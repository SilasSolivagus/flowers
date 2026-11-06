'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { RAIL_COOKIE, type RailPref } from './rail-pref';

/**
 * 左轨顶部的折叠开关。
 *
 * 「现在是不是收起状态」只有一个事实来源：**左轨实际有多宽**。cookie 答不了这个问题
 * ——没有 cookie 时桌面展开、手机收起，而服务端不知道视口（见 rail-pref.ts）。
 * 所以这里挂在 `.rail` 上量宽度（ResizeObserver），而不是自己推一份状态：
 * 视口变化、cookie 变化、CSS 断点变化，量出来的都是真的那一个。
 *
 * 点一下做三件事，缺一件就会露馅：
 * 1. 写 cookie —— 下一次导航 / 刷新时服务端画出来的第一帧就是对的；
 * 2. 立刻改 `html[data-rail]` —— 等下一次 RSC 往返太慢，这一下是即时的（CSS 的
 *    `--rail-w` 靠这个属性切换）；
 * 3. `router.refresh()` —— 让服务端那一份与新 cookie 对齐，顺带把 `title` /
 *    `aria-label` 这些 React 管的东西一起更新（它们由 state 驱动，不是 CSS）。
 *
 * 可见字是「收起 / 展开」，收起时只剩第一个字（56px 的左轨放不下两个字）。
 * 无障碍名字始终是完整的「收起侧栏 / 展开侧栏」：收起后 `<span>` 里的字被 CSS
 * 藏掉了，光靠它读屏用户读不出这个按钮是干什么的。
 */
export function RailToggle({ initial }: { initial: RailPref }) {
  const router = useRouter();
  const ref = useRef<HTMLButtonElement>(null);
  const [collapsed, setCollapsed] = useState(initial === 'collapsed');

  useEffect(() => {
    const rail = ref.current?.closest('.rail');
    if (!rail) return;
    // 100px 是个「两个档位之间」的中位数：档位只有 56 与 184，不会骑在上面。
    const measure = () => setCollapsed(rail.getBoundingClientRect().width < 100);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    return () => observer.disconnect();
  }, []);

  function toggle() {
    const next: RailPref = collapsed ? 'open' : 'collapsed';
    document.cookie = `${RAIL_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.dataset.rail = next;
    setCollapsed(next === 'collapsed');
    router.refresh();
  }

  const name = collapsed ? '展开侧栏' : '收起侧栏';

  return (
    <button
      ref={ref}
      type="button"
      className="railtoggle"
      onClick={toggle}
      aria-expanded={!collapsed}
      aria-label={name}
      title={name}
    >
      {collapsed ? '展' : '收起'}
    </button>
  );
}

export default RailToggle;
