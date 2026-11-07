import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { AppError } from '../src/core/errors.js';
import { realignOpenReviewAssignments } from '../src/db/line-anchor.js';
import { can } from '../src/core/auth/roles.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { reviewPass } from '../src/core/requirements/review.js';
import { resetDb, seedPeople, type SeededPerson } from './helpers/db.js';

/**
 * P4-06 的数据迁移：把旧规则（按**需求类型**派单）留下的开着的派单，重算到
 * 「负责人所在条线」的负责人身上。
 *
 * 为什么这支要单独测：迁移是最容易「看起来跑过了」的东西——它没有编译期检查，
 * 跑一次就结束，错的那一版会把十条需求安静地签给错的人。所以这里逐条断言：
 *
 * 1. 旧规则派出来的错人 → 改成负责人那条线的负责人，并且**真的能签**（不只是行变了）；
 * 2. 负责人没有条线 → 作废，**留下来的那个错人签不了**（比「没人签」更重要的那一半）；
 * 3. 没有负责人 → 作废，等认领；
 * 4. 幂等：第二遍什么都不改。
 */

let people: SeededPerson[] = [];

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

const FEATURE_LEAD = '吕正豪';
const COMMERCIAL_LEAD = '赵越';
const ADMIN = '房超';

function idOf(name: string): string {
  const found = people.find((person) => person.name === name);
  if (found === undefined) throw new Error(`名册里没有 ${name}`);
  return found.id;
}

async function caught(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('这次调用本该被拒绝，却成功了');
}

type AssignmentRow = {
  reviewer: string; verdict: string | null; reason: string | null;
};

/** 这条需求当前的开着的派单（连同评审人姓名）。 */
async function openAssignment(id: string): Promise<AssignmentRow | null> {
  const res = await db.execute<AssignmentRow>(sql`
    select m.name as reviewer, ra.verdict, ra.reason
      from review_assignments ra
      join members m on m.id = ra.reviewer_member_id
     where ra.requirement_id = ${id} and ra.verdict = 'handed'`);
  return res.rows[0] ?? null;
}

/** 旧规则会怎么派：类型 → 那条线的负责人。**故意与实现反着写**，用它造旧数据。 */
const OLD_RULE: Record<string, string> = {
  feature: FEATURE_LEAD,
  commercial: COMMERCIAL_LEAD,
};

/**
 * 造一条「旧规则派单」的需求：用真实服务走到 review（那时派单已按新规则落库），
 * 再把派单行改回旧规则会给出的那个人。这样测的是**迁移**，不是派单服务。
 */
async function requirementWithOldAssignment(
  owner: string, type: 'feature' | 'commercial',
): Promise<{ id: string; number: number; oldReviewer: string }> {
  const created = await createRequirement(db, owner, {
    title: `${owner} 的${type === 'feature' ? '功能' : '商业'}需求`,
    type,
    requester: '孙建宏',
  });
  await evaluate(db, owner, { requirementId: created.id });
  await submitReview(db, owner, { requirementId: created.id, prdUrl: 'https://x/prd' });

  const oldReviewer = OLD_RULE[type]!;
  await db.execute(sql`
    update review_assignments
       set reviewer_member_id = ${idOf(oldReviewer)}
     where requirement_id = ${created.id} and verdict = 'handed'`);
  return { id: created.id, number: created.number, oldReviewer };
}

