'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * 看板的横向滚动壳：`.board` 这一层（`overflow-x:auto` 就在它身上）。
 *
 * 为什么需要客户端组件：一只普通鼠标只有纵向滚轮，而一块 10 列、每列 220px 的板子
 * 注定比视口宽——不接管的话，滚轮在这块板上什么都不会发生，用户只能去够底部那条
 * 细滚动条（手机上则完全没有）。接管规则只有一条：
 *
 * - `deltaX !== 0` → **不动**。触控板的横滑手势已经在横着滚了，再拿它做一次
 *   `scrollLeft += deltaX` 就会双倍速（手指划一个像素，板子走两个）。
 * - 到头的方向 → **不动、也不 preventDefault**。这里是「把滚动还给页面」的意思：
 *   板子已经在最右还继续往右推，浏览器要么把纵向滚动交给页面，要么什么都不做；
 *   `.board` 上的 `overscroll-behavior-x:contain` 保证它不会滑成浏览器的前进/后退。
 * - 其余情况 → `scrollLeft += deltaY` 并 `preventDefault()`，页面不跟着动。
 *
 * 监听器必须原生挂（`{passive:false}`）：React 的 onWheel 是被动监听，
 * 里面 `preventDefault()` 只会得到控制台一句 "Unable to preventDefault inside
 * passive event listener"，页面照旧滚。
 *
 * `deltaMode` 也要算：Firefox 的滚轮常报「按行」（1）或「按页」（2），
 * 直接加 3 个像素等于没滚。
 */
export function BoardScroller({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const board = ref.current;
    if (!board) return;

    function onWheel(event: WheelEvent) {
      if (ref.current === null) return;
      if (event.deltaX !== 0 || event.deltaY === 0) return;
      const max = ref.current.scrollWidth - ref.current.clientWidth;
      if (max <= 0) return;

      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? ref.current.clientWidth : 1;
      const delta = event.deltaY * unit;
      const atStart = delta < 0 && ref.current.scrollLeft <= 0;
      const atEnd = delta > 0 && ref.current.scrollLeft >= max - 1;
      if (atStart || atEnd) return;

      ref.current.scrollLeft += delta;
      event.preventDefault();
    }

    board.addEventListener('wheel', onWheel, { passive: false });
    return () => board.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="board" ref={ref}>
      {children}
    </div>
  );
}

export default BoardScroller;
