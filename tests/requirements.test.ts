import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { reviewPass, reviewReject } from '../src/core/requirements/review.js';
import { AppError } from '../src/core/errors.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { reviewerOf } from './helpers/factory.js';

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
    }))).toMatchObject({ code: 'no_reviewer' });

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
