import { describe, expect, it } from 'vitest';

import {
  locateAcross,
  type CodeIndex,
  type FileKind,
  type IndexFile,
  type IndexRoute,
} from '../src/core/codemirror/code-index.js';
import { CANDIDATES_LINE } from '../src/core/locate/copy.js';
import { probeToCandidate } from '../src/core/locate/structure.js';
import {
  EXPAND_CAP,
  expandedKeywords,
  locateFromStructure,
} from '../src/core/locate/structure.js';

/**
 * 这一整个文件都**不发 ssh、不连库、不开网**：`expand` 是注入的，索引是手搓的。
 *
 * 手搓索引不是偷懒：任务 5 那套用的是真 git 仓（因为要验 `--since` 的边界），而这一层
 * 的输入本来就只是一份「结构摘要」，形状在 `CodeIndex` 里定死了。造一份索引比造一个仓
 * 快两个数量级，且能精确摆出「两个仓、只有一个命中」这种真仓里凑不出来的局面。
 */

const file = (kind: FileKind, exports: string[] = []): IndexFile => ({ kind, exports, size: 1 });

const index = (
  repo: string,
  files: Record<string, IndexFile>,
  routes: IndexRoute[] = [],
  imports: Record<string, string[]> = {},
): CodeIndex => ({
  repo,
  sha: 'f9714f6f9714f6f9714f6f9714f6f9714f6f9714',
  files,
  imports,
  routes,
  builtAt: '2026-11-07T00:00:00.000Z',
});

// ─── 扩展词 ──────────────────────────────────────────────────────────────────

describe('扩展词', () => {
  it('模型给出词就用模型的（去重、去空、限 12 个）', async () => {
    const got = await expandedKeywords(
      async () => ['权益', 'vip', '', '权益', 'member'],
      '权益套餐',
      '',
      ['原始'],
    );
    expect(got).toEqual(['权益', 'vip', 'member']);
  });

  it('首尾空白与纯空白项都清掉，顺序按模型给的来（不去排序）', async () => {
    const got = await expandedKeywords(
      async () => ['  套餐  ', ' \t ', 'vip等级', ' 套餐'],
      '权益套餐',
      '',
      ['原始'],
    );
    // 顺序刻意不是字典序：模型给的顺序带着它自己的判断，重排等于我们在猜它的意思。
    expect(got).toEqual(['套餐', 'vip等级']);
  });

  it('模型失败 → 用原始关键词，不重试也不抛', async () => {
    const got = await expandedKeywords(async () => null, '权益套餐', '', ['权益', '套餐']);
    expect(got).toEqual(['权益', '套餐']);
  });

  it('模型抛异常 → 也是回落，调用方看不到异常', async () => {
    let calls = 0;
    const got = await expandedKeywords(
      async () => {
        calls += 1;
        throw new Error('模型 502');
      },
      '权益套餐',
      '',
      ['权益', '套餐'],
    );
    expect(got).toEqual(['权益', '套餐']);
    // 「不重试」是可观测的：一次失败只允许打一次。
    expect(calls).toBe(1);
  });

  it('模型给空数组 → 也回落', async () => {
    const got = await expandedKeywords(async () => [], 'x', '', ['原始']);
    expect(got).toEqual(['原始']);
  });

  it('模型只给空串 → 清洗后为空 → 回落', async () => {
    const got = await expandedKeywords(async () => ['', '   '], 'x', '', ['原始']);
    expect(got).toEqual(['原始']);
  });

  it('模型给 20 个 → 只留前 12 个', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `词${i}`);
    const got = await expandedKeywords(async () => many, 'x', '', ['原始']);
    expect(got).toHaveLength(EXPAND_CAP);
    expect(EXPAND_CAP).toBe(12);
    expect(got).toEqual(many.slice(0, 12));
  });

  it('满 12 个的边界不动（12 个就是 12 个）', async () => {
    const exact = Array.from({ length: 12 }, (_, i) => `词${i}`);
    const got = await expandedKeywords(async () => exact, 'x', '', ['原始']);
    expect(got).toEqual(exact);
  });

  it('标题与描述原样交给模型', async () => {
    const seen: Array<[string, string]> = [];
    await expandedKeywords(
      async (title, description) => {
        seen.push([title, description]);
        return ['搜索'];
      },
      '文件搜索优化',
      '列表页要能按名字搜索',
      ['搜索'],
    );
    expect(seen).toEqual([['文件搜索优化', '列表页要能按名字搜索']]);
  });

  it('回落值不跟调用方共享同一个数组（调用方后续乱改不会污染结果）', async () => {
    const fallback = ['权益', '套餐'];
    const got = await expandedKeywords(async () => null, 'x', '', fallback);
    fallback.push('后面加的');
    expect(got).toEqual(['权益', '套餐']);
  });
});

// ─── 结构检索 ────────────────────────────────────────────────────────────────

