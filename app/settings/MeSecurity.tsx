'use client';

import { useActionState, useEffect, useState } from 'react';
import { changePasswordAction, saveNotifyChannelAction, type ActionResult } from '../actions';
import {
  LEVEL_LABEL, type Channel, type Level, type NotifyPrefs,
} from '../../src/core/notify/prefs';

/**
 * 设置 · 我的那两块（P4-05 起）：**通知频道** 与 **自改密码**。
 *
 * 通知这一块是 P4-07 的形状：两行（站内 / 企微），每行一个三档分段控件
 * （全部 / 只关键 / 关）。只有标签，没有解释段落——每一档是什么意思，是产品
 * 口径（`src/core/notify/classes.ts` 的三个类），不该在设置页再讲一遍。
 *
 * 三条实现决定：
 *
 * 1. **一次提交一格**（`channel` + `level`）。两行各有各的写请求，互不覆盖：
 *    把两格塞进一个表单，第二行的失败会把第一行已经存好的值一起退回去。
 * 2. **乐观更新 + 失败回滚**。点一下立刻就是选中的样子（这是一个 20ms 的本地偏好，
 *    不该等一次 RSC 往返才动），失败时退回原值并显示服务层那句中文。
 * 3. **绑定与机器人不在这里**（2026-11-10）：原来这一块还带一行「还没对上企微账号」+
 *    「查一下」，那是**超管替人绑**那条路留下的痕迹。现在本人有自己的一条带引导的路
 *    （`WecomBinding.tsx`：贴 userid → 验证 → 状态），「查一下」作为「我不知道自己的
 *    userid，按名字查一下」的入口活在那条路的输入框旁边。这一块只留**档位**——它回答
 *    的是「要不要被打断」，而绑定回答的是「发给谁」，两件事。
 */
const IDLE: ActionResult = { ok: true };

const LEVEL_ORDER: Level[] = ['all', 'key', 'off'];

export function NotifyChannels({ prefs }: { prefs: NotifyPrefs }) {
  const [state, setState] = useState<NotifyPrefs>(prefs);
  const [busy, setBusy] = useState<Channel | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (channel: Channel, level: Level): Promise<void> => {
    if (state[channel] === level || busy !== null) return;
    const before = state[channel];
    setState((prev) => ({ ...prev, [channel]: level }));
    setBusy(channel);
    setError(null);
    const form = new FormData();
    form.set('channel', channel);
    form.set('level', level);
    try {
      const result = await saveNotifyChannelAction(form);
      if (!result.ok) {
        setState((prev) => ({ ...prev, [channel]: before }));
        setError(result.message);
      }
    } catch {
      setState((prev) => ({ ...prev, [channel]: before }));
      setError('保存没有送达');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <ChannelRow
        channel="site"
        label="站内"
        value={state.site}
        busy={busy === 'site'}
        onPick={pick}
      />
      <ChannelRow
        channel="wecom"
        label="企微"
        value={state.wecom}
        busy={busy === 'wecom'}
        onPick={pick}
      />
      {error !== null && (
        <div className="i gen-detail">
          <div className="gen-msg bad">{error}</div>
        </div>
      )}
    </>
  );
}

/**
 * 一行：标签 + 三格分段控件。
 *
 * `role="group"` + `aria-pressed`：三个按钮表达的是「当前选中哪一格」，不是三个
 * 独立开关；屏幕阅读器读出「站内通知档位，全部，按下」比读三个开关更接近事实。
 * 选中态只靠 `aria-pressed`（样式在 `settings.css` 的 `.seg`），服务端不需要知道它。
 */
function ChannelRow({
  channel, label, value, busy, onPick,
}: {
  channel: Channel;
  label: string;
  value: Level;
  busy: boolean;
  onPick: (channel: Channel, level: Level) => Promise<void>;
}) {
  return (
    <div className="i">
      <div className="l"><b>{label}</b></div>
      <div className="v">
        <div className="seg" role="group" aria-label={`${label}通知档位`}>
          {LEVEL_ORDER.map((level) => (
            <button
              key={level}
              type="button"
              className="seg-b"
              aria-pressed={value === level}
              disabled={busy}
              onClick={() => void onPick(channel, level)}
            >
              {LEVEL_LABEL[level]}
            </button>
          ))}
        </div>
      </div>
    </div>
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
        <div className="l"><b>密码</b></div>
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
              <label htmlFor="pw-old">旧密码</label>
              <input id="pw-old" name="oldPassword" type="password" autoComplete="current-password" />
            </div>
            <div className="fld">
              <label htmlFor="pw-new">新密码</label>
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
