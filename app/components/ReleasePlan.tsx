'use client';

import { useActionState, useState } from 'react';

import { rescheduleAction, scheduleAction, type ActionResult } from '../actions';

/**
 * 版本页的「添加需求 / 管理进度」（2026-11-11）。
 *
 * 之前版本页只能看：甘特、延期条数、时间进度都是算出来的，改不动。于是两件最日常的
 * 事没有入口——把一条待排期的需求加进本版本、把已经在版本里的需求改个日期。
 *
 * 两条口径与领域层一致，不在界面重算：
 * - 加需求 = `scheduleAction`（待排期 → 待开发，要 PRD、要三个日期）；
 * - 改进度 = `rescheduleAction`（不动状态，只改版本 / 提测日 / 承诺完成日）。
 *
 * 日期默认取版本窗口（提测日 = 窗口起，承诺完成日 = 发版日）：大多数需求就是这么排的，
 * 少一次手填；改了也不影响校验——`schedule` / `reschedule` 会照旧报「晚于发版日」。
 */

const IDLE: ActionResult = { ok: true };

async function submitSchedule(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  return scheduleAction(formData);
}

async function submitReschedule(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  return rescheduleAction(formData);
}

export type ReleasePlanItem = {
  id: string;
  number: number;
  title: string;
  stateLabel: string;
  commitTestAt: string | null;
  commitDueAt: string | null;
};

function dayOf(iso: string | null): string {
  return iso === null ? '' : iso.slice(0, 10);
}

export function ReleasePlan({
  releaseId,
  windowStart,
  releaseDate,
  items,
  candidates,
}: {
  releaseId: string;
  windowStart: string;
  releaseDate: string;
  items: ReleasePlanItem[];
  candidates: Array<{ id: string; number: number; title: string }>;
}) {
  return (
    <section className="panel" data-panel="release-plan">
      <div className="ph">本版本需求与进度</div>

      {items.length === 0 ? (
        <p className="muted">这一版还没有需求。</p>
      ) : (
        <table className="plan">
          <thead>
            <tr>
              <th>需求</th>
              <th>状态</th>
              <th>提测日</th>
              <th>承诺完成日</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <RescheduleRow
                key={item.id}
                releaseId={releaseId}
                item={item}
              />
            ))}
          </tbody>
        </table>
      )}

      {/* 候选为空时**也把表单画出来**（2026-11-11 的第二次修正）：
          上一版直接把整块藏掉，页面上只剩一句灰字，owner 找不到「添加需求」在哪。
          现在表单一直在，只是下拉没得选、按钮禁用，并在旁边说清为什么。 */}
      <AddForm
        releaseId={releaseId}
        windowStart={windowStart}
        releaseDate={releaseDate}
        candidates={candidates}
      />
    </section>
  );
}

function RescheduleRow({ releaseId, item }: { releaseId: string; item: ReleasePlanItem }) {
  const [state, formAction, pending] = useActionState(submitReschedule, IDLE);
  return (
    <tr>
      <td>
        PAN-{item.number} {item.title}
      </td>
      <td>{item.stateLabel}</td>
      <td colSpan={3}>
        <form action={formAction} className="plan-form">
          <input type="hidden" name="id" value={item.id} />
          <input type="hidden" name="releaseId" value={releaseId} />
          <input
            type="date"
            name="commitTestAt"
            defaultValue={dayOf(item.commitTestAt)}
            aria-label={`PAN-${item.number} 提测日`}
            required
          />
          <input
            type="date"
            name="commitDueAt"
            defaultValue={dayOf(item.commitDueAt)}
            aria-label={`PAN-${item.number} 承诺完成日`}
            required
          />
          <button className="btn sm" type="submit" disabled={pending}>
            {pending ? '保存中…' : '保存'}
          </button>
          {!state.ok && <span className="dfail" role="alert">{state.message}</span>}
        </form>
      </td>
    </tr>
  );
}

function AddForm({
  releaseId,
  windowStart,
  releaseDate,
  candidates,
}: {
  releaseId: string;
  windowStart: string;
  releaseDate: string;
  candidates: Array<{ id: string; number: number; title: string }>;
}) {
  const [state, formAction, pending] = useActionState(submitSchedule, IDLE);
  const [selected, setSelected] = useState(candidates[0]?.id ?? '');
  return (
    <form action={formAction} className="plan-add">
      <input type="hidden" name="releaseId" value={releaseId} />
      <label>
        <span>加需求</span>
        <select
          name="id"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          disabled={candidates.length === 0}
        >
          {candidates.length === 0 ? (
            <option value="">（待排期里没有可加的需求）</option>
          ) : candidates.map((c) => (
            <option key={c.id} value={c.id}>
              PAN-{c.number} {c.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>提测日</span>
        <input type="date" name="commitTestAt" defaultValue={windowStart} required />
      </label>
      <label>
        <span>承诺完成日</span>
        <input type="date" name="commitDueAt" defaultValue={releaseDate} required />
      </label>
      <button
        className="btn sm primary"
        type="submit"
        disabled={pending || selected === '' || candidates.length === 0}
      >
        {pending ? '加入中…' : '加入本版本'}
      </button>
      {candidates.length === 0 && (
        <span className="muted">待排期里没有可加的需求：需求要先进「待排期」并且有正式 PRD。</span>
      )}
      {!state.ok && <span className="dfail" role="alert">{state.message}</span>}
    </form>
  );
}
