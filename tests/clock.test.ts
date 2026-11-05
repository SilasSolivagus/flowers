import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { tick, deadlineDay, shanghaiDayOf } from '../src/core/clock/tick.js';
import { AppError } from '../src/core/errors.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { makeQueued, makeReadyAt, makeRelease } from './helpers/factory.js';

beforeEach(async () => {
  await resetDb();
  await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

/**
 * 抓 reject 出来的错误，让调用方同时断言 instance、code、message（R13）。
 * 与 requirements.test.ts 里同名助手一致：vitest 传 AppError 实例给
 * `rejects.toThrowError` 时只比 message，放过 code 悄悄改错的情况。
 */
async function caught(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('expected AppError, nothing thrown');
}

/** `deadlineDay` 是同步函数，抛错不会变成 rejected promise，单独抓。 */
function caughtSync(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('expected AppError, nothing thrown');
}

async function stateOf(id: string): Promise<string> {
  const r = await db.execute<{ state: string }>(sql`select state from requirements where id = ${id}`);
  return r.rows[0]!.state;
}

/**
 * 等到库里有 n 个后端因为行锁阻塞。用来把「两个 tick 真的重叠了」变成确定事实，
 * 而不是靠 sleep 猜时序；等不到就直接失败（说明取行语句没拿行锁）。
 */
async function waitForLockWaiters(n: number): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const r = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
       where wait_event_type = 'Lock' and datname = current_database()`);
    if (Number(r.rows[0]!.n) >= n) return;
    if (Date.now() > deadline) {
      throw new Error(`等锁的后端不足 ${n} 个：tick 取行可能没有 for update`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function autoEvents(id: string) {  const r = await db.execute<{ type: string; actor: string; payload: string }>(sql`
    select type, actor, payload from events
     where requirement_id = ${id} and type like 'requirement.auto_%'
     order by seq`);
  return r.rows;
}

describe('tick — 三条自动转移', () => {
  it('到开工日，待开发 → 开发中', async () => {
    const { id } = await makeReadyAt('2026-12-01', '2026-12-01', '2026-12-04');
    const out = await tick(db, new Date('2026-12-01T00:00:00+08:00'));
    expect(out.moved).toContainEqual({ id, from: 'ready', to: 'dev' });
    expect(await stateOf(id)).toBe('dev');
  });

  it('到提测日，开发中 → 测试中', async () => {
    const { id } = await makeReadyAt('2026-12-01', '2026-12-01', '2026-12-04');
    await tick(db, new Date('2026-12-01T00:00:00+08:00'));
    const out = await tick(db, new Date('2026-12-03T00:00:00+08:00'));
    expect(out.moved).toContainEqual({ id, from: 'dev', to: 'test' });
    expect(await stateOf(id)).toBe('test');
  });

  it('到承诺完成日，测试中 → 已上线', async () => {
    const { id } = await makeReadyAt('2026-12-01', '2026-12-01', '2026-12-04');
    await tick(db, new Date('2026-12-01T00:00:00+08:00'));
    await tick(db, new Date('2026-12-03T00:00:00+08:00'));
    const out = await tick(db, new Date('2026-12-04T00:00:00+08:00'));
    expect(out.moved).toContainEqual({ id, from: 'test', to: 'live' });
    expect(await stateOf(id)).toBe('live');
  });
});

describe('tick — 幂等', () => {
  /**
   * 这条用例的 fixture 与 brief 不同：brief 用 makeReadyAt('2026-12-01','2026-12-01','2026-12-04')
   * 再在 12-01 01:00 期望 0 条推进，但那组数据下提测日就是 12-01，第二次 tick 到点时
   * dev → test 是**正确**行为（见下面 R17 用例）。要测「重复 tick 不重复推进」，
   * 提测日必须晚于这次 tick 的时刻，否则测的其实是「到点就该推进」。
   */
  it('重复 tick 不会重复推进', async () => {
    const { id } = await makeReadyAt('2026-12-01', '2026-12-03', '2026-12-04');
    const first = await tick(db, new Date('2026-12-01T00:00:00+08:00'));
    expect(first.moved).toEqual([{ id, from: 'ready', to: 'dev' }]);

    const again = await tick(db, new Date('2026-12-01T01:00:00+08:00'));
    expect(again.moved).toHaveLength(0);
    // 只断言「推了 0 条」不够：「一次 tick 推两步、两步后又回到同一状态」也会给出
    // 空 moved。状态 + 事件条数一起钉，才能区分「没动」和「动了但看起来没动」。
    expect(await stateOf(id)).toBe('dev');
    expect(await autoEvents(id)).toHaveLength(1);
  });

  it('一次 tick 只推进一步，窗口开始日早已过去也一样', async () => {
    const { id } = await makeReadyAt('2026-01-01', '2026-01-05', '2026-01-10');
    const out = await tick(db, new Date('2026-03-01T09:00:00+08:00'));
    expect(out.moved).toEqual([{ id, from: 'ready', to: 'dev' }]);
    expect(await stateOf(id)).toBe('dev');
  });

  it('到点前不动，开工日当天零点（Asia/Shanghai）才动', async () => {
    const { id } = await makeReadyAt('2026-12-01', '2026-12-03', '2026-12-04');
    const before = await tick(db, new Date('2026-11-30T23:59:59+08:00'));
    expect(before.moved).toHaveLength(0);
    expect(await stateOf(id)).toBe('ready');

    const at = await tick(db, new Date('2026-12-01T00:00:00+08:00'));
    expect(at.moved).toContainEqual({ id, from: 'ready', to: 'dev' });
  });

  it('一次 tick 推进所有到点的行，没到点的不动', async () => {
    const due = await makeReadyAt('2026-12-01', '2026-12-03', '2026-12-04');
    const later = await makeReadyAt('2026-12-05', '2026-12-08', '2026-12-09');
    const out = await tick(db, new Date('2026-12-01T00:00:00+08:00'));
    expect(out.moved).toEqual([{ id: due.id, from: 'ready', to: 'dev' }]);
    expect(await stateOf(later.id)).toBe('ready');
  });

  it('非时钟状态既不动，也不因为没排期/没日期报错', async () => {
    const queued = await makeQueued();
    const inbox = await createRequirement(db, '吕品', { title: 'i', type: 'feature', requester: 'b' });
    const out = await tick(db, new Date('2027-01-01T00:00:00+08:00'));
    expect(out.moved).toHaveLength(0);
    expect(await stateOf(queued.id)).toBe('queue');
    expect(await stateOf(inbox.id)).toBe('inbox');
  });
});

describe('tick — R17：打回后仍在测试窗内的交互（保留，不特判）', () => {
  /**
   * 打回只重填 commit_due_at，commit_test_at 保持不变；因此在提测日之后打回的需求，
   * 下一次 tick 会立刻被推回测试中。这是**有意保留**的行为（语义上它确实还在测试窗内，
   * 真正的上线门槛是新的承诺完成日），tick 里没有针对「刚打回的行」的特判。
   * Task 9 若认为需要 guard，以这条用例为准去改。
   */
  it('打回后的 dev 行，commit_test_at 已过 → 下次 tick 直接回 test，上线仍等新完成日', async () => {
    const { id } = await makeReadyAt('2026-12-01', '2026-12-01', '2026-12-04');
    await tick(db, new Date('2026-12-01T00:00:00+08:00'));
    await tick(db, new Date('2026-12-03T00:00:00+08:00'));
    expect(await stateOf(id)).toBe('test');

    // 模拟 Task 9 的 bounce：回 dev、只换承诺完成日，提测日原样不动。
    await db.execute(sql`
      update requirements
         set state = 'dev', commit_due_at = '2026-12-10T00:00:00Z', state_entered_at = now()
       where id = ${id}`);
    const bouncedAt = await db.execute<{ commit_test_at: string }>(
      sql`select commit_test_at from requirements where id = ${id}`);
    expect(new Date(bouncedAt.rows[0]!.commit_test_at).toISOString()).toBe('2026-12-01T00:00:00.000Z');

    const out = await tick(db, new Date('2026-12-03T00:10:00+08:00'));
    expect(out.moved).toContainEqual({ id, from: 'dev', to: 'test' });
    expect(await stateOf(id)).toBe('test');

    // 新的承诺完成日才是上线门槛：12-09 不动，12-10 当天上线。
    expect((await tick(db, new Date('2026-12-09T00:00:00+08:00'))).moved).toHaveLength(0);
    expect(await stateOf(id)).toBe('test');
    expect((await tick(db, new Date('2026-12-10T00:00:00+08:00'))).moved)
      .toContainEqual({ id, from: 'test', to: 'live' });
  });
});

describe('tick — 事件与并发', () => {
  it('每次推进写一条 system 事件，payload 记录 from / to / tick 时刻', async () => {
    const { id } = await makeReadyAt('2026-12-01', '2026-12-03', '2026-12-04');
    await tick(db, new Date('2026-12-01T00:00:00+08:00'));

    const rows = await autoEvents(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'requirement.auto_dev', actor: 'system' });
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      from: 'ready', to: 'dev', at: '2026-11-30T16:00:00.000Z',
    });
  });

  it('走完整条链，三条事件类型依次是 auto_dev / auto_test / auto_live', async () => {
    const { id } = await makeReadyAt('2026-12-01', '2026-12-01', '2026-12-04');
    await tick(db, new Date('2026-12-01T00:00:00+08:00'));
    await tick(db, new Date('2026-12-03T00:00:00+08:00'));
    await tick(db, new Date('2026-12-04T00:00:00+08:00'));

    expect((await autoEvents(id)).map((e) => e.type)).toEqual([
      'requirement.auto_dev', 'requirement.auto_test', 'requirement.auto_live',
    ]);

    // state_entered_at 跟着 tick 的时刻走（不是 now()），否则对不上排期时间轴。
    const row = await db.execute<{ state_entered_at: string }>(
      sql`select state_entered_at from requirements where id = ${id}`);
    expect(new Date(row.rows[0]!.state_entered_at).toISOString()).toBe('2026-12-03T16:00:00.000Z');
  });

  it('两个 tick 并发时同一行只推进一步（for update 生效）', async () => {
    const { id } = await makeReadyAt('2026-12-01', '2026-12-03', '2026-12-04');
    const at = new Date('2026-12-01T00:00:00+08:00');

    // 直接从外部把这一行锁住，再放两个 tick 进去：两个 tick 都会卡在取行的语句上
    // （wait_event_type='Lock'），锁一放，一个先拿到、推一步并提交，另一个重新读到的
    // 就是 dev，提测日（12-03）还没到，什么也不推。
    //
    // 为什么要这么写：直接 `Promise.all([tick, tick])` 时第一次 SELECT 未必重叠——
    // 实测把 for update 去掉后那条用例照样通过（一个跑完另一个才开始），
    // 它证明不了锁。这里先制造确定的阻塞点：去掉 for update 后，两个 tick 都不拿行锁、
    // 都读到 ready，随后两条 update 排在 blocker 的行锁后面，锁一放先后都执行——
    // 于是同一步被写两次、两条事件、state 仍是 dev，用例因为 moved 有两条而红。
    const blocker = await pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select 1 from requirements where id = $1 for update', [id]);

      // 先挂上拒绝处理再等锁：waitForLockWaiters 抛出时这两个 promise 还没 await，
      // 它们的失败会变成 unhandled rejection 打在测试进程上，掩盖真正的失败。
      const p1 = tick(db, at);
      p1.catch(() => {});
      const p2 = tick(db, at);
      p2.catch(() => {});

      await waitForLockWaiters(2);

      await blocker.query('commit');
      const [a, b] = await Promise.all([p1, p2]);

      expect([...a.moved, ...b.moved]).toEqual([{ id, from: 'ready', to: 'dev' }]);
      expect(await stateOf(id)).toBe('dev');
      expect(await autoEvents(id)).toHaveLength(1);
    } finally {
      // 失败路径上 blocker 还开着事务、还锁着这一行；只 release() 会把「开着事务的连接」
      // 还回池子，下一条用例的 resetDb() 的 truncate 就卡在这把行锁上直到超时——
      // 一条红变成整片红。先 rollback 再还连接，rollback 失败也不能盖住原错误。
      await blocker.query('rollback').catch(() => {});
      blocker.release();
    }
  });
});

describe('tick — 坏数据不静默跳过', () => {
  it('待在待开发却没有版本 → 报错，而不是永远不动', async () => {
    const r = await createRequirement(db, '吕品', { title: 'b', type: 'feature', requester: 'b' });
    await db.execute(sql`update requirements set state = 'ready' where id = ${r.id}`);

    const e = await caught(tick(db, new Date('2026-12-01T00:00:00+08:00')));
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('clock_missing_deadline');
    expect(e.message).toBe(`需求 ${r.id} 处于「待开发」但没有排期版本，无法自动推进`);
  });

  /**
   * 版本检查必须对三个状态一视同仁：dev / test 行不读 window_start，若只在
   * window_start 为空时报错，release_id 为 null 的 dev 行会被静默推成 test → live。
   * 这类行没有版本就没有开工日，属于损坏数据，必须喊出来。
   */
  it('开发中却没有版本 → 报错（不会静默推进到测试中）', async () => {
    const r = await createRequirement(db, '吕品', { title: 'b', type: 'feature', requester: 'b' });
    await db.execute(sql`
      update requirements
         set state = 'dev', release_id = null, commit_test_at = '2026-12-01T00:00:00Z'
       where id = ${r.id}`);

    const e = await caught(tick(db, new Date('2026-12-02T00:00:00+08:00')));
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('clock_missing_deadline');
    expect(e.message).toBe(`需求 ${r.id} 处于「开发中」但没有排期版本，无法自动推进`);
    expect(await stateOf(r.id)).toBe('dev');
  });

  it('测试中却没有版本 → 报错（不会静默推上线）', async () => {
    const r = await createRequirement(db, '吕品', { title: 'b', type: 'feature', requester: 'b' });
    await db.execute(sql`
      update requirements
         set state = 'test', release_id = null,
             commit_test_at = '2026-12-01T00:00:00Z', commit_due_at = '2026-12-04T00:00:00Z'
       where id = ${r.id}`);

    const e = await caught(tick(db, new Date('2026-12-05T00:00:00+08:00')));
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('clock_missing_deadline');
    expect(e.message).toBe(`需求 ${r.id} 处于「测试中」但没有排期版本，无法自动推进`);
    expect(await stateOf(r.id)).toBe('test');
  });

  it('开发中却没有提测日 → 报错', async () => {
    // 版本要给：否则先撞「没有排期版本」，测不到提测日这一格。
    const releaseId = await makeRelease('R-1', '2026-12-01', '2026-12-04');
    const r = await createRequirement(db, '吕品', { title: 'b', type: 'feature', requester: 'b' });
    await db.execute(sql`
      update requirements set state = 'dev', release_id = ${releaseId} where id = ${r.id}`);

    const e = await caught(tick(db, new Date('2026-12-01T00:00:00+08:00')));
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('clock_missing_deadline');
    expect(e.message).toBe(`需求 ${r.id} 处于「开发中」但缺少提测日，无法自动推进`);
  });

  it('测试中却没有承诺完成日 → 报错', async () => {
    const releaseId = await makeRelease('R-1', '2026-12-01', '2026-12-04');
    const r = await createRequirement(db, '吕品', { title: 'b', type: 'feature', requester: 'b' });
    await db.execute(sql`
      update requirements
         set state = 'test', release_id = ${releaseId}, commit_test_at = '2026-12-01T00:00:00Z'
       where id = ${r.id}`);

    const e = await caught(tick(db, new Date('2026-12-01T00:00:00+08:00')));
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('clock_missing_deadline');
    expect(e.message).toBe(`需求 ${r.id} 处于「测试中」但缺少承诺完成日，无法自动推进`);
  });

  it('一条坏行会让整次 tick 回滚，不留半推进状态', async () => {
    const good = await makeReadyAt('2026-12-01', '2026-12-03', '2026-12-04');
    const bad = await createRequirement(db, '吕品', { title: 'b', type: 'feature', requester: 'b' });
    await db.execute(sql`update requirements set state = 'ready' where id = ${bad.id}`);

    const e = await caught(tick(db, new Date('2026-12-01T00:00:00+08:00')));
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('clock_missing_deadline');
    expect(e.message).toBe(`需求 ${bad.id} 处于「待开发」但没有排期版本，无法自动推进`);
    expect(await stateOf(good.id)).toBe('ready');
    expect(await autoEvents(good.id)).toHaveLength(0);
  });

  it('时间戳解析不出来就报错（不把 NaN 当成「没到点」）', async () => {
    const e = caughtSync(
      () => deadlineDay('不是时间', { requirementId: 'r-1', state: 'dev', field: 'commit_test_at' }),
    );
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('clock_bad_deadline');
    expect(e.message).toBe('需求 r-1 的提测日不是有效时间：不是时间');
  });

  it('tick 的 now 是 Invalid Date 时直接报错，而不是静默推进 0 条', async () => {
    const e = await caught(tick(db, new Date('nope')));
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('invalid');
    expect(e.message).toBe('时钟时间不合法');
  });
});

describe('deadlineDay / shanghaiDayOf — timestamptz 字符串按 Asia/Shanghai 的「天」比较', () => {
  it('db.execute 回来的那种字符串能解析成同一时刻', () => {
    // pg 的文本协议给的是 '2026-12-04 00:00:00+00'，不是 Date；直接和 Date 比会是 NaN。
    expect(shanghaiDayOf('2026-12-04 00:00:00+00')).toBe(shanghaiDayOf('2026-12-04T08:00:00+08:00'));
    expect(shanghaiDayOf('2026-12-04 00:00:00+00')).toBe(shanghaiDayOf('2026-12-04T00:00:00.000Z'));
  });

  it('天界按 Asia/Shanghai 切：UTC 同一天里跨过北京零点就换天', () => {
    const beforeMidnight = shanghaiDayOf('2026-11-30T15:59:59.999Z'); // 北京 11-30 23:59:59
    const atMidnight = shanghaiDayOf('2026-11-30T16:00:00.000Z');     // 北京 12-01 00:00:00
    expect(atMidnight! - beforeMidnight!).toBe(1);
  });

  it('window_start 为空时的文案仍钉住（库里取不到该路径，只能对纯函数测）', () => {
    // releases.window_start 是 not null，版本检查又先一步拦掉没有版本的行，
    // 所以这条分支在真实数据上走不到；但它是 deadlineDay 的契约，照旧钉死文案。
    const e = caughtSync(
      () => deadlineDay(null, { requirementId: 'r-1', state: 'ready', field: 'window_start' }),
    );
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('clock_missing_deadline');
    expect(e.message).toBe('需求 r-1 处于「待开发」但缺少开工日，无法自动推进');
  });

  it('解析不出来的字符串返回 null，交给调用方报错', () => {
    expect(shanghaiDayOf('不是时间')).toBeNull();
  });
});
