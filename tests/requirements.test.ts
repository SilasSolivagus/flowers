import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { reviewPass, reviewReject } from '../src/core/requirements/review.js';
import { schedule } from '../src/core/requirements/schedule.js';
import { bounce } from '../src/core/requirements/bounce.js';
import { AppError } from '../src/core/errors.js';
import { tick } from '../src/core/clock/tick.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { makeQueued, makeReadyAt, makeRelease, reviewerOf } from './helpers/factory.js';

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

  it('类型不在枚举内（含原型链上的名字）报 invalid_type，且不写派单', async () => {
    // 直接插库绕开 zod：库里可能留着历史脏 type。'toString' 会命中原型上的函数，
    // 裸查表的实现会把它当成角色继续往下走。
    const ins = await db.execute<{ id: string }>(sql`
      insert into requirements (number, title, type, state, requester)
      values (99, '历史脏数据', 'toString', 'design', '孙建宏') returning id`);
    const id = ins.rows[0]!.id;

    expect(await caught(submitReview(db, '吕品', { requirementId: id, prdUrl: 'https://x' })))
      .toMatchObject({ code: 'invalid_type', message: '需求类型不认识' });
    expect((await rowOf(id)).state).toBe('design');
    expect(await assignmentsOf(id)).toHaveLength(0);
  });

  it('需求不存在时给中文 not_found', async () => {
    expect(await caught(evaluate(db, '吕品', {
      requirementId: '00000000-0000-0000-0000-000000000000',
    }))).toMatchObject({ code: 'not_found', message: '找不到这条需求' });
  });

  it.each([undefined, null, [], 'str', 42])('非对象入参 %j 给中文消息', async (body) => {
    expect(await caught(evaluate(db, '吕品', body))).toMatchObject({
      code: 'invalid', message: '参数不合法',
    });
  });

  it.each(['abc', 123, '', null])('需求 ID 不是 uuid 就给中文消息：%j', async (id) => {
    expect(await caught(evaluate(db, '吕品', { requirementId: id } as never))).toMatchObject({
      code: 'invalid', message: '需求 ID 格式不正确',
    });
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
    // 字段整个缺失（运行时 undefined）也必须落到同一个 AppError，而不是 TypeError。
    expect(await caught(submitReview(db, '吕品', { requirementId: r.id } as never)))
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

  it.each([undefined, null, [], 'str', 42])('非对象入参 %j 给中文消息', async (body) => {
    expect(await caught(submitReview(db, '吕品', body))).toMatchObject({
      code: 'invalid', message: '参数不合法',
    });
  });

  it.each(['abc', 123, '', null])('需求 ID 不是 uuid 就给中文消息：%j', async (id) => {
    expect(await caught(submitReview(db, '吕品', {
      requirementId: id, prdUrl: 'https://x/prd',
    } as never))).toMatchObject({ code: 'invalid', message: '需求 ID 格式不正确' });
  });
});

/** 派单行连同评审人姓名一起读出来，避免拿着服务返回值自证。 */
async function assignmentsOf(id: string) {
  const res = await db.execute<{
    name: string; verdict: string | null; reason: string | null; decided_at: Date | null;
  }>(sql`
    select m.name, ra.verdict, ra.reason, ra.decided_at
      from review_assignments ra
      join members m on m.id = ra.reviewer_member_id
     where ra.requirement_id = ${id}`);
  return res.rows;
}

