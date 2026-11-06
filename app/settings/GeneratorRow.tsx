'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  idForCommand, testLabel, type CandidateId, type GeneratorView,
} from '../../src/core/uemaster/candidates';
import { saveGeneratorAction, testGeneratorAction } from '../actions';
import { GeneratorSelect } from '../components/GeneratorSelect';

/**
 * 设置页「生成器」这一格：**一行**。下拉 + 测试 + 高级，没有别的。
 *
 * P2.7 这里是五张常驻卡片、每张一条命令行输入框，占掉整整一屏——而这一页要回答的
 * 只有一句话：「现在用哪个」。所以：
 * - 下拉的值就是答案，**改了就存**（不用再按保存）；命令本身是下拉的附属事实，
 *   不是主界面上的东西，所以它在「高级」后面。
 * - 「高级」露出所选候选的命令行，可改（`ollama` 的 `<模型名>` 只能在这里填）。
 *   改完回车或失焦就存：这一格没有第二个按钮，也没有「未保存」这种状态。
 * - 测试结果就在这一行里：`通过 · 74B · 0.9s` / `失败：<stderr>`。失败照登原文——
 *   那句话本身就是下一步，不再加一句「请检查配置」。
 *
 * 为什么在「项目」这一栏而不是「我的」：生成器是这个部署（这台机器）的配置，
 * 与需求、成员、评审线同属「项目」。
 *
 * 为什么没有「清除」按钮：撤销的入口是「把命令行删空」（服务层把空串当「没设」，
 * 这一行就退回「未配置」，抽屉里那次提问会重新出现）。P2.7 有一个显式的「清除」，
 * 它对第一次用的人是多余的，而这一行的口径是「三个控件」。
 *
 * P2.10：配了模型接口时，行首多一格值 `平台统一模型 · <模型名>`，右边的下拉 / 测试 /
 * 高级前面多一个 `CLI` 标签。理由：那时真正会被执行的是 provider，而这一格之前只
 * 描述 CLI——一个配好 key 的部署打开设置页，看到的仍是「未配置」。三个 CLI 控件照旧
 * 留着（撤掉模型接口后它们立刻是活的），标签只是说清它们治的是哪条路。
 */

