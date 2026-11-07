import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { reviewPass, reviewReject } from '../src/core/requirements/review.js';
import { schedule } from '../src/core/requirements/schedule.js';
import { bounce } from '../src/core/requirements/bounce.js';
import {
  rejectRequirement, restoreRequirement, shelveRequirement,
} from '../src/core/requirements/terminal.js';
import { AppError } from '../src/core/errors.js';
import { STATE_LABEL } from '../src/core/state-machine.js';
import { startOfShanghaiDay, tick } from '../src/core/clock/tick.js';
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

  it('类型缺省 / 空串都落成 null；不在枚举内的值仍然拒绝（Ruling 1）', async () => {
    // Ruling 1：类型不再必填。缺字段与空串（表单里那个「未指定」）都是**合法的空**。
    const noType = await createRequirement(db, '吕品', { title: 'x', requester: 'y' } as never);
    const blankType = await createRequirement(db, '吕品', {
      title: 'y', type: '   ', requester: 'y',
    });
    const rows = await db.execute<{ title: string; type: string | null }>(
      sql`select title, type from requirements order by number`);
    expect(rows.rows).toEqual([
      { title: 'x', type: null },
      { title: 'y', type: null },
    ]);
    expect(noType.id).toBeTruthy();
    expect(blankType.id).toBeTruthy();

    // 认不出的值仍然报错（单选不该被静默丢掉），而且整条建不出来。
    expect(await caught(createRequirement(db, '吕品', {
      title: 'z', type: 'other', requester: 'y',
    } as never))).toMatchObject({
      code: 'invalid', message: '类型只能是 commercial / feature（或留空 = 未指定）',
    });
    expect(await requirementCount()).toBe(2);
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

  /**
   * C1 之后编号来自 requirements_number_seq，不再扫 `max(number)+1`。
   * 语义差别就在这条用例里：序列**不回填空洞**（删掉的号不会被下一个需求捡走），
   * 而 max+1 会把空洞填上——这正是它并发不安全的来源（两个事务读同一个 max）。
   */
  it('编号由序列分配，删掉的号不复用', async () => {
    const a = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    const b = await createRequirement(db, '吕品', { title: 'b', type: 'commercial', requester: 'c' });
    expect([a.number, b.number]).toEqual([1, 2]);

    // 删掉中间那条：3 号已经是历史，不回填。
    await db.execute(sql`delete from requirements where id = ${b.id}`);
    const c = await createRequirement(db, '吕品', { title: 'c', type: 'feature', requester: 'd' });
    expect(c.number).toBe(3);

    const rows = await db.execute<{ number: number }>(sql`select number from requirements order by number`);
    expect(rows.rows.map((r) => Number(r.number))).toEqual([1, 3]);
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
      code: 'illegal_transition', message: '不能从「待设计」直接到「待设计」',
    });
    expect((await rowOf(r.id)).state).toBe('design');
  });

  it('类型是脏数据（含原型链上的名字）也不影响派单：锚点是人的条线', async () => {
    // 直接插库绕开 zod：库里可能留着历史脏 type。'toString' 会命中原型上的函数，
    // 裸查表（line → 角色）的实现会把它当成角色继续往下走。
    // P4-04：脏数据行也要有一个负责人——否则拦下它的是权限（forbidden）。
    // P4-06：类型不再是派单锚点，这一格改成证明「脏 type 不会把派单带歪」：
    // 派单只读负责人那一行的 line，'toString' 既不是 feature 也不是 commercial，
    // 于是它连查表的机会都没有。
    const ins = await db.execute<{ id: string }>(sql`
      insert into requirements (number, title, type, state, requester, owner_member_id)
      values (99, '历史脏数据', 'toString', 'design', '孙建宏',
              (select id from members where name = '吕品')) returning id`);
    const id = ins.rows[0]!.id;

    // 提交成功，派给负责人（吕品，功能线）所在条线的负责人。
    expect((await submitReview(db, '吕品', { requirementId: id, prdUrl: 'https://x' })).state)
      .toBe('review');
    expect(await reviewerOf(id)).toBe('吕正豪');
    expect((await rowOf(id)).state).toBe('review');
    expect(await assignmentsOf(id)).toMatchObject([{ name: '吕正豪', verdict: 'handed' }]);
  });

  it('需求不存在时给中文 not_found', async () => {
    expect(await caught(evaluate(db, '吕品', {
      requirementId: '00000000-0000-0000-0000-000000000000',
    }))).toMatchObject({ code: 'not_found', message: '找不到这条需求' });
  });

  it('软删的需求视为不存在：立项失败，不动状态也不写事件', async () => {
    // 软删 = 从每一条读路径上消失。状态动作是**写**路径上最要紧的那条读：不挡住它，
    // 一条已经不在板上的需求照样能被立项 / 排期 / 打回，每一步都写一条事件。
    // 判据在 `lockRequirement`（每个状态动作都从那里过），所以这里用哪一步都一样。
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    const before = await eventCountOf(r.id); // createRequirement 写的那一条
    await db.execute(sql`update requirements set deleted_at = now() where id = ${r.id}`);

    expect(await caught(evaluate(db, '吕品', { requirementId: r.id }))).toMatchObject({
      code: 'not_found', message: '找不到这条需求',
    });
    expect((await rowOf(r.id)).state).toBe('inbox');
    expect(await eventCountOf(r.id)).toBe(before);
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
    }))).toMatchObject({ code: 'illegal_transition', message: '不能从「待评审」直接到「待评审」' });
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
      code: 'illegal_transition', message: '不能从「待评审」直接到「待评审」',
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

  /**
   * P4-06：派单跟着**负责人的条线**走。同一张表里两行故意让类型与条线错开：
   *
   * | 需求类型 | 负责人 | 派给 |
   * |---|---|---|
   * | 商业 | 吕品（功能线） | 吕正豪 |
   * | 功能 | 王妍（商业线） | 赵越 |
   *
   * 旧规则下这两行的评审人正好相反——这条用例就是那次的翻转。
   */
  it('派单跟着负责人的条线，不跟需求类型', async () => {
    const commercialByFeature = await inReview('commercial');
    expect(await reviewerOf(commercialByFeature.id)).toBe('吕正豪');

    const featureByBusiness = await createRequirement(db, '王妍', {
      title: 'b', type: 'feature', requester: 'b',
    });
    await evaluate(db, '王妍', { requirementId: featureByBusiness.id });
    await submitReview(db, '王妍', { requirementId: featureByBusiness.id, prdUrl: 'https://y' });
    expect(await reviewerOf(featureByBusiness.id)).toBe('赵越');
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

  /**
   * R29：签字人必须是派单上的那个人。
   *
   * spec §2 说「评审人由类型决定，不是由人挑」——派单保证了「派给谁」，而签字这一步
   * 从前只把 actor 写进事件，谁都能签。这组用例钉住它现在闭合在签字时刻。
   */
  it('非派单评审人点通过 / 打回都是 not_reviewer，行与派单都不动', async () => {
    const r = await inReview();
    const before = await eventCountOf(r.id);

    // 吕品是 PM，不是这条需求的评审人。
    expect(await caught(reviewPass(db, '吕品', { requirementId: r.id }))).toMatchObject({
      code: 'not_reviewer', message: '签字人不是这条需求派单到的评审人',
    });
    expect(await caught(reviewReject(db, '吕品', {
      requirementId: r.id, reason: '不行',
    }))).toMatchObject({
      code: 'not_reviewer', message: '签字人不是这条需求派单到的评审人',
    });

    expect((await rowOf(r.id)).state).toBe('review');
    expect(await assignmentsOf(r.id)).toMatchObject([{ name: '吕正豪', verdict: 'handed' }]);
    expect(await eventCountOf(r.id)).toBe(before);
  });

  it('商业类的需求由功能线 PM 负责时，签它的是功能线负责人（商业线负责人签不了）', async () => {
    const c = await inReview('commercial', 'https://y');
    expect(await reviewerOf(c.id)).toBe('吕正豪');

    expect(await caught(reviewPass(db, '赵越', { requirementId: c.id }))).toMatchObject({
      code: 'not_reviewer', message: '签字人不是这条需求派单到的评审人',
    });
    // 派单上的那个人可以签。
    expect((await reviewPass(db, '吕正豪', { requirementId: c.id })).state).toBe('queue');
  });

  it('花名册里没有的名字也是 not_reviewer（不单开错误码，不给花名册探测器）', async () => {
    const r = await inReview();

    // 「查无此人」与「不是这个人」用同一句话：如果分开，拿任意名字试就能枚举出成员。
    expect(await caught(reviewPass(db, '张三', { requirementId: r.id }))).toMatchObject({
      code: 'not_reviewer', message: '签字人不是这条需求派单到的评审人',
    });
    expect((await rowOf(r.id)).state).toBe('review');
    // 空串同理：不是成员，不是派单评审人。
    expect(await caught(reviewPass(db, '', { requirementId: r.id }))).toMatchObject({
      code: 'not_reviewer',
    });
  });

  /**
   * I1 的同一类洞，落在 evaluate 上：`review → design` 是**合法**的一对（那是评审打回），
   * 所以只按配对判断时，对一条待评审的需求点「评估」会一路成功、把状态写回待设计——
   * 打回被一次误点顶掉，而没有人签字。
   *
   * 修复前的实测：before=review evaluate threw=none after=design。
   */
  it('对一条待评审的需求点评估：不能骑着 review → design 回到待设计', async () => {
    const r = await inReview();
    const before = await eventCountOf(r.id);

    expect(await caught(evaluate(db, '吕品', { requirementId: r.id }))).toMatchObject({
      code: 'illegal_transition', message: '这条需求当前在「待评审」，不能执行这一步',
    });
    expect((await rowOf(r.id)).state).toBe('review');
    expect(await eventCountOf(r.id)).toBe(before);
  });

  it('不在待评审状态时通过 / 打回都报 illegal_transition', async () => {
    const fresh = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    expect(await caught(reviewPass(db, '吕正豪', { requirementId: fresh.id }))).toMatchObject({
      code: 'illegal_transition', message: '不能从「收集」直接到「待排期」',
    });
    // 打回的措辞（I2）：inbox → design 是**合法**的一对（评估的路子），所以这里
    // 报的是「当前在收集状态，不能执行这一步」——说「不能从 inbox 到 design」会让
    // 用户以为状态机坏了。
    expect(await caught(reviewReject(db, '吕正豪', {
      requirementId: fresh.id, reason: '不行',
    }))).toMatchObject({
      code: 'illegal_transition', message: '这条需求当前在「收集」，不能执行这一步',
    });
    expect((await rowOf(fresh.id)).state).toBe('inbox');

    // 已经通过的需求再点通过：queue → queue 不是合法迁移。
    const passed = await inReview();
    await reviewPass(db, '吕正豪', { requirementId: passed.id });
    expect(await caught(reviewPass(db, '吕正豪', { requirementId: passed.id }))).toMatchObject({
      code: 'illegal_transition', message: '不能从「待排期」直接到「待排期」',
    });
    expect((await rowOf(passed.id)).state).toBe('queue');
  });

  it('同一需求二次提交评审不会开出第二条 handed 派单', async () => {
    const r = await inReview();
    expect(await caught(submitReview(db, '吕品', {
      requirementId: r.id, prdUrl: 'https://y',
    }))).toMatchObject({ code: 'illegal_transition', message: '不能从「待评审」直接到「待评审」' });

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

  it('负责人所在条线没有负责人时报 no_reviewer，整笔事务回滚', async () => {
    await db.execute(sql`update members set role = 'pm' where name = '吕正豪'`);
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    await evaluate(db, '吕品', { requirementId: r.id });
    const before = await eventCountOf(r.id);

    expect(await caught(submitReview(db, '吕品', {
      requirementId: r.id, prdUrl: 'https://x',
    }))).toMatchObject({ code: 'no_reviewer', message: '这个条线还没有配负责人' });

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
    }))).toMatchObject({ code: 'illegal_transition', message: '不能从「收集」直接到「待开发」' });
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
    }))).toMatchObject({ code: 'illegal_transition', message: '不能从「待开发」直接到「待开发」' });

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
      code: 'illegal_transition', message: '不能从「待开发」直接到「待开发」',
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

  /**
   * I5：releaseId 不是 uuid 时，PG 抛的是 22P02（invalid_text_representation），
   * 那不是 AppError —— 控制器按 `e.code` 分支时只能把它当未知错误，用户看到 500。
   * 与 requirementId 在 Task 5 得到的处理对齐：入口先校验成 uuid。
   */
  it('版本 ID 不是 uuid 就给中文消息，不让 22P02 漏成 500', async () => {
    const r = await makeQueued();
    const before = await eventCountOf(r.id);

    for (const releaseId of ['abc', 'not-a-uuid', '123']) {
      expect(await caught(schedule(db, '吕品', {
        requirementId: r.id, releaseId, commitTestAt: '2026-12-01', commitDueAt: '2026-12-04',
      }))).toMatchObject({ code: 'invalid', message: '版本 ID 格式不正确' });
    }

    // 校验在开事务之前：行不动、不写事件。
    expect(await scheduledColumnsOf(r.id)).toMatchObject({
      state: 'queue', release_id: null, commit_test_at: null, commit_due_at: null,
    });
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
    await tick(db, startOfShanghaiDay('2026-12-01'));
    await tick(db, startOfShanghaiDay('2026-12-03'));
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
   * 冻结的「现在」。
   *
   * R23 的底线（新完成日不能早于今天）让 bounce 依赖「今天」，而这些用例的日期是
   * 固定的 2026-12 叙事：不冻结时钟，它们在 2026-12-10 之后会逐条腐烂。R24 让
   * bounce 接受注入的 now，这里传一个早于 12-10 / 12-20 的时刻，叙事原样保留。
   * 生产调用方不传这个参数（见下面「不传 now」那条用例）。
   */
  const NOW = startOfShanghaiDay('2026-12-03');

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

    expect(await caught(bounce(db, '吕品', {
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

    expect(await caught(bounce(db, '吕品', {
      requirementId: id, reason, newCommitDueAt: '2026-12-10',
    } as never))).toMatchObject({ code: 'missing_reason', message: '打回必须写原因' });

    expect(await stateOfRow(id)).toBe('test');
    expect(await eventCountOf(id)).toBe(before);
  });

  it('原因和新完成日都空白时，先报 missing_new_due', async () => {
    // 声明的优先级：先看新承诺完成日，再看待填原因（与 brief 的检查顺序一致）。
    // 两个都缺时只报第一条错误，不聚合——控制器只展示一个 message。
    const id = await inTest();
    expect(await caught(bounce(db, '吕品', {
      requirementId: id, reason: '  ', newCommitDueAt: '',
    }))).toMatchObject({ code: 'missing_new_due', message: '打回必须重填承诺完成日' });
  });

  it('校验全部在开事务之前：需求不存在也先报缺失字段', async () => {
    // 「校验先于查行」与 evaluate / submitReview / reviewReject / schedule 一致，
    // 也让这条规则可以被单独钉住：不存在的 id + 空白原因 → missing_reason，而不是 not_found。
    expect(await caught(bounce(db, '吕品', {
      requirementId: '00000000-0000-0000-0000-000000000000',
      reason: ' ', newCommitDueAt: '2026-12-10',
    }))).toMatchObject({ code: 'missing_reason', message: '打回必须写原因' });
  });

  it('打回后回开发中，完成日换成新的，提测日原样不动', async () => {
    const id = await inTest();
    await backdate(id);
    const before = await eventCountOf(id);

    // 前后各留空白：落库与事件里都应该是 trim 后的值。
    const out = await bounce(db, '吕品', {
      requirementId: id, reason: '  自测没过  ', newCommitDueAt: '2026-12-10',
    }, NOW);
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
      actor: '吕品',
      payload: { from: 'test', to: 'dev', reason: '自测没过', newCommitDueAt: '2026-12-10' },
    });
  });

  it('新承诺完成日不是有效日期就报错，不把 Invalid Date 写进库', async () => {
    // 不校验日期的话 Invalid Date 会一路走到 toISOString()，抛的是 RangeError：
    // 控制器按 e.code 分支时只能当未知错误，前端看到的是 500 而不是中文提示。
    const id = await inTest();
    const before = await eventCountOf(id);

    for (const bad of ['不是日期', '2026-13-45']) {
      expect(await caught(bounce(db, '吕品', {
        requirementId: id, reason: '自测没过', newCommitDueAt: bad,
      }))).toMatchObject({ code: 'bad_new_due', message: '打回必须填有效的承诺完成日' });
    }

    const row = await datesOf(id);
    expect(row.state).toBe('test');
    expect(iso(row.commit_due_at)).toBe('2026-12-04T00:00:00.000Z');
    expect(await eventCountOf(id)).toBe(before);
  });

  it('新承诺完成日早于今天就直接拒绝，今天本身合法（R23）', async () => {
    // 日期打错一年会把「没做出来」变成「已上线」：这类需求的 commit_test_at 也已经过去，
    // 下一次 tick 会连推两步 dev → test → live，全程没有一个人工动作。
    //
    // 「今天」由注入的 now 决定（R24），所以这里的边界是 2027-03-11，而不是跑用例的那天：
    // 写死日期 + 冻结时刻，两条边界都不会随日历腐烂。两个 now 落在同一个北京日、不同钟点，
    // 顺带钉住「按天比、不按时刻比」——按时刻比的话，'2027-03-11' 零点的承诺在 23:59 的
    // 那次迭代里就会被判成过去。
    for (const now of [
      new Date('2027-03-10T16:30:00.000Z'),   // 北京 2027-03-11 00:30
      new Date('2027-03-11T15:59:00.000Z'),   // 北京 2027-03-11 23:59
    ]) {
      const id = await inTest();
      const before = await eventCountOf(id);

      // '2027-03-10' 是北京的昨天，按 UTC 却还是「今天」：按时刻比会放过它。
      expect(await caught(bounce(db, '吕品', {
        requirementId: id, reason: '自测没过', newCommitDueAt: '2027-03-10',
      }, now))).toMatchObject({ code: 'bad_new_due', message: '承诺完成日不能早于今天' });
      expect(await stateOfRow(id)).toBe('test');
      expect(await eventCountOf(id)).toBe(before);

      // 今天当天合法：承诺「今天就上线」是真实的（虽然乐观），它不能被自己的日期挡在门外。
      const out = await bounce(db, '吕品', {
        requirementId: id, reason: '自测没过', newCommitDueAt: '2027-03-11',
      }, now);
      expect(out.state).toBe('dev');
      expect(iso((await datesOf(id)).commit_due_at)).toBe('2027-03-11T00:00:00.000Z');
    }
  });

  it('不传 now 时按真实时钟判断，远期日期照常通过（默认参数）', async () => {
    // 生产调用方就是三个参数。用 2099 而不是 2026-12-10 之类的日期：这条用例一旦
    // 自己带一个到期日，就会跟着日历腐烂，而它要证明的只是「不传 now 也能跑」。
    const id = await inTest();
    const out = await bounce(db, '吕品', {
      requirementId: id, reason: '自测没过', newCommitDueAt: '2099-12-31',
    });
    expect(out.state).toBe('dev');
    expect(iso((await datesOf(id)).commit_due_at)).toBe('2099-12-31T00:00:00.000Z');
  });

  it.each(['dev', 'design', 'inbox'] as const)('从「%s」打回报 illegal_transition，行不动', async (from) => {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    await db.execute(sql`update requirements set state = ${from} where id = ${r.id}`);
    const before = await eventCountOf(r.id);

    expect(await caught(bounce(db, '吕品', {
      requirementId: r.id, reason: '自测没过', newCommitDueAt: '2026-12-10',
    }, NOW))).toMatchObject({
      code: 'illegal_transition', message: `不能从「${STATE_LABEL[from]}」直接到「开发中」`,
    });

    const row = await datesOf(r.id);
    expect(row.state).toBe(from);
    expect(row.commit_due_at).toBeNull();
    expect(await eventCountOf(r.id)).toBe(before);
  });

  it('从「待开发」打回也拒绝：ready → dev 是时钟的路子，不是打回', async () => {
    // 只按 from/to 配对，ready → dev 是合法的配对（trigger='clock'）。不钉 trigger
    // 的话，对一条还没开工的需求调 bounce 会一路成功、把状态写成 dev，等于让「打回」
    // 替时钟推了第一步，window_start 那段窗口被静默跳过。
    //
    // 措辞（I2）：配对合法、动作不对 → 说的是动作，不是配对。
    const { id } = await makeReadyAt('2026-12-01', '2026-12-01', '2026-12-04');
    const before = await eventCountOf(id);

    expect(await caught(bounce(db, '吕品', {
      requirementId: id, reason: '自测没过', newCommitDueAt: '2026-12-10',
    }, NOW))).toMatchObject({
      code: 'illegal_transition', message: '这条需求当前在「待开发」，不能执行这一步',
    });

    const row = await datesOf(id);
    expect(row.state).toBe('ready');
    expect(iso(row.commit_due_at)).toBe('2026-12-04T00:00:00.000Z');
    expect(await eventCountOf(id)).toBe(before);
  });

  it('需求不存在时给中文 not_found', async () => {
    expect(await caught(bounce(db, '吕品', {
      requirementId: '00000000-0000-0000-0000-000000000000',
      reason: '自测没过', newCommitDueAt: '2026-12-10',
    }, NOW))).toMatchObject({ code: 'not_found', message: '找不到这条需求' });
  });

  it.each([undefined, null, [], 'str', 42])('非对象入参 %j 给中文消息', async (body) => {
    expect(await caught(bounce(db, '吕品', body))).toMatchObject({
      code: 'invalid', message: '参数不合法',
    });
  });

  it.each(['abc', 123, '', null])('需求 ID 不是 uuid 就给中文消息：%j', async (id) => {
    expect(await caught(bounce(db, '吕品', {
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

    // 注入的 now（NOW = 12-03）与下面第一个 tick 的时刻一致：tick 的 now 与 bounce 的
    // now 对「今天」的口径必须相同，否则「12-20 是未来」这件事两边会各说一套。
    await bounce(db, '吕品', {
      requirementId: id, reason: '自测没过', newCommitDueAt: '2026-12-20',
    }, NOW);
    const bounced = await datesOf(id);
    expect(bounced.state).toBe('dev');
    expect(iso(bounced.commit_test_at)).toBe('2026-12-01T00:00:00.000Z');
    expect(iso(bounced.commit_due_at)).toBe('2026-12-20T00:00:00.000Z');

    // 一次 tick 就推回 test（提测日早于今天），不需要人工干预。
    const back = await tick(db, new Date('2026-12-03T00:10:00+08:00'));
    expect(back.moved).toContainEqual({ id, from: 'dev', to: 'test' });
    expect(await stateOfRow(id)).toBe('test');

    // 旧的完成日（12-04）已经过去也不会被推上线：门槛是新的 12-20。
    expect((await tick(db, startOfShanghaiDay('2026-12-05'))).moved).toHaveLength(0);
    expect((await tick(db, new Date('2026-12-19T23:59:59+08:00'))).moved).toHaveLength(0);
    expect(await stateOfRow(id)).toBe('test');

    // 新的承诺完成日当天才上线。
    const live = await tick(db, startOfShanghaiDay('2026-12-20'));
    expect(live.moved).toContainEqual({ id, from: 'test', to: 'live' });
    expect(await stateOfRow(id)).toBe('live');
  });
});

describe('拒绝 / 搁置 / 恢复', () => {
  /** 直接改状态，用来造「不该允许的那一步」的起点。 */
  async function forceState(id: string, state: string) {
    await db.execute(sql`update requirements set state = ${state} where id = ${id}`);
  }

  async function stateOf(id: string): Promise<string> {
    const r = await db.execute<{ state: string }>(sql`select state from requirements where id = ${id}`);
    return r.rows[0]!.state;
  }

  /** 这条需求最新的一条事件（拒绝 / 搁置 / 恢复都要写，且必须能读到）。 */
  async function lastEventOf(id: string) {
    const r = await db.execute<{ actor: string; type: string; payload: string }>(sql`
      select actor, type, payload from events
       where requirement_id = ${id} order by seq desc limit 1`);
    const row = r.rows[0];
    if (!row) return null;
    return { actor: row.actor, type: row.type, payload: JSON.parse(row.payload) as Record<string, unknown> };
  }

  /**
   * 拒绝 / 搁置 / 恢复只该碰 state（和 state_entered_at）。
   * 排期相关的四列单独读一份：吞掉版本和日期是这几步最容易犯的隐性破坏。
   */
  async function planColumnsOf(id: string) {
    const r = await db.execute<{
      state: string; number: number; prd_url: string | null; release_id: string | null;
      commit_test_at: string | null; commit_due_at: string | null;
    }>(sql`
      select state, number, prd_url, release_id, commit_test_at, commit_due_at
        from requirements where id = ${id}`);
    return r.rows[0]!;
  }

  /** 建 → 评估 → 提交 PRD：停在 review，带一条 handed 派单。 */
  async function inReview() {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    await evaluate(db, '吕品', { requirementId: r.id });
    await submitReview(db, '吕品', { requirementId: r.id, prdUrl: 'https://x' });
    return r;
  }

  /** 停在开发中的需求：12-01 开工，承诺 12-04 完成。 */
  async function inDev() {
    const { id } = await makeReadyAt('2026-12-01', '2026-12-01', '2026-12-04');
    await tick(db, startOfShanghaiDay('2026-12-01'));
    expect(await stateOf(id)).toBe('dev');
    return id;
  }

  it('只有 inbox 能拒绝', async () => {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    await evaluate(db, '吕品', { requirementId: r.id });

    expect(await caught(rejectRequirement(db, '吕品', { requirementId: r.id, reason: '不做' })))
      .toMatchObject({ code: 'illegal_transition', message: '只有收集状态的需求可以拒绝' });

    expect(await stateOf(r.id)).toBe('design');
    expect(await eventCountOf(r.id)).toBe(2);
  });

  it('从 inbox 拒绝：进 rejected，刷新进入时间，事件带 from / to / reason', async () => {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    await backdate(r.id);

    // reason 去首尾空白后再落库：库里和事件里都只留用户写的内容。
    const out = await rejectRequirement(db, '吕品', { requirementId: r.id, reason: '  不做  ' });
    expect(out.state).toBe('rejected');

    const row = await rowOf(r.id);
    expect(row.state).toBe('rejected');
    expect(new Date(row.state_entered_at).getTime()).toBeGreaterThan(
      new Date('2020-01-01T00:00:00Z').getTime(),
    );
    expect(await lastEventOf(r.id)).toMatchObject({
      actor: '吕品',
      type: 'requirement.rejected',
      payload: { from: 'inbox', to: 'rejected', reason: '不做' },
    });
  });

  it.each(['design', 'review', 'queue', 'ready', 'dev', 'test', 'live', 'shelved', 'rejected'])(
    '从「%s」拒绝都是 illegal_transition，行不动、不写事件', async (from) => {
      const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
      await forceState(r.id, from);
      const before = await eventCountOf(r.id);

      // 状态机里只有 inbox → rejected 这一对通向 rejected，报错也统一成这一句：
      // 用户看到的是「只有收集状态的需求可以拒绝」，而不是干巴巴的迁移编号。
      expect(await caught(rejectRequirement(db, '吕品', { requirementId: r.id, reason: '不做' })))
        .toMatchObject({ code: 'illegal_transition', message: '只有收集状态的需求可以拒绝' });

      expect(await stateOf(r.id)).toBe(from);
      expect(await eventCountOf(r.id)).toBe(before);
    },
  );

  it.each(['', '   ', undefined, null, 42])('拒绝必须写原因：%j', async (reason) => {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    const before = await eventCountOf(r.id);

    expect(await caught(rejectRequirement(db, '吕品', {
      requirementId: r.id, reason,
    } as never))).toMatchObject({ code: 'missing_reason', message: '拒绝必须写原因' });

    expect(await stateOf(r.id)).toBe('inbox');
    expect(await eventCountOf(r.id)).toBe(before);
  });

  it('拒绝的原因先于查行校验：需求不存在也先报 missing_reason', async () => {
    expect(await caught(rejectRequirement(db, '吕品', {
      requirementId: '00000000-0000-0000-0000-000000000000', reason: ' ',
    }))).toMatchObject({ code: 'missing_reason', message: '拒绝必须写原因' });
  });

  it('从 inbox 搁置：进 shelved，刷新进入时间，事件带 from / to / reason', async () => {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    await backdate(r.id);

    const out = await shelveRequirement(db, '吕品', { requirementId: r.id, reason: '本期不做' });
    expect(out.state).toBe('shelved');

    const row = await rowOf(r.id);
    expect(row.state).toBe('shelved');
    expect(new Date(row.state_entered_at).getTime()).toBeGreaterThan(
      new Date('2020-01-01T00:00:00Z').getTime(),
    );
    expect(await lastEventOf(r.id)).toMatchObject({
      actor: '吕品',
      type: 'requirement.shelved',
      payload: { from: 'inbox', to: 'shelved', reason: '本期不做' },
    });
  });

  /**
   * 搁置的口径是「任何非终态」，不是「只有 inbox」：需求做到一半被业务叫停是常态，
   * 而状态机只登记了 inbox → shelved 一条（表是单步迁移表，表达不了 8 条）。
   */
  it.each(['design', 'review', 'queue', 'ready', 'dev', 'test', 'live'])(
    '从「%s」搁置都合法', async (from) => {
      const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
      await forceState(r.id, from);

      const out = await shelveRequirement(db, '吕品', { requirementId: r.id, reason: '本期不做' });
      expect(out.state).toBe('shelved');

      expect(await stateOf(r.id)).toBe('shelved');
      expect(await lastEventOf(r.id)).toMatchObject({
        type: 'requirement.shelved',
        payload: { from, to: 'shelved', reason: '本期不做' },
      });
    },
  );

  it('开发中搁置再恢复回到 inbox，不回 dev（计划的刻意选择）', async () => {
    const id = await inDev();
    const before = await planColumnsOf(id);

    await shelveRequirement(db, '吕品', { requirementId: id, reason: '本期不做' });
    expect(await stateOf(id)).toBe('shelved');

    const out = await restoreRequirement(db, '吕品', { requirementId: id });
    expect(out.state).toBe('inbox');

    const after = await planColumnsOf(id);
    expect(after.state).toBe('inbox');
    // 恢复是「重新走一遍流程」，不是「回到原来那一步」：编号、PRD、版本、两个日期都不动。
    expect(after.number).toBe(before.number);
    expect(after.prd_url).toBe('https://x');
    expect(after.release_id).toBe(before.release_id);
    expect(iso(after.commit_test_at)).toBe('2026-12-01T00:00:00.000Z');
    expect(iso(after.commit_due_at)).toBe('2026-12-04T00:00:00.000Z');

    // 保留日期不等于「还在排期里」：状态是 inbox，时钟不再看它，所以不会被推着走。
    expect((await tick(db, new Date('2026-12-04T00:10:00+08:00'))).moved).toHaveLength(0);
    expect(await stateOf(id)).toBe('inbox');
  });

  it('搁置后恢复回 inbox', async () => {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    await shelveRequirement(db, '吕品', { requirementId: r.id, reason: '本期不做' });

    const out = await restoreRequirement(db, '吕品', { requirementId: r.id });
    expect(out.state).toBe('inbox');
    expect(await stateOf(r.id)).toBe('inbox');
    expect(await lastEventOf(r.id)).toMatchObject({
      type: 'requirement.restored',
      payload: { from: 'shelved', to: 'inbox' },
    });
  });

  it('恢复清掉上一轮的「跳过评估」标记，历史仍留在事件流里', async () => {
    // skip_reason 描述的是**这一轮**提交流程：恢复等于重新走一遍，旧标记必须清掉，
    // 否则报表会把一条正常评估过的需求算成「跳过评估」。当初跳过的事实不会丢——
    // requirement.review_requested 的 payload 里有 skippedEvaluation。
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    await submitReview(db, '吕品', { requirementId: r.id, prdUrl: 'https://x' });
    expect((await rowOf(r.id)).skip_reason).not.toBeNull();

    await shelveRequirement(db, '吕品', { requirementId: r.id, reason: '本期不做' });
    await restoreRequirement(db, '吕品', { requirementId: r.id });

    const row = await rowOf(r.id);
    expect(row.state).toBe('inbox');
    expect(row.skip_reason).toBeNull();
    // PRD 链接是身份信息，不跟着流程标记一起清。
    expect(row.prd_url).toBe('https://x');
  });

  it.each(['', '   ', undefined, null])('搁置必须写原因：%j', async (reason) => {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    const before = await eventCountOf(r.id);

    expect(await caught(shelveRequirement(db, '吕品', {
      requirementId: r.id, reason,
    } as never))).toMatchObject({ code: 'missing_reason', message: '搁置必须写原因' });

    expect(await stateOf(r.id)).toBe('inbox');
    expect(await eventCountOf(r.id)).toBe(before);
  });

  it.each(['shelved', 'rejected'])('从终态「%s」不能再搁置', async (from) => {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    await forceState(r.id, from);
    const before = await eventCountOf(r.id);

    expect(await caught(shelveRequirement(db, '吕品', {
      requirementId: r.id, reason: '本期不做',
    }))).toMatchObject({ code: 'illegal_transition', message: '终态不能再搁置' });

    expect(await stateOf(r.id)).toBe(from);
    expect(await eventCountOf(r.id)).toBe(before);
  });

  it.each(['inbox', 'design', 'queue', 'dev', 'live', 'rejected'] as const)(
    '从「%s」恢复都是 illegal_transition，行不动', async (from) => {
      const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
      await forceState(r.id, from);
      const before = await eventCountOf(r.id);

      // 状态机里只有 shelved → inbox 这一对通向 inbox，所以报错沿用状态机的措辞：
      // 「不能从「开发中」直接到「收集」」——恢复不是回退到某一步，是从搁置里出来。
      expect(await caught(restoreRequirement(db, '吕品', { requirementId: r.id })))
        .toMatchObject({ code: 'illegal_transition', message: `不能从「${STATE_LABEL[from]}」直接到「收集」` });

      expect(await stateOf(r.id)).toBe(from);
      expect(await eventCountOf(r.id)).toBe(before);
    },
  );

  it('被拒绝的需求不再接受任何终态 / 恢复动作', async () => {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    await rejectRequirement(db, '吕品', { requirementId: r.id, reason: '不做' });
    const before = await eventCountOf(r.id);

    expect(await caught(rejectRequirement(db, '吕品', { requirementId: r.id, reason: '再拒一次' })))
      .toMatchObject({ code: 'illegal_transition', message: '只有收集状态的需求可以拒绝' });
    expect(await caught(shelveRequirement(db, '吕品', { requirementId: r.id, reason: '本期不做' })))
      .toMatchObject({ code: 'illegal_transition', message: '终态不能再搁置' });
    expect(await caught(restoreRequirement(db, '吕品', { requirementId: r.id })))
      .toMatchObject({ code: 'illegal_transition', message: '不能从「已拒绝」直接到「收集」' });

    expect(await stateOf(r.id)).toBe('rejected');
    expect(await eventCountOf(r.id)).toBe(before);
  });

  it('评审中搁置会把 handed 派单作废，恢复后重新提交会重新派单', async () => {
    // 搁置不清理派单的话，「handed」会挂在一条已经不在评审里的需求上，
    // 而 assignReviewer 的 `where not exists (handed)` 会让重新提交时**不再**派单：
    // 一条搁置过的需求恢复后永远拿不到新派单。
    const r = await inReview();
    expect(await assignmentsOf(r.id)).toMatchObject([{ name: '吕正豪', verdict: 'handed' }]);

    await shelveRequirement(db, '吕品', { requirementId: r.id, reason: '本期不做' });
    const voided = await assignmentsOf(r.id);
    expect(voided).toHaveLength(1);
    expect(voided[0]).toMatchObject({ name: '吕正豪', verdict: 'voided', reason: '本期不做' });
    expect(voided[0]!.decided_at).not.toBeNull();

    await restoreRequirement(db, '吕品', { requirementId: r.id });
    await submitReview(db, '吕品', { requirementId: r.id, prdUrl: 'https://x' });

    const rows = await assignmentsOf(r.id);
    expect(rows.filter((x) => x.verdict === 'handed')).toHaveLength(1);
    expect(rows.filter((x) => x.verdict === 'voided')).toHaveLength(1);
    expect(await reviewerOf(r.id)).toBe('吕正豪');
  });

  it('需求不存在时三条服务都给中文 not_found', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    expect(await caught(rejectRequirement(db, '吕品', { requirementId: missing, reason: '不做' })))
      .toMatchObject({ code: 'not_found', message: '找不到这条需求' });
    expect(await caught(shelveRequirement(db, '吕品', { requirementId: missing, reason: '本期不做' })))
      .toMatchObject({ code: 'not_found', message: '找不到这条需求' });
    expect(await caught(restoreRequirement(db, '吕品', { requirementId: missing })))
      .toMatchObject({ code: 'not_found', message: '找不到这条需求' });
  });

  it.each([undefined, null, [], 'str', 42])('非对象入参 %j 给中文消息', async (body) => {
    expect(await caught(rejectRequirement(db, '吕品', body))).toMatchObject({
      code: 'invalid', message: '参数不合法',
    });
    expect(await caught(shelveRequirement(db, '吕品', body))).toMatchObject({
      code: 'invalid', message: '参数不合法',
    });
    expect(await caught(restoreRequirement(db, '吕品', body))).toMatchObject({
      code: 'invalid', message: '参数不合法',
    });
  });

  it.each(['abc', 123, '', null])('需求 ID 不是 uuid 就给中文消息：%j', async (id) => {
    expect(await caught(rejectRequirement(db, '吕品', {
      requirementId: id, reason: '不做',
    } as never))).toMatchObject({ code: 'invalid', message: '需求 ID 格式不正确' });
    expect(await caught(shelveRequirement(db, '吕品', {
      requirementId: id, reason: '本期不做',
    } as never))).toMatchObject({ code: 'invalid', message: '需求 ID 格式不正确' });
    expect(await caught(restoreRequirement(db, '吕品', { requirementId: id } as never)))
      .toMatchObject({ code: 'invalid', message: '需求 ID 格式不正确' });
  });
});
