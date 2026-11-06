import type { Db } from '../../db/client.js';
import { assertTrigger } from '../state-machine.js';
import { recordEvent } from '../events.js';
import { parseRequirementId, requirePlainObject } from '../validate.js';
import { lockRequirement, moveTo, type Locked, type Tx } from './lock.js';

/**
 * 评估这一步本身：门 + 推进 + 事件，**在调用方的事务里**。
 *
 * 为什么把它抽出来（P2 Task 5 / R-P2-8）：`uemaster.attach` 接上评估材料时，也要
 * 在**它自己那个事务**里做这道门和这条迁移——材料与迁移必须原子（要么都成，要么
 * 都不成）。而 `evaluate()` 自己开事务，外部没法把两件事塞进同一个事务里；硬调它
 * 就是「材料落了库、迁移失败」或者反过来，正是要防的那条。
 *
 * 抽出来只搬代码、不改行为：`evaluate()` 现在是「入参校验 + 开事务 + 调本函数」，
 * 锁行、assertTrigger（含 missing_type）、moveTo、payload `{from,to}` 逐字未动，
 * 所以真评估那条路上的错误文案、事件形状、并发语义全都与之前一致。
 *
 * `locked` 是给「调用方已经锁过行」的场景（attach 要读状态判断该不该推进，那次
 * 读取就该顺手加锁，而不是在同一事务里再 select ... for update 一次）。不传就自己
 * 锁——顺序仍然是「先锁行、再判门」，与原来一样：后到者等前者提交后基于新状态
 * 重新判断，于是第二次撞 illegal_transition，而不是两个都通过、把状态推两步。
 */
export async function evaluateInTx(
  tx: Tx,
  actor: string,
  requirementId: string,
  locked?: Locked,
): Promise<{ state: 'design' }> {
  const row = locked ?? (await lockRequirement(tx, requirementId));
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
}

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

  return db.transaction(async (tx) => evaluateInTx(tx, actor, requirementId));
}
