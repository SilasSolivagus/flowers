import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { assertTrigger } from '../state-machine.js';
import { recordEvent } from '../events.js';
import { asText, parseRequirementId, requirePlainObject } from '../validate.js';
import { memberByName } from '../auth/members.js';
import { can, leadRoleOf } from '../auth/roles.js';
import { lockRequirement, moveTo, type Locked, type Tx } from './lock.js';

/**
 * 签字人不是派单上的那个人（R29）。
 *
 * P4-04 起这条判定**不再**是本文件的私有规则：`can(actor, facts, 'review')` 是唯一的
 * 判断题。这个常量只剩一句中文——错误码仍然是 `not_reviewer` 而不是 `forbidden`：
 * 它更精确（「去找该签的人」vs「你没有权限」），而且 P1 的用例逐字钉着它。
 *
 * 用例里仍然写死评审人姓名（'赵越' / '吕正豪'），不从实现反查——否则实现改错锚点时，
 * 测试会跟着错，等于自己给自己盖章。
 */
const NOT_REVIEWER = '签字人不是这条需求派单到的评审人';

/**
 * 派单：按**负责人所在条线**挑一个角色匹配的评审人，写一条 verdict='handed' 的派单行。
 *
 * P4-06 之前这里按需求类型挑（商业类 → 商业线负责人）。owner 的原话是「按人的归属」，
 * 于是这里只读一件事：`requirements.owner_member_id` 那一行的 `members.line`。
 * 一条商业类需求由功能线 PM 负责时，签它的是功能线负责人。
 *
 * 由 submitReview 在**同一个事务**里、状态已推进到 review 之后调用：派单失败必须
 * 把状态推进一起回滚，否则会留下「在待评审但没人接」的僵局。
 *
 * 两种「没有可派的条线」：
 *
 * 1. **负责人没有条线**（今天只有超管是这种人）→ 返回 null，**不写派单行**。
 *    这时 `can('review')` 只对超管成立（`ownerLine === null` 不授予任何条线权限），
 *    而超管不受派单限制——所以这条需求照样有人能签。若在这里 throw `no_reviewer`，
 *    超管连自己提的需求都提交不了评审：一条只挡住超管的规则不是规则。
 * 2. **负责人所在条线没有配负责人**（名册里没有那个 role + line 的人）→ 抛
 *    `no_reviewer`，整笔事务回滚。这与 P1 的口径一致：类型在、人不在，宁可不进评审。
 *
 * 同一条需求同时只应该有一条 handed 派单。主防线是状态机（review → review 不存在，
 * 二次提交在写派单之前就撞 illegal_transition）；`where not exists` 只是兜底，
 * 让重复调用变成空操作而不是留下第二条。
 *
 * order by created_at, id 只是为了让「同一条线配了多个人」时结果稳定可复现。
 */
export async function assignReviewer(tx: Tx, requirementId: string): Promise<string | null> {
  const owner = await tx.execute<{
    owner_member_id: string | null; owner_line: string | null;
  }>(sql`
    select r.owner_member_id, m.line as owner_line
      from requirements r
      left join members m on m.id = r.owner_member_id
     where r.id = ${requirementId}`);
  const row = owner.rows[0];
  if (!row) throw new AppError('not_found', '找不到这条需求');

  // 没有负责人 / 负责人没有条线：没有可锚的线，派给超管（不落派单行）。
  if (row.owner_member_id === null || row.owner_line === null) return null;

  // hasOwn 而不是裸查表：line 来自数据库的 text 列，'toString' / 'constructor'
  // 会命中原型上的函数（truthy）并当成角色绑进 SQL，绕过这道判断。
  const role = leadRoleOf(row.owner_line);
  if (role === null) throw new AppError('no_reviewer', '负责人所在条线认不出，无法派单');

  const found = await tx.execute<{ id: string }>(sql`
    select id from members
     where role = ${role} and line = ${row.owner_line} and deactivated_at is null
     order by created_at, id limit 1`);
  const reviewer = found.rows[0];
  if (!reviewer) throw new AppError('no_reviewer', '这个条线还没有配负责人');

  await tx.execute(sql`
    insert into review_assignments (requirement_id, reviewer_member_id, verdict)
    select ${requirementId}::uuid, ${reviewer.id}::uuid, 'handed'
     where not exists (
       select 1 from review_assignments
        where requirement_id = ${requirementId}::uuid and verdict = 'handed')`);

  return reviewer.id;
}

