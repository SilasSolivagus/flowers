import { mkdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  answerTruncated, coerceAnno, coerceAnswer, coerceEvidence, normalizeFrame, normalizeKind, normalizeVerdict, noJsonReason,
} from './shape.js';
import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { parseRequirementId } from '../validate.js';
import {
  head, lsTree, grep, show,
  type MirrorResult,
} from '../codemirror/mirror.js';
import { repoShape, type RepoShape } from '../codemirror/route.js';
import {
  locateAcross, type CodeIndex, type LocateChoice, type Probe,
} from '../codemirror/code-index.js';
import { repoIndex, type BuiltIndex } from '../codemirror/index-store.js';
import { readPrd, type PrdReadResult } from '../prd/read.js';
import { latestSnapshot, type Snapshot } from '../prd/snapshots.js';
import { attachArtifact } from './attach.js';
import { fingerprintOfRow } from '../requirements/fingerprint.js';
import { makeTrace, type Trace } from './attempts.js';
import { assembleWalkmap, type PageFragment } from './compose.js';
import { renderFlowchart, type FlowCheck } from './flow.js';
import {
  complete, extractJson, resolveProviderConfig,
  type ProviderConfig, type ProviderResult,
} from './provider.js';
import { ARTIFACT_ROOT, artifactUrl } from './store.js';
import {
  renderWalkthrough, validateWalkmap,
  type Anno, type BuildResult, type Frame, type NodeKind,
  type Walkmap, type WalkmapAssets,
} from './walkmap.js';

/**
 * 「走查材料」：把一份 PRD 跟**真实代码**逐条对上，再把差异渲染成一份 UEmaster 材料。
 *
 * 为什么它不能是 `composeEvaluation` 再加一段提示词：那一条路的输入是「需求本身」，
 * 模型爱怎么想就怎么想——它的图与页面是**编**出来的，没人能证伪。走查要的恰恰相反：
 * 每一句「代码里是怎么做的」都要指向一个**真的存在**的文件。所以这里多了一层不在
 * 模型手里的东西：远端镜像的 HEAD（`codemirror/mirror.ts` 的四个只读读口）。
 *
 * 两段式，刻意分开：
 *
 * - **阶段一（便宜、可复现、没有模型）**：从 PRD 里抽关键词，在两个真实仓库的 HEAD 上
 *   `git grep`，得到「候选文件集」（每仓 12 个，按命中次数排序），再读一次
 *   `repoShape` 拿页面/接口/组件的结构。同一个 PRD + 同一个 HEAD 必然得到同一份候选集，
 *   所以「为什么模型没看见那个文件」这个问题可以脱离模型回答。
 * - **阶段二（贵、有模型）**：把 PRD（截断到 1 万字符并写明截断）+ 候选集 + 结构表交给
 *   模型，要一份**结构化**结论（flows + findings）。然后拿 `lsTree` 逐个核 evidence
 *   里的路径——镜像存在的全部意义就是这句核对：**没有一处不可核实的断言**。
 *   编出来的路径是硬失败：先把那些路径原样回给模型修一次，再不行就整份材料失败。
 *
 * 第三段（深读）只读模型引到的文件（≤10 个、≤40k 字符），要它（a）确认或降级每条结论、
 * （b）交 `wt-*` 页面片段。段落顺序之所以是「先结构、后深读」，是为了让第二次调用的
 * 输入由第一轮**已经验过**的东西决定：模型不会因为多读了一个无关文件而改口。
 *
 * 与 `compose.ts` 的分工：那一条路的产物是「评估/评审」，图与页面都是模型的想象；
 * 这一条路的产物是「走查」，图是**按真实流程节点串出来的一条主干**，页面上每一屏都带
 * 一条 verdict 标注（一致 / 缺失 / 多余 / 不一致）。排版仍然是同一个 vendored
 * `build.py`（`walkmap.ts` 的 `renderWalkthrough`），所以两份材料长得一样。
 */

// ─── 常量：预算与上限 ────────────────────────────────────────────────────────

/**
 * 走查盯的是这两个仓。
 *
 * 为什么不是配置里「有哪些仓库就读哪些」：`123pan-pc` 与 `123pan-uni-app` 是这条
 * 需求的两个端（PRD 标题里就写着「H5 / APP」），第三个镜像
 * （`123pan-cross-frontend`）是跨端共用层，命中率低但一份 PRD 里没有它也行。
 * 硬编码两个 id 换来的是：材料标题里那两个 sha 永远指同两个仓，可复现。
 */
export const INSPECT_REPOS = ['123pan-pc', '123pan-uni-app'] as const;

/** 阶段一的关键词个数。8 个 × 2 仓 = 16 次 `git grep`，是「够用且不慢」的平衡点。 */
export const MAX_KEYWORDS = 8;

/** 每个仓的候选文件上限。12 个文件足够让模型看清结构，又不至于把提示词撑爆。 */
export const CANDIDATE_CAP = 12;

/** 结论条数上限。走查材料是给人过评审用的，12 条已经比一次会议能消化的多。 */
export const FINDING_CAP = 12;

/** 流程节点上限（与 compose 的图判据同一个量级）。 */
export const FLOW_CAP = 8;

/** 流程节点下限：少于 3 个节点画不出一张能看出「流程」的图（`build.py` 那一侧也会拒）。 */
export const FLOW_MIN = 3;

/** 提示词里 PRD 的字符预算。超了就截断，并在提示词里**写明**截了多少。 */
export const PRD_PROMPT_MAX = 10_000;

/** 深读：最多读几个文件、一共读多少字符。 */
export const DEEP_READ_CAP = 10;
export const DEEP_READ_BUDGET = 40_000;

/** 单个文件最多读多少字符（深读预算之内的单文件上限）。 */
export const DEEP_READ_FILE_MAX = 8_000;

/** 结构那一段最多问 2 次（首版 + 一次带着「编造的路径」的修复）。 */
export const MAX_STRUCTURE_ATTEMPTS = 2;

/** 深读那一段最多问 2 次（首版 + 一次修复：结论不合规或页面片段不合契约）。 */
export const MAX_VERIFY_ATTEMPTS = 2;

/** 单次模型调用超时。这一条链路只有 3–4 次调用，给足 150 秒。 */
export const CALL_TIMEOUT_MS = 420_000;  // 1M 上下文的推理模型单轮可跑几分钟

/**
 * 结构那一段：PRD 一万字符 + 两张表；实测 12 条结论约 2100 个汉字，2200 够。
 *
 * 为什么这个数字要盯着看：网关按 `max_tokens` **预扣**额度（不是按实际用量），
 * 一次 8000 的预扣就能吃掉一个小账户的全部余额。真实跑一次 2100 字符的回话、
 * 预扣 8000，换来的是一句「预扣费额度失败」——钱没花完，但路走不动了。
 */
const STRUCTURE_MAX_TOKENS = 32_000;   // 推理模型先花思考：2200 时代 content 为空，12k 也紧

/** 深读那一段：结论复核 + 每个节点一屏 `wt-*` HTML（实测 8 个节点约 7.8k 字符）。 */
const VERIFY_MAX_TOKENS = 64_000;      // 实测这一格思考 50,554 字：预算要给答案留出同等空间

/** 阶段一 grep 每次最多回多少条命中：只用来排序，命中 200 条和 2000 条没有区别。 */
const GREP_MAX = 60;

/** 送进提示词的形状表上限（`repoShape` 自己的上限更大，这里再收一次是为了提示词体积）。 */
const SHAPE_PROMPT_CAPS = { pages: 80, api: 40, components: 40 } as const;

// ─── 形状 ────────────────────────────────────────────────────────────────────

export type Verdict = 'implemented' | 'missing' | 'extra' | 'differs';

/** verdict → 材料上的中文标注（`anno` 的小标题）。 */
export const VERDICT_NOUN: Record<Verdict, string> = {
  implemented: '一致',
  missing: '缺失',
  extra: '多余',
  differs: '不一致',
};

export type Evidence = { repo: string; path: string; note: string };

export type Finding = {
  verdict: Verdict;
  /** PRD 里的说法（短句）。 */
  prd: string;
  /** 实际实现，或「未找到」。 */
  code: string;
  evidence: Evidence[];
  /** 只对 `missing` 有意义：搜过哪些关键词，让读者自己判断这次搜索的覆盖面。 */
  searched?: string[];
};

export type FlowSpec = { id: string; title: string; kind: 'page' | 'decision' | 'system' };

export type Structure = { flows: FlowSpec[]; findings: Finding[] };

