'use client';

import { useActionState } from 'react';

import { exportQueueAction, type ExportQueueResult } from '../actions';

/** `useActionState` 要的是 `(prev, formData)` 的形状；导出这个动作不需要 formData。 */
async function submit(
  _prev: ExportQueueResult | null,
  _formData: FormData,
): Promise<ExportQueueResult> {
  return exportQueueAction();
}

/**
 * 待排期列头的「导出」（P1b）：按下 → 服务端建一张企微智能表格 → 这一格变成链接，
 * 或者一句中文原因。
 *
 * 三件事刻意留在这个组件之外：
 * - **该不该出现**：由列头问 `column.cards.length` 决定（见 `ColumnHeader`）。没有
 *   待排期就**没有这个按钮**，而不是一个点下去告诉你「没有可导出的行」的按钮。
 * - **导的是什么**：`exportQueue` 查的 `state = 'queue'` 与看板这一列是同一批行，
 *   组件不筛一遍（筛了就会和看板不一致）。
 * - **谁能导**：`exportQueueAction` 先过 `currentMember()`；这个组件不判断权限，
 *   没登录的人根本到不了看板。
 *
 * 失败原因放在按钮下面那一行（而不是只写「导出失败」）：`企微未授权：…`、
 * `命令不存在：…` 都是能照着做下一步的句子，把它们压成四个字等于让用户去问人。
 * 换行人可能看不懂原始错误，那也总比看不见强——它是排查的唯一线索。
 */
export function ExportQueueButton() {
  const [state, formAction, pending] = useActionState(submit, null);
  const done = state !== null && state.ok;

  return (
    <form action={formAction} className="hdexport">
      {done ? (
        state.url === ''
          // CLI 没回链接（只有 docid）：说「已生成」，但不去编一个空链接出来。
          ? <span className="hdlink">已生成 · {state.rows} 行</span>
          : (
            <a className="hdlink" href={state.url} target="_blank" rel="noreferrer">
              已生成 · {state.rows} 行
            </a>
          )
      ) : (
        <button type="submit" disabled={pending}>{pending ? '导出中' : '导出'}</button>
      )}
      {state !== null && !state.ok && (
        <span className="hdfail" title={state.message}>{state.message}</span>
      )}
    </form>
  );
}

export default ExportQueueButton;
