import type { Db } from '../src/db/client.js';
import { AppError } from '../src/core/errors.js';
import { requirementsOwnedBy } from '../src/core/read/member-admin.js';
import { reassignOwner } from '../src/core/requirements/assign.js';

/**
 * 「把这个人负责的需求全部转给别人」（P4-05，设置 · 成员）。
 *
 * 停用被占用的负责人时，服务层会拒绝并给一句「这个人还负责 N 条需求，先转交」。
 * 界面上的下一步就是这一条：选一个人，一次转完。
 *
 * **没有新的权限逻辑**：循环里每一条都调 `reassignOwner`，由它自己判
 * `can('reassignOwner')`、自己判「目标是不是本线的人」（超管不受这一条）、
 * 自己写 `requirement.owner_assigned` 事件。这里的只有「取哪些需求」与「一条条调」。
 *
 * 为什么不是一条 SQL 批量 update：转交是**要通知到人**的动作（事件 → 扇出），
 * 批量改会静默跳过事件线，也会跳过每一条的锁与状态检查。N 通常是个位数。
 */
export type TransferInput = { fromMemberId?: unknown; toMemberId?: unknown };

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function transferOwnedRequirements(
  db: Db, actor: string, raw: TransferInput,
): Promise<{ moved: number; to: string }> {
  const fromMemberId = text(raw.fromMemberId);
  const toMemberId = text(raw.toMemberId);
  if (fromMemberId === '') throw new AppError('invalid', '先选要转交的人');
  if (toMemberId === '') throw new AppError('invalid', '先选接手的人');
  if (fromMemberId === toMemberId) throw new AppError('invalid', '不能转给同一个人');

  const owned = await requirementsOwnedBy(fromMemberId);
  for (const requirement of owned) {
    await reassignOwner(db, actor, {
      requirementId: requirement.id,
      ownerMemberId: toMemberId,
    });
  }
  return { moved: owned.length, to: toMemberId };
}
