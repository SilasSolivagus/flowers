import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { resetDb, seedPeople } from './helpers/db.js';

/**
 * 裁定（2026-11-08，owner 两次口述、修正一次）的两条流程规则：
 *
 *   1. 无负责人的需求回「收集」，但 `live` / `rejected` / `shelved` 不动；
 *   2. 有负责人但没有 PRD 的需求回「待设计」，但 `live` / `inbox` / `rejected` /
 *      `shelved` 不动（`design` 本身当然也不动）。
 *
 * 这一组跑**真迁移文件**（`0027_ownerless_and_prd_rules.sql`），不在用例里重写一遍那两条
 * SQL：迁移文件里那两个 where 就是口径本身，抄一份到这里以后两边分叉，用例只证明「抄的
 * 那份对」（与 `ownerless-inbox.test.ts` / `dateless-to-queue.test.ts` 同一条理由）。
 *
 * 钉五件事：
 *
 * 1. **规则 1 今天是一条空转的规则**：按今天那张库的形状造数据（无主行全在收集或终态里），
 *    跑完一行都不动——「moves 0 rows」不是一个说法，是一条断言；
 * 2. 它确实会动**进行中**的无主行（待设计 / 待评审 / 待排期 / 待开发 / 开发中 / 测试中），
 *    且 `state_entered_at` 刷成 now()（它们今天真的重新进入收集）；
 * 3. 规则 2 只动「有主 + 没有 PRD + 进行中（待评审 / 待排期 / 待开发 / 开发中 / 测试中）」，
 *    有 PRD 的不动，`inbox` 不回 `design`（那是倒着走），终态与 `design` 也不动；
 * 4. 无主的行归规则 1（→ inbox），不会被规则 2 拉去 `design`——两条判据互斥；
 * 5. 跑第二遍是 no-op（0 行），`state_entered_at` 不再被刷一次。
 */

let people: Awaited<ReturnType<typeof seedPeople>> = [];

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

const MIGRATION = '0027_ownerless_and_prd_rules.sql';

/** 跑一份迁移文件：按 drizzle 的分隔符切开，逐条执行。 */
async function runMigration(file: string): Promise<void> {
  const text = await readFile(path.join(process.cwd(), 'src/db/migrations', file), 'utf8');
  for (const statement of text.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed !== '') await db.execute(sql.raw(trimmed));
  }
}

type Row = {
  state: string;
  entered: string;
  prd_url: string | null;
  owner_member_id: string | null;
  deleted_at: string | null;
};

async function rowOf(id: string): Promise<Row> {
  const res = await db.execute<Row>(sql`
    select state,
           state_entered_at::text as entered,
           prd_url,
           owner_member_id,
           deleted_at::text as deleted_at
      from requirements where id = ${id}`);
  return res.rows[0]!;
}

const 吕品 = () => people.find((p) => p.name === '吕品')!.id;

/**
 * 直接插一行「停在某个状态」的需求。
 *
 * 不跑服务：真实数据里这两类行**不是**服务造成的——它们是 `migrate-flower.ts` 搬进来的
 * （老系统没有 PRD 链接，也没有负责人这一列）。走服务也造不出「无主的待设计」：
 * `evaluate` 要求 `edit`，而无主的行对谁都不可 `edit`（超管除外），这正是规则 1 想
 * 描述的那个形状。`state_entered_at` 给 30 天前，于是「有没有被重置」一眼看得出。
 */
async function seed(opts: {
  state: string;
  owner?: string | null;
  prd?: string | null;
  deleted?: boolean;
}): Promise<string> {
  const owner = opts.owner === undefined ? 吕品() : opts.owner;
  const res = await db.execute<{ id: string }>(sql`
    insert into requirements (title, type, requester, state, owner_member_id, prd_url,
                              state_entered_at, deleted_at)
    values ('0027 的夹具行', 'feature', '王妍', ${opts.state}, ${owner},
            ${opts.prd ?? null}, now() - interval '30 days',
            ${opts.deleted === true ? sql`now()` : null})
    returning id`);
  return res.rows[0]!.id;
}

