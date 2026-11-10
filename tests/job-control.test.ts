import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { AppError } from '../src/core/errors.js';
import { cancelJob, retryJob } from '../src/core/uemaster/control.js';
import { STOPPED_REASON, pidAlive } from '../src/core/uemaster/liveness.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { REPO_ROOT, cleanArtifacts } from './helpers/files.js';

/**
 * 停止 与 重试（2026-11-10）。
 *
 * 事故里最疼的一句是「no way to stop or retry」：一条作业挂了 90 分钟，用户既停不下来，
 * 也不能再按一次生成（那句「这个阶段正在生成中」把门守着）。这一组钉四件事：
 *
 * 1. **停止**把行收成 `canceled` + 「已手动停止」，并真的杀掉 worker 的**进程组**
 *    （只杀父进程会留下还在写产物的孤儿）；
 * 2. 停止**先改库、后杀进程**：反过来的话，worker 可能在收到信号前先写完 failed，
 *    于是用户按的是「停止」，看到的是一句「生成失败」；
 * 3. **重试**新开一行（新 id），旧行一行都不动——它是历史；
 * 4. 重试走的是「按下生成」同一条服务：六问、生成器、防重一条不少。
 */

/** 与 generate.test.ts 同一个 stub 壳：`process.execPath` 里可能有空格。 */
function stub(name: string): string {
  return `"${process.execPath}" "${path.join(REPO_ROOT, 'tests', 'stubs', name)}"`;
}

type Row = { id: string; status: string; error: string | null; worker_pid: number | null };

async function rowOf(jobId: string): Promise<Row> {
  const res = await db.execute<Row>(sql`
    select id, status, error, worker_pid from uemaster_jobs where id = ${jobId}`);
  return res.rows[0]!;
}

async function runningJob(requirementId: string, pid: number | null = null): Promise<string> {
  const res = await db.execute<{ id: string }>(sql`
    insert into uemaster_jobs (requirement_id, stage, status, worker_pid, heartbeat_at)
    values (${requirementId}, 'evaluate', 'running', ${pid}, now())
    returning id`);
  return res.rows[0]!.id;
}

async function seedRequirement(): Promise<string> {
  const r = await createRequirement(db, '吕品', {
    title: 'S3 协议支持', type: 'feature', requester: '孙建宏',
    context: '运营在后台开权限时', problem: '要跳七个页面', outcome: '一次点完',
  });
  return r.id;
}

/**
 * 一个**真的在跑**的 worker：detached 起一个只会睡的 node 进程，进程组组长（组号 = pid），
 * 与 `spawnWorker` 同一个形状——「停止」要杀的就是这种。
 */
async function liveWorker(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error('spawn 没有给 pid');
  // 等它真的起来（否则 kill 会在它还没成为组长之前发出）。
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  expect(pidAlive(pid)).toBe(true);
  return pid;
}

/** 等一个 pid 消失（SIGTERM 是异步的）：最多 3 秒。 */
async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 30; i += 1) {
    if (!pidAlive(pid)) return true;
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  return false;
}

async function caught(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected AppError, nothing thrown');
}

beforeEach(async () => {
  await resetDb();
  await seedPeople();
  await cleanArtifacts();
  delete process.env.FLOWERS_GEN_CMD;
});

afterEach(() => {
  delete process.env.FLOWERS_GEN_CMD;
});

afterAll(async () => {
  await cleanArtifacts();
  await pool.end();
});

