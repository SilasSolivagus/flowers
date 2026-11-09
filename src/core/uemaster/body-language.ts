/**
 * 正文里的代码坐标与技术词：**机器拦**（2026-11-09 的产品决定，两轮）。
 *
 * ── 为什么这一层必须存在
 *
 * 规矩先写进了提示词（`copy.ts` 的 `PRODUCT_BODY_RULE`），而这一次的教训正是「只写进
 * 提示词等于没写」：owner 读到的第一份材料就带着 `service/cdn_link.go:382` 与
 * `(*cdnLink).getUserCustomDomainIsShortLink`。模型没有恶意，它只是觉得「说得更具体更好」。
 * 所以正文与坐标的分层必须由**代码**保证，模型参不参与都一样——与 `locate/banner.ts`
 * 那条「横幅是事实，提示词是请求」同一个道理。
 *
 * ── 第一轮的三种写法算违规（坐标）
 *
 * 1. `路径:行号`（`service/cdn_link.go:382`）——最硬的一种，出现即违规；
 * 2. 带目录的路径（`src/pages/Share/Share.tsx`）——它已经是「文件坐标」了，哪怕没有行号。
 *    要求路径里**至少有一个 `/`**。
 * 3. 反引号包起来的标识符（`` `getUserCustomDomainIsShortLink` ``）——markdown 里反引号
 *    就是「这是一个代码符号」的意思，读者看到它就知道自己在读研发的话。
 *
 * ── 第二轮的教训：上一版**漏掉了一整类**，而且漏得干净
 *
 * owner 退回来的第二段话逐字如下（它**通过了**第一轮的检查）：
 *
 *   缺口：跳到 purchaseRecord 的哪个 tab 写了，但带不带定位参数没写。
 *   建议：跳 /purchaseRecord?tab=rights&focus=ORDER_ID，命中项高亮 2 秒。
 *
 * 这段话里没有一个文件路径、没有反引号，却全是研发语言：网址参数（`?tab=rights&focus=…`）、
 * 裸驼峰命名（`purchaseRecord` / `ORDER_ID`，**没有**反引号）、代码变量名（`tab` / `focus`）、
 * HTTP 状态码（`302`）、实现类名词（`字段` / `接口` / `参数` / …）、扩展名。
 * 换句话说：上一版拦的是「坐标」，而 owner 不要的是「技术词汇」——坐标只是它的一个子集。
 * 所以这一版按**词类**补，每一类都配一条误伤护拦（见下）。
 *
 * ── 失败模式：**改写优先，改写不了才搬走**（第二轮新增，第一轮只有「搬」）
 *
 * 第一轮删的是整个子句、原句进末尾「研发参考」——对路径是对的（路径是证据，读者不需要
 * 在正文里读它），对**词汇**就不对了：`302` 的正文版本是「自动跳转」，删掉整句等于把
 * 一句产品上的话也删了。所以这一版先改写：
 *
 * 1. **改写**（保留子句）：只替换**含义与输入无关**的记号——HTTP 状态码、扩展名、查询串、
 *    实现名词。`302` 就是「自动跳转」，`.vue` 对读者是零信息，`参数` 就是「设置项」。
 *    换掉这些词不改变一句话说的是什么，所以信息零损失。
 * 2. **搬走**（整子句进「研发参考」）：**命名类**记号（`路径:行号`、带目录路径、反引号
 *    标识符、裸驼峰 / 蛇形大写）。它们指着**具体的一个东西**（哪个页面、哪一项），
 *    机械替换必然丢信息——那需要读懂需求才能重写，是提示词的活（`PRODUCT_BODY_RULE`
 *    里有正例），不是正则的活。
 * 3. 改写之后仍然不合格（剩下不足 `MIN_REMAIN` 个汉字、或还有违规词）→ 按第 2 条搬走。
 *    判据是机器可判的那一条：**这句话离开那个词还成不成句**。改写得漂不漂亮，这一层
 *    不管（它是网，不是笔）；正文的质量由提示词负责，见 `copy.ts` 的正例。
 *
 * ── 两档严格度：`body` 与 `gap`（第二轮新增）
 *
 * 「缺口 / 建议」是 PM 拍板的地方，那里出现实现词等于没写结论；而「分页」「导出」这种
 * 词本身就是需求自己的领域词，出现在正文里是对的。所以模式分开：
 *
 * - `gap`：缺口 / 建议 / 风险 —— 实现名词**一律**算违规，没有例外；
 * - `body`：其余正文 —— 实现名词只在**不构成领域词**时算违规（目前只有一条豁免：
 *   「第三方接口」这类「对外接入」的说法，见 `接口` 那条注释）。
 *
 * 谁算 `gap`：标注里除了 verdict（一致/缺失/多余/不一致）之外的每一行，以及评审问题清单
 * 的 `why`。判据在 `sanitizeAnno`，来源是 `VERDICT_ROW_TITLES`——它与 `inspect.ts` 的
 * `VERDICT_NOUN` 用一条用例钉住，防止两边漂。
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

// ─── 第二轮：五类技术词（每一类都有一条误伤护拦）────────────────────────────
//
// 加一条词类之前先回答两个问题：**它为什么一定会让 PM 翻页**，以及**哪些正常中文会
// 被它误伤**。答不出第二个，就不要加——误伤比漏拦更难发现（漏拦有人抱怨，误伤只会
// 让句子悄悄变短）。

/**
 * 1. 网址参数（`?tab=rights`、`&focus=ORDER_ID`）。
 *
 * 为什么算违规：这是**地址栏里的东西**，PM 读到它只知道「研发要带点什么」，不知道用户
 * 会看到什么。产品语言写「自动切到「权益」标签并定位到刚点的那一条」。
 *
 * 误伤护拦：**必须带 `=`**。中文疑问句用的是全角 `？`，半角 `?` 后面跟 `字母=` 才是
 * 参数；`#node=节点id` 这种锚点（模板里的使用说明）不以 `?`/`&` 开头，不拦。
 */
