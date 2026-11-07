/**
 * 「来源」那一列的词表（Ruling 3）：**词表、标签、空值口径只写在这一处**。
 *
 * 与 `platforms.ts` / `priority.ts` / `type.ts` 同一条理由——它同时被服务层
 * （`create.ts` 的校验）、录入表单（`app/components/RequirementForm.tsx`，**客户端**
 * 组件）、抽屉、MCP 消费。客户端组件 import 一个会连带 `drizzle-orm` / `db/client.js`
 * 的模块，那份代码就会进浏览器包，所以这里只有字面量，不 import 任何东西。
 *
 * ## 六类 + 自定义
 *
 * 线上问题 / 客服反馈 / 领导需求 / 需求挖掘 / 技术反馈 / 其他。
 *
 * **键就是中文**（不像 `platforms` 的 `web` / `mobile`）：库里存的也是这几个中文串。
 * 理由有三条，都在迁移 0022 的注释里：六类里只有两类在老系统有英文键（`online_issue`
 * / `original`），另外四类是这次新起的名字；「原创 → 需求挖掘」是一次**判断**而不是
 * 一次翻译（见迁移注释），硬造英文键会把那条判断藏进一层映射里；而 owner 的验收查询
 * 就是按中文看的（`select source, count(*)` 应当直接读到「线上问题 8 / 需求挖掘 332」）。
 *
 * ## 「其他」的自述
 *
 * 选「其他」时允许一句自述，落在 `source_note`（另一个列）。它不是一个第七类，
 * 是一个注释格子——所以它不进词表、也不参与校验，只在界面上跟着「其他」一起出现。
 *
 * ## 空值
 *
 * `null` = 未标注（463 条老数据从来没有过来源，12 条演示数据也没有）。**不编**。
 * 界面写「未标注」——与 `PLATFORM_UNSET` 同字：这两件事都是「这一格没标」，
 * 而不是「还没选」（类型的 `未指定`）。
 */

export const SOURCE_OTHER = '其他';

export type SourceKey =
  | '线上问题' | '客服反馈' | '领导需求' | '需求挖掘' | '技术反馈' | typeof SOURCE_OTHER;

export type Source = {
  /** 落库的值，也是界面上的名字（这里是同一个串，见文件头）。 */
  key: SourceKey;
  /** 界面上的名字。与 `key` 相同，留这一格是为了与 `PLATFORMS` / `TYPES` 同一形状。 */
  label: string;
};

/**
 * 顺序就是下拉的顺序：四条「别人给的」在前（真实需求大多从这里来），
 * 「需求挖掘」在后（我们自己发现的），「其他」是兜底那一项。
 */
export const SOURCES: readonly Source[] = [
  { key: '线上问题', label: '线上问题' },
  { key: '客服反馈', label: '客服反馈' },
  { key: '领导需求', label: '领导需求' },
  { key: '技术反馈', label: '技术反馈' },
  { key: '需求挖掘', label: '需求挖掘' },
  { key: SOURCE_OTHER, label: '其他' },
] as const;

/**
 * 空值的界面写法。`null` 与它是一件事。
 *
 * 与 `TYPE_UNSET`（「未指定」）刻意不同字：类型是**还没选**（现在允许不选），
 * 来源是**没标**（463 条老数据本来就没有这一格）。
 */
export const SOURCE_UNSET = '未标注';

const KEYS: readonly string[] = SOURCES.map((s) => s.key);

/** 这个词在不在词表里。 */
export function isSourceKey(value: string): value is SourceKey {
  return KEYS.includes(value.trim());
}

/**
 * 任意输入 → 落库的写法。
 *
 * `null` / `undefined` / 空白串 → `null`（= 未标注），这是合法的空；认不出的值也返回
 * `null`，由调用方决定报什么中文——与 `normalizePriority` 同一条分工：单选被静默丢掉
 * 等于把一次表态变成没表态，所以 `create.ts` 对「非空且认不出」的值**报错**。
 */
export function normalizeSource(value: unknown): SourceKey | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  return KEYS.includes(text) ? (text as SourceKey) : null;
}

/** 键 → 中文名。`null` → 「未标注」。认不出的键原样返回：读侧不该丢掉一条需求里的东西。 */
export function sourceLabel(key: string | null | undefined): string {
  if (key === null || key === undefined || key === '') return SOURCE_UNSET;
  return SOURCES.find((s) => s.key === key)?.label ?? key;
}

/** 这一行要不要显示「自述」那一格：只有「其他」且真的写了字。 */
export function sourceNoteVisible(source: string | null | undefined, note: string | null | undefined): boolean {
  return source === SOURCE_OTHER && typeof note === 'string' && note.trim() !== '';
}
