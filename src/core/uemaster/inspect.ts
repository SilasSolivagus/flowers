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
import { typeLabel } from '../requirements/type.js';
import { parseRequirementId } from '../validate.js';
import {
  head, lsTree, show,
  type MirrorResult,
} from '../codemirror/mirror.js';
import { repoShape, type RepoShape } from '../codemirror/route.js';
import { ensureHistory, readHistory, type HistoryRow } from '../locate/history-store.js';
import { locateFromHistory } from '../locate/history.js';
import { recencyOf, topRecent, type RecentFile } from '../locate/recency.js';
import { injectBanner } from '../locate/banner.js';
import { injectReference } from '../locate/reference.js';
import { countHtmlBodyHits, relocateHtmlBody, reportVocab } from './body-language.js';
import {
  ABSENT_HISTORY_LINE, ABSENT_LINE, CANDIDATES_LINE, CONFIRM_WITH_DEV, NOT_FOUND_HEADLINE,
  PRODUCT_BODY_RULE, referenceLines, type CodeRef,
  withRecency, withSnapshots,
} from '../locate/copy.js';
import { recordLocate, type LocateDetail } from '../locate/ledger.js';
import type { LocateResult } from '../locate/types.js';
import { readPrd, type PrdReadResult } from '../prd/read.js';
import { latestSnapshot, type Snapshot } from '../prd/snapshots.js';
import { attachArtifact } from './attach.js';
import { fingerprintOfRow } from '../requirements/fingerprint.js';
import { makeTrace, type Trace } from './attempts.js';
import {
  FLOW_DROP_RULE, assembleWalkmap, droppedNotesIn, reportDropped, type PageFragment,
} from './compose.js';
import {
  MAX_STEPS, MAX_WHAT_CHARS, SEQUENCE_RULE, missingStepsReason, normalizeSteps, type SeqStep,
} from './sequence.js';
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
 * - **阶段一（便宜、可复现、没有模型）**：定位只走**合并历史**——拿需求标题去
 *   `commit_history` 里做中文提交信息检索（`locateFromHistory`），再读一次 `repoShape`
 *   拿页面/接口/组件的结构。同一个 PRD + 同一份历史必然得到同一份候选集，所以
 *   「为什么模型没看见那个文件」这个问题可以脱离模型回答。关键词（`keywordsFrom`）
 *   仍然要抽，但它只喂下面那段结构摘要，**不参与检索**（裁定与三组实测见
 *   `InspectLocateInput.query` 与 `locateQuery`）。
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

/**
 * 关键词个数上限。
 *
 * 它只影响**结构摘要之外的一行提示词**（「阶段一抽出的关键词」那行）与
 * `stats.keywords`，不影响任何一次检索：走查的检索式只有需求标题（见
 * `InspectLocateInput.query`），关键词既不进检索式、也不再拿去 `git grep`
 * （那条路 Task 8 已删）。8 是原来「8 词 × 2 仓 = 16 趟 ssh」时代留下的数量，
 * 现在留着的理由是**够用且稳定**：它只是让模型看见「这份 PRD 里我们认出了哪些词」。
 */
export const MAX_KEYWORDS = 8;

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
  /**
   * 候选（`hits` 是聚合权重）。**只由合并历史给出**：旧 grep/索引路由那两套
   * 「`source` / `probes`」随 Task 8 一起删了，需要时从 git 历史取。
   */
  candidates: Array<{ path: string; hits: number }>;
  /**
   * 这个仓的定位结论（只来自合并历史）。**四种情况并不得**：`absent` 是「没看到」
   * （代码没读到 / 历史没读到，措辞分开），`none` 才是「看到了、没有」。
   *
   * 终审改掉了原来的可选 + `'unknown'`：走查里每一个仓都必然走过定位
   * （`baselineFrom` 一定会填），所以那一格不会是 `undefined`，而「没走过定位」
   * 这个取值**在走查里不可达**——留着它就得在统计里写一个永远走不到的分支
   * （装饰性分支，终审 Minor 2）。真没走定位的调用方（`scripts/shape-corpus.ts`，
   * 它量的是提示词形状）自己给一个值，并写明那不是一次定位结论。
   */
  locate: LocateResult;
};

