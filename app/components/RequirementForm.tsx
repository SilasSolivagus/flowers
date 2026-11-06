'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Member } from '../../src/core/read/member';
import { DESCRIPTIVE_FIELDS, hintFor } from '../../src/core/requirements/fields';
import {
  createRequirementAction, deleteRequirementAction, updateRequirementAction,
} from '../actions';
import type { EntryResult } from '../actions';

/**
 * 新建 / 编辑需求的表单（P4-02 的录入面）。
 *
 * 一个组件两种形态，因为两者只差三件事：
 * 1. **字段集合**：新建有标题 + 类型 + 提出人 + 负责人 + 六问；编辑**只有**标题 + 六问。
 *    类型 / 提出人 / 负责人不在编辑表单里是 owner 的决定（不可改），服务层对它们
 *    报 `not_editable` 而不是静默忽略——所以这里连字段都不渲染，两处口径一致。
 * 2. **提交目标**：`createRequirementAction` / `updateRequirementAction`。
 * 3. **脚注**：编辑多一个「删除」（软删）。
 *
 * 三条从任务书来的硬要求：
 * - **不是一个全屏接管**：它是 `.sheet` 中间那块 720px 的框（与抽屉里排期、交回材料
 *   同一个壳），背后看板还在。
 * - **新建只要标题 / 类型 / 提出人**：六问可空。校验只有服务端一份（`createRequirement`
 *   的 zod），这里不预校验——预校验会让「必填」有两个来源，而两个来源迟早不一致。
 * - **策略提示只在「空着且动过」时出现**：`touched` 记的是**离开过**那个框，不是
 *   「打开页面」。一打开就红一片提示，等于把六个问题都变成必填。
 *
 * 保存成功后跳哪：`/?open=<id>`。新建之后最想知道的是「我刚写的那几问长什么样」；
 * 编辑之后要看到的是「产物那三行翻成『需求已更新』」。两个答案都在抽屉里。
 */
export type RequirementFormProps = {
  mode: 'create' | 'edit';
  /** 名册（负责人下拉）。 */
  members: Member[];
  /** 当前成员：新建时提出人 / 负责人的初值（提出人本来就是自由文本，这里是顺手的默认）。 */
  me: string;
  /** 取消时回到哪（看板 / 抽屉）。 */
  closeHref: string;
  initial?: {
    id: string;
    number: number;
    title: string;
    type: string;
    requester: string;
    ownerMemberId: string | null;
    description: {
      context: string | null;
      problem: string | null;
      outcome: string | null;
      surfaces: string | null;
      edgeCases: string | null;
      outOfScope: string | null;
    };
  };
};

/** 六问的初值：编辑时来自那条需求，新建时全空。 */
function initialValues(initial: RequirementFormProps['initial']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of DESCRIPTIVE_FIELDS) {
    out[field.key] = initial?.description[field.key] ?? '';
  }
  return out;
}

const IDLE: EntryResult = { ok: true, id: '' };

