import { hasProseLeak } from './body-language.js';

/**
 * 后端节点的**时序图**：词表、校验、确定性排版（2026-11-09）。
 *
 * ── 为什么要有这个文件
 *
 * 纯后端需求（`PAN-815`「权益发放新增回调机制」那一类）一个页面节点都没有，于是
 * `assembleWalkmap` 把节点挂到空页面上，`validateWalkmap` 整份拒收：「引用了不存在的
 * 页面「空」」。owner 的裁定是：**没有页面的节点不再强行挂页面，改成挂「后端流程」区块；
 * 页面原型那一栏改放一张时序图**（每个后端节点一张小图，点左边节点、右边换内容）。
 *
 * 这张图不能用 mermaid（会引入运行时），也不能让模型写 SVG（它写得出来的东西没法校验）。
 * 所以：模型只交**步骤**（`{from, to, what}`），SVG 由这个文件**确定性地**排出来——
 * 同一份步骤永远得到同一份字节，与 `walkmap.ts` 里 `buildWalkmap` 的口径一致。
 *
 * ── 为什么参与方是**封闭词表**，而不是「随便写个名字」
 *
 * 这个仓刚花两轮把实现词汇从材料里赶出去（`body-language.ts`、plan
 * `2026-11-09-business-language.md`）。时序图是**最容易被实现词汇污染**的一块版式：
 * 随手一画就是
 *
 *     用户 → ShareController.refund() → RefundService.calculate()
 *
 * 它看着很专业，但 PM 在这张图里一个字的判断都做不了。所以参与方只能从
 * `PARTICIPANTS` 里选：那是**产品级角色**（用户在做什么、谁在处理、对谁发起），
 * 不是代码里的类。词表**封闭**的理由有三条，缺一条都会重新长草：
 *
 * 1. **封闭才可判**：`normalizeSteps` 能对每一个参与方说「这个词不在词表里」，
 *    而不是「看起来像代码所以也许不行」——后者模型永远改不对。
 * 2. **封闭才可排**：列宽、折行、字号全部按「最多 7 个参与方」算过（见排版那一节）。
 *    开放词表意味着列宽无界，6 个参与方就会挤成一条线。
 * 3. **封闭才不漂**：同一批需求生成十份材料，读者在每一份里看到的是同一套角色名。
 *
 * 真需要新角色时才加一行（`PARTICIPANTS` + `ALIASES` + 一条用例），
 * **不许**放宽成「任何两到六个汉字的名词」。
 */

// ─── 参与方词表（产品级角色，封闭） ──────────────────────────────────────────

/**
 * 参与方。顺序就是图里的列序（也用于报错时列给模型看）。
 *
 * 这些名字的判据是「PM 会不会用这个词跟研发说话」：
 * - 用户：产品的人；
 * - 页面：用户眼前的这一屏（含弹窗、后台页面之外的网页）；
 * - 运营后台：运营同学操作的那套界面（与用户看的页面分开，因为责任不同）；
 * - 服务端：产品自己的处理（算钱、记账、发权益），**不写**哪个服务、哪个类；
 * - 支付渠道 / 通知渠道：两个**必然穿过产品边界**的外部环节，分开是因为「钱退回来了
 *   但没通知到人」与「通知发了但钱没到」是两类事故；
 * - 第三方：其余外部系统（物流、发票平台、外部订单来源）。
 */
export const PARTICIPANTS = [
  '用户', '页面', '运营后台', '服务端', '支付渠道', '通知渠道', '第三方',
] as const;

export type Participant = (typeof PARTICIPANTS)[number];

/**
 * 同义写法 → 词表里的那一个。
 *
 * 为什么要容错：模型见过别的材料里写「客户端」「后端」「短信」，它抄回来是对的直觉，
 * 只是换了名字。为这个判死会白烧一次调用，所以认下来——但**只认这一张表**，
 * 表外的名字一律报错（那才是「它自己编了一个角色」）。
 */
