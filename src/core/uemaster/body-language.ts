/**
 * 正文里的代码坐标：**机器拦**（2026-11-09 的产品决定）。
 *
 * ── 为什么这一层必须存在
 *
 * 规矩先写进了提示词（`copy.ts` 的 `PRODUCT_BODY_RULE`），而这一次的教训正是「只写进
 * 提示词等于没写」：owner 读到的第一份材料就带着 `service/cdn_link.go:382` 与
 * `(*cdnLink).getUserCustomDomainIsShortLink`。模型没有恶意，它只是觉得「说得更具体更好」。
 * 所以正文与坐标的分层必须由**代码**保证，模型参不参与都一样——与 `locate/banner.ts`
 * 那条「横幅是事实，提示词是请求」同一个道理。
 *
 * ── 三种写法算违规
 *
 * 1. `路径:行号`（`service/cdn_link.go:382`）——最硬的一种，出现即违规；
 * 2. 带目录的路径（`src/pages/Share/Share.tsx`）——它已经是「文件坐标」了，哪怕没有行号。
 *    要求路径里**至少有一个 `/`**：`Share.tsx` 这种裸文件名在当前材料里只可能来自代码，
 *    但把它当违规会误伤「文件名恰好等于功能名」的短语，且收益很小（见报告「还漏什么」）；
 * 3. 反引号包起来的标识符（`` `getUserCustomDomainIsShortLink` ``）——markdown 里反引号
 *    就是「这是一个代码符号」的意思，读者看到它就知道自己在读研发的话。
 *
 * ── 失败模式：**搬走，不是拒绝**（与「重试一次」二选一，这里选了搬）
 *
 * 判成违规的子句从正文里删掉，原文进材料末尾的「研发参考」小节。理由三条：
 * 1. **重试是另一种提示词**。泄漏是排版/表达问题，不是内容问题；再问一次模型，
 *    换来的往往还是同一句（它不觉得自己写错了），却要花一次 90 秒的调用。
 * 2. **不能因为一句坐标把材料扣下**。本仓已经吃够「整份不出」的苦（`absent` 那段注释），
 *    而坐标泄漏比「没读到代码」轻得多：读者少一句话，而不是少一份材料。
 * 3. **信息量零损失**。坐标是 owner 要保留的证据，所以他给的出口是「降级成脚注」——
 *    这正是搬：正文少一句研发黑话，脚注多一行证据。
 *
 * 代价说清楚：删的是**整个子句**（不是只删那个路径），所以偶尔会删多一点。剩下的句子
 * 若已经不成句（少于 `MIN_REMAIN` 个汉字），整格内容会被丢掉，由调用方决定怎么兜
 * （见 `relocateProse` 的返回值）。
 */

/**
 * 一句「子句」的分界：中文标点之后断开，**全角** `（` 之前也断开。
 *
 * 为什么只认全角 `（`：`findingsAnno` 那种「（现在：路径）」是中文括号，而反引号里的
 * 标识符**可能带半角括号**（`(*cdnLink).getUserCustomDomainIsShortLink`）。
 * 在半角 `(` 前面断开会把一个标识符劈成两半：前半截被判违规删掉、后半截
 * （`(x).y` 方法。」）没有路径特征，于是**留在正文里**——那比不删更糟。
 */
const CLAUSE_SPLIT = /(?<=[，。；！？、）])|(?=（)/;

/** `路径:行号`（`service/cdn_link.go:382`）。带 `/` 与否都算——它已经写了行号。 */
const PATH_LINE = /[\w./-]*\w\.(?:go|tsx?|jsx?|mjs|cjs|vue)\s*:\s*\d+/g;

/** 带目录的路径（`src/pages/Share/Share.tsx`）。**要求至少一个 `/`**，见文件头第 2 条。 */
const PATH_ONLY = /[\w.-]+\/[\w./-]*\w\.(?:go|tsx?|jsx?|mjs|cjs|vue)(?![\w/])/g;

/** 反引号里的一段：markdown 的「这是代码」标记。 */
const BACKTICK = /`[^`\n]{1,160}`/g;

/** 剩下多少汉字才算「还成句」。低于这个数说明整格都是坐标，把它留下只会是残句。 */
export const MIN_REMAIN = 4;

/** 违规的形状。`match` 是原文里那一段（要报给人 / 要搬进脚注的就是它）。 */
export type ProseLeak = {
  kind: 'path-line' | 'path' | 'backtick';
  match: string;
};

/** 汉字的个数（只用来判「这句还成不成句」，不做任何语言判断）。 */
function hanCount(text: string): number {
  return (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
}

/**
 * 这段文字里有哪些代码坐标。
 *
 * 纯函数、不打分、不判断「像不像」：三种形状逐条扫，命中就是命中。宁可多拦一句
 * （它会被搬到脚注，读者仍看得见），也不要放过一句——放过的那句在正文里，就是
 * owner 翻页的原因。
 */
export function findProseLeaks(text: string): ProseLeak[] {
  const out: ProseLeak[] = [];
  const seen = new Set<string>();
  const push = (kind: ProseLeak['kind'], match: string): void => {
    const key = `${kind}\u0000${match}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, match });
  };
  for (const re of [PATH_LINE, PATH_ONLY]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      push(re === PATH_LINE ? 'path-line' : 'path', m[0]);
    }
  }
  BACKTICK.lastIndex = 0;
  for (let m = BACKTICK.exec(text); m !== null; m = BACKTICK.exec(text)) push('backtick', m[0]);
  return out;
}

