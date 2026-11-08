import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db, pool } from '../src/db/client.js';
import { recordLocate } from '../src/core/locate/ledger.js';
import { locateFromHistory } from '../src/core/locate/history.js';
import type { HistoryRow } from '../src/core/locate/history-store.js';
import {
  ABSENT_HEADLINE, LOW_CONFIDENCE_HEADLINE, NOT_FOUND_HEADLINE,
} from '../src/core/locate/copy.js';
import {
  EXPAND_ASK, EXPAND_MAX_TOKENS, EXPAND_TIMEOUT_MS, createExpand, expandPrompt,
} from '../src/core/locate/expand.js';
import type { CodeIndex, FileKind, IndexFile } from '../src/core/codemirror/code-index.js';
import type { RequirementRow } from '../src/core/uemaster/compose.js';
import {
  descriptionOf, gatherBaseline, type ReviewLocateDeps, type ReviewPrd,
} from '../src/core/uemaster/review.js';
import {
  keywordsFrom, locateForInspect, locateQuery, locateRoundForInspect, recordInspectRound,
  renderLocate, type LocateDeps,
} from '../src/core/uemaster/inspect.js';
import { resetDb } from './helpers/db.js';

/**
 * 走查接线（Task 8）：定位只走合并历史这一条路，且**读不到 ≠ 没有**。
 *
 * 这一组用例钉的是「三种情况在出口处仍然分得开」——本仓已经两次栽在同一形状上
 * （`mergeHistory` 把失败的退出码吞成空历史、`ensureHistory` 写坏一批只留下半段）。
 * 所以每条用例除了断言 `kind`，还要断言**材料里那句话**：那是 PM 唯一看得到的东西，
 * 结论对不对先不谈，先保证「没读到」永远不会被渲染成「代码里没有」。
 *
 * 两个读口（`ensureHistory` / `readHistory`）是**注入**的：真镜像造不出「ssh 超时」，
 * 而这条链要断言的恰恰是失败时的分支。记账（`recordLocate`）用真的——它写的是库，
 * 假对象测不出「忘了 await」。
 */

/** 一份「读得到、且与需求相似」的历史：一条功能合并，动了两个功能路径文件。 */
const ROWS: HistoryRow[] = [
  {
    repo: '123pan-uni-app',
    commitSha: 'a'.repeat(40),
    mergedAt: '2026-11-06T02:00:00.000Z',
    branch: 'feat-share-search',
    message: 'feat: 分享页搜索入口 / 全链接搜索范围切换',
    files: ['src/pages/Share/Share.tsx', 'src/pages/Share/Search.tsx'],
  },
];

/** 镜像读不到：一句点名原因的中文（`why` 会被原样带进材料）。 */
const REASON = '读合并历史失败：123pan-uni-app（/srv/mirror/uni.git）：镜像 ssh 连接超时';

function depsOf(over: Partial<LocateDeps>): LocateDeps {
  return {
    ensureHistory: async () => ({ ok: true, data: { inserted: 0, total: ROWS.length, ms: 1 } }),
    readHistory: async () => ROWS,
    recordLocate,
    ...over,
  };
}

type Row = {
  stage: string;
  outcome: string;
  candidates: number;
  requirement_id: string | null;
  detail: { repos: Record<string, { kind: string; why?: string }> } | null;
};

/** 全表按写入顺序读回来。`detail` 原样读（它是 jsonb，驱动会解成对象）。 */
async function ledger(): Promise<Row[]> {
  const res = await db.execute<Row>(sql`
    select stage, outcome, candidates, requirement_id, detail
      from locate_runs order by created_at`);
  return res.rows;
}

/**
 * 一轮走查的**完整**两段：先判（`locateRoundForInspect`，不写库），再记账
 * （`recordInspectRound`，材料写出来之后）。产品里也是这两段，中间隔着两次模型调用
 * 与产物落盘——这里把它连着调，是为了让「记了什么」能被单独断言。
 */
async function roundAndRecord(
  inputs: Parameters<typeof locateRoundForInspect>[1],
  requirementId: string | null,
  deps = depsOf({}),
): Promise<Awaited<ReturnType<typeof locateRoundForInspect>>> {
  const round = await locateRoundForInspect(db, inputs, deps);
  await recordInspectRound(db, { requirementId, parts: round.parts }, deps);
  return round;
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});