const ALIASES: Record<string, Participant> = {
  客户端: '页面', 前端: '页面', 界面: '页面', 网页: '页面', 小程序: '页面', APP: '页面', app: '页面',
  后端: '服务端', 服务器: '服务端', 系统: '服务端', 业务系统: '服务端', 后台服务: '服务端',
  管理后台: '运营后台', 运营端: '运营后台', 后台管理: '运营后台', 后台: '运营后台',
  支付平台: '支付渠道', 支付网关: '支付渠道', 微信支付: '支付渠道', 支付宝: '支付渠道',
  短信: '通知渠道', 推送: '通知渠道', 站内信: '通知渠道', 消息通知: '通知渠道',
  外部系统: '第三方', 合作方: '第三方', 电商平台: '第三方', 上游渠道: '第三方',
};

/** 允许的词表，拼成一句给报错用（与 `PARTICIPANTS` 同序，改一处就够）。 */
export const PARTICIPANT_LIST = PARTICIPANTS.join('、');

/**
 * 把模型写的参与方名收进词表。
 *
 * 归一化只做三件事：去空白（含全角空格）、去尾部标点（`服务端：` 这种）、查别名。
 * 不做模糊匹配——「服务」离「服务端」只差一个字，但认下来就等于我们替它编了角色。
 */
export function canonicalParticipant(name: string): Participant | null {
  const t = name.replace(/[\s\u3000]+/gu, '').replace(/[：:，,。.、·]+$/u, '');
  if (t === '') return null;
  if ((PARTICIPANTS as readonly string[]).includes(t)) return t as Participant;
  const alias = ALIASES[t] ?? ALIASES[t.toLowerCase()];
  return alias ?? null;
}

// ─── 步骤：形状、归一化、语言判据 ────────────────────────────────────────────

/** 一步时序：谁、向谁、做了什么。全部是产品语言。 */
export type SeqStep = { from: Participant; to: Participant; what: string };

/** 一个节点的步骤上限。与排版实测有关（见文件末尾「排版」那一段的说明）。 */
export const MAX_STEPS = 12;

/**
 * 一步的文案上限（按字符数，不是字节）。
 *
 * 实测的依据：图宽 690px、字号 11px，一步最多折两行、每行约 20 个汉字；`N. ` 前缀还要
 * 占 3 个字符。28 个字是「两行放得下且不用省略号」的上限。超了不是不能画——是模型在
 * 一句里塞了两个动作，那时**该拆成两步**，而不是让我们把字缩到看不清。
 */
export const MAX_WHAT_CHARS = 28;

/**
 * `what` 里**不许**出现的形状：方法调用、类名、表名、接口地址、HTTP 动词、空括号。
 *
 * 为什么不只靠 `hasProseLeak`：那一层判的是「正文里的技术词」（路径、驼峰、状态码、
 * 实现名词），它不管 `ShareController.refund()`——那串东西里有一个点、一对括号，
 * 驼峰正则会命中，但报出来的理由是「裸驼峰」，模型改一半还会留着括号。这里给出**这一层
 * 自己的**判据，报错也就说得具体：「这一步里写了方法名」。
 */
