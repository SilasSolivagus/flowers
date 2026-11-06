'use client';

import type { CandidateId, CandidateOption } from '../../src/core/uemaster/candidates';

/**
 * 生成器下拉：**只有这一个控件**，抽屉里第一次问、设置页以后改，都是它。
 *
 * P2.7 用的是「五张卡，每张带一条命令行输入框」——那不是配置，那是一张表单；
 * 一个 PM 打开它只想回答一个问题：用哪个。所以这里是一个原生 `<select>`：
 * 选项文字自带状态后缀（`· 已安装` / `· 未安装` / `· 需要填命令`），
 * 由 `dropdownOptions` 拼好，本组件不再判断任何东西。
 *
 * 为什么是原生 select 而不是自绘弹层：原生控件自带键盘、触屏、屏幕阅读器行为，
 * 而这一格的全部需求就是「从七行里选一行」。自绘的代价是三十行 JS，收益是零。
 *
 * `value === null` 时多一个「未配置」选项并选中它：设置页在还没选过的时候要能
 * 如实显示这个状态，而不是假装已经选了列表里的第一行（那会是「现在会跑什么」的谎）。
 *
 * `emptyLabel` 只改那一行的字（P2.10）：配了模型接口时这一格治的是**另一条路**，
 * 行首已经写着「平台统一模型 · x」、旁边还有 `CLI` 标签，再显示一个「未配置」
 * 会让整行读起来像没配——那一格的诚实说法是「未选」。
 */
export function GeneratorSelect({
  options, value, onChange, disabled, emptyLabel = '未配置',
}: {
  options: CandidateOption[];
  /** 当前选中的 id；null = 还没配置。 */
  value: CandidateId | null;
  onChange: (id: CandidateId) => void;
  disabled?: boolean;
  /** `value === null` 时那一行的字；默认「未配置」。 */
  emptyLabel?: string;
}) {
  return (
    <select
      className="gen-sel"
      aria-label="生成器"
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as CandidateId)}
    >
      {value === null && <option value="">{emptyLabel}</option>}
      {options.map((option) => (
        <option key={option.id} value={option.id}>{option.text}</option>
      ))}
    </select>
  );
}

export default GeneratorSelect;