/** 一条仓库基线：这正是标题里那两个 sha 的来源。 */
export type RepoBaseline = {
  id: string;
  sha: string;
  date: string;
  subject: string;
  files: number;
  tree: Set<string>;
  shape: RepoShape;
  candidates: Array<{ path: string; hits: number }>;
  /**
   * 候选是怎么来的：`index` = 静态索引（`hits` 是评分），`grep` = 旧的
   * 关键词命中（`hits` 是命中的关键词个数）。提示词里那句话要说清是哪一种。
   */
  source?: 'index' | 'grep';
  /** 索引给出的候选（带 `why` / `route`）。下一步的 next probes 提示词读它。 */
  probes?: Probe[];
};

/** 这次走查的数字。作业收口、报告与用例都读这一份，不各自再算一遍。 */
export type InspectStats = {
  prdVersion: string;
  prdHash: string;
  prdChars: number;
  prdTruncated: boolean;
  repos: Array<{ id: string; sha: string; date: string; files: number }>;
  keywords: string[];
  candidates: Record<string, number>;
  flows: number;
  findings: number;
  verdicts: Record<Verdict, number>;
  /** 模型引用的路径（去重后）。 */
  cited: number;
  /** 过了 `lsTree` 核对的路径数。 */
  citedValid: number;
  /** 真正读到内容的文件数 / 字符数。 */
  deepRead: number;
  deepReadChars: number;
  /** 结构段与深读段各问了几次。 */
  structureAttempts: number;
  verifyAttempts: number;
  modelCalls: number;
  /** 产物字节数与整条链路耗时。 */
  bytes: number;
  ms: number;
};

export type InspectOutcome = {
  /** 站内路径，`attachArtifact` 收的就是它。 */
  url: string;
  stats: InspectStats;
  /** 落库那行的 id（作业收口用，同 compose：不属于对外契约）。 */
  artifactId: string;
};

type RequirementRow = {
  id: string;
  number: number;
  title: string;
  type: string;
  requester: string;
  prd_url: string | null;
  /** 六问（P4-02）：指纹要它们，见 `compose.ts` 的 `RequirementRow`。 */
  context: string | null;
  problem: string | null;
  outcome: string | null;
  surfaces: string | null;
  edge_cases: string | null;
  out_of_scope: string | null;
  /** 平台（P4-08）：参与指纹。 */
  platforms: string[] | null;
  /** 优先级（P4-09）：与平台同一条理由，它参与指纹。 */
  priority: string | null;
};

// ─── 依赖（测试注入用） ──────────────────────────────────────────────────────

export type InspectDeps = {
  complete: (cfg: ProviderConfig, prompt: string, opts?: { maxTokens?: number; timeoutMs?: number }) => Promise<ProviderResult>;
  render: (mermaid: string) => Promise<FlowCheck>;
  resolveConfig: () => Promise<ProviderConfig | null>;
  build: (walkmap: Walkmap, assets: WalkmapAssets) => Promise<BuildResult>;
  readPrd: (db: Db, actor: string, input: { requirementId: string }) => Promise<PrdReadResult>;
  latestSnapshot: (db: Db, requirementId: string) => Promise<Snapshot | null>;
  head: (repoId: string) => Promise<MirrorResult<{ sha: string; date: string; subject: string } | null>>;
  lsTree: (repoId: string) => Promise<MirrorResult<string[]>>;
  grep: typeof grep;
  repoShape: (repoId: string) => Promise<MirrorResult<RepoShape>>;
  /** 静态索引（P4-10）：有就按路由/名字/导入/符号定位，没有就退回 grep。 */
  repoIndex: (db: Db, repo: string, sha: string) => Promise<MirrorResult<BuiltIndex>>;
  show: typeof show;
  attach: typeof attachArtifact;
};

/** 真实的依赖：真 HTTP、真 Python 排版器、真镜像读口、真库。 */
const LIVE: InspectDeps = {
  complete,
  render: (mermaid) => renderFlowchart(mermaid),
  resolveConfig: resolveProviderConfig,
  build: (walkmap, assets) => renderWalkthrough(walkmap, assets),
  readPrd,
  latestSnapshot,
  head,
  lsTree,
  grep,
  repoShape,
  show,
  repoIndex: (db, repo, sha) => repoIndex(db, repo, sha),
  attach: attachArtifact,
};

// ─── 阶段一：关键词 ──────────────────────────────────────────────────────────

/** 只认连续汉字：ASCII 词（`H5`、`APP`）单独一路处理，混在一起切会切出半个词。 */
const CJK_RUN = /[\u4e00-\u9fa5]+/g;
const ANY_RUN = /[\u4e00-\u9fa5A-Za-z0-9]+/g;
const QUOTED = /[「“"']([^「」“”"'\n]{2,12})[」”"']/g;

/**
 * PRD 里的样板词。
 *
 * 为什么必须有这张表：一份 16k 的 PRD 里「可以」「需要」「进行」各出现几十次，按频次
 * 排序它们会稳居前八，于是阶段一拿这八个词去 grep，得到的是「谁没写过可以」。
 * 表里只放**产品文档的胶水词**，业务名词（搜索、面包屑、分享、审核、埋点…）一个都不放。
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  '进行', '可以', '需要', '如果', '所有', '以及', '同时', '必须', '就是', '这个', '那个',
  '我们', '他们', '以下', '如下', '上述', '相关', '对应', '情况', '场景', '问题', '内容',
  '方式', '时间', '数据', '能够', '一个', '本期', '产品', '研发', '确认', '按照', '通过',
  '复用', '现有', '已经', '不再', '不得', '不能', '保留', '统一', '具体', '包括', '例如',
]);

/** 挑关键词时分不清的这些单字：它们是虚词，不是业务词。 */
const STOP_CHARS: ReadonlySet<string> = new Set(['的', '了', '和', '与', '在', '为', '是', '中', '上', '下', '不']);

function bump(map: Map<string, number>, word: string, weight: number): void {
  const clean = word.trim();
  if (clean.length < 2 || STOPWORDS.has(clean) || STOP_CHARS.has(clean)) return;
  map.set(clean, (map.get(clean) ?? 0) + weight);
}

/** 一段汉字里所有长度 2..6 的连续子串（n-gram）。 */
/**
 * 虚词/代词/量词。**任何含它们的 n-gram 都不许当关键词。**
 *
 * 为什么必须挡：按字切 n-gram 时，一段普通的中文句子会切出「为平台管理者」「对用户的上传」
 * 这种碎片——它们不是词，拿去找代码等于随机挑文件。实测（`scripts/bench-locate.ts`）
 * 一条只有标题 + 一句话的需求，8 个关键词里 7 个是这种碎片，「限速」反被挤掉，
 * 结果两条定位路径都一个文件找不到。
 *
 * PRD（有「」引号、有小标题）不太受影响，因为 QUOTED 与标题那两路给的分高；受损的正是
 * **只有一句话的老需求**——而迁移过来的 803 条里大部分长这样。
 */
const FUNCTION_CHARS = new Set([
  '的', '了', '为', '对', '在', '和', '与', '把', '被', '这', '那', '次', '每', '个',
  '是', '有', '需', '要', '可', '以', '能', '会', '就', '也', '都', '而', '并', '或',
  '我', '你', '他', '它', '们', '之', '其', '中', '上', '下', '来', '去', '到', '给',
]);

function hasFunctionChar(text: string): boolean {
  for (const ch of text) if (FUNCTION_CHARS.has(ch)) return true;
  return false;
}

function ngrams(run: string, map: Map<string, number>, weight: number): void {
  for (let len = 2; len <= 6; len += 1) {
    for (let i = 0; i + len <= run.length; i += 1) {
      const piece = run.slice(i, i + len);
      if (hasFunctionChar(piece)) continue;
      bump(map, piece, weight);
    }
  }
}

/**
 * 从 PRD 正文 + 需求标题里抽关键词，**纯函数**，同一个输入永远同一份输出。
 *
 * 三条信号，权重从高到低：
 * 1. 引号里的界面文案（`「全部文件」`/`“请输入关键词”`）：PRD 用引号写的就是**用户能
 *    看见的字**，而界面上的字在代码里几乎一定能被 grep 到。权重 3。
 * 2. 标题里的词：标题是这条需求最短的一句话，权重 2。
 * 3. 正文里的 n-gram 频次：权重 1，按 `次数 × 长度` 排序——长词比短词更具体，
 *    「分享页搜索」命中的文件比「搜索」命中的少得多，而那正是我们要的。
 *
 * 去重规则：已经选中的词如果**包含**或被包含于新的候选，新候选就不要了。理由很实际：
 * `分享页搜索` 与 `搜索` 同时去 grep，后者只会把前者已经命中的文件再命中一遍，
 * 白白多花一次 ssh 往返，还让「命中次数」这张表失去区分度。
 */
