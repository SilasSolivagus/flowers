'use client';

import { useActionState } from 'react';
import { claimAction, type ActionResult } from '../actions';

/**
 * 「认领」（P4-06）：抽屉「信息」段负责人那一行，当这条需求还没有负责人时出现。
 *
 * 只有 `detail.permissions.claim` 为真时才挂出来——那是 `can('claim')` 的结论：
 * 没有负责人，而且这个人是 PM / 条线负责人 / 超管。按钮显不显示是一个判断，
 * 能不能真认领是另一个判断（服务层 `claimRequirement` 再判一次），两个都来自同一格。
 *
 * 没有弹窗：认领不需要填任何东西（不像转交要挑人），多一层确认只会让「立个项」
 * 变成三次点击。失败的那句话落在按钮旁边，因为它是关于这一行的（「这条需求已经有
 * 负责人了」——你看到它的时候，那一行的名字通常已经变了）。
 */

const IDLE: ActionResult = { ok: true };

async function submit(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  return claimAction(formData);
}

export function ClaimButton({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState(submit, IDLE);

  return (
    <form className="claim" action={formAction}>
      <input type="hidden" name="id" value={id} />
      <button className="owner-pick" type="submit" disabled={pending}>认领</button>
      {!state.ok && <span className="dfail">{state.message}</span>}
    </form>
  );
}

export default ClaimButton;
