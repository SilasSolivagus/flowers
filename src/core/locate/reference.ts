import { REFERENCE_TITLE } from './copy.js';

/**
 * 材料末尾的「研发参考」小节：**由代码写死**，模型不参与。
 *
 * 为什么这一节与横幅（`banner.ts`）是同一个纪律、不同的位置：
 * - 横幅说「这一段话的依据是什么」（结论 / 代码快照 / 最近改动），放最前面；
 * - 这一节说「要动手的人该看哪几行」，放最后面、字号最小——正文是产品语言（给
 *   功能线负责人与 PM），坐标是脚注（给研发）。**两层不是两个渠道，是位置**。
 *
 * 三条硬规矩：
 * 1. **没有坐标就整节不写**（`lines` 为空 → 原样返回 HTML，连标题都不加）。
 *    绝不渲染「研发参考：无」——读者会以为「查过了，确实没有」，而真实情况往往是
 *    「这份材料没有引用任何代码」（评估材料就是如此）。这与 `copy.ts` 里
 *    「同类先例」「最近改动」那条纪律完全一样。
 * 2. **有坐标却插不进去 = 抛**。HTML 里找不到 `</body>` 说明排版器换了模板；静默跳过
 *    会让「坐标降级成脚注」这件事悄悄失效，而失败的样子（正文里少一句、末尾少一节）
 *    只有真人逐字读才发现——那正是这次要消灭的失败形态。
 * 3. **不放判断**：这一节只有 `仓:路径:行号 符号` 与受影响文件数，不写「所以应该改这里」。
 */

/** 小节的 class，方便以后调样式（当前用内联样式，不动 vendored 的 `build.py`）。 */
export const REFERENCE_CLASS = 'dev-reference';

/**
 * 小节的样子：**低对比、小字号**，明确「这是脚注」。
 *
 * 用内联样式而不是模板 CSS：模板是 vendored 的（`vendor/uemaster/flow-walkthrough`），
 * 改它要重新 vendor，而这一节是我们加的、只属于材料末尾的一段。
 */
const REFERENCE_STYLE = [
  'margin:24px 0 0', 'padding:12px 16px', 'border-top:1px dashed #d4d4d8',
  'color:#52525b', 'font-size:12px', 'line-height:1.8',
].join(';');

const TITLE_STYLE = 'margin:0 0 6px;font-size:12px;font-weight:600;color:#3f3f46';

const LINE_STYLE = 'margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px';

/** 只转义会破坏结构的四个字符（路径里可能出现 `<` `>` 与 `&`）。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 若干行 → 一小节 HTML。
 *
 * 每个坐标一行、`<p>` 包住（`white-space:pre` 不必要：坐标本身不含空格串，
 * 而分行是靠标签，不靠换行符——HTML 会把换行压成一个空格）。
 */
export function referenceHtml(lines: readonly string[]): string {
  const rows = lines
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => `<p style="${LINE_STYLE}">${escapeHtml(line)}</p>`)
    .join('');
  return `<section class="${REFERENCE_CLASS}" role="note" data-dev-reference="1" style="${REFERENCE_STYLE}">`
    + `<p style="${TITLE_STYLE}">${escapeHtml(REFERENCE_TITLE)}</p>${rows}</section>`;
}

/** `</body>` 的位置（大小写不敏感；取**最后**一个——散文里出现这个词的可能性不为零）。 */
const BODY_CLOSE = /<\/body\s*>/gi;

/**
 * 把「研发参考」插到材料末尾（`</body>` 之前）。
 *
 * `lines` 为空时**原样返回**：没有坐标可引的材料（评估那条路通常如此）不该有一个空小节，
 * 更不该有一句「无」。
 */
export function injectReference(html: string, lines: readonly string[]): string {
  const text = lines.map((line) => line.trim()).filter((line) => line !== '');
  if (text.length === 0) return html;
  const matches = [...html.matchAll(BODY_CLOSE)];
  const last = matches[matches.length - 1];
  if (last === undefined || last.index === undefined) {
    throw new Error('材料 HTML 里找不到 </body>：研发参考插不进去（排版器换模板了？）');
  }
  const at = last.index;
  return `${html.slice(0, at)}${referenceHtml(text)}${html.slice(at)}`;
}
