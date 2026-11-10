import { sanitizeAnno } from './body-language.js';
import type { Anno } from './walkmap.js';

/**
 * 右栏的**两栏标注**：待需求方确认 / 待研发确认（2026-11-10）。
 *
 * ── 为什么必须分成两组，而不是一栏「待确认」
 *
 * 两组欠的不是同一个人。`待需求方确认` 是 PRD / 六问没写清的产品问题（失败怎么办、
 * 这次不做什么、验收口径、边界条件）——只有提需求的人能回答；`待研发确认` 是实现层面
 * 的问题（这一页有哪些状态、跳去哪里、失败怎么提示）——只有做的人能回答。合并成一栏
 * 之后，评审会上没人认领：需求方看着「这一页有几种状态」发呆，研发看着「这次不做什么」
 * 沉默，两份责任一起蒸发。owner 在 v1 范围里把这条列成硬约束（`2026-11-10-v1-scope.md`
 * §四-2），所以它不只是一段提示词，而是一个有形状的东西。
 *
 * ── 形状为什么是「两组数组 + 渲染时才铺成行」
 *
 * walkmap/1 契约里右栏只有一种东西：`anno: [[小标题, 正文], …]`（见
 * `walkmap.ts` 的 `Anno`）。契约是上游的，不在这一版加字段。所以分组发生在**这一层**：
 * 模型交两组问题 → 我们把它铺回 `anno`，每组前面插一行组标题。好处是 `build.py`
 * 一行不改、版式与 uemaster 完全一致；代价是组标题与条目在契约里长得一样（都是
 * `[小标题, 正文]`）——那正是这里必须自己保证「空组不铺标题」的原因：契约不会替我们兜。
 *
 * ── 为什么组标题带一句范围说明
 *
 * 光一个「待需求方确认」会被读成一件要做的事（去确认吧），而读者需要的是「该问什么」。
 * 所以组标题的正文那一格写这类问题的范围（「失败怎么办、这次不做什么…」），条目跟在
 * 后面。这样一组读下来是「谁欠 + 欠什么」，而不是一串没有主语的问句。
 */

/** 两组问题的 id。**只认这两个**：第三组出现时，谁来回答这件事一定会重演。 */
export type OpenGroupKey = 'req' | 'dev';

export type OpenGroup = {
  key: OpenGroupKey;
  /** 组标题：与 owner 的裁决逐字一致，界面与材料上都只写这一份。 */
  header: string;
  /** 组标题下那句范围说明：告诉读者这一类问题**是什么样子**的。 */
  scope: string;
};

/**
 * 两组的定义。顺序就是右栏里出现的顺序：需求方在前（它决定这件事还做不做），
 * 研发在后（它只决定怎么做）。
 */
export const OPEN_GROUPS: readonly OpenGroup[] = [
  {
    key: 'req',
    header: '待需求方确认',
    scope: 'PRD / 六问没写清：失败怎么办、这次不做什么、验收口径、边界条件',
  },
  {
    key: 'dev',
    header: '待研发确认',
    scope: '实现层面要研发回答：这一页有哪些状态、跳去哪里、失败怎么提示',
  },
];

/** 一组问题：`[小标题, 正文]`，与 `Anno` 同形（第三格留给 `p0/p1/p2`，这里不用）。 */
export type OpenQuestions = Record<OpenGroupKey, Anno[]>;

/** 两组都空。**它不等于「没有问题」**：它等于「这一屏没写」——见 `readOpen` 的用法。 */
export const NO_OPEN: OpenQuestions = { req: [], dev: [] };

/**
 * 模型写组名时可能用的别的写法。
 *
 * 为什么容错：提示词里写的是 `req` / `dev`，而模型见过太多别的材料，抄回来常写成
 * `requester` / `需求方` / `产品`（前一组）与 `rd` / `研发` / `技术`（后一组）。
 * 为这个判死要白烧一次两分钟的调用，而它换的是同一个意思。**只认这张表**——
 * 表外的名字一律不收（那才是「它自己编了第三组」）。
 */
const GROUP_ALIASES: Record<string, OpenGroupKey> = {
  req: 'req', requester: 'req', requirement: 'req', demand: 'req', demander: 'req', pm: 'req',
  '需求方': 'req', '需求': 'req', '产品': 'req', '业务': 'req', '待需求方确认': 'req',
  dev: 'dev', rd: 'dev', developer: 'dev', tech: 'dev', engineering: 'dev',
  '研发': 'dev', '技术': 'dev', '待研发确认': 'dev',
};

/** 一条问题的两种宽容写法：`["小标题","正文"]` 与 `{"title":…,"body":…}`。 */
function itemOf(raw: unknown): Anno | null {
  if (typeof raw === 'string') {
    const text = raw.trim();
    return text === '' ? null : ['待确认', text];
  }
  if (Array.isArray(raw)) {
    const parts = raw.filter((part): part is string => typeof part === 'string');
    if (parts.length < 2) return null;
    const title = parts[0]!.trim();
    const body = parts[1]!.trim();
    if (title === '' || body === '') return null;
    // 第三格是缺口等级（build.py 认 p0/p1/p2），这里照收不误：某些阶段会带。
    const level = (parts[2] ?? '').trim();
    return /^p[0-2]$/i.test(level) ? [title, body, level.toLowerCase()] : [title, body];
  }
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    const body = typeof obj.body === 'string'
      ? obj.body.trim()
      : (typeof obj.text === 'string' ? obj.text.trim() : '');
    if (title === '' || body === '') return null;
    return [title, body];
  }
  return null;
}

