'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { memberKeyText, type MemberKeyView } from '../../src/core/uemaster/candidates';
import { saveMemberKeyAction, testMemberKeyAction } from '../actions';

/**
 * 「我的」栏里那一格：**我的模型 key**。
 *
 * 一行，五个东西：标签、现在的值、已配置的提示、测试、改。改之后才露出三格表单
 * （接口地址 / 模型 / key）与保存、取消。没有解释段落——这一行要回答的只有
 * 「现在用哪个模型、是不是我自己的 key」，其余靠动作本身说。
 *
 * 三条口径：
 *
 * 1. **key 不回显。** 输入框永远是空的（`type="password"`），存过之后界面上只剩
 *    `已配置 · <末 4 位>`。留空保存 = 不改那把 key（见 `saveMemberKeyAction`），
 *    否则「只想改模型名」的每一次保存都会顺手删掉 key。
 *
 * 2. **测试测的是屏上这一份。** 表单开着就测那三格里填的（key 留空沿用已存的那把），
 *    关着就测他自己存的那份，他自己一格都没有时测平台那份。结果就是那一行里的字：
 *    `通过 · 412ms · 21 tokens`，或者服务端的原文（`Incorrect API key provided: ***`）。
 *    没有 toast、没有第二块区域——那一行本来就是它该出现的地方。
 *
 * 3. **通过即存。** 这不是「测试 + 保存」两步：失败时库里的配置原封不动（填个错的
 *    key 按测试，那一行不会变成「已配置」），通过时才落库并刷新——与抽屉里那条
 *    「测试并使用」同一条规矩。
 */
export function MemberKeyRow({ view }: { view: MemberKeyView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState(view.baseUrl ?? '');
  const [model, setModel] = useState(view.ownModel ?? '');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  // 每次打开都从**存着的值**起，不复用上一次没保存的草稿：草稿是上一次「取消」的那一份，
  // 留住它，第二次打开时输入框里就有一个用户没打算再用的地址。
  const edit = (): void => {
    setBaseUrl(view.baseUrl ?? '');
    setModel(view.ownModel ?? '');
    setKey('');
    setOpen(true);
  };

  const close = (): void => {
    setOpen(false);
    setKey('');
  };

  /** 表单里那三格。表单关着时给一张空表——那时「测试」问的是存着的那一份。 */
  const fields = (): FormData => {
    const form = new FormData();
    if (!open) return form;
    form.set('baseUrl', baseUrl);
    form.set('model', model);
    form.set('key', key);
    return form;
  };

  const save = async (): Promise<void> => {
    setBusy('save');
    setResult(null);
    try {
      const done = await saveMemberKeyAction(fields());
      if (!done.ok) {
        setResult({ ok: false, text: done.message });
        return;
      }
      close();
      router.refresh();
    } catch {
      setResult({ ok: false, text: '保存没有送达' });
    } finally {
      setBusy(null);
    }
  };

  const test = async (): Promise<void> => {
    setBusy('test');
    setResult(null);
    try {
      const outcome = await testMemberKeyAction(fields());
      setResult({ ok: outcome.ok, text: outcome.label });
      // 通过即存：表单收起，让那一行先把「已配置」与新的模型名显示出来。
      if (outcome.saved) {
        close();
        router.refresh();
      }
    } catch {
      setResult({ ok: false, text: '测试请求没有送达' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="sg">
      <div className="i gen-row">
        <div className="l"><b>我的模型 key</b></div>
        <div className="v gen-actions">
          <span className="gen-src">{memberKeyText(view)}</span>
          {view.keyTail !== null && <span className="pill no">{`已配置 · ${view.keyTail}`}</span>}
          <button className="btn sm" type="button" disabled={busy !== null} onClick={() => void test()}>
            {busy === 'test' ? '测试中' : '测试'}
          </button>
          <button
            className="btn ghost sm"
            type="button"
            aria-expanded={open}
            disabled={busy !== null}
            onClick={() => (open ? close() : edit())}
          >
            {open ? '取消' : '改'}
          </button>
        </div>
      </div>

      {open && (
        <div className="i gen-detail mk-form">
          <label className="mk-f">
            <span>接口地址</span>
            <input
              className="gen-input"
              type="text"
              spellCheck={false}
              autoComplete="off"
              inputMode="url"
              value={baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label className="mk-f">
            <span>模型</span>
            <input
              className="gen-input"
              type="text"
              spellCheck={false}
              autoComplete="off"
              value={model}
              placeholder="gpt-4o-mini"
              onChange={(event) => setModel(event.target.value)}
            />
          </label>
          <label className="mk-f">
            <span>key</span>
            <input
              className="gen-input"
              type="password"
              spellCheck={false}
              autoComplete="new-password"
              value={key}
              placeholder={view.keyTail === null ? 'sk-…' : `已配置 · ${view.keyTail}`}
              onChange={(event) => setKey(event.target.value)}
            />
          </label>
          <div className="mk-acts">
            <button className="btn sm" type="button" disabled={busy !== null} onClick={() => void save()}>
              {busy === 'save' ? '保存中' : '保存'}
            </button>
            <button className="btn ghost sm" type="button" disabled={busy !== null} onClick={close}>
              取消
            </button>
          </div>
        </div>
      )}

      {result !== null && (
        <div className="i gen-detail">
          <div className={`gen-msg ${result.ok ? '' : 'bad'}`}>{result.text}</div>
        </div>
      )}
    </section>
  );
}

export default MemberKeyRow;
