import { describe, expect, it, vi } from 'vitest';

import {
  GAP_RIGHT_BLOCK, GAP_WRONG_BLOCK, PRODUCT_BODY_RULE, REFERENCE_TITLE,
  referenceLines, type CodeRef,
} from '../src/core/locate/copy.js';
import { injectReference } from '../src/core/locate/reference.js';
import {
  MOVED_HINT, VERDICT_ROW_TITLES, countHtmlBodyHits, countProseHits, findProseLeaks,
  hasProseLeak, relocateHtmlBody, relocateProse, reportVocab, rewriteClause, sanitizeAnno,
  vocabReportLine, type LeakMode,
} from '../src/core/uemaster/body-language.js';
import { VERDICT_NOUN } from '../src/core/uemaster/inspect.js';
import { assembleWalkmap, fragmentsPrompt, fragmentsRepairPrompt } from '../src/core/uemaster/compose.js';
import {
  findingsPrompt, findingsRepairPrompt,
} from '../src/core/uemaster/review.js';
import {
  structurePrompt, structureRepairPrompt, verifyPrompt, verifyRepairPrompt,
} from '../src/core/uemaster/inspect.js';
import { EMPTY_SURFACES } from '../src/core/locate/copy.js';
import type { RequirementRow } from '../src/core/uemaster/compose.js';
import type { ReviewPrd, ReviewFinding } from '../src/core/uemaster/review.js';
import type { PageFragment, FlowNode } from '../src/core/uemaster/compose.js';

/**
 * 业务语言（2026-11-09 第二轮）：第一版拦住了坐标，**没拦住词**。
 *
 * ── owner 退回来的第二段话（它通过了第一版的全部检查）
 *
 *   缺口：跳到 purchaseRecord 的哪个 tab 写了，但带不带定位参数没写。
 *   建议：跳 /purchaseRecord?tab=rights&focus=ORDER_ID，命中项高亮 2 秒。
 *         旧路径 302 到新页并带 focus 参数。
 *
 * 没有一个文件路径、没有反引号，却全是研发语言。他的原话是「好多给我的还是技术语言
 * 不是业务语言 你明白么？是pm用 不是研发用」。
 *
 * ── 为什么这一组用例的每一类都要有两条
 *
 * 每加一条词类都会带来两个风险，方向相反：漏拦（材料里还有黑话）与误伤（把产品词删了）。
 * 所以**每一类都必须有一条「拦住」的用例和一条「放过」的用例**——误伤没有人抱怨，
 * 它只会让句子悄悄变短，而这正是「材料读起来不对劲」最难查的那种。
 */

const req = {
  id: 'r1', number: 742, title: '用户部分权益缩减调整', type: 'commercial', requester: '吕品',
  prd_url: 'https://example.com/prd', context: null, problem: null, outcome: null,
  surfaces: null, edge_cases: null, out_of_scope: null, platforms: ['backend'], priority: null,
} as unknown as RequirementRow;

const NODES: FlowNode[] = [
  { id: 'A', label: '进入购买记录', kind: 'process' },
  { id: 'B', label: '提交退款', kind: 'process' },
];

const PRD = {
  version: 'v1', hash: 'h', chars: 20, truncated: false, markdown: '退款按剩余天数折价。',
  snapshot: { markdown: '退款按剩余天数折价。' },
} as unknown as Parameters<typeof findingsPrompt>[1];

const REPOS = [
  {
    id: 'apisrv', sha: 'a'.repeat(40), date: '2026-11-06T18:35:27+08:00', subject: 'Merge #292',
    files: 352, tree: new Set(['service/refund.go']),
    shape: { pages: [], routes: [], api: [], components: [], stores: [], dirs: [] },
    locate: { kind: 'none' as const },
  },
] as unknown as Parameters<typeof structurePrompt>[2];

const kinds = (text: string, mode: LeakMode = 'body'): string[] =>
  findProseLeaks(text, mode).map((leak) => leak.kind);

