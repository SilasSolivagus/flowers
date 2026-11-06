'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Failure } from '../../src/core/uemaster/trace';

/**
 * 一次**终端失败**的浮层提示（P2.13）。
 *
 * 为什么要有它，而行里那句「生成失败：…」不够：生成是一次要等几十秒到几分钟的动作，
 * 点完按钮去看别的东西是常态。回到抽屉时，那一行确实还写着原因——但如果他根本没回到
 * 抽屉，那一行就等于没写过。浮层是**瞬时**的那一声（6 秒后自己走），行里那句是**留档**的那一句
 * （刷新前一直在）。两句话不是重复，是两个时间尺度。
 *
 * 四条规矩：
 * 1. **一行标题 + 可选一行原文**。标题是分类过的中文（`这个 key 余额不足`），
 *    第二行只在服务端那句比标题多带信息时出现——不重复、也不替它说话。
 * 2. **6 秒后自己消失**，但右上角的 ✕ 随时能关：有人就是想马上清掉它。
 * 3. **永远不含 key**。`classifyFailure` 进来先洗一遍（`scrubSecret`）；这里再洗一遍
 *    是因为这个组件的 props 是公开的，将来别的调用方也可能塞一段原文进来。
 * 4. **挂到 body 上**（portal）。抽屉在 `.drawer` 里，它有 `transform`（进场动画），
 *    一个 `position:fixed` 的后代一旦落在有 transform 的祖先里，就会相对那个祖先定位——
 *    浮层会跟着抽屉跑偏。portal 让「固定」真的是固定。
 */
export const TOAST_MS = 6000;

/** 标题与原文都过一遍同一支洗笔：两行的来源是一样的，不能只洗一行。 */
function clean(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]{4,}/gi, 'sk-***');
}

export function Toast({
  failure, onClose, ms = TOAST_MS,
}: {
  failure: Failure;
  onClose: () => void;
  /** 只给用例与走查用；默认 6 秒。 */
  ms?: number;
}) {
  // 服务端没有 document：首帧不渲染，挂载之后再 portal（同步一次 effect，没有闪烁）。
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const timer = setTimeout(onClose, ms);
    return () => clearTimeout(timer);
  }, [ms, onClose]);

  if (!mounted) return null;

  const title = clean(failure.title);
  const detail = failure.detail === undefined ? null : clean(failure.detail);

  return createPortal(
    <div className="toast" role="status" aria-live="polite">
      <div className="toast-t">{title}</div>
      {detail !== null && <div className="toast-d">{detail}</div>}
      <button className="toast-x" type="button" onClick={onClose} aria-label="关闭">✕</button>
    </div>,
    document.body,
  );
}

export default Toast;
