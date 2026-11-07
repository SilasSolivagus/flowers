import { createHash } from 'node:crypto';
import { normalizePlatforms } from './platforms.js';

/**
 * 描述内容的指纹：**这一份产物是照着哪一版需求生成的**。
 *
 * 只有一处实现，因为有两个消费者（写：生成时把指纹存进 `uemaster_artifacts.input_hash`；
 * 读：抽屉拿它与当前描述比，得出「还是新的 / 需求已更新 / 版本未知」）。两处各写一份
 * 序列化，迟早在某个空白字符上分叉，而分叉的表现是**每一份老产物都突然变成「需求已更新」**
 * ——一条没人能解释的假警报。
 *
 * ## 序列化规则（对外，改它就是改契约）
 *
 * 1. 字段与顺序固定为 `FINGERPRINT_FIELDS`：title、context、problem、outcome、
 *    surfaces、edgeCases、outOfScope、prdUrl、platforms（P4-08 加的第九格）。用**数组**
 *    而不是对象：JSON 对象的键序
 *    取决于调用方怎么拼这个对象，而数组的顺序只由这一行决定——「key 顺序无关」因此
 *    是这条实现的性质，不是巧合。
 * 2. 每个值先归一：
 *    - `null` / `undefined` → `''`。**为什么 null 与 '' 必须同哈希**：库里这六列是
 *      `text` 可空，历史行是 null；而界面上的空 textarea 提交上来是 ''。同一件事
 *      （「这一问没写」）在库里两种写法，若哈希不同，那么「打开表单、什么都不改、
 *      保存」就会把所有产物打成「需求已更新」——一次纯粹的无操作制造一场假警报。
 *    - 去掉首尾空白（`trim`）：同理，`' 一句话 '` 与 `'一句话'` 是同一份内容。
 *    - `\r\n` → `\n`：从 Word / 微信里粘进来的文本带 CRLF，换台机器再粘一次就变 LF。
 *    - 值内部的换行与空格**保留**：那是内容（一问就是一段话，段落结构有意义）。
 * 3. `JSON.stringify` 一个字符串数组 → sha256 十六进制。用 JSON 而不是把八个值直接
 *    拼接：拼接会让 `['ab','c']` 与 `['a','bc']` 得到同一个串，于是把内容从 `ab`/`c`
 *    改成 `a`/`bc`（真的改了描述）不会让产物变旧。JSON 有分隔符与转义，没有这个问题。
 * 4. 输出是小写十六进制，长度 64。库里存 text（只用来比对，不参与计算）。
 * 5. `platforms` 是唯一一个**非文本**字段：它是一个字符串数组，序列化前先走
 *    `normalizePlatforms`（小写、去重、按词表顺序、丢掉词表外的值），再 `join(',')`。于是 `['h5','app']` 与 `['app','h5']` 同哈希——
 *    同一条需求的同一组平台，换一次勾选顺序不该把产物打成「需求已更新」。
 *    `null` 与 `[]` 同哈希（与第 2 条同一条理由：未标注只有一种写法）。
 *
 * ## P4-08：这一版**故意**让所有老产物变旧
 *
 * 加第九格 = 改变了 `JSON.stringify` 的数组长度，于是**每一个**历史 `input_hash` 都对
 * 不上了，抽屉里每一份老材料都会显示「需求已更新」。这是正确的：那条记录的含义是
 * 「这份材料是照着一版**不含平台**的描述生成的」，而现在描述里多了一格它会读的东西。
 * 想要「老产物仍然新鲜」只有一条路——在序列化里跳过空平台——那会让「给一条需求补上
 * 平台」不改变指纹，也就是**补了平台却仍说材料是新的**，正好是这条指纹要防的事。
 *
 * ## 什么**不**参与
 *
 * `type` / `requester` / `number` / `state` / 排期日期都不参与：它们不是「描述」，
 * 而且 `state` 每走一步都会变——把它算进去，产物会在需求进入下一个状态的那一刻
 * 全部变成「需求已更新」，而描述一个字都没改。
 */
