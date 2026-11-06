'use client';

import { useActionState, useEffect, useState } from 'react';
import type { DetailAction } from '../../src/core/read/detail';
import { runAction } from '../actions';
import type { ActionResult } from '../actions';

/**
 * 动作条：抽屉的第六段，也是唯一有交互的那一段。
 *
 * 三件事只在这里定：
 * 1. **哪些动作**——完全由 `detail.actions` 决定（读模型按状态给出的合法集合，
 *    页面不重算、不排序、不补一个「顺手也做得到」的动作）。
 * 2. **每个动作要哪些字段**——`FIELDS` 就是一张表，字段名与领域服务的入参同名字段
 *    一致（`prdUrl` / `reason` / `releaseId` / `commitAt` …），不再起别名。
 * 3. **失败的那句话落在哪**——动作条上方、抽屉里面。不是 toast，不是 sheet 里：
 *    服务拒绝（'不是这条需求的评审人'）是关于这条需求的事实，应该留在它自己的抽屉上，
 *    和动作条一起被读到，刷新也不会消失到别处去。
 */

/** 提交前的状态。`ok: true` 表示「还没失败过」，界面不渲染任何成功提示。 */
const IDLE: ActionResult = { ok: true };

/**
 * 动作名就是中文按钮名。同一个状态里不会同时出现两个同名的动作（打回分属评审/测试两态）。
 *
 * `evaluate`（评估）留在这张表里只是为了让 `Record<DetailAction, …>` 完整：读模型已经
 * 不再把它列进任何状态的动作条（P2 Task 4：它不是一次点击就能完成的动作，材料要生成）。
 * 评估的入口在抽屉「参考」段评估材料那一行的「生成」（P2.6 起由服务端跑生成器）。
 * 删掉这里的键会连类型并集一起动，而 `runAction` 仍然接得住这个领域动作
 * （`inbox → design` 是合法迁移，seed 就走它）。
 */
const LABEL: Record<DetailAction, string> = {
  evaluate: '评估',
  submitReview: '提交评审',
  reviewPass: '通过',
  reviewReject: '打回',
  schedule: '排期',
  bounce: '打回',
  reject: '拒绝',
  shelve: '搁置',
  restore: '恢复',
};

type Field = {
  /** 表单字段名，同时也是领域服务入参的字段名。 */
  name: string;
  label: string;
  kind: 'text' | 'date' | 'release';
};

/**
 * 每个动作的表单。空数组 = 这个动作没有要填的东西，点下去直接提交（不弹一个空表格）。
 *
 * 排期的版本是下拉、两个日期是 date 输入：领域层那三道门（缺字段 / 日期倒序 /
 * 晚于发版日）因此都还走得到——表单不做客户端预校验，失败原因由服务说。
 */
const FIELDS: Record<DetailAction, Field[]> = {
  evaluate: [],
  submitReview: [{ name: 'prdUrl', label: 'PRD 链接', kind: 'text' }],
  reviewPass: [],
  reviewReject: [{ name: 'reason', label: '原因', kind: 'text' }],
  schedule: [
    { name: 'releaseId', label: '版本', kind: 'release' },
    { name: 'commitTestAt', label: '提测日', kind: 'date' },
    { name: 'commitDueAt', label: '承诺完成日', kind: 'date' },
  ],
  bounce: [
    { name: 'reason', label: '原因', kind: 'text' },
    { name: 'newCommitDueAt', label: '承诺完成日', kind: 'date' },
  ],
  reject: [{ name: 'reason', label: '原因', kind: 'text' }],
  shelve: [{ name: 'reason', label: '原因', kind: 'text' }],
  restore: [],
};

/** 排期表单里的一个版本选项。展示文案在读模型那边就拼好，这里不再算日期。 */
export type ReleaseOption = { id: string; name: string; window: string };

/**
 * `useActionState` 的动作签名是 `(prevState, payload)`，而 `app/actions.ts` 里每个
 * 动作都是 `(formData) => Promise<ActionResult>`（计划里定的形状）。这一层就是两者
 * 之间的一行适配：上一状态不参与判断，失败消息由这次的返回值决定。
 */
async function submit(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(formData);
}

