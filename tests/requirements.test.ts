import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { AppError } from '../src/core/errors.js';
import { resetDb, seedPeople } from './helpers/db.js';

beforeEach(async () => {
  await resetDb();
  await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

/**
 * 抓取 reject 出来的错误，让调用方同时断言 instance、code、message。
 *
 * 不要退回 `rejects.toThrowError(new AppError('code', '消息'))`：vitest 传实例时
 * 只比较 `.message`，`new Error('同样的消息')` 或换了 code 的 AppError 都会算通过，
 * 而下游服务是按 `e.code` 分支的。
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

async function requirementCount(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`select count(*)::int as n from requirements`);
  return Number(res.rows[0]!.n);
}

describe('createRequirement', () => {
  it('建出来就是 inbox，编号从 1 开始', async () => {
    const r = await createRequirement(db, '吕品', {
      title: 'S3 协议支持', type: 'feature', requester: '孙建宏',
    });
    expect(r.state).toBe('inbox');
    expect(r.number).toBe(1);

    const row = await db.execute<{ state: string; title: string; type: string }>(
      sql`select state, title, type from requirements where id = ${r.id}`,
    );
    expect(row.rows[0]).toMatchObject({ state: 'inbox', title: 'S3 协议支持', type: 'feature' });
  });

  it('每次创建写一条事件', async () => {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    const rows = await db.execute<{ type: string; requirement_id: string; actor: string; payload: string }>(
      sql`select type, requirement_id, actor, payload from events`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      type: 'requirement.created',
      requirement_id: r.id,
      actor: '吕品',
    });
    expect(JSON.parse(rows.rows[0]!.payload)).toMatchObject({
      number: 1, title: 'a', type: 'feature',
    });
  });

  it('类型缺失或不在枚举内都直接拒绝', async () => {
    expect(await caught(createRequirement(db, '吕品', {
      title: 'x', requester: 'y',
    } as never))).toMatchObject({ code: 'invalid', message: '必须选择类型：商业或功能' });

    expect(await caught(createRequirement(db, '吕品', {
      title: 'x', type: 'other', requester: 'y',
    } as never))).toMatchObject({ code: 'invalid', message: '必须选择类型：商业或功能' });

    expect(await requirementCount()).toBe(0);
  });

  it('标题缺失或只有空白都拒绝', async () => {
    expect(await caught(createRequirement(db, '吕品', {
      type: 'feature', requester: 'y',
    } as never))).toMatchObject({ code: 'invalid', message: '标题不能为空' });

    expect(await caught(createRequirement(db, '吕品', {
      title: '   ', type: 'feature', requester: 'y',
    }))).toMatchObject({ code: 'invalid', message: '标题不能为空' });
  });

  it('提出人缺失或只有空白都拒绝', async () => {
    expect(await caught(createRequirement(db, '吕品', {
      title: 'x', type: 'feature',
    } as never))).toMatchObject({ code: 'invalid', message: '提出人不能为空' });

    expect(await caught(createRequirement(db, '吕品', {
      title: 'x', type: 'feature', requester: ' ',
    }))).toMatchObject({ code: 'invalid', message: '提出人不能为空' });
  });

  it('负责人 ID 不是 uuid 就给中文消息', async () => {
    expect(await caught(createRequirement(db, '吕品', {
      title: 'x', type: 'feature', requester: 'y', ownerMemberId: 'abc',
    }))).toMatchObject({ code: 'invalid', message: '负责人 ID 格式不正确' });

    expect(await caught(createRequirement(db, '吕品', {
      title: 'x', type: 'feature', requester: 'y', ownerMemberId: 123,
    }))).toMatchObject({ code: 'invalid', message: '负责人 ID 格式不正确' });
  });

  it.each([null, [], 'str'])('非对象入参 %j 给中文消息', async (body) => {
    expect(await caught(createRequirement(db, '吕品', body))).toMatchObject({
      code: 'invalid', message: '参数不合法',
    });
  });

  it('编号取 max(number)+1，不复用空洞', async () => {
    await db.execute(sql`
      insert into requirements (number, title, type, state, requester)
      values (7, '历史需求', 'feature', 'inbox', '孙建宏')`);

    const a = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    const b = await createRequirement(db, '吕品', { title: 'b', type: 'commercial', requester: 'c' });
    expect([a.number, b.number]).toEqual([8, 9]);

    const rows = await db.execute<{ number: number }>(sql`select number from requirements order by number`);
    expect(rows.rows.map((r) => Number(r.number))).toEqual([7, 8, 9]);
  });

  it('事件写失败时需求也回滚（同一事务）', async () => {
    // 用临时触发器让 events 插入抛错：若需求插入不在同一事务里，它就会留下来。
    // 先 drop：resetDb 只 truncate，被 kill 的旧进程会把触发器留在库里，
    // 之后所有写事件的用例都会撞上 'boom'。
    await db.execute(sql`drop trigger if exists flowers_test_boom on events`);
    await db.execute(sql`
      create or replace function flowers_test_boom() returns trigger as $$
      begin raise exception 'boom'; end $$ language plpgsql`);
    await db.execute(sql`
      create trigger flowers_test_boom before insert on events
      for each row execute function flowers_test_boom()`);
    try {
      let thrown: unknown;
      try {
        await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
      } catch (e) {
        thrown = e;
      }
      // 钉住抛出源：触发器 raise exception 的 P0001 / 'boom'。
      // 不是 AppError 才说明它是从 DB 层穿透出来的——若 createRequirement 提前
      // 校验失败、或 insert 挪到 recordEvent 之后，两个计数同样是 0，这条断言会挂。
      expect(thrown).toMatchObject({ code: 'P0001', message: 'boom' });
      expect(thrown).not.toBeInstanceOf(AppError);

      const reqs = await db.execute<{ n: number }>(sql`select count(*)::int as n from requirements`);
      const events = await db.execute<{ n: number }>(sql`select count(*)::int as n from events`);
      expect(Number(reqs.rows[0]!.n)).toBe(0);
      expect(Number(events.rows[0]!.n)).toBe(0);
    } finally {
      await db.execute(sql`drop trigger if exists flowers_test_boom on events`);
      await db.execute(sql`drop function if exists flowers_test_boom()`);
    }
  });
});

/** 直接读一行需求，避免经由服务自身的返回值判断落库结果。 */
async function rowOf(id: string) {
  const res = await db.execute<{
    state: string; state_entered_at: string; prd_url: string | null; skip_reason: string | null;
  }>(sql`select state, state_entered_at, prd_url, skip_reason from requirements where id = ${id}`);
  return res.rows[0]!;
}

/** 把 state_entered_at 推到过去，用来证明迁移确实刷新了它。 */
async function backdate(id: string) {
  await db.execute(sql`update requirements set state_entered_at = '2020-01-01T00:00:00Z' where id = ${id}`);
}

async function eventCountOf(id: string): Promise<number> {
  const res = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from events where requirement_id = ${id}`);
  return Number(res.rows[0]!.n);
}

describe('evaluate', () => {
  it('评估后从 inbox 进 design，并刷新 state_entered_at', async () => {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    await backdate(r.id);

    const out = await evaluate(db, '吕品', { requirementId: r.id });
    expect(out.state).toBe('design');

    const row = await rowOf(r.id);
    expect(row.state).toBe('design');
    expect(new Date(row.state_entered_at).getTime()).toBeGreaterThan(
      new Date('2020-01-01T00:00:00Z').getTime(),
    );
  });

  it('评估写一条事件，payload 带 from / to', async () => {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    await evaluate(db, '吕品', { requirementId: r.id });

    const rows = await db.execute<{ type: string; actor: string; payload: string }>(
      sql`select type, actor, payload from events where requirement_id = ${r.id} order by seq`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[1]).toMatchObject({ type: 'requirement.evaluated', actor: '吕品' });
    expect(JSON.parse(rows.rows[1]!.payload)).toMatchObject({ from: 'inbox', to: 'design' });
  });

  it('已经评估过的需求再评估，报 illegal_transition', async () => {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    await evaluate(db, '吕品', { requirementId: r.id });

    expect(await caught(evaluate(db, '吕品', { requirementId: r.id }))).toMatchObject({
      code: 'illegal_transition', message: '不能从「design」直接到「design」',
    });
    expect((await rowOf(r.id)).state).toBe('design');
  });

  it('需求不存在时给中文 not_found', async () => {
    expect(await caught(evaluate(db, '吕品', {
      requirementId: '00000000-0000-0000-0000-000000000000',
    }))).toMatchObject({ code: 'not_found', message: '找不到这条需求' });
  });
});

describe('submitReview', () => {
  const SKIP_REASON = '跳过评估，直接提交 PRD';

  it('PRD 链接为空就直接拒绝，不动状态也不写事件', async () => {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    await evaluate(db, '吕品', { requirementId: r.id });
    const before = await eventCountOf(r.id);

    expect(await caught(submitReview(db, '吕品', { requirementId: r.id, prdUrl: '' })))
      .toMatchObject({ code: 'missing_prd', message: '提交评审必须填正式 PRD 链接' });
    expect(await caught(submitReview(db, '吕品', { requirementId: r.id, prdUrl: '   ' })))
      .toMatchObject({ code: 'missing_prd', message: '提交评审必须填正式 PRD 链接' });

    expect((await rowOf(r.id)).state).toBe('design');
    expect(await eventCountOf(r.id)).toBe(before);
  });

  it('URL 校验在开事务之前，需求不存在也先报 missing_prd', async () => {
    expect(await caught(submitReview(db, '吕品', {
      requirementId: '00000000-0000-0000-0000-000000000000', prdUrl: ' ',
    }))).toMatchObject({ code: 'missing_prd', message: '提交评审必须填正式 PRD 链接' });
  });

  it('设计完成后提交：design → review，落 prd_url 且不写 skip_reason', async () => {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    await evaluate(db, '吕品', { requirementId: r.id });
    await backdate(r.id);

    const out = await submitReview(db, '吕品', { requirementId: r.id, prdUrl: '  https://x/prd  ' });
    expect(out).toMatchObject({ state: 'review', skippedEvaluation: false });

    const row = await rowOf(r.id);
    expect(row).toMatchObject({ state: 'review', prd_url: 'https://x/prd', skip_reason: null });
    expect(new Date(row.state_entered_at).getTime()).toBeGreaterThan(
      new Date('2020-01-01T00:00:00Z').getTime(),
    );

    const events = await db.execute<{ type: string; payload: string }>(
      sql`select type, payload from events where requirement_id = ${r.id} order by seq`);
    expect(events.rows[2]).toMatchObject({ type: 'requirement.review_requested' });
    expect(JSON.parse(events.rows[2]!.payload)).toMatchObject({
      from: 'design', to: 'review', prdUrl: 'https://x/prd', skippedEvaluation: false,
    });
  });

  it('跳过评估直提：inbox → review，写死 skip_reason 并回报 skippedEvaluation', async () => {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    await backdate(r.id);

    const out = await submitReview(db, '吕品', { requirementId: r.id, prdUrl: 'https://x/prd' });
    expect(out).toMatchObject({ state: 'review', skippedEvaluation: true });

    const row = await rowOf(r.id);
    expect(row).toMatchObject({ state: 'review', prd_url: 'https://x/prd', skip_reason: SKIP_REASON });
    expect(new Date(row.state_entered_at).getTime()).toBeGreaterThan(
      new Date('2020-01-01T00:00:00Z').getTime(),
    );

    const events = await db.execute<{ type: string; payload: string }>(
      sql`select type, payload from events where requirement_id = ${r.id} order by seq`);
    expect(JSON.parse(events.rows[1]!.payload)).toMatchObject({
      from: 'inbox', to: 'review', skippedEvaluation: true,
    });
  });

  it('已在待评审再提交，报 illegal_transition', async () => {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    await evaluate(db, '吕品', { requirementId: r.id });
    await submitReview(db, '吕品', { requirementId: r.id, prdUrl: 'https://x/prd' });

    expect(await caught(submitReview(db, '吕品', {
      requirementId: r.id, prdUrl: 'https://y/prd',
    }))).toMatchObject({ code: 'illegal_transition', message: '不能从「review」直接到「review」' });
    expect((await rowOf(r.id)).prd_url).toBe('https://x/prd');
  });

  it('并发双提交只有一次成功，另一次被行锁挡住', async () => {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    await evaluate(db, '吕品', { requirementId: r.id });

    const results = await Promise.allSettled([
      submitReview(db, '吕品', { requirementId: r.id, prdUrl: 'https://a/prd' }),
      submitReview(db, '吕品', { requirementId: r.id, prdUrl: 'https://b/prd' }),
    ]);
    const ok = results.filter((x) => x.status === 'fulfilled');
    const bad = results.filter((x) => x.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);

    const reason = (bad[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(AppError);
    expect(reason).toMatchObject({
      code: 'illegal_transition', message: '不能从「review」直接到「review」',
    });

    const winner = ok[0] as PromiseFulfilledResult<{ state: string; skippedEvaluation: boolean }>;
    expect(winner.value).toMatchObject({ state: 'review', skippedEvaluation: false });
    expect((await rowOf(r.id)).state).toBe('review');
  });

  it('需求不存在时（URL 合法）给中文 not_found', async () => {
    expect(await caught(submitReview(db, '吕品', {
      requirementId: '00000000-0000-0000-0000-000000000000', prdUrl: 'https://x/prd',
    }))).toMatchObject({ code: 'not_found', message: '找不到这条需求' });
  });
});
