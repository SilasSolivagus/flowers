/**
 * 主题偏好：一个 cookie 就是全部状态。
 *
 * 与左轨折叠（rail-pref.ts）同一套做法、同一个理由：`data-theme` 写在 `<html>` 上，
 * 而 `<html>` 是服务端画的。第一帧必须是对的，否则深色用户每次刷新都会白闪一下
 * 再变黑——那一下比没有深色更难受。cookie 由 layout 读、由 `ThemeToggle` 写。
 *
 * 三个值：'system'（没选过，跟操作系统）/ 'light' / 'dark'。
 * 'system' 不写 `data-theme`，交给 CSS 的 `@media (prefers-color-scheme: dark)`——
 * 服务端不知道用户的系统设置，这件事只能由浏览器答。
 */
export const THEME_COOKIE = 'flowers_theme';

export type ThemePref = 'system' | 'light' | 'dark';

/** cookie → 偏好。坏值（`flowers_theme=blue`、空串）落回 'system'，与没选过等价。 */
export function themeFromCookie(raw: string | undefined): ThemePref {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}
