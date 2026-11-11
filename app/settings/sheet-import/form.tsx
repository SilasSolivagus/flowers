'use client';

import { useActionState } from 'react';

type Item = {
  num: string;
  title: string;
  owner: string;
  priority: string;
  prd: boolean;
  action: 'move' | 'create' | 'keep';
  why: string;
  matched: string | null;
};

type Result = { ok: boolean; message: string };

export function SheetImportForm({
  items,
  apply,
}: {
  items: Item[];
  apply: (formData: FormData) => Promise<Result>;
}) {
  const [state, action, pending] = useActionState(
    async (_prev: Result | null, formData: FormData) => apply(formData),
    null,
  );
  return (
    <form action={action}>
      <table className="plan">
        <thead>
          <tr><th /><th>表行</th><th>匹配到</th><th>建议</th><th>为什么</th></tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.num}>
              <td>
                <input
                  type="checkbox"
                  name="row"
                  value={item.num}
                  defaultChecked={item.action !== 'keep'}
                  disabled={item.action === 'keep'}
                />
              </td>
              <td>{item.num}. {item.title} · {item.owner} · {item.priority}{item.prd ? ' · 有 PRD' : ''}</td>
              <td>{item.matched ?? '—'}</td>
              <td>{item.action === 'move' ? '挪进待排期' : item.action === 'create' ? '新建' : '不动'}</td>
              <td>
                {item.why}
                {/* 建之前把话说明白（2026-11-11）：这一行池里已经有同名的，
                    再勾一次就多一条副本——上一次就是在这个位置多出 13 条。 */}
                {item.action === 'create' && item.matched !== null && (
                  <div className="muted">这些行池里已有：勾了会再造一条，先确认那条是不是同一条。</div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn primary" type="submit" disabled={pending}>
        {pending ? '提交中…' : '应用勾选的条目'}
      </button>
      {state !== null && <p role="status">{state.message}</p>}
    </form>
  );
}