/** 「0 行被移动」的可读断言：整行的四个观察列。 */
async function snapshot(ids: string[]): Promise<Row[]> {
  return Promise.all(ids.map(rowOf));
}

describe('规则 1：无负责人 → 收集（终态不动）', () => {
  it('按今天的库形状（无主行全在收集 / 终态里）跑一遍：一行都不动', async () => {
    // 今天那张库：195 条无主行 = inbox 166 · live 6 · rejected 17 · shelved 6。
    // 这里按同样的形状造 6 行——**没有任何一条「无主且进行中」**，所以规则 1 是空转的。
    const ids = [
      await seed({ state: 'inbox', owner: null }),
      await seed({ state: 'inbox', owner: null }),
      await seed({ state: 'live', owner: null }),
      await seed({ state: 'rejected', owner: null }),
      await seed({ state: 'shelved', owner: null }),
    ];
    const before = await snapshot(ids);

    await runMigration(MIGRATION);

    expect(await snapshot(ids)).toEqual(before);
    // 同一件事的更直接说法：命中这张形状的行数是 0。
    const moving = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from requirements
       where owner_member_id is null and deleted_at is null
         and state not in ('inbox', 'live', 'rejected', 'shelved')`);
    expect(moving.rows[0]!.n).toBe(0);
  });

  it('无主的进行中状态全部回收集，并重置 state_entered_at', async () => {
    const states = ['design', 'review', 'queue', 'ready', 'dev', 'test'];
    const ids = await Promise.all(states.map((state) => seed({ state, owner: null })));
    const before = await snapshot(ids);

    await runMigration(MIGRATION);

    for (const [i, id] of ids.entries()) {
      const after = await rowOf(id);
      expect(after.state).toBe('inbox');
      // 刻意重置：它现在真的重新进入收集、重新开始排队等认领（理由见迁移注释）。
      expect(new Date(after.entered).getTime())
        .toBeGreaterThan(new Date(before[i]!.entered).getTime());
      // 其它列一个字节都不改：无主是事实，PRD / 负责人不该被这条规则碰到。
      expect(after.prd_url).toBe(before[i]!.prd_url);
      expect(after.owner_member_id).toBeNull();
    }
  });

  it('无主的终态不动：live / rejected / shelved 连同时刻原样留着', async () => {
    const ids = [
      await seed({ state: 'live', owner: null }),
      await seed({ state: 'rejected', owner: null }),
      await seed({ state: 'shelved', owner: null }),
    ];
    const before = await snapshot(ids);

    await runMigration(MIGRATION);

    // 终态是结论，不是流程位置：给 live 盖上「今天回收集」等于说「它今天才上线」。
    expect(await snapshot(ids)).toEqual(before);
  });

  it('软删的行不动：它对外已经不存在（与 0024 / 0026 / 读侧同一条口径）', async () => {
    const id = await seed({ state: 'dev', owner: null, deleted: true });
    const before = await rowOf(id);

    await runMigration(MIGRATION);

    expect(await rowOf(id)).toEqual(before);
  });
});

describe('规则 2：有负责人但没有 PRD → 待设计（终态 / inbox / design 不动）', () => {
  it('有主 + 无 PRD + 待排期 → 待设计，并重置 state_entered_at', async () => {
    const id = await seed({ state: 'queue' });
    const before = await rowOf(id);

    await runMigration(MIGRATION);

    const after = await rowOf(id);
    expect(after.state).toBe('design');
    expect(new Date(after.entered).getTime())
      .toBeGreaterThan(new Date(before.entered).getTime());
    // 负责人与「没有 PRD」这两件事实本身不改：迁移只摆位置，不替谁补文档。
    expect(after.owner_member_id).toBe(before.owner_member_id);
    expect(after.prd_url).toBeNull();
  });

  it('有主 + 无 PRD 的其它进行中状态同样回待设计', async () => {
    const ids = await Promise.all(
      ['review', 'ready', 'dev', 'test'].map((state) => seed({ state })),
    );

    await runMigration(MIGRATION);

    for (const id of ids) expect((await rowOf(id)).state).toBe('design');
  });

  it('回到收集是倒着走：有主 + 无 PRD 的 inbox 不动', async () => {
    const id = await seed({ state: 'inbox' });
    const before = await rowOf(id);

    await runMigration(MIGRATION);

    // `inbox → design` 是 `evaluate` 这个**动作**（要有人点、要写一条事件）。迁移替人
    // 走这一步，会让一条没人评估过的需求看起来「已评估」，而事件流里没有那一笔。
    expect(await rowOf(id)).toEqual(before);
  });

  it('终态与目标状态不动：live / rejected / shelved / design', async () => {
    const ids = [
      await seed({ state: 'live' }),
      await seed({ state: 'rejected' }),
      await seed({ state: 'shelved' }),
      await seed({ state: 'design' }),
    ];
    const before = await snapshot(ids);

    await runMigration(MIGRATION);

    expect(await snapshot(ids)).toEqual(before);
  });

  it('有 PRD 的待排期不动（门是「没有文档」，不是「在待排期」）', async () => {
    const id = await seed({ state: 'queue', prd: 'https://doc.example.com/prd' });
    const before = await rowOf(id);

    await runMigration(MIGRATION);

    expect(await rowOf(id)).toEqual(before);
  });

  it('PRD 是一串空白也算没有 PRD（与 submit_review 的 `if (!url)` 同源）', async () => {
    const id = await seed({ state: 'queue', prd: '   ' });

    await runMigration(MIGRATION);

    expect((await rowOf(id)).state).toBe('design');
  });

  it('软删的行不动：它对外已经不存在（规则 2 的 `deleted_at is null`）', async () => {
    const id = await seed({ state: 'queue', deleted: true });
    const before = await rowOf(id);

    await runMigration(MIGRATION);

    expect(await rowOf(id)).toEqual(before);
  });

  it('无主 + 无 PRD 的行归规则 1（→ 收集），不会被规则 2 拉去待设计', async () => {
    // 两条判据互斥（owner 为空 / 非空），但这一条钉住「互斥」这件事：一条既没负责人
    // 也没 PRD 的待排期需求，真实缺口是「没人接」，所以它去收集，不是去待设计。
    const id = await seed({ state: 'queue', owner: null });

    await runMigration(MIGRATION);

    expect((await rowOf(id)).state).toBe('inbox');
  });
});

describe('幂等：跑第二遍是 no-op', () => {
  it('两条规则都已落位时再跑一遍，一行都不动（state_entered_at 不再刷）', async () => {
    const ids = [
      await seed({ state: 'queue' }),
      await seed({ state: 'dev' }),
      await seed({ state: 'queue', owner: null }),
      await seed({ state: 'live', owner: null }),
    ];

    await runMigration(MIGRATION);
    const first = await snapshot(ids);
    await runMigration(MIGRATION);

    // 第二次一个字都不改：否则「停了 N 天」会每次重放都归零。
    expect(await snapshot(ids)).toEqual(first);
  });

  it('重放之前被推进去的行会被再拉回来（重复执行是期望，不只是安全）', async () => {
    const id = await seed({ state: 'queue' });
    await runMigration(MIGRATION);
    expect((await rowOf(id)).state).toBe('design');

    // 模拟一次绕过写入口的漂移：脚本 / MCP / 直接写库把这条没 PRD 的需求塞回待排期。
    await db.execute(sql`update requirements set state = 'queue' where id = ${id}`);

    await runMigration(MIGRATION);

    expect((await rowOf(id)).state).toBe('design');
  });
});