export function RequirementForm({ mode, members, me, closeHref, initial }: RequirementFormProps) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(initial));
  const [title, setTitle] = useState(initial?.title ?? '');
  const [type, setType] = useState(initial?.type ?? 'feature');
  const [requester, setRequester] = useState(initial?.requester ?? me);
  const [owner, setOwner] = useState(initial?.ownerMemberId ?? '');
  /** 离开过哪些框：只有这些框的提示才出现（见文件头第 3 条）。 */
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [deleting, setDeleting] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const [state, formAction, pending] = useActionState(
    async (_prev: EntryResult, formData: FormData): Promise<EntryResult> => (
      mode === 'create'
        ? createRequirementAction(formData)
        : updateRequirementAction(formData)
    ),
    IDLE,
  );

  // 保存成功 → 进抽屉。`id === ''` 是初值，不跳（否则一挂载就跳到 /?open=）。
  useEffect(() => {
    if (state.ok && state.id !== '') router.push(`/?open=${state.id}`);
  }, [state, router]);

  const message = state.ok ? null : state.message;

  const close = () => router.push(closeHref);

  const remove = async () => {
    if (initial === undefined) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setDeleting(true);
    const form = new FormData();
    form.set('id', initial.id);
    const result = await deleteRequirementAction(form);
    setDeleting(false);
    if (result.ok) router.push('/');
  };

  return (
    <div
      className="sheet on"
      role="dialog"
      aria-modal="true"
      aria-label={mode === 'create' ? '新建需求' : '编辑描述'}
      onClick={(event) => {
        // 点框外 = 关闭（与抽屉的 scrim、动作条的 sheet 同一个行为）。
        if (event.target === event.currentTarget) close();
      }}
    >
      <form className="box wide" action={formAction}>
        {/* 编辑时服务端要知道改的是哪一条。表单里没有「可见的 id」，但**必须有**这一个
            隐藏字段：服务层的 `parseRequirementId` 读的就是 `id`，缺了它每次保存都会
            报「需求 ID 格式不正确」——一个看起来像 bug 的校验错误。 */}
        {mode === 'edit' && initial !== undefined && (
          <input type="hidden" name="id" value={initial.id} />
        )}
        <div className="h">
          <b>{mode === 'create' ? '新建需求' : `编辑 PAN-${initial?.number ?? ''}`}</b>
          <button type="button" className="x" onClick={close} aria-label="关闭">✕</button>
        </div>

        <div className="b">
          <div className="fld">
            <label htmlFor="req-title">标题</label>
            <input
              id="req-title"
              name="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoComplete="off"
            />
          </div>

          {/* 类型 / 提出人 / 负责人只在新建时出现：它们是「这条需求是什么、归谁」，
              不是「它要做什么」。编辑描述不该顺手改分类（owner 的裁决）。 */}
          {mode === 'create' && (
            <>
              <div className="two">
                <div className="fld">
                  <label htmlFor="req-type">类型</label>
                  <select
                    id="req-type"
                    name="type"
                    value={type}
                    onChange={(event) => setType(event.target.value)}
                  >
                    <option value="feature">功能</option>
                    <option value="commercial">商业</option>
                  </select>
                </div>
                <div className="fld">
                  <label htmlFor="req-requester">提出人</label>
                  <input
                    id="req-requester"
                    name="requester"
                    value={requester}
                    onChange={(event) => setRequester(event.target.value)}
                    autoComplete="off"
                  />
                </div>
              </div>
              <div className="fld">
                <label htmlFor="req-owner">负责人</label>
                <select
                  id="req-owner"
                  name="ownerMemberId"
                  value={owner}
                  onChange={(event) => setOwner(event.target.value)}
                >
                  <option value="">未指定</option>
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>{member.name}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          {/* 六问。标签就是问题本身（见 `fields.ts`），提示只在「空着且离开过」时出现。 */}
          {DESCRIPTIVE_FIELDS.map((field) => {
            const value = values[field.key] ?? '';
            const hint = touched[field.key] ? hintFor(field, value, type) : null;
            return (
              <div className="fld" key={field.key}>
                <label htmlFor={`req-${field.key}`}>{field.label}</label>
                <textarea
                  id={`req-${field.key}`}
                  name={field.key}
                  value={value}
                  rows={2}
                  onChange={(event) => setValues((was) => ({ ...was, [field.key]: event.target.value }))}
                  onBlur={() => setTouched((was) => ({ ...was, [field.key]: true }))}
                />
                {hint !== null && <div className="hintline">{hint}</div>}
              </div>
            );
          })}

          {message !== null && <div className="dfail">{message}</div>}
        </div>

        <div className="f">
          {mode === 'edit' && (
            <button
              type="button"
              className="btn ghost danger"
              onClick={() => void remove()}
              disabled={deleting || pending}
            >
              {deleteArmed ? '真的删除' : '删除'}
            </button>
          )}
          <button type="button" className="btn" onClick={close}>取消</button>
          <button className="btn primary" type="submit" disabled={pending}>
            {mode === 'create' ? '创建' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default RequirementForm;
