/**
 * 形状容错的**表驱动**测试。
 *
 * 这张表的每一行都对应一次真实观测（`scripts/shape-corpus.ts` 跑出的 132 次调用，
 * 报告见 `docs/superpowers/plans/p3-04-shape-corpus.md`）。加新行时把「模型原文」
 * 一起写下来——没有原文的容错是猜的，猜出来的容错会把真话判成假话（已经发生过一次：
 * 一条字符串里拼了三份证据，只认第一个，于是把真实存在的路径报成不存在）。
 */
import { describe, expect, it } from 'vitest';
import {
  answerTruncated, coerceAnswer, looksTruncated, noJsonReason, normalizeFrame, normalizeKind, normalizeVerdict,
} from '../src/core/uemaster/shape.js';
import { normalizeMermaid } from '../src/core/uemaster/compose.js';

const REPOS = ['123pan-pc', '123pan-uni-app'];
const evidenceOf = (raw: unknown): unknown =>
  (coerceAnswer(raw, REPOS) as { findings: { evidence: unknown }[] }).findings[0]!.evidence;

describe('verdict：13 种真实写法', () => {
  const rows: Array<[string, unknown, string]> = [
    ['规范值', 'implemented', 'implemented'],
    ['中文', '一致', 'implemented'],
    ['粘着斜杠', 'missing/缺失', 'missing'],
    ['括号注释', 'implemented（一致）', 'implemented'],
    ['自创第五值', 'partial/部分实现', 'differs'],
    ['自创第五值（英文）', 'inconsistent', 'differs'],
    ['多余 + 不在范围', '多余/不在范围', 'extra'],
    ['extra + 中文', 'extra/多余', 'extra'],
    ['包了一层数组', ['inconsistent/不一致'], 'differs'],
    ['整句判定', '大部分一致但缺面包屑', 'missing'],
  ];
  for (const [name, input, want] of rows) {
    it(name, () => expect(normalizeVerdict(input)).toBe(want));
  }

  it('认不出来的原样返回，交给 zod 拒（不猜）', () => {
    expect(normalizeVerdict('大概可以吧')).toBe('大概可以吧');
  });
});

describe('evidence：四种真实形状', () => {
  it('字符串数组 repo:path', () => {
    expect(evidenceOf({ findings: [{ verdict: 'differs', evidence: ['123pan-pc:src/a.ts'] }] }))
      .toEqual([{ repo: '123pan-pc', path: 'src/a.ts', note: '' }]);
  });

  it('对象用 file 键（不是 repo/path）', () => {
    const out = evidenceOf({ findings: [{ verdict: 'differs', evidence: [{ file: '123pan-pc:src/b.ts', note: 'n' }] }] });
    expect(out).toEqual([{ file: '123pan-pc:src/b.ts', note: 'n', repo: '123pan-pc', path: 'src/b.ts' }]);
  });

  it('**一条字符串里拼了三份**（30 条真实回话是这种）', () => {
    const out = evidenceOf({
      findings: [{ verdict: 'differs', evidence: '123pan-pc:src/a.ts、123pan-uni-app:src/b.vue、123pan-pc:src/c.ts' }],
    }) as Array<{ repo: string; path: string }>;
    expect(out).toHaveLength(3);
    expect(out.map((e) => `${e.repo}:${e.path}`)).toEqual([
      '123pan-pc:src/a.ts', '123pan-uni-app:src/b.vue', '123pan-pc:src/c.ts',
    ]);
  });

  it('只给裸路径且只有一个仓：补上仓库', () => {
    const out = coerceAnswer({ findings: [{ verdict: 'extra', evidence: [{ path: 'src/d.ts' }] }] }, ['123pan-pc']);
    expect((out as { findings: { evidence: Array<{ repo: string }> }[] }).findings[0]!.evidence[0]!.repo).toBe('123pan-pc');
  });
});

describe('pages：anno / frame / kind / 多余节点', () => {
  it('anno 少一层数组（平铺成对）', () => {
    const out = coerceAnswer({ nodes: [{ id: 'A', anno: ['一致', '说明'] }] }, [], ['A']) as { nodes: Array<{ anno: unknown }> };
    expect(out.nodes[0]!.anno).toEqual([['一致', '说明']]);
  });

  it('frame 写成中文', () => {
    expect(normalizeFrame('分享页浏览')).toBe('phone');
    expect(normalizeFrame('后台管理宽窗')).toBe('wide');
  });

  it('kind 写成中文', () => {
    expect(normalizeKind('判断')).toBe('decision');
    expect(normalizeKind('系统')).toBe('system');
  });

  it('图里不存在的节点被丢掉（挂了也放不进 walkmap）', () => {
    const out = coerceAnswer({
      nodes: [{ id: 'A', anno: [['一致', 'x']] }, { id: 'H', anno: [['一致', 'y']] }],
    }, [], ['A', 'B']) as { nodes: Array<{ id: string }> };
    expect(out.nodes.map((n) => n.id)).toEqual(['A']);
  });
});

