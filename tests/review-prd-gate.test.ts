import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { AppError } from '../src/core/errors.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { startGeneration } from '../src/core/uemaster/start.js';
import { REVIEW_NEEDS_PRD, reviewRequirement } from '../src/core/uemaster/review.js';

/**
 * 2026-11-08 裁定：**没有 PRD 直接拒绝生成评审材料，并说清怎么补**。
 *
 * 两道门，一条口径：
 *
 * 1. `startGeneration`（按钮 `generateAction` 后面那一个服务）——拒绝发生在**落作业
 *    之前**。这是这一组最要紧的一条断言：一次被拒的点击不该留下 `uemaster_jobs` 行，
 *    因此也不会甩 worker、不会读 PRD（`prd_snapshots` 一行不增）、不会留下产物。
 * 2. `reviewRequirement`（真正生成的那一段）——`prdBaseline` 先看链接**再看快照**。
 *    只看快照的旧写法会在「库里有上一版快照、需求上的链接却没了」时产出一份读起来
 *    像「PRD 已经评过」的材料，而那正是这条裁定要掐掉的形状。
 *
 * 两侧都断言：**缺 PRD → 拒绝 + 一句能照着做的中文**；**有 PRD → 照旧开得起来**。
 * 只测拒绝的话，一个把整条评审都关掉的实现也会绿。
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 与 `tests/generate.test.ts` 同一套假生成器：只证明这条路走到哪，不跑真 CLI。 */
function stub(name: string): string {
  return `"${process.execPath}" "${path.join(REPO_ROOT, 'tests', 'stubs', name)}"`;
}

beforeEach(async () => {
  await resetDb();
  await seedPeople();
  delete process.env.FLOWERS_PROVIDER_BASE_URL;
  delete process.env.FLOWERS_PROVIDER_API_KEY;
  delete process.env.FLOWERS_PROVIDER_MODEL;
});

afterAll(async () => {
  await pool.end();
});

/** 库里「一次生成留下了什么」的三格：这三格都必须还是 0。 */
async function sideEffects(): Promise<{ jobs: number; artifacts: number; snapshots: number }> {
  const res = await db.execute<{ jobs: number; artifacts: number; snapshots: number }>(sql`
    select (select count(*)::int from uemaster_jobs) as jobs,
           (select count(*)::int from uemaster_artifacts) as artifacts,
           (select count(*)::int from prd_snapshots) as snapshots`);
  const row = res.rows[0]!;
  return { jobs: Number(row.jobs), artifacts: Number(row.artifacts), snapshots: Number(row.snapshots) };
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

/** 一条**没有** PRD 链接的需求。 */
/**
 * 一条**没有 PRD** 的需求。
 *
 * 2026-11-10 起多填了三格六问（context / problem / outcome）：这一组盯的是「PRD 链接」
 * 那一道门，而评估生成还有另一道门（六问必填，`uemaster/gate.ts`）。不填的话，
 * 「评估材料不受 PRD 规则约束」那条用例会先撞上六问，测不到它要测的东西。
 */
async function bare() {
  return createRequirement(db, '吕品', {
    title: '没有 PRD 的需求', type: 'feature', requester: '孙建宏',
    context: '运营在后台开权限时', problem: '要跳七个页面', outcome: '一次点完',
  });
}

describe('评审材料：没有 PRD 链接就拒绝（按钮那一条路）', () => {
  it('startGeneration 拒绝：一句点名修法的中文，作业 / 产物 / 快照一行都不落', async () => {
    const r = await bare();

    const error = await caught(startGeneration(db, '吕品', {
      requirementId: r.id, stage: 'review',
    }));

    expect(error.code).toBe('prd_missing_url');
    // 一句话要说三件事：缺什么、为什么不能凑、下一步动手做什么。
    expect(error.message).toBe(REVIEW_NEEDS_PRD);
    expect(error.message).toContain('还没有正式 PRD 链接');
    expect(error.message).toContain('评审材料要先有 PRD');
    expect(error.message).toContain('信息 · PRD 链接');

    // 拒绝发生在落作业之前：一次被拒的点击什么都不留下。
    expect(await sideEffects()).toEqual({ jobs: 0, artifacts: 0, snapshots: 0 });
  });

  it('评估材料不受这条规则约束（同一份没有 PRD 的需求照样开得起来）', async () => {
    process.env.FLOWERS_GEN_CMD = stub('gen-silent.mjs');
    const r = await bare();

    const { jobId } = await startGeneration(db, '吕品', {
      requirementId: r.id, stage: 'evaluate',
    });
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await sideEffects()).jobs).toBe(1);
  });

  it('有 PRD 链接：照旧开作业（拒绝只针对缺链接的那一格）', async () => {
    process.env.FLOWERS_GEN_CMD = stub('gen-silent.mjs');
    const r = await bare();
    await submitReview(db, '吕品', {
      requirementId: r.id, prdUrl: 'https://docs.example.com/prd/r',
    });

    const { jobId } = await startGeneration(db, '吕品', {
      requirementId: r.id, stage: 'review',
    });
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    const res = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from uemaster_jobs
       where requirement_id = ${r.id} and stage = 'review'`);
    expect(Number(res.rows[0]!.n)).toBe(1);
  });
});

describe('评审材料：没有 PRD 链接就拒绝（生成那一条路）', () => {
  /**
   * `reviewRequirement` 的第一件事是解析模型配置（没配就走不到后面）。这一组钉的是
   * 「链接这一关」，所以注入一份**假的**配置：它要证明的是 prdBaseline 在发出任何请求
   * 之前就停下来——`complete` 一次都不该被调（记在 `calls` 里）。
   */
  function fakeConfig() {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        resolveConfig: async () => ({ baseUrl: 'http://example.invalid', apiKey: 'k', model: 'm' }),
        complete: async () => {
          calls.push('complete');
          return { ok: false as const, error: '不该被调到' };
        },
      },
    };
  }

  it('没有链接：prd_missing_url + 那句中文，一次模型调用都不发，也不落快照', async () => {
    const r = await bare();
    const fake = fakeConfig();

    const error = await caught(reviewRequirement(db, '吕品', {
      requirementId: r.id,
    }, fake.deps));

    expect(error.code).toBe('prd_missing_url');
    expect(error.message).toBe(REVIEW_NEEDS_PRD);
    expect(fake.calls).toEqual([]);
    expect(await sideEffects()).toEqual({ jobs: 0, artifacts: 0, snapshots: 0 });
  });

  it('库里有上一版快照、链接被清掉：仍然拒绝（看的是需求上的链接，不是快照）', async () => {
    const r = await bare();
    // 上一版快照还在（例如 PRD 链接被清空之前读过一次），链接这一格是空的。
    await db.execute(sql`
      insert into prd_snapshots (requirement_id, url, markdown, hash)
      values (${r.id}, 'https://docs.example.com/prd/r', '# 旧 PRD', 'hash-old')`);
    const fake = fakeConfig();

    const error = await caught(reviewRequirement(db, '吕品', {
      requirementId: r.id,
    }, fake.deps));

    expect(error.code).toBe('prd_missing_url');
    expect(error.message).toBe(REVIEW_NEEDS_PRD);
    expect(fake.calls).toEqual([]);
  });
});
