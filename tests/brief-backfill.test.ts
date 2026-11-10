import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { resetDb, seedPeople } from './helpers/db.js';
import {
  BATCH, REASON, distribution, formatDistribution, moveBrieflessDesignToInbox,
} from '../scripts/migrate-brief-to-inbox.js';

/**
 * 存量回退（2026-11-10）：**只**把核心三条不齐的「待设计」退回「收集」。
 *
 * 这条迁移是那条新规则（六问不齐不能立项）对**已有的库**的那一半：口径只有一个，
 * 否则看板上的「待设计」既可能是「六问齐的」也可能是「六问空的」。
 *
 * 这一组钉五件事，每一条都对着一个会被改坏的地方：
 *
 * 1. **幂等**：第二次跑命中 0 行、不写第二条事件（写成 `state <> 'inbox'` 或者不判
 *    状态的实现会在这里红）；
 * 2. **只动 design**：review / queue / ready / dev / test / live / rejected / shelved
 *    一律不碰，**即使它们六问也不齐**（把 `state = 'design'` 写成 `state <> 'inbox'`
 *    会把 265 条已上线的需求拉回收集——那是这条迁移最坏的失败形状）；
 * 3. **判据不另抄一遍**：三条齐的待设计行留在原地，缺一条的才退（SQL 里另写一份
 *    `btrim()` 谓词就会和 `brief.ts` 的判据分叉）；
 * 4. **软删的行不算**：它对外等于不存在；
 * 5. **空库不报错**，`dry-run` 一个字节都不写。
 *
 * 事件也要钉：`requirement.state_changed` / `actor = 'system'` / payload 里有
 * `reason` 与 `batch`（后者是 0028 那条「批量操作不该刷屏」的口令，见 `read/notify.ts`）。
 */

// 2026-11-11 起六问全必填：夹具必须六格，否则每条用例都先撞同一道门。
const FILLED = {
  context: '运营在后台给客户开权限时',
  problem: '每次要跳七个页面，容易漏配',
  outcome: '一次点完，漏配为 0',
  surfaces: '管理后台 · 客户权限页',
  edgeCases: '客户已停用、重复勾选时提示',
  outOfScope: '不做批量导入',
};

type BriefKey = 'context' | 'problem' | 'outcome';

async function seedRequirement(
  fields: Partial<Record<BriefKey, string>> = {},
): Promise<string> {
  const r = await createRequirement(db, '吕品', {
    title: `需求 ${Math.random().toString(36).slice(2, 8)}`,
    type: 'feature',
    requester: '孙建宏',
    ...fields,
  });
  return r.id;
}

/** 直接把一条需求摆到某个状态（这条路本来就绕过了状态机，正是迁移要清理的那种行）。 */
async function placeAt(id: string, state: string): Promise<void> {
  await db.execute(sql`
    update requirements set state = ${state}, state_entered_at = now() where id = ${id}`);
}

async function stateOf(id: string): Promise<string> {
  const res = await db.execute<{ state: string }>(sql`
    select state from requirements where id = ${id}`);
  return res.rows[0]!.state;
}