const STEP_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/[A-Za-z_][A-Za-z0-9_]*\s*\.\s*[A-Za-z_][A-Za-z0-9_]*\s*\(/, '方法调用'],
  [/\b[A-Za-z0-9]+(?:Controller|Service|Handler|Mapper|DAO|Dao|Impl|Entity|Model|Repository)\b/, '代码类名'],
  [/\b(?:sql|SQL)\b|select\s+.+\s+from\s+/i, 'SQL 语句'],
  [/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/, '表名或字段名（下划线命名）'],
  [/\b(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b\s*\/?|\/api\/|https?:\/\//, '接口地址或 HTTP 动词'],
  [/\(\s*\)/, '空括号（函数调用的形状）'],
];

/** 一句话里为什么不能当步骤文案；合格返回 null。 */
export function stepLanguageProblem(what: string): string | null {
  for (const [pattern, noun] of STEP_PATTERNS) {
    const hit = pattern.exec(what);
    if (hit !== null) return `这一步里出现了${noun}「${hit[0].trim()}」`;
  }
  // 与正文同一档：`gap` 最严（实现名词无豁免）。时序步骤是给 PM 判断「后端到底做了什么」
  // 的那一格，比正文更需要产品语言。
  if (hasProseLeak(what, 'gap')) return '这一步里出现了实现词（参数、字段、接口、埋点之类）';
  if ([...what].length > MAX_WHAT_CHARS) {
    return `这一步的文案 ${[...what].length} 个字，超过 ${MAX_WHAT_CHARS} 字：一句话只写一个动作，长的拆成两步`;
  }
  return null;
}

export type StepRead =
  | { ok: true; steps: SeqStep[] }
  | { ok: false; why: string };

/**
 * 模型交回来的 `steps` → 干净的 `SeqStep[]`。
 *
 * 容错三件（都是实测见过的写法）：整格写成 `["用户","页面","点退款"]`；参与方写成别名
 * （`客户端` / `后端`）；`what` 里带换行与多余空白。除此之外一个字都不放过——参与方不在
 * 词表里、`what` 里有代码形状、步数超上限，都**报错**并说清是哪一步。
 *
 * 报错必须点名第几步：一个节点 8 步时，「参与方不在词表里」这种话说三遍，模型也不知道
 * 该改哪一行。
 */
export function normalizeSteps(raw: unknown): StepRead {
  if (raw === undefined || raw === null) return { ok: false, why: '没有给时序步骤（steps）' };
  if (!Array.isArray(raw)) return { ok: false, why: 'steps 必须是数组：每个元素是一条 {from, to, what}' };
  if (raw.length === 0) return { ok: false, why: 'steps 是空的：后端节点至少要有一句话的时序' };
  if (raw.length > MAX_STEPS) {
    return { ok: false, why: `steps 有 ${raw.length} 条，超过上限 ${MAX_STEPS} 条（一步一个动作，长的拆到相邻节点）` };
  }

  const steps: SeqStep[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const at = `第 ${i + 1} 步`;
    const item = raw[i];
    // 两种写法都收：{from,to,what} 与 ["用户","页面","点退款"]。
    let from: unknown;
    let to: unknown;
    let what: unknown;
    if (Array.isArray(item)) {
      [from, to, what] = item as unknown[];
    } else if (typeof item === 'object' && item !== null) {
      const obj = item as Record<string, unknown>;
      from = obj['from'] ?? obj['谁'];
      to = obj['to'] ?? obj['对谁'];
      what = obj['what'] ?? obj['做什么'];
    } else {
      return { ok: false, why: `${at} 不是对象也不是三元数组` };
    }
    if (typeof from !== 'string' || typeof to !== 'string' || typeof what !== 'string') {
      return { ok: false, why: `${at} 缺少 from / to / what（三个都要，都是字符串）` };
    }
    const f = canonicalParticipant(from);
    const t = canonicalParticipant(to);
    if (f === null) return { ok: false, why: `${at} 的参与方「${from}」不在词表里（只能用：${PARTICIPANT_LIST}）` };
    if (t === null) return { ok: false, why: `${at} 的参与方「${to}」不在词表里（只能用：${PARTICIPANT_LIST}）` };
    const text = what.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim();
    if (text === '') return { ok: false, why: `${at} 没有写「做什么」` };
    const problem = stepLanguageProblem(text);
    if (problem !== null) return { ok: false, why: `${at}：${problem}` };
    steps.push({ from: f, to: t, what: text });
  }
  return { ok: true, steps };
}

/**
 * 后端节点没有交步骤时的那一句话（2026-11-09 第三轮，全仓唯一的措辞来源）。
 *
 * 为什么在**读回话那一层**就把整份退回，而不是留给 `validateWalkmap`：模型在这里能一次
 * 改对——「你把这一步判成了后端流程，但没说它在服务端做什么」。而 walkmap 那一层看不见
 * `kind`（契约里没有这一格），它能说的只有「既没有页面也没有后端流程」；两句话意思不同，
 * 不能合并：这一句说的是**意图与义务**（你判它是服务端的事，那就说明它做了什么），那一句
 * 说的是**事实**（这个节点没有落点）。运维看到哪一句，就知道该让模型补什么。
 *
 * 为什么这件事值得整份拒收：上一版把这种节点挂到最近的页面上，读者于是看见一屏界面，
 * 把一步发生在服务端的事读成「这一步在界面上」——这正是本仓这一天在清的那类假陈述。
 * 旧材料在磁盘上是静态 HTML，不会被重新生成，所以变严格只影响**新生成**的材料。
 */
export function missingStepsReason(id: string, title: string): string {
  return `节点「${id} ${title}」判为后端流程但没有给出步骤：请说明这一步在服务端做什么`
    + `（给 steps：「谁 → 谁 · 做什么」，1–${MAX_STEPS} 步，每步 ≤${MAX_WHAT_CHARS} 字）`;
}

/** 参与方（按首次出现排序，去重）。排版按这个顺序排列。 */
export function participantsOf(steps: readonly SeqStep[]): Participant[] {
  const seen = new Set<Participant>();
  const order: Participant[] = [];
  for (const step of steps) {
    for (const name of [step.from, step.to]) {
      if (!seen.has(name)) {
        seen.add(name);
        order.push(name);
      }
    }
  }
  return order;
}

// ─── 提示词里的那一段（只此一处，两条路共用） ────────────────────────────────

/**
 * 时序步骤的提示词块。`compose.ts`（评估 / 评审）与 `inspect.ts`（走查）都贴这一段。
 *
 * 为什么放在这个文件而不是各写一遍：**参与方词表是唯一的事实源**。两个提示词各写一份
 * 词表，改了一处忘了另一处，模型就会在一份材料里看到「支付渠道」、在另一份里看到
 * 「资金方」——那正好是我们要根治的问题。段末那两个反例是 owner 的原话，逐字保留。
 */
export const SEQUENCE_RULE: readonly string[] = [
  '',
  '【后端节点交时序步骤，不交页面】流程节点有两种：',
  '  · 落在页面上的（kind=page）——交页面片段；',
  '  · 发生在服务端的（kind=system / decision）——交一组**时序步骤**，不要画页面，',
  '    也不要拿相邻页面凑（强行挂页面会让读者以为那一步有界面）。',
  'steps 按时间顺序排列，每步 { "from": "谁", "to": "对谁", "what": "做了什么" }：',
  '  { "from": "用户", "to": "页面", "what": "点「申请退款」" }',
  '  { "from": "页面", "to": "服务端", "what": "提交退款申请" }',
  '  { "from": "服务端", "to": "服务端", "what": "按剩余权益计算可退金额" }',
  `参与方只能从这七个里选：${PARTICIPANT_LIST}。`,
  '  它们是**产品级角色**（谁在做什么），不是代码里的类；表外没有别的角色，写不出来就说明',
  '  这一步该合进相邻的一步。自己处理自己时 from 与 to 相同（「服务端 → 服务端：回收权益」）。',
  'what 是产品语言，一句话一个动作：',
  '  · 可以写：点「申请退款」、提交退款申请、按剩余权益计算可退金额、发起退款、退款成功、',
  '    回收权益、站内通知；',
  '  · 不许写：方法名或类名（ShareController.refund() / RefundService）、表名与字段名',
  '    （t_refund_order / refund_status）、接口地址与 HTTP 动词（POST /api/refund）、',
  '    以及参数、字段、埋点、接口这类实现名词。',
  `一个节点 1–${MAX_STEPS} 步，每步不超过 ${MAX_WHAT_CHARS} 个字（超了说明一句话里塞了两个动作）。`,
] as const;

// ─── 排版：确定性 SVG（690px 宽） ────────────────────────────────────────────

/**
 * 图宽固定 690px：那是模板 `.frame-wide` 的宽度，也是 `.stage` 里时序图那一格用的宽度。
 * 不跟容器走（`width="100%"`）的原因是**确定性**：同一份步骤在任何机器上都排出同一份
 * 字节，测试才能逐字断言。
 */
export const SEQ_WIDTH = 690;

const PAD_X = 16;
const TOP_PAD = 10;
const ACTOR_H = 26;
const ACTOR_FONT = 12;
const MSG_FONT = 11;
const LINE_H = 14;
const MAX_LABEL_LINES = 2;
/** 标签框最小宽度：两列相邻时的箭头只有 100 多像素，标签再窄就读不出句子。 */
const MIN_LABEL_W = 240;
/** 自己发给自己的那一圈：向右伸出的长度。 */
const LOOP_W = 22;

/** 一个字符在给定字号下的宽度估计。**只看码位范围，不看字体**——确定性优先。 */
function charWidth(ch: string, fontSize: number): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x2e80) return fontSize;         // 汉字 / 全角标点
  if (ch === ' ') return fontSize * 0.3;
  return fontSize * 0.56;                    // 半角字母数字
}