describe('停止', () => {
  it('行 → canceled + 「已手动停止」，worker 进程组真的被杀掉', async () => {
    const requirementId = await seedRequirement();
    const pid = await liveWorker();
    const jobId = await runningJob(requirementId, pid);

    // 停之前：一行 running，旁边有一个真的在跑的进程。
    expect(await rowOf(jobId)).toMatchObject({ status: 'running', worker_pid: pid });
    expect(pidAlive(pid)).toBe(true);

    const result = await cancelJob(db, jobId);

    expect(result).toEqual({ canceled: true });
    expect(await rowOf(jobId)).toMatchObject({
      status: 'canceled',
      error: STOPPED_REASON,
    });
    expect(STOPPED_REASON).toBe('已手动停止');
    // 进程真的没了：只改库不杀进程，用户看到的「已停止」就是一句谎（它还在写产物）。
    expect(await waitDead(pid)).toBe(true);
  });

  it('已经没有 worker 的老行（pid 为空）照样能停：行是真相', async () => {
    const requirementId = await seedRequirement();
    const jobId = await runningJob(requirementId, null);

    expect(await cancelJob(db, jobId)).toEqual({ canceled: true });
    expect(await rowOf(jobId)).toMatchObject({ status: 'canceled', error: STOPPED_REASON });
  });

  it('worker 已经自己结束 → canceled: false，一个字都不改（按晚了一步不是错误）', async () => {
    const requirementId = await seedRequirement();
    const jobId = await runningJob(requirementId, null);
    await db.execute(sql`
      update uemaster_jobs set status = 'failed', error = '生成命令已退出 1', finished_at = now()
       where id = ${jobId}`);

    expect(await cancelJob(db, jobId)).toEqual({ canceled: false });
    // 那句真实的失败原因留着：用户点「停止」不该把「为什么失败」抹掉。
    expect(await rowOf(jobId)).toMatchObject({ status: 'failed', error: '生成命令已退出 1' });
  });

  it('停止之后再来的 worker 收尾写不进库（UPDATE 带 status = running）', async () => {
    const requirementId = await seedRequirement();
    const jobId = await runningJob(requirementId, null);
    await cancelJob(db, jobId);

    // 这正是 worker 的 `failJob` 那一句：先到的人说了算。
    await db.execute(sql`
      update uemaster_jobs set status = 'failed', error = '生成命令被信号 15 终止'
       where id = ${jobId} and status = 'running'`);
    expect(await rowOf(jobId)).toMatchObject({ status: 'canceled', error: STOPPED_REASON });
  });

  it('id 形状不对 / 作业不存在 → not_found（坏 id 不是「按晚了」）', async () => {
    const bad = await caught(cancelJob(db, 'PAN-7'));
    expect(bad.code).toBe('not_found');
    expect(bad.message).toBe('生成任务不存在');

    const missing = await caught(cancelJob(db, '11111111-1111-4111-8111-111111111111'));
    expect(missing.code).toBe('not_found');
  });
});

describe('重试', () => {
  it('新作业是新 id；旧的失败行一行都不动', async () => {
    process.env.FLOWERS_GEN_CMD = stub('gen-silent.mjs');
    const requirementId = await seedRequirement();
    const failedId = await runningJob(requirementId, null);
    await db.execute(sql`
      update uemaster_jobs
         set status = 'failed', error = '生成进程已退出（服务已重启或被终止），本次没有产出；可以直接重试',
             finished_at = now()
       where id = ${failedId}`);
    const before = await rowOf(failedId);

    const { jobId } = await retryJob(db, '吕品', failedId);

    expect(jobId).not.toBe(failedId);
    // 旧行逐字不变：它是历史（时间线与排查要读的就是它）。
    expect(await rowOf(failedId)).toEqual(before);
    // 新行是 running，并且绑在同一条需求的同一个阶段上。
    const fresh = await db.execute<{ requirement_id: string; stage: string; status: string }>(sql`
      select requirement_id, stage, status from uemaster_jobs where id = ${jobId}`);
    expect(fresh.rows[0]).toMatchObject({
      requirement_id: requirementId, stage: 'evaluate', status: 'running',
    });

    // 收口：把这次真的甩出去的 worker 停掉（不让它留在后台跨用例）。
    await cancelJob(db, jobId);
  });

  it('被停止的作业也能重试（停止不是终局）', async () => {
    process.env.FLOWERS_GEN_CMD = stub('gen-silent.mjs');
    const requirementId = await seedRequirement();
    const canceledId = await runningJob(requirementId, null);
    await cancelJob(db, canceledId);

    const { jobId } = await retryJob(db, '吕品', canceledId);
    expect(jobId).not.toBe(canceledId);
    expect(await rowOf(canceledId)).toMatchObject({ status: 'canceled', error: STOPPED_REASON });

    await cancelJob(db, jobId);
  });

  it('重试走的是同一条服务：六问没填照样被拒（不是绕过检查的后门）', async () => {
    process.env.FLOWERS_GEN_CMD = stub('gen-silent.mjs');
    const r = await createRequirement(db, '吕品', {
      title: '什么都没写', type: 'feature', requester: '孙建宏',
    });
    const failedId = await runningJob(r.id, null);
    await db.execute(sql`
      update uemaster_jobs set status = 'failed', error = '生成命令已退出 1', finished_at = now()
       where id = ${failedId}`);

    const error = await caught(retryJob(db, '吕品', failedId));
    expect(error.code).toBe('description_incomplete');
    expect(error.message).toContain('还差三条没填');

    const rows = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from uemaster_jobs where requirement_id = ${r.id}`);
    expect(Number(rows.rows[0]!.n)).toBe(1);
  });

  it('id 形状不对 → not_found', async () => {
    const error = await caught(retryJob(db, '吕品', 'nope'));
    expect(error.code).toBe('not_found');
    expect(error.message).toBe('生成任务不存在');
  });
});
