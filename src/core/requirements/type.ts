/**
 * 「类型」那一列的词表：**键、标签、空值口径只写在这一处**。
 *
 * 与 `platforms.ts` / `priority.ts` / `fields.ts` 同一条理由——它同时被服务层
 * （`create.ts` 的归一与校验）、录入表单（`app/components/RequirementForm.tsx`，
 * **客户端**组件）、抽屉、导出表、MCP、以及三处生成 prompt 消费。客户端组件 import
 * 一个会连带 `drizzle-orm` / `db/client.js` 的模块，那份代码就会进浏览器包，所以这里
 * 只有字面量，不 import 任何东西。
 *
 * ## Ruling 1（2026-11-08）：类型**不再必填**
 *
 * owner 的裁决：负责人决定评审人（P4-06 之后派单锚在 `members.line`，不在需求类型上），
 * 于是「类型」不再承载任何权限，它只剩一条内容属性。一条没人填类型的需求不该被卡在
 * 收集列——那道门在 `state-machine.ts` 里已经摘掉（`inbox → design` 的 `guard: 'type'`）。
 *
 * 于是这一列的三种取值：
 * - `'commercial'`（商业）/ `'feature'`（功能）——历史上就有的两个键，**不动**：
 *   803 条迁移数据全是它们，换键名等于一次没有收益的全表改写；
 * - `null`——没填。这是**合法值**，不是缺失数据：界面写「未指定」，不再编一个默认值。
 *
 * 为什么键仍是英文而不是「商业 / 功能」：这一列的值是 `members.line`
 * （`feature` / `commercial`）的同名兄弟，`line-anchor.ts` / `roles.ts` 那一整套
 * 条线逻辑都按这两个词写；改成中文只会在两列之间再造一份翻译。**标签**才是给人看的
 * 那一半，而 `TYPE_UNSET` 是空值的写法。
 */

export type TypeKey = 'commercial' | 'feature';

export type RequirementType = {
  key: TypeKey;
  /** 界面上的名字（下拉、抽屉那一行、导出表的一格）。 */
  label: string;
};

/** 顺序就是表单下拉的顺序（功能在前：真实数据里它更多）。 */
export const TYPES: readonly RequirementType[] = [
  { key: 'feature', label: '功能' },
  { key: 'commercial', label: '商业' },
] as const;

/**
 * 空值的界面写法（Ruling 1）。
 *
 * 与 `PRIORITY_UNSET`（「未定」）、`PLATFORM_UNSET`（「未标注」）刻意不同字：这三件事
 * 的「空」不是同一件事——优先级是**还没定级**（要定），平台是**没标端**（可以不标），
 * 类型是**没选**（现在允许不选）。三处措辞一致会让读的人以为它们是同一种缺口。
 */
export const TYPE_UNSET = '未指定';

const KEYS: readonly string[] = TYPES.map((t) => t.key);

/** 这个词在不在词表里（大小写不敏感）。 */
export function isTypeKey(value: string): value is TypeKey {
  return KEYS.includes(value.trim().toLowerCase());
}

/**
 * 任意输入 → 落库的写法。
 *
 * `null` / `undefined` / 空白串 → `null`（= 未指定），这是**合法的空**；
 * 认不出的值也返回 `null`，由调用方决定报什么中文——与 `normalizePriority` 同一条
 * 分工：单选被静默丢掉等于把一次表态变成没表态，所以 `create.ts` 会对「非空且认不出」
 * 的值报错，而不是拿这个 `null` 当结果。
 *
 * 同时接受中文标签（「商业」/「功能」）：MCP 的 agent 从抽屉里抄的是标签，
 * 而这两个词与键一一对应，接受它不引入第二种值。
 */
export function normalizeType(value: unknown): TypeKey | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (text === '') return null;
  if (KEYS.includes(text)) return text as TypeKey;
  const byLabel = TYPES.find((t) => t.label === value.trim());
  return byLabel?.key ?? null;
}

/**
 * 键 → 中文名。`null` → 「未指定」（**不返回空串**：抽屉那一行会变成一个空白格，
 * 而空白格读起来像渲染坏了）。认不出的键原样返回：读侧不该丢掉一条需求里的东西。
 */
export function typeLabel(key: string | null | undefined): string {
  if (key === null || key === undefined) return TYPE_UNSET;
  return TYPES.find((t) => t.key === key)?.label ?? key;
}

/**
 * 抽屉抬头那一行的写法：` · 功能类` / ` · 未指定类` 都不对，所以空值给 `null`，
 * 由界面决定「整段不渲染」——抬头只有编号与标题时仍然成立，而「未指定类」不是中文。
 *
 * 信息表那一行用的是 `typeLabel()`（=「未指定」），两处的差别是有意的：
 * 抬头是**标题行**（省掉一段没人读的话），信息表是**字段**（必须有一格说得清它是空的）。
 */
export function typeSuffix(key: string | null | undefined): string | null {
  if (key === null || key === undefined || key === '') return null;
  return `${typeLabel(key)}类`;
}
