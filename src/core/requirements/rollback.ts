import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { assertTrigger } from '../state-machine.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';
import { asText, parseRequirementId, requirePlainObject } from '../validate.js';
import { assertCan } from '../auth/guard.js';
import { lockRequirement, moveTo } from './lock.js';

const MISSING_REASON = '回滚必须写原因';

/**
 * 回滚：`live → queue`（已上线 → 待排期）。
 *
 * ── 为什么退回**待排期**，而不是「开发中」
 *
 * 这条边最容易写错的地方不是权限，是时钟。`dev` 的推进条件是 `commit_test_at <= 今天`，
 * 而一条刚发出去又撤回来的需求，它的提测日必然在昨天或更早——退回 `dev` 的效果是
 * **下一次 tick 立刻把它推到测试中，再下一次推到已上线**，回滚等于没做。
 *
 * 想让它停在 `dev`，只能把两个日期清空；可清空之后这条需求再也回不到排期（`schedule`
 * 的入口在 `queue → ready`，从 `dev` 没有那条边），于是它永远停在开发中。两条都是
 * 死路。
 *
 * `queue` 是唯一有出路的落点：重新排期（`schedule`）会把版本与两个日期整体覆盖，
 * 时钟再从新的提测日开始算。所以「回滚」在这个状态机里的准确含义是
 * **这条没发成，退回去重排**。
 *
 * ── 清掉排期三列，但把它写进事件
 *
 * 留在 `queue` 上还挂着旧版本与旧日期，看板与甘特会说两句话（「它属于 2026.11」
 * 与「它在待排期」）。所以三列一起清；清掉的事实不丢——`payload` 里带着被清掉的
 * 版本名与两个日期，事件流仍然回答得出「它先前排在哪一版」。
 */
export async function rollbackRelease(db: Db, actor: string, raw: unknown) {
  const input = requirePlainObject(raw);
  const reason = asText(input.reason);
  if (!reason) throw new AppError('missing_reason', MISSING_REASON);

  const requirementId = parseRequirementId(input);

  return db.transaction(async (tx) => {
    const row = await lockRequirement(tx, requirementId);

    // 权限与搁置同一条口径（`edit`：负责人 / 本线条线负责人 / 超管）。
    // 回滚是「这条需求发出去的版本有问题」，做决定的还是对它负责的那个人。
    await assertCan(tx, actor, {
      ownerMemberId: row.owner_member_id, ownerLine: row.owner_line, state: row.state,
    }, 'edit');

    assertTrigger(row.state, 'queue', 'rollback');

    // 被清掉的三列先读出来：事件要写「从哪一版、哪两个日子撤回来的」。
    const before = await tx.execute<{
      release_name: string | null; commit_test_at: string | null; commit_due_at: string | null;
    }>(sql`
      select rel.name as release_name, r.commit_test_at::text as commit_test_at,
             r.commit_due_at::text as commit_due_at
        from requirements r
        left join releases rel on rel.id = r.release_id
       where r.id = ${requirementId}`);

    await moveTo(tx, requirementId, 'queue');
    await tx.execute(sql`
      update requirements
         set release_id = null, commit_test_at = null, commit_due_at = null
       where id = ${requirementId}`);

    await recordEvent(tx, {
      requirementId,
      actor,
      type: 'requirement.rolled_back',
      payload: {
        from: row.state,
        to: 'queue',
        reason,
        release: before.rows[0]?.release_name ?? null,
        commitTestAt: before.rows[0]?.commit_test_at ?? null,
        commitDueAt: before.rows[0]?.commit_due_at ?? null,
      },
    });

    return { state: 'queue' as const };
  });
}
