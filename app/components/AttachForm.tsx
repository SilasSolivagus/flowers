'use client';

import { useActionState, useEffect, useState } from 'react';
import { attachAction, type ActionResult } from '../actions';

/**
 * 参考段那一行右侧的「交回材料」：一条**人**能走的路。
 *
 * MCP 那条路要求先接上 agent；一个把任务包拿到别处跑完的人，回到这里只能看着一行
 * 「复制任务包」——他有材料，没有入口。这个按钮就是入口：两条进法，共用一个服务端
 * 动作 `attachAction`（领域层只有 `attachArtifact` 一处写路径，这里不新增第二条）。
 *
 * 界面的三条规矩与动作条一致：
 * 1. **复用动作条的 sheet**：同一套 `.sheet .box .h .b .fld .f .dfail`，不新造一层
 *    弹窗样式——抽屉里同时存在两种形状的对话框是最没必要的不一致。
 * 2. **失败原文照登**：`AppError` 的中文消息（`产物文件不存在…`、`只收 .html 文件`、
 *    `文件不能超过 5 MB`）就是给用户看的，一个字都不改写、也不吞成「交回失败」。
 *    失败时 sheet 不关：链接与文件是这界面上最贵的输入，关掉等于把它们扔掉。
 * 3. **成功不给提示**：`revalidatePath` 之后那一行自己变成链接 + 日期，那才是结果。
 *    界面上没有一句解释性文案——只有字段名与按钮名。
 */

/** 提交前的状态。`ok: true` = 还没失败过，界面不渲染任何话。 */
const IDLE: ActionResult = { ok: true };

/** `useActionState` 的动作签名是 `(prevState, payload)`，这里适配成 `(formData)`。 */
async function submit(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  return attachAction(formData);
}

export function AttachForm({
  id, number, stage,
}: { id: string; number: number; stage: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn copy" type="button" onClick={() => setOpen(true)}>交回材料</button>
      {/* sheet 只在打开时挂载：`useActionState` 的状态因此随每次打开重置，
          上一次失败的那句话不会跟到下一次（动作条那边是靠 `last.action` 手工区分的）。 */}
      {open && (
        <AttachSheet
          id={id}
          number={number}
          stage={stage}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function AttachSheet({
  id, number, stage, onClose,
}: { id: string; number: number; stage: string; onClose: () => void }) {
  const [state, formAction, pending] = useActionState(submit, IDLE);
  /** 有没有真的提交过一次：`IDLE` 也是 `ok`，不区分就会一打开就自己关掉。 */
  const [sent, setSent] = useState(false);

  // 只有成功才关。失败留在原地，原因显示在表单上方。
  useEffect(() => {
    if (sent && state.ok) onClose();
  }, [sent, state, onClose]);

  const message = state.ok ? null : state.message;

  return (
    <div
      className="sheet on"
      onClick={(event) => {
        // 点遮罩 = 关闭（与动作条的 sheet 同一个行为）；点 box 内部不关。
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="box">
        <form action={formAction} onSubmit={() => setSent(true)}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="stage" value={stage} />
          <input type="hidden" name="number" value={number} />
          <div className="h">交回材料</div>
          {message !== null && <div className="dfail">{message}</div>}
          <div className="b">
            <div className="fld">
              <label htmlFor={`attach-url-${stage}`}>链接</label>
              {/* `type="text"` 而不是 `type="url"`：站内那一种合法形状是
                  `/uemaster/PAN-7/evaluate.html`，而浏览器的 url 校验要求**带 scheme**
                  的绝对 URL——`type="url"` 会把「任务包让 agent 交回来的那种路径」直接
                  拦在提交之外，还不给任何中文提示（原生气泡是一句英文的 "Please enter
                  a URL"）。合法性归领域层（`attachArtifact` 的 invalid_url），它给的是
                  中文，而且知道站内路径也是合法的。 */}
              <input id={`attach-url-${stage}`} name="url" type="text" spellCheck={false} />
            </div>
            <div className="fld">
              <label htmlFor={`attach-file-${stage}`}>文件</label>
              {/* accept 只是浏览器侧的过滤，真正的门在服务端（扩展名 + 5 MB）；
                  两条都填时以文件为准——文件是「我刚生成的那一份」，比一个手打的老链接新。 */}
              <input
                id={`attach-file-${stage}`}
                name="file"
                type="file"
                accept=".html,text/html"
              />
            </div>
          </div>
          <div className="f">
            <button className="btn" type="button" onClick={onClose}>取消</button>
            <button className="btn primary" type="submit" disabled={pending}>交回材料</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AttachForm;