describe('searched：布尔与字符串', () => {
  it('布尔 true → 丢掉这一格（只表示搜过，没给词组）', () => {
    const out = coerceAnswer({ findings: [{ verdict: '一致', searched: true, evidence: [] }] }) as { findings: Array<Record<string, unknown>> };
    expect('searched' in out.findings[0]!).toBe(false);
  });

  it('字符串 → 包一层数组', () => {
    const out = coerceAnswer({ findings: [{ verdict: '一致', searched: '面包屑', evidence: [] }] }) as { findings: Array<{ searched: unknown }> };
    expect(out.findings[0]!.searched).toEqual(['面包屑']);
  });
});

describe('截断：与"语法错误"分开说', () => {
  it('大括号没闭合 → 判截断', () => {
    expect(looksTruncated('{"nodes":[{"id":"A","html":"<div>')).toBe(true);
  });

  it('以逗号/冒号收尾 → 判截断', () => {
    expect(looksTruncated('{"nodes":[{"id":"A"},')).toBe(true);
  });

  it('完整 JSON 与纯文字都不算截断', () => {
    expect(looksTruncated('{"nodes":[{"id":"A"}]}')).toBe(false);
    expect(looksTruncated('好的，我来生成这份材料')).toBe(false);
  });

  it('措辞要点名"预算"，不要误导成结构问题', () => {
    expect(noJsonReason('{"nodes":[{"id":"A"')).toContain('输出预算');
    expect(noJsonReason('这里没有 JSON')).toContain('没有 JSON');
  });

  it('整体判断：代码围栏内的截断也认得出', () => {
    expect(answerTruncated('```json\n{"nodes":[{"id":"A"')).toBe(true);
  });
});

describe('mermaid：一行串起来的链', () => {
  it('a --> b --> c 拆成两条边（引擎只认一行一条）', () => {
    const out = normalizeMermaid('flowchart TD\nA --> B --> C');
    expect(out.split('\n').filter((l) => l.includes('-->'))).toEqual(['A --> B', 'B --> C']);
  });

  it('拆开后连边标签仍跟着正确的那一段走', () => {
    const out = normalizeMermaid('flowchart TD\nA -->|是| B -->|否| C');
    expect(out).toContain('A -->|是| B');
    expect(out).toContain('B -->|否| C');
  });

  it('本来就是一行一条边的，原样返回', () => {
    const src = 'flowchart TD\nA --> B\nB --> C';
    expect(normalizeMermaid(src)).toBe(src);
  });
});

describe('顶层形状', () => {
  it('整个回答是数组（只有 findings）', () => {
    const out = coerceAnswer([{ verdict: '一致', evidence: [] }]) as { flows: unknown[]; findings: unknown[] };
    expect(out.flows).toEqual([]);
    expect(out.findings).toHaveLength(1);
  });

  it('nodes 形状的回话不被补进 flows/findings（会伪造"结构不完整"）', () => {
    const out = coerceAnswer({ nodes: [{ id: 'A', anno: [['一致', 'x']] }] }, [], ['A']) as Record<string, unknown>;
    expect('flows' in out).toBe(false);
    expect('findings' in out).toBe(false);
  });
});

describe('节点漏字段与仓库反推（旧语料 132 次里各 2 / 1 次）', () => {
  it('节点漏写 title → 用 id 补（id 是唯一标识，不构成编造）', () => {
    const out = coerceAnswer({ nodes: [{ id: 'C1', kind: 'page', anno: [['一致', 'x']] }] }, [], ['C1']) as {
      nodes: Array<{ title?: string }>;
    };
    expect(out.nodes[0]!.title).toBe('C1');
  });

  it('repo 留空但路径只在一个仓里存在 → 反推成那个仓', async () => {
    const { validateStructure } = await import('../src/core/uemaster/inspect.js');
    const trees = new Map([
      ['123pan-pc', new Set(['src/pc-only.ts'])],
      ['123pan-uni-app', new Set(['src/uni-only.vue'])],
    ]);
    const doc = {
      flows: [1, 2, 3].map((i) => ({ id: String.fromCharCode(64 + i), title: 't', kind: 'page' as const })),
      findings: [{
        verdict: 'differs' as const, prd: 'p', code: 'c', evidence: [{ repo: '', path: 'src/uni-only.vue', note: '' }],
      }],
    };
    expect(validateStructure(doc, trees).ok).toBe(true);
  });

  it('路径两个仓都没有 → 说清"这个文件不存在"，而不是"仓库『』不在范围内"', async () => {
    const { validateStructure } = await import('../src/core/uemaster/inspect.js');
    const trees = new Map([['123pan-pc', new Set(['a.ts'])], ['123pan-uni-app', new Set(['b.vue'])]]);
    const doc = {
      flows: [1, 2, 3].map((i) => ({ id: String.fromCharCode(64 + i), title: 't', kind: 'page' as const })),
      findings: [{
        verdict: 'differs' as const, prd: 'p', code: 'c', evidence: [{ repo: '', path: 'src/nope.ts', note: '' }],
      }],
    };
    const out = validateStructure(doc, trees);
    expect(out.ok).toBe(false);
    expect(out.problems.join('；')).toContain('都不存在');
  });
});