export function GeneratorRow({ view }: { view: GeneratorView }) {
  const router = useRouter();
  const [advanced, setAdvanced] = useState(false);
  /** 手改过的命令；null = 跟随所选候选自带的那条。 */
  const [draft, setDraft] = useState<string | null>(null);
  /**
   * 刚在下拉里选中的那一行。
   *
   * 为什么需要它：`view.savedId` 是服务端渲染出来的值，选完要等一次 RSC 往返才变，
   * 期间下拉会**弹回**上一个选项（用户会以为没选上）。这里先乐观地按住新值，
   * 服务端那一次回来之后两边相等，它就不再起作用；保存失败则退回（见 `change`）。
   */
  const [picked, setPicked] = useState<CandidateId | null>(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = picked ?? view.savedId;
  const option = view.options.find((item) => item.id === selected) ?? null;

  // 选中的是自建（或某条改过的命令）时，输入框里得是**存着的那一条**，不是空串。
  const seeded = selected === 'custom' || option === null
    ? (view.saved ?? '')
    : option.command;
  const command = draft ?? seeded;

  // 命令行默认不出现（D）。两个例外：按了「高级」；或者刚选了一个「还不能直接跑」
  // 的候选（需要填命令的 WorkBuddy / Grok Bot / 自建，或 ollama 那种还带着
  // `<模型名>` 的）——那时输入框就是「选它」这个动作本身，要先填好才存得下。
  const askingForCommand = (option?.needsCommand === true || option?.ready === false)
    && selected !== view.savedId;
  const showInput = advanced || askingForCommand;

  // 选了还没存 / 改了还没存：这时那一行不能显示上一次的测试结果——它测的是另一条命令。
  const unsaved = selected !== view.savedId || (draft !== null && draft.trim() !== (view.saved ?? ''));
  const testIsCurrent = !unsaved && view.test !== null && view.saved !== null
    && view.test.command === view.saved;

  const save = async (value: string): Promise<void> => {
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      form.set('command', value);
      const saved = await saveGeneratorAction(form);
      if (!saved.ok) {
        setError(saved.message);
        setPicked(null);
        return;
      }
      setDraft(null);
      // 存完把乐观值对齐到**刚存下的那条命令**该落在哪一行：清空之后它是 null，
      // 于是下拉如实回到「未配置」（而不是继续显示上一个候选）。
      setPicked(idForCommand(value));
      router.refresh();
    } catch {
      setError('保存没有送达');
    }
  };

  const change = async (id: CandidateId): Promise<void> => {
    const next = view.options.find((item) => item.id === id);
    if (next === undefined) return;
    setError(null);
    setResult(null);
    setDraft(null);
    setPicked(id);
    // 还不能直接跑的几行（空命令、或命令里还有 `<模型名>`）：先把输入框露出来，
    // 填好才存——存一条跑不了的命令等于把「测试」这一步变成假动作。
    if (next.needsCommand || !next.ready) {
      setAdvanced(true);
      return;
    }
    await save(next.command);
  };

  // 高级里那一条：回车或失焦时存（与下拉「改了就存」同一条规矩）。
  //
  // 把它清空 = 回到「未配置」：服务层把空串当「没设」（`generatorCommand()` 返回 null），
  // 于是下一次按「生成」会重新问一次。P2.7 那行有一个「清除」按钮；这一版没有第三个
  // 按钮，撤销就落在「把命令删掉」这个动作上——它本来就在用户的脑子里。
  const commit = async (): Promise<void> => {
    const value = command.trim();
    if (value === (view.saved ?? '')) return;
    await save(value);
  };

  const runTest = async (): Promise<void> => {
    setTesting(true);
    setError(null);
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
  const detail = result?.message ?? (testIsCurrent && view.test !== null ? testLabel(view.test) : null);

  return (
    <section className="sg">
      <div className="i gen-row">
        <div className="l"><b>生成器</b></div>
        <div className="v gen-actions">
          {/* 活着的那条路写在最左边：`平台统一模型 · gpt-5.4-mini`。后面那个 `CLI`
              标签是给右边那三个控件的——它们治的是另一条路，provider 在时仍然可改
              （撤掉模型接口之后它就立刻变成活的）。没有解释句，只有值与标签。 */}
          {view.provider !== null && (
            <span className="gen-src">{`平台统一模型 · ${view.provider.model}`}</span>
          )}
          {view.source === 'env' && <span className="pill no">环境变量</span>}
          {view.provider !== null && <span className="pill no">CLI</span>}
          <GeneratorSelect
            options={view.options}
            value={selected}
            // provider 在时这一格是「另一条路」，行首已经说了活着的是谁：那一格的
            // 空值说「未选」，不说「未配置」——后者会让整行读起来像没配。
            emptyLabel={view.provider !== null ? '未选' : undefined}
            onChange={(id) => void change(id)}
          />
          <button
            className="btn sm"
            type="button"
            onClick={() => void runTest()}
            disabled={view.saved === null || unsaved || testing}
          >
            {testing ? '测试中' : '测试'}
          </button>
          <button
            className="btn ghost sm"
            type="button"
            aria-expanded={advanced}
            onClick={() => setAdvanced((open) => !open)}
          >
            高级
          </button>
        </div>
      </div>

      {showInput && (
        <div className="i gen-detail">
          <input
            className="gen-input"
            type="text"
            spellCheck={false}
            autoComplete="off"
            aria-label="命令"
            value={command}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void commit();
            }}
          />
        </div>
      )}

      {(detail !== null || error !== null) && (
        <div className="i gen-detail">
          <div className={`gen-msg ${(result !== null && !result.ok) || error !== null ? 'bad' : ''}`}>
            {error ?? detail}
          </div>
        </div>
      )}
    </section>
  );
}

export default GeneratorRow;
