/**
 * 左轨的折叠偏好：一个 cookie 就是全部状态。
 *
 * 为什么状态在 cookie 而不是 localStorage / React state：左轨宽 184px / 56px，
 * 而外壳（`.shell` 的栅格）是 server component 画的——宽度的第一帧必须来自服务端，
 * 否则每次导航、每次刷新都会从 184px 闪一下再收起来。cookie 由 layout 读，由
 * `RailToggle` 写，写完之后立刻 `router.refresh()` 让服务端那一份对齐。
 *
 * 三个值而不是两个值：没有 cookie 时是**桌面展开、手机（<768px）收起**，而服务端
 * 不知道视口，所以「默认」本身得交给 CSS。'auto' 就是那个「交给 CSS」，'open' /
 * 'collapsed' 是用户亲手点过的结果、优先于视口。CSS 只看左轨**实际有多宽**
 * （`--rail-w` + `@container`，见 globals.css），不看这个值是怎么来的——所以
 * 「auto 在手机上等于收起」不需要第二套样式。
 */
export const RAIL_COOKIE = 'flowers_rail';

export type RailPref = 'open' | 'collapsed' | 'auto';

/**
 * cookie → 偏好。人手改过的坏值（`flowers_rail=true`、空串）落回 'auto'：
 * 一个坏 cookie 不该让左轨钉死在某个宽度上，而 'auto' 正是「没选过」的意思。
 */
export function railFromCookie(raw: string | undefined): RailPref {
  return raw === 'open' || raw === 'collapsed' ? raw : 'auto';
}
