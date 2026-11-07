'use client';

import { useActionState } from 'react';

import { claimAction, type ActionResult } from '../actions';

const IDLE: ActionResult = { ok: true };

/** `useActionState` 要的是 `(prev, formData)` 的形状，`claimAction` 只有 formData。 */
async function submit(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  return claimAction(formData);
}

/**
 * 卡片上的「认领」。
 *
 * 它是**卡片链接里面的一个按钮**，所以两件事必须自己处理：
 * - `preventDefault` + `stopPropagation`：不这么做，点下去会先跳进抽屉，
 *   再做认领——一次点击两个动作，而其中一个会把另一个的状态盖掉；
 * - 按钮自己提交一个 server action（不是链接），认领成功由 revalidate 把这张卡
 *   从「收集」搬到「待设计」，卡片跟着消失。
 *
 * 认领的权限判断**不在这里**：`BoardCard.claimable` 由读模型问过 `can()`。
 * 这里只负责「点了会发生什么」，不负责「该不该出现」。
 */
export function ClaimButton({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState(submit, IDLE);

  return (
    <form
      action={formAction}
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
      className="claim"
    >
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        className="claimbtn"
        disabled={pending}
        onClick={(event) => event.stopPropagation()}
      >
        {pending ? '认领中' : (state.ok ? '认领' : state.message)}
      </button>
    </form>
  );
}

export default ClaimButton;