describe('迁移：开着的派单按负责人的条线重算', () => {
  it('旧规则派给商业线的一条商业类需求，负责人是功能线 PM → 改派功能线负责人', async () => {
    const { id, number, oldReviewer } = await requirementWithOldAssignment('吕品', 'commercial');
    expect(oldReviewer).toBe(COMMERCIAL_LEAD);

    const report = await realignOpenReviewAssignments();
    expect(report.moved).toContainEqual({
      number, title: '吕品 的商业需求', from: COMMERCIAL_LEAD, to: FEATURE_LEAD,
    });
    expect(await openAssignment(id)).toMatchObject({ reviewer: FEATURE_LEAD, verdict: 'handed' });

    // 迁移不是为了「行好看」：换过去的人必须真的能签，被换掉的人必须真的签不了。
    expect(await caught(reviewPass(db, COMMERCIAL_LEAD, { requirementId: id })))
      .toMatchObject({ code: 'not_reviewer' });
    expect((await reviewPass(db, FEATURE_LEAD, { requirementId: id })).state).toBe('queue');
  });

  it('镜像：功能类但负责人是商业线 PM → 改派商业线负责人', async () => {
    const { id, number } = await requirementWithOldAssignment('王妍', 'feature');
    const report = await realignOpenReviewAssignments();

    expect(report.moved).toContainEqual({
      number, title: '王妍 的功能需求', from: FEATURE_LEAD, to: COMMERCIAL_LEAD,
    });
    expect(await openAssignment(id)).toMatchObject({ reviewer: COMMERCIAL_LEAD });
  });

  it('负责人没有条线（超管）：派单作废，留给超管，错的那个人签不了', async () => {
    // 房超是超管、没有条线：新规则下提交评审**不落派单行**，所以这里要先补一行旧数据。
    const created = await createRequirement(db, ADMIN, {
      title: '超管自己的需求', type: 'commercial', requester: '孙建宏',
    });
    await evaluate(db, ADMIN, { requirementId: created.id });
    await submitReview(db, ADMIN, { requirementId: created.id, prdUrl: 'https://x/prd' });
    expect(await openAssignment(created.id)).toBeNull();

    await db.execute(sql`
      insert into review_assignments (requirement_id, reviewer_member_id, verdict)
      values (${created.id}, ${idOf(COMMERCIAL_LEAD)}, 'handed')`);

    const report = await realignOpenReviewAssignments();
    expect(report.voided).toContainEqual({
      number: created.number,
      title: '超管自己的需求',
      owner: ADMIN,
      reviewer: COMMERCIAL_LEAD,
      why: '负责人没有条线：改由超管评审',
    });

    // 作废之后没有开着的派单，错的人签不了；超管能签（他不受派单限制）。
    expect(await openAssignment(created.id)).toBeNull();
    expect(await caught(reviewPass(db, COMMERCIAL_LEAD, { requirementId: created.id })))
      .toMatchObject({ code: 'not_reviewer' });
    expect((await reviewPass(db, ADMIN, { requirementId: created.id })).state).toBe('queue');
  });

  it('没有负责人：派单作废，原因写「先认领」', async () => {
    const created = await createRequirement(db, ADMIN, {
      title: '待接单', type: 'commercial', requester: '孙建宏', ownerMemberId: null,
    });
    await db.execute(sql`
      insert into review_assignments (requirement_id, reviewer_member_id, verdict)
      values (${created.id}, ${idOf(COMMERCIAL_LEAD)}, 'handed')`);

    const report = await realignOpenReviewAssignments();
    expect(report.voided).toContainEqual({
      number: created.number,
      title: '待接单',
      owner: null,
      reviewer: COMMERCIAL_LEAD,
      why: '需求还没有负责人：认领后再派单',
    });
    expect(report.unowned).toBe(1);
  });

  it('本来就对的派单一行不动（幂等：第二遍什么都不改）', async () => {
    // 吕品（功能线）→ 提交之后派单已经是吕正豪，迁移不该动它。
    const created = await createRequirement(db, '吕品', {
      title: '本来就对', type: 'commercial', requester: '孙建宏',
    });
    await evaluate(db, '吕品', { requirementId: created.id });
    await submitReview(db, '吕品', { requirementId: created.id, prdUrl: 'https://x' });

    const first = await realignOpenReviewAssignments();
    expect(first.moved).toEqual([]);
    expect(first.voided).toEqual([]);
    expect(first.kept).toBe(1);

    const second = await realignOpenReviewAssignments();
    expect(second).toEqual({ moved: [], voided: [], kept: 1, unowned: 0 });
  });

  it('迁移之后 can() 的口径与派单一致：负责人那条线的负责人可签，别人不可', async () => {
    const { id } = await requirementWithOldAssignment('吕品', 'commercial');
    await realignOpenReviewAssignments();

    const row = await db.execute<{
      owner_member_id: string; owner_line: string | null;
    }>(sql`
      select r.owner_member_id, m.line as owner_line
        from requirements r left join members m on m.id = r.owner_member_id
       where r.id = ${id}`);
    const facts = {
      ownerMemberId: row.rows[0]!.owner_member_id,
      ownerLine: row.rows[0]!.owner_line,
      state: 'review',
      reviewerMemberId: idOf(FEATURE_LEAD),
    };
    const lead = people.find((p) => p.name === FEATURE_LEAD)!;
    const otherLead = people.find((p) => p.name === COMMERCIAL_LEAD)!;
    expect(can(lead, facts, 'review')).toBe(true);
    expect(can(otherLead, facts, 'review')).toBe(false);
  });
});