/** 这段文字里有没有代码坐标（调用方只要一个二值答案时用它）。 */
export function hasProseLeak(text: string): boolean {
  return findProseLeaks(text).length > 0;
}

/** 一句子句里有没有坐标。 */
function clauseLeaks(clause: string): ProseLeak[] {
  return findProseLeaks(clause);
}

/**
 * 收尾：把删掉子句之后留下的悬空标点收干净。
 *
 * 三条，都是为了「剩下的还是一句人话」：
 * - 重复标点（`，，`）压成一个；
 * - 句首的标点去掉（前一句被删掉时，这一句原本是接在 `，` 后面的）；
 * - **句尾的逗号改句号**：删掉的子句往往是最后一句，留下的那个 `，` 会让整段悬空
 *   （「……判定规则，」）。改成 `。` 是唯一不改字、又能收住句子的做法。
 */
function tidy(text: string): string {
  const body = text
    .replace(/[ \t\u3000]{2,}/g, ' ')
    .replace(/([，。；、])\s*(?=[，。；、])/g, '')
    .replace(/^[\s，。；、）]+/, '')
    .replace(/[\s（(]+$/, '');
  const tail = body.replace(/\s*$/, '');
  if (/[，、；]$/.test(tail)) return `${tail.slice(0, -1)}。`;
  return tail.trim();
}

/**
 * 正文 → 去掉坐标之后的正文 + 被搬走的那些坐标。
 *
 * 删的粒度是**子句**（见文件头「代价」）：一个文件路径出现在一句话的中间时，只删那一段
 * 会留下「落点是 的 私有方法」这种残句——那比原文更难读。整句删掉之后，读者的损失是
 * 「少了一句研发黑话」，而不是「读到一句病句」。
 *
 * 剩下不足 `MIN_REMAIN` 个汉字时返回空串：那一格本来就只是坐标，删完什么都没了，
 * 调用方据此丢掉整格（而不是把一句残句塞进材料）。
 */
export function relocateProse(text: string): { text: string; moved: string[] } {
  if (text.trim() === '') return { text: '', moved: [] };
  const clauses = text.split(CLAUSE_SPLIT).filter((clause) => clause !== '');
  if (clauses.length === 0) return { text, moved: [] };
  const kept: string[] = [];
  const moved: string[] = [];
  for (const clause of clauses) {
    const leaks = clauseLeaks(clause);
    if (leaks.length === 0) {
      kept.push(clause);
      continue;
    }
    for (const leak of leaks) moved.push(leak.match);
  }
  if (moved.length === 0) return { text, moved: [] };
  const joined = tidy(kept.join(''));
  if (hanCount(joined) < MIN_REMAIN) return { text: '', moved };
  return { text: joined, moved };
}

/** `<body …>` 的起点（与 `locate/banner.ts` 的 `BODY_TAG` 同一个判据）。 */
const BODY_TAG = /<body[^>]*>/i;

/**
 * 材料 HTML → 正文（`<body>` 之后、`</body>` 之前）里没有代码坐标的 HTML。
 *
 * 只看**文本节点**（`>…<` 之间的那一段），属性一个字都不动：`class`、`onclick`、
 * `data-*` 里出现路径是**页面的构造**，不是读者读到的句子，改它会把页面改坏。
 * 这一层是最后一道网（模型的标注、我们自己拼的标注都要过它），不是主路径——
 * 主路径是提示词 + `findingsAnno` 不在正文里写路径。
 *
 * 没有 `<body>` 时**原样返回**：那是排版器换了模板（`banner.ts` 会抛，这里不抛），
 * 这一层不该成为材料出不来的第二个原因。
 */
export function relocateHtmlBody(html: string, moved: string[] = []): string {
  const bodyAt = BODY_TAG.exec(html);
  if (bodyAt === null) return html;
  const head = html.slice(0, bodyAt.index + bodyAt[0].length);
  const rest = html.slice(bodyAt.index + bodyAt[0].length);
  const cleaned = rest.replace(/>([^<]*)</g, (whole, text: string) => {
    const result = relocateProse(text);
    if (result.moved.length === 0) return whole;
    moved.push(...result.moved);
    return `>${result.text}<`;
  });
  return head + cleaned;
}