describe('读不到代码：absent（不是「没有」）', () => {
  it('ensureHistory 失败 → absent；消息带原因，且不许出现「代码里没有」', async () => {
    let readCalls = 0;
    const got = await locateForInspect(db, {
      repoId: '123pan-uni-app',
      query: '分享页搜索入口',
      requirementId: null,
      deps: depsOf({
        ensureHistory: async () => ({ ok: false, code: 'git_failed', message: REASON }),
        // 读库这一步**不许**在补齐失败之后再跑：那不是「没读到」，是「读了一半」。
        readHistory: async () => { readCalls += 1; return ROWS; },
      }),
    });

    expect(got.kind).toBe('absent');
    if (got.kind !== 'absent') return;
    expect(got.why).toContain('镜像 ssh 连接超时');
    expect(readCalls).toBe(0);
    // 文案层对空数组抛，所以 absent 永远不该走到候选那一路
    expect(() => renderLocate(got)).not.toThrow();
  });

  it('readHistory 抛错（库/连接坏了也是「没读到」）→ absent，原因里带原始那句', async () => {
    const got = await locateForInspect(db, {
      repoId: '123pan-uni-app',
      query: '分享页搜索入口',
      requirementId: null,
      deps: depsOf({
        readHistory: async () => { throw new Error('connection terminated unexpectedly'); },
      }),
    });

    expect(got.kind).toBe('absent');
    if (got.kind === 'absent') expect(got.why).toContain('connection terminated unexpectedly');
  });
});

describe('读到了：none 与 candidates 分得开', () => {
  it('读到了、没有相似合并 → none', async () => {
    const got = await locateForInspect(db, {
      repoId: '123pan-uni-app',
      query: '发票报销审批流',
      requirementId: null,
      deps: depsOf({}),
    });
    expect(got).toEqual({ kind: 'none' });
  });

  it('读到相似合并 → candidates，一律 low，每条 reason 非空', async () => {
    const got = await locateForInspect(db, {
      repoId: '123pan-uni-app',
      query: '分享页搜索入口',
      requirementId: null,
      deps: depsOf({}),
    });

    expect(got.kind).toBe('candidates');
    if (got.kind !== 'candidates') return;
    expect(got.confidence).toBe('low');
    expect(got.items.length).toBeGreaterThan(0);
    for (const item of got.items) {
      expect(item.reason.trim()).not.toBe('');
      expect(item.source).toBe('history');
    }
    // 真答案必须在清单里，否则「有候选」是句空话
    expect(got.items.map((item) => item.path)).toContain('src/pages/Share/Share.tsx');
  });
});

describe('检索式：只传标题（描述不进 query——裁定见 inspect.ts 的三组实测）', () => {
  /** 两条各自只跟「标题」或只跟「描述」对得上的合并。 */
  const TWO: HistoryRow[] = [
    {
      repo: '123pan-pc',
      commitSha: 'b'.repeat(40),
      mergedAt: '2026-10-02T02:00:00.000Z',
      branch: 'feat-share-search',
      message: 'feat: 分享页搜索补齐 / 工具栏搜索入口改成输入框',
      files: ['src/pages/Share/Share.tsx'],
    },
    {
      repo: '123pan-pc',
      commitSha: 'c'.repeat(40),
      mergedAt: '2026-09-18T02:00:00.000Z',
      branch: 'feat-download-limit',
      message: 'feat: 下载限速风控开发',
      files: ['src/services/download-risk-modal.ts'],
    },
  ];

  const TITLE = '分享页搜索补齐';
  const DESC = '上传下载按量限速：超过阈值的下载要弹风控提示';

  it('标题 + 长描述 → 检索式仍然**等于标题**（描述没有进入检索式的通道）', () => {
    // 函数就只收标题：这一句是编译期保证，用例把运行期的结果也钉一遍。
    expect(locateQuery(TITLE)).toBe(TITLE);
    expect(locateQuery(`  ${TITLE}\n\t`)).toBe(TITLE);
    // 描述「在场」但不在检索式里：长描述一个字都不许出现（它没有能进去的参数）
    expect(locateQuery(TITLE)).not.toContain(DESC);
    expect(locateQuery(TITLE)).not.toContain('限速');
    // 反过来只有手工把描述当标题拼进来才会出现——生产链路没有这条通道
    // （`queryOfRequirement` 只传 `req.title`），所以这不是「能不能拼」的问题。
    expect(locateQuery(`${TITLE} ${DESC}`)).toContain(DESC);
  });

  it('描述不再参与：只跟描述对得上的那条合并进不了候选（本次裁定的代价）', () => {
    const paths = (() => {
      const got = locateFromHistory(TWO, locateQuery(TITLE));
      return got.kind === 'candidates' ? got.items.map((item) => item.path) : [];
    })();
    expect(paths).toContain('src/pages/Share/Share.tsx');       // 标题对得上的那条在
    expect(paths).not.toContain('src/services/download-risk-modal.ts'); // 只有描述对得上的那条不在
    // 这就是代价：那条需求「限速」是真的，但我们只拿标题去比，它找不到。
  });

  it('没有标题的那一格不会被补位：压空白之后是空串就是空串', () => {
    expect(locateQuery('   ')).toBe('');
  });
});

