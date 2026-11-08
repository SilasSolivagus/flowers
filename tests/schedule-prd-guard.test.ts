import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { AppError } from '../src/core/errors.js';
import { can, type Member } from '../src/core/auth/roles.js';
import { claimRequirement } from '../src/core/requirements/claim.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { updateRequirement } from '../src/core/requirements/manage.js';
import { schedule } from '../src/core/requirements/schedule.js';
import { resetDb, seedPeople, type SeededPerson } from './helpers/db.js';
import { makeQueued, makeRelease } from './helpers/factory.js';

/**
 * 规则 2 的**写入口**（2026-11-08 裁定）：没有 PRD 的需求不能排期。
 *
 * 0027 那条迁移只在跑的那一刻把位置摆正；要让规则长期成立，得拦在 `queue → ready`
 * 这一步上（`schedule` 是这条迁移的唯一执行者——状态机表里 `queue → ready` 只有
 * `schedule` 一个 trigger，时钟不碰它）。这一组钉住四件事：
 *
 * 1. 没有 PRD 就排期 → 中文报错，且**什么都没发生**（不写事件、不改状态、不落日期）；
 * 2. 一串空白也算没有 PRD（判据与 `submit_review`、0025 / 0026、0027 同源）；
 * 3. 有 PRD 的照旧能排期（门不许误伤）；
 * 4. 报错的**顺序**：状态不对 / 日期缺失先报它们，PRD 门最后——与状态机
 *    「先配对、再动作、后判门」一致。
 *
 * 文件后半段是规则 1 的**结构证据**：无主需求在服务层只有「认领」这一条路能被动到
 * （`claim` 不需要负责人那条线；`edit` / `review` / `reassignOwner` 都要）。测试同时
 * 把**例外**写下来：超管的 `edit` 对任何一行都成立，所以规则 1 不是「代码上不可能
 * 违反」，而是「除超管外不可能违反 + 0027 兜底」。
 */

let people: SeededPerson[] = [];

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

const 吕品 = () => people.find((p) => p.name === '吕品')!.id;

/** 捕获 AppError（拿 code + message）。非 AppError 原样抛，免得把 bug 当成「拒绝」。 */
async function caught(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('这次调用本该被拒绝，却成功了');
}

