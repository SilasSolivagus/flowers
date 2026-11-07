import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { resetDb, seedPeople } from './helpers/db.js';

/**
 * Ruling 2（2026-11-08）：没有负责人的需求回到「收集」——**终态不动**。
 *
 * 这一组**跑真迁移文件**（`0021_ownerless_to_inbox.sql` / `0023_restore_ownerless_terminal_states.sql`），
 * 不是在用例里重写一遍那条 SQL：迁移文件里那条 where 就是口径本身，抄一份到这里以后两边
 * 分叉，测试只会证明「抄的那份对」。跑两遍是为了钉住幂等——第二次必须是 no-op，
 * 尤其是 `state_entered_at` 不能被再刷一次（否则「停了 N 天」会每次迁移归零）。
 *
 * `rejected` / `shelved` / `live` 是**终态**：终态是结论，不是流程位置。没有负责人只说明
 * 「当年谁负责没记录」，不说明「这件事要重来」——把 `rejected` 拉回收集等于悄悄撤销一次
 * 拒绝决定，把 `live` 拉回收集会让一个已经在跑的功能显示「等领取」。
 */

let people: Awaited<ReturnType<typeof seedPeople>> = [];

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

/** 跑一份迁移文件：按 drizzle 的分隔符切开，逐条执行。 */
async function runMigration(file: string): Promise<void> {
  const text = await readFile(path.join(process.cwd(), 'src/db/migrations', file), 'utf8');
  for (const statement of text.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed !== '') await db.execute(sql.raw(trimmed));
  }
}

async function stateOf(id: string): Promise<{ state: string; entered: string }> {
  const res = await db.execute<{ state: string; entered: string }>(
    sql`select state, state_entered_at::text as entered from requirements where id = ${id}`);
  return res.rows[0]!;
}

/** 直接插两行：一条无主、一条有主，都停在「待设计」并且「停了 10 天」。 */
async function seedTwo(): Promise<{ ownerless: string; owned: string }> {
  const 吕品 = people.find((p) => p.name === '吕品')!.id;
  const res = await db.execute<{ id: string; title: string }>(sql`
    insert into requirements (title, type, requester, state, owner_member_id, state_entered_at)
    values
      ('没有人接的需求', 'feature', '王妍', 'design', null, now() - interval '10 days'),
      ('有人负责的需求', 'feature', '王妍', 'design', ${吕品}, now() - interval '10 days')
    returning id, title`);
  const ownerless = res.rows.find((r) => r.title === '没有人接的需求')!.id;
  const owned = res.rows.find((r) => r.title === '有人负责的需求')!.id;
  return { ownerless, owned };
}

describe('Ruling 2：无负责人 → 收集（真迁移文件，幂等）', () => {
  it('无主的行回到 inbox 且 state_entered_at 重置；有主的行一个字都不动', async () => {
    const { ownerless, owned } = await seedTwo();
    const before = await stateOf(ownerless);
    const ownedBefore = await stateOf(owned);

    await runMigration('0021_ownerless_to_inbox.sql');

    const after = await stateOf(ownerless);
    expect(after.state).toBe('inbox');
    // 刻意重置：它现在真的重新进入收集、重新开始排队等领取（理由见迁移注释）。
    expect(new Date(after.entered).getTime())
      .toBeGreaterThan(new Date(before.entered).getTime());

    expect(await stateOf(owned)).toEqual(ownedBefore);
  });

  it('再跑一次是 no-op：state_entered_at 不再被刷（幂等的强断言）', async () => {
    const { ownerless } = await seedTwo();

    await runMigration('0021_ownerless_to_inbox.sql');
    const first = await stateOf(ownerless);

    await runMigration('0021_ownerless_to_inbox.sql');
    const second = await stateOf(ownerless);

    expect(second).toEqual(first);
  });

  it('终态不动：无主的需求只剩「进行中」的进 inbox，rejected/shelved/live 留在原列', async () => {
    await seedTwo();
    // 再造几条散落在别的状态里的无主需求。
    await db.execute(sql`
      insert into requirements (title, type, requester, state, owner_member_id)
      values ('无主-待评审', 'feature', '王妍', 'review', null),
             ('无主-已搁置', 'feature', '王妍', 'shelved', null),
             ('无主-已拒绝', 'feature', '王妍', 'rejected', null),
             ('无主-已上线', 'feature', '王妍', 'live', null)`);

    await runMigration('0021_ownerless_to_inbox.sql');

    const res = await db.execute<{ state: string; count: string }>(sql`
      select state, count(*)::text as count
        from requirements
       where owner_member_id is null
       group by state
       order by state`);
    // design 1 + review 1 回到收集；三个终态原地不动。
    expect(res.rows).toEqual([
      { state: 'inbox', count: '2' },
      { state: 'live', count: '1' },
      { state: 'rejected', count: '1' },
      { state: 'shelved', count: '1' },
    ]);
  });

  it('已经在收集里的无主需求不会被再动一次（state_entered_at 保持原值）', async () => {
    await seedTwo();
    const { ownerless } = await seedTwo();
    await db.execute(sql`
      update requirements set state = 'inbox', state_entered_at = now() - interval '3 days'
       where id = ${ownerless}`);
    const before = await stateOf(ownerless);

    await runMigration('0021_ownerless_to_inbox.sql');

    expect(await stateOf(ownerless)).toEqual(before);
  });
});

