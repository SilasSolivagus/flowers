import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { assignReviewer } from '../src/core/requirements/review.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { reviewerOf } from './helpers/factory.js';

/**
 * 派单选人：同一条线配了多个负责人时，派给谁（P2「派单选人」）。
 *
 * 这一组用例存在的理由是一条**静默**的坏法：旧实现是
 * `order by created_at, id limit 1`，于是
 *
 * 1. 同线两个人时永远是第一个人——另一个人永远签不到字，而没有任何界面提示这件事；
 * 2. 如果需求负责人本人就是那条线的负责人，派单会派给他**自己**。他点「通过」是真的
 *    通过（`can()` 认派单、派单是他），评审这道关口就等于不存在，而事件流、抽屉、
 *    看板全都长得完全正常。
 *
 * 所以这里不测「随便派了一个人」，而是逐个钉住三条排序各自的后果。为了让「是按 id 选的
 * 还是按规则选的」可分辨，用例**自己给成员指定 uuid**：id 的顺序因此是写死的，一条
 * 「只按 id」的实现会在下面每一条断言上给出另一个答案。
 */

beforeEach(async () => {
  await resetDb();
  await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

/** 可控 id 的成员：id 的顺序 = 插入的顺序，于是「id 升序」是可以预测的。 */
async function addPerson(input: {
  id: string; name: string; role: string; line: string | null;
}): Promise<string> {
  await db.execute(sql`
    insert into members (id, name, email, role, line)
    values (${input.id}::uuid, ${input.name}, ${`${input.name}@123pan.com`}, ${input.role}, ${input.line})`);
  return input.id;
}

/** 造一个「最近动过」的痕迹：一条以他为 actor 的事件（`events.actor` 存的是名字）。 */
async function activeAt(name: string, at: string): Promise<void> {
  await db.execute(sql`
    insert into events (requirement_id, actor, type, payload, at)
    values (null, ${name}, 'requirement.updated', '{}', ${at}::timestamptz)`);
}

/** 一条由 `owner` 负责、停在「待评审」的需求（走真实服务，不手改状态）。 */
async function submitted(owner: string): Promise<string> {
  const created = await createRequirement(db, owner, {
    title: '同线两人时的派单', type: 'feature', requester: '孙建宏',
  });
  await submitReview(db, owner, { requirementId: created.id, prdUrl: 'https://doc.example.com/prd' });
  return created.id;
}

const LEAD_A = '00000000-0000-4000-8000-00000000000a';
const LEAD_B = '00000000-0000-4000-8000-00000000000b';
const LEAD_C = '00000000-0000-4000-8000-00000000000c';

describe('同线多负责人：派给谁', () => {
  it('负责人本人也是本条线负责人时，派给另一个人（不是他自己）', async () => {
    // 两个功能线负责人，甲（owner，id 更小）与乙。
    await addPerson({ id: LEAD_A, name: '审甲', role: 'feature_reviewer', line: 'feature' });
    await addPerson({ id: LEAD_B, name: '审乙', role: 'feature_reviewer', line: 'feature' });

    const id = await submitted('审甲');

    // id 升序会选甲（= 自己签字）；规则说选乙。
    expect(await reviewerOf(id)).toBe('审乙');
  });

  it('非本人里优先最近有活动的人（活动胜过 id 顺序，也胜过「一条事件都没有」）', async () => {
    // 三个负责人：甲是 owner；乙 id 更小但**一条事件都没有**；丙 id 更大但最近动过。
    // 「没活动」在这一列里是 NULL，而 PG 的 `desc` 默认是 NULLS FIRST——少了
    // `nulls last`，乙（NULL）会排到丙前面。这条用例同时钉住那件事。
    await addPerson({ id: LEAD_A, name: '审甲', role: 'feature_reviewer', line: 'feature' });
    await addPerson({ id: LEAD_B, name: '审乙', role: 'feature_reviewer', line: 'feature' });
    await addPerson({ id: LEAD_C, name: '审丙', role: 'feature_reviewer', line: 'feature' });
    await activeAt('审丙', '2026-03-09T02:00:00.000Z');

    const id = await submitted('审甲');

    expect(await reviewerOf(id)).toBe('审丙');
  });

  it('两个候选都有活动时，取最近的那个', async () => {
    await addPerson({ id: LEAD_A, name: '审甲', role: 'feature_reviewer', line: 'feature' });
    await addPerson({ id: LEAD_B, name: '审乙', role: 'feature_reviewer', line: 'feature' });
    await addPerson({ id: LEAD_C, name: '审丙', role: 'feature_reviewer', line: 'feature' });
    await activeAt('审乙', '2026-01-05T02:00:00.000Z');
    await activeAt('审丙', '2026-03-09T02:00:00.000Z');

    const id = await submitted('审甲');

    expect(await reviewerOf(id)).toBe('审丙');
  });

  it('都没活动过时按 id 稳定：同一份输入跑两次给同一个人', async () => {
    await addPerson({ id: LEAD_A, name: '审甲', role: 'feature_reviewer', line: 'feature' });
    await addPerson({ id: LEAD_B, name: '审乙', role: 'feature_reviewer', line: 'feature' });

    const id = await submitted('审甲');
    // 第二次直接调派单函数：这正是「同一份输入再来一次」的形状。
    // 派单行有 `where not exists (handed)` 兜底，重复调用是空操作而不是第二条。
    const again = await db.transaction(async (tx) => assignReviewer(tx, id));
    const third = await db.transaction(async (tx) => assignReviewer(tx, id));

    expect(await reviewerOf(id)).toBe('审乙');
    expect(again).toBe(LEAD_B);
    expect(third).toBe(LEAD_B);
  });

  it('最近的签名属于别人时不会被算成自己的活动', async () => {
    // 反向一格：乙最近动过，但甲方是 owner——owner 的活动不参与排序（他本来就被排除）。
    await addPerson({ id: LEAD_A, name: '审甲', role: 'feature_reviewer', line: 'feature' });
    await addPerson({ id: LEAD_B, name: '审乙', role: 'feature_reviewer', line: 'feature' });
    await activeAt('审甲', '2026-03-09T02:00:00.000Z');
    await activeAt('审乙', '2026-01-05T02:00:00.000Z');

    const id = await submitted('审甲');

    expect(await reviewerOf(id)).toBe('审乙');
  });

  it('只配了一个负责人时照旧派给他（不是本人时）', async () => {
    // 回归位：新规则不能把「唯一的那个人」排掉——他既是候选也是唯一答案。
    // 先停用种子里那条线的负责人，让审甲 成为唯一候选。
    await db.execute(sql`update members set deactivated_at = now() where name = '吕正豪'`);
    await addPerson({ id: LEAD_A, name: '审甲', role: 'feature_reviewer', line: 'feature' });

    const created = await createRequirement(db, '吕品', {
      title: '唯一候选', type: 'feature', requester: '孙建宏',
    });
    await submitReview(db, '吕品', {
      requirementId: created.id, prdUrl: 'https://doc.example.com/prd',
    });

    expect(await reviewerOf(created.id)).toBe('审甲');
  });

  it('这条线只有负责人本人时派给他自己（偏好，不是禁令）', async () => {
    // **刻意的一格**：「避开本人」是**偏好**而不是禁令。线上此刻两条线各只有一位
    // 负责人，其中 54 条「收集 / 待设计」的需求就归这两位本人——如果这里改成「找不到
    // 别人就报错」，这 54 条下一次提交评审会当场失败，而它们今天能走完流程。
    // 所以规则是 order by，不是 where：本人排在最后，但只要他是唯一候选，仍然是答案。
    // 谁在什么时候签了自己的需求，看 `review_assignments` 那一行就能看出来。
    await db.execute(sql`update members set deactivated_at = now() where name = '吕正豪'`);
    await addPerson({ id: LEAD_A, name: '审甲', role: 'feature_reviewer', line: 'feature' });

    const id = await submitted('审甲');

    expect(await reviewerOf(id)).toBe('审甲');
  });
});
