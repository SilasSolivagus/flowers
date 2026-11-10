'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GeneratorView } from '../../src/core/uemaster/candidates';
import type { DetailRef } from '../../src/core/read/detail';
import type { State } from '../../src/core/state-machine';
import { attemptLine, classifyFailure, type AttemptView, type Failure } from '../../src/core/uemaster/trace';
import {
  generateAction, generationStatusAction, retryGenerationAction, stopGenerationAction,
} from '../actions';
import { GeneratorDialog } from './GeneratorDialog';
import { RunningRow, runningRowOf, type RunningRowProps } from './RunningRow';
import { Toast } from './Toast';

/**
 * 参考段那一行右边的「生成」：按下 → 服务端开一次作业 → 这一行变「生成中」→
 * 变成产物链接，或者一行中文失败原因。
 *
 * 生成器在这条链路上只出现一次，就是**第一次**（P2.8）：
 * - `ready`（配过了 / env）：直接跑，不弹任何东西——story map 第 4 行。
 * - `choose`（还没配）：在原地弹那个小对话框（一个下拉 + 测试并使用）。
 *   测通就存下并**接着开跑**（一次点击的意图）；测不通，对话框留着，换一个再按。
 *   存过之后，这一支再也不会走到——story map 第 2、3 行。
 * - `none`（一个可执行文件都没有）：按钮禁用，一句原因 + 去设置那一格。
 *
 * 三条从 P2.6 留下来的取舍（第 1 条 2026-11-10 修订）：
 * 1. **没有进度条、没有 spinner**——但**有字**。原来这一格只有两个字「生成中」，而一次
 *    生成 2–5 分钟，那两个字不随时间变，读者只能判断它卡死了。现在它在跑的时候显示
 *    「正在按六问拆流程 · 00:47」(+「第 2 次尝试」)：三件事都来自库里已经有的东西
 *    （`uemaster_job_attempts.phase` / `attempt` 与作业的 `created_at`），没有一个
 *    是编出来的进度百分数。见 `RunningRow.tsx`。
 * 2. **错误就在行里**，由服务端作业的 `error` 原文加前缀「生成失败：」组成。
 *    `OAuth session expired` 是合法且有用的句子；「生成失败」四个字什么也没说。
 * 3. **刷新之后状态还在**。初始的 `generation` 由服务端读模型给出（正在跑的作业），
 *    所以刷新页面、换一个人打开同一条需求，看到的都是「生成中」。
 *
 * P2.13 起失败多两件东西，各管一件事：
 * - 行里那句仍是**留档**：`生成失败：<原文>`，一个字不改写；
 * - 行下多一个「详情」，列出这一次作业的每一次尝试（`第 1 次 · flow · 2 个节点 1 条连线被拒`），
 *   数据来自 `uemaster_job_attempts`——原来只有最后那句能活下来，前几次的理由全蒸发了；
 * - 外加一个 6 秒的浮层：点完去看别处的人回来时，行还在，但他没看见那一声。
 * 三者只在**失败**时出现；成功的作业一条尝试记录也会写库，只是界面不显示（无噪音）。
 *
 * 2026-11-10 起这一格多了三件事，各修事故里的一句话：
 * - **停止**：在跑时旁边多一个按钮。事故里最疼的是「no way to stop」——一条 pid 已经
 *   不在的作业转了 90 分钟，谁都停不下来。现在它先改库（canceled + 「已手动停止」）
 *   再杀 worker 进程组，行是真相（`control.ts` 解释为什么是这个顺序）。
 * - **重试**：失败 / 被停止的那一行给出新的一次（新作业 id，旧行留作历史）。
 *   它与「生成」走同一条服务，六问与生成器的判断一条都不少。
 * - **六问没填时按钮禁用 + 一句理由**：这是 owner 的裁定（`uemaster/gate.ts`）。
 *   那句话由读模型发下来，与 `startGeneration` 抛出的错误原文**逐字相同**——
 *   界面只负责画，不自己拼一句「还差什么」。
 */

