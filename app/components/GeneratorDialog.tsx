'use client';

import { useState } from 'react';
import {
  initialOptionId, type CandidateId, type GeneratorView,
} from '../../src/core/uemaster/candidates';
import { applyGeneratorAction } from '../actions';
import { GeneratorSelect } from './GeneratorSelect';

/**
 * 第一次用时的那个问题：「生成器用它，行不行？」
 *
 * 这是 P2.8 的核心修正。P2.7 把「配置生成器」当成一个**目的地**——用户得先离开
 * 需求、去设置页、在五张卡里挑一张、填一条命令、再回来按生成。而它真正是一次
 * **只用问一次的提问**：抽屉里按「生成」，如果还没配过，就在原地问一句，问完
 * 就再也不出现（答案落在 `app_settings`，之后每一次直接跑）。
 *
 * 四个决定：
 * 1. **一个下拉**，预选装了的第一个（`initialOptionId`）。不是五张卡：五张卡是
 *    「请配置」，一个下拉是「请选」。用户答的是后者。
 * 2. **「测试并使用」是一个动作**。测通了就存 + 立刻接着生成（一次点击的意图，
 *    不是「测试」加「生成」两次）；测不通就把 CLI 的原话留在框里，对话框不关,
 *    换一个选项再按一次。
 * 3. **命令行藏在「高级」里**。PM 不该读 `--skip-git-repo-check`；但 `ollama` 的
 *    `<模型名>` 与两个「需要填命令」的候选必须有一条路填——那条路就在高级里，
 *    不是另一张表。
 * 4. **不悄悄替他选**。就算只装了一个，也问这一次（预选好，一次确认）。他没答应
 *    过的事，PATH 不能代答。
 */
export function GeneratorDialog({
  view, onDone, onCancel,
}: {
  view: GeneratorView;
  /** 测试通过并保存之后：关掉对话框，接着开始这一次生成。 */
  onDone: () => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<CandidateId>(() => initialOptionId(view));
  // 每个候选各留一份草稿：改过 ollama 的模型名再切回 claude 再切回来，改的那句还在。
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const option of view.options) {
      // 已保存的那一行用**存着的**那条命令（可能被改过：`ollama run qwen2.5`），
      // 其余用它自带的模板。
      seed[option.id] = option.id === view.savedId && view.saved !== null
        ? view.saved
        : option.command;
    }
    return seed;
  });
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const option = view.options.find((item) => item.id === selected) ?? null;
  const command = draft[selected] ?? option?.command ?? '';
  // 「需要填命令」的那几行（WorkBuddy / Grok Bot / 自建）一选中就露出输入框：
  // 它们没有命令可藏，高级在这里是空的。
  const showInput = option?.needsCommand === true || advanced;

  const submit = async (): Promise<void> => {
    setError(null);
    const value = command.trim();
    if (value === '') {
      setError('先填一条命令');
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.set('command', value);
      const result = await applyGeneratorAction(form);
      if (!result.ok) {
        // 失败不关框：用户可以就地换一个选项再试，或者改高级里那条命令。
        setError(result.message);
        return;
      }
      onDone();
    } catch {
      setError('请求没有送达');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gen-ask">
      <div className="gen-line">
        <GeneratorSelect
          options={view.options}
          value={selected}
          disabled={busy}
          onChange={(id) => {
            setSelected(id);
            setError(null);
          }}
        />
        <button
          className="btn ghost sm"
          type="button"
          aria-expanded={advanced}
          onClick={() => setAdvanced((open) => !open)}
        >
          高级
        </button>
      </div>

      {showInput && (
        <input
          className="gen-input"
          type="text"
          spellCheck={false}
          autoComplete="off"
          aria-label="命令"
          placeholder="命令"
          value={command}
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, [selected]: event.target.value })}
        />
      )}

      {error !== null && <div className="gen-err" role="alert">{error}</div>}

      <div className="gen-foot">
        <button className="btn ghost sm" type="button" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button className="btn primary sm" type="button" onClick={() => void submit()} disabled={busy}>
          {busy ? '测试中' : '测试并使用'}
        </button>
      </div>
    </div>
  );
}

export default GeneratorDialog;
