'use server';

import { revalidatePath } from 'next/cache';
import { db } from '../src/db/client';
import { AppError } from '../src/core/errors';
import type { DetailAction } from '../src/core/read/detail';
import { currentMember } from '../src/core/read/member';
import { evaluate } from '../src/core/requirements/evaluate';
import { submitReview } from '../src/core/requirements/submit-review';
import { reviewPass, reviewReject } from '../src/core/requirements/review';
import { schedule } from '../src/core/requirements/schedule';
import { bounce } from '../src/core/requirements/bounce';
import {
  rejectRequirement, restoreRequirement, shelveRequirement,
} from '../src/core/requirements/terminal';
import { attachFromForm } from './attach-form';

/**
 * 抽屉里那九个动作的服务端入口。
 *
 * D1：没有 REST 层——页面直接调领域服务，这里的每个函数只做三件事：从 FormData
 * 取字段、把 actor 从 cookie 里解出来、把 AppError 翻成一句给用户看的话。
 * 业务规则一条都不在这里（状态门、签字人、日期区间全在 `src/core` 里），
 * 否则界面和领域会各有一份「什么时候能做这一步」。
 */

/** 动作的返回值。界面只关心失败的那句话；成功之后页面本来就会变。 */
export type ActionResult = { ok: true } | { ok: false; message: string };

/** FormData 里的字段：缺失 / 非字符串都归一到空串，交给领域层报它自己的中文错误。 */
function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * 所有动作共用的外壳：取身份 → 调服务 → 失效看板 → 翻译错误。
 *
 * 为什么 AppError 之外要原样抛：
 * - AppError 是领域层写给用户看的（'提交评审必须填正式 PRD 链接'、'不是这条需求的
 *   评审人'），原样显示，一个字都不改写——改写就等于界面在替领域编造失败原因。
 * - 其它异常（TypeError、pg 的非 AppError 错误）是 bug，不是用户操作的结果。
 *   把它们压成一句「操作失败」会让界面看起来一切正常：错误信息在服务端日志里，
 *   而用户和排查的人只看到一句话术。这里让它们穿到 Next 的错误边界上（dev 里是
 *   覆盖层，生产里是 500），宁可吵，也不装作成功。
 *
 * revalidatePath 放在 finally 里，成功与失败都刷：
 * 失败**不等于**「什么都没改」。最常见的两种拒绝恰恰是「服务端已经和页面不一样了」——
 * `illegal_transition`（时钟把这条需求推进了，例如 test 自己上到 live）与
 * `not_found`（同事先把这一步做掉了）。只在成功路径上刷，抽屉会继续显示旧状态、继续
 * 提供已经不可能成功的按钮，用户每点一次都撞同一句话，只能手动刷新才能恢复。
 * 刷新不会抹掉失败原因：`useActionState` 的返回值在客户端，服务端重新渲染的只是
 * 六段与动作条，所以用户看着「为什么失败」的同时，按钮集合在下面跟着变对。
 */
async function run(call: (actor: string) => Promise<unknown>): Promise<ActionResult> {
  const actor = await currentMember();
  try {
    await call(actor);
    return { ok: true };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  } finally {
    revalidatePath('/');
  }
}

/**
 * 交回材料：抽屉「参考」段那三行右边的入口（人走的那条路，MCP 是另一条）。
 *
 * 「取字段 → 存文件 → attach」在 `app/attach-form.ts`（普通函数，不进 `'use server'`）：
 * 那个模块能被用例用真 FormData 跑一遍，而这里只留三件 Next 专有的东西——身份、
 * 失效、把 `AppError` 翻成一句话。
 */
export async function attachAction(formData: FormData): Promise<ActionResult> {
  const actor = await currentMember();
  try {
    await attachFromForm(db, actor, formData);
    return { ok: true };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  } finally {
    // 与 `run()` 同一条规矩：失败也刷。最常见的两种拒绝恰恰是「服务端已经和页面
    // 不一样了」（时钟推进了、同事先做了一步），不刷就会一直撞同一句话。
    revalidatePath('/');
  }
}