describe('材里那句话：三种情况各说各的', () => {
  it('absent 的正文带原因，且与 none 的正文不同', async () => {
    const absent = await locateForInspect(db, {
      repoId: 'r',
      query: 'x',
      requirementId: null,
      deps: depsOf({ ensureHistory: async () => ({ ok: false, code: 'git_failed', message: REASON }) }),
    });
    const none = await locateForInspect(db, {
      repoId: 'r',
      query: '发票报销审批流',
      requirementId: null,
      deps: depsOf({}),
    });

    const absentText = renderLocate(absent);
    const noneText = renderLocate(none);

    expect(absentText.startsWith(ABSENT_HEADLINE)).toBe(true);
    expect(absentText).toContain('镜像 ssh 连接超时');
    expect(absentText).not.toContain('代码里没有');

    expect(noneText.startsWith(NOT_FOUND_HEADLINE)).toBe(true);
    expect(noneText).not.toContain('镜像 ssh 连接超时');
    // 两句不许互相接近：这就是本次改造要保住的那条缝
    expect(noneText).not.toBe(absentText);
    expect(noneText).not.toContain('这一轮不含任何现状判断');
  });

  it('candidates 的正文是「待研发确认」的编号清单', async () => {
    const got = await locateForInspect(db, {
      repoId: 'r',
      query: '分享页搜索入口',
      requirementId: null,
      deps: depsOf({}),
    });
    const text = renderLocate(got);
    expect(text.startsWith('最可能的位置（待研发确认）：')).toBe(true);
    expect(text).toContain('src/pages/Share/Share.tsx');
    expect(text).toContain('以上是线索，不是结论');
  });
});

/**
 * 记账的单位是**一轮案例**，不是一次仓内检索（终审 Minor 3）；一行里还要带上**分仓明细**
 * （修复二波，推翻「一轮一行、不留细节」）。
 *
 * 走查每一轮要判两个仓，原来写两行；评审每轮写一行。`locate_runs` 是算准确率的分母，
 * 而分母的单位是「PM 拿到的一份材料」——两仓两行会让「攒够 30 条案例」这个门槛把走查
 * 算双份。所以：**一轮一行**，两仓的结论由 `mergeLocateRound` 合成。
 *
 * 但一行的 `outcome` 只有一个词，于是「一仓读不到 + 一仓有候选」被合成 `low`——盲仓在
 * 分母里彻底消失。`detail` 就是补这一块：每仓的 `kind`，`absent` 的仓连 `why` 原句一起。
 */