/** 一段文字的排版宽度（像素）。 */
export function textWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch, fontSize);
  return w;
}

/** 按宽度折行（逐字符贪心）。中英混排时不会在半角单词中间断——判据是宽度不是词边界。 */
export function wrapText(text: string, maxWidth: number, fontSize: number): string[] {
  const lines: string[] = [];
  let cur = '';
  let curW = 0;
  for (const ch of text) {
    const w = charWidth(ch, fontSize);
    if (cur !== '' && curW + w > maxWidth) {
      lines.push(cur);
      cur = '';
      curW = 0;
    }
    cur += ch;
    curW += w;
  }
  if (cur !== '') lines.push(cur);
  return lines.length === 0 ? [''] : lines;
}

/**
 * 折行 + 限行 + 省略。返回 `elided` 让调用方（报告 / 测试）知道**丢过字**。
 *
 * 为什么省略号落在最后一行末尾而不是中间：读者是自上而下读的，缺的字在结尾时他知道
 * 「后面还有」，缺在中间时他会以为这句本来就是这样。
 */
export function elideText(
  text: string,
  maxWidth: number,
  fontSize: number,
  maxLines: number,
): { lines: string[]; elided: boolean } {
  const all = wrapText(text, maxWidth, fontSize);
  if (all.length <= maxLines) return { lines: all, elided: false };
  const keep = all.slice(0, maxLines);
  const last = keep[maxLines - 1] ?? '';
  const budget = maxWidth - textWidth('…', fontSize);
  let out = '';
  let w = 0;
  for (const ch of last) {
    const cw = charWidth(ch, fontSize);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  keep[maxLines - 1] = `${out}…`;
  return { lines: keep, elided: true };
}

/** 排版结果。测试与报告都读它（列数、行数、高度、被省略的步数）。 */
export type SequenceLayout = {
  width: number;
  height: number;
  actors: Participant[];
  /**
   * 每一步的落点：`y` 是这一段的上沿，`lines` 是折好的文案，`self` 表示自环。
   * `labelW` / `textX` / `anchor` 也在这里算好，`sequenceSvg` 直接用——两处各算一遍
   * 就会出现「折行按 240px、落笔按 300px」这种只在一处对的错。
   */
  rows: Array<{
    index: number;
    step: SeqStep;
    fromX: number;
    toX: number;
    lines: string[];
    elided: boolean;
    y: number;
    arrowY: number;
    self: boolean;
    labelW: number;
    textX: number;
    anchor: 'start' | 'middle';
  }>;
  /** 被省略号截断的步数（0 = 一步都没丢字）。 */
  elided: number;
};

/**
 * 纯排版：步骤 → 坐标。不产生字符串、不读时钟，测试可以直接断数字。
 *
 * 规则（也是这一版能画到多大的依据）：
 * - 参与方均分 690px 宽（`PAD_X` 两边各 16）。1 个参与方时列宽取满宽、画的是一串自环；
 * - 标签框宽度 = `min(690-32, max(箭头跨度, 240))`，并在框内居中于箭头中点、被夹在
 *   边距里——所以相邻两列之间那条窄箭头的文案会**向两侧借空间**，而不是挤成三行；
 * - 一步最多两行；超出按省略号截断，`elided` 记账（报告里要说这个数）；
 * - 行高由折行数决定：`行数 × 14 + 8`，自环再加一圈（12px）。
 */
export function layoutSequence(steps: readonly SeqStep[]): SequenceLayout {
  const actors = participantsOf(steps);
  const n = Math.max(actors.length, 1);
  const usable = SEQ_WIDTH - PAD_X * 2;
  const colW = usable / n;
  const xOf = (name: Participant): number => {
    const index = actors.indexOf(name);
    if (index < 0) return PAD_X + colW / 2;
    return PAD_X + colW * (index + 0.5);
  };

  const rows: SequenceLayout['rows'] = [];
  let y = TOP_PAD + ACTOR_H + 12;
  let elided = 0;

  steps.forEach((step, index) => {
    const self = step.from === step.to;
    const fromX = xOf(step.from);
    const toX = xOf(step.to);
    const label = `${index + 1}. ${step.what}`;
    // 标签落点：自环只能往右放（左边是自己的列），别的箭头居中于中点、夹在边距里。
    const availRight = SEQ_WIDTH - PAD_X - (fromX + LOOP_W + 6);
    const labelW = self
      ? Math.max(60, Math.min(availRight, 420))
      : Math.min(usable, Math.max(Math.abs(toX - fromX), MIN_LABEL_W));
    const textX = self
      ? fromX + LOOP_W + 6
      : Math.min(Math.max((fromX + toX) / 2, PAD_X + labelW / 2), SEQ_WIDTH - PAD_X - labelW / 2);
    const fit = elideText(label, labelW, MSG_FONT, MAX_LABEL_LINES);
    if (fit.elided) elided += 1;
    const arrowY = y + fit.lines.length * LINE_H + 8;
    rows.push({
      index,
      step,
      fromX,
      toX,
      lines: fit.lines,
      elided: fit.elided,
      y,
      arrowY,
      self,
      labelW,
      textX,
      anchor: self ? 'start' : 'middle',
    });
    y = arrowY + (self ? 20 : 12);
  });

  return {
    width: SEQ_WIDTH,
    height: Math.ceil(y + TOP_PAD),
    actors,
    rows,
    elided,
  };
}

/** 一位小数的坐标（像素）。压掉浮点尾巴，产物才是逐字节确定的。 */
function px(value: number): string {
  return (Math.round(value * 10) / 10).toString();
}

/** SVG 文本节点转义。时序文案是模型写的，`&` `<` 必须先转。 */
function esc(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/**
 * 步骤 → 一张 SVG 的正文（含 `<svg>` 标签本身）。
 *
 * 颜色与字号全部交给模板的 CSS（`.seq-figure` 那一段）：图里只写结构类名，
 * 所以深色模式跟着模板走，不用在这里塞第二套颜色。
 */
export function sequenceSvg(steps: readonly SeqStep[]): string {
  const layout = layoutSequence(steps);
  const { width, height } = layout;
  const usable = width - PAD_X * 2;
  const colW = usable / Math.max(layout.actors.length, 1);
  const boxW = Math.max(56, Math.min(colW - 12, 160));

  const parts: string[] = [];
  parts.push(
    `<svg class="seq-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"`
      + ` role="img" aria-label="${esc(`后端流程时序，共 ${steps.length} 步`)}">`,
  );

  // 参与方：顶部一个框 + 一条虚线生命线。
  layout.actors.forEach((name, i) => {
    const x = PAD_X + colW * (i + 0.5);
    const text = elideText(name, boxW - 8, ACTOR_FONT, 1).lines[0] ?? '';
    parts.push(
      `<rect class="seq-box" x="${px(x - boxW / 2)}" y="${TOP_PAD}" width="${px(boxW)}"`
        + ` height="${ACTOR_H}" rx="6" ry="6"/>`,
    );
    parts.push(
      `<text class="seq-actor" x="${px(x)}" y="${px(TOP_PAD + ACTOR_H / 2 + ACTOR_FONT / 3)}"`
        + ` text-anchor="middle">${esc(text)}</text>`,
    );
    parts.push(
      `<line class="seq-life" x1="${px(x)}" y1="${TOP_PAD + ACTOR_H}"`
        + ` x2="${px(x)}" y2="${px(height - 6)}"/>`,
    );
  });

  for (const row of layout.rows) {
    row.lines.forEach((line, k) => {
      parts.push(
        `<text class="seq-msg" x="${px(row.textX)}" y="${px(row.y + MSG_FONT + k * LINE_H)}"`
          + ` text-anchor="${row.anchor}">${esc(line)}</text>`,
      );
    });

    if (row.self) {
      // 自环：向右出去、往下 12px、再指回自己。
      const x = row.fromX;
      const top = row.arrowY - 7;
      const bottom = row.arrowY + 7;
      parts.push(
        `<path class="seq-arrow seq-loop" d="M ${px(x)} ${px(top)} H ${px(x + LOOP_W)}`
          + ` V ${px(bottom)} H ${px(x + 6)}" fill="none"/>`,
      );
      parts.push(
        `<polygon class="seq-head" points="${px(x + 6)},${px(bottom)} ${px(x + 13)},${px(bottom - 4)}`
          + ` ${px(x + 13)},${px(bottom + 4)}"/>`,
      );
    } else {
      const dir = row.toX > row.fromX ? 1 : -1;
      const tip = row.toX - dir * 1;
      parts.push(
        `<line class="seq-arrow" x1="${px(row.fromX)}" y1="${px(row.arrowY)}"`
          + ` x2="${px(tip)}" y2="${px(row.arrowY)}"/>`,
      );
      parts.push(
        `<polygon class="seq-head" points="${px(tip)},${px(row.arrowY)}`
          + ` ${px(tip - dir * 7)},${px(row.arrowY - 4)} ${px(tip - dir * 7)},${px(row.arrowY + 4)}"/>`,
      );
    }
  }

  parts.push('</svg>');
  return parts.join('');
}

/**
 * 时序图是**推**出来的——这句话必须印在每一张没页面的图上（2026-11-10，v1 硬约束 1）。
 *
 * 为什么非要印：v1 的评估**不读代码**。这张图的参与方与步骤全部来自需求描述（六问 +
 * PRD）的推断，而它长得和真时序图一模一样。不标的时候，读的人会把它当成「代码里就是
 * 这么走的」——那就是拿一张推出来的图去评审。标了之后，它仍然有用（讨论可行性时
 * 「这几步谁做什么」正是要问的），但没有人会把它当现状。
 */
export const SEQ_INFERENCE_LABEL = '逻辑时序（推演）';

/**
 * 标签下面那句话：一句话说清「谁推的、谁该回答」。
 *
 * 措辞不合并进标签（`逻辑时序（推演）`），因为两者说的是两件事：标签说的是**这张图的
 * 性质**（推的），这句话说的是**它的边界**（推得对不对得研发答）。
 */
export const SEQ_INFERENCE_NOTE = '参与者与步骤按需求描述推的；代码里怎么实现，需要研发确认';

/**
 * 步骤 → 一段可以直接塞进 `pages[]` 的 HTML 片段（时序图 + 一行说明）。
 *
 * 这一行说明不是装饰：
 * 1. 它把参与方**用文字**列一遍——图被省略号截断时，读者至少知道谁在场；
 * 2. 它是这份材料的可引用句（评审记录里抄的就是这一行）；
 * 3. 图的第一行标题在 `.stage` 里被裁掉时，它还在。
 *
 * 2026-11-10 起多两行：`逻辑时序（推演）` 的标签与那句边界说明（见上面两个常量）。
 * 复用 `.seq-cap` 这个已有的类，不新造样式：vendored 模板不归我们改版式，而
 * `build.py` 只把片段原样塞进中栏——一个没有样式的 `div` 会在深色模式下变成黑底黑字。
 */
export function renderSequencePage(steps: readonly SeqStep[], title: string): string {
  const layout = layoutSequence(steps);
  const caption = `${title} · 后端流程 ${steps.length} 步：${layout.actors.join('、')}`;
  return `<figure class="seq-figure" data-seq-steps="${steps.length}" data-seq-inferred="1">`
    + `<div class="seq-cap seq-inferred">${esc(SEQ_INFERENCE_LABEL)}</div>`
    + `<figcaption class="seq-cap">${esc(caption)}</figcaption>`
    + sequenceSvg(steps)
    + `<div class="seq-cap seq-inferred-note">${esc(SEQ_INFERENCE_NOTE)}</div>`
    + '</figure>';
}