/** 评估：inbox → design。 */
export async function evaluateAction(formData: FormData): Promise<ActionResult> {
  const requirementId = field(formData, 'id');
  return run((actor) => evaluate(db, actor, { requirementId }));
}

/** 提交评审：design → review（从 inbox 提交等于跳过评估）。 */
export async function submitReviewAction(formData: FormData): Promise<ActionResult> {
  const requirementId = field(formData, 'id');
  const prdUrl = field(formData, 'prdUrl');
  return run((actor) => submitReview(db, actor, { requirementId, prdUrl }));
}

/** 评审判定：通过，review → queue。签字人必须是派单上的评审人（由服务自己拦）。 */
export async function reviewPassAction(formData: FormData): Promise<ActionResult> {
  const requirementId = field(formData, 'id');
  return run((actor) => reviewPass(db, actor, { requirementId }));
}

/** 评审判定：打回，review → design。原因必填。 */
export async function reviewRejectAction(formData: FormData): Promise<ActionResult> {
  const requirementId = field(formData, 'id');
  const reason = field(formData, 'reason');
  return run((actor) => reviewReject(db, actor, { requirementId, reason }));
}

/** 排期：queue → ready。版本、提测日、承诺完成日三个都必填。 */
export async function scheduleAction(formData: FormData): Promise<ActionResult> {
  const requirementId = field(formData, 'id');
  const releaseId = field(formData, 'releaseId');
  const commitTestAt = field(formData, 'commitTestAt');
  const commitDueAt = field(formData, 'commitDueAt');
  return run((actor) => schedule(db, actor, {
    requirementId, releaseId, commitTestAt, commitDueAt,
  }));
}

/** 打回：test → dev。原因 + 新的承诺完成日必填（不传 now，用真实时钟）。 */
export async function bounceAction(formData: FormData): Promise<ActionResult> {
  const requirementId = field(formData, 'id');
  const reason = field(formData, 'reason');
  const newCommitDueAt = field(formData, 'newCommitDueAt');
  return run((actor) => bounce(db, actor, { requirementId, reason, newCommitDueAt }));
}

/** 拒绝：inbox → rejected。原因必填。 */
export async function rejectAction(formData: FormData): Promise<ActionResult> {
  const requirementId = field(formData, 'id');
  const reason = field(formData, 'reason');
  return run((actor) => rejectRequirement(db, actor, { requirementId, reason }));
}

/** 搁置：任何非终态 → shelved。原因必填。 */
export async function shelveAction(formData: FormData): Promise<ActionResult> {
  const requirementId = field(formData, 'id');
  const reason = field(formData, 'reason');
  return run((actor) => shelveRequirement(db, actor, { requirementId, reason }));
}

/** 恢复：shelved → inbox。 */
export async function restoreAction(formData: FormData): Promise<ActionResult> {
  const requirementId = field(formData, 'id');
  return run((actor) => restoreRequirement(db, actor, { requirementId }));
}

/**
 * 动作名 → 服务端动作。键就是读模型的 `DetailAction`，两边的动作集合因此由
 * 类型系统钉住：读模型加了动作而这里没接，`Record` 会编译失败。
 */
const ACTIONS: Record<DetailAction, (formData: FormData) => Promise<ActionResult>> = {
  evaluate: evaluateAction,
  submitReview: submitReviewAction,
  reviewPass: reviewPassAction,
  reviewReject: reviewRejectAction,
  schedule: scheduleAction,
  bounce: bounceAction,
  reject: rejectAction,
  shelve: shelveAction,
  restore: restoreAction,
};

/**
 * 抽屉唯一的提交入口：动作名从表单的 `act` 字段来。
 *
 * 为什么不给每个动作各配一个 `useActionState`：九个 hook 只是为了拿到「哪一次失败
 * 的那句话」，而失败消息是抽屉里的一份状态，不该有九个来源。这里仍然是一个
 * `(formData) => Promise<ActionResult>`，九个具名动作照样单独可调、可测。
 */
export async function runAction(formData: FormData): Promise<ActionResult> {
  const name = field(formData, 'act');
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, name)) {
    return { ok: false, message: '未知动作' };
  }
  return ACTIONS[name as DetailAction](formData);
}