// ─── 1. 五类技术词：每类都有「拦住」的一条 ────────────────────────────────

describe('findProseLeaks：五类技术词（第二轮新增）', () => {
  it('网址参数：`?a=b` 与 `&x=y`', () => {
    expect(kinds('跳 /purchaseRecord?tab=rights 这一页')).toContain('query');
    expect(kinds('带上 &focus=ORDER_ID 过去')).toContain('query');
  });

  it('状态码当散文用：跳 / 返回 / 页面 / 302 到新页', () => {
    expect(kinds('旧入口返回 404')).toContain('status');
    expect(kinds('提交后跳 302 到列表')).toContain('status');
    expect(kinds('旧路径 302 到新页并带参数')).toContain('status');
    expect(kinds('页面状态是 500')).toContain('status');
  });

  it('裸驼峰与蛇形大写（没有反引号也算）', () => {
    expect(kinds('跳到 purchaseRecord 的哪个标签')).toContain('identifier');
    expect(kinds('按 ORDER_ID 去找那条订单')).toContain('identifier');
    expect(kinds('调 fetchVipGoods 拿会员信息')).toContain('identifier');
  });

  it('裸扩展名：.vue / .ts / .tsx / .json / .go', () => {
    for (const ext of ['a.vue', 'a.ts', 'a.tsx', 'a.json', 'a.go']) {
      expect(kinds(`这个 ${ext} 文件`)).toContain('extension');
    }
  });

  it('实现名词：字段 / 接口 / 埋点 / 参数 / 路由 / 组件 / 入参 / 出参', () => {
    for (const word of ['字段', '接口', '埋点', '参数', '路由', '组件', '入参', '出参']) {
      expect(kinds(`这里要加一个${word}`)).toContain('impl-noun');
    }
  });

  it('反例那一整段：第一版一条都不报，第二轮报满', () => {
    expect(countProseHits(GAP_WRONG_BLOCK, 'gap')).toBeGreaterThan(0);
  });
});

// ─── 2. 误伤护栏：必须活下来的产品词 ──────────────────────────────────────

describe('误伤护栏：这些词是需求自己的领域词，必须原样留在正文里', () => {
  it('分页 / 导出 / 排序 / 筛选：UI 功能名，不是实现词', () => {
    const text = '列表底部加分页，导出按钮放右上角，表头点了能排序、能筛选。';
    expect(hasProseLeak(text)).toBe(false);
    expect(relocateProse(text).text).toBe(text);
  });

  it('第三方接口：正文里是领域说法（要不要备案），只在缺口/建议里算违规', () => {
    const text = '第三方接口要备案，完成后才能开放给合作方。';
    expect(hasProseLeak(text, 'body')).toBe(false);
    expect(hasProseLeak(text, 'gap')).toBe(true);
  });

  it('品牌与产品词：VIP / SVIP / iOS / WiFi / SKU / API 不算驼峰', () => {
    expect(hasProseLeak('SVIP 月卡、VIP 年卡，走 iOS 内购，WiFi 环境下也不限速。')).toBe(false);
    expect(hasProseLeak('SKU 编号与 API 调用额度都写在页面上。')).toBe(false);
    // 这半句才是 `PROTECTED_WORDS` 真正救下的东西：`iCloud` / `iPhone` 是**小写开头 + 大写中段**，
    // 与 `purchaseRecord` 完全同形。不列白名单就会被当成裸驼峰删掉。
    expect(hasProseLeak('备份走 iCloud，iPhone 和 iPad 上都能看。')).toBe(false);
  });

  it('年份、计数、单价：状态码的两种误伤（相邻法与量词法）', () => {
    expect(hasProseLeak('2026 年 3 月上线')).toBe(false);
    expect(hasProseLeak('预计影响 302 个用户')).toBe(false);
    expect(hasProseLeak('302 到 500 个用户受影响')).toBe(false);
    expect(hasProseLeak('按 0.97 元/天折价，v1.2.3 版本上线')).toBe(false);
    // 量词护拦真正起作用的地方：状态词（页面）就在旁边，后面跟的却是计数。
    // 只靠「相邻词」判会把它读成状态码，量词护拦是第二条命。
    expect(hasProseLeak('这一版页面多了 302 个会员')).toBe(false);
  });

  it('路由器是硬件，不是页面跳转', () => {
    expect(hasProseLeak('路由器需要重启一次')).toBe(false);
  });

  it('模板里的锚点 `#node=节点id` 不是网址参数', () => {
    expect(hasProseLeak('支持 #node=节点id 直达。')).toBe(false);
  });

  it('页面路由仍是产品语言（第一轮的裁决没变）', () => {
    expect(hasProseLeak('点在 /pages/share/index 这一屏的顶部')).toBe(false);
  });
});

