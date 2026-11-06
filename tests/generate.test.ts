import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { AppError } from '../src/core/errors.js';
import { artifactUrlIn } from '../src/core/uemaster/generator.js';
import { jobStatus, runJob, startGeneration } from '../src/core/uemaster/start.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { REPO_ROOT, artifactExists, cleanArtifacts, writeArtifact } from './helpers/files.js';

/**
 * P2.6 的生成管线：作业 → 任务包 → 生成器 → 产物 → attach。
 *
 * 真 CLI 在本机是登不进去的（`claude -p` 报 OAuth 过期，`codex exec` 401），所以
 * 这里跑的是 `tests/stubs/*.mjs`：它们与真 CLI 吃同一个输入（stdin 上的完整任务包）、
 * 按同一个约定落盘（包自己写的路径）。测的是**管线**，不是模型画得好不好。
 *
 * 每条用例都走真的服务层 + 真的库 + 真的文件系统；只有「谁来写这份 HTML」被换成了
 * 一个退出码可预测的脚本。这样 running → done / failed、artifact 行、文件存在性、
 * 事件与状态迁移全都不是 mock 出来的。
 */

/** stub 命令：包一层引号，`process.execPath` 里可能有空格。 */
function stub(name: string): string {
  return `"${process.execPath}" "${path.join(REPO_ROOT, 'tests', 'stubs', name)}"`;
}

type JobRow = {
  status: string;
  error: string | null;
  artifact_id: string | null;
  finished_at: Date | null;
};

async function jobRow(jobId: string): Promise<JobRow> {
  const res = await db.execute<JobRow>(sql`
    select status, error, artifact_id, finished_at from uemaster_jobs where id = ${jobId}`);
  const row = res.rows[0];
  if (!row) throw new Error(`作业不见了：${jobId}`);
  return row;
}

async function insertJob(requirementId: string, stage: string): Promise<string> {
  const res = await db.execute<{ id: string }>(sql`
    insert into uemaster_jobs (requirement_id, stage, status)
    values (${requirementId}, ${stage}, 'running') returning id`);
  return res.rows[0]!.id;
}

async function artifactCount(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`select count(*)::int as n from uemaster_artifacts`);
  return Number(res.rows[0]!.n);
}

async function requirementState(id: string): Promise<string> {
  const res = await db.execute<{ state: string }>(sql`select state from requirements where id = ${id}`);
  return res.rows[0]!.state;
}

/** 一条收集里的需求（没有 PRD、类型齐全）：评估这条路可以跑。 */
async function inbox() {
  return createRequirement(db, '吕品', {
    title: 'S3 协议支持', type: 'feature', requester: '孙建宏',
  });
}

/** 一条已提交评审的需求（有 PRD）：评审 / 走查两条路可以跑。 */
async function inReview() {
  const r = await inbox();
  await submitReview(db, '吕品', { requirementId: r.id, prdUrl: 'https://docs.example.com/prd/r' });
  return r;
}

/** 抓服务抛出来的错误：instance + code + message 都要对得上。 */
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
  // 每条用例自己设它要的生成器；漏设时默认探测真 CLI 会让用例依赖机器的登录状态。
  delete process.env.FLOWERS_GEN_CMD;
});

afterAll(async () => {
  delete process.env.FLOWERS_GEN_CMD;
  await cleanArtifacts();
  await pool.end();
});

