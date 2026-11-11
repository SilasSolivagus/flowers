import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { recordEvent } from '../events.js';
import { assertCan } from '../auth/guard.js';
import { isAdmin } from '../auth/roles.js';
import { parseRequirementId, requirePlainObject, asText } from '../validate.js';
import { sql } from 'drizzle-orm';
import { lockRequirement } from './lock.js';
import { STATE_LABEL, type State } from '../state-machine.js';

/**
 * 状态校准（2026-11-11，C3）：把一条需求直接摆到它**真实所在**的阶段。
 *
 * 为什么需要它：迁移进来的存量卡片，真实进度早就不在「收集」了（有的已经做完设计、
 * 有的在等排期），但状态机只认「走过来的路」，没有「从任意状态到任意状态」的边。
 * 没有这个入口，人只能「新建一条再搁置旧的」，历史就断成两截。
 *
 * 三条约束，缺一条就会变成「谁都能改状态」：
 * 1. **只有超管**（`product_owner`）。这是一次写历史的动作，不是日常推进；
 * 2. **必须写原因**，事件里记 from → to 与原因；
 * 3. **只改状态**，不动版本、承诺日、产物——那些各自有入口（版本页 / 交材料）。
 *    真要清日期，校准完再去版本页改。
 *
 * 与其它动作的关系：日常流转仍然走状态机（立项 / 评审 / 排期 / 打回…）。这个入口
 * 是**校准**，不是捷径：它不代替任何一步，只是把「机器里的状态」对齐「现实里的状态」。
 */
export async function calibrateState(db: Db, actor: string, raw: unknown): Promise<{
  from: State; to: State;
}> {
  const input = requirePlainObject(raw);
  const requirementId = parseRequirementId(input);
  const to = asText(input.to).trim() as State;
  const reason = asText(input.reason).trim();

  if (!(to in STATE_LABEL)) {
    throw new AppError('invalid', `状态只能是：${Object.keys(STATE_LABEL).join(' / ')}`);
  }
  if (reason === '') throw new AppError('invalid', '状态校准必须写原因');

  return db.transaction(async (tx) => {
    const row = await lockRequirement(tx, requirementId);
    await assertCan(tx, actor, {
      ownerMemberId: row.owner_member_id, ownerLine: row.owner_line, state: row.state,
    }, 'admin');
    const member = await tx.execute<{ role: string }>(
      sql`select role from members where name = ${actor} limit 1`);
    if (!isAdmin({ role: member.rows[0]?.role } as never)) {
      throw new AppError('forbidden', '状态校准只有超管能做');
    }
    if (row.state === to) throw new AppError('invalid', '目标状态与当前状态相同');

    await tx.execute(sql`
      update requirements set state = ${to}, state_entered_at = now() where id = ${requirementId}`);
    await recordEvent(tx, {
      requirementId,
      actor,
      type: 'requirement.calibrated',
      payload: { from: row.state, to, reason },
    });
    return { from: row.state as State, to };
  });
}