// ─── 3. 改写优先，改不了才搬走 ────────────────────────────────────────────

describe('rewriteClause：能换词就换词，换不了就交出去', () => {
  it('owner 的缺口那半句：改写成产品语言并留在正文（连结尾标点都不变）', () => {
    const clause = '跳到 purchaseRecord 的哪个 tab 写了，';
    expect(hasProseLeak(clause, 'gap')).toBe(true);
    const fixed = rewriteClause(clause, 'gap');
    // 页面语境的裸驼峰 → 「该页面」；变量名 tab → 「标签」。信息还在（谁跳、跳哪儿）。
    expect(fixed).toBe('跳到该页面的哪个标签写了，');
  });

  it('查询串 → 「（带上定位信息）」：定位这件事没丢，参数名没了', () => {
    const fixed = rewriteClause('跳 /purchaseRecord?tab=rights&focus=ORDER_ID，', 'gap');
    expect(fixed).toBe('跳 /purchaseRecord（带上定位信息），');
  });

  it('状态码 → 产品说法（302 是自动跳转，404 是打不开）', () => {
    expect(rewriteClause('旧路径 302 到新页。', 'body')).toBe('旧路径自动跳转到新页。');
    expect(rewriteClause('返回 404 时展示空白页。', 'body')).toContain('打不开');
  });

  it('非页面语境的裸驼峰改不了 → null（让调用方整句搬走，不猜它是什么）', () => {
    expect(rewriteClause('按 ORDER_ID 排序后导出。', 'gap')).toBeNull();
  });

  it('坐标不许半替换：路径整句交出去，不留「落点是 service/ 的方法」', () => {
    expect(rewriteClause('落点是 service/x.go:382 的方法。', 'body')).toBeNull();
    const { text, moved } = relocateProse('落点是 service/x.go:382 的方法。');
    expect(text).toBe('');
    expect(moved).toEqual(['service/x.go:382']);
  });

  it('括号里的坐标块：moved 里是坐标本身，不是包着它的那句话', () => {
    const { moved } = relocateProse('现在已经会判断了（现在：service/x.go）');
    expect(moved).toEqual(['service/x.go']);
  });

  it('整句只剩一个实现词时原样改写、不搬走（信息不丢）', () => {
    const { text, moved } = relocateProse('这块要加一个字段。', 'gap');
    expect(moved).toEqual([]);
    expect(text).toBe('这块要加一个信息项。');
  });
});

// ─── 4. 缺口 / 建议那一档：verdict 按正文档，其余按缺口档 ────────────────

