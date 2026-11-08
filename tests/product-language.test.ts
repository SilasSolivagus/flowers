import { describe, expect, it } from 'vitest';

import {
  PRODUCT_BODY_ANTI_EXAMPLE, PRODUCT_BODY_EXAMPLE, PRODUCT_BODY_RULE, REFERENCE_TITLE,
  referenceLines, type CodeRef,
} from '../src/core/locate/copy.js';
import { injectReference, referenceHtml } from '../src/core/locate/reference.js';
import {
  MIN_REMAIN, findProseLeaks, hasProseLeak, relocateHtmlBody, relocateProse,
} from '../src/core/uemaster/body-language.js';
import { findingsAnno, findingsPrompt, reviewRefs } from '../src/core/uemaster/review.js';
import { fragmentsPrompt, flowPrompt, type FlowNode, type RequirementRow } from '../src/core/uemaster/compose.js';
import { structurePrompt, verifyPrompt } from '../src/core/uemaster/inspect.js';
import { EMPTY_SURFACES } from '../src/core/locate/copy.js';

/**
 * 两层语言（2026-11-09 的产品决定）：正文说产品的话，坐标降级成脚注。
 *
 * ── 为什么这一组用例的东西必须存在
 *
 * owner 读了一份真实材料，把这句话退回来了：
 *   「落点是 `service/cdn_link.go:382` 的 `(*cdnLink).getUserCustomDomainIsShortLink` 私有方法，
 *    改动面在 `service/cdn_link.go` 及其调用方，不在 `component/`」
 *
 * 他的原话是「这种好像也不对吧 得是产品语言吧」。读者是功能线/商业线负责人与 PM，
 * 他们**跳过**任何一句「文件路径 + Go 方法名」。
 *
 * 这一次的教训不是「提示词里少写了一句话」，而是「只写进提示词就等于没写」：模型读到
 * 一份现状摘录，它自然会觉得「说得更具体更好」。所以规矩落在四处，四处都要有锚点：
 *
 * 1. **提示词**：三份材料的提示词都带同一条规矩 + 同一个正例（`PRODUCT_BODY_RULE`）；
 * 2. **机器检查**：`findProseLeaks` / `relocateProse` / `relocateHtmlBody`——正文里
 *    出现坐标就删掉那一句，并把它搬进脚注；
 * 3. **脚注本身**：`referenceLines` + `injectReference`——`仓:路径:行号 符号` +
 *    受影响文件数；**没有坐标就整节不写**；
 * 4. **我们自己那一处**：`findingsAnno` 原来往右栏写 `（现在：src/pages/x.tsx）`，
 *    那是唯一一处由**代码**（不是模型）往正文里塞路径的地方，已在代码里删掉。
 */

const req = {
  id: 'r1', number: 613, title: '自定义域名备案失效告警与分享页独立 CNAME',
  type: 'feature', requester: '吕品', prd_url: null, context: null, problem: null,
  outcome: null, surfaces: null, edge_cases: null, out_of_scope: null,
  platforms: ['backend'], priority: null,
} as unknown as RequirementRow;

const NODES: FlowNode[] = [
  { id: 'A', label: '进入分享页', kind: 'process' },
  { id: 'B', label: '是否已备案？', kind: 'decision' },
];

const PRD = {
  version: 'v1', hash: 'h', chars: 20, truncated: false, markdown: '自定义域名备案失效时要告警。',
  snapshot: { markdown: '自定义域名备案失效时要告警。' },
} as unknown as Parameters<typeof findingsPrompt>[1];

/** 走查的两个仓（`structurePrompt` 要 `RepoBaseline` 的形状）。 */
const REPOS = [
  {
    id: 'apisrv', sha: 'a'.repeat(40), date: '2026-11-06T18:35:27+08:00', subject: 'Merge #292',
    files: 352, tree: new Set(['service/cdn_link.go']),
    shape: { pages: [], routes: [], api: [], components: [], stores: [], dirs: [] },
    locate: { kind: 'none' as const },
  },
] as unknown as Parameters<typeof structurePrompt>[2];

