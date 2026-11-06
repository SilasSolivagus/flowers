'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** 左轨的三个入口。aria-current 供 globals.css 的 `.rail > a[aria-current="true"]` 高亮当前页。 */
const ENTRIES = [
  { href: '/', label: '需求' },
  { href: '/releases', label: '版本' },
  { href: '/settings', label: '设置' },
] as const;

/**
 * 左轨导航。两个标签同时挂在 DOM 上，`display` 由 CSS 按左轨**实际宽度**切
 * （globals.css 的 `@container (max-width:100px)`）：
 *
 * - `.lbl` 是完整标签（展开态）；
 * - `.abbr` 是第一个字（收起态，56px 放不下两个字）。
 *
 * 为什么不在这里读一个 `collapsed` prop：这个组件在 layout 里、跟开关是兄弟，
 * 传 prop 要么把整个左轨变成一个客户端边界，要么在收缩的那一帧里两边不同步
 * （开关已经 56px 了，标签还在等 RSC 回来）。宽度只有一个来源：CSS 量出来的。
 *
 * 收起后 `.lbl` 是 `display:none`，读屏用户算名字时读不到它，所以每个链接都带
 * `aria-label`/`title`（= 完整标签）：可见的「需」与可访问的名字「需求」说的是同一个目的地。
 */
export function RailNav() {
  const pathname = usePathname();

  return (
    <>
      {ENTRIES.map(({ href, label }) => {
        const current = href === '/' ? pathname === '/' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={current ? 'true' : undefined}
            aria-label={label}
            title={label}
          >
            <span className="lbl">{label}</span>
            <span className="abbr" aria-hidden="true">{label.slice(0, 1)}</span>
          </Link>
        );
      })}
    </>
  );
}

export default RailNav;