/** 这次走查的数字。作业收口、报告与用例都读这一份，不各自再算一遍。 */
export type InspectStats = {
  prdVersion: string;
  prdHash: string;
  prdChars: number;
  prdTruncated: boolean;
  repos: Array<{ id: string; sha: string; date: string; files: number }>;
  keywords: string[];
  /** 每个仓的候选数（`absent` / `none` 都是 0）。 */
  candidates: Record<string, number>;
  /**
   * 每个仓的定位结论（`absent` / `none` / `candidates`）——材料里那几句话的来源。
   *
   * **没有第四种取值。** 早先这里写的是 `LocateResult['kind'] | 'unknown'`，并配一个
   * `repo.locate === undefined ? 'unknown' : …` 的分支；但走查里每个仓都必然走过定位
   * （`baselineFrom` 一定填 `locate`），那个分支**不可达**，终审（Minor 2）把它删了。
   * 删它的理由不是「省一行」：一个不可达的取值会让读者以为存在「这个仓没走过定位」
   * 这种状态，于是去给它写渲染、写统计、写兜底——那正是 `?? 'absent'` 那种「没有结论
   * 被静默记成没读到」的老毛病换了个方向。
   */
  locate: Record<string, LocateResult['kind']>;
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
  /**
   * 正文 + 标注里违规词**清洗之前**的处数（2026-11-09 第二轮的可数指标）。
   *
   * 为什么它是「流水线的失误数」而不是「材料的缺陷数」：模型写了多少处研发语言，
   * 就说明提示词在那一次有多不够用。>0 时材料照样出（本仓吃够了「整份不出」的苦），
   * 但这个数会出现在日志一行与这份 stats 里——没有被看见的失败等于没发生。
   */
  vocabHits: number;
  /** 清洗**之后**还剩几处（应当恒为 0；不为 0 说明改写/搬走漏了一条路）。 */
  vocabLeft: number;
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
  /** 可空（Ruling 1）：null = 未指定，prompt 里也照这个词写。 */
  type: string | null;
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

// ─── 阶段一：代码位置（走查只走合并历史） ────────────────────────────────────

/**
 * 走查的定位**只有一条路**：合并历史（`commit_history` → `locateFromHistory`）。
 *
 * 这是 2026-11-07 定位改造的**实施裁决**，比任何「多给几条线索总没坏处」的直觉都硬：
 * 走查发生在**代码已经合进来之后**，历史里已经有「这个功能是哪次合并带进来的、动了
 * 哪些文件」这条权威信号。此时再拿结构/关键词候选去补位，就是把前六个任务刚刚拿掉的
 * 噪音装回材料里——而且那些候选在「历史空/历史读不到」这两种场景下**从没被测过**，
 * 它们混进来的时候还带着一个更糟的副作用：让「读不到代码」看起来像「定位过了」。
 *
 * 所以**不要**在这里加「历史返回 none → 退回结构候选」这一步。三种结果必须一路走到
 * 材料里（措辞只在 `copy.ts` 里定义一次）：
 *
 * | 情况 | `LocateResult` | 材料里那一段 |
 * |---|---|---|
 * | 补齐/读库失败（镜像不通、仓没配） | `absent` + `why` | `ABSENT_HISTORY_LINE(why)` |
 * | 读到、没有相似合并 | `none` | `NOT_FOUND_HEADLINE` + 与研发确认真实现状 |
 * | 读到、有相似合并 | `candidates`（一律 `low`） | `CANDIDATES_LINE(items)` |
 *
 * 旧的 grep / 索引候选路径（`grepCandidates` / `baselineOf` / `rankCandidates` /
 * `candidateLines`）**已删**（Task 8 修一轮）：它们已无调用者，而留着它们最大的害处
 * 是让「走查还有一条备用路」这句话看起来成立。需要旧实现时从 git 历史取（`6d1206c`
 * 及之前）。评审那条路（`review.ts`）走的是自己的 `locateAcross` + 索引，不经过这四个。
 */
export type LocateDeps = {
  ensureHistory: (db: Db, repo: string) => Promise<MirrorResult<{ inserted: number; total: number; ms: number }>>;
  readHistory: (db: Db, repo: string) => Promise<HistoryRow[]>;
  recordLocate: typeof recordLocate;
};

/** 真的那三个读口/写口。测试只换前两格（真镜像造不出「ssh 超时」）。 */
export const LIVE_LOCATE_DEPS: LocateDeps = { ensureHistory, readHistory, recordLocate };

export type InspectLocateInput = {
  repoId: string;
  /**
   * 检索式：**只有需求标题**（`locateQuery`，`\s+` 压成一个空格再 trim）。
   *
   * 描述、六问、`keywordsFrom` 抽出来的关键词**一律不进**这个字段。这条不是口味问题，
   * 是实测定的（uni-app 124 行，真答案 `src/services/download-risk-modal.ts`）：
   * - 只有标题 → 真答案第 5（0.260）；
   * - 标题 + 一句短描述 → 还是第 5（0.185），**零收益**；
   * - 标题 + 60 字整段描述 → **掉出前 6**，第一名变成「fix:修改版本号和描述」那批 utils。
   *
   * 机制上也不是本仓特产：提交信息平均 20–40 字，查询越长，命中「修改 / 版本 / 描述」
   * 这类高频词的空泛合并越占便宜——查询长度与文档长度量级不一致，是检索的经典病。
   * 关键词还有第二个坏处：那套词是为「中文 → 英文标识符」造桥用的（`搜索` → `search`），
   * 而这一层是**中文对中文**比字面重合，桥用不上，多出来的词只给宽合并加分。
   *
   * 关键词在走查里只剩一个用途：喂下面那段结构摘要（路由/页面清单），不参与检索。
   * **不要往这个字段里加任何东西**，除非重跑那三组实测并把它写进这里。
   */
  query: string;
  requirementId: string | null;
  deps?: LocateDeps;
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
  repoShape: (repoId: string) => Promise<MirrorResult<RepoShape>>;
  /**
   * 走查的定位读口 + 记账口（合并历史）。注入它们**只**为了造出「镜像/库读不到」——
   * 真镜像造不出 ssh 超时，而这条链要钉的恰恰是失败时不许假装。
   */
  locateDeps: LocateDeps;
  show: typeof show;
  attach: typeof attachArtifact;
};

/**
 * 真实的依赖：真 HTTP、真 Python 排版器、真镜像读口、真库。
 *
 * 终审（Blocker 5）删掉了这里的 `grep`：Task 8 把走查的候选改成只来自合并历史之后，
 * `InspectDeps.grep` 已经没有任何调用者，而它留在 `LIVE` 里更坏——读者会以为阶段一
 * 还在 grep。`mirror.ts` 的 `grep` 作为读口本身还在（`scripts/` 与对比脚本用得上），
 * 只是走查不再读它。
 */
const LIVE: InspectDeps = {
  complete,
  render: (mermaid) => renderFlowchart(mermaid),
  resolveConfig: resolveProviderConfig,
  build: (walkmap, assets) => renderWalkthrough(walkmap, assets),
  readPrd,
  latestSnapshot,
  head,
  lsTree,
  repoShape,
  show,
  locateDeps: LIVE_LOCATE_DEPS,
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
 * 排序它们会稳居前八，于是交给模型的那八个词全是胶水词——`structurePrompt` 把它们当
 * 「这条需求的业务词」列给模型看，模型照着自己编，写出来的流程节点就是「进行」与「确认」。
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
 * 这些词现在只去两个地方，**都不再是「拿词去 grep」**：
 * - 走查：进 `structurePrompt`，作为「这条需求的业务词」给模型看（历史检索只传标题，
 *   见 `locateQuery`）；
 * - 评审：当模型扩展词失败时的回落词表，进结构索引检索（`locateFromStructure` →
 *   `locateAcross`，拿路径 / 路由 / 导出名去比）。
 *
 * 三条信号，权重从高到低：
 * 1. 引号里的界面文案（`「全部文件」`/`“请输入关键词”`）：PRD 用引号写的就是**用户能
 *    看见的字**，而这些字要落到代码里时，通常原样出现在文件路径、组件名或导出名里——
 *    正是结构检索要比的那几处。权重 3。
 * 2. 标题里的词：标题是这条需求最短的一句话，权重 2。
 * 3. 正文里的 n-gram 频次：权重 1，按 `次数 × 长度` 排序——长词比短词更具体，
 *    「分享页搜索」能命中的文件比「搜索」少得多，而那正是我们要的。
 *
 * 去重规则：已经选中的词如果**包含**或被包含于新的候选，新候选就不要了。理由很实际：
 * `分享页搜索` 与 `搜索` 同时进检索，后者只会把前者已经命中的那批文件再命中一遍，
 * 同一批候选的分被算两次、多花一趟匹配，而排出来的名次看起来还更可信。
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

/**
 * 一个仓库的结构基线：HEAD、树、形状（**不含候选、不含索引**）。
 *
 * 索引曾经也在这里（旧 grep/索引路由要用），Task 8 之后走查不读它了，于是连同
 * `repoIndex` 这一格一起删掉：留着它每遇到一个新 sha 就白建一次索引（0.5–1 s），
 * 而没人读。评审那条路（`review.ts`）有自己的读口，不受影响。
 */
type RepoStructure = {
  id: string;
  sha: string;
  date: string;
  subject: string;
  files: number;
  tree: Set<string>;
  shape: RepoShape;
};

/** 一个仓库的结构：HEAD、树、形状。失败一律是那句中文。 */
async function structureOf(repoId: string, deps: InspectDeps): Promise<RepoStructure> {
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

  return {
    id: repoId,
    sha: headRes.data.sha,
    date: headRes.data.date,
    subject: headRes.data.subject,
    files: treeRes.data.length,
    tree: new Set(treeRes.data),
    shape: shapeRes.data,
  };
}

/** 异常 → 一句话。`why` 会被原样渲染进材料，所以不能给出 `[object Object]`。 */
function whyOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 一个仓的定位：补齐历史 → 读历史 → 检索。**不记账**（记账在一轮的那一层，
 * 见 `locateRoundForInspect`）。
 *
 * 两处「失败必须是返回值、不是异常」的取舍：
 * - `ensureHistory` 自己的失败是 `MirrorResult`（它内部已经把 `mergeHistory` 的退出码
 *   吞过一次，Task 3 修的就是那条），这里原样翻成 `absent`；
 * - 读库那一步抛（连接断了、表被人删了）也是「没读到」，翻成 `absent` 并**带上原始那句**
 *   ——PM 拿它去催人，概括成「读取失败」就没人能行动了。
 *
 * 这里的 `absent` 一律是**「代码读到了、合并历史没读到」那一半**：代码本身读不到时
 * `structureOf` 已经抛了，根本走不到这一层。所以渲染时传 `origin: 'history'`。
 */
export async function locateForInspect(db: Db, input: InspectLocateInput): Promise<LocateResult> {
  const deps = input.deps ?? LIVE_LOCATE_DEPS;

  let ensured: Awaited<ReturnType<LocateDeps['ensureHistory']>>;
  try {
    ensured = await deps.ensureHistory(db, input.repoId);
  } catch (error) {
    return { kind: 'absent', why: `读合并历史时抛错：${whyOf(error)}` };
  }
  if (!ensured.ok) {
    // 不再往下读：补齐失败时库里的行是**上几轮**的，拿它检索等于用旧历史回答这一轮。
    return { kind: 'absent', why: ensured.message };
  }

  let rows: HistoryRow[];
  try {
    rows = await deps.readHistory(db, input.repoId);
  } catch (error) {
    return { kind: 'absent', why: `读 commit_history 失败：${whyOf(error)}` };
  }

  return locateFromHistory(rows, input.query);
}

/**
 * 一轮走查的定位：每个仓各判一次，**把两仓的结果合成一条**（记账见 `recordInspectRound`）。
 *
 * 为什么是「合成一条」而不是每仓一条（终审 Minor 3）：`locate_runs` 是拿来算准确率的
 * 分母，而分母的单位是**案例**——PM 每一轮走查看到的是一份材料，不是一个仓一份。
 * 原来走查每轮写两行（每仓一行）、评审每轮写一行，于是「攒够 30 条案例」这个门槛上，
 * 走查的案例被算了两遍：30 行里可能只有 15 轮。这里统一成「一轮一行」，两种阶段同口径。
 *
 * 一轮一行丢掉的仓粒度由 `locate_runs.detail` 补回来（修复二波，见 `recordInspectRound`）。
 *
 * 合成的规则（`mergeLocateRound`）只有一条：**candidates > absent > none**。
 * 选出别的顺序都有害：把 `none` 放在 `absent` 之上，等于让「一个仓没读到」被
 * 「另一个仓读到了但没找到」盖住——那正是本次改造要消灭的那种合并。
 *
 * 这个函数**不写库**：它只回答「两个仓各是什么、合起来是什么」。写库在材料产出之后
 * （`recordInspectRound`），理由见那里。
 */
export async function locateRoundForInspect(
  db: Db,
  inputs: readonly InspectLocateInput[],
  deps: LocateDeps,
): Promise<InspectRound> {
  const first = inputs[0];
  if (first === undefined) throw new Error('locateRoundForInspect 至少要一个仓：空输入说明仓清单坏了');

  const parts: Array<{ repo: string; result: LocateResult }> = [];
  for (const input of inputs) {
    parts.push({ repo: input.repoId, result: await locateForInspect(db, input) });
  }
  return { parts, merged: mergeLocateRound(parts) };
}

/** 一轮走查的定位结果：每仓一份原结论 + 合成后的那一条（给材料与记账用）。 */
export type InspectRound = {
  parts: Array<{ repo: string; result: LocateResult }>;
  merged: LocateResult;
};

/**
 * 把一轮走查记成**一行**账，并带上分仓明细。**由调用点在材料写出来之后调。**
 *
 * 两件事，各自都有一条裁定：
 *
 * 1. **时机**（修复二波，与评审那条路同口径）：这一行描述的是「PM 真拿到了一份材料」，
 *    而 `locate_runs` 是算准确率的分母。原来的写法在**两次模型调用之前**就落库，于是
 *    `inspect_invalid` / `inspect_rejected` / `flow_rejected` / `walkmap_rejected`
 *    这些失败都会留下一条指向从未存在过的材料的行。现在记账只在 `inspect()` 拿到
 *    `attach` 之后发生——「有行必有材料」不再靠注释，靠位置。
 * 2. **明细**（修复二波，推翻「一轮一行、不留细节」）：`outcome` 只记「材料上那句话
 *    怎么说的」，而「哪个仓没读到」必须落进 `detail`。否则「一仓 absent + 一仓
 *    candidates」合成的那条 `low` 会让盲仓在分母里彻底消失——将来算准确率时，半盲的
 *    样本会被当成全见的样本。剔除办法写在 `locate_runs.detail` 的列注释里。
 *
 * 记账失败**一路抛出去**：这一层不产生业务结论，没有可以退回去的地方；而静默少记一条
 * 在攒数阶段不可见（报告里只会显示「案例比预期少几条」）。
 */
export async function recordInspectRound(
  db: Db,
  input: { requirementId: string | null; parts: readonly { repo: string; result: LocateResult }[] },
  deps: Pick<LocateDeps, 'recordLocate'>,
): Promise<LocateResult> {
  const merged = mergeLocateRound(input.parts);
  const repos: LocateDetail['repos'] = {};
  for (const part of input.parts) {
    // `why` 只在 `absent` 时写：其余两种没有原因可写，写一句空字符串会让
    // 「有没有原因」这件事变得要靠 `kind` 再判一次。
    repos[part.repo] = part.result.kind === 'absent'
      ? { kind: 'absent', why: part.result.why }
      : { kind: part.result.kind };
  }
  await deps.recordLocate(db, {
    requirementId: input.requirementId,
    stage: 'inspect',
    result: merged,
    detail: { repos },
  });
  return merged;
}

/**
 * 两仓的结论 → 一条（记账用）。规则与理由见 `locateRoundForInspect`。
 *
 * `absent` 的 `why` 按仓拼（`仓 id：原句`）：合成之后仍然要能看出是哪一个仓没读到，
 * 否则 PM 拿着「（原因：读 commit_history 失败）」不知道该去查哪个仓的库。
 */
export function mergeLocateRound(
  parts: readonly { repo: string; result: LocateResult }[],
): LocateResult {
  const first = parts[0];
  if (first === undefined) throw new Error('mergeLocateRound 至少要一个仓');

  const withCandidates = parts.filter((part) => part.result.kind === 'candidates');
  if (withCandidates.length > 0) {
    const items = withCandidates.flatMap((part) =>
      part.result.kind === 'candidates' ? part.result.items : []);
    // 一律 `low`：两仓拼起来的清单只比单仓更弱，不会更强。
    return { kind: 'candidates', confidence: 'low', items };
  }

  const blind = parts.filter((part) => part.result.kind === 'absent');
  if (blind.length > 0) {
    const why = blind
      .map((part) => `${part.repo}：${part.result.kind === 'absent' ? part.result.why : ''}`)
      .join('；');
    return { kind: 'absent', why };
  }

  return { kind: 'none' };
}

/**
 * `absent` 缺的是哪一半。**由调用点给**，因为它刚调用的是哪个读口。
 *
 * - `code`：代码本身没读到（镜像连不上、仓没配、HEAD/树读不出来）；
 * - `history`：代码读到了，合并历史（`commit_history` 补齐或读库）没读到。
 *
 * 为什么这不是 `LocateResult` 上的一个字段：类型一改，记账、统计、材料三处都要多一个
 * 分支，任一处漏写就会把一种缺口算成另一种。缺口的位置是**调用点的事实**，不是结果
 * 类型的身份——所以它作为参数进来，而不是塞进联合里。
 */
export type LocateOrigin = 'code' | 'history';

/**
 * 定位结论 → 材料里的那一段。**全仓只有这两三句**（措辞在 `copy.ts`）。
 *
 * 走查把它原样放进结构提示词与材料顶部的横幅；评审放进现状基线与横幅。这里绝不写
 * 第四句过渡语——几种情况一旦开始互相接近，迟早并成一句，那正是本次改造要消灭的
 * 那种合并。
 *
 * `origin` 只在 `absent` 时起作用（其余两种与缺口在哪一半无关）。默认取 `'code'`：
 * 忘记传的后果是「说得更严重」，而不是把一次库故障说成「代码里没有」——失败方向是响亮的。
 */
export function renderLocate(result: LocateResult, origin: LocateOrigin = 'code'): string {
  if (result.kind === 'absent') {
    return origin === 'history' ? ABSENT_HISTORY_LINE(result.why) : ABSENT_LINE(result.why);
  }
  if (result.kind === 'none') return `${NOT_FOUND_HEADLINE}${CONFIRM_WITH_DEV}`;
  return CANDIDATES_LINE(result.items);
}

/**
 * 结构 + 定位结论 → 一个仓的基线。
 *
 * `candidates` 只在真的拿到候选时才有内容：`absent` / `none` 一律空数组。这是**同一个
 * 事实的两种字段写法**，不是两次判断——提示词与横幅里那段文字一律由 `renderLocate`
 * 现算（终审删掉了 `locateText` 那一格：同一个结论存两份，两份总有先后，先后就是漂移）。
 * 让 `absent` 也顺手带几个候选进来，材料里就会出现「没读到代码」后面跟着一份清单的
 * 自相矛盾。
 *
 * 这一层传 `'history'`：走查能产出 `absent` 的唯一路径是合并历史/库读不到——代码本身
 * 读不到时 `structureOf` 早就抛了，轮不到这里。
 */
function baselineFrom(struct: RepoStructure, locate: LocateResult): RepoBaseline {
  return {
    ...struct,
    candidates: locate.kind === 'candidates'
      ? locate.items.map((item) => ({ path: item.path, hits: item.score }))
      : [],
    locate,
  };
}

/**
 * 走查的检索式：**只传需求标题**（trim + 压空白），描述、六问、关键词一律不进。
 *
 * 这条裁定是拿三组实测定的（uni-app 124 行，真答案 `src/services/download-risk-modal.ts`）：
 *
 * | 检索式 | 真答案名次 | 权重 |
 * |---|---|---|
 * | A 只有标题 | 第 5 | 0.260 |
 * | B 标题 + 一句短描述 | 第 5 | 0.185 |
 * | C 标题 + 60 字整段描述 | **掉出前 6** | —（第一名变成「fix:修改版本号和描述」那批 utils） |
 *
 * B 相对 A **零收益**（名次没动），C **明确有害**，所以描述不该进 query。机制上也不是
 * 本仓特产：提交信息平均 20–40 字，query 越长，命中「修改 / 版本 / 描述」这类高频词的
 * 空泛合并越占便宜——**查询长度与文档长度量级不一致，本身就是检索的经典病**。
 *
 * 那为什么连 `keywordsFrom` 也不用（第一版用过，同样被实测否掉）：那套词是为「把中文
 * 桥到英文路径」设计的（`搜索` → `search`），而历史检索是**中文对中文**比字面重合，桥
 * 用不上；多出来的词反而给宽合并加分（关键词拼检索式时，`上传下载按量限速风控` 的前六
 * 名全是 `app/browser-window/*`，真答案一个都进不来）。
 *
 * **别再「顺手把描述加回去，因为信息更多」。** 信息更多在这条链上是负收益：这一层比的是
 * 「这条需求标题像哪次合并的提交信息」，而提交信息本身就是一句话；把 PRD 式的长描述塞进来
 * 只是让每个空泛合并都多一点「沾边」的分数。真答案没到第 1 名也不是这里的问题——它和
 * 同一次合并里另外四个文件**权重完全相同**，卡住它的是同合并并列（`compareFiles` 组内按
 * 路径升序），不是打分。调参已裁定关闭。
 */
export function locateQuery(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

/** 一次走查的检索式（从需求行取，两处拼法只此一份）。 */
function queryOfRequirement(req: RequirementRow): string {
  return locateQuery(req.title);
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

/**
 * 材料里的定位段：把 `renderLocate` 的结论之一原样挂到仓名下。
 *
 * 缩进两格只是排版——文字**一个字都不改**：`absent` 那一句里的「这一轮不含任何现状
 * 判断」是要让模型与 PM 一起看见的，这里若为了好看改写，语义就散了。
 */
function locateLines(repo: RepoBaseline): string[] {
  return [
    `  [${repo.id}]`,
    ...renderLocate(repo.locate, 'history').split('\n').map((line) => `    ${line}`),
  ];
}

/**
 * 材料顶部横幅的文字（`injectBanner` 的输入）。
 *
 * 三件事的次序不能倒：
 * 1. **结论相同就只说一遍**。两仓都判成 `none`（或都 absent 且原因相同）时，硬按仓各说
 *    一遍，PM 会以为这是两份不同的结论；而且同一句话念两遍，正是「三句变四句」的开头。
 * 2. 结论不同才按仓标出（`[仓]` 一行 + 正文）：那时仓名是信息，不是排版。
 *
 * 文字一律来自 `renderLocate`（再往下是 `copy.ts`），这里**一个字都不自己写**；
 * 末尾那份「代码快照：<仓> @ <日期>」同样来自 `copy.ts`（`withSnapshots`）——材料说
 * 「最可能的位置」时，必须同时说清这是对着哪一版代码说的，旧了也要说旧（2026-11-08）。
 * 「同类先例：…」那一行（Task 5）**刻意没有接在这里**：实测 44/60 条真需求标题的
 * 第一名是「更换 work / 更新 web 代码」这类一次性合进来十几个提交的巨型合并，
 * 把规模照抄成 14~150 个文件——比不写更糟（评审会拿错的例子量这次改动）。
 * 理由与数字见 `.superpowers/sdd/2026-11-08-index-value/task-5-report.md`；
 * 检索本身在 `similarMerges`，接回来之前先重跑那张表。
 *
 * 「最近改动：…」那几行（Task 6）接在**快照行之后**：顺序是「对着哪一版代码」（快照）
 * → 「这些位置最近有人动过吗」。两句必须放在一起读：快照说代码整体到哪天为止，最近改动
 * 说某个文件最后一次被合进来是哪天，后者永远不该晚于前者——晚于就是库或时钟出了问题，
 * 那时读者会在同一屏里看到两句互相打脸的话（Task 5 被否掉的第二种失败形态）。
 */
function locateBannerText(
  repos: readonly RepoBaseline[],
  recency: readonly RecentFile[] = [],
): string {
  const rendered = repos.map((repo) => ({ repo: repo.id, text: renderLocate(repo.locate, 'history') }));
  const first = rendered[0];
  if (first === undefined) return '';
  const distinct = new Set(rendered.map((item) => item.text));
  const body = distinct.size === 1
    ? first.text
    : rendered.map((item) => `[${item.repo}]\n${item.text}`).join('\n');
  // 一行一个仓：用了几个仓就写几行（`RepoBaseline` 自带 `id` / `date`）。
  return withRecency(withSnapshots(body, repos), recency);
}

/**
 * 走查材料引用到的**代码坐标**（末尾「研发参考」的输入）。
 *
 * 来源只有一处：结论里那些 evidence 的 `{repo, path}`——它们已经被 `validateStructure`
 * 拿 `ls-tree` 逐个核对过存在（不存在的会整条退回重答），所以这里不再筛。
 *
 * **为什么不带行号与符号**：走查这条路不读结构索引（`structureOf` 只取 HEAD / 树 / 形状，
 * 见那里的注释），拿不到 `outline` 的行号。宁可行号空着，也不要猜一行——这一节唯一的
 * 价值是「研发照着点开就是那个东西」，猜错一次它就作废了。（评审那条路有索引，
 * 所以它的坐标带行号与符号，见 `reviewRefs`。）
 */
export function inspectRefs(findings: readonly Finding[]): CodeRef[] {
  const refs: CodeRef[] = [];
  for (const finding of findings) {
    for (const evidence of finding.evidence) {
      refs.push({ repo: evidence.repo, path: evidence.path });
    }
  }
  return refs;
}

/**
 * 有仓「没读到」时，把那条硬规则当场写进提示词（没有就一行都不加）。
 *
 * 为什么不把它写死成第 8 条规则、永远出现：模型看到一句与本次输入无关的禁令，会开始
 * 猜「是不是有个仓没读到」。规则必须跟着输入出现，才读得懂。
 */
function absentRule(repos: readonly RepoBaseline[]): string[] {
  const absent = repos.filter((repo) => repo.locate.kind === 'absent');
  if (absent.length === 0) return [];
  return [
    `  ! ${absent.map((repo) => repo.id).join('、')} 的代码这一轮**没读到**（见上面的原因）：`,
    '    不要给这些仓下任何现状判断——不要写 implemented / extra / differs，也不要引用它们的路径。',
    '    确实要提就写 missing，并在 searched 里写你搜索时用的词；「没读到」不等于「没有实现」。',
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
    `  · 类型：${typeLabel(req.type)}　提出人：${flat(req.requester)}`,
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
    '阶段一：代码位置（在镜像的**合并历史**里按需求标题检索出来的；这是唯一的一路，',
    '        没有相似合并就是没有，不会拿别的近似信号凑数）：',
    ...repos.flatMap((repo) => locateLines(repo)),
    ...absentRule(repos),
    `（阶段一抽出的关键词（只用于下面的结构摘要，不参与历史检索）：${keywords.join('、')}）`,
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
    ...PRODUCT_BODY_RULE,
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
    '',
    ...FLOW_DROP_RULE,
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
    ...repos.flatMap((repo) => locateLines(repo)),
    ...absentRule(repos),
    `（阶段一抽出的关键词（只用于下面的结构摘要，不参与历史检索）：${keywords.join('、')}）`,
    '',
    ...PRODUCT_BODY_RULE,
    '',
    '重发**完整**的 JSON，形状不变：',
    '{"flows":[{"id","title","kind"}],"findings":[{"verdict","prd","code","evidence":[{"repo","path","note"}],"searched"}]}',
    `规则：flows 3–${FLOW_CAP} 个、按用户实际顺序；findings 1–${FINDING_CAP} 条；`,
    'missing 的 evidence 必须是空数组并给 searched；其余 verdict 至少一条 evidence；',
    '所有路径都必须在对应仓库的 HEAD 上真实存在。只输出 JSON 本身。',
    '',
    ...FLOW_DROP_RULE,
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
    ...PRODUCT_BODY_RULE,
    ...SEQUENCE_RULE,
    '（上面这段正文规则对 findings 的 prd / code 两格与每个节点的 anno 都成立：anno 写在'
      + '右栏给 PM 读，说清「这一步与需求对不对得上」，不要贴路径。'
      + '证据位置由系统写进末尾的「研发参考」。）',
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
    '后端节点（kind=system / decision）没有页面：不要给 html，交一组时序步骤 steps：',
    '{ "id": "B", "kind": "system", "title": "写分享记录",',
    '  "steps": [',
    '    { "from": "页面", "to": "服务端", "what": "提交分享内容" },',
    '    { "from": "服务端", "to": "服务端", "what": "记录这次分享" },',
    '    { "from": "服务端", "to": "通知渠道", "what": "给被分享的人提醒" }',
    '  ],',
    '  "anno": [["缺失", "代码里没有写分享记录这一步"]] }',
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
    ' 1. 每个节点 1–3 条，每条 ["小标题","正文"]，小标题 2–6 个字（缺口 + 建议算一对、占 2 条）。',
    ' 2. **第一条必须是一条 verdict**：小标题只能是 一致 / 缺失 / 多余 / 不一致 之一，',
    '    正文一句话说清这个节点与 PRD 的关系。它是这份材料「走查」的身份，缺了会被退回。',
    ' 3. 其余条目写设计约束、边界与风险；不要重复页面里已有的文案。',
    ' 4. PRD 没定、不定就没法开工的地方，写**一对**行（这是评审最要看的两格）：',
    '    ["缺口 · 小标题", "一句话说清缺什么、谁要定", "p0"] 紧跟一行 ["建议", "产品上怎么补"]。',
    '    第三格是严重度：p0 = 不定就没法开工，p1 = 会返工，p2 = 可以先绕。',
    '    这两格里**一个实现词都不许有**——不写参数、字段、接口、埋点、状态码，也不写页面',
    '    在代码里的名字。照上面「缺口 + 建议」的正例写，那一对就是从真实材料里拿来的。',
    ' 5. kind=system / decision 的节点没有页面：不要给 html 和 frame，只给 anno 与 steps。',
    `    steps 是 1–${MAX_STEPS} 步的数组，每步 { "from": "谁", "to": "对谁", "what": "做了什么" }，`
      + `每步 ≤${MAX_WHAT_CHARS} 字；参与方只能用：用户 / 页面 / 运营后台 / 服务端 / 支付渠道 / 通知渠道 / 第三方。`,
    '    这是给 PM 看「这一步后端到底做了什么、跟谁打交道」的那张图——他看不到代码，',
    '    所以一个方法名、表名、接口地址都不许出现（写了会被机器退回）。',
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
    ...PRODUCT_BODY_RULE,
    ...SEQUENCE_RULE,
    '',
    '重发**完整**的 JSON，形状不变：{"findings":[{"verdict","prd","code","evidence":[],"searched":[]}],'
      + '"nodes":[{"id","kind","frame","title","html","anno","steps":[{"from","to","what"}]}]}',
    'kind=page 给 frame 与 html；kind=system / decision 不给 html，给 steps（谁 → 谁 · 做什么，'
      + `1–${MAX_STEPS} 步，每步 ≤${MAX_WHAT_CHARS} 字）。`,
    '每个节点 anno 的第一条必须是 verdict（一致/缺失/多余/不一致）；',
    '缺口那一对行的严重度只能取 p0 / p1 / p2，且缺口与建议两格不许出现实现词。',
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
  // 后端节点的时序步骤（2026-11-09）：形状交给 `sequence.ts` 的 `normalizeSteps`，
  // 在那里报错才能说清「第几步、哪个参与方不在词表里」（见 compose.ts 同名字段的注释）。
  steps: z.unknown().optional(),
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
    /**
     * 后端节点的时序步骤（2026-11-09）：走查这条路的节点本来也分两类，但原来只有
     * 「给不给 html」的判据，于是一个纯后端流程（`PAN-815` 那一类）里六个节点全都没有
     * html，拼装时挂到空页面上、整份被拒。这里把义务说清：**没有页面的节点必须给 steps**。
     *
     * 第三轮收紧（与 `compose.readFragments` 同一句话，`missingStepsReason` 是唯一措辞来源）：
     * 上一版放过「判为后端但没 steps」的节点、由拼装阶段挂到最近的页面上——那会让读者看见
     * 一屏界面，把一步服务端的事读成「这一步在界面上」。现在整份退回，模型据此能一次补上。
     */
    let steps: SeqStep[] = [];
    if (node.kind !== 'page') {
      // 空数组与「没给」是同一件事：都等于没说这一步在服务端做什么（旧版正因为它走了兜底）。
      const blank = node.steps === undefined || node.steps === null
        || (Array.isArray(node.steps) && node.steps.length === 0);
      if (blank) return { ok: false, why: missingStepsReason(node.id, node.title) };
      const read = normalizeSteps(node.steps);
      if (!read.ok) return { ok: false, why: `节点 ${node.id} 的 ${read.why}` };
      steps = read.steps;
    }
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
      ...(steps.length > 0 ? { steps } : {}),
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
    repos: [], keywords: [], candidates: {}, locate: {}, flows: 0, findings: 0,
    verdicts: { implemented: 0, missing: 0, extra: 0, differs: 0 },
    cited: 0, citedValid: 0, deepRead: 0, deepReadChars: 0,
    structureAttempts: 0, verifyAttempts: 0, modelCalls: 0, bytes: 0, ms: 0,
    vocabHits: 0, vocabLeft: 0,
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
  // 结构先全部拿到手，**再**一起定位：两个仓的 HEAD / 树要一对一对地进同一次走查
  // （标题里那两个 sha 就是它俩），而证据核对按仓索引（`TreeIndex`）——某一步失败时
  // 能一眼看出是哪一个仓没读到，比在模型调用之后才发现少了一个仓好。
  const structures: RepoStructure[] = [];
  for (const repoId of INSPECT_REPOS) structures.push(await structureOf(repoId, full));
  // 定位只走合并历史（裁决见 `LocateDeps` 的注释）：上面的结构表还在（HEAD / 树 / 形状
  // 是核对证据的基础），但候选只来自历史。**不**在 `none` 时退回结构候选——那会把刚拿掉
  // 的噪音装回去，还会让「没读到」看起来像「定位过了」。
  const query = queryOfRequirement(req);
  // 一轮定位：每仓各判一次，结果**合成一条**（终审 Minor 3：分母的单位是「案例」，
  // 一轮走查 PM 看到的是**一份**材料，不是一仓一份）。这里只是**判**，不写库——
  // 记账在材料写出来之后（见本函数末尾的 `recordInspectRound`）。
  const round = await locateRoundForInspect(
    db,
    structures.map((struct) => ({
      repoId: struct.id,
      query,
      requirementId,
      deps: full.locateDeps,
    })),
    full.locateDeps,
  );
  const locateByRepo = new Map(round.parts.map((part) => [part.repo, part.result]));
  const repos: RepoBaseline[] = structures.map((struct) => {
    const result = locateByRepo.get(struct.id);
    // 不写兜底值：`parts` 与 `structures` 一一对应（同一个循环造出来的），缺了就是
    // 装配错了——给它编一句「没读到」正是本次改造禁止的那种「失败渲染成正常取值」。
    if (result === undefined) throw new Error(`定位结果缺了 ${struct.id}：parts 与 structures 不同源`);
    return baselineFrom(struct, result);
  });

  stats.repos = repos.map((repo) => ({ id: repo.id, sha: repo.sha, date: repo.date, files: repo.files }));
  stats.candidates = Object.fromEntries(repos.map((repo) => [repo.id, repo.candidates.length]));
  stats.locate = Object.fromEntries(repos.map((repo) => [repo.id, repo.locate.kind]));

  // ── 候选文件「最近一次被合进来」是哪天（Task 6）──
  //
  // 只查**这一轮定位到的候选**：材料上的「最近改动：…」是在解释上面那份候选清单，
  // 查别的文件既没人读，也会把材料变成一张报表。一次查询覆盖全部候选（`recencyOf`）。
  //
  // 查不到就一条都不出现（`recencyLines` 返回空数组）：写「未知」等于说「我们查过了、
  // 确实没有」，而真实情况是那个文件没有合并记录（日常小提交从不进 `commit_history`）。
  // 不 try/catch：这一步紧跟在几仓的 `readHistory` 成功之后，同一个库同一条连接刚刚
  // 读通过；此时再失败只可能是库真的坏了，把它吞成「没有最近改动」正是本仓修过两遍的
  // 「失败渲染成一个看起来正常的取值」。
  const recency = topRecent(await recencyOf(
    db,
    repos.flatMap((repo) => repo.candidates.map((item) => ({ repo: repo.id, path: item.path }))),
    new Date(),
  ));

  // ── 两仓的历史都没读到：**照样出材料**，但材料顶部写明「这一轮不含现状判断」──
  //
  // 这是终审 Blocker 1 的裁决点。旧行为是抛 `locate_absent` 整份不出，理由是「拿不到
  // 定位，模型只会编」。但这条路径上 HEAD / lsTree / repoShape **都已经读到了**：
  // 证据核对、深读、页面片段都不依赖合并历史，能出的部分是真实的（流程主干 + PRD 侧的
  // 问题清单）。整份丢掉，PM 拿到的只有一句错话（「代码没读到」）+ 一份消失的材料。
  //
  // 所以现在：**材料照出**，靠三处把「没有现状判断」钉死——
  // 1. 材料顶部横幅（`injectBanner`，代码写死，模型不参与）第一句就是
  //    `ABSENT_HISTORY_HEADLINE`，连同 `why`；
  // 2. 提示词里 `absentRule` 对 `absent` 的仓下禁令：不许写 implemented / extra / differs，
  //    不许引用它们的路径——两仓都 absent 时，等于整份结论里没有现状判断；
  // 3. `stats.locate` 与 `recordLocate` 都记着 `absent`，不会在统计里变成一次成功定位。
  //
  // 已知残余（写进报告）：`absentRule` 只是提示词禁令，没有机器核对（本仓原有第 3 条
  // 已知代价）。真要机器保证，得在 `validateStructure` 里对 absent 仓的 evidence 直接
  // 判死——那是另一件事，不在本次修复范围。

  const trees: TreeIndex = new Map(repos.map((repo) => [repo.id, repo.tree]));
  const trace: Trace = makeTrace(db, request.jobId ?? null, cfg.model);

  // ── 阶段二：结构（最多 2 次） ──
  let prompt = structurePrompt(req, prd, repos, keywords);
  let structure: Structure | null = null;
  let lastProblems: string[] = [];
  /**
   * 模型在**被接受的那一版**里删掉的流程步骤（`已删去：…`，见 `compose.ts` 的
   * `FLOW_DROP_RULE`）。只认最后接受的那一版：前几版模型重画了整张图，那些删改已经
   * 不生效，把它们一起报出来会让复核的人去找一个不存在的缺口。
   */
  let droppedSteps: string[] = [];

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
      if (checked.ok) {
        structure = read.doc;
        droppedSteps = droppedNotesIn(reply.text);
      } else lastProblems = checked.problems;
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

  // 删掉了不属于产品流程的步骤 → 打一行交代（删了什么、删了几步）。
  reportDropped(`PAN-${req.number} inspect`, droppedSteps);

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
  // 横幅在**写盘之前**插（终审 Blocker 2）：那几句话原本只进提示词，材料里一个字都不带，
  // 于是评审/走查落 `absent` 时 PM 只看到标题里一句「未参考代码现状」，而 `why`（唯一
  // 能拿去催人的线索）丢了。这一段由代码写死、模型不参与——模型在正文里提没提它都一样。
  /**
   * 三段，顺序与评审那条路一字不差（`review.ts` 同一处有完整理由）：
   * 1. `relocateHtmlBody` —— 正文里不许有代码坐标（`service/x.go:382`、反引号标识符）。
   *    被删掉的原句进 `moved`，随后搬进末尾的「研发参考」。**机器保证**，不看模型脸色。
   * 2. `injectBanner` —— 顶部结论 + 代码快照 + 最近改动；放在剥离之后，因为横幅里的
   *    候选清单本来就带路径（那是给 PM 拿去催研发的线索，不是正文）。
   * 3. `injectReference` —— 末尾「研发参考」：`仓:路径` + 受影响文件数；没坐标整节不写。
   */
  const moved: string[] = [];
  const vocabHits = assembly.annoRaw + countHtmlBodyHits(built.html);
  const stripped = relocateHtmlBody(built.html, moved);
  const vocabLeft = assembly.annoLeft + countHtmlBodyHits(stripped);
  reportVocab(`PAN-${req.number} inspect`, vocabHits, vocabLeft);
  const html = injectReference(
    injectBanner(stripped, locateBannerText(repos, recency)),
    // 两处来源合起来：正文里被删掉的子句（`moved`）与标注里被搬走的句子
    // （`assembly.moved`，缺口/建议那一档更严，2026-11-09 第二轮）。
    referenceLines(inspectRefs(findings), [...moved, ...assembly.moved]),
  );
  await writeFile(file, html, 'utf8');

  const url = artifactUrl(file);
  const artifact = await full.attach(db, actor, {
    requirementId, stage: 'inspect', url, inputHash,
  });

  stats.bytes = Buffer.byteLength(html, 'utf8');
  stats.vocabHits = vocabHits;
  stats.vocabLeft = vocabLeft;
  stats.ms = Date.now() - started;

  // 记账放在**材料写出来之后**（修复二波，与评审那条路同口径）。这一行描述的是「PM 真拿到了
  // 一份材料」，而 `locate_runs` 是算准确率的分母：`inspect_invalid` / `inspect_rejected` /
  // `flow_rejected` / `walkmap_rejected` 那几处失败都不会走到这里，所以「有行必有材料」
  // 不是靠注释，是靠位置。原来这一行写在两次模型调用之前，`walkmap_rejected` 之后库里就留着
  // 一条指向从未存在过的材料的行。
  await recordInspectRound(db, { requirementId, parts: round.parts }, full.locateDeps);

  return { url, stats, artifactId: artifact.id };
}