// ─── 1. 提示词：三份材料都带同一条规矩与同一个正例 ──────────────────────────

describe('提示词：正文与坐标分开写', () => {
  it('规矩里同时有正例与反例（反例就是 owner 退回来的那一句）', () => {
    const text = PRODUCT_BODY_RULE.join('\n');
    expect(text).toContain(PRODUCT_BODY_EXAMPLE);
    expect(text).toContain(PRODUCT_BODY_ANTI_EXAMPLE);
    expect(text).toContain('不许');
    expect(text).toContain(REFERENCE_TITLE);
  });

  /**
   * 三份材料各自那一条路（评估=页面片段、评审=问题清单、走查=结构+复核）都要带。
   * 少了任何一条，那一份材料就退回「模型心情」——而它不会报错，只会多一句黑话。
   */
  it('页面片段提示词（评估 / 评审共用）带正例', () => {
    expect(fragmentsPrompt(req, 'evaluate', NODES, EMPTY_SURFACES)).toContain(PRODUCT_BODY_EXAMPLE);
    expect(fragmentsPrompt(req, 'review', NODES, EMPTY_SURFACES)).toContain(PRODUCT_BODY_ANTI_EXAMPLE);
  });

  it('评审的问题清单提示词带正例（why 那一格就是正文）', () => {
    expect(findingsPrompt(req, PRD, NODES)).toContain(PRODUCT_BODY_EXAMPLE);
  });

  it('走查的两个提示词都带正例（结构里的 prd/code，复核里的 anno）', () => {
    const structure = structurePrompt(req, PRD as never, REPOS, ['备案']);
    expect(structure).toContain(PRODUCT_BODY_EXAMPLE);
    const verify = verifyPrompt(
      req, PRD as never, [{ id: 'A', title: '进入分享页', kind: 'page' } as never], [], [],
    );
    expect(verify).toContain(PRODUCT_BODY_EXAMPLE);
  });

  it('图的提示词也提一句（节点文案是产品语言，坐标进脚注）', () => {
    const p = flowPrompt(req, 'evaluate');
    expect(p).toContain('产品语言');
    expect(p).toContain(REFERENCE_TITLE);
    // 图里只有 12 个字的节点文案，塞不下正例：那条提示词只要一句禁令。
    expect(p).not.toContain(PRODUCT_BODY_ANTI_EXAMPLE);
  });
});

// ─── 2. 机器检查 ────────────────────────────────────────────────────────────

describe('findProseLeaks：三种写法都算违规', () => {
  it('`路径:行号` / 带目录的路径 / 反引号标识符', () => {
    expect(findProseLeaks('落点是 service/cdn_link.go:382 的那个方法').map((l) => l.kind))
      .toContain('path-line');
    expect(findProseLeaks('改动面在 src/pages/Share/Share.tsx 里').map((l) => l.kind))
      .toContain('path');
    expect(findProseLeaks('调用了 `getUserCustomDomainIsShortLink` 方法').map((l) => l.kind))
      .toContain('backtick');
  });

  it('产品语言不算违规（这正是正文该有的样子）', () => {
    expect(hasProseLeak(PRODUCT_BODY_EXAMPLE)).toBe(false);
    expect(hasProseLeak('系统现在能判断某个自定义域名是否已备案，缺的是失效后主动告警。')).toBe(false);
    // 页面路由不是文件路径：`/pages/share/index` 是产品里的一个屏，读者要的就是它。
    expect(hasProseLeak('点在 /pages/share/index 这一屏的顶部')).toBe(false);
    // 裸文件名（没有目录）不拦：误伤「文件名恰好就是功能名」的短语，收益太小。
    expect(hasProseLeak('这个 Share.tsx 页面')).toBe(false);
  });
});