/**
 * 把模型交的 `open` 收成两组。
 *
 * 三个容忍，都为了让一次调用不作废（每一次作废是 420 秒）：
 * - 组名用别名（见 `GROUP_ALIASES`）；
 * - 一组给成对象（`{标题: 正文}`）也行：模型偶尔把数组写成映射；
 * - 单条写成字符串也行（`"失败时停在哪一屏"` → `["待确认", …]`）。
 *
 * 交不出两组就交空（`NO_OPEN`）。**空不是失败**：真正判「这份材料有没有两组」的地方是
 * `compose.readFragments`——它拿着节点清单，能说清是哪个节点缺、缺哪一组；这一层只说形状。
 */
export function readOpen(raw: unknown): OpenQuestions {
  const out: OpenQuestions = { req: [], dev: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = GROUP_ALIASES[name.trim()] ?? GROUP_ALIASES[name.trim().toLowerCase()];
    if (key === undefined) continue;
    const list: unknown[] = Array.isArray(value)
      ? value
      : (typeof value === 'object' && value !== null
        ? Object.entries(value as Record<string, unknown>)
          .map(([title, body]) => ({ title, body: typeof body === 'string' ? body : '' }))
        : []);
    for (const item of list) {
      const pair = itemOf(item);
      if (pair !== null) out[key].push(pair);
    }
  }
  return out;
}

/** 一组里到底有几条（不含组标题）。 */
export function openCount(open: OpenQuestions | undefined): number {
  if (open === undefined) return 0;
  return open.req.length + open.dev.length;
}

/**
 * 整份材料一条待确认都没有时，右栏铺的**那一行**（2026-11-10，owner 裁决）。
 *
 * 为什么需要它：那两栏是 v1 承诺本身，一份材料里一条都没有，读者点开任何一个节点，
 * 右栏都是空的——空右栏既不等于「没有问题」，也不等于「我们漏了」，它什么都不说。
 * 原来这条靠「整份退回」兜（`compose.readFragments` 的 `requireOpen`），代价是重烧
 * 一次两三分钟的调用，而且第二次照样可能一条都不提。owner 的口径是：**重试照旧，
 * 但绝不因此把整份材料判死**——把话说清楚比退回有用。
 *
 * 为什么标题写「本版」：它是这一份材料的状态，不是这条需求的状态。下一版重新生成
 * 时这一行会自己消失（那时模型给了问题），读者不会以为这是永久结论。
 *
 * 为什么正文要点出「也可能是漏了」：模型稳定地说「没问题」是可疑信号，而不是好消息。
 * 只写「没发现」会把它读成一次确认；补上自查那句，读者才知道该做什么。
 */
export const EMPTY_OPEN_HEAD = '本版没发现待确认项';
export const EMPTY_OPEN_NOTE = '模型在这一轮没有提出待确认项；如果这份材料看着太顺，'
  + '很可能是因为 PRD 和六问都写得很完整——也可能是漏了。请对照六问自查一次。';

/** 那一行本身（`anno` 的形状：小标题 + 正文，与组标题同形）。 */
export function emptyOpenRow(): Anno {
  return [EMPTY_OPEN_HEAD, EMPTY_OPEN_NOTE];
}

/**
 * 两组问题 → 右栏的行（`anno` 的形状），**空的那一组一行都不铺**。
 *
 * 「空组不铺标题」是这条规则的**唯一**判据，也是它的存在理由：一个「待需求方确认」
 * 下面什么都没有，读的人只会得出两个结论之一——「需求方还没确认过」（假：根本没人问）
 * 或者「系统漏了」（同样是假）。两种都比不写更坏。
 *
 * 注意这一层只管**一个节点**。整份材料一条都没有时铺的是 `emptyOpenRow()`，那件事
 * 只有拼装那一层知道（它手里有全部节点，见 `assembleWalkmap`）。
 */
export function openRows(open: OpenQuestions | undefined): Anno[] {
  if (open === undefined) return [];
  const rows: Anno[] = [];
  for (const group of OPEN_GROUPS) {
    const items = open[group.key];
    if (items.length === 0) continue;
    rows.push([group.header, group.scope]);
    rows.push(...items);
  }
  return rows;
}

/**
 * 两组问题过正文那道网（与 `anno` 同一条：标注里的技术词由机器拦）。
 *
 * 为什么这一档按 `gap`（严格档）走：两组问题的正文全是「要谁拍板」的句子，里面出现
 * 实现词等于这一条没写成问题（「这一页的接口返回什么」——需求方读到这句只能沉默）。
 * 组标题那两行不过网：它们是我们的固定文案（见 `OPEN_GROUPS`），不归模型写，
 * 洗它只会让「空组不铺标题」那条判据多一个不必要的变量。
 */
export function sanitizeOpen(open: OpenQuestions | undefined): {
  rows: OpenQuestions;
  /** 清洗前违规处数（进 `Assembly.annoRaw`）。 */
  raw: number;
  /** 清洗后仍违规处数（应当恒为 0）。 */
  left: number;
} {
  if (open === undefined) return { rows: NO_OPEN, raw: 0, left: 0 };
  let raw = 0;
  let left = 0;
  const rows: OpenQuestions = { req: [], dev: [] };
  for (const key of ['req', 'dev'] as const) {
    const result = sanitizeAnno(open[key]);
    raw += result.raw;
    left += result.left;
    rows[key] = result.rows.map((row): Anno =>
      (row.length >= 3 ? [row[0]!, row[1]!, row[2]!] : [row[0]!, row[1]!]));
  }
  return { rows, raw, left };
}