const QUERY = /[?&][A-Za-z_][\w.-]*=[^\s，。；、）)\]"'」]*/g;

/**
 * 2. 当散文用的 HTTP 状态码（`302` / `404` / `500`）。
 *
 * 为什么算违规：「302 到新页」的正文版本是「旧入口会自动跳到新页面」；状态码本身对 PM
 * 没有任何信息量。
 *
 * 误伤护拦有两条，**都是上下文判据，不靠白名单**：
 * - 只在**挨着**跳 / 返回 / 状态 / 页面 / 错误 / 重定向 / 入口时才拦（「302 个用户」
 *   「2026 年」这类年份与计数因此安全）；
 * - 数值后面紧跟量词（个 / 元 / 天 / 次 / 年 / 折 / % …）一律不拦。
 */
const STATUS_CODE = /(?<![\d.])(30[1278]|40[0134]|50[023])(?![\d.])/g;

/** 状态码的**上下文**词：出现才算「当散文用」。没有它，`302` 只是一个数字。 */
const STATUS_CONTEXT = /跳|返回|状态|页面|错误|重定向|入口/;

/**
 * 「`302` 到新页」这种写法：3xx **后面直接跟「到 + 页面词」**，也是当散文用。
 *
 * 为什么单独一条、而且不把「到」放进上面的上下文词里：`302 到 500 个用户` 是一个
 * **区间**，把「到」当上下文词会把它误判成状态码。所以这一条只认 `3xx`、且后面跟的
 * 必须是页面词（新 / 页 / 首 / 旧 / 下 / 上 / 跳）。
 */
const STATUS_TO_PAGE = /\s*到\s*(?:新|页|首|旧|下|上|跳)/;

/** 状态码后面若是量词，它是计数不是状态码。 */
const COUNT_TAIL = /^\s*(?:年|月|日|个|元|万|块|号|秒|天|次|行|条|人|篇|折|台|位|%|px)/;

/**
 * 这一处状态码是「当散文用」吗（`findProseLeaks` 与 `rewriteClause` 共用同一条判据）。
 *
 * 为什么必须共用一个函数：两处各写一遍，改了一处另一处就漂——漂的方向一定是「拦得住
 * 但不改写」，于是句子被整句搬走，而它本来可以留在正文里。
 */
function isProseStatus(text: string, at: number, match: string, length: number): boolean {
  if (COUNT_TAIL.test(text.slice(at + length, at + length + 2))) return false;
  if (match.startsWith('3') && STATUS_TO_PAGE.test(text.slice(at + length, at + length + 4))) {
    return true;
  }
  const window = text.slice(Math.max(0, at - 10), at + length + 10);
  return STATUS_CONTEXT.test(window);
}

