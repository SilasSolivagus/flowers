import { spawn } from 'node:child_process';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { jobStatus } from '../src/core/uemaster/start.js';
import { listRunningJobs } from '../src/core/read/progress.js';
import { getRequirementDetail } from '../src/core/read/detail.js';
import {
  HEARTBEAT_STALE_MS, MAX_JOB_AGE_MS, ORPHAN_EXITED, ORPHAN_SILENT, ORPHAN_TOO_OLD,
  healStaleJobs, pidAlive, stallReasonOf,
} from '../src/core/uemaster/liveness.js';
import { resetDb, seedPeople } from './helpers/db.js';

/**
 * 孤儿作业自己死（2026-11-10）。
 *
 * 事故：dev server 重启把 detached worker 带走了，库里留下一条 `running`；抽屉里
 * 「正在生成页面片段 1:29:12 · 第 2 次尝试」转了 90 分钟，停不下来、也重试不了。
 * owner 手工 `UPDATE 1` 才恢复——产品不该需要他这么做。
 *
 * 这一组钉三档判据（`liveness.ts` 文件头有为什么是这三档、为什么这个顺序）：
 * 1. **pid 不在** → failed。这是「确定死」而不是「未知」：那条行只可能由一个一次性
 *    worker 写完，pid 没了就没有下文了；
 * 2. **心跳过期**（> 90 秒）→ failed。pid 可能是空的老行，也可能被系统回收给了别人；
 * 3. **绝对年龄上限**（> 15 分钟）→ failed。连心跳都没写成的那些（活着的卡死）。
 *
 * 以及一条不许动的：**健康的** running（pid 活着、心跳新鲜）一个字都不许改——一条
 * 正在跑的作业被误杀，产物白跑、模型白烧。
 */

/** 一个**确定已经退出**的 pid：起一个立刻退出的子进程，等它真的退出。 */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('spawn 没有给 pid');
  await new Promise<void>((resolve) => { child.on('exit', () => resolve()); });
  // 前提检查：这个用例的全部意义就是「这个 pid 不在了」。
  expect(pidAlive(pid)).toBe(false);
  return pid;
}

async function seedRequirement(): Promise<string> {
  const r = await createRequirement(db, '吕品', {
    title: 'S3 协议支持', type: 'feature', requester: '孙建宏',
    context: '运营在后台开权限时', problem: '要跳七个页面', outcome: '一次点完',
  });
  return r.id;
}

/**
 * 直接落一条 running 作业（走 `startGeneration` 会真甩一个 worker，这组用例不要那个）。
 *
 * 三格由调用方给：`pid`（谁在跑）、`heartbeatAgo`（最后一次报到是多久以前）、
 * `age`（什么时候开的）。它们就是判据的全部输入。
 */
async function insertRunning(
  requirementId: string,
  opts: { pid?: number | null; heartbeatAgo?: number | null; age?: number; stage?: string } = {},
): Promise<string> {
  const stage = opts.stage ?? 'evaluate';
  const pid = opts.pid === undefined ? null : opts.pid;
  const heartbeatAt = opts.heartbeatAgo === undefined || opts.heartbeatAgo === null
    ? null
    : new Date(Date.now() - opts.heartbeatAgo);
  const createdAt = new Date(Date.now() - (opts.age ?? 0));
  const res = await db.execute<{ id: string }>(sql`
    insert into uemaster_jobs (requirement_id, stage, status, worker_pid, heartbeat_at, created_at)
    values (${requirementId}, ${stage}, 'running', ${pid}, ${heartbeatAt}, ${createdAt})
    returning id`);
  return res.rows[0]!.id;
}

type Row = { status: string; error: string | null; finished_at: Date | null };

async function rowOf(jobId: string): Promise<Row> {
  const res = await db.execute<Row>(sql`
    select status, error, finished_at from uemaster_jobs where id = ${jobId}`);
  return res.rows[0]!;
}