/**
 * 签字人必须是派单上的那个人（R29）。
 *
 * 派单（assignReviewer）只保证了「派给谁」，签字这一步从前只把 actor 写进事件——
 * 谁都能签。这里把它闭合：actor（成员姓名，整套服务对外都用姓名标识人）必须等于
 * 这条需求 handed 派单上的 reviewer_member_id。
 *
 * P4-06 起「谁有权签」的那一半由 `can('review')` 按**负责人所在条线**回答；这一层只
 * 补两件事：状态（`can` 里也有，这里先过一遍为了错误措辞）与派单。
 *
 * 三种不匹配一律 not_reviewer，用同一句话：
 * - 姓名对不上派单上的评审人；
 * - 这个人不是负责人所在条线的负责人（也不是超管）；
 * - 这条需求没有 handed 派单时不算不匹配：`can()` 把 null 当成「不挑人」，于是那条线
 *   的负责人（或超管）仍然能签——负责人没有条线时派单本来就是空的，超管要签得下去。
 *
 * 为什么不为「查无此人」单开一个错误码：那会变成一张「谁是成员」的探测器
 * （拿任意名字试，凭错误码差异枚举出花名册），而用户能做的动作是一样的——找对的人来签。
 * 顺序在 assertTrigger 之后：先回答「这一步能不能做」，再回答「你能不能做」。
 */
async function assertReviewer(
  tx: Tx, requirementId: string, actor: string, locked: Locked,
): Promise<void> {
  const found = await tx.execute<{ reviewer_member_id: string }>(sql`
    select ra.reviewer_member_id
      from review_assignments ra
     where ra.requirement_id = ${requirementId} and ra.verdict = 'handed'
     order by ra.id
     limit 1`);
  const member = await memberByName(tx, actor);
  const facts = {
    ownerMemberId: locked.owner_member_id,
    ownerLine: locked.owner_line,
    state: locked.state,
    // 没有 handed 派单时传 null：can() 把「还没有派单」当成「不挑人」，于是负责人所在
    // 条线的负责人仍然能签（否则一条派单丢失的需求会永远没人能签）。负责人没有条线时
    // 派单本来就是空的，这一格让超管签得下去。
    reviewerMemberId: found.rows[0]?.reviewer_member_id ?? null,
  };
  if (member === null || member.deactivatedAt !== null || !can(member, facts, 'review')) {
    throw new AppError('not_reviewer', NOT_REVIEWER);
  }
}

/**
 * 通过：review → queue（进待排期），并把这条需求的 handed 派单收口成 passed。
 */
export async function reviewPass(db: Db, actor: string, raw: unknown) {
  // 入口守卫放在事务之前，与 evaluate / submitReview 保持一致。
  const input = requirePlainObject(raw);
  const requirementId = parseRequirementId(input);

  return db.transaction(async (tx) => {
    const row = await lockRequirement(tx, requirementId);
    // 只按配对判断是不够的：inbox → design 是合法的一对（那是评估的路子），
    // 所以光看配对，对一条还在 inbox 的需求点「通过」会骑着它走到别处。
    assertTrigger(row.state, 'queue', 'review_pass');
    await assertReviewer(tx, requirementId, actor, row);

    await moveTo(tx, requirementId, 'queue');
    await tx.execute(sql`
      update review_assignments set verdict = 'passed', decided_at = now()
       where requirement_id = ${requirementId} and verdict = 'handed'`);

    await recordEvent(tx, {
      requirementId, actor, type: 'requirement.review_passed',
      payload: { from: row.state, to: 'queue' },
    });
    return { state: 'queue' as const };
  });
}

/**
 * 打回：review → design，并把派单收口成 rejected 且落原因。
 *
 * 原因校验在开事务之前：空白原因是最常见的用户错误，没必要占连接、开事务再回滚；
 * 也让「校验先于查行」可以被单独测试（需求不存在时也先报 missing_reason）。
 */
export async function reviewReject(db: Db, actor: string, raw: unknown) {
  const input = requirePlainObject(raw);
  const reason = asText(input.reason);
  if (!reason) throw new AppError('missing_reason', '打回必须写原因');

  const requirementId = parseRequirementId(input);

  return db.transaction(async (tx) => {
    const row = await lockRequirement(tx, requirementId);
    // 同上：inbox → design 是合法配对，所以一条 inbox 的需求直接点打回会「成功」，
    // 等于白送一次评估。钉住 trigger，措辞也因此变成「当前在「收集」，不能执行这一步」。
    assertTrigger(row.state, 'design', 'review_reject');
    await assertReviewer(tx, requirementId, actor, row);

    await moveTo(tx, requirementId, 'design');
    await tx.execute(sql`
      update review_assignments set verdict = 'rejected', reason = ${reason}, decided_at = now()
       where requirement_id = ${requirementId} and verdict = 'handed'`);

    await recordEvent(tx, {
      requirementId, actor, type: 'requirement.review_rejected',
      payload: { from: row.state, to: 'design', reason },
    });
    return { state: 'design' as const };
  });
}
