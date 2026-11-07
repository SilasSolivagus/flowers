'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { changePasswordAction, saveNotifyPrefsAction, type ActionResult } from '../actions';

/**
 * 设置 · 我的那两格（P4-05）：**收变动通知** 与 **自改口令**。
 *
 * 两条都只有一行控件，没有解释段落。
 *
 * 1. 通知开关发三格（`inherit` / `changed` / `rejected`），因为库里存的是这份 JSON。
 *    界面只暴露**一个**开关：关 = 三格全 false（`inherit:false` 才是真的关，
 *    见 `src/core/read/notify.ts` 的 `prefsOf`）；开 = `inherit:true`（按角色默认）。
 *    扇出规则、默认值、谁能收到什么，一条都不在这一层——读侧已经按 `notify_prefs`
 *    算好了，这里只负责把它翻成一次写。
 *
 * 2. 改口令三格（旧 / 新 / 确认）。校验与落库在 `app/password-change.ts` +
 *    `src/core/auth/password.ts`；这里不做客户端预校验，失败原因原文显示。
 */

const IDLE: ActionResult = { ok: true };

export function NotifyRow({ on }: { on: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const next = !on;
    const form = new FormData();
    form.set('inherit', next ? 'true' : 'false');
    form.set('changed', next ? 'true' : 'false');
    form.set('rejected', next ? 'true' : 'false');
    try {
      const result = await saveNotifyPrefsAction(form);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    } catch {
      setError('保存没有送达');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="i">
        <div className="l"><b>收变动通知</b></div>
        <div className="v gen-actions">
          <span className="gen-src">{on ? '开' : '关'}</span>
          <button
            className={`sw${on ? ' on' : ''}`}
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="收变动通知"
            disabled={busy}
            onClick={() => void toggle()}
          >
            <i />
          </button>
        </div>
      </div>
      {error !== null && (
        <div className="i gen-detail">
          <div className="gen-msg bad">{error}</div>
        </div>
      )}
    </>
  );
}

export function PasswordRow() {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionResult, formData: FormData): Promise<ActionResult> => (
      changePasswordAction(formData)
    ),
    IDLE,
  );

  useEffect(() => {
    if (sent && state.ok) {
      setOpen(false);
      setSent(false);
    }
  }, [sent, state]);

  const message = state.ok ? null : state.message;

  return (
    <>
      <div className="i">
        <div className="l"><b>口令</b></div>
        <div className="v gen-actions">
          <button
            className="btn ghost sm"
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
          >
            {open ? '取消' : '改'}
          </button>
        </div>
      </div>
      {open && (
        <div className="i gen-detail mk-form">
          <form action={formAction} onSubmit={() => setSent(true)}>
            <div className="fld">
              <label htmlFor="pw-old">旧口令</label>
              <input id="pw-old" name="oldPassword" type="password" autoComplete="current-password" />
            </div>
            <div className="fld">
              <label htmlFor="pw-new">新口令</label>
              <input id="pw-new" name="newPassword" type="password" autoComplete="new-password" />
            </div>
            <div className="fld">
              <label htmlFor="pw-confirm">确认</label>
              <input id="pw-confirm" name="confirm" type="password" autoComplete="new-password" />
            </div>
            {message !== null && <div className="gen-msg bad">{message}</div>}
            <div className="mk-acts">
              <button className="btn sm primary" type="submit" disabled={pending}>保存</button>
              <button className="btn ghost sm" type="button" disabled={pending} onClick={() => setOpen(false)}>
                取消
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