/** 3. 裸驼峰（`purchaseRecord`）与蛇形大写（`ORDER_ID`）——**没有**反引号的那些。 */
const CAMEL = /(?<![A-Za-z0-9_/])[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+(?![A-Za-z0-9_])/g;
const SNAKE_UPPER = /(?<![A-Za-z0-9_])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?![A-Za-z0-9_])/g;

/**
 * 误伤护拦：**品牌与产品自己的词**。它们长得像驼峰，但读者认得、而且是需求里的正名。
 *
 * 为什么要显式列出而不是「首字母大写的放过」：`WiFi` 是小写开头 + 大写中段（与
 * `purchaseRecord` 同形），`VIP` / `SKU` 是全大写。这些词删掉会改变句子的意思，
 * 而它们恰好是最常出现的几个。表短、有用例；加新词时问一句「PM 会把它当技术词吗」。
 */
const PROTECTED_WORDS: ReadonlySet<string> = new Set([
  'WiFi', 'iOS', 'iPad', 'iPhone', 'iCloud', 'macOS', 'MacBook', 'WeChat', 'PayPal',
  'GitHub', 'YouTube', 'AppStore', 'eSIM', 'HiFi', 'OneDrive', 'Android',
]);

/**
 * 4. 裸扩展名（`.vue` / `.tsx` / `.json` / `.go`）。
 *
 * 为什么算违规：`Share.tsx 页面` 里的 `Share` 还有用，`.tsx` 是纯实现细节。
 *
 * 误伤护拦：**前面必须是一个字母开头的词**。`0.97 元`、`v1.2.3`、`2026.11.09` 这些都
 * 以数字开头，不会被吃进来。（这条护拦是必须的：折价公式里到处都是小数。）
 *
 * 注意：第一轮**故意**放过裸文件名（见旧报告 §7.2），这一版收回了那次豁免——owner 第二段
 * 话里 `purchaseRecord` 就是**裸的**标识符，豁免它正是那个洞。
 */
const EXTENSION = /(?<![\w.])[A-Za-z][\w-]*\.(?:vue|tsx?|jsx?|mjs|cjs|json|go)(?![\w])/g;

/**
 * 5. 实现类名词。
 *
 * 为什么算违规：PM 读到「字段」不知道是哪个信息项、读到「埋点」不知道要统计什么；
 * 产品语言有对应的说法，见下表。
 *
 * 误伤护拦（按词判，逐条写在注释里）：
 * - `接口`：**「第三方接口」「开放接口」「对外接口」「合作方接口」不算违规**——那是
 *   「要不要备案 / 要不要走外部审批」的领域说法，PM 决策用的正是这个词。它在
 *   `body` 模式豁免，在 `gap` 模式仍然拦（缺口里说「第三方接口」等于没说缺口在哪）。
 * - `路由`：「路由器」不拦（那是硬件，不是页面跳转）。
 * - 「分页」「导出」「排序」「筛选」**不在词表里**：它们是需求自己的领域词，
 *   出现在正文里是对的。这条豁免由用例钉住（误伤用例），不靠人记得。
 */
const IMPL_NOUNS: ReadonlyArray<{ word: string; product: string }> = [
  { word: '接口地址', product: '对接地址' },
  { word: '入参', product: '提交的内容' },
  { word: '出参', product: '返回的内容' },
  { word: '字段', product: '信息项' },
  { word: '接口', product: '系统对接' },
  { word: '埋点', product: '数据统计' },
  { word: '参数', product: '设置项' },
  { word: '路由', product: '页面跳转' },
  { word: '组件', product: '页面模块' },
];

/** `接口` 的领域豁免前缀（`body` 模式）。四个词都出自真实 PRD 的「对外接入」语境。 */
const INTERFACE_DOMAIN = /(?:第三方|开放|对外|合作方|合作伙)$/;

/**
 * 代码变量名（`tab` / `focus`）——**只在 `gap` 模式**、只认这一小张封闭表。
 *
 * 为什么不做成「所有英文单词」：正文里 `PRD`、`App`、`H5`、`UI` 都是正常词，把英文单词
 * 一律当违规会把正文删成筛子。这张表只收 owner 那段话里真实出现过的两个词；下一次
 * 材料里再冒出别的变量名，加一行 + 一条用例，而不是放宽成通配。
 */
const CODE_VARS: ReadonlyArray<{ word: string; product: string }> = [
  { word: 'tab', product: '标签' },
  { word: 'tabs', product: '标签' },
  { word: 'focus', product: '定位' },
  { word: 'param', product: '设置项' },
  { word: 'params', product: '设置项' },
];