/**
 * 轮询间隔：够快看到结果，又不至于把 server action 当日志刷。
 *
 * 2026-11-10 从 1500 调到 2000：这一格现在多了一格「现在在哪一步」，而秒数是**本地**
 * 跳的（`elapsed` 每秒自己算），所以「新到一步」这件事 2 秒的延迟看不出来；把轮询压到
 * 2 秒以内只是让一个 server action 当日志刷。**不要低于 2000**。
 */
const POLL_MS = 2000;

/** 客户端等不到结果的上限。服务端的硬超时是 10 分钟，这里多留一分钟。 */
const GIVE_UP_MS = 11 * 60 * 1000;

export function GenerateButton({
  requirementId, stage, state, generation, generator, present, fresh, versions, needsDescription,
}: {
  requirementId: string;
  stage: string;
  /**
   * 这条需求现在在哪个状态（2026-11-10 的 v1 阶段门要它）。
   *
   * 只用来决定「去补」那个链接画不画，**不用来判断能不能生成**：能不能生成由
   * `needsDescription` 一句话回答（服务端两道门合成的），这里再判一次就会有两份判据。
   * 理由：六问没填是能在原地补的（同一个页面的 `?edit=1`），而阶段门不是——那条需求
   * 已经过了收集，补描述要新建一条或先把它退回，给它一个编辑表单的链接就是指向一条
   * 做不成事的路（那句话本身已经把两条出路说清了）。
   */
  state: State;
  /**
   * 这个阶段**正在跑**的那次作业（服务端读模型给的，`null` = 没有）。
   *
   * 比原来那个 `runningJobId: string | null` 多了三格（`startedAt` / `phase` /
   * `attempt`）：刷新页面、换一个人打开同一条需求，第一帧就该看见「在第几步、跑了
   * 多久」——只给 id 的话第一帧仍然只有「生成中」，而那正是这次要修掉的观感。
   */
  generation: DetailRef['generation'];
  generator: GeneratorView;
  /**
   * 这一阶段已经有一份产物（P4-02）。
   *
   * 它只改**按钮上的字**（`生成` → `重新生成`）与鼠标悬停时那一句警告，不改行为：
   * 重新生成**永远允许**（owner 的裁决）。生成是一次可能的覆盖，但「有一份旧的、
   * 我想再做一份」是常态——把它拦下来只会逼人去删产物。
   *
   * `fresh` 只用于那句警告的措辞：当前版本已有一份（`fresh`）与旧版本还在（`stale`）
   * 是两件不同的事，但两者的后果一样「会再存一版」，所以都不拦。
   */
  present: boolean;
  fresh: boolean;
  /**
   * 这个阶段已经存过几版（0 = 没有产物）。
   *
   * 有它才能回答「我在覆盖第几版」——一个数字，不是一句说明：界面上那格是
   * 抽屉里的「第 N 版」pill，悬停那句警告里也带同一个数字。
   */
  versions: number;
  /**
   * 这一行现在**不能**生成的理由；`null` = 可以。两道门共用这一句（2026-11-10）：
   * v1 阶段门（不在「收集」就不生成评估材料）与六问门（三问没填完）。
   *
   * 由读模型给（`DetailRef.needsDescription`），与 `startGeneration` 抛出的错误原文
   * 是同一个字符串——界面不自己拼一句「还差什么」，否则它会与服务的判断分叉。
   */
  needsDescription: string | null;
}) {
  const router = useRouter();
  const [jobId, setJobId] = useState<string | null>(generation?.id ?? null);
  /**
   * 抽屉里那一行现在要画的东西（`RunningRow`）。`null` = 没有在跑的作业。
   *
   * 它是**状态**而不是从 `jobId` 推导：轮询每 2 秒回来一次「现在在哪一步」，那一格
   * 变了这一行就得跟着变；`jobId` 只说明「还有作业在跑」。
   */
  const [row, setRow] = useState<RunningRowProps | null>(runningRowOf(generation === null
    ? null
    : {
      status: 'running',
      phase: generation.phase,
      attempt: generation.attempt,
      startedAt: generation.startedAt,
    }));
  /** 秒表：每秒自增一次，只为让「已用时」重新算（没有它 React 不会重渲染）。 */
  const [, setBeat] = useState(0);
  /**
   * 这一行的结局：失败 / 被停止。`null` = 没有结局（在跑，或从没跑过）。
   *
   * 为什么用带 `kind` 的联合而不是一个 `error: string`：这两件事在界面上是两句不同的话
   * （「生成失败：…」/「已手动停止」），在库里也是两个状态（`failed` / `canceled`）。
   * 压成一个字符串就必然要在某处用「内容里有没有『已手动停止』」来反推种类——那种
   * 反推是下一次改文案时静默失效的东西。
   */
  const [outcome, setOutcome] = useState<{ kind: 'failed' | 'canceled'; message: string } | null>(null);
  /** 停止请求在飞：按钮禁用，避免连点两次（第二次会得到「已经结束了」）。 */
  const [stopping, setStopping] = useState(false);
  /**
   * 最近一次作业的 id（停止 / 重试要它）。
   *
   * 用 ref 而不是 state：轮询里每 2 秒写一次的东西不该触发重渲染；而两个动作只需要
   * 「按下那一刻最新的那个值」。
   */
  const lastJobId = useRef<string | null>(generation?.id ?? null);
  /**
   * 这一次失败的那条作业的尝试清单（P2.13）。只在失败时非空：成功的作业不显示任何东西，
   * 但库里照样有它的行（诊断要用）。
   */
  const [attempts, setAttempts] = useState<AttemptView[]>([]);
  /** 浮层：`seq` 让「又失败了一次」重新计时，而不是沿用上一次那 6 秒。 */
  const [toast, setToast] = useState<{ seq: number; failure: Failure } | null>(null);
  const [pending, setPending] = useState(false);
  /**
   * 这一帧的时刻。**每渲染一次就取一次**（不写进 state）：秒表的 interval 只负责触发
   * 重渲染，秒数本身每次重渲染重新算——两处都不需要假时钟。
   */
  const now = Date.now();
  /** 第一次用时的那个对话框：只在「还没配」时开，而且只开一次（答完就落库）。 */
  const [asking, setAsking] = useState(false);
  /** 这一次轮询的截止时刻：作业可以被杀掉，客户端不能陪着一起永远转。 */
  const deadline = useRef<number>(0);

  /**
   * 秒表（2026-11-10）：只在有作业在跑时走。1 秒一格——「它还在动」这件事只能靠秒针说，
   * 而秒数不能在轮询那一格（2 秒一次）里等，否则秒针会跟着网络抖。
   *
   * 依赖写的是 `row === null` 那个**布尔**，不是 `row` 本身：写成 `row` 的话每 2 秒
   * 轮询回来一次都会把 interval 拆了重建，秒针于是被轮询节奏带着抖——而那正好是这一格
   * 要证明「没在抖」的东西。
   */
  useEffect(() => {
    if (row === null) return undefined;
    const beat = setInterval(() => setBeat((n) => n + 1), 1000);
    return () => clearInterval(beat);
  }, [row === null]);

  useEffect(() => {
    if (jobId === null) return undefined;
    if (deadline.current === 0) deadline.current = Date.now() + GIVE_UP_MS;

    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async (): Promise<void> => {
      if (!alive) return;
      if (Date.now() > deadline.current) {
        deadline.current = 0;
        setJobId(null);
        const message = '生成没有回报（后台进程可能已退出）';
        setOutcome({ kind: 'failed', message });
        setToast((was) => ({ seq: (was?.seq ?? 0) + 1, failure: classifyFailure(message) }));
        return;
      }

      const status = await generationStatusAction(jobId);
      if (!alive) return;

      if (status === null) {
        // 作业不见了（库被重置 / id 被改坏）：停手，把控制权还给按钮。
        deadline.current = 0;
        setJobId(null);
        setRow(null);
        return;
      }
      if (status.status === 'done') {
        deadline.current = 0;
        setJobId(null);
        // 那一行消失，材料那一行接着出现（产物链接来自服务端渲染，见下面 `router.refresh`）。
        setRow(null);
        // 让服务端重新渲染这一行：产物链接、日期、时间轴上的新事件都从库里来。
        router.refresh();
        return;
      }
      if (status.status === 'failed' || status.status === 'canceled') {
        deadline.current = 0;
        setJobId(null);
        setRow(null);
        /**
         * 服务端把这条作业收成了什么，界面就说那句话（2026-11-10）。
         *
         * `canceled` 也走这一支：它和失败一样是**结束**，所以那一行必须落回按钮；
         * 但话不一样（「已手动停止」），所以带着 `kind` 下去。孤儿回收（死 pid）走的
         * 就是这一支：下一次轮询（≤2 秒）回来时 `status` 已经是 failed，用户看到的
         * 是「生成失败：生成进程已退出（服务已重启或被终止），本次没有产出；可以
         * 直接重试」+ 一个「重试」——而不是一个永远在跳的秒表。
         */
        const canceled = status.status === 'canceled';
        const message = status.error ?? (canceled ? '已手动停止' : '未知原因');
        setOutcome({ kind: canceled ? 'canceled' : 'failed', message });
        // 详情与浮层同源：都是这条作业的尝试清单 / 那句原文的分类。分类只决定浮层
        // 说哪句人话，行里那句始终是原文。
        setAttempts(status.attempts);
        setToast((was) => ({ seq: (was?.seq ?? 0) + 1, failure: classifyFailure(message) }));
        return;
      }
      /**
       * 还在跑：把这一步写回那一行（`runningRowOf` 是唯一的判据——它给 null 就说明
       * 这次不该再画那一行）。`startedAt` 用服务端给的，不用本地时钟：刷新之后秒表
       * 接着数，而不是从头数。
       */
      setRow(runningRowOf({
        status: status.status,
        phase: status.phase ?? null,
        attempt: status.attempt,
        startedAt: status.createdAt,
      }));
      timer = setTimeout(() => void tick(), POLL_MS);
    };

    timer = setTimeout(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [jobId, router]);

  const closeToast = useCallback(() => setToast(null), []);

  const start = async (): Promise<void> => {
    setPending(true);
    setOutcome(null);
    setAttempts([]);
    try {
      const form = new FormData();
      form.set('requirementId', requirementId);
      form.set('stage', stage);
      const result = await generateAction(form);
      if (!result.ok) {
        // 服务端说「还没选 / 没有生成器」时，界面状态已经过期（另一个标签页刚改过
        // 设置）：刷新一次让服务端把新的解析结果送上来。
        if (/生成器/.test(result.message)) router.refresh();
        setOutcome({ kind: 'failed', message: result.message });
        // 连作业都没开成（没生成器 / 正在生成中）：这也是一次终端失败，同样要那一声。
        setToast((was) => ({ seq: (was?.seq ?? 0) + 1, failure: classifyFailure(result.message) }));
        return;
      }
      deadline.current = Date.now() + GIVE_UP_MS;
      lastJobId.current = result.jobId;
      setJobId(result.jobId);
      // 按下之后立刻点亮那一行：模型还没回话，所以 phase 是 null → 「正在读 PRD」。
      setRow(runningRowOf({
        status: 'running', phase: null, attempt: 0, startedAt: new Date().toISOString(),
      }));
    } catch {
      setOutcome({ kind: 'failed', message: '生成请求没有送达' });
      setToast((was) => ({ seq: (was?.seq ?? 0) + 1, failure: classifyFailure('生成请求没有送达') }));
    } finally {
      setPending(false);
    }
  };

  /**
   * 停止（2026-11-10）。服务端先改库、再杀 worker 进程组；这里只负责把界面带到
   * 「已手动停止 · 重试」那一帧，并停掉轮询（那条作业已经不会再变了）。
   *
   * `canceled: false` = 按晚了一步（它刚好自己结束了）：不当错误处理，刷新一次让
   * 服务端那一帧说了算——用户会看到产物链接或那句真实的失败原因。
   */
  const stop = async (): Promise<void> => {
    const id = lastJobId.current;
    if (id === null) return;
    setStopping(true);
    try {
      const result = await stopGenerationAction(id);
      if (!result.ok) {
        setOutcome({ kind: 'failed', message: result.message });
        return;
      }
      // 无论「真的停掉了」还是「已经结束了」，轮询都该停手：这两个结局都是终态。
      deadline.current = 0;
      setJobId(null);
      setRow(null);
      if (result.canceled) setOutcome({ kind: 'canceled', message: '已手动停止' });
      // 材料那一行（产物链接 / 「还没生成」）由服务端重新渲染。
      router.refresh();
    } catch {
      setOutcome({ kind: 'failed', message: '停止请求没有送达' });
    } finally {
      setStopping(false);
    }
  };

  /**
   * 重试（2026-11-10）：为同一个需求的同一个阶段新开一次。
   *
   * 走 `retryGenerationAction(oldJobId)` 而不是 `generateAction`：服务端从**库里**取
   * 需求与阶段（界面只交一个作业 id），并且走的是「按下生成」同一条服务——六问、
   * PRD、生成器、防重一条不少。旧的那一行一行都不动，它是历史。
   *
   * 没有旧 id（从没跑过、或服务端渲染那一帧就没作业）时退回 `start()`：同一个意图。
   */
  const retry = async (): Promise<void> => {
    const id = lastJobId.current;
    if (id === null) {
      await start();
      return;
    }
    setPending(true);
    setOutcome(null);
    setAttempts([]);
    try {
      const result = await retryGenerationAction(id);
      if (!result.ok) {
        setOutcome({ kind: 'failed', message: result.message });
        setToast((was) => ({ seq: (was?.seq ?? 0) + 1, failure: classifyFailure(result.message) }));
        return;
      }
      deadline.current = Date.now() + GIVE_UP_MS;
      lastJobId.current = result.jobId;
      setJobId(result.jobId);
      setRow(runningRowOf({
        status: 'running', phase: null, attempt: 0, startedAt: new Date().toISOString(),
      }));
    } catch {
      setOutcome({ kind: 'failed', message: '重试请求没有送达' });
    } finally {
      setPending(false);
    }
  };

  // 有作业在跑：这一格就是那一行（步 + 秒表 + 第几次）+ 一个「停止」。
  // 作业一结束 `row` 变 null，这里落回下面的「生成 / 重试」按钮，材料那一行由服务端刷新。
  //
  // 为什么停止按钮在这一格、而不是等失败之后：事故里「no way to stop」说的就是这个
  // 位置——用户盯着那一行 90 分钟，旁边一个能按的东西都没有。
  if (row !== null) {
    return (
      <span className="gen-run">
        <RunningRow view={row} now={now} />
        <button
          className="btn gen stop"
          type="button"
          onClick={() => void stop()}
          disabled={stopping}
          title="停止这次生成（会杀掉后台进程，这一次的产出作废）"
        >
          停止
        </button>
      </span>
    );
  }

  /**
   * 六问没填：按钮禁用 + 理由（2026-11-10 owner 的裁定）。
   *
   * 三件事缺一不可：**看得见**（不是点了才被拒）、**说清缺哪几条**（那句话由服务端发
   * 下来，与 `startGeneration` 抛出的错误原文逐字相同）、**给出路**（一个直接进
   * 「编辑」的链接——抽屉里那张六问表单就在同一个页面的 `?edit=1` 后面）。
   * 为什么不禁用之后什么都不说：一个灰掉的按钮等于「这里有个能做的事，但我不告诉你为什么」。
   */
  if (needsDescription !== null) {
    return (
      <span className="gen-off">
        <span className="gerr" title={needsDescription}>{needsDescription}</span>
        {/* 「去补」只在收集阶段出现（见 `state` 的注释）：那才是六问能原地补的那个阶段；
            阶段门的出路（新建一条 / 退回收集）已经写在理由那句话里了。 */}
        {state === 'inbox' && (
          <Link className="gen-link" href={`/?open=${requirementId}&edit=1`}>去补</Link>
        )}
        <button className="btn gen" type="button" disabled title={needsDescription}>
          {outcome !== null ? '重试' : '生成'}
        </button>
      </span>
    );
  }

  // 一个可执行文件都没有：按钮禁用，理由在行里，指路就在旁边（设置页那一格）。
  if (generator.state === 'none') {
    return (
      <span className="gen-off">
        <span className="gerr">
          未检测到生成器 · <Link className="gen-link" href="/settings?tab=project">设置</Link>
        </span>
        <button className="btn gen" type="button" disabled>生成</button>
      </span>
    );
  }

  return (
    <>
      {outcome !== null && (
        <>
          {/* 失败那一行的原文加前缀「生成失败：」；被停止的那一行写自己的话
              （「已手动停止」）——一个是程序出事，一个是人的决定，不该共用一句壳。 */}
          <span className="gerr" title={outcome.message}>
            {outcome.kind === 'canceled' ? outcome.message : `生成失败：${outcome.message}`}
          </span>
          {/* 详情：只在失败时出现，成功时界面一个新元素都不多。一条尝试一行，
              没有散文——这里要的是「几次、卡在哪一步」，不是第二篇报错。 */}
          {attempts.length > 0 && (
            <details className="gen-trace">
              <summary>详情</summary>
              <ol className="gen-trace-l">
                {attempts.map((item) => (
                  <li key={`${item.phase}-${item.attempt}`}>{attemptLine(item)}</li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
      <button
        className="btn gen"
        type="button"
        title={present
          ? `${fresh ? '已有一份当前版本的产物' : '已有一份旧版本的产物'}；`
            + `这次会存成第 ${versions + 1} 版（共 ${versions} 版）`
          : undefined}
        onClick={() => {
          // 有结局（失败 / 被停止）→ 一次**重试**（新作业、旧行留作历史）；
          // 否则就是一次普通的生成。
          if (generator.state === 'choose') setAsking(true);
          else if (outcome !== null) void retry();
          else void start();
        }}
        disabled={pending}
      >
        {/* 会存成第几版直接写在按钮上，不靠悬停：重新生成是一次覆盖，
            覆盖第几版是按下之前就该知道的事。 */}
        {outcome !== null
          ? '重试'
          : (present ? `重新生成 · 第 ${versions + 1} 版` : '生成')}
      </button>
      {asking && (
        <div
          className="sheet on"
          onClick={(event) => {
            // 点遮罩 = 关闭（与动作条、交回材料同一个行为）；点 box 内部不关。
            if (event.target === event.currentTarget) setAsking(false);
          }}
        >
          <div className="box">
            <div className="h">生成器</div>
            <div className="b">
              <GeneratorDialog
                view={generator}
                onCancel={() => setAsking(false)}
                onDone={() => {
                  // 测通并落库之后：关框、刷新（服务端的解析结果从 choose 变 ready）、
                  // 立刻开跑。一次点击的意图，不是两次。
                  setAsking(false);
                  router.refresh();
                  void start();
                }}
              />
            </div>
          </div>
        </div>
      )}
      {toast !== null && (
        <Toast key={toast.seq} failure={toast.failure} onClose={closeToast} />
      )}
    </>
  );
}

export default GenerateButton;
