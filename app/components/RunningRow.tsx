import { elapsedLabel } from '../../src/core/read/elapsed';
import { phaseLabelOf } from '../../src/core/uemaster/phases';
import type { AttemptPhase } from '../../src/core/uemaster/trace';

/**
 * 抽屉里「这一阶段正在生成」那一行（2026-11-10）。
 *
 * ── 为什么要有它
 *
 * 一次生成 2–5 分钟。原来那一格只有两个字「生成中」，它不随时间变，也不说在做哪一步
 * ——两分钟之后读者的判断只有一个：卡死了。右下角的进度卡（P4-02）一直在报这两件事，
 * 但它是**另一个地方**：人已经点进这条需求的抽屉了，要他抬头去看角落，等于让他自己
 * 去猜这里没坏。
 *
 * ── 三件东西，各说一件事
 *
 * - 现在在哪一步（phase 的中文，表在 `uemaster/phases.ts`，与进度卡同一份）；
 * - 跑了多久（`mm:ss`，本地跳秒：等服务端给秒数就意味着秒针跟着网络抖，而这一格
 *   恰恰是「它还在动」的唯一证据）；
 * - 第几次尝试（**只在 > 1 时**出现：第 1 次是常态，写上去只是噪音）。
 *
 * ── 为什么单独一个文件、而不是写在 `GenerateButton` 里
 *
 * 判据要能被用例钉住，而 `GenerateButton` 带着 `useRouter` / server action / 轮询定时器，
 * 在用例进程里渲染不出来（`tests/artifact-missing.test.tsx` 那一套 mock 只够让它画出
 * 静态的一帧）。这里只留「给一份视图、画一行字」：没有 hook、没有 `next/link`、
 * 没有 server action，`renderToStaticMarkup` 就能证明它写了什么。
 *
 * 时钟从外面传（`now`），组件自己不读 `Date.now()`：同一份输入永远画同一行，用例不必
 * 用假时钟去追一个每秒都在变的数。
 */

/** 一行要的四格。`attempt` / `startedAt` 由调用方从作业读出来。 */
export type RunningRowProps = {
  /** 那一句中文（`正在按六问拆流程` …）。 */
  phaseLabel: string;
  /** 走到第几次（1 基；`0` = 一次都还没有）。 */
  attempt: number;
  /** 作业开始的时刻（ISO）。 */
  startedAt: string;
};

/**
 * 作业状态 → 这一行画什么。**`null` = 这一格不出现**（没有在跑的作业）。
 *
 * 为什么这是**单独一个纯函数**而不是写在 JSX 的三元里：它是「生成结束了没有」这件事
 * 的唯一判据——`done` / `failed` 都必须让这一行消失（产物链接 / 失败原因各自出现在
 * 别处）。写成 `status === 'running' ? <RunningRow/> : null` 的散装三元，迟早会有一处
 * 忘了判 `failed`，于是失败的作业在抽屉里永远「生成中」。
 */
export function runningRowOf(
  view: { status: string; phase: AttemptPhase | null; attempt: number; startedAt: string } | null,
): RunningRowProps | null {
  if (view === null || view.status !== 'running') return null;
  return {
    phaseLabel: phaseLabelOf(view.phase),
    attempt: view.attempt,
    startedAt: view.startedAt,
  };
}

export function RunningRow({ view, now }: { view: RunningRowProps; now: number }) {
  // 负数是两端钟差（客户端比服务端慢），`elapsedLabel` 会夹到 0；这里再保险一次，
  // 因为 `startedAt` 可能是刚刚才写下的那一行。
  const elapsedMs = Math.max(0, now - new Date(view.startedAt).getTime());
  return (
    <span className="run">
      <b>{view.phaseLabel}</b>
      {/* 秒数两边不同是必然的：服务端渲染那一刻与浏览器接管那一刻差了几百毫秒，
          而这一格每秒都在变。`suppressHydrationWarning` 只压这一格的那声警告；
          第一次 tick 之后秒数就都由本地算了（这也是为什么它必须本地跳）。 */}
      <i className="tm" title="已用时" suppressHydrationWarning>{elapsedLabel(elapsedMs)}</i>
      {/* 「第 2 次尝试」只在重试时才有意义：第一次是常态，写在每一行上只是噪音。 */}
      {view.attempt > 1 && <span className="at">第 {view.attempt} 次尝试</span>}
    </span>
  );
}

export default RunningRow;
