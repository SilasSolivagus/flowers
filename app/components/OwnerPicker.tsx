'use client';

import { useActionState, useEffect, useState } from 'react';
import type { Member } from '../../src/core/read/member';
import { reassignOwnerAction, type ActionResult } from '../actions';
import { lineLabel, roleLabel } from '../settings/roles';

/**
 * 抽屉「信息」段负责人那一行的「改」（P4-05）。
 *
 * 只有 `detail.permissions.reassignOwner` 为真时才挂出来（超管 / 本条线负责人）：
 * 按钮显不显示是一个判断，能不能真转交是另一个判断——两个都来自
 * `can('reassignOwner')`，一个在服务端读模型里算（这里只读结果），一个在
 * `reassignOwner` 服务里再判一次。
 *
 * 下拉里的候选由读模型给（`ownerCandidates`）：超管看全名册，条线负责人只看本线。
 * 这里不再筛一遍——筛两遍就会出现「界面摆了一个服务不接受的选项」。
 */

const IDLE: ActionResult = { ok: true };

async function submit(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  return reassignOwnerAction(formData);
}

export function OwnerPicker({
  id, owner, members,
}: { id: string; owner: string | null; members: Member[] }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(submit, IDLE);

  // 成功就收起：那一行的名字由服务端重新渲染后已经是新人，不需要额外提示。
  useEffect(() => { if (state.ok) setOpen(false); }, [state]);

  const message = state.ok ? null : state.message;

  return (
    <>
      <button
        className="owner-pick"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        改
      </button>
      {open && (
        <div
          className="sheet on"
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div className="box">
            <form action={formAction}>
              <input type="hidden" name="id" value={id} />
              <div className="h">负责人</div>
              {message !== null && <div className="dfail">{message}</div>}
              <div className="b">
                <div className="fld">
                  <label htmlFor={`owner-${id}`}>负责人</label>
                  <select id={`owner-${id}`} name="ownerMemberId" defaultValue={owner ?? undefined}>
                    {members.map((member) => (
                      <option key={member.id} value={member.id}>
                        {[member.name, roleLabel(member.role), lineLabel(member.line)]
                          .filter((part) => part !== '').join(' · ')}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="f">
                <button className="btn" type="button" onClick={() => setOpen(false)}>取消</button>
                <button className="btn primary" type="submit" disabled={pending}>保存</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

export default OwnerPicker;
