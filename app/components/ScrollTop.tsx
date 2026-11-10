'use client';

import { useEffect } from 'react';

/**
 * 抽屉打开时把内容滚回顶部（2026-11-11）。
 *
 * 事故：owner 截图里抽屉一打开就停在「现在怎么做 / 哪不好」那一行，上面「谁在什么
 * 情况下用」被滚出视野，于是他以为六问少了一问。内容一直都在（六格在 DOM 里），
 * 缺的是「打开时从哪一行开始读」。
 *
 * 为什么用 effect 改父节点的 scrollTop 而不是给 `.dbody` 加 `scroll-behavior`：
 * 这个容器的滚动位置会跨抽屉复用（同一个 DOM，换 `?open=` 只换内容），所以必须在
 * 每次挂载时显式归零。`scroll-behavior: smooth` 会让它归零时抖一下，这里要的是
 * **立刻**回到第一行。
 */
export function ScrollTop() {
  useEffect(() => {
    const body = document.querySelector('.drawer .dbody');
    if (body !== null) body.scrollTop = 0;
  }, []);
  return null;
}

export default ScrollTop;