beforeEach(async () => {
  await resetDb();
  await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

describe('stallReasonOf（三档判据，纯函数）', () => {
  const now = 1_800_000_000_000;
  /** 一律「pid 42 活着」：除了 pid 那一档，其它两档要的正是「进程还在」。 */
  const alive = (pid: number): boolean => pid === 42;

  it('pid 不在 → 生成进程已退出（**不再是「未知」**）', () => {
    const reason = stallReasonOf({ workerPid: 7, heartbeatAt: now, createdAt: now }, now, alive);
    expect(reason).toBe(ORPHAN_EXITED);
    // 逐字的那一句：用户要在抽屉里读到它，不是一句「状态未知」。
    expect(reason).toBe('生成进程已退出（服务已重启或被终止），本次没有产出；可以直接重试');
  });

  it('pid 活着、心跳过期（> 90 秒）→ 卡住', () => {
    const reason = stallReasonOf({
      workerPid: 42,
      heartbeatAt: now - HEARTBEAT_STALE_MS - 1,
      createdAt: now,
    }, now, alive);
    expect(reason).toBe(ORPHAN_SILENT);
  });

  it('pid 活着、心跳没过期 → 不动它（差 1 毫秒也算活着）', () => {
    expect(stallReasonOf({
      workerPid: 42,
      heartbeatAt: now - HEARTBEAT_STALE_MS + 1,
      createdAt: now,
    }, now, alive)).toBeNull();
  });

  it('pid 为空、心跳为空、刚开 → 不动它（什么都证明不了 = 还不知道）', () => {
    expect(stallReasonOf({ workerPid: null, heartbeatAt: null, createdAt: now }, now, alive)).toBeNull();
  });

  it('pid 为空、心跳过期 → 卡住（老行只有心跳这一格证据）', () => {
    expect(stallReasonOf({
      workerPid: null,
      heartbeatAt: now - HEARTBEAT_STALE_MS - 1,
      createdAt: now,
    }, now, alive)).toBe(ORPHAN_SILENT);
  });

  it('pid 活着、心跳新鲜，但已经 15 分钟 → 年龄上限收掉（活着的卡死）', () => {
    const reason = stallReasonOf({
      workerPid: 42,
      heartbeatAt: now,
      createdAt: now - MAX_JOB_AGE_MS - 1,
    }, now, alive);
    expect(reason).toBe(ORPHAN_TOO_OLD);
  });

  it('阈值边界：心跳刚好 90 秒、年龄刚好 15 分钟都不算死', () => {
    expect(stallReasonOf({
      workerPid: 42, heartbeatAt: now - HEARTBEAT_STALE_MS, createdAt: now,
    }, now, alive)).toBeNull();
    expect(stallReasonOf({
      workerPid: 42, heartbeatAt: now, createdAt: now - MAX_JOB_AGE_MS,
    }, now, alive)).toBeNull();
  });

  it('pidAlive：不存在的 pid 是 false，自己的 pid 是 true', () => {
    expect(pidAlive(process.pid)).toBe(true);
    // 0 / 负数 / 非整数都是「说不清」→ 按不活着算（判据只会因此更早收掉一条坏行）。
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(1.5)).toBe(false);
    expect(pidAlive(null)).toBe(false);
  });
});

describe('读一次就把孤儿收掉（事故里那一行）', () => {
  it('死 pid 的 running：一次 jobStatus 读取 → failed + 那句可读的中文', async () => {
    const requirementId = await seedRequirement();
    const pid = await deadPid();
    const jobId = await insertRunning(requirementId, { pid, heartbeatAgo: 0 });

    // 读之前：库里确实是那条僵死的 running（这就是 owner 屏幕上那一行）。
    expect(await rowOf(jobId)).toMatchObject({ status: 'running', error: null });

    const view = await jobStatus(db, jobId);

    expect(view?.status).toBe('failed');
    expect(view?.error).toBe(ORPHAN_EXITED);
    // 行本身也被写下来了（不只是读模型里折了一下）：下一个读的人拿到的是同一件事。
    expect(await rowOf(jobId)).toMatchObject({ status: 'failed', error: ORPHAN_EXITED });
    expect((await rowOf(jobId)).finished_at).not.toBeNull();
  });

  it('心跳过期（pid 还在）→ failed，原因是「90 秒没有回报」', async () => {
    const requirementId = await seedRequirement();
    const jobId = await insertRunning(requirementId, {
      pid: process.pid, heartbeatAgo: HEARTBEAT_STALE_MS + 5_000,
    });

    const view = await jobStatus(db, jobId);
    expect(view?.status).toBe('failed');
    expect(view?.error).toBe(ORPHAN_SILENT);
  });

  it('15 分钟年龄上限 → failed（连心跳都没有的那些）', async () => {
    const requirementId = await seedRequirement();
    const jobId = await insertRunning(requirementId, { age: MAX_JOB_AGE_MS + 60_000 });

    const view = await jobStatus(db, jobId);
    expect(view?.status).toBe('failed');
    expect(view?.error).toBe(ORPHAN_TOO_OLD);
  });

  it('健康的 running 一个字都不改（pid 活着、心跳刚刚）', async () => {
    const requirementId = await seedRequirement();
    const jobId = await insertRunning(requirementId, { pid: process.pid, heartbeatAgo: 1_000 });

    const view = await jobStatus(db, jobId);
    expect(view?.status).toBe('running');
    expect(view?.error).toBeNull();
    expect(await rowOf(jobId)).toMatchObject({ status: 'running', error: null });
  });

  it('already 结束的作业（done / failed / canceled）一个字都不改', async () => {
    const requirementId = await seedRequirement();
    const jobId = await insertRunning(requirementId, { pid: await deadPid() });
    await db.execute(sql`
      update uemaster_jobs set status = 'done', error = null, finished_at = now() where id = ${jobId}`);

    const view = await jobStatus(db, jobId);
    expect(view?.status).toBe('done');
    // 「done 且 pid 不在」是**正常**的：worker 交完结果就退出了。判据只作用于 running。
    expect(view?.error).toBeNull();
  });
});

describe('另外两处读侧也收孤儿', () => {
  it('进度卡（listRunningJobs）不再挂着一条死作业', async () => {
    const requirementId = await seedRequirement();
    const jobId = await insertRunning(requirementId, { pid: await deadPid() });

    const jobs = await listRunningJobs();
    expect(jobs.map((j) => j.jobId)).not.toContain(jobId);
    expect((await rowOf(jobId)).status).toBe('failed');
  });

  it('抽屉的服务端渲染（getRequirementDetail）首帧就不是「生成中」', async () => {
    const requirementId = await seedRequirement();
    const jobId = await insertRunning(requirementId, { pid: await deadPid() });

    const detail = await getRequirementDetail(requirementId);
    const ref = detail!.refs.find((r) => r.stage === 'evaluate')!;
    expect(ref.generation).toBeNull();
    expect((await rowOf(jobId)).status).toBe('failed');
  });

  it('healStaleJobs 只碰自己那一条（按 requirementId 收窄）', async () => {
    const a = await seedRequirement();
    const b = await seedRequirement();
    const dead = await deadPid();
    const ja = await insertRunning(a, { pid: dead });
    const jb = await insertRunning(b, { pid: dead });

    const healed = await healStaleJobs(db, { requirementId: a });
    expect(healed).toEqual([ja]);
    expect((await rowOf(ja)).status).toBe('failed');
    expect((await rowOf(jb)).status).toBe('running');
  });

  it('where status = running 让回收是幂等的（跑两次，第二次什么也不改）', async () => {
    const requirementId = await seedRequirement();
    const jobId = await insertRunning(requirementId, { pid: await deadPid() });

    expect(await healStaleJobs(db, { jobId })).toEqual([jobId]);
    const once = await rowOf(jobId);
    expect(await healStaleJobs(db, { jobId })).toEqual([]);
    expect(await rowOf(jobId)).toEqual(once);
  });
});
