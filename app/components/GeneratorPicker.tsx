'use client';

import { useState } from 'react';
import type { CandidateView } from '../../src/core/uemaster/candidates';
import { saveGeneratorAction } from '../actions';

/**
 * 生成器选择器：一行一个候选，命令就地可改，点「用这个」保存。
 *
 * 两个地方用它，同一个形状：
 * - 抽屉里点「生成」但探测到多条时（`.sheet` 里的那张）；
 * - 设置页「生成器」那一行点「改」（同一份内容，内嵌在那一节里）。
 *
 * 三条刻意的规矩：
 * 1. **探测到的候选在前，自建永远在最后**。没探测到的不列：这一列的意义是
 *    「这台机器上现在有什么」，列一串装了才有用的名字等于给用户出选择题。
 * 2. **命令是输入框，不是只读文本**。`ollama run <模型名>` 这种探测到了但还不能跑
 *    的候选，唯一能让它变成「能用」的动作就是在这里改一次——保存时服务层会挡住
 *    没填的占位符，不会让它悄悄跑到 shell 里去当重定向。
 * 3. **保存与能不能跑是两件事**。这里只保存；跑不跑得通由设置页的「测试」回答。
 *    失败的那一句照登，不改写。
 *
 * 类名一律带 `gen-` 前缀：全局表里已经有 `.grow`（看板的一行），一个通用的
 * `.grow` 会把它 `height: var(--h-row)` 一起继承过来——这次的布局重叠就是这么来的。
 */

/** 自建那一行永远存在，命令为空，用户自己填。 */
const CUSTOM: CandidateView = {
  id: 'custom',
  label: '自建 / 自定义',
  command: '',
  note: '',
  ready: true,
};

/**
 * 这一次要列哪些行。
 *
 * - 探测到东西：只列探测到的，加「自建」。这一列的意义是「这台机器上现在有什么」。
 * - 一个都没探测到：列**整张表**，并且把 `dsh` 放第一个——那时这一列不是清单而是指路，
 *   而 `dsh` 是这个产品最想要的那条（DeepSeek Harness：headless 形态、一条命令、
 *   不需要 agent 的写文件权限）。这是「零条时设置页的指路把 dsh 排第一」在界面上的落点。
 */
function rowsFor(candidates: CandidateView[], known: CandidateView[]): CandidateView[] {
  const detected = candidates.filter((candidate) => candidate.id !== 'custom');
  if (detected.length > 0) return [...detected, CUSTOM];

  const rest = known.filter((candidate) => candidate.id !== 'custom');
  const dsh = rest.filter((candidate) => candidate.id === 'dsh');
  return [...dsh, ...rest.filter((candidate) => candidate.id !== 'dsh'), CUSTOM];
}

export function GeneratorPicker({
  candidates, known, onPicked, onCancel, onClear,
}: {
  candidates: CandidateView[];
  /** 五行完整表：零探测时用它来指路（`dsh` 排第一）。 */
  known: CandidateView[];
  /** 保存成功之后要做什么（抽屉里：立刻开始生成；设置页：收起面板）。 */
  onPicked: (command: string) => void | Promise<void>;
  onCancel: () => void;
  /**
   * 清掉保存的那条，回到「按 PATH 探测」。只有设置页给这个动作：抽屉里的选择器
   * 是「这一步用哪个」，没有「以后都不选」的语义。空串在服务层就是「没设」，
   * 所以这里不需要第二个删除接口。
   */
  onClear?: () => void | Promise<void>;
}) {
  const rows = rowsFor(candidates, known);
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const row of rows) seed[row.id] = row.command;
    return seed;
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clear = async (): Promise<void> => {
    setError(null);
    setBusy('clear');
    try {
      const form = new FormData();
      form.set('command', '');
      const result = await saveGeneratorAction(form);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (onClear !== undefined) await onClear();
      else await onPicked('');
    } catch {
      setError('保存没有送达');
    } finally {
      setBusy(null);
    }
  };

  const pick = async (row: CandidateView): Promise<void> => {
    const command = (draft[row.id] ?? '').trim();
    setError(null);
    if (command === '') {
      setError('先填一条命令');
      return;
    }
    setBusy(row.id);
    try {
      const form = new FormData();
      form.set('command', command);
      const result = await saveGeneratorAction(form);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      await onPicked(command);
    } catch {
      setError('保存没有送达');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="gen-pick">
      {rows.map((row) => (
        <div className="gen-opt" key={row.id}>
          <div className="gen-head">
            <label className="gen-name" htmlFor={`gen-${row.id}`}>{row.label}</label>
            <button
              className="btn sm gen-use"
              type="button"
              onClick={() => void pick(row)}
              disabled={busy !== null}
            >
              {busy === row.id ? '保存中' : '用这个'}
            </button>
          </div>
          <input
            id={`gen-${row.id}`}
            className="gen-input"
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={draft[row.id] ?? ''}
            onChange={(event) => setDraft({ ...draft, [row.id]: event.target.value })}
          />
        </div>
      ))}
      {error !== null && <div className="gen-err" role="alert">{error}</div>}
      <div className="gen-foot">
        {onClear !== undefined && (
          <button
            className="btn ghost sm gen-clear"
            type="button"
            disabled={busy !== null}
            onClick={() => void clear()}
          >
            清除
          </button>
        )}
        <button className="btn ghost sm" type="button" onClick={onCancel} disabled={busy !== null}>
          取消
        </button>
      </div>
    </div>
  );
}

export default GeneratorPicker;