describe('评审派单、通过与打回', () => {
  /** 建 → 评估 → 提交 PRD，返回停在 review 的需求。 */
  async function inReview(type: 'feature' | 'commercial' = 'feature', prdUrl = 'https://x') {
    const r = await createRequirement(db, '吕品', { title: 'a', type, requester: 'b' });
    await evaluate(db, '吕品', { requirementId: r.id });
    await submitReview(db, '吕品', { requirementId: r.id, prdUrl });
    return r;
  }

  it('功能类派给功能线评审人，商业类派给商业线', async () => {
    const f = await inReview('feature');
    expect(await reviewerOf(f.id)).toBe('吕正豪');

    const c = await inReview('commercial', 'https://y');
    expect(await reviewerOf(c.id)).toBe('赵越');
  });

  it('派单在提交评审的同一事务里落库：一条 handed，尚未写决定时间', async () => {
    const r = await inReview();
    expect(await assignmentsOf(r.id)).toMatchObject([
      { name: '吕正豪', verdict: 'handed', reason: null, decided_at: null },
    ]);
  });

  it('通过后进待排期', async () => {
    const r = await inReview();
    const out = await reviewPass(db, '吕正豪', { requirementId: r.id });
    expect(out.state).toBe('queue');

    expect((await rowOf(r.id)).state).toBe('queue');
    // 派单收口：handed → passed，并记下决定时间。
    const rows = await assignmentsOf(r.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: '吕正豪', verdict: 'passed', reason: null });
    expect(rows[0]!.decided_at).not.toBeNull();
  });

  it('通过写一条 review_passed 事件，payload 带 from / to', async () => {
    const r = await inReview();
    await reviewPass(db, '吕正豪', { requirementId: r.id });

    const rows = await db.execute<{ type: string; actor: string; payload: string }>(
      sql`select type, actor, payload from events where requirement_id = ${r.id} order by seq`);
    const last = rows.rows[rows.rows.length - 1]!;
    expect(last).toMatchObject({ type: 'requirement.review_passed', actor: '吕正豪' });
    expect(JSON.parse(last.payload)).toMatchObject({ from: 'review', to: 'queue' });
  });

  it('打回回到待设计，且必须写原因', async () => {
    const r = await inReview();

    // 空原因在开事务之前就被挡住：状态和派单都不许动。
    expect(await caught(reviewReject(db, '吕正豪', { requirementId: r.id, reason: '' })))
      .toMatchObject({ code: 'missing_reason', message: '打回必须写原因' });
    expect(await caught(reviewReject(db, '吕正豪', { requirementId: r.id, reason: '   ' })))
      .toMatchObject({ code: 'missing_reason', message: '打回必须写原因' });
    // 字段整个缺失（运行时 undefined）也必须落到同一个 AppError，而不是 TypeError。
    expect(await caught(reviewReject(db, '吕正豪', { requirementId: r.id } as never)))
      .toMatchObject({ code: 'missing_reason', message: '打回必须写原因' });
    expect((await rowOf(r.id)).state).toBe('review');
    expect((await assignmentsOf(r.id))[0]).toMatchObject({ verdict: 'handed' });

    const out = await reviewReject(db, '吕正豪', { requirementId: r.id, reason: '页面状态没写清' });
    expect(out.state).toBe('design');

    expect((await rowOf(r.id)).state).toBe('design');
    const rows = await assignmentsOf(r.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verdict: 'rejected', reason: '页面状态没写清' });
    expect(rows[0]!.decided_at).not.toBeNull();
  });

  it('打回写事件，payload 带 from / to 和原因', async () => {
    const r = await inReview();
    await reviewReject(db, '吕正豪', { requirementId: r.id, reason: '  页面状态没写清  ' });

    const rows = await db.execute<{ type: string; payload: string }>(
      sql`select type, payload from events where requirement_id = ${r.id} order by seq`);
    const last = rows.rows[rows.rows.length - 1]!;
    expect(last.type).toBe('requirement.review_rejected');
    expect(JSON.parse(last.payload)).toMatchObject({
      from: 'review', to: 'design', reason: '页面状态没写清',
    });
  });

  it('不在待评审状态时通过 / 打回都报 illegal_transition', async () => {
    const fresh = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    expect(await caught(reviewPass(db, '吕正豪', { requirementId: fresh.id }))).toMatchObject({
      code: 'illegal_transition', message: '不能从「inbox」直接到「queue」',
    });
    expect(await caught(reviewReject(db, '吕正豪', {
      requirementId: fresh.id, reason: '不行',
    }))).toMatchObject({
      code: 'illegal_transition', message: '不能从「inbox」直接到「design」',
    });
    expect((await rowOf(fresh.id)).state).toBe('inbox');

    // 已经通过的需求再点通过：queue → queue 不是合法迁移。
    const passed = await inReview();
    await reviewPass(db, '吕正豪', { requirementId: passed.id });
    expect(await caught(reviewPass(db, '吕正豪', { requirementId: passed.id }))).toMatchObject({
      code: 'illegal_transition', message: '不能从「queue」直接到「queue」',
    });
    expect((await rowOf(passed.id)).state).toBe('queue');
  });

  it('同一需求二次提交评审不会开出第二条 handed 派单', async () => {
    const r = await inReview();
    expect(await caught(submitReview(db, '吕品', {
      requirementId: r.id, prdUrl: 'https://y',
    }))).toMatchObject({ code: 'illegal_transition', message: '不能从「review」直接到「review」' });

    expect(await assignmentsOf(r.id)).toHaveLength(1);
  });

  it('打回后再提交评审会重新派单，旧派单保持 rejected', async () => {
    const r = await inReview();
    await reviewReject(db, '吕正豪', { requirementId: r.id, reason: '页面状态没写清' });
    await submitReview(db, '吕品', { requirementId: r.id, prdUrl: 'https://x/v2' });

    const rows = await assignmentsOf(r.id);
    expect(rows.map((x) => x.verdict).sort()).toEqual(['handed', 'rejected']);
    expect(await reviewerOf(r.id)).toBe('吕正豪');
  });

  it('类型在但没有对应角色的成员时报 no_reviewer，整笔事务回滚', async () => {
    await db.execute(sql`update members set role = 'pm' where name = '吕正豪'`);
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    await evaluate(db, '吕品', { requirementId: r.id });
    const before = await eventCountOf(r.id);

    expect(await caught(submitReview(db, '吕品', {
      requirementId: r.id, prdUrl: 'https://x',
    }))).toMatchObject({ code: 'no_reviewer', message: '这个类型还没有配评审人' });

    // 派单失败必须连状态推进和事件一起回滚：不能停在 review 却没人接。
    expect((await rowOf(r.id)).state).toBe('design');
    expect(await eventCountOf(r.id)).toBe(before);
    expect(await assignmentsOf(r.id)).toHaveLength(0);
  });

  it('需求不存在时给中文 not_found', async () => {
    const ghost = '00000000-0000-0000-0000-000000000000';
    expect(await caught(reviewPass(db, '吕正豪', { requirementId: ghost }))).toMatchObject({
      code: 'not_found', message: '找不到这条需求',
    });
    expect(await caught(reviewReject(db, '吕正豪', {
      requirementId: ghost, reason: '不行',
    }))).toMatchObject({ code: 'not_found', message: '找不到这条需求' });
  });

  it.each([undefined, null, [], 'str', 42])('非对象入参 %j 给中文消息', async (body) => {
    expect(await caught(reviewPass(db, '吕正豪', body))).toMatchObject({
      code: 'invalid', message: '参数不合法',
    });
    expect(await caught(reviewReject(db, '吕正豪', body))).toMatchObject({
      code: 'invalid', message: '参数不合法',
    });
  });

  it.each(['abc', 123, '', null])('需求 ID 不是 uuid 就给中文消息：%j', async (id) => {
    expect(await caught(reviewPass(db, '吕正豪', { requirementId: id } as never))).toMatchObject({
      code: 'invalid', message: '需求 ID 格式不正确',
    });
    expect(await caught(reviewReject(db, '吕正豪', {
      requirementId: id, reason: '不行',
    } as never))).toMatchObject({ code: 'invalid', message: '需求 ID 格式不正确' });
  });
});

