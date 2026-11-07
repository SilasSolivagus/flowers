import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { resetDb, seedPeople } from './helpers/db.js';

/**
 * 裁定 6（2026-11-08）：缺日期的「待开发 / 开发中 / 测试中」退回「待排期」。
 *
 * 这一组**跑真迁移文件**（`0024_dateless_clock_states_to_queue.sql`），不是在用例里
 * 重写一遍那条 SQL：迁移文件里那几行 where 就是口径本身，抄一份到这里以后两边分叉，
 * 用例只证明「抄的那份对」。
 *
 * 钉四件事：
 *
 * 1. **只动动不了的行**：三个状态各带一条「缺日期 → 退回收、有日期 → 原地不动」；
 * 2. `state_entered_at` 刷成 now()（它们今天真的重新进入待排期），而有日期的行
 *    一个字节都不动（`release_id`、三个日期列同样不许动）；
 * 3. 跑第二遍是 no-op（幂等，尤其 `state_entered_at` 不许再被刷一次）；
 * 4. 跑完之后「时钟状态里再没有缺日期的行」——这才是这条迁移真正想留下的不变量，
 *    因为 tick 对缺日期的行是整次抛错，一条这样的行会让全库的时钟停摆。
 *
 * 为什么另开一个文件而不是塞进 `ownerless-inbox.test.ts`：那个文件属于裁定 2
 * （无主），这条属于裁定 6（缺日期）。两条裁定的判据完全无关，混在一起以后
 * 「这条用例为什么红」要多读三十行才知道。
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

const MIGRATION = '0024_dateless_clock_states_to_queue.sql';

type Row = {
  state: string;
  entered: string;
  release_id: string | null;
  commit_test_at: string | null;
  commit_due_at: string | null;
  deleted_at: string | null;
};

async function rowOf(id: string): Promise<Row> {
  const res = await db.execute<Row>(sql`
    select state,
           state_entered_at::text as entered,
           release_id,
           commit_test_at::text as commit_test_at,
           commit_due_at::text as commit_due_at,
           deleted_at::text as deleted_at
      from requirements where id = ${id}`);
  return res.rows[0]!;
}

/**
 * 造一条需求，直接写成「某个时钟状态」。
 *
 * 不跑服务：真实数据里这些行**不是**服务造成的，它们是 `migrate-flower.ts` 搬进来的
 * （老系统只有状态、没有这三个日期）。所以这里也只能直接写库——走 `schedule` 造不出
 * 「dev 且没有提测日」这种形状，`schedule` 正是那条拦住它的门。
 *
 * 默认给一个版本，让「有日期的行」真的能被时钟推进（`tick` 还要求 release_id）。
 */
async function seedInState(opts: {
  state: string;
  commitTestAt?: string | null;
  commitDueAt?: string | null;
  withRelease?: boolean;
  deleted?: boolean;
  owner?: string | null;
}): Promise<string> {
  const owner = opts.owner === undefined
    ? people.find((p) => p.name === '吕品')!.id
    : opts.owner;
  const release = opts.withRelease === false
    ? null
    : (await db.execute<{ id: string }>(sql`
        insert into releases (name, window_start, release_date)
        values ('R-0024', ${'2026-12-01T00:00:00Z'}, ${'2026-12-20T00:00:00Z'})
        returning id`)).rows[0]!.id;

  const res = await db.execute<{ id: string }>(sql`
    insert into requirements
      (title, type, requester, state, owner_member_id, state_entered_at,
       release_id, commit_test_at, commit_due_at, deleted_at)
    values
      ('缺日期的迁移行', 'feature', '未知', ${opts.state}, ${owner},
       now() - interval '200 days',
       ${release}, ${opts.commitTestAt ?? null}, ${opts.commitDueAt ?? null},
       ${opts.deleted === true ? sql`now()` : null})
    returning id`);
  return res.rows[0]!.id;
}

