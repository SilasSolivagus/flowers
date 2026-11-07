import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db, pool } from '../src/db/client.js';
import { recordLocate } from '../src/core/locate/ledger.js';
import type { Candidate, LocateResult } from '../src/core/locate/types.js';
import { resetDb } from './helpers/db.js';

/**
 * 记账（Task 7）：每一行 `locate_runs` 都要能回答「这次定位属于三种里的哪一种」。
 *
 * 全部对着真库跑：这一层唯一的行为就是「写了什么进库」，把 `db.execute` 换成一个
 * 假对象能测的只有我以为的 SQL。
 *
 * 两套词表在这里对撞——`LocateResult.kind` 是 `absent / none / candidates`，
 * `locate_runs.outcome` 是 `absent / none / low`。中间那一格（`candidates → low`）
 * 是整张表的重点：按 kind 直接写进去的实现会在库里留下一个不存在的 outcome，
 * 而它读起来一点也不像错误，所以每一条腿都要单独钉一次。
 */

const one: Candidate = { path: 'a/b.vue', reason: '出自 11-03 那次合并', source: 'structure', score: 1 };

const candidateResult: LocateResult = { kind: 'candidates', confidence: 'low', items: [one] };

type Row = {
  requirement_id: string | null;
  stage: string;
  outcome: string;
  candidates: number;
  hit: boolean | null;
};

/** 全表按写入顺序读回来。`created_at` 是每条 insert 自己的时钟，三条之间隔着一次往返。 */
async function rows(): Promise<Row[]> {
  const res = await db.execute<Row>(sql`
    select requirement_id, stage, outcome, candidates, hit
      from locate_runs
     order by created_at`);
  return res.rows;
}

/**
 * 失败用例要一次真的写库失败。
 *
 * 用触发器而不是一个会抛的假 db：假对象测不出「忘了 await」——没 await 的
 * `db.execute` 仍然会让函数正常返回，用例照样绿，而产品里每一行都写不进去。
 */
const dropBoom = async () => {
  await db.execute(sql`drop trigger if exists flowers_test_locate_boom on locate_runs`);
  await db.execute(sql`drop function if exists flowers_test_locate_boom()`);
};

beforeEach(async () => {
  // 上一轮崩在失败用例里会把这个触发器留在库里，truncate 清不掉它。
  await dropBoom();
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});

describe('kind → outcome 的映射', () => {
  /** 三条腿逐个钉：改坏任何一条，只有它自己红，指向明确。 */
  const legs: Array<{ kind: string; result: LocateResult; outcome: string; candidates: number }> = [
    { kind: 'absent', result: { kind: 'absent', why: '镜像连不上' }, outcome: 'absent', candidates: 0 },
    { kind: 'none', result: { kind: 'none' }, outcome: 'none', candidates: 0 },
    { kind: 'candidates', result: candidateResult, outcome: 'low', candidates: 1 },
  ];

  for (const leg of legs) {
    it(`kind=${leg.kind} 记成 outcome=${leg.outcome}，候选数 ${leg.candidates}`, async () => {
      await recordLocate(db, { requirementId: null, stage: 'inspect', result: leg.result });
      const got = await rows();
      expect(got).toHaveLength(1);
      expect(got[0]?.outcome).toBe(leg.outcome);
      expect(got[0]?.candidates).toBe(leg.candidates);
    });
  }

  /**
   * 一次写三种，读回来必须是三条**不同**的值。
   *
   * 与上面三条腿不重复：那三条各看一行，这条看的是「三行放在一起是否仍然可分」——
   * 把两个 kind 映到同一个 outcome（比如都写 'none'）能过上面任意一条，过不了这条。
   */
  it('三种情况各记一条，outcome 三值不同', async () => {
    await recordLocate(db, { requirementId: null, stage: 'inspect', result: { kind: 'absent', why: '镜像连不上' } });
    await recordLocate(db, { requirementId: null, stage: 'inspect', result: { kind: 'none' } });
    await recordLocate(db, { requirementId: null, stage: 'review', result: candidateResult });
    const got = await rows();
    expect(got.map((r) => r.outcome)).toEqual(['absent', 'none', 'low']);
    expect(got.map((r) => r.candidates)).toEqual([0, 0, 1]);
  });
});

describe('这一行还记了什么', () => {
  it('候选数就是 items.length，不是布尔、不是 1', async () => {
    const items = [one, { ...one, path: 'c/d.vue' }, { ...one, path: 'e/f.vue' }];
    await recordLocate(db, {
      requirementId: null,
      stage: 'inspect',
      result: { kind: 'candidates', confidence: 'low', items },
    });
    const got = await rows();
    expect(got[0]?.candidates).toBe(3);
  });

  /**
   * `hit` 写进去时必须是 null。
   *
   * 这个值回答的是「这条线索后来被研发确认是对的吗」，而在写这一行的那一秒我们
   * 无从知道——由 Task 8/9 的评估回填。写成 false 会把「还没评」说成「评错了」，
   * 之后算准确率时分母里多出来的全是不该在那儿的负数。
   */
  it('hit 留空（还没评，不是评错了）', async () => {
    await recordLocate(db, { requirementId: null, stage: 'inspect', result: candidateResult });
    const got = await rows();
    expect(got[0]?.hit).toBeNull();
  });

  it('需求 id 与阶段原样落库', async () => {
    const requirementId = randomUUID();
    await recordLocate(db, { requirementId, stage: 'review', result: candidateResult });
    const got = await rows();
    expect(got[0]?.requirement_id).toBe(requirementId);
    expect(got[0]?.stage).toBe('review');
  });
});

describe('写不进去的时候', () => {
  /**
   * 写库失败必须**抛出去**，不能吞成一次「成功」。
   *
   * 这条账的第一版用途就是攒数（够 30 条再定准确率的线），一次静默丢失不会有人
   * 发现：报告里只是「少了几个案例」，而没有人会去数应该有多少条。
   */
  it('写库失败要抛出来，不能吞成「记下了」', async () => {
    await db.execute(sql`
      create or replace function flowers_test_locate_boom() returns trigger
      language plpgsql as $$ begin raise exception 'boom'; end $$`);
    await db.execute(sql`
      create trigger flowers_test_locate_boom before insert on locate_runs
      for each row execute function flowers_test_locate_boom()`);
    try {
      await expect(
        recordLocate(db, { requirementId: null, stage: 'inspect', result: { kind: 'none' } }),
      ).rejects.toThrow(/boom/);
      // 失败那一行不该留下半个痕迹。
      const got = await rows();
      expect(got).toEqual([]);
    } finally {
      await dropBoom();
    }
  });
});
