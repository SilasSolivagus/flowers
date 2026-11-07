'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Member } from '../../src/core/read/member';
import { DESCRIPTIVE_FIELDS, hintFor } from '../../src/core/requirements/fields';
import {
  createRequirementAction, deleteRequirementAction, splitDescriptionAction,
  updateRequirementAction,
} from '../actions';
import type { EntryResult, SplitFillResult } from '../actions';
import { PLATFORMS, type PlatformKey } from '../../src/core/requirements/platforms';

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
    /** 平台（P4-08）：chips 的初值。新建时没有这一格（空数组 = 未标注）。 */
    platforms?: string[];
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

/**
 * 「从原文拆六问」的结果（P4-08）：**先给人看，再决定按不按保存**。
 *
 * 三行信息，一行都不许省：
 * 1. 填了几格、空了几格（空的那几格保持空——原文没写，工具不编）；
 * 2. 空的是哪几问，用产品里的标签说（「涉及哪些页面 / 入口」而不是 `surfaces`）；
 * 3. 依据：每一格用了原文的哪一句（`←`），哪一句因为对不上原文被丢（`⨯`）。
 *
 * 第 3 条是这份工具能不能被信任的全部理由。省掉它，六段看起来很像需求的话就没人
 * 再回头看原文了——而那正是「模型写的不是需求」这件事最容易藏身的地方。
 */
function SplitReport({ note }: { note: SplitFillResult }) {
  if (!note.ok) return <div className="gen-msg bad">{note.message}</div>;
  const filled = Object.values(note.filled).filter((value) => value !== '').length;
  return (
    <div className="splitreport" data-filled={filled} data-missing={note.missing.length}>
      <div className="splitsum">
        {`已填入 ${filled} / 6 格（只是填进表单，保存还要按下面那个按钮）`}
      </div>
      {note.missing.length > 0 && (
        <div className="hintline">
          {`原文没有依据、留空：${note.missing.map((item) => item.label).join('、')}`}
        </div>
      )}
      {note.notes.length > 0 && (
        <ul className="splitnotes">
          {note.notes.map((line, index) => (
            <li key={index} className={line.includes('⨯') ? 'no' : undefined}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RequirementForm({ mode, members, me, closeHref, initial }: RequirementFormProps) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(initial));
  const [title, setTitle] = useState(initial?.title ?? '');
  const [type, setType] = useState(initial?.type ?? 'feature');
  const [requester, setRequester] = useState(initial?.requester ?? me);
  const [owner, setOwner] = useState(initial?.ownerMemberId ?? '');
  /**
   * 平台（P4-08）：多选 chips，本地状态。
   *
   * 为什么不是 `<select multiple>`：这八个键是**标签**（一条需求常常勾两三个），
   * 而原生多选控件在 macOS 上是一块「按住 ⌘ 点」的暗色列表——没人会想到那是多选。
   * chips 一次点击切换一个，勾中的状态是**颜色**（不用读文字就知道选了哪些）。
   *
   * 提交形状：每个勾中的 chip 是一个同名 checkbox（`name="platforms"`），服务端用
   * `getAll('platforms')` 收全部；一个都没勾就一个都不提交 —— 服务层读到 `[]`，
   * 落库是 `'{}'`，语义是**未标注**（不是「不改」：表单永远表达当前状态）。
   */
  const [platforms, setPlatforms] = useState<string[]>(initial?.platforms ?? []);
  const togglePlatform = (key: string): void => {
    setPlatforms((was) => (was.includes(key) ? was.filter((k) => k !== key) : [...was, key]));
  };
  /** 离开过哪些框：只有这些框的提示才出现（见文件头第 3 条）。 */
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [deleting, setDeleting] = useState(false);
  /**
   * 「从原文拆六问」（P4-08）：编辑模式的辅助工具。
   *
   * 它是**一次性工具 + 一个入口**，不是保存时的静默转换：粘贴旧描述 → 拆 → 六格被填进
   * 表单 → 人核对、改、再按保存。工具自己不写库（服务端 `splitDescription` 只返回
   * 结果，`splitDescriptionAction` 只把结果交回这一页）。
   */
  const [splitOpen, setSplitOpen] = useState(false);
  const [oldDescription, setOldDescription] = useState('');
  const [splitting, setSplitting] = useState(false);
  const [splitNote, setSplitNote] = useState<SplitFillResult | null>(null);
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

  /**
   * 拆一次，把结果填进六格**供核对**。
   *
   * 三条：
   * 1. **只填、不保存**：`setValues` 之后什么都不提交——保存仍然要按下面那个按钮。
   * 2. **空的那几格保持空**：服务端已经把「原文没说」的格判成空串，这里不补。
   * 3. **依据要说出来**：`splitNote.notes` 原文显示在按钮下面（哪一句用了、哪一句被拒），
   *    人拿着它就能核；不显示的话，六段长得像需求的话就没人再回头看原文了。
   */
  const split = async (): Promise<void> => {
    if (initial === undefined) return;
    setSplitting(true);
    setSplitNote(null);
    try {
      const form = new FormData();
      form.set('id', initial.id);
      form.set('description', oldDescription);
      const result = await splitDescriptionAction(form);
      if (!result.ok) {
        setSplitNote(result);
        return;
      }
      setSplitNote(result);
      setValues((was) => ({ ...was, ...result.filled }));
    } finally {
      setSplitting(false);
    }
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

          {/* 平台（P4-08）：多选 chips。两种形态都有——它是**内容**（这条需求落在哪几个
              端上），不是分类（类型不可改是 owner 的裁决，平台可以长）。 */}
          <div className="fld">
            <span className="flabel">平台</span>
            <div className="chips" role="group" aria-label="平台">
              {PLATFORMS.map((platform) => {
                const on = platforms.includes(platform.key);
                return (
                  <label
                    key={platform.key}
                    className={on ? 'chipbox on' : 'chipbox'}
                    data-platform={platform.key}
                  >
                    <input
                      type="checkbox"
                      name="platforms"
                      value={platform.key}
                      checked={on}
                      onChange={() => togglePlatform(platform.key)}
                    />
                    {platform.label}
                  </label>
                );
              })}
            </div>
            <div className="hintline">
              {platforms.length === 0 ? '未标注：这条需求现在没有说落在哪几个端上' : ' '}
            </div>
          </div>

          {/* 「从原文拆六问」（P4-08）：**只在编辑模式**——新建时的需求没有「旧描述」。
              它是六格旁边的入口，不是保存路径上的一步。 */}
          {mode === 'edit' && (
            <div className="fld splitbox">
              <div className="splithead">
                <button
                  type="button"
                  className="btn sm"
                  data-act="split-open"
                  aria-expanded={splitOpen}
                  onClick={() => setSplitOpen((was) => !was)}
                >
                  {splitOpen ? '收起' : '从原文拆六问'}
                </button>
                <span className="splitlead">粘一段旧描述，拆成下面六格（只填，不保存）</span>
              </div>
              {splitOpen && (
                <>
                  <textarea
                    name="oldDescription"
                    rows={4}
                    value={oldDescription}
                    placeholder="把旧系统里的那段描述整段粘进来"
                    onChange={(event) => setOldDescription(event.target.value)}
                  />
                  <div className="mk-acts">
                    <button
                      type="button"
                      className="btn sm primary"
                      data-act="split-run"
                      disabled={splitting || oldDescription.trim() === ''}
                      onClick={() => void split()}
                    >
                      {splitting ? '拆分中…' : '拆分并填入'}
                    </button>
                  </div>
                  {splitNote !== null && <SplitReport note={splitNote} />}
                </>
              )}
            </div>
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
