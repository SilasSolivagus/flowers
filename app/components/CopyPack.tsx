'use client';

import { useEffect, useState } from 'react';

/**
 * 参考段那一行右侧的按钮：复制服务端已经渲染进页面的任务包。
 *
 * 三件事只在这里定：
 * 1. **文本从哪来**——DOM。服务端的 `RefRow` 把 `packFor` 的结果写进一个
 *    `<pre hidden>`，这个按钮按 id 取它的 `textContent`。所以复制是「读页面里已有的
 *    一段字符串」，不是一次请求、不是一次渲染、也不需要在客户端重新算包。
 * 2. **成功长什么样**——按钮自己变 1.5 秒的「已复制」。界面不给解释性文案：一句
 *    「已复制到剪贴板，粘贴给你的 agent」就是这一段设计里唯一被禁的东西。
 * 3. **失败长什么样**——不变。宁可什么都不说，也不要弹一个「复制失败」的 toast，
 *    更不要在失败时假装成功。
 */

/** 反馈停留时长：够看见，不够到需要读第二行。 */
const COPIED_MS = 1500;

/**
 * 写剪贴板，两条路。
 *
 * `navigator.clipboard` 需要安全上下文与权限；被拒时退到 `execCommand('copy')`
 * ——它老、已废弃，但在一张普通页面上按用户手势调用仍然有效，且同样只复制那段文本。
 * 两条都失败就返回 false（按钮不显示「已复制」）。
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '0';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyPack({ packId }: { packId: string }) {
  const [copied, setCopied] = useState(false);

  // 1.5 秒后自己回到「复制任务包」。依赖里带 copied：连点两次会重新计时，
  // 而不是第二次点击被前一次的定时器提前收尾。
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      className="btn copy"
      type="button"
      onClick={async () => {
        const text = document.getElementById(packId)?.textContent ?? '';
        // 空字符串不写剪贴板：那会把用户原来复制的东西抹掉，而页面上什么都没给出。
        if (text === '') return;
        if (await writeClipboard(text)) setCopied(true);
      }}
    >
      {copied ? '已复制' : '复制任务包'}
    </button>
  );
}

export default CopyPack;
