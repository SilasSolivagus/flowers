import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { recordEvent } from '../src/core/events.js';
import { AppError, translatePgError } from '../src/core/errors.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { resetDb, seedPeople } from './helpers/db.js';

/**
 * C1 的回归防线：编号（events.seq / requirements.number）曾经是 `max(col)+1`，
 * 那是一次无锁的「读—算—写」——不同行的并发写彼此没有互斥（行锁只管同一行），
 * 于是两个事务算出同一个值，输的那个撞唯一约束。
 *
 * 复现基线（改序列之前，本机实测）：12 个并发 evaluate 打 12 条**不同**需求，
 * 每轮失败 9 / 9 / 6，全部 23505 events_pkey；6 个并发 create 每轮只成功 1 个。
 * 下面的 N=12 就是那个 reproduce 出来的并发度，不是「挑一个好看的数」。
 */
const N = 12;

beforeEach(async () => {
  await resetDb();
  await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

/** 抓 reject 出来的错误，让调用方同时断言 instance、code、message。 */
async function caught(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('expected AppError, nothing thrown');
}

function failures(results: PromiseSettledResult<unknown>[]): PromiseRejectedResult[] {
  return results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
}

describe('C1：并发分配编号（序列，不是 max+1）', () => {
  it(`12 个并发 evaluate 打 12 条不同需求，全部成功且 seq 两两不同`, async () => {
    const created = [];
    for (let i = 0; i < N; i += 1) {
      created.push(await createRequirement(db, '吕品', {
        title: `并发-${i}`, type: 'feature', requester: '孙建宏',
      }));
    }
    // 12 条不同的行：这里面没有任何行锁争用，正是断言「互斥必须来自编号分配本身」。
    expect(new Set(created.map((r) => r.id)).size).toBe(N);

    const results = await Promise.allSettled(
      created.map((r) => evaluate(db, '吕品', { requirementId: r.id })),
    );

    expect(failures(results).map((f) => (f.reason as { code?: string }).code)).toEqual([]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(N);

    // 12 条需求都进了 design。
    const states = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from requirements where state = 'design'`);
    expect(Number(states.rows[0]!.n)).toBe(N);

    // 12 条 evaluate 事件，12 个互不相同的 seq —— 撞过一次就写不出这个矩阵。
    const events = await db.execute<{ seq: number }>(sql`
      select seq from events where type = 'requirement.evaluated' order by seq`);
    expect(events.rows).toHaveLength(N);
    expect(new Set(events.rows.map((r) => Number(r.seq))).size).toBe(N);
  });

  it('6 个并发 createRequirement 全部成功，编号两两不同', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => createRequirement(db, '吕品', {
        title: `并发建-${i}`, type: 'feature', requester: '孙建宏',
      })),
    );

    expect(failures(results).map((f) => (f.reason as { code?: string }).code)).toEqual([]);
    // 不用 filter 的类型谓词：PromiseSettledResult 的窄化比这里需要的更啰嗦。
    const numbers: number[] = [];
    for (const r of results) if (r.status === 'fulfilled') numbers.push(r.value.number);
    expect(numbers).toHaveLength(6);
    expect(new Set(numbers).size).toBe(6);

    // 编号落库后仍然两两不同，且没有空洞以外的问题（6 条行、6 个号）。
    const rows = await db.execute<{ number: number }>(sql`select number from requirements`);
    expect(rows.rows).toHaveLength(6);
    expect(new Set(rows.rows.map((r) => Number(r.number))).size).toBe(6);
  });

  it('编号来自序列的 default（回退到 max+1 会立刻红）', async () => {
    const res = await db.execute<{ table_name: string; column_default: string | null }>(sql`
      select table_name, column_default from information_schema.columns
       where (table_name = 'events' and column_name = 'seq')
          or (table_name = 'requirements' and column_name = 'number')
       order by table_name`);
    expect(res.rows).toEqual([
      { table_name: 'events', column_default: "nextval('events_seq_seq'::regclass)" },
      { table_name: 'requirements', column_default: "nextval('requirements_number_seq'::regclass)" },
    ]);
  });
});

describe('C1：23505 在边界上翻成 AppError', () => {
  /**
   * 序列之后正常路径撞不上唯一约束，所以这里**人为**制造一次真实的 23505：
   * truncate restart identity 把序列复位到 1 之后，先手写一条 seq=1 的事件，
   * 下一次 nextval 就会撞 events_pkey —— 走的仍是 pg 的原生报错路径。
   */
  it('真实的 23505 变成 AppError(conflict)，不是英文的 duplicate key', async () => {
    await db.execute(sql`insert into events (seq, actor, type, payload) values (1, 'x', 'y', '{}')`);

    const e = await caught(db.transaction(async (tx) => {
      await recordEvent(tx, { requirementId: null, actor: '吕品', type: 'requirement.created', payload: {} });
    }));
    expect(e.code).toBe('conflict');
    expect(e.message).toBe('编号冲突，请重试');

    // 事务回滚：那条手写的事件还在，新的没写进去。
    const rows = await db.execute<{ n: number }>(sql`select count(*)::int as n from events`);
    expect(Number(rows.rows[0]!.n)).toBe(1);
  });

  it('非 23505 原样放行，不被吞也不被改写', () => {
    const original = Object.assign(new Error('boom'), { code: 'P0001' });
    expect(translatePgError(original)).toBe(original);

    const plain = new Error('普通错误');
    expect(translatePgError(plain)).toBe(plain);

    // 没有 code 的普通对象也不会被当成 pg 错误。
    expect(translatePgError({ message: 'x' })).toEqual({ message: 'x' });
  });
});