/** 读排期相关的列。timestamptz 经 pg 文本协议回来是字符串，比较前先过 Date。 */
async function scheduledColumnsOf(id: string) {
  const res = await db.execute<{
    state: string; release_id: string | null; commit_test_at: string | null; commit_due_at: string | null;
  }>(sql`select state, release_id, commit_test_at, commit_due_at from requirements where id = ${id}`);
  return res.rows[0]!;
}

/** timestamptz 字符串（'2026-12-04 00:00:00+00'）→ 可比较的 ISO 串。 */
const iso = (value: string | null) => (value === null ? null : new Date(value).toISOString());

describe('排期（三个日期）', () => {
  const MISSING_DATES = '排期必须填版本、提测日和承诺完成日';

  it('三个日期齐全才能排期', async () => {
    const r = await makeQueued();
    const rel = await makeRelease('2026.12', '2026-12-01', '2026-12-04');
    const before = await eventCountOf(r.id);

    // 三个都缺
    expect(await caught(schedule(db, '吕品', {
      requirementId: r.id, releaseId: null, commitTestAt: null, commitDueAt: null,
    }))).toMatchObject({ code: 'missing_dates', message: MISSING_DATES });
    // 只缺承诺完成日
    expect(await caught(schedule(db, '吕品', {
      requirementId: r.id, releaseId: rel, commitTestAt: '2026-12-01',
    }))).toMatchObject({ code: 'missing_dates', message: MISSING_DATES });
    // 只缺提测日（空白也算缺）
    expect(await caught(schedule(db, '吕品', {
      requirementId: r.id, releaseId: rel, commitTestAt: '   ', commitDueAt: '2026-12-04',
    }))).toMatchObject({ code: 'missing_dates', message: MISSING_DATES });
    // 只缺版本
    expect(await caught(schedule(db, '吕品', {
      requirementId: r.id, releaseId: '', commitTestAt: '2026-12-01', commitDueAt: '2026-12-04',
    }))).toMatchObject({ code: 'missing_dates', message: MISSING_DATES });

    expect(await scheduledColumnsOf(r.id)).toMatchObject({
      state: 'queue', release_id: null, commit_test_at: null, commit_due_at: null,
    });
    expect(await eventCountOf(r.id)).toBe(before);
  });

  it('完成日早于提测日 或 晚于发版日 都拒绝', async () => {
    const rel = await makeRelease('2026.12', '2026-12-01', '2026-12-04');
    const r = await makeQueued();
    const before = await eventCountOf(r.id);

    expect(await caught(schedule(db, '吕品', {
      requirementId: r.id, releaseId: rel, commitTestAt: '2026-12-03', commitDueAt: '2026-12-02',
    }))).toMatchObject({ code: 'bad_dates', message: '承诺完成日不能早于提测日' });
    expect(await caught(schedule(db, '吕品', {
      requirementId: r.id, releaseId: rel, commitTestAt: '2026-12-01', commitDueAt: '2026-12-10',
    }))).toMatchObject({ code: 'bad_dates', message: '承诺完成日不能晚于版本发版日' });

    // 两条拒绝路径都不许留下半截写入，也不许写事件。
    expect(await scheduledColumnsOf(r.id)).toMatchObject({
      state: 'queue', release_id: null, commit_test_at: null, commit_due_at: null,
    });
    expect(await eventCountOf(r.id)).toBe(before);
  });

  it('排期后进待开发', async () => {
    const rel = await makeRelease('2026.12', '2026-12-01', '2026-12-04');
    const r = await makeQueued();
    const out = await schedule(db, '吕品', {
      requirementId: r.id, releaseId: rel, commitTestAt: '2026-12-01', commitDueAt: '2026-12-04',
    });
    expect(out.state).toBe('ready');
  });

  it('排期落库：state / 版本 / 两个日期都在，并刷新 state_entered_at', async () => {
    const rel = await makeRelease('2026.12', '2026-12-01', '2026-12-04');
    const r = await makeQueued();
    await backdate(r.id);

    await schedule(db, '吕品', {
      requirementId: r.id, releaseId: rel, commitTestAt: '2026-12-01', commitDueAt: '2026-12-04',
    });

    const row = await scheduledColumnsOf(r.id);
    expect(row.state).toBe('ready');
    expect(row.release_id).toBe(rel);
    expect(iso(row.commit_test_at)).toBe('2026-12-01T00:00:00.000Z');
    expect(iso(row.commit_due_at)).toBe('2026-12-04T00:00:00.000Z');
    expect(new Date((await rowOf(r.id)).state_entered_at).getTime()).toBeGreaterThan(
      new Date('2020-01-01T00:00:00Z').getTime(),
    );
  });

  it('排期写一条事件，payload 带版本和两个日期', async () => {
    const rel = await makeRelease('2026.12', '2026-12-01', '2026-12-04');
    const r = await makeQueued();
    await schedule(db, '吕品', {
      requirementId: r.id, releaseId: rel, commitTestAt: '2026-12-01', commitDueAt: '2026-12-04',
    });

    const rows = await db.execute<{ type: string; actor: string; payload: string }>(
      sql`select type, actor, payload from events where requirement_id = ${r.id} order by seq`);
    const last = rows.rows[rows.rows.length - 1]!;
    expect(last).toMatchObject({ type: 'requirement.scheduled', actor: '吕品' });
    expect(JSON.parse(last.payload)).toMatchObject({
      from: 'queue', to: 'ready',
      releaseId: rel, commitTestAt: '2026-12-01', commitDueAt: '2026-12-04',
    });
  });

  it('边界：完成日等于提测日、也等于发版日都放行', async () => {
    const rel = await makeRelease('2026.12', '2026-12-01', '2026-12-04');

    // 提测日 = 承诺完成日 = 发版日：两条不等式都取等号。
    const same = await makeQueued();
    expect((await schedule(db, '吕品', {
      requirementId: same.id, releaseId: rel, commitTestAt: '2026-12-04', commitDueAt: '2026-12-04',
    })).state).toBe('ready');
    expect(iso((await scheduledColumnsOf(same.id)).commit_due_at)).toBe('2026-12-04T00:00:00.000Z');

    // 提测日在前、承诺完成日正好压在发版日上：也放行。
    const edge = await makeQueued();
    expect((await schedule(db, '吕品', {
      requirementId: edge.id, releaseId: rel, commitTestAt: '2026-12-01', commitDueAt: '2026-12-04',
    })).state).toBe('ready');
  });

  it('边界：承诺完成日晚发版日一天就拒绝（发版日是字符串，不能直接比）', async () => {
    // release_date 经 pg 文本协议回来是 '2026-12-04 00:00:00+00' 这样的字符串。
    // 若直接拿 Date 和它比大小，比较会退化成 NaN 比较、永远为 false，
    // 「晚于发版日」这条约束会静默失效——这条用例就是钉住它必须真的拦住。
    const rel = await makeRelease('2026.12', '2026-12-01', '2026-12-04');
    const r = await makeQueued();
    const before = await eventCountOf(r.id);

    expect(await caught(schedule(db, '吕品', {
      requirementId: r.id, releaseId: rel, commitTestAt: '2026-12-03', commitDueAt: '2026-12-05',
    }))).toMatchObject({ code: 'bad_dates', message: '承诺完成日不能晚于版本发版日' });

    expect(await scheduledColumnsOf(r.id)).toMatchObject({
      state: 'queue', release_id: null, commit_test_at: null, commit_due_at: null,
    });
    expect(await eventCountOf(r.id)).toBe(before);
  });

  it('不在待排期状态时排期报 illegal_transition，且不覆盖已有排期', async () => {
    const rel = await makeRelease('2026.12', '2026-12-01', '2026-12-04');

    // inbox 直接排期
    const fresh = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    expect(await caught(schedule(db, '吕品', {
      requirementId: fresh.id, releaseId: rel, commitTestAt: '2026-12-01', commitDueAt: '2026-12-04',
    }))).toMatchObject({ code: 'illegal_transition', message: '不能从「inbox」直接到「ready」' });
    expect((await scheduledColumnsOf(fresh.id)).state).toBe('inbox');

    // 已经排过期的再排一次
    const done = await makeQueued();
    await schedule(db, '吕品', {
      requirementId: done.id, releaseId: rel, commitTestAt: '2026-12-01', commitDueAt: '2026-12-03',
    });
    const before = await eventCountOf(done.id);
    const other = await makeRelease('2027.01', '2027-01-01', '2027-01-08');
    expect(await caught(schedule(db, '吕品', {
      requirementId: done.id, releaseId: other, commitTestAt: '2027-01-05', commitDueAt: '2027-01-06',
    }))).toMatchObject({ code: 'illegal_transition', message: '不能从「ready」直接到「ready」' });

    const kept = await scheduledColumnsOf(done.id);
    expect(kept.release_id).toBe(rel);
    expect(iso(kept.commit_test_at)).toBe('2026-12-01T00:00:00.000Z');
    expect(iso(kept.commit_due_at)).toBe('2026-12-03T00:00:00.000Z');
    expect(await eventCountOf(done.id)).toBe(before);
  });

  it('并发双排期只有一次成功，另一次被行锁挡住', async () => {
    const rel = await makeRelease('2026.12', '2026-12-01', '2026-12-04');
    const r = await makeQueued();
    const before = await eventCountOf(r.id);

    const results = await Promise.allSettled([
      schedule(db, '吕品', {
        requirementId: r.id, releaseId: rel, commitTestAt: '2026-12-01', commitDueAt: '2026-12-02',
      }),
      schedule(db, '吕品', {
        requirementId: r.id, releaseId: rel, commitTestAt: '2026-12-02', commitDueAt: '2026-12-03',
      }),
    ]);
    const ok = results.filter((x) => x.status === 'fulfilled');
    const bad = results.filter((x) => x.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);

    const reason = (bad[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(AppError);
    expect(reason).toMatchObject({
      code: 'illegal_transition', message: '不能从「ready」直接到「ready」',
    });

    // 只有一次写成功：一条事件，日期是两次提交里合法的那一个。
    expect(await eventCountOf(r.id)).toBe(before + 1);
    const row = await scheduledColumnsOf(r.id);
    expect(row.state).toBe('ready');
    expect([iso(row.commit_due_at)]).toEqual([
      expect.stringMatching(/^2026-12-0(2|3)T00:00:00\.000Z$/),
    ]);
  });

  it('版本不存在时给中文 not_found，需求留在待排期', async () => {
    const r = await makeQueued();
    const before = await eventCountOf(r.id);
    expect(await caught(schedule(db, '吕品', {
      requirementId: r.id,
      releaseId: '00000000-0000-0000-0000-000000000000',
      commitTestAt: '2026-12-01', commitDueAt: '2026-12-04',
    }))).toMatchObject({ code: 'not_found', message: '找不到这个版本' });

    expect((await scheduledColumnsOf(r.id)).state).toBe('queue');
    expect(await eventCountOf(r.id)).toBe(before);
  });

  it('需求不存在时给中文 not_found', async () => {
    const rel = await makeRelease('2026.12', '2026-12-01', '2026-12-04');
    expect(await caught(schedule(db, '吕品', {
      requirementId: '00000000-0000-0000-0000-000000000000',
      releaseId: rel, commitTestAt: '2026-12-01', commitDueAt: '2026-12-04',
    }))).toMatchObject({ code: 'not_found', message: '找不到这条需求' });
  });

  it('日期不是有效日期就报 bad_dates，不把 Invalid Date 写进库', async () => {
    const rel = await makeRelease('2026.12', '2026-12-01', '2026-12-04');
    const r = await makeQueued();
    expect(await caught(schedule(db, '吕品', {
      requirementId: r.id, releaseId: rel, commitTestAt: '不是日期', commitDueAt: '2026-12-04',
    }))).toMatchObject({ code: 'bad_dates', message: '提测日和承诺完成日必须是有效日期' });
    expect(await caught(schedule(db, '吕品', {
      requirementId: r.id, releaseId: rel, commitTestAt: '2026-12-01', commitDueAt: '2026-13-45',
    }))).toMatchObject({ code: 'bad_dates', message: '提测日和承诺完成日必须是有效日期' });
    expect((await scheduledColumnsOf(r.id)).state).toBe('queue');
  });

  it.each([undefined, null, [], 'str', 42])('非对象入参 %j 给中文消息', async (body) => {
    expect(await caught(schedule(db, '吕品', body))).toMatchObject({
      code: 'invalid', message: '参数不合法',
    });
  });

  it.each(['abc', 123, '', null])('需求 ID 不是 uuid 就给中文消息：%j', async (id) => {
    expect(await caught(schedule(db, '吕品', {
      requirementId: id, releaseId: '00000000-0000-0000-0000-000000000000',
      commitTestAt: '2026-12-01', commitDueAt: '2026-12-04',
    } as never))).toMatchObject({ code: 'invalid', message: '需求 ID 格式不正确' });
  });
});

describe('打回（测试中 → 开发中，必须重填完成日）', () => {
  /**
   * 造一条停在 test 的需求：12-01 开工 → 12-03 时提测日（12-01）已过。
   *
   * 刻意让提测日早于「今天」：这正是 R17 的场景——打回只有一种写法，没有特例分支，
   * 所以用例必须覆盖「提测日已经过去」这个真实情况，而不是拿一个还没到点的提测日
   * 绕开它。
   */
  async function inTest() {
    const { id } = await makeReadyAt('2026-12-01', '2026-12-01', '2026-12-04');
    await tick(db, new Date('2026-12-01T00:00:00+08:00'));
    await tick(db, new Date('2026-12-03T00:00:00+08:00'));
    expect(await stateOfRow(id)).toBe('test');
    return id;
  }

  async function stateOfRow(id: string): Promise<string> {
    const r = await db.execute<{ state: string }>(sql`select state from requirements where id = ${id}`);
    return r.rows[0]!.state;
  }

  /** 打回只碰这几列，单独读一份，不从服务返回值推断落库结果。 */
  async function datesOf(id: string) {
    const r = await db.execute<{
      state: string; commit_test_at: string | null; commit_due_at: string | null;
    }>(sql`select state, commit_test_at, commit_due_at from requirements where id = ${id}`);
    return r.rows[0]!;
  }

  /**
   * 北京时间的「今天」偏移 offsetDays 天，形如 '2026-11-06'。
   *
   * 服务端是按 Asia/Shanghai 的**日历日**判「今天」的，用例必须用同一口径生成边界值：
   * 直接写死 '2026-11-05' / '2026-11-06' 会在第二天变成「两天前 / 昨天」，用例自己就烂掉；
   * 而拿时刻（Date.now() - 86400000）当边界会让「今天」随运行的小时数漂移。
   */
  function todayInShanghai(offsetDays: number): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const part = (type: string) => parts.find((p) => p.type === type)!.value;
    const day = new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + offsetDays);
    return day.toISOString().slice(0, 10);
  }

  /** 最后一条 requirement.bounced 事件；没有就返回 null。 */
  async function bouncedEventOf(id: string) {
    const r = await db.execute<{ actor: string; payload: string }>(sql`
      select actor, payload from events
       where requirement_id = ${id} and type = 'requirement.bounced'
       order by seq desc limit 1`);
    const row = r.rows[0];
    if (!row) return null;
    return { actor: row.actor, payload: JSON.parse(row.payload) as Record<string, unknown> };
  }

  it.each(['', '   ', undefined])('新承诺完成日缺失或空白就拒绝：%j', async (newCommitDueAt) => {
    const id = await inTest();
    const before = await eventCountOf(id);

    expect(await caught(bounce(db, '王妍', {
      requirementId: id, reason: '自测没过', newCommitDueAt,
    } as never))).toMatchObject({
      code: 'missing_new_due', message: '打回必须重填承诺完成日',
    });

    expect(await stateOfRow(id)).toBe('test');
    expect(await eventCountOf(id)).toBe(before);
  });

  it.each(['', '   ', undefined])('原因缺失或空白就拒绝：%j', async (reason) => {
    const id = await inTest();
    const before = await eventCountOf(id);

    expect(await caught(bounce(db, '王妍', {
      requirementId: id, reason, newCommitDueAt: '2026-12-10',
    } as never))).toMatchObject({ code: 'missing_reason', message: '打回必须写原因' });

    expect(await stateOfRow(id)).toBe('test');
    expect(await eventCountOf(id)).toBe(before);
  });

  it('原因和新完成日都空白时，先报 missing_new_due', async () => {
    // 声明的优先级：先看新承诺完成日，再看待填原因（与 brief 的检查顺序一致）。
    // 两个都缺时只报第一条错误，不聚合——控制器只展示一个 message。
    const id = await inTest();
    expect(await caught(bounce(db, '王妍', {
      requirementId: id, reason: '  ', newCommitDueAt: '',
    }))).toMatchObject({ code: 'missing_new_due', message: '打回必须重填承诺完成日' });
  });

  it('校验全部在开事务之前：需求不存在也先报缺失字段', async () => {
    // 「校验先于查行」与 evaluate / submitReview / reviewReject / schedule 一致，
    // 也让这条规则可以被单独钉住：不存在的 id + 空白原因 → missing_reason，而不是 not_found。
    expect(await caught(bounce(db, '王妍', {
      requirementId: '00000000-0000-0000-0000-000000000000',
      reason: ' ', newCommitDueAt: '2026-12-10',
    }))).toMatchObject({ code: 'missing_reason', message: '打回必须写原因' });
  });

  it('打回后回开发中，完成日换成新的，提测日原样不动', async () => {
    const id = await inTest();
    await backdate(id);
    const before = await eventCountOf(id);

    // 前后各留空白：落库与事件里都应该是 trim 后的值。
    const out = await bounce(db, '王妍', {
      requirementId: id, reason: '  自测没过  ', newCommitDueAt: '2026-12-10',
    });
    expect(out.state).toBe('dev');

    const row = await datesOf(id);
    expect(row.state).toBe('dev');
    expect(iso(row.commit_due_at)).toBe('2026-12-10T00:00:00.000Z');
    // 提测日不动是刻意的：它决定「什么时候算进测试」，不是「什么时候上线」。
    expect(iso(row.commit_test_at)).toBe('2026-12-01T00:00:00.000Z');
    // 打回是状态迁移，必须刷新 state_entered_at，否则前端时间轴停在进测试那天。
    expect(new Date((await rowOf(id)).state_entered_at).getTime()).toBeGreaterThan(
      new Date('2020-01-01T00:00:00Z').getTime(),
    );

    expect(await eventCountOf(id)).toBe(before + 1);
    expect(await bouncedEventOf(id)).toMatchObject({
      actor: '王妍',
      payload: { from: 'test', to: 'dev', reason: '自测没过', newCommitDueAt: '2026-12-10' },
    });
  });

  it('新承诺完成日不是有效日期就报错，不把 Invalid Date 写进库', async () => {
    // 不校验日期的话 Invalid Date 会一路走到 toISOString()，抛的是 RangeError：
    // 控制器按 e.code 分支时只能当未知错误，前端看到的是 500 而不是中文提示。
    const id = await inTest();
    const before = await eventCountOf(id);

    for (const bad of ['不是日期', '2026-13-45']) {
      expect(await caught(bounce(db, '王妍', {
        requirementId: id, reason: '自测没过', newCommitDueAt: bad,
      }))).toMatchObject({ code: 'bad_new_due', message: '打回必须填有效的承诺完成日' });
    }

    const row = await datesOf(id);
    expect(row.state).toBe('test');
    expect(iso(row.commit_due_at)).toBe('2026-12-04T00:00:00.000Z');
    expect(await eventCountOf(id)).toBe(before);
  });

  it('新承诺完成日早于今天就直接拒绝，今天本身合法（R23）', async () => {
    // 日期打错一年（'2020-12-10' 写成 '2026-12-10' 的反面）会把「没做出来」变成「已上线」：
    // 这类需求的 commit_test_at 也已经过去，下一次 tick 会连推两步 dev → test → live，
    // 全程没有一个人工动作。所以新完成日不能落在今天之前。
    const id = await inTest();
    const before = await eventCountOf(id);

    expect(await caught(bounce(db, '王妍', {
      requirementId: id, reason: '自测没过', newCommitDueAt: todayInShanghai(-1),
    }))).toMatchObject({ code: 'bad_new_due', message: '承诺完成日不能早于今天' });
    expect(await stateOfRow(id)).toBe('test');
    expect(await eventCountOf(id)).toBe(before);

    // 今天当天合法：承诺「今天就上线」是真实的（虽然乐观），它不能被自己的日期挡在门外。
    const out = await bounce(db, '王妍', {
      requirementId: id, reason: '自测没过', newCommitDueAt: todayInShanghai(0),
    });
    expect(out.state).toBe('dev');
    expect(iso((await datesOf(id)).commit_due_at)).toBe(`${todayInShanghai(0)}T00:00:00.000Z`);
  });

  it.each(['dev', 'design', 'inbox'])('从「%s」打回报 illegal_transition，行不动', async (from) => {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    await db.execute(sql`update requirements set state = ${from} where id = ${r.id}`);
    const before = await eventCountOf(r.id);

    expect(await caught(bounce(db, '王妍', {
      requirementId: r.id, reason: '自测没过', newCommitDueAt: '2026-12-10',
    }))).toMatchObject({
      code: 'illegal_transition', message: `不能从「${from}」直接到「dev」`,
    });

    const row = await datesOf(r.id);
    expect(row.state).toBe(from);
    expect(row.commit_due_at).toBeNull();
    expect(await eventCountOf(r.id)).toBe(before);
  });

  it('从「待开发」打回也拒绝：ready → dev 是时钟的路子，不是打回', async () => {
    // assertTransition 只按 from/to 配对，而 ready → dev 是合法的配对（trigger='clock'）。
    // 不钉 trigger 的话，对一条还没开工的需求调 bounce 会一路成功、把状态写成 dev，
    // 等于让「打回」替时钟推了第一步，window_start 那段窗口被静默跳过。
    const { id } = await makeReadyAt('2026-12-01', '2026-12-01', '2026-12-04');
    const before = await eventCountOf(id);

    expect(await caught(bounce(db, '王妍', {
      requirementId: id, reason: '自测没过', newCommitDueAt: '2026-12-10',
    }))).toMatchObject({
      code: 'illegal_transition', message: '不能从「ready」直接到「dev」',
    });

    const row = await datesOf(id);
    expect(row.state).toBe('ready');
    expect(iso(row.commit_due_at)).toBe('2026-12-04T00:00:00.000Z');
    expect(await eventCountOf(id)).toBe(before);
  });

  it('需求不存在时给中文 not_found', async () => {
    expect(await caught(bounce(db, '王妍', {
      requirementId: '00000000-0000-0000-0000-000000000000',
      reason: '自测没过', newCommitDueAt: '2026-12-10',
    }))).toMatchObject({ code: 'not_found', message: '找不到这条需求' });
  });

  it.each([undefined, null, [], 'str', 42])('非对象入参 %j 给中文消息', async (body) => {
    expect(await caught(bounce(db, '王妍', body))).toMatchObject({
      code: 'invalid', message: '参数不合法',
    });
  });

  it.each(['abc', 123, '', null])('需求 ID 不是 uuid 就给中文消息：%j', async (id) => {
    expect(await caught(bounce(db, '王妍', {
      requirementId: id, reason: '自测没过', newCommitDueAt: '2026-12-10',
    } as never))).toMatchObject({ code: 'invalid', message: '需求 ID 格式不正确' });
  });

  /**
   * R17：打回后 tick 立刻把需求推回测试中——**有意保留**，不特判。
   *
   * bounce 不动 commit_test_at，所以对 12-03 的 tick 来说 12-01 的提测日「已到点」。
   * 语义上它确实还在测试窗内，真正的上线门槛是新的承诺完成日；guard 一旦加进 tick
   * （或 bounce 里改提测日），这条用例先挂。
   */
  it('打回后一次 tick 就回到测试中，上线仍等新的承诺完成日（R17）', async () => {
    const id = await inTest();

    await bounce(db, '王妍', {
      requirementId: id, reason: '自测没过', newCommitDueAt: '2026-12-20',
    });
    const bounced = await datesOf(id);
    expect(bounced.state).toBe('dev');
    expect(iso(bounced.commit_test_at)).toBe('2026-12-01T00:00:00.000Z');
    expect(iso(bounced.commit_due_at)).toBe('2026-12-20T00:00:00.000Z');

    // 一次 tick 就推回 test（提测日早于今天），不需要人工干预。
    const back = await tick(db, new Date('2026-12-03T00:10:00+08:00'));
    expect(back.moved).toContainEqual({ id, from: 'dev', to: 'test' });
    expect(await stateOfRow(id)).toBe('test');

    // 旧的完成日（12-04）已经过去也不会被推上线：门槛是新的 12-20。
    expect((await tick(db, new Date('2026-12-05T00:00:00+08:00'))).moved).toHaveLength(0);
    expect((await tick(db, new Date('2026-12-19T23:59:59+08:00'))).moved).toHaveLength(0);
    expect(await stateOfRow(id)).toBe('test');

    // 新的承诺完成日当天才上线。
    const live = await tick(db, new Date('2026-12-20T00:00:00+08:00'));
    expect(live.moved).toContainEqual({ id, from: 'test', to: 'live' });
    expect(await stateOfRow(id)).toBe('live');
  });
});
