'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { GeneratorView } from '../../src/core/uemaster/candidates';
import { GeneratorPicker } from '../components/GeneratorPicker';
import { testGeneratorAction } from '../actions';

/**
 * 设置页「生成器」那一行：值是**现在真会执行的那条命令**，右边两个按钮。
 *
 * 为什么在「项目」这一栏而不是「我的」：生成器是这个部署（这台机器）的配置，与
 * 需求、成员、评审线同属「项目」；「我的」只有身份——一个没有账号系统的人能看到的
 * 那两行。把它塞进「我的」会让「这一页只显示关于你的事实」这条口径失效。
 *
 * 三条界面规矩（与设置页其余部分一致）：
 * 1. **屏上不出现解释性文案**：只有行标签、值、按钮，以及测试的**结果原文**。
 *    `失败：MISSING_CREDENTIAL: …` 那句 stderr 就是说明本身，不再加一句「请检查配置」。
 * 2. **未配置就说未配置**；探测到但没保存的那一条照样显示（带一个「自动」标签），
 *    因为那才是现在按下去会跑的东西——把自动探测藏起来，用户会以为必须先去设一条。
 * 3. **保存不要求先测通**，但那一行必须诚实：没有一次通过的测试，就写「未通过测试」。
 *    刷新之后它还在（结果落在 `app_settings`），不会因为一次刷新被洗成「未配置」。
 */

export function GeneratorRow({ view }: { view: GeneratorView }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const command = view.command ?? view.saved;
  const test = view.test;
  const testIsCurrent = test !== null && command !== null && test.command === command;
  const passed = testIsCurrent && test.ok;

  const runTest = async (): Promise<void> => {
    setTesting(true);
    setResult(null);
    try {
      const outcome = await testGeneratorAction();
      setResult(outcome);
      router.refresh();
    } catch {
      setResult({ ok: false, message: '失败：测试请求没有送达' });
    } finally {
      setTesting(false);
    }
  };

  // 刚测过就以刚回来的那句为准（刷新前后一屏之内不会闪）；否则用库里存着的那份。
  const detail = result?.message
    ?? (testIsCurrent
      ? (test.ok
        ? `通过（${test.size ?? 0} 字节 · ${test.ms ?? 0} ms）`
        : `失败：${test.error ?? '未知原因'}`)
      : null);

  return (
    <section className="sg">
      <div className="h">生成器</div>
      <div className="i gen-row">
        <div className="l">
          <b className="gen-cmd">{command ?? '未配置'}</b>
        </div>
        <div className="v gen-actions">
          {command !== null && (
            <span className={`pill ${passed ? 'ok' : 'no'}`}>{passed ? '通过' : '未通过测试'}</span>
          )}
          {view.source === 'detected' && <span className="pill no">自动</span>}
          {view.source === 'env' && <span className="pill no">环境变量</span>}
          <button
            className="btn sm"
            type="button"
            onClick={() => void runTest()}
            disabled={command === null || testing}
          >
            {testing ? '测试中' : '测试'}
          </button>
          <button
            className="btn ghost sm"
            type="button"
            onClick={() => setEditing((open) => !open)}
          >
            改
          </button>
        </div>
      </div>
      {detail !== null && (
        <div className="i gen-detail">
          <div className={`gen-msg ${result !== null && !result.ok ? 'bad' : ''}`}>{detail}</div>
        </div>
      )}
      {editing && (
        <div className="gen-edit">
          <GeneratorPicker
            candidates={view.candidates}
            known={view.known}
            onCancel={() => setEditing(false)}
            onPicked={() => {
              setEditing(false);
              setResult(null);
              router.refresh();
            }}
            onClear={() => {
              setEditing(false);
              setResult(null);
              router.refresh();
            }}
          />
        </div>
      )}
    </section>
  );
}

export default GeneratorRow;