export function keywordsFrom(markdown: string, title: string, max = MAX_KEYWORDS): string[] {
  const counts = new Map<string, number>();

  QUOTED.lastIndex = 0;
  for (let m = QUOTED.exec(markdown); m !== null; m = QUOTED.exec(markdown)) {
    const text = (m[1] ?? '').trim();
    if (/[\u4e00-\u9fa5]/.test(text)) bump(counts, text, 3);
  }

  for (const run of title.match(ANY_RUN) ?? []) {
    bump(counts, run, 2);
    if (/[\u4e00-\u9fa5]/.test(run)) ngrams(run, counts, 2);
  }

  for (const run of markdown.match(CJK_RUN) ?? []) ngrams(run, counts, 1);

  const ranked = [...counts.entries()]
    .map(([word, count]) => ({ word, score: count * word.length }))
    .sort((a, b) => b.score - a.score || b.word.length - a.word.length || a.word.localeCompare(b.word));

  const picked: string[] = [];
  for (const item of ranked) {
    if (picked.length >= max) break;
    const redundant = picked.some((word) => word.includes(item.word) || item.word.includes(word));
    if (redundant) continue;
    picked.push(item.word);
  }
  return picked;
}

// ─── 阶段一：候选文件集 ──────────────────────────────────────────────────────

/**
 * 文档类文件：在一个「这是哪一屏、哪个组件」的问题上，它们不是答案。
 *
 * 镜像的噪音过滤（`mirror.ts` 的 `isNoisePath`）只剔打包产物与二进制——`.md` 是源码级
 * 文本，剔不得。但一份 575 文件的 React 仓里，`AGENTS.md`、`docs/plans/*.md`、
 * `.cursor/rules/*.mdc` 会因为「返回」「文件」这种通用词命中四五个关键词，然后凭命中
 * 数把 `search-entrance.vue` 挤出候选集。所以**降权而不是剔除**：真有一份 PRD 只改文档
 * 时，它们仍然排得进来。
 */
const DOC_EXT = /\.(?:md|mdc|mdx|txt|rst)$/i;

/** 一个关键词命中多少个文件：越少见的关键词，命中它越能说明问题。 */
export function rankCandidates(
  perKeyword: Array<{ word: string; files: Set<string> }>,
  cap = CANDIDATE_CAP,
): Array<{ path: string; hits: number }> {
  const hits = new Map<string, number>();
  const score = new Map<string, number>();
  for (const { files } of perKeyword) {
    // 文档频率：这个词在这一个仓里命中了几个文件。`当前`（41 个文件）与
    // `上一级`（2 个文件）对「哪个文件讲的就是这件事」的说服力完全不同。
    const df = Math.max(files.size, 1);
    for (const path of files) {
      hits.set(path, (hits.get(path) ?? 0) + 1);
      score.set(path, (score.get(path) ?? 0) + 1 / df + 0.05);
    }
  }
  return [...hits.keys()]
    .map((path) => ({
      path,
      hits: hits.get(path) ?? 0,
      score: (score.get(path) ?? 0) * (DOC_EXT.test(path) ? 0.25 : 1),
    }))
    .sort((a, b) => b.score - a.score || b.hits - a.hits || a.path.localeCompare(b.path))
    .slice(0, cap)
    .map(({ path, hits: n }) => ({ path, hits: n }));
}

/** 一个仓库的结构基线：HEAD、树、形状、索引（**不含候选**）。 */
type RepoStructure = {
  id: string;
  sha: string;
  date: string;
  subject: string;
  files: number;
  tree: Set<string>;
  shape: RepoShape;
  /** 静态索引；读不到就是 `null`（那一仓退回 grep）。 */
  index: CodeIndex | null;
};

/** 一个仓库的结构：HEAD、树、形状、索引。失败一律是那句中文。 */
async function structureOf(repoId: string, deps: InspectDeps, db: Db): Promise<RepoStructure> {
  const [headRes, treeRes, shapeRes] = await Promise.all([
    deps.head(repoId),
    deps.lsTree(repoId),
    deps.repoShape(repoId),
  ]);

  if (!headRes.ok) throw mirrorFailure(headRes.code, repoId, headRes.message);
  if (headRes.data === null) {
    throw new AppError('mirror_empty', `镜像仓库 ${repoId} 还没有任何提交：走查没有可比对的代码基线`);
  }
  if (!treeRes.ok) throw mirrorFailure(treeRes.code, repoId, treeRes.message);
  if (!shapeRes.ok) throw mirrorFailure(shapeRes.code, repoId, shapeRes.message);

  const indexed = await deps.repoIndex(db, repoId, headRes.data.sha);
  return {
    id: repoId,
    sha: headRes.data.sha,
    date: headRes.data.date,
    subject: headRes.data.subject,
    files: treeRes.data.length,
    tree: new Set(treeRes.data),
    shape: shapeRes.data,
    index: indexed.ok ? indexed.data.index : null,
  };
}

/**
 * 旧的 grep 候选集（§3.5 的降级路径，**原样保留**）。
 *
 * 关键词逐个 grep；同一仓的几次搜索并发发出去（互不依赖），失败**不吞**：
 * 一次 grep 失败说明镜像读不通，那时给部分结果只会让人以为「代码里没有」。
 */
async function grepCandidates(
  struct: RepoStructure,
  keywords: string[],
  deps: InspectDeps,
): Promise<Array<{ path: string; hits: number }>> {
  const results = await Promise.all(
    keywords.map((word) => deps.grep(struct.id, word, { max: GREP_MAX })),
  );
  const perKeyword: Array<{ word: string; files: Set<string> }> = [];
  const tree = [...struct.tree];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i]!;
    if (!result.ok) throw mirrorFailure(result.code, struct.id, result.message);
    const files = new Set<string>();
    for (const hit of result.data) {
      if (!tree.includes(hit.path)) continue; // 双保险：grep 与 ls-tree 必须同一份 HEAD
      files.add(hit.path);
    }
    perKeyword.push({ word: keywords[i] ?? '', files });
  }
  return rankCandidates(perKeyword);
}

/**
 * 一个仓的基线：结构 + 候选。
 *
 * 候选来自哪条路由由**调用方**决定（`locateAcross` 的结果）：`index` → 直接用
 * `Probe[]`；`grep` → 跑上面那段旧算法。判断放不到这里的原因见 `locateAcross` 的
 * 注释——「这份 PRD 有没有具体线索」是整个需求的事，不是单个仓的事。
 */
async function baselineOf(
  struct: RepoStructure,
  choice: LocateChoice,
  keywords: string[],
  deps: InspectDeps,
): Promise<RepoBaseline> {
  // `index` 不进 `RepoBaseline`：它是「怎么定位的」，不是「定位到了什么」。
  const { index: _index, ...base } = struct;
  if (choice.source === 'index') {
    return {
      ...base,
      candidates: choice.probes.map((probe) => ({ path: probe.path, hits: probe.score })),
      source: 'index',
      probes: choice.probes,
    };
  }
  const candidates = await grepCandidates(struct, keywords, deps);
  return { ...base, candidates, source: 'grep', probes: [] };
}

/**
 * 镜像的失败 → 一句能指路的中文。
 *
 * `bad_config` 原样往上走（它已经点名了缺的是 `code.mirror.repos` 还是
 * `FLOWERS_MIRROR_REPOS`）：那一句话是 owner 唯一能照着做的线索，包一层
 * 「镜像读不到」只会把它埋掉。
 */
function mirrorFailure(code: string, repoId: string, message: string): AppError {
  if (code === 'bad_config') return new AppError('mirror_unconfigured', message);
  if (code === 'unknown_repo') return new AppError('mirror_unconfigured', message);
  return new AppError('mirror_failed', `读镜像 ${repoId} 失败：${message}`);
}

// ─── PRD 基线 ────────────────────────────────────────────────────────────────

export type PrdBaseline = {
  url: string;
  markdown: string;
  hash: string;
  /** `v1.4` 这种；从正文的版本表里取最大的那个版本号。 */
  version: string;
  chars: number;
};

/**
 * PRD 这一版的身份。
 *
 * 版本号从正文里找（PRD 的版本表就是一个 `v1.0 / v1.4` 的表），取**数值最大**的那一个
 * 而不是第一个：`v1.0` 是文档开头的「初版」，表里最后一行才是这一版。找不到就退回
 * 快照 hash 的前 8 位——留一个「不知道是哪版」的名字，比编一个 `v1.4` 好。
 */
export function prdVersionOf(markdown: string, hash: string): string {
  const found: number[] = [];
  for (const m of markdown.matchAll(/v(\d+(?:\.\d+)?)/g)) {
    const value = Number.parseFloat(m[1] ?? '');
    if (Number.isFinite(value)) found.push(value);
  }
  if (found.length === 0) return `未标版本#${hash.slice(0, 8)}`;
  const latest = Math.max(...found);
  return `v${Number.isInteger(latest) ? `${latest}.0` : String(latest)}`;
}