export const FINGERPRINT_FIELDS = [
  'title', 'context', 'problem', 'outcome', 'surfaces', 'edgeCases', 'outOfScope', 'prdUrl',
  'platforms',
] as const;

/** 参与指纹的九个值（界面上是标题 + 六问 + PRD 链接 + 平台）。 */
export type FingerprintInput = {
  title: string;
  context?: string | null;
  problem?: string | null;
  outcome?: string | null;
  surfaces?: string | null;
  edgeCases?: string | null;
  outOfScope?: string | null;
  prdUrl?: string | null;
  /** 平台（P4-08）。`null` / `[]` / `undefined` 三者同值。 */
  platforms?: readonly string[] | null;
};

/** 归一一个字段：null 与 '' 同值，去首尾空白，CRLF 折成 LF。见文件头第 2 条。 */
function normalize(value: string | null | undefined): string {
  return (value ?? '').replace(/\r\n/g, '\n').trim();
}

/**
 * 指纹。两条路径（写 / 读）都走这一个函数。
 *
 * `platforms` 单独序列化（数组 → 词表顺序的逗号串，见文件头第 5 条）：其余八格都是
 * 文本，只有它不是。
 */
export function requirementFingerprint(input: FingerprintInput): string {
  const parts = FINGERPRINT_FIELDS.map((field) => (field === 'platforms'
    ? normalizePlatforms(input.platforms).join(',')
    : normalize(input[field])));
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

/**
 * 一条从 SQL 出来的需求行 → 指纹。
 *
 * 为什么不直接在 `requirementFingerprint` 里收 snake_case：那样这个名字就会有两种
 * 形状（界面的 camelCase 与 SQL 的 snake_case），而调用方永远只该看见一种。SQL 的
 * 那一种在这里翻译一次，四个生成入口（`compose` / `review` / `inspect` / `start`）
 * 与读模型共用这一处。
 */
export type FingerprintRow = {
  title: string;
  context: string | null;
  problem: string | null;
  outcome: string | null;
  surfaces: string | null;
  edge_cases: string | null;
  out_of_scope: string | null;
  prd_url: string | null;
  /** `text[]`：pg 驱动给的是字符串数组；null 只在理论上出现（列是 not null default '{}'）。 */
  platforms: readonly string[] | null;
};

export function fingerprintOfRow(row: FingerprintRow): string {
  return requirementFingerprint({
    title: row.title,
    context: row.context,
    problem: row.problem,
    outcome: row.outcome,
    surfaces: row.surfaces,
    edgeCases: row.edge_cases,
    outOfScope: row.out_of_scope,
    prdUrl: row.prd_url,
    platforms: row.platforms,
  });
}

/**
 * SQL 里要投影的那几列。
 *
 * 一条常量而不是四份手抄的列清单：生成入口有四个（评估 / 评审 / 走查 / CLI 那条路），
 * 每个都自己 `select ... from requirements`。少抄一列的表现是**那一列永远不参与指纹**
 * ——改它不会把产物标成旧的，而这种漏读在代码里看不出来、在界面上只表现为「明明改了
 * 却没提示」。所以列清单只写一遍，谁要算指纹就把它拼进 select。
 */
export const FINGERPRINT_COLUMNS = 'title, context, problem, outcome, surfaces, edge_cases, out_of_scope, prd_url, platforms';

/**
 * 产物的新鲜度，三态。
 *
 * - `fresh`：存下来的指纹等于当前描述的指纹（包括两边都是「空描述」的情况）。
 * - `stale`：不等 → 「需求已更新」。
 * - `unknown`：产物上没有指纹（P4-02 之前的行，或绕过生成器直接 attach 的行）
 *   → 「版本未知」。**不猜**：把 null 当成 stale 会让所有老产物一上线就全部变成
 *   「需求已更新」，把它当成 fresh 则等于替它们编一个「还是新的」的结论。
 */
export type Freshness = 'fresh' | 'stale' | 'unknown';

export function freshnessOf(stored: string | null | undefined, current: string): Freshness {
  if (stored === null || stored === undefined || stored === '') return 'unknown';
  return stored === current ? 'fresh' : 'stale';
}