describe('裁定 6：缺日期的时钟状态退回待排期（真迁移文件，幂等）', () => {
  it('三个状态各一条：缺日期的退回 queue，日期齐全的原地不动', async () => {
    const TEST_AT = '2026-12-10T00:00:00Z';
    const DUE_AT = '2026-12-20T00:00:00Z';
    // ready：提测日缺失 = 走一步就冻住（裁定 6 的判据）
    const readyFrozen = await seedInState({ state: 'ready', commitDueAt: DUE_AT });
    // ready：日期齐全，时钟还能推它 → 不动
    const readyOk = await seedInState({
      state: 'ready', commitTestAt: TEST_AT, commitDueAt: DUE_AT,
    });
    // dev：只缺承诺完成日也算动不了（提测日到了会推进到 test，然后冻住）
    const devFrozen = await seedInState({ state: 'dev', commitTestAt: TEST_AT });
    const devOk = await seedInState({ state: 'dev', commitTestAt: TEST_AT, commitDueAt: DUE_AT });
    const testFrozen = await seedInState({ state: 'test', commitTestAt: TEST_AT });
    const testOk = await seedInState({
      state: 'test', commitTestAt: TEST_AT, commitDueAt: DUE_AT,
    });

    const moving = [
      { id: readyFrozen, before: await rowOf(readyFrozen) },
      { id: devFrozen, before: await rowOf(devFrozen) },
      { id: testFrozen, before: await rowOf(testFrozen) },
    ];
    const staying = [
      { id: readyOk, before: await rowOf(readyOk) },
      { id: devOk, before: await rowOf(devOk) },
      { id: testOk, before: await rowOf(testOk) },
    ];

    await runMigration(MIGRATION);

    for (const { id, before } of moving) {
      const after = await rowOf(id);
      expect(after.state).toBe('queue');
      // 「今天重新进入待排期」：不是 200 天前的旧时刻（与 0023 的取舍相反，见迁移注释）。
      expect(new Date(after.entered).getTime())
        .toBeGreaterThan(new Date(before.entered).getTime());
      // release_id 与两个日期列一个字节都不改：日期缺失是事实，猜不出来也不替谁填。
      expect(after.release_id).toBe(before.release_id);
      expect(after.commit_test_at).toBe(before.commit_test_at);
      expect(after.commit_due_at).toBe(before.commit_due_at);
    }

    // 有日期的行：状态、时刻、版本、日期全部原样。
    for (const { id, before } of staying) expect(await rowOf(id)).toEqual(before);
  });

  it('再跑一次是 no-op：已经退回的行不再被碰（幂等的强断言）', async () => {
    const id = await seedInState({ state: 'dev' });

    await runMigration(MIGRATION);
    const first = await rowOf(id);
    await runMigration(MIGRATION);

    expect(first.state).toBe('queue');
    // 第二次不刷 state_entered_at —— 否则「停了 N 天」会每次迁移归零。
    expect(await rowOf(id)).toEqual(first);
  });

  it('其它状态不看日期：queue / live / rejected 缺日期也不动', async () => {
    const ids = [
      await seedInState({ state: 'queue' }),
      await seedInState({ state: 'live' }),
      await seedInState({ state: 'rejected' }),
    ];
    const before = await Promise.all(ids.map(rowOf));

    await runMigration(MIGRATION);

    for (const [i, id] of ids.entries()) expect(await rowOf(id)).toEqual(before[i]);
  });

  it('软删除的行不动：看板不显示它，tick 也不推进它', async () => {
    const id = await seedInState({ state: 'dev', deleted: true });
    const before = await rowOf(id);

    await runMigration(MIGRATION);

    expect(await rowOf(id)).toEqual(before);
  });

  it('跑完之后三个时钟状态里再没有缺日期的行（tick 不会再整次抛出）', async () => {
    // 一串「什么形状都有」的迁移数据：缺一个日期、缺两个日期、连版本都没有。
    await seedInState({ state: 'ready', withRelease: false });
    await seedInState({ state: 'dev', withRelease: false });
    await seedInState({ state: 'dev', commitTestAt: '2026-12-10T00:00:00Z' });
    await seedInState({ state: 'test', withRelease: false });
    await seedInState({ state: 'test', commitTestAt: '2026-12-10T00:00:00Z' });

    await runMigration(MIGRATION);

    // 口径与 `clock/tick.ts` 一致：三个状态都要求挂在版本上（`assertHasRelease`），
    // 各自的驱动日期也必须有（`deadlineDay`）。剩一条这样的行，tick 就整次抛出。
    const leftover = await db.execute<{ n: number }>(sql`
      select count(*)::int as n
        from requirements r
        left join releases rel on rel.id = r.release_id
       where r.deleted_at is null
         and (
           (r.state = 'ready' and (rel.window_start is null or r.commit_test_at is null))
           or (r.state = 'dev' and (r.commit_test_at is null or r.commit_due_at is null))
           or (r.state = 'test' and r.commit_due_at is null)
         )`);
    expect(leftover.rows[0]!.n).toBe(0);
  });
});
