'use client';

import { usePathname } from 'next/navigation';

import { pageTitle } from './sections';

/**
 * 顶栏的页面标题。
 *
 * 为什么是一个 client component，而不是在每个页面里写一个 `title` 值：
 *
 * 1. **只有一份**。左轨是导航、顶栏只回答「你在哪一页」，那个答案已经由路径决定了；
 *    让三个页面各自 export 一个字符串，就是把同一个事实写三遍，第四页忘了写就又变回
 *    一个空顶栏（这次修的正是它）。
 * 2. **不跟服务端往返**。`usePathname()` 在客户端导航时就换了值，标题与内容同帧到位；
 *    走 prop 的话，切页的第一帧里标题还是上一页的（`<Link>` 的预取与 RSC 回来的
 *    那一刻之间），那一下闪烁比空顶栏更刺眼。
 * 3. 代价只有一行 JS：这个组件没有 state、没有 effect，服务端渲染的第一帧就带着
 *    正确的字（usePathname 在 RSC 渲染时也能拿到），不是「先空后填」。
 *
 * 中文名不在这里写：路径 → 中文的翻译表在 `./sections.ts`，与左轨共用同一份。
 */
export function PageTitle() {
  const pathname = usePathname();
  return <h1>{pageTitle(pathname)}</h1>;
}

export default PageTitle;
