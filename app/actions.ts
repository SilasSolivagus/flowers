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
import { jobStatus, startGeneration, type JobView } from '../src/core/uemaster/start';
import { testGenerator, TEST_TIMEOUT_MS } from '../src/core/uemaster/generator';
import { generatorCommand, saveGeneratorCommand, writeTest } from '../src/core/uemaster/settings';
import { testLabel, type GeneratorTest } from '../src/core/uemaster/candidates';
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

/**
 * 生成：参考段那一行右边的「生成」（P2.6）。
 *
 * 与其它动作不同，它**不快**：产物要由一个本机 agent CLI 跑几十秒到几分钟。所以
 * 这个动作只做两件事——开一次作业、把 `jobId` 交回客户端；结果由客户端用
 * `generationStatusAction` 轮询。请求不挂在那几分钟上，页面也不需要知道生成器的存在。
 *
 * 失败照旧原文返还：AppError 的中文（`这个阶段正在生成中…`、`需求不存在`）就是
 * 界面上那一行字，不改写、不吞。真正的生成器错误（OAuth 过期之类）不在这里出现——
 * 它们发生在后台，落在 `uemaster_jobs.error` 上，由轮询读到。
 */
export type StartGenerationResult = { ok: true; jobId: string } | { ok: false; message: string };

export async function generateAction(formData: FormData): Promise<StartGenerationResult> {
  const actor = await currentMember();
  try {
    const { jobId } = await startGeneration(db, actor, {
      requirementId: field(formData, 'requirementId'),
      stage: field(formData, 'stage'),
    });
    // 让服务端那一份抽屉也知道「这个阶段正在生成」：刷新 / 换个人打开时，
    // 那一行不该又变回一个可以再按一次的「生成」。
    revalidatePath('/');
    return { ok: true, jobId };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  }
}

/**
 * 轮询用的一次读取。查不到（作业被清掉、id 被改坏）返回 null，客户端据此停手。
 *
 * 它是一个 server action 而不是 REST 路由：这条链路只有抽屉一个消费者，
 * 而抽屉已经在用 server action 说同一种话（D1：没有 REST 层）。
 */
export async function generationStatusAction(jobId: string): Promise<JobView | null> {
  return jobStatus(db, jobId);
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

/**
 * 生成器设置（P2.7）：保存一条命令，以及就地测它一下。
 *
 * 两个动作都不碰 `src/core` 里的服务：保存走 `saveGeneratorCommand`（只拦空串与未填
 * 的占位符），测试走 `testGenerator`（真跑一次，10 秒，与真生成同一条命令契约）。
 * 这一层只做三件 Next 专有的事：从 FormData 取字段、把 AppError 翻成一句话、失效页面。
 *
 * 为什么保存**不要求**先测通：这条机器的现实是「装了 ≠ 能用」，而一个人可能先要把
 * 命令存下来、再慢慢调（模型名、代理、key）。要求「测通了才能存」会让他在设置页上
 * 无处可存。代价是那一行必须诚实：测过没通过、或者根本还没测，都要写出来。
 */
export async function saveGeneratorAction(formData: FormData): Promise<ActionResult> {
  try {
    await saveGeneratorCommand(db, field(formData, 'command'));
    return { ok: true };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  } finally {
    revalidatePath('/settings');
    revalidatePath('/');
  }
}

export type GeneratorTestResult = { ok: boolean; message: string };

/**
 * 跑一次小测、把结果落库、返回那一行的字。
 *
 * 落库而不只是返回给这一次点击：刷新之后那一行仍要显示「未通过测试」，否则一次刷新
 * 就把失败洗成了「未配置」。字的形状由 `testLabel` 拼（`通过 · 74B · 0.9s` /
 * `失败：<stderr>`），失败时**原文照登**——`OAuth session expired`、
 * `MISSING_CREDENTIAL: … DEEPSEEK_API_KEY` 这两句本身就是给 owner 的下一步。
 */
async function recordTest(command: string): Promise<GeneratorTestResult> {
  const result = await testGenerator(command, { timeoutMs: TEST_TIMEOUT_MS });
  const test: GeneratorTest = {
    ok: result.ok,
    command,
    at: new Date().toISOString(),
    size: result.ok ? result.size : null,
    ms: result.ms,
    error: result.ok ? null : result.error,
  };
  await writeTest(db, test);
  revalidatePath('/settings');
  revalidatePath('/');
  return { ok: test.ok, message: testLabel(test) };
}

/** 就地测**库里那条**（设置页那一行的「测试」）。 */
export async function testGeneratorAction(): Promise<GeneratorTestResult> {
  const command = await generatorCommand(db);
  if (command === null) return { ok: false, message: '未配置生成器命令' };
  return recordTest(command);
}

/**
 * 「测试并使用」：真跑一次小测 → 通了才存。**一个动作**，不是两个。
 *
 * 为什么合成一步：这是第一次用时的那个问题（「它能不能用」）与回答（「就用它」）。
 * 拆成「保存」和「测试」两个按钮，用户就会在其中一个上停下来——留下来的是
 * 一条没测过的命令，或者一次没保存的通过。
 *
 * 为什么**先测后存**（P2.8 的决定）：存了再测，失败时库里会留下一条已经生效的坏
 * 命令——那个对话框还开着，用户以为什么都没发生，可下一次按「生成」就会拿它去跑。
 * 「测试并使用」里的「使用」是条件句：通过了才使用。失败就什么都不改，对话框
 * 留着，换一个选项或改一行命令再按一次；失败的原文由对话框当场显示（不落库：
 * 库里那份测试结果是给设置页那一行看的，它跟着**存着的那条**命令走）。
 *
 * 空命令与未填的占位符在测之前就被 `testGenerator` 拦下（它自己会说清楚），
 * 所以这里不需要第二条校验路径。
 */
export async function applyGeneratorAction(formData: FormData): Promise<GeneratorTestResult> {
  const command = field(formData, 'command').trim();
  if (command === '') return { ok: false, message: '先填一条命令' };

  const result = await testGenerator(command, { timeoutMs: TEST_TIMEOUT_MS });
  if (!result.ok) return { ok: false, message: `失败：${result.error}` };

  try {
    await saveGeneratorCommand(db, command);
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  }

  const test: GeneratorTest = {
    ok: true,
    command,
    at: new Date().toISOString(),
    size: result.size,
    ms: result.ms,
    error: null,
  };
  await writeTest(db, test);
  revalidatePath('/settings');
  revalidatePath('/');
  return { ok: true, message: testLabel(test) };
}