describe('记账：一轮一条 + detail 分仓明细（修复二波）', () => {
  it('两仓合成一条：全 none → none，阶段是 inspect', async () => {
    await roundAndRecord([
      { repoId: 'pc', query: '发票报销审批流', requirementId: null, deps: depsOf({}) },
      { repoId: 'uni', query: '发票报销审批流', requirementId: null, deps: depsOf({}) },
    ], null);

    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: 'inspect', outcome: 'none', candidates: 0 });
  });

  it('两仓合成一条：都有候选 → low，候选数相加', async () => {
    await roundAndRecord([
      { repoId: 'pc', query: '分享页搜索入口', requirementId: null, deps: depsOf({}) },
      { repoId: 'uni', query: '分享页搜索入口', requirementId: null, deps: depsOf({}) },
    ], null);

    const rows = await ledger();
    expect(rows).toHaveLength(1);
    // 每条历史合并动了 2 个文件，两仓各一份 → 4 条候选，四舍五入不重要，重要的是**一条行**
    expect(rows[0]!.outcome).toBe('low');
    expect(rows[0]!.candidates).toBe(4);
  });

  it('一个仓没读到 + 另一个仓 none → absent：没读到的那半不许被「没找到」盖住', async () => {
    const got = await roundAndRecord([
      {
        repoId: 'pc',
        query: 'x',
        requirementId: null,
        deps: depsOf({ ensureHistory: async () => ({ ok: false, code: 'git_failed', message: REASON }) }),
      },
      { repoId: 'uni', query: 'x', requirementId: null, deps: depsOf({}) },
    ], null);

    expect(got.merged.kind).toBe('absent');
    if (got.merged.kind === 'absent') {
      // why 里按仓标出：PM 拿着这句要知道去查哪个仓
      expect(got.merged.why).toContain('pc：');
      expect(got.merged.why).toContain('镜像 ssh 连接超时');
    }
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('absent');
  });

  /**
   * 这一条是修复二波的核心：**半盲的样本必须能从库里认出来**。
   *
   * 一仓 absent + 一仓有候选，合成口径（candidates > absent > none）会把这一轮记成
   * `low`——只看 `outcome` 的话，它与「两仓都读了、都找到候选」完全一样，将来算准确率
   * 就会拿半盲的样本当全见的样本。所以 `detail` 必须点名那个盲仓，连 `why` 一起。
   *
   * 变异：insert 里删掉 `detail` → 这条红（`detail` 是 null，`repos` 取不到）。
   */
  it('一仓 absent + 一仓有候选 → outcome=low，detail 点名盲仓与它的 why', async () => {
    await roundAndRecord([
      {
        repoId: '123pan-uni-app',
        query: 'x',
        requirementId: null,
        deps: depsOf({ ensureHistory: async () => ({ ok: false, code: 'git_failed', message: REASON }) }),
      },
      { repoId: '123pan-pc', query: '分享页搜索入口', requirementId: null, deps: depsOf({}) },
    ], null);

    const rows = await ledger();
    expect(rows).toHaveLength(1);
    // 材料上那句话：有候选，所以是 low
    expect(rows[0]!.outcome).toBe('low');

    const repos = rows[0]!.detail?.repos;
    expect(repos).toBeDefined();
    // 盲仓：kind + 原因原句。why 是「以后拿去催运维」的线索，不许只剩 kind。
    expect(repos!['123pan-uni-app']).toEqual({ kind: 'absent', why: REASON });
    // 见到的那个仓：kind 用 LocateResult 的词（candidates），不是本表 outcome 的 low
    expect(repos!['123pan-pc']).toEqual({ kind: 'candidates' });

    // 「按 detail 剔除盲样本」这句话在库里真的能执行：全见样本 0 条，半盲 1 条
    const seen = await db.execute<{ blind: number; all_seen: number }>(sql`
      select count(*) filter (where exists (
               select 1 from jsonb_each(detail->'repos') e where e.value->>'kind' = 'absent'
             ))::int as blind,
             count(*) filter (where not exists (
               select 1 from jsonb_each(detail->'repos') e where e.value->>'kind' = 'absent'
             ))::int as all_seen
        from locate_runs`);
    expect(seen.rows[0]).toEqual({ blind: 1, all_seen: 0 });
  });

  /**
   * 判与记是**两段**：`locateRoundForInspect` 只判、不写库。
   *
   * 产品的写法是「判 → 两次模型调用 → 产物落盘 → 记」（见 `inspect()` 末尾）。
   * 若有人把写库塞回判的那一步，`walkmap_rejected` 之后库里就会留一条指向不存在材料的行。
   */
  it('只判不记：locateRoundForInspect 之后库里还是空的', async () => {
    await locateRoundForInspect(db, [
      { repoId: 'pc', query: '分享页搜索入口', requirementId: null, deps: depsOf({}) },
      { repoId: 'uni', query: '分享页搜索入口', requirementId: null, deps: depsOf({}) },
    ], depsOf({}));
    expect(await ledger()).toEqual([]);
  });

  it('需求 id 原样落库（null 就是 null，不编一个）', async () => {
    await roundAndRecord([
      { repoId: 'pc', query: '分享页搜索入口', requirementId: null, deps: depsOf({}) },
      { repoId: 'uni', query: '分享页搜索入口', requirementId: null, deps: depsOf({}) },
    ], null);
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requirement_id).toBeNull();
  });

  it('记账失败往上抛，不降级成一条「记不上就算了」', async () => {
    const parts = [
      { repo: 'pc', result: { kind: 'none' } as const },
      { repo: 'uni', result: { kind: 'none' } as const },
    ];
    await expect(recordInspectRound(db, { requirementId: null, parts }, {
      recordLocate: async () => { throw new Error('locate_runs 写不进去'); },
    })).rejects.toThrow('locate_runs 写不进去');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 任务 9：评审接线（结构索引 + 模型扩展词）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 评审那一段与走查有三处不同，所以单独一组：
 * 1. 代码**可能还不存在**（评审在开工之前），所以检索只走结构索引；
 * 2. 关键词可以来自模型（`expand`），失败即回落 PRD 抽的词；
 * 3. 结论进的是材料里的一段话（`baseline.text`），三种结果各有各的第一句。
 *
 * 镜像读口、索引、`show`、`expand` 全部注入：这一组**不发 ssh、不开网**；
 * 记账用真的（`recordLocate`），因为它要断言的行就是「库里多了什么」。
 */

const SHA = 'a'.repeat(40);
const HEAD_OK = { sha: SHA, date: '2026-11-07T02:00:00.000Z', subject: 'feat: download limit' };

const file = (kind: FileKind): IndexFile => ({ kind, exports: [], size: 1 });

const indexOf = (repo: string, paths: string[]): CodeIndex => ({
  repo,
  sha: SHA,
  files: Object.fromEntries(paths.map((p) => [p, file('page' as FileKind)])),
  imports: {},
  // Task 3 新增的那一列：这份用例钉的是接线，反向图留空。
  importedBy: {},
  routes: [],
  // Task 1/2 新增的两列：这份用例钉的是接线，不是页面清单。
  pages: [],
  outline: {},
  builtAt: '2026-11-07T00:00:00.000Z',
});

/** PRD 与标题：`下载 / 限速` 会被 `keywordsFrom` 抽成回落词，`search` 不会。 */
const PRD = '# download limit\n\n下载限速：超过阈值的下载要弹风控提示，超限后引导升级。';
const TITLE = 'download limit';
const FALLBACK = keywordsFrom(PRD, TITLE);

function requirementRow(over: Partial<RequirementRow> = {}): RequirementRow {
  return {
    id: '6f0f3c4e-0000-4000-8000-000000000009',
    number: 9,
    title: TITLE,
    type: 'feature',
    requester: '吕品',
    prd_url: null,
    context: null,
    problem: null,
    outcome: null,
    surfaces: null,
    edge_cases: null,
    out_of_scope: null,
    platforms: null,
    priority: null,
    ...over,
  };
}

function reviewPrd(markdown = PRD): ReviewPrd {
  return {
    snapshot: {
      id: 'snap', requirementId: 'req', url: 'u', markdown, hash: 'h', fetchedAt: new Date(),
    },
    version: 'v1',
    text: markdown,
    chars: markdown.length,
    truncated: false,
  };
}

type LocateOver = {
  /** 每个仓的索引（没列出的仓给一份空索引）。 */
  indices?: Array<{ repo: string; index: CodeIndex }>;
  paths?: string[];
  bodies?: Record<string, string>;
  expand: ReviewLocateDeps['expand'];
  /** 这个仓的 `head` 失败（造「没读到」）。 */
  failHead?: string;
  /** 这个仓的索引建失败。 */
  failIndex?: string;
};

function locateDeps(over: LocateOver): ReviewLocateDeps {
  return {
    head: async (repo) => (repo === over.failHead
      ? { ok: false, code: 'git_failed', message: `镜像 ${repo} 读不到：ssh 连接超时` }
      : { ok: true, data: HEAD_OK }),
    lsTree: async () => ({ ok: true, data: over.paths ?? [] }),
    show: async (repo, path) => ({ ok: true, data: over.bodies?.[`${repo}:${path}`] ?? `// ${path}` }),
    repoIndex: async (_db, repo) => {
      if (repo === over.failIndex) {
        return { ok: false, code: 'git_failed', message: '建索引失败：show 超时' };
      }
      const hit = over.indices?.find((entry) => entry.repo === repo);
      return { ok: true, data: { index: hit?.index ?? indexOf(repo, []), built: false, buildMs: 0 } };
    },
    expand: over.expand,
  };
}

describe('评审定位：模型给的词就是检索用的词', () => {
  it('expand 成功 → 用模型的词（回落词不进检索），摘要原样交给模型', async () => {
    const asked: Array<{ title: string; description: string }> = [];
    let calls = 0;
    const req = requirementRow({ problem: '上传下载按量限速' });

    const baseline = await gatherBaseline(reviewPrd(), req, locateDeps({
      indices: [
        { repo: '123pan-pc', index: indexOf('123pan-pc', [
          'src/pages/search/Search.tsx', 'src/services/download-risk.ts',
        ]) },
      ],
      paths: ['src/pages/search/Search.tsx', 'src/services/download-risk.ts'],
      expand: async (title, description) => {
        calls += 1;
        asked.push({ title, description });
        return ['search'];
      },
    }), db);

    // 一次调用：`expandedKeywords` 钉了 `calls === 1`，这一层不再加一次。
    expect(calls).toBe(1);
    expect(asked[0]?.title).toBe(TITLE);
    // 六问里写了什么，模型就看到什么（描述为空才是空串）。
    expect(asked[0]?.description).toContain('上传下载按量限速');
    expect(descriptionOf(req)).toBe('上传下载按量限速');

    // 模型给的词就是检索用的词：落点是 search，而回落词（下载/限速）只会命中 download。
    // 两个路径集合互不重叠，所以这两条断言同时钉住了「用的是模型的词」这件事。
    expect(baseline.locate.kind).toBe('candidates');
    const paths = baseline.locate.kind === 'candidates'
      ? baseline.locate.items.map((item) => item.path) : [];
    expect(paths).toContain('src/pages/search/Search.tsx');
    expect(paths).not.toContain('src/services/download-risk.ts');
    // 第一行是「最可能的位置（待研发确认）：」——三句之一，不是自造的第四句。
    expect(baseline.text.startsWith(LOW_CONFIDENCE_HEADLINE)).toBe(true);
    expect(baseline.text).toContain('现状基线：123pan-pc@');

    // `gatherBaseline` **不记账**（终审 Minor 4）：行由 `reviewRequirement` 在材料写出来
    // 之后才写，所以这一层跑完库里必须是空的。材料侧的记账在 `tests/review.test.ts`
    // 里钉（成功一份材料 → 一行；`review_empty` / 构建失败 → 零行）。
    expect(await ledger()).toEqual([]);
  });

  it('expand 返回 null → 回落 PRD 关键词，基线照样产出，只记一条 review 行', async () => {
    const baseline = await gatherBaseline(reviewPrd(), requirementRow(), locateDeps({
      indices: [
        { repo: '123pan-pc', index: indexOf('123pan-pc', [
          'src/pages/search/Search.tsx', 'src/services/download-risk.ts',
        ]) },
      ],
      paths: ['src/pages/search/Search.tsx', 'src/services/download-risk.ts'],
      expand: async () => null,
    }), db);

    expect(FALLBACK.length).toBeGreaterThan(0);
    expect(baseline.locate.kind).toBe('candidates');
    const paths = baseline.locate.kind === 'candidates'
      ? baseline.locate.items.map((item) => item.path) : [];
    // 回落词（下载 / 限速）指向 download，而不是模型才可能给出的 search。
    expect(paths).toContain('src/services/download-risk.ts');
    expect(paths).not.toContain('src/pages/search/Search.tsx');
    expect(baseline.text.startsWith(LOW_CONFIDENCE_HEADLINE)).toBe(true);

    expect(await ledger()).toEqual([]);
  });

  it('expand 抛错 → 与 null 同一条路：不往上抛，回落原始关键词', async () => {
    const baseline = await gatherBaseline(reviewPrd(), requirementRow(), locateDeps({
      indices: [
        { repo: '123pan-pc', index: indexOf('123pan-pc', ['src/services/download-risk.ts']) },
      ],
      paths: ['src/services/download-risk.ts'],
      expand: async () => { throw new Error('模型 502'); },
    }), db);

    expect(baseline.locate.kind).toBe('candidates');
    const paths = baseline.locate.kind === 'candidates'
      ? baseline.locate.items.map((item) => item.path) : [];
    expect(paths).toContain('src/services/download-risk.ts');
    expect(await ledger()).toEqual([]);
  });

  it('索引为空（后端仓 / 没建索引）→ none：写「没能定位到」，不写「没读到」', async () => {
    const baseline = await gatherBaseline(reviewPrd(), requirementRow(), locateDeps({
      // 两个仓的索引都在、但一个前端页面都没有——这是后端的仓，不是「没读到」。
      indices: [
        { repo: '123pan-pc', index: indexOf('123pan-pc', []) },
        { repo: '123pan-uni-app', index: indexOf('123pan-uni-app', []) },
      ],
      paths: ['server/main.go'],
      expand: async () => ['search'],
    }), db);

    expect(baseline.locate).toEqual({ kind: 'none' });
    expect(baseline.text.startsWith(NOT_FOUND_HEADLINE)).toBe(true);
    expect(baseline.text).not.toContain(ABSENT_HEADLINE);
    expect(baseline.text).not.toContain('代码没读到');

    expect(await ledger()).toEqual([]);
  });

  it('镜像读不到 → absent（点名那个仓），且一次模型调用都不发', async () => {
    let calls = 0;
    const baseline = await gatherBaseline(reviewPrd(), requirementRow(), locateDeps({
      failHead: '123pan-uni-app',
      paths: [],
      expand: async () => { calls += 1; return ['search']; },
    }), db);

    expect(baseline.locate.kind).toBe('absent');
    if (baseline.locate.kind === 'absent') expect(baseline.locate.why).toContain('123pan-uni-app');
    expect(baseline.text.startsWith(ABSENT_HEADLINE)).toBe(true);
    expect(baseline.text).not.toContain(NOT_FOUND_HEADLINE);
    // 没有索引可搜时猜词是纯浪费：这一格必须是 0。
    expect(calls).toBe(0);
    expect(baseline.repos).toEqual([]); // 标题会写「未参考代码现状」

    expect(await ledger()).toEqual([]);
  });

  it('建索引失败也算「没读到」：半份现状不许当成一份交给 PM', async () => {
    const baseline = await gatherBaseline(reviewPrd(), requirementRow(), locateDeps({
      failIndex: '123pan-pc',
      indices: [{ repo: '123pan-uni-app', index: indexOf('123pan-uni-app', ['src/pages/search/Search.tsx']) }],
      paths: ['src/pages/search/Search.tsx'],
      expand: async () => ['search'],
    }), db);

    expect(baseline.locate.kind).toBe('absent');
    if (baseline.locate.kind === 'absent') expect(baseline.locate.why).toContain('建索引失败');
  });
});

describe('真 expand（createExpand）：不重试、不白等，围栏照样认，其余失败一律 null', () => {
  const CFG = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' };

  type Reply = Awaited<ReturnType<Parameters<typeof createExpand>[0]['complete']>>;

  /**
   * 记账用的假 provider：数调用次数、记提示词与预算，再按脚本回话（或按脚本抛）。
   *
   * 为什么必须有 `calls`：这一层最贵的错不是「回了 null」，是**回了 null 又去问一次**
   * ——评审是批处理，一个需求多等 4 秒，整轮就走不动。`null` 那个分支不抛，看起来像
   * 抖动，最容易被顺手加上重试；只有数次数才拦得住。
   */
  function providerStub(reply: Reply | (() => never)) {
    const seen = {
      calls: 0,
      prompts: [] as string[],
      opts: [] as Array<{ maxTokens?: number; timeoutMs?: number } | undefined>,
    };
    const complete: Parameters<typeof createExpand>[0]['complete'] = async (_cfg, prompt, opts) => {
      seen.calls += 1;
      seen.prompts.push(prompt);
      seen.opts.push(opts);
      if (typeof reply === 'function') return (reply as () => never)();
      return reply;
    };
    return { seen, complete };
  }

  function expandWith(reply: Reply | (() => never), onAttempt?: Parameters<typeof createExpand>[0]['onAttempt']) {
    const stub = providerStub(reply);
    const expand = createExpand({ resolveConfig: async () => CFG, complete: stub.complete, onAttempt });
    return { expand, seen: stub.seen };
  }

  it('超时预算是「3–5 秒」这个**数**：写死上限，不拿常量自己比自己', async () => {
    // 简报的判据是秒数。拿 `EXPAND_TIMEOUT_MS` 去断言 `timeoutMs === EXPAND_TIMEOUT_MS`
    // 是循环论证：把它改成 9000 也全绿，而「评审不能被一个猜词调用卡住」正是这条的意义。
    expect(EXPAND_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    expect(EXPAND_TIMEOUT_MS).toBeGreaterThanOrEqual(3_000);

    const { expand, seen } = expandWith({ ok: true, text: '["a"]' });
    await expand('t', '');
    expect(seen.opts[0]?.timeoutMs).toBe(EXPAND_TIMEOUT_MS);
    expect(seen.opts[0]?.maxTokens).toBe(EXPAND_MAX_TOKENS);
  });

  it('```json 围栏里的数组照样取出来（围栏不是失败——词还是那个词），且只问一次', async () => {
    const { expand, seen } = expandWith({ ok: true, text: '```json\n["搜索", "search"]\n```' });
    expect(await expand('分享页搜索', '')).toEqual(['搜索', 'search']);
    // 成功路径也只许打一次：失败路径的 `calls === 1` 挡不住「先探一次、再要一次」。
    expect(seen.calls).toBe(1);

    const prompt = seen.prompts[0] ?? '';
    expect(prompt).toContain('分享页搜索');
    expect(prompt).toContain(`最多 ${EXPAND_ASK} 个`);
    expect(prompt).toContain('JSON 字符串数组');
    // 描述为空时整行不出现（拼出「描述：」后面空着会诱导模型替我们补内容）。
    expect(prompt).not.toContain('描述：');
  });

  it('散文后面接一段数组也认；对象、混合类型、空数组一律 null（且各只问一次）', async () => {
    expect(await expandWith({ ok: true, text: '好的：["a","b"]' }).expand('t', '')).toEqual(['a', 'b']);

    /** 解析失败也要数次数：只在「回的不是数组」这一支加重试，同样不许过。 */
    const nullOnce = async (text: string): Promise<void> => {
      const { expand, seen } = expandWith({ ok: true, text });
      expect(await expand('t', ''), text).toBeNull();
      expect(seen.calls, text).toBe(1);
    };
    await nullOnce('{"keywords":["a"]}');
    // 元素不是字符串：整条判失败，不做 `String(x)`（那会造出一个叫 null 的关键词）。
    await nullOnce('[1,"a"]');
    await nullOnce('[]');
    await nullOnce('没有词');
  });

  it('非 2xx / 超时（complete 的 ok:false）→ null，不抛，也不再问一次', async () => {
    const { expand, seen } = expandWith({ ok: false, error: '请求超时：4 秒内没有响应' });
    expect(await expand('t', '描述')).toBeNull();
    expect(seen.calls).toBe(1);
  });

  it('provider 自己抛（连接被掐）→ null，不抛，也不再问一次', async () => {
    const attempts: Array<string | null> = [];
    const { expand, seen } = expandWith(
      () => { throw new Error('socket hang up'); },
      (record) => { attempts.push(record.error); },
    );
    expect(await expand('t', '')).toBeNull();
    expect(seen.calls).toBe(1);
    expect(attempts[0]).toContain('socket hang up');
  });

  it('没配模型 → null，且一次请求都不发（连提示词都没拼出去）', async () => {
    // 只断言「返回 null」是测不出这条的：删掉 `cfg === null` 的提前返回，那个被守卫的
    // throw 会被同一个 catch 吞成 null，用例照样绿。所以要数 `calls` 与 `prompts`。
    const stub = providerStub({ ok: true, text: '["不该到这"]' });
    const expand = createExpand({ resolveConfig: async () => null, complete: stub.complete });

    expect(await expand('t', '')).toBeNull();
    expect(stub.seen.calls).toBe(0);
    expect(stub.seen.prompts).toHaveLength(0);
  });

  it('失败原因写进留痕：超时、不是数组、成功三种分得开', async () => {
    const seen: Array<{ words: number | null; error: string | null }> = [];
    const log = (record: { words: number | null; error: string | null }) => {
      seen.push({ words: record.words, error: record.error });
    };

    await expandWith({ ok: false, error: '请求超时：4 秒内没有响应' }, log).expand('t', '');
    await expandWith({ ok: true, text: '{"keywords":[]}' }, log).expand('t', '');
    await expandWith({ ok: true, text: '["a"]' }, log).expand('t', '');

    expect(seen).toEqual([
      { words: null, error: '请求超时：4 秒内没有响应' },
      { words: null, error: '回的不是一个 JSON 字符串数组' },
      { words: 1, error: null },
    ]);
  });

  it('提示词里没有描述时不出现「描述：」，有描述时原样带上（压平换行）', () => {
    expect(expandPrompt('标题', '')).not.toContain('描述：');
    expect(expandPrompt('标题', '  第一行\n第二行  ')).toContain('描述：第一行 第二行');
  });
});
