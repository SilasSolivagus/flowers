import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

import { RAIL_COOKIE, railFromCookie } from './components/rail-pref';
import './globals.css';

export const metadata: Metadata = {
  title: 'Flower · 需求门禁',
  description: '123云盘 · 产品研发需求门禁',
};

/**
 * 根布局：只有 `<html>` / `<body>` 和全局样式。
 *
 * ── 为什么 P4-04 把它掏空
 *
 * 登录页必须**没有**左轨、顶栏、铃铛、进度卡——那样一页里出现「吕品 / PM」的身份块，
 * 等于告诉一个还没登录的人「你现在是谁」。而根布局对 `/login` 也生效，所以外壳
 * （应用框架）不能住在这里。
 *
 * 它现在住在 `app/components/Shell.tsx`：有身份的页面各自包一层。这一层是**权限边界
 * 的一部分**——`Shell` 第一件事是 `requireSession()`，没有会话就 `redirect('/login')`。
 * 换句话说：一个页面只要渲染在 `Shell` 里，它就不可能被未登录的人看到。
 *
 * 根布局只保留一件与身份无关的偏好：左轨宽度（`data-rail`）。它必须写在
 * `<html>` 上，因为折叠档的 CSS 选择器从根元素切（`html[data-rail="collapsed"] .shell`），
 * 而 `RailToggle` 点下去要能立刻改一个现成的属性、不等 RSC 往返。
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  const rail = railFromCookie(jar.get(RAIL_COOKIE)?.value);

  return (
    <html lang="zh-CN" data-rail={rail}>
      {/*
        suppressHydrationWarning 是给**浏览器扩展**用的，不是给我们的标记用的：装着的
        扩展会往 <body> 上注入属性（线上那一例是 `data-atm-ext-installed`），而
        React 的水合对比会在下面每一条属性上做严格比对，于是 Next 的「1 Issue」
        徽标亮起、报的是一处 hydration mismatch——错的不是这一棵树的任何一行代码。
      */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