/** 违规的形状。`match` 是原文里那一段（要报给人 / 要搬进脚注的就是它）。 */
export type ProseLeak = {
  kind:
    | 'path-line' | 'path' | 'backtick'
    | 'query' | 'status' | 'identifier' | 'extension' | 'impl-noun';
  match: string;
};

/**
 * 严格度。
 *
 * - `body`：正文（页面文案、verdict 标注）——实现名词按领域豁免判；
 * - `gap`：缺口 / 建议 / 风险——实现名词无豁免，代码变量名也算违规。
 */
export type LeakMode = 'body' | 'gap';

/** verdict 那一行的四个小标题。与 `inspect.ts` 的 `VERDICT_NOUN` 用一条用例钉住。 */
export const VERDICT_ROW_TITLES: ReadonlySet<string> = new Set(['一致', '缺失', '多余', '不一致']);

/** 汉字的个数（只用来判「这句还成不成句」，不做任何语言判断）。 */
function hanCount(text: string): number {
  return (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
}

/** 一段命中区间。用来做「这一处已经在别的违规里了，不重复算」的跳过判断。 */
type Span = { start: number; end: number };

/** 一个正则在一段文字里的全部命中区间。 */
function spansOf(re: RegExp, text: string): Span[] {
  const out: Span[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** 这个位置落在某个区间里吗。 */
function inside(spans: readonly Span[], at: number): boolean {
  return spans.some((span) => at >= span.start && at < span.end);
}

/**
 * 这段文字里有哪些代码坐标与技术词。
 *
 * 纯函数、不打分、不判断「像不像」：八种形状逐条扫，命中就是命中。宁可多拦一句
 * （它会被改写成产品说法、或搬到脚注，读者仍看得见），也不要放过一句——放过的那句
 * 在正文里，就是 owner 翻页的原因。
 *
 * **去重口径**：先扫「硬坐标」（路径 / 反引号），再扫词表，且词表的命中若落在已经算过的
 * 区间里就跳过。理由：`service/cdn_link.go:382` 同时是一个路径、一个扩展名、一个蛇形名，
 * 同一处报三次只会让计数（本文件末尾那个指标）失真。
 */
export function findProseLeaks(text: string, mode: LeakMode = 'body'): ProseLeak[] {
  const out: ProseLeak[] = [];
  const seen = new Set<string>();
  const push = (kind: ProseLeak['kind'], match: string): void => {
    const key = `${kind}\u0000${match}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, match });
  };
  const taken: Span[] = [];
  for (const re of [PATH_LINE, PATH_ONLY]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      // `service/x.go:382` 同时满足「路径:行号」与「带目录的路径」两个正则。只报前者：
      // 同一处报两条会让「搬进研发参考」出现两行同一个文件（一行带行号、一行不带），
      // 也会让指标把一个坐标数成两处。
      if (re === PATH_ONLY && inside(taken, m.index)) continue;
      push(re === PATH_LINE ? 'path-line' : 'path', m[0]);
      taken.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  BACKTICK.lastIndex = 0;
  for (let m = BACKTICK.exec(text); m !== null; m = BACKTICK.exec(text)) {
    push('backtick', m[0]);
    taken.push({ start: m.index, end: m.index + m[0].length });
  }

  const scan = (
    re: RegExp,
    kind: ProseLeak['kind'],
    accept: (match: string, at: number) => boolean = () => true,
  ): void => {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const at = m.index;
      if (inside(taken, at)) continue;
      if (!accept(m[0], at)) continue;
      push(kind, m[0]);
      taken.push({ start: at, end: at + m[0].length });
    }
  };

  // 顺序有意义：查询串先扫，`ORDER_ID` 才不会作为蛇形名被重复算一次。
  scan(QUERY, 'query');
  scan(STATUS_CODE, 'status', (match, at) => isProseStatus(text, at, match, match.length));
  scan(CAMEL, 'identifier', (match) => !PROTECTED_WORDS.has(match));
  scan(SNAKE_UPPER, 'identifier', (match) => !PROTECTED_WORDS.has(match));
  scan(EXTENSION, 'extension');
  for (const noun of IMPL_NOUNS) {
    const re = new RegExp(noun.word, 'g');
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const at = m.index;
      if (inside(taken, at)) continue;
      // 误伤护拦 1：`路由器` 是硬件，不是页面跳转。
      if (noun.word === '路由' && text.slice(at + 2, at + 3) === '器') continue;
      // 误伤护拦 2：`第三方接口` 这类是领域说法，只在正文模式豁免。
      if (noun.word === '接口' && mode === 'body') {
        const before = text.slice(Math.max(0, at - 4), at);
        if (INTERFACE_DOMAIN.test(before)) continue;
      }
      push('impl-noun', noun.word);
      taken.push({ start: at, end: at + noun.word.length });
    }
  }
  if (mode === 'gap') {
    for (const variable of CODE_VARS) {
      const re = new RegExp(`(?<![A-Za-z0-9_])${variable.word}(?![A-Za-z0-9_])`, 'g');
      re.lastIndex = 0;
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        if (inside(taken, m.index)) continue;
        push('impl-noun', m[0]);
        taken.push({ start: m.index, end: m.index + m[0].length });
      }
    }
  }
  return out;
}

/** 这段文字里有没有代码坐标 / 技术词（调用方只要一个二值答案时用它）。 */
export function hasProseLeak(text: string, mode: LeakMode = 'body'): boolean {
  return findProseLeaks(text, mode).length > 0;
}

/** 一句子句里有没有坐标。 */
function clauseLeaks(clause: string, mode: LeakMode): ProseLeak[] {
  return findProseLeaks(clause, mode);
}

// ─── 改写：把这些词换成产品说法 ─────────────────────────────────────────────

/** 命名类记号：它们指着具体一个东西，机械替换必然丢信息（见 `rewriteClause` 的注释）。 */
const HARD_KINDS: ReadonlySet<ProseLeak['kind']> = new Set(['path-line', 'path', 'backtick']);

/** 状态码 → 产品说法。读者要知道的是「会发生什么」，不是「几号状态」。 */
const STATUS_WORD: Readonly<Record<string, string>> = {
  '301': '自动跳转', '302': '自动跳转', '307': '自动跳转', '308': '自动跳转',
  '400': '打不开', '403': '没有权限', '404': '打不开',
  '500': '出错', '502': '出错', '503': '出错',
};

/** 查询串的替身：它说明「会带着定位信息过去」，具体参数名对读者没有信息量。 */
const QUERY_WORD = '（带上定位信息）';

/** 裸标识符在**页面语境**里的替身（`跳到 purchaseRecord 的哪个 tab`）。 */
const PAGE_WORD = '该页面';

/** 路由 / 页面名词的语境词：出现在标识符前面 12 个字里，就把它当页面名。 */
const PAGE_CONTEXT = /跳|进入|打开|页面|页|到|回|在/;

/** 被搬走的整格缺口 / 建议，正文里留下的指针（不编内容，只说它去哪了）。 */
export const MOVED_HINT = '技术细节见文末「研发参考」。';

/** 中文之间不留空格（替换留下的缝）。 */
function squeeze(text: string): string {
  return text
    .replace(/[ \t\u3000]{2,}/g, ' ')
    .replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1')
    .replace(/\s+(?=[，。；、）])/g, '')
    .replace(/([（])\s+/g, '$1');
}

/**
 * 改写一句子句（不动整段的结构）。
 *
 * 返回 `null` = **改不了**，调用方按「搬走」处理。判据只有两条，都是机器能判的：
 * 1. 有一处命名类记号落在**无法安全替换**的位置（比如一个不是页面名的裸驼峰）；
 * 2. 改写之后仍然有违规词，或剩下的汉字不足 `MIN_REMAIN`（已经不是一句话了）。
 *
 * 刻意不做的事：不猜语义。`purchaseRecord` 到底是「购买记录页」还是「订单页」只有
 * 读过需求的人知道；猜错比留着更坏——所以只有「页面语境」这一种可判的情形才替换。
 */
export function rewriteClause(clause: string, mode: LeakMode = 'body'): string | null {
  // 子句是按标点切出来的，所以**每一句都自带一个结尾标点**。判「还成不成句」时必须把它
  // 先摘下来，否则「以逗号结尾」会被当成残句，改写永远失败——第一版就是这么错的。
  const tail = /[，。；、]+$/.exec(clause)?.[0] ?? '';
  const core = tail === '' ? clause : clause.slice(0, -tail.length);
  /**
   * 命名类记号一出现就**直接认输**，不做半吊子替换。
   *
   * 为什么：这类词指着具体一个东西（哪个文件、哪一行、哪个符号），正则换不出它的产品
   * 说法。更糟的是「半替换」——`service/cdn_link.go` 若先把扩展名吃掉，会剩下
   * 「落点是 service/ 的方法」，既不是坐标也不是人话，而且**已经没有违规词了**，
   * 于是它会留在正文里。宁可整句搬走，也不要留半句。
   */
  if (findProseLeaks(core, mode).some((leak) => HARD_KINDS.has(leak.kind))) return null;
  let text = core;
  let lost = false;

  // 1. 查询串：第一处换成「（带上定位信息）」，其余删掉（一句话里两个查询串只是同一个意思）。
  let firstQuery = true;
  text = text.replace(QUERY, () => {
    if (firstQuery) {
      firstQuery = false;
      return QUERY_WORD;
    }
    return '';
  });

  // 2. 状态码。
  text = text.replace(STATUS_CODE, (match, _g1: string, at: number) => {
    if (!isProseStatus(text, at, match, match.length)) return match;
    return STATUS_WORD[match] ?? match;
  });

  // 3. 扩展名：纯删。读 `Share.tsx 页面` 的人要的是「那个页面」。
  text = text.replace(EXTENSION, '');

  // 4. 实现名词 → 产品说法。
  for (const noun of IMPL_NOUNS) {
    const re = new RegExp(noun.word, 'g');
    text = text.replace(re, (match, at: number) => {
      if (noun.word === '路由' && text.slice(at + 2, at + 3) === '器') return match;
      if (noun.word === '接口' && mode === 'body') {
        if (INTERFACE_DOMAIN.test(text.slice(Math.max(0, at - 4), at))) return match;
      }
      return noun.product;
    });
  }

  // 5. 代码变量名（只在 gap 模式）：封闭表，逐个换成产品词。
  if (mode === 'gap') {
    for (const variable of CODE_VARS) {
      const re = new RegExp(`(?<![A-Za-z0-9_])${variable.word}(?![A-Za-z0-9_])`, 'g');
      text = text.replace(re, variable.product);
    }
  }

  // 6. 裸标识符：**只有页面语境**才替换，其余情况一律认输（见函数头「刻意不做的事」）。
  const replaceIdentifier = (match: string, at: number): string => {
    if (PROTECTED_WORDS.has(match)) return match;
    const before = text.slice(Math.max(0, at - 12), at);
    if (PAGE_CONTEXT.test(before)) return PAGE_WORD;
    lost = true;
    return match;
  };
  text = text.replace(CAMEL, (match, at: number) => replaceIdentifier(match, at));
  text = text.replace(SNAKE_UPPER, (match, at: number) => replaceIdentifier(match, at));

  if (lost) return null;
  const out = squeeze(text);
  if (hanCount(out) < MIN_REMAIN) return null;
  if (findProseLeaks(out, mode).length > 0) return null;
  if (/[，。；、]{2}|^[，。；、]/.test(out)) return null;
  return out + tail;
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
 * 正文 → 去干净之后的正文 + 被搬走的原句。
 *
 * 处理的粒度是**子句**（见文件头「代价」）：一个文件路径出现在一句话的中间时，只删那一段
 * 会留下「落点是 的 私有方法」这种残句——那比原文更难读。整句删掉之后，读者的损失是
 * 「少了一句研发黑话」，而不是「读到一句病句」。
 *
 * 剩下不足 `MIN_REMAIN` 个汉字时返回空串：那一格本来就只是坐标，删完什么都没了，
 * 调用方据此丢掉整格（而不是把一句残句塞进材料）。
 */
export function relocateProse(
  text: string,
  mode: LeakMode = 'body',
): { text: string; moved: string[]; rewritten: number } {
  if (text.trim() === '') return { text: '', moved: [], rewritten: 0 };
  const clauses = text.split(CLAUSE_SPLIT).filter((clause) => clause !== '');
  if (clauses.length === 0) return { text, moved: [], rewritten: 0 };
  const kept: string[] = [];
  const moved: string[] = [];
  let rewritten = 0;
  for (const clause of clauses) {
    const leaks = clauseLeaks(clause, mode);
    if (leaks.length === 0) {
      kept.push(clause);
      continue;
    }
    const fixed = rewriteClause(clause, mode);
    if (fixed !== null) {
      kept.push(fixed);
      rewritten += 1;
      continue;
    }
    /**
     * 搬走什么：整句搬走是默认（读者少一句黑话，研发多一行原话）。
     *
     * 但若这一句里的违规**全是坐标**，只交坐标——「（现在：service/x.go）」这种括号块
     * 整句搬进「研发参考」是一行噪音，而那一节要的正是可点开的坐标（第一轮的用例
     * 钉的就是这个：`moved` 里应当是 `service/x.go`，不是包着它的那句话）。
     */
    if (leaks.every((leak) => HARD_KINDS.has(leak.kind))) {
      for (const leak of leaks) moved.push(leak.match);
    } else {
      moved.push(clause.trim());
    }
  }
  if (moved.length === 0 && rewritten === 0) return { text, moved: [], rewritten: 0 };
  const joined = tidy(kept.join(''));
  if (hanCount(joined) < MIN_REMAIN) return { text: '', moved, rewritten };
  return { text: joined, moved, rewritten };
}

/** `<body …>` 的起点（与 `locate/banner.ts` 的 `BODY_TAG` 同一个判据）。 */
const BODY_TAG = /<body[^>]*>/i;

/**
 * `<script>` / `<style>` 整块（含标签）。
 *
 * 为什么必须跳过：材料把 walkmap 的 JSON 原样塞在 `<script>var NODES = …</script>` 里，
 * 而那段 JS 里满是 `getElementById` / `setViewByNode` 这种驼峰名。第二轮加上「裸驼峰算
 * 违规」之后，若不跳过，`relocateProse` 会把 JS 的句子当正文删掉——**页面脚本被删成
 * 残句，材料打开就是一片空白**。脚本与样式是「页面的构造」，不是读者读到的句子，
 * 与属性里的路径同一条规矩（见 `relocateHtmlBody`）。
 */
const OPAQUE_BLOCK = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * 材料 HTML → 正文（`<body>` 之后、`</body>` 之前）里没有代码坐标 / 技术词的 HTML。
 *
 * 只看**文本节点**（`>…<` 之间的那一段），属性一个字都不动：`class`、`onclick`、
 * `data-*` 里出现路径是**页面的构造**，不是读者读到的句子，改它会把页面改坏。
 * `<script>` / `<style>` 同理整块跳过（见 `OPAQUE_BLOCK`）。
 *
 * 这一层是最后一道网（模型的标注、我们自己拼的标注都要过它），不是主路径——
 * 主路径是提示词 + `sanitizeAnno`（缺口 / 建议那一档比这里更严）。
 *
 * 没有 `<body>` 时**原样返回**：那是排版器换了模板（`banner.ts` 会抛，这里不抛），
 * 这一层不该成为材料出不来的第二个原因。
 */
export function relocateHtmlBody(
  html: string,
  moved: string[] = [],
  mode: LeakMode = 'body',
): string {
  return walkBodyText(html, (text: string) => {
    const result = relocateProse(text, mode);
    if (result.moved.length === 0 && result.rewritten === 0) return text;
    moved.push(...result.moved);
    return result.text;
  });
}

/**
 * 正文 HTML 的文本节点 → 逐个交给 `fn` 改写，`<script>` / `<style>` 整块原样保留。
 *
 * 只认 `>…<` 之间的那一段（文本节点），属性一个字都不动；没有 `<body>` 时原样返回
 * （`banner.ts` 会抛，这里不抛：这一层不该成为材料出不来的第二个原因）。
 */
function walkBodyText(html: string, fn: (text: string) => string): string {
  const bodyAt = BODY_TAG.exec(html);
  if (bodyAt === null) return html;
  const head = html.slice(0, bodyAt.index + bodyAt[0].length);
  const rest = html.slice(bodyAt.index + bodyAt[0].length);
  const walk = (chunk: string): string =>
    chunk.replace(/>([^<]*)</g, (whole, text: string) => {
      const next = fn(text);
      return next === text ? whole : `>${next}<`;
    });

  // 用保留段的方式切分：命中的 `<script>` / `<style>` 整块原样保留。
  let out = '';
  let last = 0;
  OPAQUE_BLOCK.lastIndex = 0;
  for (let m = OPAQUE_BLOCK.exec(rest); m !== null; m = OPAQUE_BLOCK.exec(rest)) {
    out += walk(rest.slice(last, m.index));
    out += m[0];
    last = m.index + m[0].length;
  }
  out += walk(rest.slice(last));
  return head + out;
}

// ─── 可数的指标：一份材料里还剩多少违规词 ───────────────────────────────────

/**
 * 一段文字里有多少处违规（`gap` 模式更严，见 `LeakMode`）。
 *
 * 为什么是一个**数**而不是一句「看起来还行」：owner 的两次退货都是「这句话里的词不对」，
 * 而「对不对」如果不落成一个数，就只能靠人逐字读。这个数进日志、进产物统计，>0
 * 就是流水线的失败——它不拦材料（见 `reportVocab` 的注释），但它必须被看见。
 */
export function countProseHits(text: string, mode: LeakMode = 'body'): number {
  return findProseLeaks(text, mode).length;
}

/** 材料 HTML 的正文里有几处违规（跳过属性、`<script>`、`<style>`）。 */
export function countHtmlBodyHits(html: string, mode: LeakMode = 'body'): number {
  let hits = 0;
  walkBodyText(html, (text: string) => {
    hits += countProseHits(text, mode);
    return text;
  });
  return hits;
}

/**
 * 指标那一行日志。
 *
 * 为什么保留英文键名（`lint ... hits`）：这一行会被日志系统按前缀切分，中文键名在里面
 * 是一串乱码；正文部分仍然是中文，人读得懂。
 */
export function vocabReportLine(tag: string, raw: number, left: number): string {
  const verdict = left === 0 ? '通过' : '不通过（正文里还有实现词）';
  return `[body-language] ${tag} hits=${raw} left=${left} ${verdict}`;
}

/**
 * 把指标写出去（日志一行）+ 交还同一个数，方便调用方塞进 stats。
 *
 * 为什么不抛：本仓吃够了「整份不出」的苦（见 `types.ts` 的 `absent`）。违规词比
 * 「代码没读到」轻得多——读者少一句黑话，而不是少一份材料。所以这一层**记账不拦**：
 * 数字进日志、进 `stats.vocabHits`，谁去修是人的决定。真正拦材料的是改写与搬走，
 * 它们已经尽力了（改写优先，改不了才搬）。
 */
export function reportVocab(tag: string, raw: number, left: number): number {
  process.stderr.write(`${vocabReportLine(tag, raw, left)}\n`);
  return raw;
}

// ─── 缺口 / 建议：标注那一档（比正文更严）───────────────────────────────────

/** 标注的一行：`[小标题, 正文]`，可选的第三格是缺口等级。与 `walkmap.ts` 的 `Anno` 同形。 */
export type AnnoRow = string[];

/** 一个节点的标注被清洗之后的样子。 */
export type SanitizedAnno = {
  /** 清洗后的标注（顺序不变，行数可能少一条——整格都搬走的那种）。 */
  rows: AnnoRow[];
  /** 被搬走的原句（进末尾「研发参考」）。 */
  moved: string[];
  /** 清洗前有多少处违规（不进材料，只进指标）。 */
  raw: number;
  /** 清洗后还剩多少处（应当恒为 0）。 */
  left: number;
};

/**
 * 清洗一个节点的标注：`gap` 档比正文更严（实现名词无豁免）。
 *
 * verdict 那一行（一致 / 缺失 / 多余 / 不一致）按 `body` 档处理：它是结论句，里面夹一个
 * 「第三方接口」这样的领域词是合理的。其余每一行（缺口 / 建议 / 风险 / 边界 / 设计约束）
 * 都是 PM 拍板的地方，实现词在那里等于没写结论。
 *
 * 整格被搬空时**不删这一行**：缺口少一条，PM 就少看见一个缺口。留一句
 * `MOVED_HINT`（「技术细节见文末「研发参考」。」）——不编内容，只指路。这是「信息不丢」
 * 在这一层的具体做法。
 */
export function sanitizeAnno(rows: readonly AnnoRow[]): SanitizedAnno {
  let raw = 0;
  let left = 0;
  const moved: string[] = [];
  const out: AnnoRow[] = [];
  for (const row of rows) {
    const title = row[0] ?? '';
    const body = row[1] ?? '';
    const mode: LeakMode = VERDICT_ROW_TITLES.has(title) ? 'body' : 'gap';
    raw += countProseHits(body, mode);
    const result = relocateProse(body, mode);
    left += countProseHits(result.text, mode);
    moved.push(...result.moved);
    const text = result.text === '' && result.moved.length > 0 ? MOVED_HINT : result.text;
    out.push(row.length >= 3 ? [title, text, row[2]!] : [title, text]);
  }
  return { rows: out, moved, raw, left };
}