describe('sanitizeAnno：缺口/建议比正文更严', () => {
  it('verdict 行里的领域词留下，缺口行里的同一个词被换掉', () => {
    const out = sanitizeAnno([
      ['一致', '第三方接口要备案，页面上已经写了。'],
      ['缺口 · 备案', '第三方接口要备案这件事没写进流程。'],
    ]);
    expect(out.rows[0]![1]).toBe('第三方接口要备案，页面上已经写了。');
    expect(out.rows[1]![1]).not.toContain('接口');
    expect(out.left).toBe(0);
  });

  it('整格都被搬走时留一句指路，缺口不会因此凭空消失', () => {
    const out = sanitizeAnno([['缺口 · 跳转', '按 ORDER_ID 排序后导出。']]);
    expect(out.rows[0]![1]).toBe(MOVED_HINT);
    expect(out.moved.join(' ')).toContain('ORDER_ID');
    expect(MOVED_HINT).toContain(REFERENCE_TITLE);
  });

  it('计两个数：清洗前（raw）与清洗后（left，应恒为 0）', () => {
    const out = sanitizeAnno([
      ['一致', '一切照旧。'],
      ['缺口', '参数没写全。'],
    ]);
    expect(out.raw).toBeGreaterThan(0);
    expect(out.left).toBe(0);
  });

  it('VERDICT_ROW_TITLES 与 inspect 的 VERDICT_NOUN 是同一份（防两边漂）', () => {
    expect([...VERDICT_ROW_TITLES].sort()).toEqual([...Object.values(VERDICT_NOUN)].sort());
  });
});

// ─── 5. HTML 那一层：正文才改，脚本与样式整块不动 ────────────────────────

describe('relocateHtmlBody：<script> / <style> 必须整块跳过', () => {
  const HTML = [
    '<html><body>',
    '<div class="src/pages/a.tsx" onclick="go(\'A\')">点这里</div>',
    '<p>跳到 purchaseRecord 的哪个 tab 写了。</p>',
    '<script>var x = document.getElementById("a"); function setViewByNode(n) { return n; }</script>',
    '<style>.anno-item { padding: 2px; }</style>',
    '</body></html>',
  ].join('');

  it('正文里的技术词被改写；脚本里的驼峰名一个字节都不动', () => {
    const moved: string[] = [];
    const out = relocateHtmlBody(HTML, moved);
    expect(out).toContain('document.getElementById');
    expect(out).toContain('setViewByNode');
    expect(out).toContain('.anno-item { padding: 2px; }');
    expect(out).toContain('class="src/pages/a.tsx"');
    expect(out).not.toContain('purchaseRecord');
    expect(out).toContain('该页面');
  });

  it('计数与剥离同口径：脚本里的驼峰不计入', () => {
    const hits = countHtmlBodyHits(HTML);
    expect(hits).toBeGreaterThan(0);
    expect(hits).toBeLessThan(5);
  });

  it('没有 <body> 时原样返回（模板换了不该让材料出不来）', () => {
    expect(relocateHtmlBody('<div>purchaseRecord</div>')).toBe('<div>purchaseRecord</div>');
  });
});

// ─── 6. 可数指标 ──────────────────────────────────────────────────────────

describe('指标：一个数，进日志、进 stats', () => {
  it('countProseHits 按处数算，不按种类算', () => {
    expect(countProseHits('参数、字段、接口')).toBe(3);
  });

  it('日志一行：有剩下的就是不通过', () => {
    expect(vocabReportLine('PAN-742 inspect', 3, 0)).toContain('hits=3');
    expect(vocabReportLine('PAN-742 inspect', 3, 0)).toContain('通过');
    expect(vocabReportLine('PAN-742 inspect', 3, 2)).toContain('不通过');
  });

  it('reportVocab 真的写出去（stdout 不行，得是 stderr）', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(reportVocab('PAN-742 inspect', 2, 0)).toBe(2);
    expect(String(spy.mock.calls[0]?.[0])).toContain('PAN-742 inspect');
    spy.mockRestore();
  });

  it('答案基准：产品语言那一段是 0 处', () => {
    expect(countProseHits(GAP_RIGHT_BLOCK, 'gap')).toBe(0);
  });
});

// ─── 7. 提示词：五份都带那对正例 / 反例 + 边界 ───────────────────────────