async function eventCount(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from events where type = 'requirement.state_changed'`);
  return Number(res.rows[0]!.n);
}

beforeEach(async () => {
  await resetDb();
  await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

/** 一张「各种状态都有一条、而且六问都不齐」的库：迁移只该动 design 那一条。 */
async function seedMixed(): Promise<{ designMissing: string[]; designFilled: string; others: string[] }> {
  const designMissing = [
    await seedRequirement({}),
    await seedRequirement({ context: FILLED.context }),
  ];
  const designFilled = await seedRequirement(FILLED);
  const others: string[] = [];
  for (const state of ['review', 'queue', 'ready', 'dev', 'test', 'live', 'rejected', 'shelved']) {
    const id = await seedRequirement({});
    await placeAt(id, state);
    others.push(id);
  }
  for (const id of [...designMissing, designFilled]) await placeAt(id, 'design');
  return { designMissing, designFilled, others };
}

describe('只动「待设计 + 核心三条不齐」', () => {
  it('dry-run：报出 2 条命中，但一个字节都不写', async () => {
    const seeded = await seedMixed();
    const before = await distribution(db);

    const result = await moveBrieflessDesignToInbox(db, { dryRun: true });
    expect(result.moved).toBe(2);
    expect(result.numbers).toHaveLength(2);
    // 前后分布相同：dry-run 不写库。
    expect(result.after).toEqual(result.before);

    expect(await distribution(db)).toEqual(before);
    for (const id of seeded.designMissing) expect(await stateOf(id)).toBe('design');
    expect(await eventCount()).toBe(0);
  });

  it('--apply：那 2 条退回收集，三条齐的那条不动', async () => {
    const seeded = await seedMixed();

    const result = await moveBrieflessDesignToInbox(db);
    expect(result.moved).toBe(2);
    for (const id of seeded.designMissing) expect(await stateOf(id)).toBe('inbox');
    expect(await stateOf(seeded.designFilled)).toBe('design');

    // 前后分布：待设计 3 → 1，收集 +2。
    expect(result.before.design).toBe(3);
    expect(result.after.design).toBe(1);
    expect(result.after.inbox).toBe((result.before.inbox ?? 0) + 2);
  });

  it('已过评估的八个状态一条都不碰（即使它们六问全空）', async () => {
    const seeded = await seedMixed();
    const before = await distribution(db);

    await moveBrieflessDesignToInbox(db);

    for (const id of seeded.others) {
      expect(await stateOf(id)).not.toBe('inbox');
    }
    const after = await distribution(db);
    for (const state of ['review', 'queue', 'ready', 'dev', 'test', 'live', 'rejected', 'shelved']) {
      expect(after[state]).toBe(before[state]);
    }
  });

  it('软删的行不算：它对外等于不存在', async () => {
    const id = await seedRequirement({});
    await placeAt(id, 'design');
    await db.execute(sql`update requirements set deleted_at = now() where id = ${id}`);

    const result = await moveBrieflessDesignToInbox(db);
    expect(result.moved).toBe(0);
    expect(await stateOf(id)).toBe('design');
  });

  it('判据与 brief.ts 同一份：三条齐的行留着，缺任意一条的都退', async () => {
    const complete = await seedRequirement(FILLED);
    const missingContext = await seedRequirement({ problem: FILLED.problem, outcome: FILLED.outcome });
    const missingProblem = await seedRequirement({ context: FILLED.context, outcome: FILLED.outcome });
    const missingOutcome = await seedRequirement({ context: FILLED.context, problem: FILLED.problem });
    // 只有空白：`missingRequired` 里 trim 之后为空 = 没写（SQL 那边的 `<> ''` 会漏掉它）。
    const blank = await seedRequirement({ context: '   ', problem: FILLED.problem, outcome: FILLED.outcome });
    for (const id of [complete, missingContext, missingProblem, missingOutcome, blank]) {
      await placeAt(id, 'design');
    }

    const result = await moveBrieflessDesignToInbox(db);
    expect(result.moved).toBe(4);
    expect(await stateOf(complete)).toBe('design');
    for (const id of [missingContext, missingProblem, missingOutcome, blank]) {
      expect(await stateOf(id)).toBe('inbox');
    }
  });
});

describe('幂等', () => {
  it('第二次跑命中 0 行：不移动、不写第二条事件', async () => {
    const seeded = await seedMixed();

    const first = await moveBrieflessDesignToInbox(db);
    expect(first.moved).toBe(2);
    expect(await eventCount()).toBe(2);

    const second = await moveBrieflessDesignToInbox(db);
    expect(second.moved).toBe(0);
    expect(second.numbers).toEqual([]);
    expect(second.after).toEqual(second.before);
    expect(await eventCount()).toBe(2);
    for (const id of seeded.designMissing) expect(await stateOf(id)).toBe('inbox');
  });

  it('空库不报错：命中 0 行，分布是空的', async () => {
    const result = await moveBrieflessDesignToInbox(db);
    expect(result.moved).toBe(0);
    expect(result.before).toEqual({});
    expect(result.after).toEqual({});
    // 报告那张表在空库上也能印出来（只有表头一行）。
    expect(formatDistribution(result.before, result.after)).toHaveLength(1);
  });
});

describe('事件：一条状态变更，actor 是 system', () => {
  it('payload 带 from / to / reason / batch（批量不进通知）', async () => {
    const [id] = (await seedMixed()).designMissing;

    await moveBrieflessDesignToInbox(db);

    const res = await db.execute<{ actor: string; payload: string }>(sql`
      select actor, payload from events
       where requirement_id = ${id} and type = 'requirement.state_changed'`);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.actor).toBe('system');
    expect(JSON.parse(res.rows[0]!.payload)).toEqual({
      from: 'design', to: 'inbox', reason: REASON, batch: BATCH,
    });
    expect(REASON).toBe('六问核心三条不齐，v1 立项前必须先补');
  });
});
