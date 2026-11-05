import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { assertTrigger } from '../state-machine.js';
import { recordEvent } from '../events.js';
import { asText, parseRequirementId, requirePlainObject } from '../validate.js';
import { lockRequirement, moveTo, type Tx } from './lock.js';

/**
 * 需求类型 → 评审人角色（members.role 的取值就是这两个字符串）。模块私有：
 * 唯一消费者是本文件的 assignReviewer。用例里刻意写死评审人姓名（'赵越' / '吕正豪'），
 * 不从这里反查——否则实现改错映射时，测试会跟着错，等于自己给自己盖章。
 */
const REVIEWER_ROLE = {
  commercial: 'commercial_reviewer',
  feature: 'feature_reviewer',
} as const;

/**
 * 派单：按需求类型挑一个角色匹配的评审人，写一条 verdict='handed' 的派单行。
 *
 * 由 submitReview 在**同一个事务**里、状态已推进到 review 之后调用：派单失败必须
 * 把状态推进一起回滚，否则会留下「在待评审但没人接」的僵局。
 *
 * 同一条需求同时只应该有一条 handed 派单。主防线是状态机（review → review 不存在，
 * 二次提交在写派单之前就撞 illegal_transition）；`where not exists` 只是兜底，
 * 让重复调用变成空操作而不是留下第二条。
 *
 * order by created_at, id 只是为了让「同角色配了多个人」时结果稳定可复现。
 */
export async function assignReviewer(tx: Tx, requirementId: string, type: string) {
  // hasOwn 而不是裸查表：type 来自数据库的 text 列，'toString' / 'constructor'
  // 会命中原型上的函数（truthy）并当成角色绑进 SQL，绕过 !role 这道判断。
  const role = Object.hasOwn(REVIEWER_ROLE, type)
    ? REVIEWER_ROLE[type as keyof typeof REVIEWER_ROLE]
    : undefined;
  if (!role) throw new AppError('invalid_type', '需求类型不认识');

  const found = await tx.execute<{ id: string }>(sql`
    select id from members where role = ${role} order by created_at, id limit 1`);
  const reviewer = found.rows[0];
  if (!reviewer) throw new AppError('no_reviewer', '这个类型还没有配评审人');

  await tx.execute(sql`
    insert into review_assignments (requirement_id, reviewer_member_id, verdict)
    select ${requirementId}::uuid, ${reviewer.id}::uuid, 'handed'
     where not exists (
       select 1 from review_assignments
        where requirement_id = ${requirementId}::uuid and verdict = 'handed')`);

  return reviewer.id;
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
