'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** 左轨的三个入口。aria-current 供 views.css 的 `.rail > a[aria-current="true"]` 高亮当前页。 */
const ENTRIES = [
  { href: '/', label: '需求' },
  { href: '/releases', label: '版本' },
  { href: '/settings', label: '设置' },
] as const;

export function RailNav() {
  const pathname = usePathname();

  return (
    <>
      {ENTRIES.map(({ href, label }) => {
        const current = href === '/' ? pathname === '/' : pathname.startsWith(href);
        return (
          <Link key={href} href={href} aria-current={current ? 'true' : undefined}>
            {label}
          </Link>
        );
      })}
    </>
  );
}

export default RailNav;