async function baselinePrd(
  db: Db,
  actor: string,
  requirementId: string,
  deps: InspectDeps,
): Promise<PrdBaseline> {
  const latest = await deps.latestSnapshot(db, requirementId);
  let snapshot: Snapshot = latest ?? await (async () => {
    // 没有快照才去读：`readPrd` 会调企业微信 CLI（几秒 + 一次真实读盘）。
    // 走查要的是「这一版 PRD」，而快照就是那一版；有快照还去读，等于让结论跟着
    // 文档的改动漂。
    const read = await deps.readPrd(db, actor, { requirementId });
    if (!read.ok) throw new AppError(`prd_${read.code}`, read.message);
    return read.data.snapshot;
  })();

  if (snapshot.markdown.trim() === '') {
    throw new AppError('prd_empty', 'PRD 快照是空的：先重新读一次 PRD，再点走查');
  }
  return {
    url: snapshot.url,
    markdown: snapshot.markdown,
    hash: snapshot.hash,
    version: prdVersionOf(snapshot.markdown, snapshot.hash),
    chars: snapshot.markdown.length,
  };
}

/** 截断并**写明**截断：不写这一句，模型会以为 PRD 只有这些字。 */
export function truncatePrd(markdown: string, max = PRD_PROMPT_MAX): { text: string; truncated: boolean } {
  if (markdown.length <= max) return { text: markdown, truncated: false };
  return { text: markdown.slice(0, max), truncated: true };
}

// ─── 提示词 1：结构（flows + findings） ──────────────────────────────────────

function flat(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function shapeLines(repo: RepoBaseline): string[] {
  const shape = repo.shape;
  const cut = (list: string[], cap: number): string[] => {
    const shown = list.slice(0, cap);
    return shown.length === list.length ? shown : [...shown, `…（还有 ${list.length - shown.length} 个未列出）`];
  };
  return [
    `  [${repo.id}] ${repo.files} 个源码文件，${shape.pages.length} 个页面 / ${shape.api.length} 个接口 / ${shape.components.length} 个组件`,
    '    页面：',
    ...cut(shape.pages, SHAPE_PROMPT_CAPS.pages).map((p) => `      ${p}`),
    '    接口：',
    ...cut(shape.api, SHAPE_PROMPT_CAPS.api).map((p) => `      ${p}`),
  ];
}

function candidateLines(repo: RepoBaseline): string[] {
  if (repo.candidates.length === 0) return [`  [${repo.id}] 关键词一个都没命中（这份 PRD 的用词与代码里的标识符对不上）`];
  // 两种来源的 `hits` 不是同一个量：索引给的是评分，grep 给的是命中关键词个数。
  // 标签必须跟着来源走——把评分写成「关键词命中」是一句假话，模型会照它推理。
  const note = (hits: number): string => (repo.source === 'index'
    ? `评分 ${hits}`
    : `${hits} 个关键词命中`);
  return [
    `  [${repo.id}]`,
    ...repo.candidates.map((c) => `    ${c.path}  （${note(c.hits)}）`),
  ];
}

/**
 * 提示词 1：只产出**结论的结构**（哪些流程节点、哪些差异），不要页面、不要图。
 *
 * 三条规则写进提示词的理由都一样：它们**会被机器核对**，模型必须先知道核对存在。
 * - 路径要真实存在：说明「我们会拿 ls-tree 逐个核对」，它才会老实写自己读过的文件；
 * - `missing` 不许带证据：没有代码可引的结论，唯一的诚实写法是「我搜了什么」；
 * - `differs` 必须带证据：不能只说「对不上」。
 */
export function structurePrompt(
  req: RequirementRow,
  prd: PrdBaseline,
  repos: RepoBaseline[],
  keywords: string[],
): string {
  const { text, truncated } = truncatePrd(prd.markdown);
  const prdNote = truncated
    ? `PRD 正文（已截断：只给你前 ${text.length} 字符，全文 ${prd.chars} 字符；后面 `
      + `${prd.chars - text.length} 字符没给——那段不要凭标题猜，猜的地方不要写成结论）`
    : `PRD 正文（全文 ${prd.chars} 字符）`;

  return [
    '你是需求走查助手。任务：把一份 PRD 跟**真实代码**逐条对上，产出结构化的走查结论。',
    '',
    '这次的对象：',
    `  · 编号：PAN-${req.number}`,
    `  · 标题：${flat(req.title)}`,
    `  · 类型：${flat(req.type)}　提出人：${flat(req.requester)}`,
    '  · 材料是「走查材料」：拿实现跟 PRD 对比——流程要按真实存在的页面画，不要照 PRD 修图。',
    '',
    '代码基线（读的是镜像的 HEAD，不是某个分支）：',
    ...repos.map((repo) => `  · ${repo.id}@${repo.sha.slice(0, 8)}：${repo.files} 个源码文件（${repo.date}）`),
    '  ! 证据只能引用这两个仓 HEAD 上**真实存在**的文件。路径会逐条拿 ls-tree 核对，',
    '    写一个不存在的路径，整份结论会被退回重答——不要猜文件名，不要写目录。',
    '',
    prdNote + '：',
    text,
    '',
    '阶段一：在 HEAD 上按 PRD 关键词搜出来的候选源码文件（按命中关键词个数排序）：',
    ...repos.flatMap((repo) => candidateLines(repo)),
    `（搜过的关键词：${keywords.join('、')}）`,
    '',
    '阶段一：两个仓的路由/页面结构：',
    ...repos.flatMap((repo) => shapeLines(repo)),
    '',
    '输出一个 JSON 对象（不要代码围栏、不要解释），只有两个键：',
    '{',
    '  "flows": [ { "id": "A", "title": "分享页搜索入口", "kind": "page" } ],',
    '  "findings": [',
    '    { "verdict": "implemented", "prd": "PRD 要求分享页工具栏有搜索入口",',
    '      "code": "工具栏里已有输入框样式的搜索入口",',
    '      "evidence": [ { "repo": "123pan-pc", "path": "src/pages/share/Share.tsx", "note": "为什么是这条证据" } ] }',
    '  ]',
    '}',
    '',
    '规则（逐条会被机器校验）：',
    ` 1. flows 是这条需求**用户实际走的流程**，按顺序 3–${FLOW_CAP} 个；kind 只能 page / decision / system，`,
    '    page=有界面的页面，decision=判断，system=后台环节。id 用大写字母或数字（A、B、C…）。',
    ` 2. findings 是 PRD 与代码的差异清单，1–${FINDING_CAP} 条。verdict 只能四选一：`,
    '    implemented=PRD 说了、代码里也有；missing=PRD 说了、代码里没有；',
    '    extra=代码里有、PRD 没写；differs=两边都有但对不上（行为/文案/时机不同）。',
    ' 3. evidence 每条给 { repo, path, note }：repo 必须是上面两个 id 之一，path 必须是仓内相对路径',
    '    且真实存在（我们会核对）。note 一句话说清「为什么这条能证明这件事」。',
    ' 4. **missing 的 evidence 必须是空数组**（没有代码可引），并且必须给 "searched": ["搜过的关键词"]，',
    '    让读者自己判断这次搜索的覆盖面。missing 也可以指一个"它本该在的文件"（拿得到路径更可信）。',
    ' 5. differs 至少要有一条 evidence；implemented 与 extra 也要有（没有证据的判断等于没判断）。',
    ' 6. prd / code 各写一句短句（不超过 40 字），中文；不要写「详见 PRD」这种空话。',
    ' 7. 找不到就写 missing，不要为了凑条数编一条 implemented。',
  ].join('\n');
}

/**
 * 修结构的提示词：上一版原文 + **一条条不合格的地方**（含被编造的路径）+ 规则再来一遍。
 *
 * 为什么把路径原样写回去：模型看「路径不存在」不知道说的是哪一条；写回
 * `123pan-pc/src/pages/share/Search.tsx` 它才知道自己编的是哪一个。
 */
export function structureRepairPrompt(
  req: RequirementRow,
  prd: PrdBaseline,
  repos: RepoBaseline[],
  keywords: string[],
  previous: string,
  problems: string[],
): string {
  const trimmed = previous.trim();
  const shown = trimmed.length > 6000 ? `${trimmed.slice(0, 6000)}…` : trimmed;
  return [
    `上一版走查结论没有通过校验（PAN-${req.number}「${flat(req.title)}」，PRD ${prd.version}）。请修好它。`,
    '',
    '上一版原文：',
    shown === '' ? '（空）' : shown,
    '',
    '不合格的地方：',
    ...problems.map((problem) => `  · ${problem}`),
    '',
    '证据只能来自这些仓库的真实 HEAD（路径会被 ls-tree 核对，编一个就会被退回）：',
    ...repos.flatMap((repo) => candidateLines(repo)),
    `（搜过的关键词：${keywords.join('、')}）`,
    '',
    '重发**完整**的 JSON，形状不变：',
    '{"flows":[{"id","title","kind"}],"findings":[{"verdict","prd","code","evidence":[{"repo","path","note"}],"searched"}]}',
    `规则：flows 3–${FLOW_CAP} 个、按用户实际顺序；findings 1–${FINDING_CAP} 条；`,
    'missing 的 evidence 必须是空数组并给 searched；其余 verdict 至少一条 evidence；',
    '所有路径都必须在对应仓库的 HEAD 上真实存在。只输出 JSON 本身。',
  ].join('\n');
}

// ─── 结构回话的解析与校验 ────────────────────────────────────────────────────

const EvidenceSchema = z.object({
  // repo 允许空串：容错层认不出仓库时留空，交给 `validateStructure` 按路径反推。
  // 在 schema 这一层就拒掉，等于把「能救回来的」变成「退回重答一整轮」。
  repo: z.string().default(''),
  path: z.string().min(1),
  note: z.string().default(''),
});





const FindingSchema = z.object({
  verdict: z.preprocess(normalizeVerdict, z.enum(['implemented', 'missing', 'extra', 'differs'])),
  prd: z.string().min(1),
  code: z.string().default(''),
  evidence: z.array(EvidenceSchema).default([]),
  searched: z.array(z.string()).optional(),
});

const FlowSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.preprocess(normalizeKind, z.enum(['page', 'decision', 'system'])),
});

