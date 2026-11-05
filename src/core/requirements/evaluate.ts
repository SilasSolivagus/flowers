import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { assertTransition } from '../state-machine.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';
import { parseRequirementId, requirePlainObject } from '../validate.js';

/**
 * 评估：inbox → design。
 *
 * 取行用 `for update`：并发评估同一需求时，后来者会等前者提交，再基于新状态
 * 重新判断，于是第二次会撞上 illegal_transition，而不是两个都通过。
 */
export async function evaluate(db: Db, actor: string, raw: unknown) {
  // 入参先挡住：非对象会抛 TypeError，非 uuid 会让 PG 抛 22P02，两者都不是 AppError。
  const input = requirePlainObject(raw);
  const requirementId = parseRequirementId(input);

  return db.transaction(async (tx) => {
    const cur = await tx.execute<{ state: string; type: string | null }>(
      sql`select state, type from requirements where id = ${requirementId} for update`);
    const row = cur.rows[0];
    if (!row) throw new AppError('not_found', '找不到这条需求');
    assertTransition(row.state as never, 'design', { hasPrd: true, hasType: !!row.type });
    await tx.execute(sql`
      update requirements set state = 'design', state_entered_at = now()
      where id = ${requirementId}`);
    await recordEvent(tx, {
      requirementId, actor, type: 'requirement.evaluated',
      payload: { from: row.state, to: 'design' },
    });
    return { state: 'design' as const };
  });
}