describe('relocateProse：删子句、把坐标交出去', () => {
  it('owner 那一句整段被删掉（子句级），剩下的句子还成句', () => {
    const text = '这条需求改的是备案失效的判定规则，落点是 service/cdn_link.go:382 的 `(x).y` 方法。';
    const { text: kept, moved } = relocateProse(text);
    expect(kept).toBe('这条需求改的是备案失效的判定规则。');
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.join(' ')).toContain('service/cdn_link.go:382');
  });

  it('括号里的「（现在：路径）」整块删掉，不留下「现在的」这种残句', () => {
    const { text: kept, moved } = relocateProse('「要能告警」——现在已经会判断了（现在：service/x.go）');
    expect(kept).toBe('「要能告警」——现在已经会判断了');
    expect(moved).toEqual(['service/x.go']);
  });

  it('整格都是坐标时返回空串（调用方据此丢整格，而不是塞一句残句）', () => {
    const { text: kept } = relocateProse('`service/cdn_link.go:382`');
    expect(kept).toBe('');
    expect(MIN_REMAIN).toBeGreaterThan(0);
  });

  it('没有坐标时原样返回（不重排、不改标点）', () => {
    const text = PRODUCT_BODY_EXAMPLE;
    expect(relocateProse(text)).toEqual({ text, moved: [] });
  });
});

describe('relocateHtmlBody：只动文本节点，属性一个字不改', () => {
  const HTML = [
    '<html><body>',
    '<a class="src/pages/a.tsx" onclick="go(\'A\')">点这里</a>',
    '<p>落点是 service/cdn_link.go:382 的方法。</p>',
    '</body></html>',
  ].join('');

  it('正文里的坐标被删掉、属性里的路径保留（那是页面的构造，不是句子）', () => {
    const moved: string[] = [];
    const out = relocateHtmlBody(HTML, moved);
    expect(out).toContain('class="src/pages/a.tsx"');
    expect(out).toContain('onclick="go(\'A\')"');
    expect(out).not.toContain('service/cdn_link.go:382');
    expect(moved).toContain('service/cdn_link.go:382');
  });

  it('没有 <body> 时原样返回（排版器换模板不该让材料出不来）', () => {
    expect(relocateHtmlBody('<div>service/x.go:1</div>')).toBe('<div>service/x.go:1</div>');
  });

  it('<head> 里的标题不动（它是文档标题，不是正文）', () => {
    const html = '<html><head><title>a.tsx:1</title></head><body><p>正文</p></body></html>';
    expect(relocateHtmlBody(html)).toContain('<title>a.tsx:1</title>');
  });
});

// ─── 3. 脚注：研发参考 ──────────────────────────────────────────────────────