export const StructureSchema = z.object({
  flows: z.array(FlowSchema).default([]),
  findings: z.array(FindingSchema).default([]),
});

/** mermaid 的节点 id 只认这几个字符；模型写 `节点1` 或 `A-1` 都会画不出来。 */
const FLOW_ID = /^[A-Za-z0-9_]+$/;






/**
 * 解析被拒时把模型原文落盘，只在一个环境变量开着时写。
 *
 * 为什么需要：形状漂移是**一次只暴露一条**的（zod 报第一个 issue），而每轮真实调用
 * 要两分钟。开着这个开关跑一次，就能一次看清「evidence 不是数组」「verdict 写了整句」
 * 「frame 写成中文」全部问题，而不是修一个跑一次。
 */
function dumpRejected(phase: string, text: string, issues: unknown): void {
  if (process.env.FLOWERS_DEBUG_REPLY !== '1') return;
  try {
    const file = `/tmp/uemaster-reply-${phase}.json`;
    writeFileSync(file, JSON.stringify({ issues, text }, null, 1));
  } catch {
    // 诊断辅助，写不了就算了，绝不影响主流程。
  }
}

export function readStructure(
  text: string,
  repoIds: string[] = [],
): { ok: true; doc: Structure } | { ok: false; why: string } {
  // 截断要在解析之前认：截断的 JSON 会让 extractJson 退到内层对象，报成「缺字段」。
  if (answerTruncated(text)) return { ok: false, why: noJsonReason(text) };
  const raw = extractJson<unknown>(text);
  if (raw === null) return { ok: false, why: noJsonReason(text) };
  const shaped = coerceAnswer(raw, repoIds);
  const parsed = StructureSchema.safeParse(shaped);
  if (!parsed.success) {
    dumpRejected('structure', text, parsed.error.issues);
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? '结构不对' : `${issue.path.join('.') || '(根)'}：${issue.message}`;
    return { ok: false, why: `JSON 结构不对 —— ${where}` };
  }
  return { ok: true, doc: parsed.data as Structure };
}

/** 仓库 id → HEAD 上的路径集合。校验只认这张表，不认模型的记忆。 */
export type TreeIndex = Map<string, Set<string>>;

/**
 * 校验一份结构：这是整条链路**唯一**的硬门。
 *
 * 每一条都有对应的真实坏法：
 * - 编路径：模型把 `pages/Share/index.tsx` 写成 `src/pages/share/Index.tsx`——大小写、
 *   多一层目录、把组件名当文件名。除了拿 `lsTree` 核，没有第二种办法发现。
 * - `missing` 带证据：说明模型一边说「没有」一边递上了一个文件，结论自相矛盾。
 * - `missing` 不带 `searched`：读者无法判断「没搜到」是因为不存在，还是因为搜错了词。
 * - `differs` 无证据：这是最容易被写空的一条（「行为不一致」四个字谁都会写）。
 * - 条数/流程数越界：一份 30 条的走查没人读得完，一张 2 节点的图看不出流程。
 */
export function validateStructure(doc: Structure, trees: TreeIndex): { ok: boolean; problems: string[] } {
  const problems: string[] = [];

  if (doc.flows.length < FLOW_MIN || doc.flows.length > FLOW_CAP) {
    problems.push(`flows 有 ${doc.flows.length} 个，要求 ${FLOW_MIN}–${FLOW_CAP} 个`);
  }
  const flowIds = new Set<string>();
  for (const flow of doc.flows) {
    if (!FLOW_ID.test(flow.id)) problems.push(`流程节点 id「${flow.id}」只能用字母、数字、下划线`);
    if (flowIds.has(flow.id)) problems.push(`流程节点 id「${flow.id}」写了两次`);
    flowIds.add(flow.id);
    if (flow.title.trim() === '') problems.push(`流程节点 ${flow.id} 没有标题`);
  }

  if (doc.findings.length === 0) problems.push('findings 是空的：走查至少要给出 1 条结论');
  if (doc.findings.length > FINDING_CAP) problems.push(`findings 有 ${doc.findings.length} 条，上限是 ${FINDING_CAP} 条`);

  doc.findings.forEach((finding, i) => {
    const at = `第 ${i + 1} 条（${finding.verdict}）`;
    if (finding.prd.trim() === '') problems.push(`${at} 没有写 PRD 里的说法`);

    for (const evidence of finding.evidence) {
      // repo 没写全时按路径反推：一个路径只在一个仓里存在，就必然是那一个。
      // 这不是猜——两边都查过，唯一命中才补；两边都有或都没有，仍旧报错。
      if (evidence.repo === '' || !trees.has(evidence.repo)) {
        const hits = [...trees.entries()].filter(([, set]) => set.has(evidence.path)).map(([id]) => id);
        if (hits.length === 1) evidence.repo = hits[0]!;
      }
      const tree = trees.get(evidence.repo);
      if (tree === undefined) {
        problems.push(evidence.repo === ''
          // 空仓库 + 两个仓都查不到这个路径：真正的问题是"这个文件不存在"，不是"仓库没写"。
          ? `${at} 的证据路径 ${evidence.path} 在 ${[...trees.keys()].join('、')} 里都不存在`
          : `${at} 的证据仓库「${evidence.repo}」不在这次走查的仓库里（只有 ${[...trees.keys()].join('、')}）`);
        continue;
      }
      // 这一段就是「镜像存在的意义」：路径必须真的在 HEAD 上。
      if (!tree.has(evidence.path)) problems.push(`${at} 的证据路径在仓库里不存在：${evidence.repo}:${evidence.path}`);
    }

    if (finding.verdict === 'missing') {
      if (finding.evidence.length > 0) {
        // 早前这里禁止 missing 带证据，理由是「没有代码可引就不许引」。**这条是错的**：
        // 真实的缺失几乎总有"它本该在的那个文件"（「这个页面里没有面包屑」要指到页面文件），
        // 而且指了之后读者能自己去看一眼——比一句空白的「缺失」更有据可查。
        // 实测模型第二次就是被这条拦下的（3 处 missing 都带了路径）。
        // 真正要守的是：路径必须真实存在（上面那道 lsTree 硬门），以及**说清搜了什么**。
      }
      if ((finding.searched ?? []).length === 0 && finding.evidence.length === 0) {
        problems.push(`${at} 是 missing，但既没给 searched 也没指一个"本该在哪"的文件：读者无法判断这次搜索的覆盖面`);
      }
    } else if (finding.evidence.length === 0) {
      problems.push(`${at} 没有任何证据路径：${finding.verdict} 必须至少指一个真实文件`);
    }
  });

  return { ok: problems.length === 0, problems };
}

// ─── 流程 → mermaid（纯函数） ────────────────────────────────────────────────

/**
 * 结构里的 flows → 一段 mermaid。
 *
 * 为什么由我们串、而不是再问模型要一张图：走查的图必须**等于**结论里的节点清单，
 * 否则读者会看到「图上有搜索页、结论里没有」这种对不上的材料。串成一条主干的好处是
 * 排版器的三个计数天然为 0（没有分支就没有交叉），代价写在报告的「还粗糙的地方」：
 * 判断节点的两条出边被压成了一条直线，走查材料里「分支」这件事只能从标注里读。
 */