/**
 * 0023：把第一版 0021 误移的终态行放回去。
 *
 * 迁移表里写死了 29 组「Flower uuid → 状态 → Flower 的 state_changed_at」，这里拿其中一条
 * （`61d46aef…` = `live`，Flower 的 `state_changed_at` 是 2026-03-12 07:32:56Z）造一个人工
 * 场景：行在 inbox、时间被 0021 刷成了 now()——正是线上那 29 行的样子。
 */
describe('Ruling 2 修订：终态无主行放回去（0023，幂等）', () => {
  const FLOWER_UUID = '61d46aef-4bec-5170-8bbd-af0fc8f5a409';
  const FLOWER_ENTERED = '2026-03-12T07:32:56.636Z';

  /** 造一条「0021 第一版已经拉回收集」的迁移行，并写下当年落地时的事件。 */
  async function seedDamaged(options: { state?: string; owner?: string | null } = {}): Promise<string> {
    const owner = options.owner ?? null;
    const res = await db.execute<{ id: string }>(sql`
      insert into requirements (title, type, requester, state, owner_member_id, state_entered_at, legacy_ref)
      values ('【推广分佣】转存优化需求2.0', 'feature', '未知', 'inbox', ${owner},
              now(), ${FLOWER_UUID})
      returning id`);
    const id = res.rows[0]!.id;
    await db.execute(sql`
      insert into events (requirement_id, actor, type, payload)
      values (${id}, 'migrate-flower', 'requirement.migrated',
              ${JSON.stringify({ sourceState: 'launched', state: options.state ?? 'live' })})`);
    return id;
  }

  it('状态与 state_entered_at 都回到 Flower 的事实值（不是 now()）', async () => {
    const id = await seedDamaged();

    await runMigration('0023_restore_ownerless_terminal_states.sql');

    const after = await stateOf(id);
    expect(after.state).toBe('live');
    expect(new Date(after.entered).toISOString()).toBe(FLOWER_ENTERED);
  });

  it('再跑一次是 no-op：已经不在 inbox 的行不再被碰', async () => {
    const id = await seedDamaged();

    await runMigration('0023_restore_ownerless_terminal_states.sql');
    const first = await stateOf(id);
    await runMigration('0023_restore_ownerless_terminal_states.sql');

    expect(await stateOf(id)).toEqual(first);
  });

  it('事件里的状态与迁移表对不上时不动它（宁可漏，不可编）', async () => {
    const id = await seedDamaged({ state: 'design' });

    await runMigration('0023_restore_ownerless_terminal_states.sql');

    const after = await stateOf(id);
    expect(after.state).toBe('inbox');
  });

  it('有负责人的行不动（这条迁移只修 0021 造成的无主误移）', async () => {
    const 吕品 = people.find((p) => p.name === '吕品')!.id;
    const id = await seedDamaged({ owner: 吕品 });
    const before = await stateOf(id);

    await runMigration('0023_restore_ownerless_terminal_states.sql');

    expect(await stateOf(id)).toEqual(before);
  });
});