describe('referenceLines / injectReference', () => {
  const refs: CodeRef[] = [
    { repo: 'apisrv', path: 'service/cdn_link.go', line: 382, symbol: '(*cdnLink).getUserCustomDomainIsShortLink' },
    { repo: 'apisrv', path: 'service/cdn_link.go', line: 382, symbol: '(*cdnLink).getUserCustomDomainIsShortLink' },
    { repo: 'apisrv', path: 'service/cdn_link.go', line: 120, symbol: '(*cdnLink).setDomain' },
    { repo: '123pan-pc', path: 'src/pages/Share/Share.tsx' },
  ];

  it('一行一个坐标、去重、末尾给受影响文件数（按路径数，不按行数）', () => {
    expect(referenceLines(refs)).toEqual([
      'apisrv:service/cdn_link.go:382 (*cdnLink).getUserCustomDomainIsShortLink',
      'apisrv:service/cdn_link.go:120 (*cdnLink).setDomain',
      '123pan-pc:src/pages/Share/Share.tsx',
      '受影响文件：2 个',
    ]);
  });

  it('没有坐标时是空数组（整节不写，绝不写「无」）', () => {
    expect(referenceLines([])).toEqual([]);
    expect(referenceLines([{ repo: '', path: '' }])).toEqual([]);
  });

  it('从正文搬过来的坐标照样进这一节，但**不进**受影响文件计数（它可能缺仓名）', () => {
    const lines = referenceLines([refs[0]!], ['service/x.go:12']);
    expect(lines).toEqual([
      'apisrv:service/cdn_link.go:382 (*cdnLink).getUserCustomDomainIsShortLink',
      'service/x.go:12',
      '受影响文件：1 个',
    ]);
  });

  it('插在 </body> 之前（最后一个），标题就是「研发参考」', () => {
    const out = injectReference('<html><body><p>正文</p></body></html>', referenceLines(refs));
    expect(out.indexOf(REFERENCE_TITLE)).toBeGreaterThan(out.indexOf('正文'));
    expect(out.indexOf(REFERENCE_TITLE)).toBeLessThan(out.indexOf('</body>'));
    expect(out).toContain('data-dev-reference="1"');
  });

  it('空清单 → 原样返回（评估材料通常走这一支）', () => {
    const html = '<html><body><p>正文</p></body></html>';
    expect(injectReference(html, [])).toBe(html);
  });

  it('有坐标却没有 </body> → 抛（静默跳过等于这一节悄悄消失）', () => {
    expect(() => injectReference('<div>没有 body</div>', referenceLines(refs))).toThrow(/body/);
  });

  it('路径里的尖括号被转义（不破坏结构）', () => {
    expect(referenceHtml(['a<b>.go'])).toContain('a&lt;b&gt;.go');
  });
});

// ─── 4. 我们自己那一处：右栏不再写路径 ──────────────────────────────────────

describe('findingsAnno：正文里不再出现现状路径', () => {
  it('带 code 的那三类条目，右栏只有「引文 + 为什么」', () => {
    const anno = findingsAnno([{
      type: 'conflicts_current', node: 'B', quote: '失效后要主动告警',
      why: '现在只判断不告警', code: { repo: 'apisrv', path: 'service/cdn_link.go' },
    }]);
    expect(anno).toHaveLength(1);
    const body = anno[0]![1];
    expect(body).toContain('现在只判断不告警');
    expect(body).not.toContain('service/cdn_link.go');
    expect(body).not.toContain('（现在：');
  });
});

describe('reviewRefs：脚注的坐标来自已核过的两处', () => {
  const baseline = {
    locate: { kind: 'candidates' as const, source: 'index' as const, items: [{ path: 'src/pages/Share/Share.tsx', reason: 'x' }] },
    trees: new Map([['123pan-pc', new Set(['src/pages/Share/Share.tsx'])]]),
    indexes: new Map([['123pan-pc', {
      repo: '123pan-pc', sha: 'a'.repeat(40), files: {}, imports: {}, importedBy: {},
      routes: [], pages: [], skippedGenerated: 0, builtAt: '2026-11-09T00:00:00.000Z',
      outline: { 'src/pages/Share/Share.tsx': [{ kind: 'symbol', name: 'Share', line: 12 }] },
    }]]),
  };

  it('候选进脚注，且带上索引里的行号与符号', () => {
    const refs = reviewRefs([], baseline as never);
    expect(refs).toEqual([
      { repo: '123pan-pc', path: 'src/pages/Share/Share.tsx', line: 12, symbol: 'Share' },
    ]);
    expect(referenceLines(refs)).toEqual([
      '123pan-pc:src/pages/Share/Share.tsx:12 Share',
      '受影响文件：1 个',
    ]);
  });

  it('索引里没有轮廓时行号留空（不猜一行）', () => {
    const refs = reviewRefs([{
      type: 'no_migration', node: 'A', quote: 'q', why: 'w', code: { repo: '', path: 'src/x.ts' },
    }], {
      ...baseline,
      trees: new Map([['123pan-pc', new Set(['src/x.ts'])]]),
    } as never);
    expect(refs).toEqual([{ repo: '123pan-pc', path: 'src/x.ts', line: null, symbol: null }]);
  });
});