/** 提交那一刻表单里的字段值原样记下来（失败后要把它们放回输入框）。 */
function readForm(form: HTMLFormElement | null): Record<string, string> {
  const values: Record<string, string> = {};
  if (form === null) return values;
  for (const [key, value] of new FormData(form).entries()) values[key] = String(value);
  return values;
}

export function ActionBar({
  id, actions, releases,
}: { id: string; actions: DetailAction[]; releases: ReleaseOption[] }) {
  const [state, formAction, pending] = useActionState(submit, IDLE);
  const [open, setOpen] = useState<DetailAction | null>(null);
  /** 最近一次提交的是哪个动作，以及它提交出去的字段值。 */
  const [last, setLast] = useState<{ action: DetailAction; values: Record<string, string> } | null>(null);

  // 只有成功才收起表单。失败必须留在原地：PRD 链接、两个日期是这界面上最贵的输入，
  // 关掉表单等于把它们扔掉，而用户还要一边看着原因一边改。
  useEffect(() => { if (state.ok) setOpen(null); }, [state]);

  const message = state.ok ? null : state.message;

  // 当前动作已经不在合法集合里（时钟把这条需求推进了、或同事先做了一步）→ 这张表单
  // 整个不渲染：它上面的按钮再点一次只会撞同一个 illegal_transition。这条同时是
  // 「提交成功后表单自己消失」的机械保证——每一种迁移都会换掉合法动作集合。
  const sheet = open !== null && actions.includes(open) ? open : null;
  // 失败的是这张表单才回填它的字段值、才在表单里显示那句话；换一个动作就是干净的一张表。
  const seed = last !== null && last.action === sheet ? last.values : {};
  const sheetMessage = last !== null && last.action === sheet ? message : null;

  function remember(action: DetailAction, form: HTMLFormElement | null) {
    setLast({ action, values: readForm(form) });
  }

  return (
    <>
      <div className="dfoot">
        {/* 失败的原文照登：领域层的中文消息就是给用户看的，不再包一层「操作失败」。
            这一处是唯一的 alert 区域——表单里会再显示一遍同一句话（那份只是文字，
            不再 alert 一次，否则读屏会听见两遍）。 */}
        {message !== null && <div className="dfail" role="alert">{message}</div>}
        <div className="db">
          {actions.map((action) => (
            FIELDS[action].length === 0 ? (
              // 无字段的动作：点下去就是一次表单提交（不是按钮上挂事件）
              <form
                className="act"
                action={formAction}
                key={action}
                onSubmit={(event) => remember(action, event.currentTarget)}
              >
                <input type="hidden" name="act" value={action} />
                <input type="hidden" name="id" value={id} />
                <button className="btn" type="submit" disabled={pending}>{LABEL[action]}</button>
              </form>
            ) : (
              <button
                className="btn"
                type="button"
                key={action}
                disabled={pending}
                onClick={() => setOpen(action)}
              >
                {LABEL[action]}
              </button>
            )
          ))}
          <span className="sp" />
        </div>
      </div>

      {sheet !== null && (
        <div
          className="sheet on"
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(null);
          }}
        >
          <div className="box">
            <form action={formAction} onSubmit={(event) => remember(sheet, event.currentTarget)}>
              <input type="hidden" name="act" value={sheet} />
              <input type="hidden" name="id" value={id} />
              <div className="h">{LABEL[sheet]}</div>
              {sheetMessage !== null && <div className="dfail">{sheetMessage}</div>}
              {FIELDS[sheet].length > 0 && (
                <div className="b">
                  {FIELDS[sheet].map((f) => (
                    <div className="fld" key={f.name}>
                      <label htmlFor={`field-${f.name}`}>{f.label}</label>
                      {f.kind === 'release' ? (
                        <select
                          id={`field-${f.name}`}
                          name={f.name}
                          defaultValue={seed[f.name] ?? releases[0]?.id}
                        >
                          {releases.map((r) => (
                            <option key={r.id} value={r.id}>{r.name} · {r.window}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          id={`field-${f.name}`}
                          name={f.name}
                          type={f.kind}
                          defaultValue={seed[f.name] ?? ''}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="f">
                <button className="btn" type="button" onClick={() => setOpen(null)}>取消</button>
                <button className="btn primary" type="submit" disabled={pending}>
                  {LABEL[sheet]}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

export default ActionBar;
