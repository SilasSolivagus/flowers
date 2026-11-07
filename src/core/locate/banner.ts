/**
 * 材料顶部的定位横幅：**由代码写死**，模型不参与。
 *
 * 为什么需要这一层（2026-11-07 终审 Blocker 2）：那几句话原本只进了**提示词**
 * （`inspect.ts` 的 `structurePrompt`、`review.ts` 的 `findingsPrompt`），材料 HTML
 * 的拼装（`inspect.ts` 的 `build`→`writeFile`、`review.ts` 的同一步）一个字都不带。
 * 后果是：评审落 `absent` 时 PM 在材料上只看到标题里一句「未参考代码现状」，
 * 而 `copy.ts` 明确说 `why`（原因）是「PM 唯一能拿去催人的线索」——它直接丢了。
 *
 * 更要紧的是「模型有没有照做」不该决定这件事：提示词是请求，横幅是事实。模型可以
 * 一个字都不提那三句话，材料顶部那一段仍然在那里。所以：
 * - 调用点必须在**写出 HTML 之前**插这一段，不能等到提示词里；
 * - 找不到 `<body>` 就直接抛：静默跳过等于退回「只进提示词」的老毛病，而那种失败
 *   只有真人逐字读材料才能发现。
 *
 * 这里只做 HTML（转义 + 插入），**句子从哪来**由调用方决定（`copy.ts` 的常量，
 * 经 `renderLocate` 渲染）。分成两层是因为句子属于 `copy.ts`，而 DOM 结构属于
 * 材料排版——混在一起就又有两套措辞了。
 */

/** 横幅的 class，方便以后调样式（当前用内联样式，不动 vendored 的 `build.py`）。 */
export const BANNER_CLASS = 'locate-banner';

/** 横幅的样子：醒目的左边框 + 浅底，**不依赖模板 CSS**（模板是 vendored 的，改它要重新 vendor）。 */
const BANNER_STYLE = [
  'margin:0 0 16px', 'padding:12px 16px', 'border-left:4px solid #d97706',
  'background:#fffbeb', 'color:#7c2d12', 'font-size:14px', 'line-height:1.7',
  'border-radius:4px',
].join(';');

/** 只转义会破坏结构的四个字符：`why` 里可能出现镜像路径与尖括号。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 一段文字 → 一段横幅 HTML。
 *
 * 按行切 `<p>`：那几句话本身就是多行的（候选清单是「引导句 + 编号清单 + 收尾」），
 * 拼成一整段会让清单丢掉行结构，PM 读到的是「1. a 2. b」连成一句。
 */
export function bannerHtml(text: string): string {
  const paragraphs = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .map((line) => `<p style="margin:0 0 6px">${escapeHtml(line)}</p>`)
    .join('');
  return `<section class="${BANNER_CLASS}" role="note" data-locate-banner="1" style="${BANNER_STYLE}">${paragraphs}</section>`;
}

/** `<body ...>` 标签（属性可有可无，大小写不敏感）。 */
const BODY_TAG = /<body[^>]*>/i;

/**
 * 把横幅插到材料正文的最前面（紧跟 `<body>`）。
 *
 * 三种失败都**抛**，不返回原样 HTML：
 * - `text` 是空白：说明调用点没拿到结论（`renderLocate` 空转），那是 bug；
 * - HTML 里没有 `<body>`：排版器换了模板，插不进去——此时悄悄返回原文，材料就又是
 *   「只有标题一句」的样子了；
 * - HTML 不是字符串（构建返回了 `undefined` 却被写下去）：同上。
 */
export function injectBanner(html: string, text: string): string {
  if (text.trim() === '') throw new Error('定位横幅是空的：这一轮没有结论可写，不该出材料');
  const match = BODY_TAG.exec(html);
  if (match === null) throw new Error('材料 HTML 里找不到 <body>：定位横幅插不进去（排版器换模板了？）');
  const at = match.index + match[0].length;
  return `${html.slice(0, at)}${bannerHtml(text)}${html.slice(at)}`;
}
