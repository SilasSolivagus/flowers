import type { Db } from '../../db/client.js';
import { assertTrigger } from '../state-machine.js';
import { recordEvent } from '../events.js';
import { parseRequirementId, requirePlainObject } from '../validate.js';
import { assertCan } from '../auth/guard.js';
import { briefOf, lockRequirement, moveTo, type Locked, type Tx } from './lock.js';

/**
 * **立项**这一步本身：门 + 推进 + 事件，**在调用方的事务里**。
 *
 * 名字仍叫 `evaluate`（文件也叫这个），但做的事从 2026-11-10 起只有一个含义：
 * `收集 → 待设计`。那一天 owner 的第二次纠正把「生成评估材料」与「立项」拆开了——
 * **材料是产物，立项是决定**；把决定藏在产物里（attach 一份材料就顺带进待设计），
 * 用户就没有改主意的机会。所以：
 * - 生成 / 交回材料：`uemaster/attach.ts`，只落产物与 `uemaster.attached` 事件，
 *   状态一个字不动；
 * - 立项：本函数，trigger `approve`，带 `guard: 'brief'`（核心三问）。
 *
 * 函数名与文件名保持 `evaluate` 是一个**刻意的取舍**：它是 19 个用例文件与三处脚本
 * 的 import 名，改名只会让这一版多出 20 个文件的 diff，却不会让任何人少踩一次坑；
 * 真正的口径在 trigger（`approve`）、在界面动作名（`approve`，按钮写「立项」）与
 * 两个调用点（`app/actions.ts` 的 `approveAction`、MCP 的 `requirement_start_design`）。
 * 读这一行的人该记住的是「它做立项」，不是「它叫 evaluate」。
 *
 * 为什么它是一层、而不是直接写在 `evaluate()` 里：`evaluate()` 自己开事务（入参校验 +
 * 开事务 + 调本函数），而「锁行 + 门 + 迁移 + 事件」这四步在**一个事务**里才成立——
 * 门一响就不该有半条迁移，事件也不该与状态分家。把这段抽成函数，事务的边界由调用方
 * 决定，而语义只有一份。
 *
 * 2026-11-10 之前它还有第二个调用方（`uemaster/attach.ts` 在同一个事务里顺手推进
 * 「材料落地即立项」）。那次纠正之后它只剩一个调用方，而**这恰好是那一次纠正的目的**：
 * 状态的改变只能由一个明说的动作触发。这段注释留着那条历史，因为「为什么不用再担心
 * 材料与迁移的原子性」的答案就在它里面——两件事已经不在同一条路上了。
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
 * 这条迁移只有一个入口：**人点「立项」**（界面动作 `approve`）或 MCP 的
 * `requirement_start_design`，两者都落到 `evaluate()`。生成 / 交回材料不走这里
 * （`uemaster/attach.ts` 只落产物，见 2026-11-10 的第二次纠正）。
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
  // 待评审的需求点「立项」会骑着它跑回待设计、静默顶掉打回。必须钉 trigger
  // （`approve`；这个名字 2026-11-10 之前叫 `evaluate`）。
  //
  // ctx 传的是刚锁回来的那一行：`brief` 那道门要逐条点名缺哪几格，判据与那句话都在
  // `requirements/brief.ts`（状态机、生成前、读模型共用同一份）。
  // 类型仍然不传：Ruling 1 之后没有 `guard: 'type'`，传一个没人读的键会让下一个人
  // 以为类型还在判。
  assertTrigger(row.state, 'design', 'approve', { brief: briefOf(row) });
  await moveTo(tx, requirementId, 'design');
  await recordEvent(tx, {
    requirementId, actor, type: 'requirement.evaluated',
    payload: { from: row.state, to: 'design' },
  });
  return { state: 'design' as const };
}

/**
 * 立项：inbox → design。
 *
 * 锁行语义见 lock.ts：并发立项同一条需求时，后来者会等前者提交，再基于新状态
 * 重新判断，于是第二次会撞上 illegal_transition，而不是两个都通过。
 *
 * 它**不生成材料**（2026-11-10 起）：生成是 `uemaster/start.ts` 那条作业链，
 * 产物落在 `uemaster_artifacts`，状态一个字不动。两个动作分开的理由见文件头。
 */
export async function evaluate(db: Db, actor: string, raw: unknown) {
  // 入参先挡住：非对象会抛 TypeError，非 uuid 会让 PG 抛 22P02，两者都不是 AppError。
  const input = requirePlainObject(raw);
  const requirementId = parseRequirementId(input);

  return db.transaction(async (tx) => {
    // 权限先于状态门（P4-04）：先回答「这条需求是不是你能改的」，再回答「现在能不能
    // 立项」。反过来的话，一句「当前在「待评审」，不能执行这一步」就等于告诉一个
    // 旁观者这条需求现在停在哪个状态——状态本身不是秘密，但顺序决定了错误消息在
    // 权限之外还泄露多少东西。锁行之后判，读到的就是这一事务将要改的那一行。
    const row = await lockRequirement(tx, requirementId);
    await assertCan(tx, actor, {
      ownerMemberId: row.owner_member_id, ownerLine: row.owner_line, state: row.state,
    }, 'edit');
    return evaluateInTx(tx, actor, requirementId, row);
  });
}