describe('结构检索', () => {
  it('索引全空 → none', () => {
    expect(locateFromStructure(
      [{ repo: 'r', index: { files: {}, imports: {}, routes: [] } as never }],
      ['搜索'],
    ).kind).toBe('none');
  });

  it('一个仓都没有 → none（不是 absent：我们确实看了，只是没有东西可看）', () => {
    const got = locateFromStructure([], ['搜索']);
    expect(got.kind).toBe('none');
  });

  it('多个仓的索引都是空的 → none', () => {
    const got = locateFromStructure([
      { repo: 'uni-app', index: index('uni-app', {}) },
      { repo: 'pc', index: index('pc', {}) },
    ], ['搜索']);
    expect(got.kind).toBe('none');
  });

  it('关键词一个都不命中 → none', () => {
    const got = locateFromStructure([
      {
        repo: 'uni-app',
        index: index('uni-app', { 'src/pages/video/video.vue': file('page') }),
      },
    ], ['权益缩减']);
    expect(got.kind).toBe('none');
  });

  it('只有命中的那个仓出候选，另一个仓一条都不出', () => {
    const got = locateFromStructure([
      {
        repo: 'uni-app',
        index: index(
          'uni-app',
          { 'src/pages/search/search.vue': file('page', ['searchFiles']) },
          [{ route: '/search', file: 'src/pages/search/search.vue', title: '搜索' }],
        ),
      },
      {
        // 后端仓：一个 JS/TS 页面都没有，索引空着。它不是「没找到」，是「没东西可找」。
        repo: 'server',
        index: index('server', {}),
      },
    ], ['搜索']);

    expect(got.kind).toBe('candidates');
    if (got.kind !== 'candidates') return;
    expect(got.confidence).toBe('low');
    expect(got.items.map((item) => item.path)).toEqual(['src/pages/search/search.vue']);
    expect(got.items.every((item) => item.source === 'structure')).toBe(true);
  });

  it('顺序照 locateAcross 给的来：仓的顺序就是 entries 的顺序，不跨仓按分重排', () => {
    const low = index('low', { 'src/components/search-bar/index.vue': file('component') });
    const high = index(
      'high',
      { 'src/pages/search/search.vue': file('page') },
      [{ route: '/search', file: 'src/pages/search/search.vue', title: '搜索' }],
    );
    const entries = [{ repo: 'low', index: low }, { repo: 'high', index: high }];

    // 期望值不手抄一遍排名规则：直接问 `locateAcross`，只钉「我们不重排」这件事。
    const choices = locateAcross(entries, ['搜索']);
    const expected: string[] = [];
    for (const choice of choices.values()) {
      if (choice.source === 'index') expected.push(...choice.probes.map((probe) => probe.path));
    }
    expect(expected).toHaveLength(2);

    const got = locateFromStructure(entries, ['搜索']);
    if (got.kind !== 'candidates') throw new Error(`期望 candidates，实际 ${got.kind}`);
    expect(got.items.map((item) => item.path)).toEqual(expected);
    // 高分的那个仓在 entries 里排第二，所以它在清单里也必须排第二。
    expect(got.items[0]?.path).toBe('src/components/search-bar/index.vue');
  });

  it('每条的 reason 都非空（空的 why 会在材料里渲染成一个悬空的箭头）', () => {
    const got = locateFromStructure([
      {
        repo: 'uni-app',
        index: index(
          'uni-app',
          {
            'src/pages/search/search.vue': file('page', ['searchFiles']),
            'src/services/search-api.ts': file('service', ['searchByKeyword']),
            'src/components/search-bar/index.vue': file('component'),
          },
          [{ route: '/search', file: 'src/pages/search/search.vue', title: '搜索' }],
        ),
      },
    ], ['搜索']);

    if (got.kind !== 'candidates') throw new Error(`期望 candidates，实际 ${got.kind}`);
    expect(got.items.length).toBeGreaterThan(1);
    for (const item of got.items) {
      expect(item.reason.trim()).not.toBe('');
    }
    // 交给文案层就能直接渲染——`CANDIDATES_LINE` 对空数组是抛的。
    expect(() => CANDIDATES_LINE(got.items)).not.toThrow();
  });

  it('why 是空的探针也照样给一句话（不让箭头后面空着）', () => {
    const item = probeToCandidate({ path: 'src/pages/a.vue', kind: 'page', score: 6, why: '   ' });
    expect(item.reason.trim()).not.toBe('');
    expect(item.reason).not.toContain('a.vue');
    expect(item.source).toBe('structure');
  });

  it('limit 是每仓上限，不是全局上限', () => {
    const files: Record<string, IndexFile> = {
      'src/pages/search/search.vue': file('page'),
      'src/pages/search/result.vue': file('page'),
      'src/components/search-bar/index.vue': file('component'),
    };
    const got = locateFromStructure([{ repo: 'uni-app', index: index('uni-app', files) }], ['搜索'], { limit: 1 });
    if (got.kind !== 'candidates') throw new Error(`期望 candidates，实际 ${got.kind}`);
    expect(got.items).toHaveLength(1);
  });

  it('score 原样带出来，不在这一层改成 0..1 或再加权', () => {
    const got = locateFromStructure([
      { repo: 'uni-app', index: index('uni-app', { 'src/pages/search/search.vue': file('page') }) },
    ], ['搜索']);
    if (got.kind !== 'candidates') throw new Error(`期望 candidates，实际 ${got.kind}`);
    const probes = locateAcross(
      [{ repo: 'uni-app', index: index('uni-app', { 'src/pages/search/search.vue': file('page') }) }],
      ['搜索'],
    );
    const choice = probes.get('uni-app');
    const first = choice?.source === 'index' ? choice.probes[0]?.score : undefined;
    expect(got.items[0]?.score).toBe(first);
  });
});
