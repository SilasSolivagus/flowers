'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { THEME_COOKIE, type ThemePref } from './theme-pref';

/**
 * 顶栏的主题开关：随系统 → 浅色 → 深色 → 随系统。
 *
 * 为什么是三个值而不是一个二元开关：silas-UX 的深色是一套**配套组**，不是把浅色
 * 反相。有人用系统深色但不希望这一页跟；也有人反过来。三档才两个愿望都装得下。
 *
 * 点一下做三件事（与 `RailToggle` 同一条规矩）：
 * 1. 写 cookie —— 下一次导航 / 刷新时服务端画出来的 `<html>` 就是对的；
 * 2. 立刻改 `document.documentElement.dataset.theme` —— 不等 RSC 往返；
 * 3. `router.refresh()` —— 让服务端那一份与 cookie 对齐。
 *
 * 'system' 时把属性**删掉**，不是写成 "system"：CSS 里 `@media (prefers-color-scheme)`
 * 那条规则的前置是 `:root:not([data-theme])`，属性存在就轮不到它。
 */
/** 三档的顺序写成一个表，而不是数组下标 +1：下标越界在 TS 里是 `undefined`，得再兜一次。 */
const NEXT: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };

const LABEL: Record<ThemePref, string> = {
  system: '随系统',
  light: '浅色',
  dark: '深色',
};

/** 下一档的名字就是按钮的无障碍名字——「点下去会变成什么」比「现在是什么」更有用。 */
const NEXT_NAME: Record<ThemePref, string> = {
  system: '切换到浅色',
  light: '切换到深色',
  dark: '切换到随系统',
};

export function ThemeToggle({ initial }: { initial: ThemePref }) {
  const router = useRouter();
  const [pref, setPref] = useState<ThemePref>(initial);

  function toggle() {
    const next = NEXT[pref];
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    if (next === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    setPref(next);
    router.refresh();
  }

  return (
    <button
      type="button"
      className="themetoggle"
      onClick={toggle}
      aria-label={NEXT_NAME[pref]}
      title={NEXT_NAME[pref]}
    >
      {LABEL[pref]}
    </button>
  );
}

export default ThemeToggle;
