/**
 * 左轨的三处入口，以及顶栏标题的唯一一份「路径 → 中文」表。
 *
 * 为什么要有这一份：入口的中文名现在有两个消费者——左轨里的链接（RailNav /
 * RailFooter）和顶栏的页面标题（PageTitle）。两张表写两遍，第一次改文案就会出现
 * 「顶栏写版本、左轨写发版」这种不一致，而它只会在截图里被人看出来。所以路径与
 * 中文名只在这里写一次，谁要谁 import。
 *
 * 为什么不从 `usePathname()` 的结果反推中文（比如把 `/releases` 大写首字母）：路由
 * 是英文、界面是中文，两者之间本来就只有这张表能翻译。
 */

export interface Section {
  readonly href: string;
  readonly label: string;
}

/** 左轨上半部分的两条导航。设置不在这一组：它在底部与身份块一起（见 RailFooter）。 */
export const RAIL_SECTIONS: ReadonlyArray<Section> = [
  { href: '/', label: '需求' },
  { href: '/releases', label: '版本' },
];

/** 左轨底部的那一个入口。 */
export const SETTINGS_SECTION: Section = { href: '/settings', label: '设置' };

/**
 * 当前路径是不是这个入口。
 *
 * `href === '/'` 要单独判：`'/'.startsWith('/')` 对每个路径都成立，照前缀算的话
 * 需求永远高亮、其它页也永远高亮着需求。其余入口按「相等或后面跟一个 `/`」判，
 * 这样 `/releases/x` 算版本，而将来真出现 `/releases-old` 这类兄弟路由时不会误命中。
 */
export function isCurrent(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * 顶栏要显示的那四个字。
 *
 * 认不出的路径（404、将来新增但忘了登记的入口）退回第一个入口的名字：顶栏必须有一行字，
 * 空着正是这次要修的那个毛病；而「需求」是这个应用的正门，猜错也只是猜错一个标题。
 */
export function pageTitle(pathname: string): string {
  const hit = [SETTINGS_SECTION, ...RAIL_SECTIONS].find((section) => isCurrent(pathname, section.href));
  return hit?.label ?? '需求';
}