export function mermaidFromFlows(flows: FlowSpec[]): string {
  const lines = ['flowchart TD'];
  flows.forEach((flow, index) => {
    const label = flat(flow.title).replace(/["[\]{}]/g, '').slice(0, 12) || flow.id;
    const open = flow.kind === 'decision' ? '{"' : flow.kind === 'system' ? '[["' : '["';
    const close = flow.kind === 'decision' ? '"}' : flow.kind === 'system' ? '"]]' : '"]';
    lines.push(`  ${flow.id}${open}${label}${close}`);
    if (index > 0) lines.push(`  ${flows[index - 1]!.id} --> ${flow.id}`);
  });
  return lines.join('\n');
}

/** 材料标题。两个 sha 与 PRD 版本都在里面：读者能指着它说「我看的是这一版」。 */
export function inspectTitle(req: RequirementRow, prd: PrdBaseline, repos: RepoBaseline[]): string {
  const code = repos.map((repo) => `${repo.id}@${repo.sha.slice(0, 8)}`).join(' / ');
  return `PAN-${req.number}「${flat(req.title)}」走查材料 · 代码 ${code} · PRD ${prd.version}`;
}

// ─── 深读 ────────────────────────────────────────────────────────────────────

type Excerpt = { repo: string; path: string; text: string; chars: number };

/** 把引用过的路径按出现顺序去重，最多 `cap` 个。 */
export function citationsOf(findings: Finding[], cap = DEEP_READ_CAP): Array<{ repo: string; path: string }> {
  const seen = new Set<string>();
  const out: Array<{ repo: string; path: string }> = [];
  for (const finding of findings) {
    for (const evidence of finding.evidence) {
      const key = `${evidence.repo}\0${evidence.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ repo: evidence.repo, path: evidence.path });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/**
 * 深读段：只读结论引到的文件，预算 40k 字符。
 *
 * 为什么按「引用顺序」而不是按命中次数：命中次数已经在阶段一用掉了；这里的顺序是
 * 模型自己排的优先级（第一条结论最重要）。预算耗尽时**先读最相关的**那几份，
 * 后面的不读——文件被截断到一半的道理和 PRD 一样，宁可少读一份，也不要每份都读半截。
 */
async function deepRead(
  citations: Array<{ repo: string; path: string }>,
  deps: InspectDeps,
): Promise<{ excerpts: Excerpt[]; chars: number }> {
  const excerpts: Excerpt[] = [];
  let left = DEEP_READ_BUDGET;
  for (const citation of citations) {
    if (left <= 0) break;
    const budget = Math.min(DEEP_READ_FILE_MAX, left);
    const text = await deps.show(citation.repo, citation.path, { maxBytes: budget });
    // 读不动就跳过：路径已经过了 lsTree，读失败只可能是镜像在两次读之间出了问题。
    // 为它整份失败没有意义——结论仍然成立，只是少了这一份正文。
    if (!text.ok) continue;
    excerpts.push({ ...citation, text: text.data, chars: text.data.length });
    left -= text.data.length;
  }
  return { excerpts, chars: DEEP_READ_BUDGET - Math.max(left, 0) };
}

// ─── 提示词 2：确认结论 + 页面片段 ───────────────────────────────────────────

const KIND_NOUN: Record<NodeKind, string> = { page: '页面', system: '系统', decision: '判断' };

function findingLines(findings: Finding[]): string[] {
  return findings.map((finding, i) => {
    const evidence = finding.evidence.length === 0
      ? '（无证据）'
      : finding.evidence.map((e) => `${e.repo}:${e.path}`).join('、');
    return `  ${i + 1}. [${finding.verdict}/${VERDICT_NOUN[finding.verdict]}] PRD：${flat(finding.prd)}`
      + `　代码：${flat(finding.code)}　证据：${evidence}`;
  });
}

/**
 * 提示词 2：两个任务，一个回话。
 *
 * 为什么把「确认结论」与「画页面」放在一次调用里：它们要读的是**同一批文件**。
 * 分成两次，第二次还得把正文再贴一遍（几万字符），而模型多半会给出与第一次不同的
 * 判断——一份材料里出现两套结论，比只有一套错更难查。
 *
 * 页面片段的规则直接抄 `compose.ts` 的那一套（`wt-*` 词表、375/690 两种宽度、无 emoji、
 * 只写 body 内片段），因为产物最终要过的是同一个 `build.py`。区别只有一条：
 * 每个节点的标注里**必须有一条 verdict**（一致/缺失/多余/不一致），它就是这份材料
 * 「走查」的身份——没有它，这就是一份普通的流程原型。
 */
export function verifyPrompt(
  req: RequirementRow,
  prd: PrdBaseline,
  flows: FlowSpec[],
  findings: Finding[],
  excerpts: Excerpt[],
): string {
  const { text } = truncatePrd(prd.markdown, 6000);
  const list = flows.map((flow) => `  ${flow.id}  [${KIND_NOUN[flow.kind === 'page' ? 'page' : flow.kind === 'decision' ? 'decision' : 'system']}]  ${flow.title}`).join('\n');

  return [
    `你在为 PAN-${req.number}「${flat(req.title)}」做走查材料（PRD ${prd.version}）。`,
    '下面是你上一轮给出的结论，以及你引用的那几个文件的**真实正文**。这一轮只做两件事：',
    '  (1) 用正文核对每条结论：对就保留，错就改 verdict（可以降级，也可以改成 missing），并补一句代码里到底怎么做的；',
    '  (2) 按流程节点画页面片段。',
    '',
    '你上一轮的结论：',
    ...findingLines(findings),
    '',
    '你引用的文件正文（节选；带「已截断」的就是没给全）：',
    ...excerpts.flatMap((excerpt) => [
      `--- ${excerpt.repo}:${excerpt.path}（${excerpt.chars} 字符）`,
      excerpt.text,
      '',
    ]),
    'PRD 节选（前 6000 字符）：',
    text,
    '',
    '流程节点（id / 形态 / 文案）：',
    list,
    '',
    '要交的东西：一个 JSON 对象（不要代码围栏、不要解释），两个键 findings 与 nodes。',
    '',
    'findings：**同一条一条不少**，形状与上面完全一致（verdict / prd / code / evidence / searched）。',
    '  改过 judgment 的也要保留这一条；evidence 里的路径仍然必须真实存在。',
    '',
    'nodes：每个流程节点一条：',
    '{ "id": "A", "kind": "page", "frame": "phone", "title": "分享页搜索入口",',
    '  "html": "<div class=\\"wt-screen\\">…</div>",',
    '  "anno": [["一致", "工具栏已换成输入框式入口"], ["内容", "点进独立搜索页"]] }',
    '',
    '页面片段的规则（来自 flow-walkthrough 的 page-guide，逐条会被机器校验）：',
    ' 1. 设备框就是用户真的会看到的屏幕：只写上线后用户看得见的内容；设计理由、待确认项、',
    '    演示说明一律不写，元素下面不加解释性小字。',
    ' 2. 手机页面 375px 宽（frame 写 phone）；后台/浏览器页面 690px 宽（frame 写 wide）。',
    ' 3. 只用模板内置的 wt-* 组件类，不自带 <style>、不引外部资源：',
    '    wt-screen、wt-statusbar、wt-nav（wt-nav-back / wt-nav-title / wt-nav-action）、wt-titlebar、',
    '    wt-body、wt-card、wt-section、wt-list / wt-list-item / wt-li-main / wt-li-title / wt-li-sub /',
    '    wt-li-extra / wt-li-arrow、wt-input、wt-btn / wt-btn-ghost / wt-btn-sm、wt-badge、wt-dimtext、',
    '    wt-tabs / wt-tab / wt-on、wt-empty、wt-img、wt-bottombar、wt-modal / wt-dialog / wt-dialog-title /',
    '    wt-dialog-body / wt-dialog-actions、wt-toast、wt-browserbar、wt-table。',
    ' 4. 只写 body 内的片段：不要 <html>、<head>、<body>、<script>、<style>。',
    ' 5. 不用 emoji（构建器硬校验，出现即整份被拒）。图片用 wt-img 占位。',
    ' 6. 页面按**代码里真实的样子**画，不要照 PRD 的理想状态画：PRD 要求而代码里没有的元素，',
    '    画成它现在缺的样子，由标注去说明。',
    ` 7. 页面上能推进流程的按钮写 onclick="goNode('节点id')"，id 必须是上面清单里的 id。`,
    '',
    '标注（anno）规则：',
    ' 1. 每个节点 1–3 条，每条 ["小标题","正文"]，小标题 2–6 个字。',
    ' 2. **第一条必须是一条 verdict**：小标题只能是 一致 / 缺失 / 多余 / 不一致 之一，',
    '    正文一句话说清这个节点与 PRD 的关系。它是这份材料「走查」的身份，缺了会被退回。',
    ' 3. 其余条目写设计约束、边界与风险；不要重复页面里已有的文案。',
    ' 4. kind=system / decision 的节点没有页面：不要给 html 和 frame，只给 anno。',
    '',
    '规则：id 必须与流程节点清单一一对应；全部中文；只输出 JSON 本身。',
  ].join('\n');
}

export function verifyRepairPrompt(
  req: RequirementRow,
  flows: FlowSpec[],
  previous: string,
  why: string,
): string {
  const trimmed = previous.trim();
  const shown = trimmed.length > 3000 ? `${trimmed.slice(0, 3000)}…` : trimmed;
  return [
    `上一版的复核没有通过校验（PAN-${req.number}「${flat(req.title)}」走查材料）。`,
    '',
    '上一版原文：',
    shown === '' ? '（空）' : shown,
    '',
    `问题：${why}`,
    '',
    '流程节点（id / 形态 / 文案，一个都不能少）：',
    flows.map((flow) => `  ${flow.id}  [${flow.kind}]  ${flow.title}`).join('\n'),
    '',
    '重发**完整**的 JSON，形状不变：{"findings":[{"verdict","prd","code","evidence":[],"searched":[]}],"nodes":[{"id","kind","frame","title","html","anno"}]}',
    'kind=page 给 frame 与 html；kind=system / decision 只给 anno，不要给 html。',
    '每个节点 anno 的第一条必须是 verdict（一致/缺失/多余/不一致）。',
    'html 只用 wt-* 组件类、只写 body 内片段、不用 emoji。只输出 JSON 本身。',
  ].join('\n');
}

// ─── 复核回话的解析 ──────────────────────────────────────────────────────────

const NodeSchema = z.object({
  id: z.string().min(1),
  kind: z.preprocess(normalizeKind, z.enum(['page', 'system', 'decision'])),
  title: z.string().min(1),
  frame: z.preprocess(normalizeFrame, z.enum(['phone', 'wide'])).default('phone'),
  html: z.string().default(''),
  anno: z.array(z.array(z.string().min(1)).min(2).max(3)).default([]),
});

export const VerifySchema = z.object({
  findings: z.array(FindingSchema).optional(),
  nodes: z.array(NodeSchema).default([]),
});

export type VerifyDoc = {
  findings: Finding[];
  nodes: PageFragment[];
};

/** 标注第一条必须是 verdict 之一。 */
const VERDICT_TITLES: ReadonlySet<string> = new Set(Object.values(VERDICT_NOUN));

function toAnno(pairs: string[][]): Anno[] {
  return pairs.map((pair) => (pair.length >= 3 ? [pair[0]!, pair[1]!, pair[2]!] as Anno : [pair[0]!, pair[1]!] as Anno));
}

/**
 * 读复核回话：JSON 抠得出来 + zod 通过 + **节点全覆盖** + 每个页面节点有 verdict 标注 +
 * findings（若给了）重新过一遍 `validateStructure` 的同一套规则。
 *
 * 为什么 findings 是「若给了」：模型有可能只交 nodes——那时结论沿用第一轮（第一轮已经
 * 核过了）。反过来，给了 findings 就必须过同样的校验，否则第二轮成了绕开校验的后门。
 */
export function readVerify(
  text: string,
  flowIds: string[],
  trees: TreeIndex,
): { ok: true; doc: VerifyDoc } | { ok: false; why: string } {
  // 截断要在解析之前认：截断的 JSON 会让 extractJson 退到内层对象，报成「缺字段」。
  if (answerTruncated(text)) return { ok: false, why: noJsonReason(text) };
  const raw = extractJson<unknown>(text);
  if (raw === null) return { ok: false, why: noJsonReason(text) };
  // 复核段的形状漂移与结构段同源（evidence 写成字符串、顶层写成数组），走同一套扶正。
  const repoIds = [...trees.keys()];
  const parsed = VerifySchema.safeParse(coerceAnswer(raw, repoIds, flowIds));
  if (!parsed.success) {
    dumpRejected('verify', text, parsed.error.issues);
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? '结构不对' : `${issue.path.join('.') || '(根)'}：${issue.message}`;
    return { ok: false, why: `JSON 结构不对 —— ${where}` };
  }

  const nodes: PageFragment[] = [];
  const seen = new Set<string>();
  for (const node of parsed.data.nodes) {
    if (seen.has(node.id)) return { ok: false, why: `节点 ${node.id} 写了两遍` };
    seen.add(node.id);
    const html = node.html.trim();
    if (node.kind === 'page' && html === '') return { ok: false, why: `节点 ${node.id} 是页面，但没有给 html` };
    const anno = toAnno(node.anno);
    if (!anno.some((row) => VERDICT_TITLES.has(row[0]))) {
      return { ok: false, why: `节点 ${node.id} 的标注里没有 verdict（第一条得是 一致 / 缺失 / 多余 / 不一致 之一）` };
    }
    nodes.push({
      id: node.id,
      title: node.title,
      kind: node.kind,
      frame: node.frame as Frame,
      html: node.kind === 'page' ? html : '',
      anno,
    });
  }

  const missing = flowIds.filter((id) => !seen.has(id));
  if (missing.length > 0) return { ok: false, why: `这些流程节点没有页面片段：${missing.join('、')}` };
  const extra = [...seen].filter((id) => !flowIds.includes(id));
  if (extra.length > 0) return { ok: false, why: `多出了流程里不存在的节点：${extra.join('、')}` };

  if (parsed.data.findings !== undefined) {
    const checked = validateStructure(
      { flows: flowIds.map((id) => ({ id, title: id, kind: 'page' as const })), findings: parsed.data.findings as Finding[] },
      trees,
    );
    if (!checked.ok) return { ok: false, why: checked.problems.join('；') };
  }

  return { ok: true, doc: { findings: (parsed.data.findings as Finding[] | undefined) ?? [], nodes } };
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

async function loadRequirement(db: Db, requirementId: string): Promise<RequirementRow> {
  const res = await db.execute<RequirementRow>(sql`
    select id, number, title, type, requester, prd_url,
           context, problem, outcome, surfaces, edge_cases, out_of_scope, platforms, priority
      from requirements
     where id = ${requirementId} and deleted_at is null`);
  const row = res.rows[0];
  if (!row) throw new AppError('not_found', '需求不存在');
  return { ...row, number: Number(row.number) };
}

function emptyStats(): InspectStats {
  return {
    prdVersion: '', prdHash: '', prdChars: 0, prdTruncated: false,
    repos: [], keywords: [], candidates: {}, flows: 0, findings: 0,
    verdicts: { implemented: 0, missing: 0, extra: 0, differs: 0 },
    cited: 0, citedValid: 0, deepRead: 0, deepReadChars: 0,
    structureAttempts: 0, verifyAttempts: 0, modelCalls: 0, bytes: 0, ms: 0,
  };
}

function countVerdicts(findings: Finding[]): Record<Verdict, number> {
  const out: Record<Verdict, number> = { implemented: 0, missing: 0, extra: 0, differs: 0 };
  for (const finding of findings) out[finding.verdict] += 1;
  return out;
}

export type InspectRequest = { requirementId: string; jobId?: string };

/**
 * 走查材料：PRD ⇄ 真实代码 → 一份带 verdict 标注的 UEmaster 材料。
 *
 * 顺序是硬的，而且每一段失败都会说清是哪一段：
 * 1. 模型配置（没有就点名缺哪一格）→ 需求行 → PRD 基线（快照优先，没有才读）；
 * 2. 两个仓的 HEAD + 候选集 + 形状（**没有镜像就在这里失败**，一个模型调用都不发）；
 * 3. 结构（最多 2 次：被退回的路径原样回给模型）；
 * 4. 深读引用到的文件 + 复核结论 + 页面片段（最多 2 次）；
 * 5. `build.py` 出 HTML → 写文件 → `attachArtifact(stage: 'inspect')`。
 */
export async function inspect(
  db: Db,
  actor: string,
  request: InspectRequest,
  deps: Partial<InspectDeps> = {},
): Promise<InspectOutcome> {
  const started = Date.now();
  const requirementId = parseRequirementId({ requirementId: request.requirementId });
  const full: InspectDeps = { ...LIVE, ...deps };

  // 配置先于一切：没有 key 就没有这一条路（`start.ts` 也是按它选路的）。
  const cfg = await full.resolveConfig();
  if (cfg === null) {
    throw new AppError('provider_unconfigured', '未配置模型接口：走查要问模型，先把「接口地址 + API Key + 模型名」配好');
  }
  const req = await loadRequirement(db, requirementId);
  // 与 compose / review 同一刻：指纹在读完需求时取，attach 时原样带下去。
  const inputHash = fingerprintOfRow(req);
  const prd = await baselinePrd(db, actor, requirementId, full);
  const stats = emptyStats();
  stats.prdVersion = prd.version;
  stats.prdHash = prd.hash;
  stats.prdChars = prd.chars;
  stats.prdTruncated = prd.chars > PRD_PROMPT_MAX;

  // ── 阶段一：关键词 → 两个仓的候选集 ──
  const keywords = keywordsFrom(prd.markdown, req.title);
  stats.keywords = keywords;
  // 结构先全部拿到手，**再**一起定位：`locateAcross` 要看到所有仓才判得了「这份 PRD
  // 到底有没有具体线索」（见 code-index.ts 的注释：每仓各判各的会把 pc 的噪音排到
  // search.vue 前面）。
  const structures: RepoStructure[] = [];
  for (const repoId of INSPECT_REPOS) structures.push(await structureOf(repoId, full, db));
  const choices = locateAcross(
    structures.map((struct) => ({ repo: struct.id, index: struct.index })),
    keywords,
    { limit: CANDIDATE_CAP },
  );
  const repos: RepoBaseline[] = [];
  for (const struct of structures) {
    const choice = choices.get(struct.id) ?? { source: 'index' as const, probes: [] };
    repos.push(await baselineOf(struct, choice, keywords, full));
  }
  stats.repos = repos.map((repo) => ({ id: repo.id, sha: repo.sha, date: repo.date, files: repo.files }));
  stats.candidates = Object.fromEntries(repos.map((repo) => [repo.id, repo.candidates.length]));

  const trees: TreeIndex = new Map(repos.map((repo) => [repo.id, repo.tree]));
  const trace: Trace = makeTrace(db, request.jobId ?? null, cfg.model);

  // ── 阶段二：结构（最多 2 次） ──
  let prompt = structurePrompt(req, prd, repos, keywords);
  let structure: Structure | null = null;
  let lastProblems: string[] = [];

  for (let attempt = 1; attempt <= MAX_STRUCTURE_ATTEMPTS; attempt += 1) {
    const callStarted = Date.now();
    const reply = await full.complete(cfg, prompt, { maxTokens: STRUCTURE_MAX_TOKENS, timeoutMs: CALL_TIMEOUT_MS });
    const ms = Date.now() - callStarted;
    stats.structureAttempts = attempt;
    stats.modelCalls += 1;
    if (!reply.ok) {
      await trace.write({
        attempt, phase: 'locate', promptChars: prompt.length, outputChars: 0, error: reply.error, ms,
      });
      throw new AppError('provider_error', reply.error);
    }

    const read = readStructure(reply.text, [...trees.keys()]);
    if (!read.ok) {
      lastProblems = [read.why];
    } else {
      const checked = validateStructure(read.doc, trees);
      if (checked.ok) structure = read.doc;
      else lastProblems = checked.problems;
    }

    await trace.write({
      attempt,
      phase: 'locate',
      promptChars: prompt.length,
      outputChars: reply.text.length,
      error: structure === null ? lastProblems.join('；') : null,
      ms,
    });

    if (structure !== null) break;
    if (attempt === MAX_STRUCTURE_ATTEMPTS) break;
    prompt = structureRepairPrompt(req, prd, repos, keywords, reply.text, lastProblems);
  }

  if (structure === null) {
    throw new AppError(
      'inspect_invalid',
      `走查结论 ${MAX_STRUCTURE_ATTEMPTS} 次都没通过校验：${lastProblems.join('；')}`,
    );
  }

  const findings0 = structure.findings;
  stats.flows = structure.flows.length;
  stats.verdicts = countVerdicts(findings0);
  const citations = citationsOf(findings0);
  stats.cited = citations.length;

  // ── 深读：只读引到的文件 ──
  const deep = await deepRead(citations, full);
  stats.deepRead = deep.excerpts.length;
  stats.deepReadChars = deep.chars;

  // ── 图：按结论里的流程节点串一条主干（纯函数，不花模型调用） ──
  const mermaid = mermaidFromFlows(structure.flows);
  const check = await full.render(mermaid);
  if (!check.ok) {
    // 这条图是我们自己串的，画不出来说明 flowlayout 变了或节点文案里有它读不懂的字符。
    await trace.write({
      attempt: 1, phase: 'build', promptChars: 0, outputChars: mermaid.length,
      error: check.error ?? `布局不合格：交叉 ${check.crossings}、重叠 ${check.overlaps}、文字溢出 ${check.textOverflow}`,
      ms: 0,
    });
    throw new AppError(
      'flow_rejected',
      `走查流程图排版失败：${check.error ?? `交叉 ${check.crossings}、重叠 ${check.overlaps}、文字溢出 ${check.textOverflow}`}`,
    );
  }
  const svg = check.svg ?? '';
  const title = inspectTitle(req, prd, repos);

  // ── 复核 + 页面片段（最多 2 次） ──
  const flowIds = structure.flows.map((flow) => flow.id);
  let verifyPromptText = verifyPrompt(req, prd, structure.flows, findings0, deep.excerpts);
  let findings = findings0;
  let nodes: PageFragment[] | null = null;
  let assembly: ReturnType<typeof assembleWalkmap> | null = null;
  let lastVerifyWhy = '';

  for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt += 1) {
    const callStarted = Date.now();
    const reply = await full.complete(cfg, verifyPromptText, { maxTokens: VERIFY_MAX_TOKENS, timeoutMs: CALL_TIMEOUT_MS });
    const ms = Date.now() - callStarted;
    stats.verifyAttempts = attempt;
    stats.modelCalls += 1;
    if (!reply.ok) {
      await trace.write({
        attempt, phase: 'verify', promptChars: verifyPromptText.length, outputChars: 0, error: reply.error, ms,
      });
      throw new AppError('provider_error', reply.error);
    }

    const parsed = readVerify(reply.text, flowIds, trees);
    if (!parsed.ok) {
      lastVerifyWhy = parsed.why;
    } else {
      const candidate = assembleWalkmap({ nodes: parsed.doc.nodes }, { title, svg });
      const report = validateWalkmap(candidate.walkmap, { svg, fragments: candidate.fragments });
      if (report.ok) {
        nodes = parsed.doc.nodes;
        assembly = candidate;
        if (parsed.doc.findings.length > 0) findings = parsed.doc.findings;
        lastVerifyWhy = '';
      } else {
        lastVerifyWhy = report.errors.join('；');
      }
    }

    await trace.write({
      attempt,
      phase: 'verify',
      promptChars: verifyPromptText.length,
      outputChars: reply.text.length,
      error: nodes === null ? lastVerifyWhy : null,
      ms,
    });

    if (nodes !== null) break;
    if (attempt === MAX_VERIFY_ATTEMPTS) break;
    verifyPromptText = verifyRepairPrompt(req, structure.flows, reply.text, lastVerifyWhy);
  }

  if (nodes === null || assembly === null) {
    throw new AppError(
      'inspect_rejected',
      `页面片段 ${MAX_VERIFY_ATTEMPTS} 次都没通过校验：${lastVerifyWhy}`,
    );
  }

  // 复核可能改过 verdict（也可以把 implemented 降级成 missing）：以最终那一份为准。
  // 第二轮没过校验时 `findings` 仍是第一轮——那时它已经过过一次全量校验。
  stats.verdicts = countVerdicts(findings);
  stats.findings = findings.length;

  // 引用数按**最终**结论重算：复核可能删掉或换掉一条证据，那一份才是材料上写着的东西。
  const finalCitations = citationsOf(findings, Number.MAX_SAFE_INTEGER);
  stats.cited = finalCitations.length;
  stats.citedValid = finalCitations.filter((c) => trees.get(c.repo)?.has(c.path) === true).length;

  const buildStarted = Date.now();
  const built = await full.build(assembly.walkmap, { svg, fragments: assembly.fragments });
  const buildMs = Date.now() - buildStarted;
  await trace.write({
    attempt: 1,
    phase: 'build',
    promptChars: 0,
    outputChars: built.html?.length ?? 0,
    error: built.ok && built.html !== undefined ? null : (built.error ?? built.errors.join('；')),
    ms: buildMs,
  });
  if (!built.ok || built.html === undefined) {
    throw new AppError('walkmap_rejected', `走查材料构建失败：${built.error ?? built.errors.join('；')}`);
  }

  const file = path.join(ARTIFACT_ROOT, `PAN-${req.number}`, 'inspect.html');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, built.html, 'utf8');

  const url = artifactUrl(file);
  const artifact = await full.attach(db, actor, {
    requirementId, stage: 'inspect', url, inputHash,
  });

  stats.bytes = Buffer.byteLength(built.html, 'utf8');
  stats.ms = Date.now() - started;

  return { url, stats, artifactId: artifact.id };
}
