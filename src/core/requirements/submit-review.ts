import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { assertTransition } from '../state-machine.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';

/** 跳过评估直提评审时写进 skip_reason 的固定文案（报表按它识别这条捷径）。 */
export const SKIP_EVALUATION_REASON = '跳过评估，直接提交 PRD';

/**
 * 提交评审：design → review，或 inbox → review（跳过评估）。
 *
 * PRD 链接的校验放在事务之前：空白链接是最常见的用户错误，没必要占一条连接、
 * 开一个事务再回滚；也让「校验先于查行」这件事可以被单独测试。
 *
 * 取行用 `for update`：并发双提交时后来者会等前者提交，看到 state 已变成
 * review，于是撞 illegal_transition，而不是两次都成功。
 */
export async function submitReview(
  db: Db, actor: string, input: { requirementId: string; prdUrl: string },
) {
  const url = input.prdUrl.trim();
  if (!url) throw new AppError('missing_prd', '提交评审必须填正式 PRD 链接');

  return db.transaction(async (tx) => {
    const cur = await tx.execute<{ state: string; type: string | null }>(
      sql`select state, type from requirements where id = ${input.requirementId} for update`);
    const row = cur.rows[0];
    if (!row) throw new AppError('not_found', '找不到这条需求');
    assertTransition(row.state as never, 'review', { hasPrd: true, hasType: !!row.type });

    const skipped = row.state === 'inbox';
    await tx.execute(sql`
      update requirements
         set state = 'review',
             prd_url = ${url},
             state_entered_at = now(),
             skip_reason = case when ${skipped} then ${SKIP_EVALUATION_REASON}
                                else skip_reason end
       where id = ${input.requirementId}`);

    await recordEvent(tx, {
      requirementId: input.requirementId, actor, type: 'requirement.review_requested',
      payload: { from: row.state, to: 'review', prdUrl: url, skippedEvaluation: skipped },
    });

    // Task 6 在此处派单（按 type 选评审人、写 review_assignments）；本任务只留缝。

    return { state: 'review' as const, skippedEvaluation: skipped };
  });
}
