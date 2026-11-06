/**
 * 版本时间窗的纯函数：**零依赖**，服务层与客户端表单共用。
 *
 * 为什么单独一个文件：录入表单要在用户敲日期的过程中**就地**算「与上一版重叠了哪一段」
 * （那是 P4-02 明确要求的行内提示，不是提交后才出现的错误）。而客户端组件不能 import
 * `manage.ts`——那个文件 import 了 drizzle 与 `db/client`，一行 import 就会把库连接
 * 拖进浏览器包。所以判定本身住在这里，两边各自 import 一份同一个实现。
 *
 * 这三条规则对「重叠」的定义就是全部：
 * 1. 区间是半开的 `[windowStart, releaseDate)`：**首尾相接不算重叠**。上一版 11-15
 *    发版、这一版 11-15 开窗，是同一件事的正常排法，警它一下只会让人把日期改成 11-16。
 * 2. 两端都按 UTC 零点解析（版本日期一律是 `YYYY-MM-DD`，见 `manage.ts` 的
 *    `parseDayOrThrow`）：'2026-11-01' 是一件日历事实，不是某个时区的瞬间。
 * 3. 解析不出来（`Invalid Date`）一律当作「没有重叠」，而不是抛：这一层会被界面的
 *    每次敲键调用，而输入框里半截日期是常态。真正的非法日期由服务层的校验说。
 */

export type Window = { windowStart: string; releaseDate: string };

/** ISO / `YYYY-MM-DD` → 'MM-DD'。取的是 UTC 那一天，与写库口径一致。 */
export function dayLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().slice(5, 10);
}

/** 两个时间窗重叠的那一段（ISO 起止），没有重叠就是 null。 */
export function overlapOf(a: Window, b: Window): { start: string; end: string } | null {
  const start = Math.max(new Date(a.windowStart).getTime(), new Date(b.windowStart).getTime());
  const end = Math.min(new Date(a.releaseDate).getTime(), new Date(b.releaseDate).getTime());
  if (Number.isNaN(start) || Number.isNaN(end) || start >= end) return null;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

/**
 * 那一行策略文案：`上一个版本：v1.4 11-01 → 11-15`。
 *
 * owner 举的例子是这个形状，一个字都不多。没有上一版时说「还没有版本，这是第一个」
 * ——这句话是**上下文**，不是错误：新建版本时最需要知道的就是「我这一版排在哪」。
 */
export function previousLine(previous: Window & { name: string } | null): string {
  if (previous === null) return '还没有版本，这是第一个';
  return `上一个版本：${previous.name} ${dayLabel(previous.windowStart)} → ${dayLabel(previous.releaseDate)}`;
}

/** 重叠警告的那一句话（点名版本与重叠的那一段）；没有重叠就是 null。 */
export function overlapLine(entered: Window, previous: (Window & { name: string }) | null): string | null {
  if (previous === null) return null;
  const overlap = overlapOf(entered, previous);
  if (overlap === null) return null;
  return `与「${previous.name}」重叠：${dayLabel(overlap.start)} → ${dayLabel(overlap.end)}`;
}
