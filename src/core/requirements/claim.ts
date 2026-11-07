import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { recordEvent } from '../events.js';
import { parseRequirementId, requirePlainObject } from '../validate.js';
import { assertCan } from '../auth/guard.js';
import { lockRequirement } from './lock.js';

/**
 * 认领（P4-06）：把一条**还没有负责人**的需求接过来，认领人即成为负责人。
 *
 * 为什么需要这个动作：权限锚点从「需求类型」换成「负责人的条线」之后，一条没有负责人
 * 的需求**没有任何条线可以锚定**——它不属于任何一位条线负责人。旧模型里「类型决定谁
 * 管」，无主的需求至少还有一条线；新模型里那条线不存在了，所以必须有一个显式的动作把
 * 它落回某个人身上。owner 的原话是「任何 PM 都能立项，立项即成为负责人」。
 *
 * 三个边界：
 *
 * 1. **只能认领无主的需求**：`can('claim')` 里带着 `ownerMemberId === null`，所以已经
 *    有负责人的需求对所有人（包括超管）都不是「可认领」——超管要走 `reassignOwner`。
 *    这里的 `where owner_member_id is null` 是第二道：即使在判与写之间有人抢先认领
 *    （`for update` 已经挡住了），这条 update 也不会覆盖别人的归属。
 * 2. **认领不改状态**：状态机是冻结的（`src/core/state-machine.ts`），认领只是换了
 *    负责人这一列——收集里的需求认领之后还在收集里，它的下一步仍然是评估或提交评审。
 *    「立项」在这个系统里就是「成为负责人」，不是「跳过一个状态」。
 * 3. **写一条 `requirement.owner_assigned` 事件**（`from: null`）：时间轴、通知扇出、
 *    「这条需求换过几次人」都从事件读。与转交共用同一个事件类型，因为读侧要回答的是
 *    同一件事——「负责人是谁、什么时候换的」；不另开一种「认领」事件，否则每个读
 *    `owner_assigned` 的地方都要再记一个类型名。
 *
 * 认领之后这条需求就落到认领人的条线下：他的条线负责人从此能改、能签这条需求，
 * 别的条线仍然不能（这本文件不需要写这句话，`can()` 会回答）。
 */
export async function claimRequirement(db: Db, actor: string, raw: unknown): Promise<{
  id: string; owner: string; changed: boolean;
}> {
  const input = requirePlainObject(raw);
  const requirementId = parseRequirementId(input);

  return db.transaction(async (tx) => {
    const locked = await lockRequirement(tx, requirementId);
    const me = await assertCan(tx, actor, {
      ownerMemberId: locked.owner_member_id,
      ownerLine: locked.owner_line,
      state: locked.state,
    }, 'claim');

    const updated = await tx.execute<{ id: string }>(sql`
      update requirements
         set owner_member_id = ${me.id}
       where id = ${requirementId} and owner_member_id is null
      returning id`);

    // 判的时候还没有负责人、写的时候已经有了：并发下另一笔认领先落地。这不是错误，
    // 是「你来晚了」；不写事件、也不改归属，调用方看 changed=false。
    if (updated.rows.length === 0) {
      return { id: requirementId, owner: me.name, changed: false };
    }

    await recordEvent(tx, {
      requirementId,
      actor,
      type: 'requirement.owner_assigned',
      payload: { from: null, to: me.name },
    });

    return { id: requirementId, owner: me.name, changed: true };
  });
}
