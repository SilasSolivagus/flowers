/**
 * 「优先级」那一列的词表（P4-09）：**键、标签、写入口径只写在这一处**。
 *
 * 与 `platforms.ts` / `fields.ts` 同一条理由——它同时被服务层、录入表单（**客户端**
 * 组件）、抽屉、指纹消费，所以这里只有字面量，不 import 任何东西。
 *
 * ## 为什么是这五个
 *
 * 生产库里真实存在的优先级取值（括号里是条数，803 条里有 800 条填了它）：
 *
 *   P0 223 · P1 193 · P2 331 · P3 30 · 绿色通道 23
 *
 * 键取 `p0..p3` / `green` 而不是「P0」「绿色通道」：键是**数**（排序、比较、MCP 入参），
 * 标签才是给人看的。这也是 P4-08 平台那一列的同一条口径。
 *
 * ## 空值是合法值，而且是常见的
 *
 * 803 条里有 3 条没有优先级；描述六问里 178 条一条都没写。**不编造缺失数据**：
 * 这一列 `null` = 没定，界面显示「未定」，表单里是空选项，指纹把它归一成 `''`
 * ——与「没写」的六问同一种写法（见 `fingerprint.ts` 文件头第 2 条）。
 */

export type PriorityKey = 'p0' | 'p1' | 'p2' | 'p3' | 'green';

export type Priority = {
  key: PriorityKey;
  /** 界面上的名字（chips / 下拉、抽屉那一行、事件里的「旧值 → 新值」）。 */
  label: string;
};

/** 顺序 = 严重程度，从高到低。也是 `normalizePriority` 认得的全部取值。 */
export const PRIORITIES: readonly Priority[] = [
  { key: 'p0', label: 'P0' },
  { key: 'p1', label: 'P1' },
  { key: 'p2', label: 'P2' },
  { key: 'p3', label: 'P3' },
  { key: 'green', label: '绿色通道' },
] as const;

/** 空值的界面写法。`null` 与它是一件事。 */
export const PRIORITY_UNSET = '未定';

const KEYS: readonly string[] = PRIORITIES.map((p) => p.key);

/** 这个词在不在词表里（大小写不敏感）。 */
export function isPriorityKey(value: string): value is PriorityKey {
  return KEYS.includes(value.trim().toLowerCase());
}

/**
 * 任意输入 → 落库的写法。
 *
 * 与 `normalizePlatforms` 的关键差别：**认不出的值不静默丢掉，而是交给调用方决定**。
 * 平台是一组标签（丢掉一个只是少一个标签），优先级是一个**单选**——把 `P9` 丢掉
 * 等于把一次明确的表态变成「没定」，那比报错更坏。所以这里返回 `null` 表示
 * 「不认识」，由 `create.ts` / `manage.ts` 决定报什么中文。
 *
 * `null` / `undefined` / 空白串 → `null`（= 未定），这是合法的「清空」。
 */
export function normalizePriority(value: unknown): PriorityKey | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (key === '') return null;
  return KEYS.includes(key) ? (key as PriorityKey) : null;
}

/** 键 → 中文名。认不出的键原样返回：读侧不该丢掉一条需求里的东西。 */
export function priorityLabel(key: string | null | undefined): string {
  if (key === null || key === undefined) return PRIORITY_UNSET;
  return PRIORITIES.find((p) => p.key === key)?.label ?? key;
}
