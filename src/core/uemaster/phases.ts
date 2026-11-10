import type { AttemptPhase } from './trace.js';

/**
 * `uemaster_job_attempts.phase` 的中文出口（六档，**没有第七档**）。
 *
 * 为什么从 `read/progress.ts` 单独拆出来：这是**唯一**一处「phase 标识符 → 一句人话」
 * 的映射，而读它的地方有三个，运行环境互不相同：
 * - 服务端读模型（`read/progress.ts` 的进度卡、`read/detail.ts` 的抽屉那一行）；
 * - 浏览器里的抽屉（`app/components/GenerateButton.tsx`，生成中那一行要显示现在在哪一
 *   步）。客户端组件 import `read/progress.ts` 会把 `pg` 拖进浏览器包（webpack 立刻报
 *   `Can't resolve 'fs'`）——那个坑在 `read/elapsed.ts` 的文件头已经记过一次。
 *
 * 所以这一格必须是**纯**的：不接库、不读环境、不看时钟。
 *
 * 库里的值是英文标识符（`flow` / `pages` / …），界面上不能出现它们——漏一档的表现
 * 就是屏幕上冒出一个 `locate`。认不出的值（将来新增档位、或库里被手改）折成
 * `IDLE_PHASE_LABEL`，而不是原文：那一格说的是「现在在干什么」，一个英文单词什么也
 * 没说。
 *
 * 措辞与 owner 这一轮给的例子逐字一致（「正在按六问拆流程」「正在生成页面片段」
 * 「正在装配三栏」「正在自检」）：这四句描述的是**评估材料**那条链路上的四步。走查
 * 的两步（`locate` / `verify`）与评审的 `findings` 沿用原来的说法——它们已经是那两条
 * 链路的读者认得的词，改一遍只会让人以为换了流程。
 */
export const PHASE_LABEL: Record<AttemptPhase, string> = {
  flow: '正在按六问拆流程',
  pages: '正在生成页面片段',
  build: '正在装配三栏',
  locate: '正在找页面',
  verify: '正在自检',
  findings: '正在写问题清单',
};

/** 还一次尝试都没有时的说法：PRD 快照 / 图之前的准备。 */
export const IDLE_PHASE_LABEL = '正在读 PRD';

/**
 * phase → 一句人话。`null`（一次都没问模型）与认不出的值都走 `IDLE_PHASE_LABEL`。
 */
export function phaseLabelOf(phase: AttemptPhase | string | null | undefined): string {
  if (phase === null || phase === undefined) return IDLE_PHASE_LABEL;
  return PHASE_LABEL[phase as AttemptPhase] ?? IDLE_PHASE_LABEL;
}
