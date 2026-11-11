import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { assertCan } from '../auth/guard.js';
import { parseRequirementId, requirePlainObject, asText } from '../validate.js';
import { lockRequirement, moveTo } from './lock.js';
import { assertTransition } from '../state-machine.js';
import { recordEvent } from '../events.js';

/**
 * 退回待开发（2026-11-11，C1）：dev → ready。
 *
 * 为什么要有这条：开发中常常发现「这条接错了 / 方案变了 / 排期要重来」，原来没有任何
 * 往回走的动作（只有测试→开发的 bounce）。人只能把需求搁置再新建一条，历史就断了。
 *
 * 与 bounce 的分工：
 * - `bounce`：测试 → 开发，语义是「测试没过，修完再测」；
 * - `reopen`：开发 → 待开发，语义是「还没真正开始，退回去重新排期」。
 *
 * 必须写原因：时间线上要能回答「为什么退回」，否则版本页的延期数字又变成没有来由的。
 */
export async function reopenRequirement(db: Db, actor: string, raw: unknown): Promise<{
  state: 'ready';
}> {
  const input = requirePlainObject(raw);
  const requirementId = parseRequirementId(input);
  const reason = asText(input.reason).trim();
  if (reason === '') throw new AppError('invalid', '退回待开发要写原因');

  return db.transaction(async (tx) => {
    const row = await lockRequirement(tx, requirementId);
    await assertCan(tx, actor, {
      ownerMemberId: row.owner_member_id, ownerLine: row.owner_line, state: row.state,
    }, 'edit');

    // 状态门先过：`moveTo` 只写状态，不判「这条边存不存在」。
    assertTransition(row.state, 'ready');
    await moveTo(tx, requirementId, 'ready');
    await recordEvent(tx, {
      requirementId,
      actor,
      type: 'requirement.reopened',
      payload: { from: row.state, to: 'ready', reason },
    });
    return { state: 'ready' as const };
  });
}
