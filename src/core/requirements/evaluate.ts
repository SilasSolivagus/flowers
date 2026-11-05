import type { Db } from '../../db/client.js';
import { assertTrigger } from '../state-machine.js';
import { recordEvent } from '../events.js';
import { parseRequirementId, requirePlainObject } from '../validate.js';
import { lockRequirement, moveTo } from './lock.js';

/**
 * 评估：inbox → design。
 *
 * 锁行语义见 lock.ts：并发评估同一需求时，后来者会等前者提交，再基于新状态
 * 重新判断，于是第二次会撞上 illegal_transition，而不是两个都通过。
 */
export async function evaluate(db: Db, actor: string, raw: unknown) {
  // 入参先挡住：非对象会抛 TypeError，非 uuid 会让 PG 抛 22P02，两者都不是 AppError。
  const input = requirePlainObject(raw);
  const requirementId = parseRequirementId(input);

  return db.transaction(async (tx) => {
    const row = await lockRequirement(tx, requirementId);
    // 光看配对不够：review → design 也是合法的一对（那是评审打回），所以对着一条
    // 待评审的需求点「评估」会骑着它跑回待设计、静默顶掉打回。必须钉 trigger。
    // hasType 来自真实读出的行（类型列 NOT NULL，但门禁读的是数据，不是常量）。
    assertTrigger(row.state, 'design', 'evaluate', { hasType: !!row.type });
    await moveTo(tx, requirementId, 'design');
    await recordEvent(tx, {
      requirementId, actor, type: 'requirement.evaluated',
      payload: { from: row.state, to: 'design' },
    });
    return { state: 'design' as const };
  });
}
