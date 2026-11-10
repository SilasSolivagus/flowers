import type { Db } from '../../db/client.js';
import { assertTrigger } from '../state-machine.js';
import { recordEvent } from '../events.js';
import { parseRequirementId, requirePlainObject } from '../validate.js';
import { assertCan } from '../auth/guard.js';
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
 * 锁行、assertTrigger、moveTo、payload `{from,to}` 逐字未动，所以真评估那条路上的
 * 错误文案、事件形状、并发语义全都与之前一致。
 *
 * Ruling 1（2026-11-08）：这里曾经传 `hasType: !!row.type`。类型不再是门，那个键
 * 连同上送的 `missing_type` 一起删掉——**没有类型的需求照样立项**（这正是裁决要的：
 * 负责人决定评审人，类型不承载权限）。锁行仍然照旧，`assertTrigger` 仍然要跑：
 * 它防的是「走错门的动作」，与类型无关。
 *
 * Ruling 2（2026-11-10）：`inbox → design` 现在带 `guard: 'brief'`——**核心三问不齐不
 * 能立项**。上下文就是刚锁回来的那一行（`Locked` 里有 context / problem / outcome），
 * 所以这句话点名的是库里真实缺的那几格，不是调用方嘴上说的。为什么门在这条边上、
 * 而不是只装在生成器里：立项是一个动作，材料是这个动作的产物（见 `brief.ts` 与
 * `state-machine.ts` 的 Ruling 2）。
 *
 * 这条迁移有两个入口，都要过这道门：`evaluate()`（点评估 / MCP 的
 * `requirement_start_design`）与 `uemaster/attach.ts`（生成完把材料交回来时顺手推进）。
 * 后者走同一个函数，所以「材料落了库、需求没推进」与「改了状态、材料没落」这两种半成品
 * 都不会出现——门一响，两件事一起回滚。
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
  //
  // ctx 传的是刚锁回来的那一行：`brief` 那道门要逐条点名缺哪几格，判据与那句话都在
  // `requirements/brief.ts`（状态机、生成前、读模型共用同一份）。
  // 类型仍然不传：Ruling 1 之后没有 `guard: 'type'`，传一个没人读的键会让下一个人
  // 以为类型还在判。
  assertTrigger(row.state, 'design', 'evaluate', { brief: row });
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

  return db.transaction(async (tx) => {
    // 权限先于状态门（P4-04）：先回答「这条需求是不是你能改的」，再回答「现在能不能
    // 评估」。反过来的话，一句「当前在「待评审」，不能执行这一步」就等于告诉一个
    // 旁观者这条需求现在停在哪个状态——状态本身不是秘密，但顺序决定了错误消息在
    // 权限之外还泄露多少东西。锁行之后判，读到的就是这一事务将要改的那一行。
    const row = await lockRequirement(tx, requirementId);
    await assertCan(tx, actor, {
      ownerMemberId: row.owner_member_id, ownerLine: row.owner_line, state: row.state,
    }, 'edit');
    return evaluateInTx(tx, actor, requirementId, row);
  });
}
