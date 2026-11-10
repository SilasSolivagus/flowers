import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { rollbackRelease } from '../src/core/requirements/rollback.js';
import { actionsFor } from '../src/core/read/detail.js';
import { assertTrigger, TRANSITIONS } from '../src/core/state-machine.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { BRIEF } from './helpers/brief.js';

/**
 * 回滚（2026-11-10）：live → queue。
 *
 * 这一组钉四件事：
 * 1. 状态机里确实有这条边，且只从 `live` 出发；
 * 2. 服务要求原因、要求权限，落库后版本与两个日期被清空；
 * 3. **落到 `queue` 而不是 `dev`**——`dev` 的时钟会立刻把它推回测试与已上线，
 *    这条用例如果哪天被「顺手改成 dev」，第二条断言就会红；
 * 4. 事件里留着「从哪一版撤回来的」。
 */

let people: Array<{ id: string; name: string; role: string; line: string | null }> = [];

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

const PM = '吕品';

function memberId(name: string): string {
  const found = people.find((p) => p.name === name);
  if (!found) throw new Error(`种子里没有成员 ${name}`);
  return found.id;
}

/** 造一条「已上线、挂在某个版本上、日期在过去」的需求（形状直接写库，不推时钟）。 */
async function liveRequirement(title = '回滚用例'): Promise<{ id: string; number: number }> {
  const created = await createRequirement(db, PM, {
    ...BRIEF, title, type: 'feature', requester: PM,
  });

  const release = await db.execute<{ id: string }>(sql`
    insert into releases (name, window_start, release_date)
    values ('2026.10', current_date - 30, current_date - 3)
    returning id`);

  await db.execute(sql`
    update requirements
       set state = 'live',
           state_entered_at = now() - interval '10 days',
           release_id = ${release.rows[0]!.id},
           commit_test_at = now() - interval '20 days',
           commit_due_at = now() - interval '5 days'
     where id = ${created.id}`);

  return created;
}

describe('状态机', () => {
  it('live → queue 由 rollback 触发，表里只有这一条倒着走的边', () => {
    expect(TRANSITIONS).toContainEqual({ from: 'live', to: 'queue', trigger: 'rollback' });
    expect(() => assertTrigger('live', 'queue', 'rollback')).not.toThrow();
    // 其余状态不许回滚。
    for (const state of ['inbox', 'design', 'review', 'queue', 'ready', 'dev', 'test'] as const) {
      expect(() => assertTrigger(state, 'queue', 'rollback')).toThrow();
    }
  });

  it('已上线那一列的合法动作里有「回滚」，且排在搁置之前', () => {
    expect(actionsFor('live')).toEqual(['rollback', 'shelve']);
  });
});

describe('回滚服务', () => {
  it('原因必填', async () => {
    const created = await liveRequirement();
    await expect(rollbackRelease(db, PM, { requirementId: created.id, reason: '  ' }))
      .rejects.toThrow(/原因/);
  });

  it('退回待排期，版本与两个日期清空，事件里留着撤回来之前的那一版', async () => {
    const created = await liveRequirement('发错了版本的那条');

    const got = await rollbackRelease(db, PM, {
      requirementId: created.id,
      reason: '发出去之后下单页 500，撤回',
    });
    expect(got).toEqual({ state: 'queue' });

    const row = (await db.execute<{
      state: string; release_id: string | null; commit_test_at: string | null; commit_due_at: string | null;
    }>(sql`select state, release_id, commit_test_at, commit_due_at from requirements where id = ${created.id}`)).rows[0]!;
    expect(row.state).toBe('queue');
    // 落到 queue 而不是 dev：dev 的时钟会立刻把它推回 live。
    expect(row.release_id).toBeNull();
    expect(row.commit_test_at).toBeNull();
    expect(row.commit_due_at).toBeNull();

    const event = (await db.execute<{ type: string; payload: unknown }>(sql`
      select type, payload from events
       where requirement_id = ${created.id} and type = 'requirement.rolled_back'
       order by seq desc limit 1`)).rows[0]!;
    expect(event.type).toBe('requirement.rolled_back');
    // `events.payload` 是 text（drizzle 没给它 jsonb 类型），读回来要自己解析。
    const payload = (typeof event.payload === 'string'
      ? JSON.parse(event.payload)
      : event.payload) as { reason: string; release: string | null; commitDueAt: string | null };
    expect(payload.reason).toContain('500');
    expect(payload.release).toBe('2026.10');
    expect(payload.commitDueAt).not.toBeNull();
  });

  it('不是负责人的 PM 不能回滚（与搁置同一条能力：edit）', async () => {
    const created = await liveRequirement();
    await expect(rollbackRelease(db, '李嘉', { requirementId: created.id, reason: '看着不顺眼' }))
      .rejects.toThrow(/只能改自己负责的需求/);
  });

  it('不在已上线状态时回滚撞状态机', async () => {
    const created = await createRequirement(db, PM, {
      ...BRIEF, title: '还在收集', type: 'feature', requester: PM,
    });
    await expect(rollbackRelease(db, PM, { requirementId: created.id, reason: '撤' }))
      .rejects.toThrow(/待排期|已上线/);
  });

  it('负责人自己能回滚（edit 能力有一条是「我是负责人」）', async () => {
    const created = await liveRequirement('负责人自己撤');
    await expect(rollbackRelease(db, PM, { requirementId: created.id, reason: '自己撤' }))
      .resolves.toEqual({ state: 'queue' });
    expect(memberId(PM)).toBeTruthy();
  });
});
