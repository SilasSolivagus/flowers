'use server';

import { sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '../src/db/client';
import { AppError } from '../src/core/errors';
import type { DetailAction } from '../src/core/read/detail';
import { currentMember, memberIdByName } from '../src/core/read/member';
import { assertCan, requirementFacts } from '../src/core/auth/guard';
import { evaluate } from '../src/core/requirements/evaluate';
import { submitReview } from '../src/core/requirements/submit-review';
import { reviewPass, reviewReject } from '../src/core/requirements/review';
import { schedule } from '../src/core/requirements/schedule';
import { reschedule } from '../src/core/requirements/reschedule';
import { reopenRequirement } from '../src/core/requirements/reopen';
import { bounce } from '../src/core/requirements/bounce';
import {
  rejectRequirement, restoreRequirement, shelveRequirement,
} from '../src/core/requirements/terminal';
import { rollbackRelease } from '../src/core/requirements/rollback';
import { jobStatus, startGeneration, type JobView } from '../src/core/uemaster/start';
import { cancelJob, retryJob } from '../src/core/uemaster/control';
import { credentialFor, testGenerator, TEST_TIMEOUT_MS } from '../src/core/uemaster/generator';
import { generatorCommand, saveGeneratorCommand, writeTest } from '../src/core/uemaster/settings';
import { testLabel, type GeneratorTest } from '../src/core/uemaster/candidates';
import {
  configOf, memberProviderParts, saveMemberProviderSettings,
} from '../src/core/uemaster/member-provider';
import { probeProvider, resolveProviderConfig } from '../src/core/uemaster/provider';
import { splitDescription, SPLIT_KEYS } from '../src/core/uemaster/intake';
import { DESCRIPTIVE_FIELDS } from '../src/core/requirements/fields';
import { createRequirement } from '../src/core/requirements/create';
import { reassignOwner } from '../src/core/requirements/assign';
import { claimRequirement } from '../src/core/requirements/claim';
import {
  bindWecomUserid, createMember, deactivateMember, lookupWecomAccount, resetPassword,
  saveMemberWebhook, saveNotifyChannels, testMemberWebhook, updateMember,
} from '../src/core/members/manage';
import { logout } from '../src/core/auth/login';
import {
  deleteRequirement, updateRequirement,
} from '../src/core/requirements/manage';
import {
  createRelease, deleteRelease, updateRelease,
} from '../src/core/releases/manage';
import { listRunningJobs, type JobProgress } from '../src/core/read/progress';
import {
  currentMemberRow, latestNoticeSeq, markRead, notifyView, type NotifyView,
} from '../src/core/read/notify';
import { exportQueue } from '../src/core/export/queue';
import { attachFromForm } from './attach-form';
import { changePassword } from './password-change';
import { transferOwnedRequirements } from './member-transfer';

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
    // 版本页也读同一批需求（版本里的行、甘特、延期数），动作改完之后它同样要重取。
    revalidatePath('/');
    revalidatePath('/releases');
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

/**
 * 停止一次正在跑的生成（2026-11-10）。
 *
 * 授权与 `generateAction` **同一条**：`currentMember()` 解出身份，服务层不做更细的门
 * （能按下生成的人，必须能把他自己按下去的那一次停掉；见 `control.ts` 文件头）。
 * 界面那一层另有一道 `can('edit')`：别人的需求只读，那行里根本没有这个按钮。
 *
 * 返回值三态而不是两态：`canceled: false` 是「你按晚了一步，它已经结束了」——那不是
 * 失败，不该弹一条错误。界面据此只刷新一次。
 */
export type StopGenerationResult =
  | { ok: true; canceled: boolean }
  | { ok: false; message: string };

export async function stopGenerationAction(jobId: string): Promise<StopGenerationResult> {
  await currentMember();
  try {
    const { canceled } = await cancelJob(db, jobId);
    // 停完要刷：那一行从「生成中」变回「生成」，右下角的进度卡也该少一条。
    revalidatePath('/');
    return { ok: true, canceled };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  }
}

/**
 * 重试：为同一条需求的同一个阶段**新开**一次（2026-11-10）。
 *
 * 旧行（失败 / 被停止的那一次）一行都不动：它是历史，带着自己那句原因。新的作业是
 * 另一个 id，走的是「按下生成」同一条服务（六问 / PRD / 生成器 / 防重一条不少）。
 *
 * 返回 `jobId`（与 `generateAction` 同一个形状）：界面换到新的那一行上继续轮询，
 * 而不是留着旧的失败提示。
 */
export async function retryGenerationAction(jobId: string): Promise<StartGenerationResult> {
  const actor = await currentMember();
  try {
    const result = await retryJob(db, actor, jobId);
    revalidatePath('/');
    return { ok: true, jobId: result.jobId };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  }
}

/**
 * 立项：inbox → design（2026-11-10 owner 的第二次纠正之后，这是**唯一**改这个状态的动作）。
 *
 * 名字叫 `approveAction`、动作名是 `approve`、按钮写「立项」，而它底下调的领域服务仍叫
 * `evaluate`（19 个用例文件与三处脚本 import 的那个名字）：改名只会让这一版多出二十个
 * 文件的 diff，不会让任何人少踩一次坑。真正的口径在 trigger（`approve`）与这道动作本身。
 *
 * **它不生成评估材料**：材料由「参考」段那一行的「生成」产出（`generateAction`），
 * 生成不改状态。两个动作分开的理由——材料是产物，立项是决定；把决定藏在产物里，
 * 用户就没有改主意的机会。
 */
export async function approveAction(formData: FormData): Promise<ActionResult> {
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

/** 改排期（2026-11-11）：不动状态，只改版本与两个承诺日；版本页「改进度」用。 */
export async function rescheduleAction(formData: FormData): Promise<ActionResult> {
  const requirementId = field(formData, 'id');
  const releaseId = field(formData, 'releaseId');
  const commitTestAt = field(formData, 'commitTestAt');
  const commitDueAt = field(formData, 'commitDueAt');
  return run((actor) => reschedule(db, actor, {
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

/** 退回待开发（2026-11-11）：dev → ready，原因必填。 */
export async function reopenAction(formData: FormData): Promise<ActionResult> {
  const requirementId = field(formData, 'id');
  const reason = field(formData, 'reason');
  return run((actor) => reopenRequirement(db, actor, { requirementId, reason }));
}

/** 搁置：任何非终态 → shelved。原因必填。 */
export async function shelveAction(formData: FormData): Promise<ActionResult> {
  const requirementId = field(formData, 'id');
  const reason = field(formData, 'reason');
  return run((actor) => shelveRequirement(db, actor, { requirementId, reason }));
}

/** 回滚：live → queue（2026-11-10）。发出去的东西有问题，退回去重排。 */
export async function rollbackAction(formData: FormData): Promise<ActionResult> {
  const requirementId = field(formData, 'id');
  const reason = field(formData, 'reason');
  return run((actor) => rollbackRelease(db, actor, { requirementId, reason }));
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
  approve: approveAction,
  submitReview: submitReviewAction,
  reviewPass: reviewPassAction,
  reviewReject: reviewRejectAction,
  schedule: scheduleAction,
  bounce: bounceAction,
  reject: rejectAction,
  shelve: shelveAction,
  restore: restoreAction,
  rollback: rollbackAction,
  reopen: reopenAction,
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
 * 这一次小测要补的凭据：**库里那把 key**（`provider.*` 三格，按当前成员的解析顺序）。
 *
 * 为什么在这里解析而不是让 `testGenerator` 自己读库：`generator.ts` 是一层不碰库的
 * 纯执行层（它与 MCP、worker 共用），凭据的来源属于「谁在用这条命令」。这一句就是
 * 那个「谁」——与真生成走的是同一个解析函数（`resolveProviderConfig(actor)`），
 * 所以设置页那一格的「通过」说的就是真生成会用的那把 key。
 *
 * 不把 key 带出这个函数：`credentialFor` 的返回值只交给 `testGenerator` 的 spawn。
 */
async function credentialForTest(command: string): Promise<ReturnType<typeof credentialFor>> {
  const config = await resolveProviderConfig(await currentMember());
  return credentialFor(command, config?.apiKey ?? null);
}

/**
 * 跑一次小测、把结果落库、返回那一行的字。
 *
 * 落库而不只是返回给这一次点击：刷新之后那一行仍要显示「未通过测试」，否则一次刷新
 * 就把失败洗成了「未配置」。字的形状由 `testLabel` 拼（`通过 · 74B · 0.9s` /
 * `失败：<stderr>`），失败时**原文照登**——`OAuth session expired`、
 * `MISSING_CREDENTIAL: … DEEPSEEK_API_KEY` 这两句本身就是给 owner 的下一步。
 */
async function recordTest(command: string): Promise<GeneratorTestResult> {
  const result = await testGenerator(command, {
    timeoutMs: TEST_TIMEOUT_MS,
    credential: await credentialForTest(command),
  });
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

  const result = await testGenerator(command, {
    timeoutMs: TEST_TIMEOUT_MS,
    credential: await credentialForTest(command),
  });
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

// ─── P2.12：我的模型 key（成员作用域的三格） ────────────────────────────────

/**
 * 「我的」那一行的两个动作：保存，与就地测一次。
 *
 * 身份只有一条来源：`currentMember()`（cookie 里的名字），再换成 `members.id`——
 * 键是 `member.<id>.provider.*`（见 member-provider.ts 的「三条硬规矩」）。这一层
 * 不接任何「谁的 key」参数：能改的永远只有自己那三格，所以也不存在越权的写法。
 *
 * 两个动作都不碰 `src/core` 里的领域服务（这一层只写 `app_settings`），也不记 key：
 * key 从 FormData 进来、进 `Authorization` 头、进库，别处没有它的名字。
 */
async function actingMemberId(): Promise<string> {
  const actor = await currentMember();
  const id = await memberIdByName(actor);
  if (id === null) throw new AppError('member_unknown', `当前成员「${actor}」不在名册上`);
  return id;
}

/**
 * 保存自己那三格。
 *
 * **key 留空 = 不改**。这是这一格唯一与别处不同的口径，理由是界面：key 输入框
 * 永远不预填（它不回显），所以「我只想改模型名」时那个框必然是空的——把空当成
 * 「清掉这条 key」，等于每次改模型都顺手删掉自己的 key。要清掉整份配置就清
 * 地址与模型（空串等于没设，三格不齐整层就作废，退回平台那一份）。
 */
export async function saveMemberKeyAction(formData: FormData): Promise<ActionResult> {
  try {
    const memberId = await actingMemberId();
    const apiKey = field(formData, 'key');
    await saveMemberProviderSettings(db, memberId, {
      baseUrl: field(formData, 'baseUrl'),
      model: field(formData, 'model'),
      ...(apiKey.trim() === '' ? {} : { apiKey }),
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  } finally {
    revalidatePath('/settings');
  }
}

export type MemberKeyTest = {
  ok: boolean;
  /** 那一行要显示的字：`通过 · 412ms · 21 tokens`，或服务端原文（已脱敏）。 */
  label: string;
  /** 这次通过是否同时把它存了下来（界面据此刷新、收起表单）。 */
  saved: boolean;
};

/**
 * 就地测一次，**测的是屏上这一份**：
 * - 表单开着 → 测那三格里填的（key 空着就沿用已存的那把，改模型不必重打 key）；
 * - 表单关着 → 测他自己存的那一份；
 * - 他自己一格都没有 → 测平台那一份（那时这一行显示「平台统一模型 · x」，
 *   「测试」问的就是那个 x 通不通）。
 *
 * **通过即存，失败什么都不改。** 这不是「测完再点保存」的两步，而是既有那条
 * 「测试并使用」（`applyGeneratorAction`）的同一条规矩：失败的配置不该先在库里
 * 生效、再去撞下一次生成。于是 owner 要的两个动作各自成立——填一个错的 key 按
 * 「测试」，错误原文进那一行、库里那份配置原封不动（那一行不会变成「已配置」）；
 * 填一个能用的按「测试」，通过、存下、刷新后那一行就是自己的模型。
 *
 * 15 秒超时（`PROBE_TIMEOUT_MS`）：10 秒会把冷的网关判成错，45 秒让人以为页面卡了。
 * 失败**原文照登**，只有 `complete()` 已经做过的那一次脱敏（key → ***）。
 */
export async function testMemberKeyAction(formData: FormData): Promise<MemberKeyTest> {
  const actor = await currentMember();
  const memberId = await memberIdByName(actor);
  if (memberId === null) return { ok: false, label: `当前成员「${actor}」不在名册上`, saved: false };

  const typed = {
    baseUrl: field(formData, 'baseUrl').trim(),
    model: field(formData, 'model').trim(),
    key: field(formData, 'key').trim(),
  };
  const fromForm = typed.baseUrl !== '' || typed.model !== '' || typed.key !== '';
  const parts = await memberProviderParts(db, memberId);

  // 表单里空着的那几格退回**已存**的那几格（而不是平台的）：一个人在补 key 的时候
  // 不该被要求把地址与模型再抄一遍。
  const cfg = fromForm
    ? configOf({
      baseUrl: typed.baseUrl || (parts.baseUrl ?? ''),
      apiKey: typed.key || (parts.apiKey ?? ''),
      model: typed.model || (parts.model ?? ''),
    })
    : await resolveProviderConfig(actor);

  const probe = await probeProvider(cfg ?? { baseUrl: '', apiKey: '', model: '' });

  if (!probe.ok) return { ok: false, label: probe.label, saved: false };
  if (!fromForm || cfg === null) return { ok: true, label: probe.label, saved: false };

  try {
    await saveMemberProviderSettings(db, memberId, {
      baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
    });
  } catch (error) {
    // 存不下去时**不要说「通过」**：那一行会显示通过，而库里其实没变。
    if (error instanceof AppError) return { ok: false, label: error.message, saved: false };
    throw error;
  }
  revalidatePath('/settings');
  return { ok: true, label: probe.label, saved: true };
}

// ─── P4-02：录入面（需求 / 版本的增删改） ─────────────────────────────────────

/**
 * 录入动作的返回值：成功时带上 id，让界面能立刻打开那一条（新建之后最想知道的是
 * 「我刚写的那几问长什么样」）；失败时只有一句中文原因，与其它动作同一个形状。
 */
export type EntryResult = { ok: true; id: string; warning?: string | null } | { ok: false; message: string };

/**
 * 录入动作共用的外壳：身份 → 服务 → 失效两页 → 翻译错误。
 *
 * 为什么与 `run()` 分开：`run()` 只刷看板（它服务的是抽屉里的九个动作），而录入会
 * 同时改变看板与版本页（新建/删掉一个版本会改看板的版本标签与排期下拉）。两页都刷，
 * 代价是一次 RSC 重算，换来的是「切到版本页看到的是新的」。
 *
 * 失败也刷（与 `run()` 同一条规矩）：最常见的拒绝是 `not_found`——同事刚把这条需求
 * 删了，而屏上还画着它。
 */
async function entry(
  call: (actor: string) => Promise<{ id: string; warning?: string | null }>,
): Promise<EntryResult> {
  const actor = await currentMember();
  try {
    const result = await call(actor);
    return { ok: true, id: result.id, warning: result.warning ?? null };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  } finally {
    revalidatePath('/');
    revalidatePath('/releases');
  }
}

/**
 * 新建需求（看板顶栏那个按钮）。
 *
 * 表单只**必须**填标题 / 类型 / 提出人，六问可空——校验一条都不在这一层，全部由
 * `createRequirement` 的 zod 说（缺字段时那句中文就是界面上那一行）。
 * `ownerMemberId` 是下拉框的值，空串（未指定负责人）交给服务层归一成 null。
 */
export async function createRequirementAction(formData: FormData): Promise<EntryResult> {
  const owner = field(formData, 'ownerMemberId').trim();
  return entry((actor) => createRequirement(db, actor, {
    title: field(formData, 'title'),
    // 类型（Ruling 1）：下拉里的「未指定」提交的是空串，服务层把它归一成 null
    // （`create.ts` 的 `toType`）。这里不做第二次判断——值域只有一个来源。
    type: field(formData, 'type'),
    // 来源（Ruling 3）：同上；`sourceNote` 只有选中「其他」时才在表单里存在，
    // 缺失时 `field` 给空串，服务层归一成 null。
    source: field(formData, 'source'),
    sourceNote: field(formData, 'sourceNote'),
    requester: field(formData, 'requester'),
    ownerMemberId: owner === '' ? null : owner,
    // 查重（2026-11-11）：网页上那个「确认不是重复」的勾，勾了才允许同名新建。
    allowDuplicate: field(formData, 'allowDuplicate') === '1',
    // 平台是**多值**（P4-08）：同名 checkbox 提交上来是几行，`getAll` 取全部。
    // 一个都没勾就是空数组 = 未标注（不是「没传」：表单永远会提交这一格的存在性）。
    platforms: formData.getAll('platforms').filter((v): v is string => typeof v === 'string'),
    // 优先级（P4-09）是单选：下拉里那个「未定」选项的值是空串，服务层把它当 null
    // （而不是一个认不出的键——见 create.ts 的枚举）。
    priority: field(formData, 'priority') === '' ? null : field(formData, 'priority'),
    context: field(formData, 'context'),
    problem: field(formData, 'problem'),
    outcome: field(formData, 'outcome'),
    surfaces: field(formData, 'surfaces'),
    edgeCases: field(formData, 'edgeCases'),
    outOfScope: field(formData, 'outOfScope'),
    // 备注（2026-11-10）：只去企微汇总表，不进生成链路。
    remark: field(formData, 'remark'),
  }));
}

/**
 * 改描述：标题 + 六问（抽屉「描述」段的「编辑」）。
 *
 * **不传** type / requester / ownerMemberId / prdUrl：录入面不碰它们，而服务层对
 * 前三个是「报错」而不是「忽略」（见 `manage.ts` 的 `FORBIDDEN`）。这一层因此也
 * 不能顺手把它们带上——那会把一次「改了个错字」变成一句 not_editable。
 */
export async function updateRequirementAction(formData: FormData): Promise<EntryResult> {
  return entry((actor) => updateRequirement(db, actor, {
    requirementId: field(formData, 'id'),
    title: field(formData, 'title'),
    // 多选 chips：一个都没勾 → `[]` → 「未标注」。这与「不改」不同，后者是字段缺席。
    platforms: formData.getAll('platforms').filter((v): v is string => typeof v === 'string'),
    // 优先级：`''` = 未定（清空）。与「不改」不同，后者是字段缺席。
    priority: field(formData, 'priority') === '' ? null : field(formData, 'priority'),
    context: field(formData, 'context'),
    problem: field(formData, 'problem'),
    outcome: field(formData, 'outcome'),
    surfaces: field(formData, 'surfaces'),
    edgeCases: field(formData, 'edgeCases'),
    outOfScope: field(formData, 'outOfScope'),
    // 备注（2026-11-10）：只去企微汇总表，不进生成链路。
    remark: field(formData, 'remark'),
  }));
}

/**
 * 「从原文拆六问」（P4-08）：**一次性工具**，不是保存路径上的一步。
 *
 * 三件事，全在这里：
 * 1. 取这条需求的标题（模型要知道它在拆什么）+ 人粘进来的旧描述；
 * 2. 用**当前这个人**的模型配置拆一次（`resolveProviderConfig(actor)`：env → 成员自己
 *    的三格 → 平台三格，与生成材料同一套解析）；
 * 3. 把六格与依据交回**表单**。这个动作不写库、不落产物、不发事件——保存是人的下一次
 *    点击（`updateRequirementAction`）。
 *
 * 为什么需要 `edit` 权限才让调：它是一次要花钱的模型调用，而"看得到这条需求的描述"
 * 不等于"能改它"。与保存同一个判据（`manage.ts` 的 `edit`），省得有人拿只读身份把
 * 一个部署的 key 用成一台免费翻译机。
 */
export type SplitFillResult = {
  ok: boolean;
  /** 六格的新值（camelCase，与表单字段同名）。失败时全空。 */
  filled: Record<string, string>;
  /** 回来是空的字段（原文没依据，或引文对不上原文）。 */
  missing: { key: string; label: string }[];
  /** 用了 / 拒了哪些原文片段（`←` / `⨯`），一行一条。 */
  notes: string[];
  /** 失败时那一句中文；成功时 null。 */
  message: string | null;
};

/** 六问的 camelCase 键 ↔ intake 的 snake_case 键（六问的定义只有一处：`fields.ts`）。 */
const SPLIT_TO_FORM: Record<string, string> = {
  context: 'context',
  problem: 'problem',
  outcome: 'outcome',
  surfaces: 'surfaces',
  edge_cases: 'edgeCases',
  out_of_scope: 'outOfScope',
};

const SPLIT_TO_SNAKE: Record<string, string> = Object.fromEntries(
  Object.entries(SPLIT_TO_FORM).map(([snake, camel]) => [camel, snake]),
);

const SPLIT_LABEL: Record<string, string> = Object.fromEntries(
  DESCRIPTIVE_FIELDS.map((field) => [field.key, field.label]),
);

/**
 * 注意（2026-11-11）：**表单上的入口已移除**（owner：「把这个去掉」）。
 * 这个动作与 `intake.splitDescription` 一起留着——它是一条被用例钉住的纯能力
 * （六问逐字核对、引文对不上就丢），要重新露出入口时不必从零写；但界面上已经没有
 * 任何按钮会调它。
 */
export async function splitDescriptionAction(formData: FormData): Promise<SplitFillResult> {
  const empty: SplitFillResult['filled'] = Object.fromEntries(
    Object.values(SPLIT_TO_FORM).map((camel) => [camel, '']),
  );
  try {
    const actor = await currentMember();
    const id = field(formData, 'id');
    const found = await db.execute<{ title: string }>(
      sql`select title from requirements where id = ${id} and deleted_at is null`);
    const row = found.rows[0];
    if (row === undefined) {
      return { ok: false, filled: empty, missing: [], notes: [], message: '需求不存在' };
    }
    await assertCan(db, actor, await requirementFacts(db, id), 'edit');

    const cfg = await resolveProviderConfig(actor);
    if (cfg === null) {
      return {
        ok: false,
        filled: empty,
        missing: [],
        notes: [],
        message: '未配置模型接口：拆分要问模型，先把「接口地址 + API Key + 模型名」配好',
      };
    }

    const result = await splitDescription(cfg, {
      title: row.title,
      description: field(formData, 'description'),
    });

    const filled: Record<string, string> = {};
    for (const snake of SPLIT_KEYS) {
      filled[SPLIT_TO_FORM[snake]!] = result[snake];
    }
    return {
      ok: true,
      filled,
      missing: result.missing.map((snake) => ({
        key: SPLIT_TO_FORM[snake]!,
        label: SPLIT_LABEL[SPLIT_TO_FORM[snake]!] ?? snake,
      })),
      notes: result.notes,
      message: null,
    };
  } catch (error) {
    if (error instanceof AppError) {
      return { ok: false, filled: empty, missing: [], notes: [], message: error.message };
    }
    throw error;
  }
}

/** 软删除一条需求（编辑框里的「删除」）。 */
export async function deleteRequirementAction(formData: FormData): Promise<ActionResult> {
  const result = await entry((actor) => deleteRequirement(db, actor, {
    requirementId: field(formData, 'id'),
  }));
  return result.ok ? { ok: true } : result;
}

/** 新建版本。重叠不拦，作为 `warning` 回给界面（那一行就地显示）。 */
export async function createReleaseAction(formData: FormData): Promise<EntryResult> {
  return entry((actor) => createRelease(db, actor, {
    name: field(formData, 'name'),
    windowStart: field(formData, 'windowStart'),
    releaseDate: field(formData, 'releaseDate'),
    goal: field(formData, 'goal'),
    note: field(formData, 'note'),
  }));
}

/** 改版本（版本页「编辑」）。 */
export async function updateReleaseAction(formData: FormData): Promise<EntryResult> {
  return entry((actor) => updateRelease(db, actor, {
    id: field(formData, 'id'),
    name: field(formData, 'name'),
    windowStart: field(formData, 'windowStart'),
    releaseDate: field(formData, 'releaseDate'),
    goal: field(formData, 'goal'),
    note: field(formData, 'note'),
  }));
}

/** 软删除一个版本（编辑框里的「删除」）。 */
export async function deleteReleaseAction(formData: FormData): Promise<ActionResult> {
  const result = await entry((actor) => deleteRelease(db, actor, {
    id: field(formData, 'id'),
  }));
  return result.ok ? { ok: true } : result;
}

/**
 * 进度卡的轮询口（P4-02）。
 *
 * 与 `generationStatusAction` 同一条理由：这条链路只有一个消费者（右下角那张卡），
 * 而它已经在用 server action 说同一种话（D1：没有 REST 层）。返回整份清单而不是
 * 单条作业：卡片要的是「现在在跑什么」，作业的增减是清单的变化。
 */
export async function runningJobsAction(): Promise<JobProgress[]> {
  return listRunningJobs();
}

/**
 * 站内通知的三个入口（P4-03）。
 *
 * 通知没有写路径：它由 `events` 派生（见 `src/core/read/notify.ts`）。这里只有
 * 「读一页」与「把水位线推到哪」两件事，所以没有 `ActionResult`，也没有中文错误——
 * 读失败就是读失败，一张通知列表不该有自己的错误话术。
 *
 * 轮询与首帧同源：`noticesAction` 返回的 `{ notices, unread }` 与布局首帧传给铃铛的
 * 是同一个函数（`notifyView`），所以「30 秒后数字变了、列表没变」这种事不可能发生。
 */
export async function noticesAction(): Promise<NotifyView> {
  const member = await currentMemberRow();
  if (member === null) return { notices: [], unread: 0 };
  return notifyView(db, member);
}

/**
 * 点开一条通知：水位线推到**那一行的 seq**（不是最新，也不是全部）。
 *
 * 返回值是推完之后重新读的一页：界面上那些「未读」的样式与红点都从它来，不必在
 * 客户端自己重算一遍（重算就会和服务端的口径分叉）。
 * 不 `revalidatePath`：这是一次本地已读，页面其余部分不受影响；下一次轮询/刷新
 * 会从库里重新读。省掉一次整页 RSC 往返，点击后的反馈也就没有延迟。
 */
export async function markReadAction(upToSeq: number): Promise<NotifyView> {
  const member = await currentMemberRow();
  if (member === null) return { notices: [], unread: 0 };
  await markRead(db, member, upToSeq);
  return notifyView(db, member);
}

/**
 * 全部已读：水位线推到**最新一条点到我的事件**，而不是当前这一页的最后一条。
 *
 * feed 有上限（30 条），用页尾当水位线会让「全部已读」之后红点仍然亮着——第 31 条
 * 只是没被渲染出来，它依然是未读的。
 */
export async function markAllReadAction(): Promise<NotifyView> {
  const member = await currentMemberRow();
  if (member === null) return { notices: [], unread: 0 };
  const latest = await latestNoticeSeq(db, member);
  if (latest !== null) await markRead(db, member, latest);
  return notifyView(db, member);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * P4-04：身份与成员的写入口
 *
 * 这四个（加上登录页里的 `loginAction`）是「谁能改谁」在**界面这一层**的全部入口。
 * 它们一律只做三件事：从 FormData 取字段、把 actor 交给服务层、把 AppError 翻成一句
 * 中文——规则一条都不在这里。特别是「谁能转交负责人」：`can('reassignOwner')` 只在
 * `src/core/auth/roles.ts` 里判一次，这里不复制它的分支。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 登出：清 cookie（`proxy.ts` 那一层下次就会把人送回登录页）。 */
export async function logoutAction(): Promise<void> {
  await logout();
  redirect('/login');
}

/**
 * 转交负责人（抽屉里的那一行「负责人」）。
 *
 * 与「改描述」分成两个动作是刻意的：改描述只碰标题与六问，归属是另一件事——它要
 * 通知到人（`requirement.owner_assigned` 事件），而且只有条线负责人/超管能做。
 */
export async function reassignOwnerAction(formData: FormData): Promise<ActionResult> {
  return run((actor) => reassignOwner(db, actor, {
    requirementId: field(formData, 'id'),
    ownerMemberId: field(formData, 'ownerMemberId'),
  }));
}

/**
 * 认领（P4-06）：抽屉「信息」段负责人那一行，当这条需求还没有负责人时出现。
 *
 * 「任何 PM 都能立项，立项即成为负责人」——所以这里不做任何角色判断：能不能认领由
 * `can('claim')` 在服务层回答，认领之后这条需求落到认领人的条线下。
 * 与 `reassignOwnerAction` 分成两个动作：认领只发生在无主的需求上，转交发生在有主之后。
 */
export async function claimAction(formData: FormData): Promise<ActionResult> {
  return run((actor) => claimRequirement(db, actor, {
    requirementId: field(formData, 'id'),
  }));
}

/** 建人（设置 · 成员）。返回初始密码一次——之后再也拿不到。 */
export async function createMemberAction(formData: FormData): Promise<
  { ok: true; id: string; password: string } | { ok: false; message: string }
> {
  const actor = await currentMember();
  try {
    const created = await createMember(db, actor, {
      name: field(formData, 'name'),
      // 登录名（P4-08）：建人时必须给，否则这个人建出来也登不进来。
      email: field(formData, 'email'),
      role: field(formData, 'role'),
      line: field(formData, 'line') === '' ? null : field(formData, 'line'),
      password: field(formData, 'password') === '' ? null : field(formData, 'password'),
    });
    revalidatePath('/settings');
    return { ok: true, id: created.member.id, password: created.password };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  }
}

/** 改人：角色 / 条线 / 启用状态。 */
export async function updateMemberAction(formData: FormData): Promise<ActionResult> {
  const actor = await currentMember();
  try {
    const activeField = field(formData, 'active');
    await updateMember(db, actor, {
      memberId: field(formData, 'memberId'),
      ...(field(formData, 'role') === '' ? {} : { role: field(formData, 'role') }),
      ...(field(formData, 'line') === ''
        ? {}
        : { line: field(formData, 'line') === 'none' ? null : field(formData, 'line') }),
      ...(activeField === '' ? {} : { active: activeField === 'true' }),
    });
    revalidatePath('/settings');
    return { ok: true };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  } finally {
    // 版本页也读同一批需求（版本里的行、甘特、延期数），动作改完之后它同样要重取。
    revalidatePath('/');
    revalidatePath('/releases');
  }
}

/** 停用（删除的软版本）。 */
export async function deactivateMemberAction(formData: FormData): Promise<ActionResult> {
  const actor = await currentMember();
  try {
    await deactivateMember(db, actor, { memberId: field(formData, 'memberId') });
    revalidatePath('/settings');
    return { ok: true };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  }
}

/** 重置密码：新密码只在这一次的返回值里出现。 */
export async function resetPasswordAction(formData: FormData): Promise<
  { ok: true; password: string } | { ok: false; message: string }
> {
  const actor = await currentMember();
  try {
    const result = await resetPassword(db, actor, { memberId: field(formData, 'memberId') });
    return { ok: true, password: result.password };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  }
}

/**
 * 自改密码（设置 · 我的）：旧密码 + 新密码 + 确认。
 *
 * 规则在 `app/password-change.ts`（旧密码验一次、两次一致、长度交给 `setPassword`）；
 * 这里只做那三件 Next 专有的事：取字段、把 `AppError` 翻成一句中文、失效设置页。
 * 成功不返回任何密码——本人刚输入的那个就在他手里，回显一次只是多一个能把它读走的地方。
 */
export async function changePasswordAction(formData: FormData): Promise<ActionResult> {
  const actor = await currentMember();
  try {
    await changePassword(db, actor, {
      oldPassword: field(formData, 'oldPassword'),
      newPassword: field(formData, 'newPassword'),
      confirm: field(formData, 'confirm'),
    });
    revalidatePath('/settings');
    return { ok: true };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  }
}

/**
 * 转交一个成员名下的全部需求（设置 · 成员，停用被挡住之后的那一步）。
 *
 * 一条条调 `reassignOwner`：权限、本线约束、事件全部由那个服务回答，这里不复制。
 * 失败时把服务那句中文原样带回；成功时 `moved` 只是让界面能收起那一行。
 */
export async function transferOwnedAction(formData: FormData): Promise<
  { ok: true; moved: number } | { ok: false; message: string }
> {
  const actor = await currentMember();
  try {
    const result = await transferOwnedRequirements(db, actor, {
      fromMemberId: field(formData, 'fromMemberId'),
      toMemberId: field(formData, 'toMemberId'),
    });
    return { ok: true, moved: result.moved };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  } finally {
    revalidatePath('/settings');
    revalidatePath('/');
  }
}

/**
 * 通知频道档位（设置 · 我）。自己改自己；超管可以替别人改。
 *
 * 一次提交一格（`channel` + `level`）：设置页是两个独立的行，一行一个分段控件。
 * 校验在 `saveNotifyChannels` 里（三档之外的值在那里被拒），这一层只搬字段。
 */
export async function saveNotifyChannelAction(formData: FormData): Promise<ActionResult> {
  const actor = await currentMember();
  const channel = field(formData, 'channel');
  try {
    await saveNotifyChannels(db, actor, {
      memberId: field(formData, 'memberId') === '' ? null : field(formData, 'memberId'),
      [channel]: field(formData, 'level'),
    });
    revalidatePath('/settings');
    return { ok: true };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  }
}

/**
 * 「查一下」：把这个人的名字对到企微通讯录（设置 · 我那一行）。
 *
 * 返回的是**匹配到的那个显示名**或失败原因：用户点这个按钮要的答案是「到底对上了
 * 谁」——只回一个「成功」等于什么都没说。企微那边名字带部门前缀
 * （`产品经理-吕品`），所以显示名里出现前缀是正常的，不是错误。
 *
 * 失败不 revalidate：库里没有任何变化（只有 `wecom_lookup_at` 落了时刻），
 * 失败原因由这一句返回给按钮显示。
 */
export async function lookupWecomAction(): Promise<
  { ok: true; name: string; userid: string; cached: boolean } | { ok: false; message: string }
> {
  const actor = await currentMember();
  const result = await lookupWecomAccount(db, actor, {});
  if (result.ok) {
    revalidatePath('/settings');
    // `userid` 一起回去（2026-11-10）：按钮的新用途是**填空**——按名字查到的人，
    // 把它的 userid 填进「绑定企微」那个输入框，再按「验证」走同一条本人绑定的路。
    // 它不是秘密（就是这个人自己的账号），与「不回显 webhook」是两件事。
    return { ok: true, name: result.name, userid: result.userid, cached: result.cached };
  }
  return { ok: false, message: result.message };
}

/**
 * 「绑定企微」的验证（2026-11-10，设置 · 我的）。
 *
 * 一个动作做三件事：贴了 userid 就**真去通讯录查一次**（查不到不落库，只把「试过」
 * 记下来，界面因此显示「验证失败」）；传空串 = 解绑；成功才写 `wecom_userid`。
 * 权限与落库都在 `bindWecomUserid`（自己改自己；超管可以替别人改，与通知档位同一条口径）。
 */
export async function bindWecomAction(formData: FormData): Promise<
  { ok: true; userid: string; name: string; cleared: boolean } | { ok: false; message: string }
> {
  const actor = await currentMember();
  try {
    const result = await bindWecomUserid(db, actor, {
      memberId: field(formData, 'memberId') === '' ? null : field(formData, 'memberId'),
      userid: field(formData, 'userid'),
    });
    if (!result.ok) return result;
    revalidatePath('/settings');
    return result;
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  }
}

/**
 * 存/清「我自己的机器人」（2026-11-10）。
 *
 * 返回值里只有**掩码**（`saveMemberWebhook` 保证）：整串 webhook 等于一个能往群里发
 * 消息的凭证，进一次响应体就多一个能把它抄走的地方。空串 = 清掉，回到共用机器人。
 */
export async function saveWebhookAction(formData: FormData): Promise<
  { ok: true; masked: string | null; cleared: boolean } | { ok: false; message: string }
> {
  const actor = await currentMember();
  try {
    const result = await saveMemberWebhook(db, actor, {
      memberId: field(formData, 'memberId') === '' ? null : field(formData, 'memberId'),
      webhook: field(formData, 'webhook'),
    });
    if (!result.ok) return result;
    revalidatePath('/settings');
    return result;
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  }
}

/**
 * 「测试」那一条 webhook（2026-11-10）：**真的发一条**，不发不知道通不通。
 *
 * 测的是**框里那一条**（用户可能刚粘进来、还没保存），没传才测库里那条——测库里那条
 * 等于替他确认了一个他没在看的地址。不 revalidate：测试不改库，除非用户接着按保存。
 */
export async function testWebhookAction(formData: FormData): Promise<
  { ok: true; message: string } | { ok: false; message: string }
> {
  const actor = await currentMember();
  try {
    return await testMemberWebhook(db, actor, {
      memberId: field(formData, 'memberId') === '' ? null : field(formData, 'memberId'),
      webhook: field(formData, 'webhook'),
    });
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  }
}

/**
 * 导出：看板「待排期」列头那个入口（P1b）。
 *
 * **权限：登录即可。** 这里没有 `can(...)`，不是漏了——导出的是这个人打开看板就能
 * 看到的同一批行（待排期那一列），没有任何一条比看板更细的数据。真正的门是
 * `currentMember()`：它会抛 `no_member` / 会话过期，也就是「这个人现在根本没登录」。
 * 造一个 `export` 能力只会多一条永远为真的判断，还会让人以为这里挡着什么。
 *
 * 返回**比 `ActionResult` 多两个字段**：成功时要把链接与行数带回去（界面要显示
 * 「已生成」+ 那个链接），失败时要把 `code` 带回去（`no_rows` 与「企微未授权」
 * 在界面上的处理不一样）。所以不用 `run()` 那个只回 `{ok:true}` 的外壳。
 *
 * 不 revalidate：导出不改任何一条需求，看板不需要重画。失败照旧不吞——
 * `exportQueue` 的 message 是中文且带原始原因，原样交给按钮。
 */
export type ExportQueueResult =
  | { ok: true; url: string; rows: number; docid: string }
  | { ok: false; code: string; message: string };

export async function exportQueueAction(): Promise<ExportQueueResult> {
  // 这一句就是权限：没有会话 / 没有任何成员时它会抛 AppError，页面因此不会导出
  // 一份「没人认领」的表。
  await currentMember();
  const outcome = await exportQueue({ database: db });
  if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };
  return { ok: true, url: outcome.url, rows: outcome.rows, docid: outcome.docid };
}
