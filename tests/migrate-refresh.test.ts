import { describe, expect, it } from 'vitest';

import { legacyDiff, STATE_MAP, PLATFORM_MAP } from '../src/core/migrate/flower-legacy.js';

/**
 * 切换日的「最后一次对齐」（2026-11-10）。
 *
 * Flower 只读之前，常有人在那边改标题、推状态。这些行已经在库里（`legacy_ref` 有值），
 * `--apply` 会跳过它们——于是切换后看板显示的是几个小时前的状态。`--refresh` 就是补这一刀，
 * 而它判「变没变」只靠 `legacyDiff` 这个纯函数，所以这一组用例钉的就是那条判据。
 *
 * 不起库、不连 Flower：这里要证明的是「四格比较的边界」——平台顺序、null 与空数组、
 * 只看会被刷新的那四格（负责人/提出人不在这个函数的判据里）。
 */
describe('legacyDiff：四格判据', () => {
  const current = {
    title: '权益套餐产品结构改造',
    state: 'queue',
    priority: 'p1',
    platforms: ['h5', 'mobile'],
  };

  it('四格都一样 → 不算变更（顺序不同的平台也算一样）', () => {
    expect(legacyDiff(current, {
      title: '权益套餐产品结构改造', state: 'queue' as never, priority: 'p1',
      platforms: ['mobile', 'h5'] as never,
    })).toEqual([]);
  });

  it('分别报出变了哪几格，顺序固定（title → state → priority → platforms）', () => {
    expect(legacyDiff(current, {
      title: '改了标题', state: 'ready' as never, priority: 'p0',
      platforms: ['mobile'] as never,
    })).toEqual(['title', 'state', 'priority', 'platforms']);

    expect(legacyDiff(current, {
      title: current.title, state: 'ready' as never, priority: 'p1',
      platforms: ['h5', 'mobile'] as never,
    })).toEqual(['state']);
  });

  it('null 与空数组是同一件事（未定 / 未标注），不是「变了」', () => {
    expect(legacyDiff(
      { ...current, priority: null, platforms: [] },
      { title: current.title, state: 'queue' as never, priority: null, platforms: [] as never },
    )).toEqual([]);
  });

  it('平台从「无」到「有」算变更，反过来也算', () => {
    expect(legacyDiff(
      { ...current, platforms: [] },
      { title: current.title, state: 'queue' as never, priority: 'p1', platforms: ['h5'] as never },
    )).toEqual(['platforms']);
    expect(legacyDiff(
      { ...current, platforms: ['h5'] },
      { title: current.title, state: 'queue' as never, priority: 'p1', platforms: [] as never },
    )).toEqual(['platforms']);
  });
});

describe('映射表是老数据的兼容面', () => {
  it('11 个旧状态都有落点（切域名时一条都不许丢）', () => {
    const states = [
      'collect', 'to_evaluate', 'evaluated', 'to_design', 'designing',
      'to_develop', 'developing', 'testing', 'launched', 'rejected', 'shelved',
    ];
    for (const state of states) expect(STATE_MAP[state], state).toBeDefined();
    // 两条 owner 裁决过的折格：待评估 → 收集，已评估 → 待设计。
    expect(STATE_MAP.to_evaluate).toBe('inbox');
    expect(STATE_MAP.evaluated).toBe('design');
  });

  it('平台标签到键的映射覆盖 Flower 实际用到的写法', () => {
    expect(PLATFORM_MAP['Web端']).toBe('web');
    expect(PLATFORM_MAP['移动端']).toBe('mobile');
    expect(PLATFORM_MAP['PC客户端']).toBe('pc');
    expect(PLATFORM_MAP['管理后台']).toBe('admin');
  });
});

describe('花名册导入的名单', () => {
  it('7 个人、邮箱唯一、恰好一个超管', async () => {
    const { ROSTER } = await import('../src/core/migrate/roster.js');
    expect(ROSTER).toHaveLength(7);
    expect(new Set(ROSTER.map((p) => p.email)).size).toBe(7);
    expect(ROSTER.filter((p) => p.role === 'product_owner')).toHaveLength(1);
    // 两个评审人各自对应一条线，其余是 PM——这是 P4-04 的角色口径。
    expect(ROSTER.filter((p) => p.role === 'feature_reviewer').map((p) => p.line))
      .toEqual(['feature']);
    expect(ROSTER.filter((p) => p.role === 'commercial_reviewer').map((p) => p.line))
      .toEqual(['commercial']);
    for (const person of ROSTER) expect(person.email.endsWith('@123pan.com')).toBe(true);
  });
});