describe('提示词：缺口/建议的前后对照进了每一份', () => {
  const sources: Array<[string, string]> = [
    ['页面片段（评估）', fragmentsPrompt(req, 'evaluate', NODES, EMPTY_SURFACES)],
    ['页面片段（评审）', fragmentsPrompt(req, 'review', NODES, EMPTY_SURFACES)],
    ['页面片段 repair', fragmentsRepairPrompt(req, 'evaluate', NODES, '{}', 'x', EMPTY_SURFACES)],
    ['评审问题清单', findingsPrompt(req, PRD, NODES)],
    ['评审 repair', findingsRepairPrompt(req, PRD, NODES, '{}', { drops: [], why: 'x' })],
    ['走查结构', structurePrompt(req, PRD as never, REPOS, ['退款'])],
    ['走查复核', verifyPrompt(req, PRD as never, [{ id: 'A', title: '进入', kind: 'page' } as never], [], [])],
    ['走查复核 repair', verifyRepairPrompt(req, [{ id: 'A', title: '进入', kind: 'page' } as never], '{}', 'x')],
  ];

  it('每一份都带逐字的前后对照（缺口 + 建议）', () => {
    for (const [name, text] of sources) {
      expect(text, name).toContain(GAP_WRONG_BLOCK);
      expect(text, name).toContain(GAP_RIGHT_BLOCK);
    }
  });

  it('每一份都写明边界：领域词可以出现在正文，缺口/建议里一个都不许', () => {
    for (const [name, text] of sources) {
      expect(text, name).toContain('分页');
      expect(text, name).toContain('缺口 / 建议 / 风险');
    }
  });

  it('走查的标注规则里点名了缺口/建议那一对，并给了严重度取值', () => {
    const prompt = verifyPrompt(req, PRD as never, [
      { id: 'A', title: '进入', kind: 'page' } as never,
    ], [], []);
    expect(prompt).toContain('缺口 · 小标题');
    expect(prompt).toContain('p0 = 不定就没法开工');
    expect(prompt).toContain('一个实现词都不许有');
  });

  it('反例里没有任何文件路径（它照样是研发语言，这正是第二轮的教训）', () => {
    expect(GAP_WRONG_BLOCK).not.toContain('.go:');
    expect(GAP_WRONG_BLOCK).not.toContain('/service/');
    expect(PRODUCT_BODY_RULE.join('\n')).toContain('任何文件路径');
  });
});

// ─── 8. 装配那一层：标注在上游就被洗干净 ─────────────────────────────────

describe('assembleWalkmap：标注进门就洗，两个数交给调用方', () => {
  const fragment = {
    id: 'A', title: '购买记录', kind: 'page', frame: 'phone',
    html: '<div class="wt-screen">列表</div>',
    anno: [
      ['一致', '页面已经在。'],
      ['缺口 · 跳转落点', '跳到 purchaseRecord 的哪个 tab 写了。', 'p1'],
      ['缺口 · 排序', '按 ORDER_ID 排序后导出。'],
    ],
  } as unknown as PageFragment;

  it('缺口行被改写，verdict 行原样保留，改不了的原句进 moved', () => {
    const assembly = assembleWalkmap({ nodes: [fragment] }, { title: 't', svg: '<svg/>' });
    const anno = assembly.walkmap.nodes.A!.anno;
    expect(anno[0]![1]).toBe('页面已经在。');
    // 第一条缺口能改写（页面语境），第二条改不了（不是页面名）→ 搬走。
    expect(anno[1]![1]).toContain('该页面');
    expect(anno[1]![1]).not.toContain('purchaseRecord');
    expect(anno[2]![1]).toBe(MOVED_HINT);
    expect(assembly.annoRaw).toBeGreaterThan(0);
    expect(assembly.annoLeft).toBe(0);
    expect(assembly.moved.join(' ')).toContain('ORDER_ID');
  });

  it('搬走的原句能进「研发参考」；没有坐标时整节仍然不写', () => {
    const assembly = assembleWalkmap({ nodes: [fragment] }, { title: 't', svg: '<svg/>' });
    const lines = referenceLines([] as CodeRef[], assembly.moved);
    expect(lines.join(' ')).toContain('ORDER_ID');
    expect(referenceLines([], [])).toEqual([]);
    const html = injectReference('<html><body><p>x</p></body></html>', lines);
    expect(html).toContain(REFERENCE_TITLE);
  });
});
