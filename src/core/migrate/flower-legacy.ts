import { normalizePlatforms, type PlatformKey } from '../requirements/platforms.js';
import type { State } from '../state-machine.js';

/**
 * Flower（老系统）→ flowers 的**字段口径本身**（2026-11-10 从 `scripts/migrate-flower.ts`
 * 搬过来）。
 *
 * 为什么单独一个模块：那 11 个状态与平台标签的映射，是切换域名时唯一的语义翻译表——
 * 它必须能被用例逐条钉住（「11 个旧状态一条都不许丢」）。而 `scripts/migrate-flower.ts`
 * 是**脚本**：顶层就会 ssh 取数、连库、打印报告，用例 import 它等于每次跑测试都连一次
 * 生产 Flower。搬到这里之后，脚本只负责「解析 → 打印 → 写库」。
 */

export const STATE_MAP: Readonly<Record<string, State>> = {
  collect: 'inbox',
  // owner 裁决：待评估都是收集。
  to_evaluate: 'inbox',
  to_design: 'design',
  designing: 'design',
  // owner 裁决：已评估都改为待设计。
  evaluated: 'design',
  to_develop: 'ready',
  developing: 'dev',
  testing: 'test',
  launched: 'live',
  rejected: 'rejected',
  shelved: 'shelved',
};

export const PLATFORM_MAP: Readonly<Record<string, PlatformKey>> = {
  'Web端': 'web',
  '移动端': 'mobile',
  'PC客户端': 'pc',
  '小程序': 'mini',
  '后端': 'backend',
  '管理后台': 'admin',
  'Manager后台': 'manager',
  '前端': 'frontend',
  'H5': 'h5',
  '开放平台': 'open',
  '鸿蒙': 'harmony',
  'TV端': 'tv',
  'H5-分享页': 'h5',
  'h5端': 'h5',
  'pc端': 'pc',
  '管理端': 'admin',
  '企业管理后台': 'admin',
  manager: 'manager',
  '支付宝': 'mobile',
};

/** 库里这条老数据现在的样子（只取会被刷新的四格）。 */
export type LegacyCurrent = {
  title: string; state: string; priority: string | null; platforms: string[];
};

/** Flower 那边现在的样子（已经映射到我们的词表）。 */
export type LegacyWanted = {
  title: string; state: State; priority: string | null; platforms: PlatformKey[];
};

/**
 * 四格差异：返回变了哪几格（`title` / `state` / `priority` / `platforms`）。
 *
 * 纯函数，只有这一处判「算不算变了」，所以它对「平台顺序」「null 与空数组」这些
 * 归一问题的答案只有一份：平台按集合比（`normalizePlatforms` 已经排过序，这里还是
 * 排序后再比，免得哪天上游顺序变了就全量报变更）。
 */
export function legacyDiff(current: LegacyCurrent, wanted: LegacyWanted): string[] {
  const changed: string[] = [];
  if (current.title !== wanted.title) changed.push('title');
  if (current.state !== wanted.state) changed.push('state');
  if ((current.priority ?? null) !== (wanted.priority ?? null)) changed.push('priority');
  const a = [...(current.platforms ?? [])].sort().join(',');
  const b = normalizePlatforms(wanted.platforms).slice().sort().join(',');
  if (a !== b) changed.push('platforms');
  return changed;
}