describe('runJob（worker 的那一段）', () => {
  it('成功：running → done，产物落盘并 attach，作业带上 artifact_id', async () => {
    process.env.FLOWERS_GEN_CMD = stub('gen-ok.mjs');
    const r = await inbox();
    const jobId = await insertJob(r.id, 'evaluate');
    const url = `/uemaster/PAN-${r.number}/evaluate.html`;

    await runJob(db, jobId, { actor: '吕品', timeoutMs: 10000 });

    const job = await jobRow(jobId);
    expect(job.status).toBe('done');
    expect(job.error).toBeNull();
    expect(job.artifact_id).not.toBeNull();
    expect(job.finished_at).not.toBeNull();
    expect(await artifactExists(url)).toBe(true);

    const artifact = await db.execute<{ url: string; created_by: string; id: string }>(sql`
      select id, url, created_by from uemaster_artifacts`);
    expect(artifact.rows).toHaveLength(1);
    expect(artifact.rows[0]!.url).toBe(url);
    // 按按钮的人就是 created_by：时间线上「谁交的」不是靠猜。
    expect(artifact.rows[0]!.created_by).toBe('吕品');
    expect(artifact.rows[0]!.id).toBe(job.artifact_id);

    // attach 的既有语义透过生成这条路照样成立：收集里的需求收到评估材料 → 待设计。
    expect(await requirementState(r.id)).toBe('design');

    const status = await jobStatus(db, jobId);
    expect(status).toMatchObject({ status: 'done', url, error: null });
  });

  it('失败：stderr 原文进 error，没有产物行，文件也不存在', async () => {
    process.env.FLOWERS_GEN_CMD = stub('gen-fail.mjs');
    const r = await inbox();
    const jobId = await insertJob(r.id, 'evaluate');
    const url = `/uemaster/PAN-${r.number}/evaluate.html`;

    await runJob(db, jobId, { timeoutMs: 10000 });

    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    expect(job.artifact_id).toBeNull();
    // 原文照登：这句英文就是用户要读的那句「该去登录了」。
    expect(job.error).toContain('Failed to authenticate: OAuth session expired');
    expect(await artifactCount()).toBe(0);
    expect(await artifactExists(url)).toBe(false);
    // 需求状态不动：失败不产生评估材料，就不该被推进。
    expect(await requirementState(r.id)).toBe('inbox');

    const status = await jobStatus(db, jobId);
    expect(status?.status).toBe('failed');
    expect(status?.error).toContain('OAuth session expired');
    expect(status?.url).toBeNull();
  });

  it('超时：到点杀掉命令，作业收成 failed，原因写明超时', async () => {
    process.env.FLOWERS_GEN_CMD = stub('gen-hang.mjs');
    const r = await inbox();
    const jobId = await insertJob(r.id, 'evaluate');

    const started = Date.now();
    await runJob(db, jobId, { timeoutMs: 600 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(10000);
    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toContain('生成超时');
    expect(await artifactCount()).toBe(0);
  });

  it('退出 0 但没写文件：不算成功', async () => {
    process.env.FLOWERS_GEN_CMD = stub('gen-silent.mjs');
    const r = await inbox();
    const jobId = await insertJob(r.id, 'evaluate');

    await runJob(db, jobId, { timeoutMs: 10000 });

    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toContain('产物文件不存在');
    expect(await artifactCount()).toBe(0);
  });

  it('旧文件还在但没被重写：也不算成功（不把上一版当新结果）', async () => {
    process.env.FLOWERS_GEN_CMD = stub('gen-silent.mjs');
    const r = await inbox();
    const url = `/uemaster/PAN-${r.number}/evaluate.html`;
    // 上一版产物：路径是固定的，重做会覆盖同一份文件。
    await writeArtifact(url, '<!doctype html><title>上一版</title>');
    const jobId = await insertJob(r.id, 'evaluate');

    await runJob(db, jobId, { timeoutMs: 10000 });

    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toContain('产物文件没有更新');
    expect(await artifactCount()).toBe(0);
  });

  it('没有 PRD 的评审：不跑生成器，直接给出缺什么', async () => {
    // 指向会写文件的 stub：如果它真被调用了，就会留下文件——这条用例要证明它没跑。
    process.env.FLOWERS_GEN_CMD = stub('gen-ok.mjs');
    const r = await inbox();
    const jobId = await insertJob(r.id, 'review');

    await runJob(db, jobId, { timeoutMs: 10000 });

    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('缺少 PRD 链接，无法生成评审材料');
    expect(await artifactExists(`/uemaster/PAN-${r.number}/review.html`)).toBe(false);
    expect(await artifactCount()).toBe(0);
  });

  it('作业已经收口：再跑一次什么都不改（worker 可重入）', async () => {
    process.env.FLOWERS_GEN_CMD = stub('gen-ok.mjs');
    const r = await inbox();
    const jobId = await insertJob(r.id, 'evaluate');

    await runJob(db, jobId, { timeoutMs: 10000 });
    const first = await jobRow(jobId);

    await runJob(db, jobId, { timeoutMs: 10000 });
    const second = await jobRow(jobId);
    expect(second).toEqual(first);
    expect(await artifactCount()).toBe(1);
  });
});

describe('startGeneration（服务层）', () => {
  it('同一个阶段已经有 running：拒绝，并且不新增作业', async () => {
    const r = await inbox();
    await insertJob(r.id, 'evaluate');

    const error = await caught(startGeneration(db, '吕品', {
      requirementId: r.id, stage: 'evaluate',
    }));
    expect(error.code).toBe('generation_running');
    expect(error.message).toBe('这个阶段正在生成中，等这次结束再试');

    const rows = await db.execute<{ n: number }>(sql`select count(*)::int as n from uemaster_jobs`);
    expect(Number(rows.rows[0]!.n)).toBe(1);
  });

  it('其它阶段不受影响：同一个需求可以同时有两条不同 stage 的作业', async () => {
    process.env.FLOWERS_GEN_CMD = stub('gen-silent.mjs');
    const r = await inReview();
    await insertJob(r.id, 'evaluate');

    const { jobId } = await startGeneration(db, '吕品', { requirementId: r.id, stage: 'review' });
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    // 交给 worker 的那条作业会在后台自己收口（gen-silent 立刻退出）；这里只钉写库结果。
    const rows = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from uemaster_jobs where requirement_id = ${r.id}`);
    expect(Number(rows.rows[0]!.n)).toBe(2);
  });

  it('超时未回报的 running 会被收成 failed，然后放行新的一次', async () => {
    process.env.FLOWERS_GEN_CMD = stub('gen-silent.mjs');
    const r = await inbox();
    const stale = await insertJob(r.id, 'evaluate');
    await db.execute(sql`
      update uemaster_jobs set created_at = now() - interval '20 minutes' where id = ${stale}`);

    const { jobId } = await startGeneration(db, '吕品', { requirementId: r.id, stage: 'evaluate' });
    expect(jobId).not.toBe(stale);

    const old = await jobRow(stale);
    expect(old.status).toBe('failed');
    expect(old.error).toBe('生成超时：后台进程没有回报');
    expect((await jobRow(jobId)).status).toBe('running');
  });

  it('入参校验：stage 不合法 / 需求 ID 不是 uuid / 需求不存在', async () => {
    const r = await inbox();

    const badStage = await caught(startGeneration(db, '吕品', {
      requirementId: r.id, stage: 'ship',
    }));
    expect(badStage.code).toBe('invalid_stage');

    const badId = await caught(startGeneration(db, '吕品', {
      requirementId: 'PAN-7', stage: 'evaluate',
    }));
    expect(badId.message).toBe('需求 ID 格式不正确');

    const missing = await caught(startGeneration(db, '吕品', {
      requirementId: '11111111-1111-4111-8111-111111111111', stage: 'evaluate',
    }));
    expect(missing.code).toBe('not_found');
    expect(missing.message).toBe('需求不存在');

    const notObject = await caught(startGeneration(db, '吕品', null));
    expect(notObject.message).toBe('参数不合法');
  });
});

describe('jobStatus', () => {
  it('非 uuid / 查不到都返回 null', async () => {
    expect(await jobStatus(db, 'nope')).toBeNull();
    expect(await jobStatus(db, '11111111-1111-4111-8111-111111111111')).toBeNull();
  });
});

describe('artifactUrlIn（包 → 产物路径）', () => {
  it('从任务包的「交付」那一段取出站内路径', () => {
    const pack = '交付：把文件写到 data/uemaster/PAN-7/review.html，'
      + '然后调用 uemaster_attach，把站内路径 /uemaster/PAN-7/review.html 交回';
    expect(artifactUrlIn(pack)).toBe('/uemaster/PAN-7/review.html');
  });

  it('包里没有路径：抛中文错误', () => {
    expect(() => artifactUrlIn('没有路径的文本')).toThrowError('任务包里没有产物路径');
  });
});

describe('整条路（startGeneration 真的甩出一个 detached worker）', () => {
  it('按钮那一侧拿到 jobId，几秒后作业自己变成 done 且产物出现', async () => {
    process.env.FLOWERS_GEN_CMD = stub('gen-ok.mjs');
    const r = await inbox();

    const { jobId } = await startGeneration(db, '吕品', {
      requirementId: r.id, stage: 'evaluate',
    });

    // worker 是 detached 的：父进程只等结果，不拥有它。给它 20 秒（tsx 冷启动 + 一条 node）。
    let status = await jobStatus(db, jobId);
    for (let i = 0; i < 100 && status?.status === 'running'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      status = await jobStatus(db, jobId);
    }

    expect(status?.status).toBe('done');
    expect(status?.url).toBe(`/uemaster/PAN-${r.number}/evaluate.html`);
    expect(await artifactExists(status!.url!)).toBe(true);
  }, 30000);
});
