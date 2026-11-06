'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { RAIL_SECTIONS, isCurrent } from './sections';

/**
 * 左轨上半部分的导航（需求 / 版本）。
 *
 * 两个标签同时挂在 DOM 上，`display` 由 CSS 按左轨**实际宽度**切
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
 *
 * 「设置」不在这里：它在左轨底部、与身份块同一组（见 RailFooter），因为它不是
 * 「看哪一页」而是「这一套怎么配」。顺序变了，高亮规则没变：`aria-current` 仍然
 * 由同一张表（./sections.ts）与同一个 `isCurrent()` 判出来。
 */
export function RailNav() {
  const pathname = usePathname();

  return (
    <>
      {RAIL_SECTIONS.map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          aria-current={isCurrent(pathname, href) ? 'true' : undefined}
          aria-label={label}
          title={label}
        >
          <span className="lbl">{label}</span>
          <span className="abbr" aria-hidden="true">{label.slice(0, 1)}</span>
        </Link>
      ))}
    </>
  );
}

export default RailNav;
