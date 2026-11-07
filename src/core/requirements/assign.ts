import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { recordEvent } from '../events.js';
import { parseRequirementId, requirePlainObject, asText, parseId } from '../validate.js';
import { assertCan } from '../auth/guard.js';
import { memberById } from '../auth/members.js';
import { can } from '../auth/roles.js';
import { lockRequirement } from './lock.js';

/**
 * 转交负责人（P4-04）。
 *
 * 站在这条规则的两端：**谁能转**、**能转给谁**。
 *
 * - 谁能转：`can(..., 'reassignOwner')` —— 超管，或**这条需求所属条线的负责人**。
 *   PM 不能：他能改自己的需求，但不能把它甩给别人，否则「谁负责」就变成一句可以由
 *   当事人单方面改写的注释。
 * - 能转给谁：目标必须在名册上、还没停用；条线负责人只能转给**本线的人**（超管不受
 *   这条限制）。跨线转交等于把一条商业需求塞进功能线——那条线的负责人从此要为一件
 *   不归他管的事负责，而权限模型里没有任何一格表达这件事。
 *
 * 为什么单独一个函数、而不是复用 `updateRequirement`：那个函数的白名单里明确没有
 * `ownerMemberId`（描述可改、归属不可改，见 manage.ts 的 `FORBIDDEN`）。把归属塞进
 * 描述那条路，等于让一次「保存描述」悄悄改掉负责人；而归属变更是要通知到人的。
 *
 * 写成**独立事件**（`requirement.owner_assigned`）而不是悄悄 update：通知扇出、时间轴、
 * 「这条需求换过几次人」都从事件读。新负责人收到的第一条通知就是它。
 */
export async function reassignOwner(db: Db, actor: string, raw: unknown): Promise<{
  id: string; owner: string; changed: boolean;
}> {
  const input = requirePlainObject(raw);
  const requirementId = parseRequirementId(input);
  const ownerText = asText(input.ownerMemberId);
  const ownerMemberId = parseId(ownerText ?? '', '负责人 ID 格式不正确');

  return db.transaction(async (tx) => {
    const locked = await lockRequirement(tx, requirementId);
    const me = await assertCan(tx, actor, {
      type: locked.type ?? '', ownerMemberId: locked.owner_member_id, state: locked.state,
    }, 'reassignOwner');

    const target = await memberById(tx, ownerMemberId);
    if (target === null || target.deactivatedAt !== null) {
      throw new AppError('invalid', '负责人不在名册上（或已停用）');
    }

    if (!can(me, {
      type: locked.type ?? '', ownerMemberId: locked.owner_member_id,
    }, 'admin') && target.line !== locked.type) {
      throw new AppError('forbidden', '只能把需求交给本线的人');
    }

    if (locked.owner_member_id === target.id) {
      // 转给同一个人不是错误：界面上再点一次「保存」不该报错，也不该产生一条事件。
      return { id: requirementId, owner: target.name, changed: false };
    }

    const fromName = locked.owner_member_id === null
      ? null
      : await nameOf(tx, locked.owner_member_id);

    await tx.execute(sql`
      update requirements set owner_member_id = ${target.id} where id = ${requirementId}`);

    await recordEvent(tx, {
      requirementId,
      actor,
      type: 'requirement.owner_assigned',
      payload: { from: fromName, to: target.name },
    });

    return { id: requirementId, owner: target.name, changed: true };
  });
}

async function nameOf(
  exec: { execute: Db['execute'] }, memberId: string,
): Promise<string> {
  const res = await exec.execute<{ name: string }>(
    sql`select name from members where id = ${memberId} limit 1`);
  return res.rows[0]?.name ?? '';
}
