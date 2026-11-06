'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  overlapLine, pickOverlapping, previousLine, type NamedWindow,
} from '../../src/core/releases/window';
import { createReleaseAction, deleteReleaseAction, updateReleaseAction } from '../actions';
import type { EntryResult } from '../actions';

/**
 * 新建 / 编辑版本的表单（P4-02）。
 *
 * 与 `RequirementForm` 同一个壳（`.sheet` 中间的宽框），但多一件事，而它就是任务书
 * 第 4 条（userask 要带上策略）在版本这一侧的落点：
 *
 * **顶上那一行策略**：`上一个版本：v1.4 11-01 → 11-15`。
 * owner 的原话是「新建版本时告诉最近一个版本是几号到几号」——填这一版的时间窗时，
 * 唯一必须知道又不在屏上的事实就是它。所以它固定在表单顶部，由服务端按**当前日期**
 * （新建）或**这一版本身**（编辑）算好传进来。
 *
 * **重叠是行内提示，不是拦截**：用户敲日期的时候就地算（`overlapLine`，与服务层
 * 返回的 `warning` 是同一句话），提交照旧允许。真实世界里「这一版拖到下一版开窗日」
 * 是常态，把重叠做成硬约束只会逼人把日期填错。
 *
 * 删掉的版本是软删：它的需求仍然指着它（排期是历史事实），只是版本名不再显示。
 */
export type ReleaseFormProps = {
  mode: 'create' | 'edit';
  closeHref: string;
  /**
   * 「上一个版本」：**上下文**，按发版日取最近的那一个（服务端 `previousRelease`）。
   * null = 还没有版本。它只用来写顶上那行策略，**不**参与重叠判定。
   */
  previous: NamedWindow | null;
  /**
   * 全部活着的版本：**防撞车**的候选集（owner 2026-11-07 的裁决）。
   *
   * 为什么要把整份清单给到客户端：用户改日期的那一刻就要看到警告，而那件事不能
   * 每敲一个键往返一次服务端。挑哪一条由 `pickOverlapping` 决定——服务端算 `warning`
   * 用的是同一个函数，所以「敲的时候看到的那句」与「保存后看到的那句」永远一样。
   */
  candidates: readonly NamedWindow[];
  /** 编辑时排除自己（否则「把这一版往后挪」会立刻得到一条与自身重叠的警告）。 */
  selfId?: string;
  /**
   * 新建时的默认时间窗（今天 → 两周后）。空着日期也能看到那行策略文案——它是
   * 上下文，不该等用户敲完才出现；敲了之后行内重叠警告跟着变。
   */
  defaults?: { windowStart: string; releaseDate: string };
  initial?: {
    id: string;
    name: string;
    windowStart: string;
    releaseDate: string;
    goal: string | null;
    note: string | null;
  };
};

const IDLE: EntryResult = { ok: true, id: '' };

/** `YYYY-MM-DD` 的那一天：`<input type="date">` 只认这个形状。 */
function dateValue(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

export function ReleaseForm({
  mode, closeHref, previous, candidates, selfId, defaults, initial,
}: ReleaseFormProps) {
  const router = useRouter();
  const [name, setName] = useState(initial?.name ?? '');
  const [windowStart, setWindowStart] = useState(
    dateValue(initial?.windowStart ?? defaults?.windowStart ?? null),
  );
  const [releaseDate, setReleaseDate] = useState(
    dateValue(initial?.releaseDate ?? defaults?.releaseDate ?? null),
  );
  const [goal, setGoal] = useState(initial?.goal ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [deleting, setDeleting] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const [state, formAction, pending] = useActionState(
    async (_prev: EntryResult, formData: FormData): Promise<EntryResult> => (
      mode === 'create'
        ? createReleaseAction(formData)
        : updateReleaseAction(formData)
    ),
    IDLE,
  );

  // 成功 → 选中刚写的那一版（`?release=`），版本页整块换成它。
  useEffect(() => {
    if (state.ok && state.id !== '') router.push(`/releases?release=${state.id}`);
  }, [state, router]);

  const message = state.ok ? null : state.message;
  const close = () => router.push(closeHref);

  /**
   * 行内重叠警告：进入窗口有值就当场算，扫**全部**活着的版本（排除自己）。
   *
   * 不是拿 `previous` 算——那是「上一个版本」，按发版日取最近的一个；而撞车要看的是
   * 所有版本（可能撞上更晚的那一版）。两者是两个问题，两个定义，见 `manage.ts`。
   */
  const entered = windowStart !== '' && releaseDate !== ''
    ? { windowStart, releaseDate }
    : null;
  const overlapping = entered === null
    ? null
    : pickOverlapping(entered, candidates.filter((item) => item.id !== selfId));
  const warning = entered === null ? null : overlapLine(entered, overlapping);

  const remove = async () => {
    if (initial === undefined) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setDeleting(true);
    const form = new FormData();
    form.set('id', initial.id);
    const result = await deleteReleaseAction(form);
    setDeleting(false);
    if (result.ok) router.push('/releases');
  };

  return (
    <div
      className="sheet on"
      role="dialog"
      aria-modal="true"
      aria-label={mode === 'create' ? '新建版本' : '编辑版本'}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <form className="box" action={formAction}>
        {/* 与 `RequirementForm` 同一个隐藏字段：编辑的入参是 `id`，缺了它服务层只报
            「版本 ID 格式不正确」。 */}
        {mode === 'edit' && initial !== undefined && (
          <input type="hidden" name="id" value={initial.id} />
        )}
        <div className="h">
          <b>{mode === 'create' ? '新建版本' : '编辑版本'}</b>
          <button type="button" className="x" onClick={close} aria-label="关闭">✕</button>
        </div>

        <div className="b">
          {/* 策略行：这一版排在哪。位置在**最上面**：填日期之前先看它。 */}
          <div className="strat">{previousLine(previous)}</div>

          <div className="fld">
            <label htmlFor="rel-name">名称</label>
            <input
              id="rel-name"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
            />
          </div>

          <div className="two">
            <div className="fld">
              <label htmlFor="rel-start">开始日</label>
              <input
                id="rel-start"
                name="windowStart"
                type="date"
                value={windowStart}
                onChange={(event) => setWindowStart(event.target.value)}
              />
            </div>
            <div className="fld">
              <label htmlFor="rel-date">发版日</label>
              <input
                id="rel-date"
                name="releaseDate"
                type="date"
                value={releaseDate}
                onChange={(event) => setReleaseDate(event.target.value)}
              />
            </div>
          </div>

          {/* 重叠：一行警告，不拦提交（见文件头）。 */}
          {warning !== null && <div className="hintline warn">{warning}</div>}

          <div className="fld">
            <label htmlFor="rel-goal">这一版要做什么</label>
            <textarea
              id="rel-goal"
              name="goal"
              rows={2}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
            />
          </div>

          <div className="fld">
            <label htmlFor="rel-note">备注</label>
            <textarea
              id="rel-note"
              name="note"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

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

export default ReleaseForm;