async function eventCountOf(requirementId: string): Promise<number> {
  const res = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from events where requirement_id = ${requirementId}`);
  return res.rows[0]!.n;
}

type Scheduled = {
  state: string;
  entered: string;
  release_id: string | null;
  commit_test_at: string | null;
  commit_due_at: string | null;
};

async function columnsOf(id: string): Promise<Scheduled> {
  const res = await db.execute<Scheduled>(sql`
    select state,
           state_entered_at::text as entered,
           release_id,
           commit_test_at::text as commit_test_at,
           commit_due_at::text as commit_due_at
      from requirements where id = ${id}`);
  return res.rows[0]!;
}

/** 造一条「在待排期、但没有 PRD」的需求：正是今天库里那 19 条的形状。 */
async function queuedWithoutPrd(opts: { prd?: string | null } = {}): Promise<string> {
  const r = await makeQueued();
  await db.execute(sql`
    update requirements set prd_url = ${opts.prd === undefined ? null : opts.prd}
     where id = ${r.id}`);
  return r.id;
}

describe('规则 2 的写入口：没有 PRD 不能排期', () => {
  const MISSING_PRD = '没有正式 PRD 链接的需求不能排期';

  it('没有 PRD：中文报错，且不写事件、不改状态、不落日期', async () => {
    const id = await queuedWithoutPrd();
    const rel = await makeRelease('2026.12', '2026-12-01', '2026-12-04');
    const before = await columnsOf(id);
    const events = await eventCountOf(id);

    expect(await caught(schedule(db, '吕品', {
      requirementId: id, releaseId: rel, commitTestAt: '2026-12-01', commitDueAt: '2026-12-04',
    }))).toMatchObject({ code: 'missing_prd', message: MISSING_PRD });

    // 门在写之前：状态、时刻、版本、两个日期一个字节都不动。
    expect(await columnsOf(id)).toEqual(before);
    expect(await eventCountOf(id)).toBe(events);
  });

  it('PRD 是一串空白也算没有 PRD', async () => {
    const id = await queuedWithoutPrd({ prd: '   ' });
    const rel = await makeRelease('2026.12', '2026-12-01', '2026-12-04');

    expect(await caught(schedule(db, '吕品', {
      requirementId: id, releaseId: rel, commitTestAt: '2026-12-01', commitDueAt: '2026-12-04',
    }))).toMatchObject({ code: 'missing_prd', message: MISSING_PRD });
    expect((await columnsOf(id)).state).toBe('queue');
  });

  it('有 PRD 的照旧能排期（门不许误伤）', async () => {
    const r = await makeQueued();
    const rel = await makeRelease('2026.12', '2026-12-01', '2026-12-04');

    const out = await schedule(db, '吕品', {
      requirementId: r.id, releaseId: rel, commitTestAt: '2026-12-01', commitDueAt: '2026-12-04',
    });

    expect(out.state).toBe('ready');
    expect((await columnsOf(r.id)).release_id).toBe(rel);
  });

  it('状态不对时先报状态，不报 PRD（门不许抢先说错动作）', async () => {
    // 一条「待设计」的需求本来就没有 PRD；对它点排期，真实问题是「这一步不属于这个状态」。
    // 若先报 missing_prd，用户会以为补个链接就能排期——而他补完仍然排不了。
    const created = await db.execute<{ id: string }>(sql`
      insert into requirements (title, type, requester, state, owner_member_id)
      values ('待设计的需求', 'feature', '王妍', 'design', ${吕品()})
      returning id`);
    const id = created.rows[0]!.id;
    const rel = await makeRelease('2026.12', '2026-12-01', '2026-12-04');

    expect(await caught(schedule(db, '吕品', {
      requirementId: id, releaseId: rel, commitTestAt: '2026-12-01', commitDueAt: '2026-12-04',
    }))).toMatchObject({
      code: 'illegal_transition', message: '不能从「待设计」直接到「待开发」',
    });
  });

  it('日期缺失时先报日期（入参校验在开事务之前）', async () => {
    const id = await queuedWithoutPrd();

    expect(await caught(schedule(db, '吕品', { requirementId: id })))
      .toMatchObject({ code: 'missing_dates', message: '排期必须填版本、提测日和承诺完成日' });
    expect((await columnsOf(id)).state).toBe('queue');
  });

  it('错误码与评审那道 prd 门是同一个（界面上「缺 PRD」只有一种形状）', async () => {
    const id = await queuedWithoutPrd();
    const rel = await makeRelease('2026.12', '2026-12-01', '2026-12-04');
    const mine = await caught(schedule(db, '吕品', {
      requirementId: id, releaseId: rel, commitTestAt: '2026-12-01', commitDueAt: '2026-12-04',
    }));

    // 措辞是排期自己的（不是评审那句「直接提交评审必须有正式 PRD 链接」），码是同一个。
    expect(mine.message).not.toContain('提交评审');
    expect(mine.code).toBe('missing_prd');
  });
});

/**
 * 规则 1 不需要代码，但它的前提要先被证明：**无主需求只能被「认领」动到**。
 *
 * 这一组钉住两件事：
 * 1. 服务层：一条无主需求，PM 的改描述 / 评估都被拒（`forbidden`），认领成功；
 * 2. 能力层（`can()` 的真值）：`claim` 是唯一**不需要负责人那条线**的能力，`edit` /
 *    `reassignOwner` / `review` 都要；`review` 还要状态是 `review`。
 *
 * 同时把**例外**写成断言：超管的 `edit` 对任何一行都成立（`roles.ts` 的第一档是
 * 「超管：改任何一条」）。所以规则 1 的保证是「除超管外只有认领」，不是「谁都动不了」；
 * 超管把一条无主需求推去别处之后，由 0027 的重复执行把它拉回收集。
 */
describe('规则 1 的结构保证：无主需求只有认领这一条路', () => {
  /** 一条真正的无主需求：`createRequirement` 只有在超管显式传 null 时才能造出来。 */
  async function ownerless(): Promise<string> {
    const res = await db.execute<{ id: string }>(sql`
      insert into requirements (title, type, requester, state, owner_member_id)
      values ('没有人接的需求', 'feature', '王妍', 'inbox', null)
      returning id`);
    return res.rows[0]!.id;
  }

  it('无主需求拒绝「改描述」，也拒绝「评估」', async () => {
    const id = await ownerless();

    expect(await caught(updateRequirement(db, '吕品', { requirementId: id, title: '我改' })))
      .toMatchObject({ code: 'forbidden', message: '你只能改自己负责的需求' });
    expect(await caught(evaluate(db, '吕品', { requirementId: id })))
      .toMatchObject({ code: 'forbidden', message: '你只能改自己负责的需求' });

    // 拒绝之后仍然无主、仍在收集：没有半截写入。
    const row = await db.execute<{ state: string; owner_member_id: string | null }>(
      sql`select state, owner_member_id from requirements where id = ${id}`);
    expect(row.rows[0]).toEqual({ state: 'inbox', owner_member_id: null });
  });

  it('同一条无主需求接受「认领」：认领人即负责人，状态不动', async () => {
    const id = await ownerless();

    expect(await claimRequirement(db, '吕品', { requirementId: id }))
      .toMatchObject({ id, owner: '吕品', changed: true });

    const row = await db.execute<{ state: string; owner_member_id: string | null }>(
      sql`select state, owner_member_id from requirements where id = ${id}`);
    // 认领不改状态（状态机是冻结的）：收集里的需求认领之后还在收集。
    expect(row.rows[0]).toEqual({ state: 'inbox', owner_member_id: 吕品() });
  });

  it('认领之后这条路就通了：同一个 PM 现在能评估它', async () => {
    const id = await ownerless();
    await claimRequirement(db, '吕品', { requirementId: id });

    expect((await evaluate(db, '吕品', { requirementId: id })).state).toBe('design');
  });

  it('能力层：无主行上 claim 是唯一不需要负责人那条线的能力（超管除外）', async () => {
    const facts = { ownerMemberId: null, ownerLine: null, state: 'review' } as const;
    const member = (name: string): Member => {
      const person = people.find((p) => p.name === name)!;
      return {
        id: person.id, name: person.name, role: person.role, line: person.line,
        deactivatedAt: null,
      };
    };

    for (const name of ['吕品', '王妍', '吕正豪', '赵越']) {
      const actor = member(name);
      expect(can(actor, facts, 'claim')).toBe(true);
      expect(can(actor, facts, 'edit')).toBe(false);
      expect(can(actor, facts, 'reassignOwner')).toBe(false);
      expect(can(actor, facts, 'review')).toBe(false);
    }

    // 例外：超管的 edit / reassignOwner 对任何一行都成立（roles.ts 的第一档）。
    const admin = member('房超');
    expect(can(admin, facts, 'edit')).toBe(true);
    expect(can(admin, facts, 'reassignOwner')).toBe(true);
    expect(can(admin, facts, 'claim')).toBe(true);
  });

  it('已过期的认领不会覆盖别人的归属（changed=false，不写事件）', async () => {
    const id = await ownerless();
    await claimRequirement(db, '吕品', { requirementId: id });
    const events = await eventCountOf(id);

    // 这时它已经有负责人了：`can('claim')` 对谁都是 false。
    expect(await caught(claimRequirement(db, '王妍', { requirementId: id })))
      .toMatchObject({ code: 'forbidden', message: '这条需求已经有负责人了' });
    expect(await eventCountOf(id)).toBe(events);
  });
});
