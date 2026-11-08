import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { typeLabel } from '../requirements/type.js';
import { parseRequirementId } from '../validate.js';
import { readPrd, type PrdReadResult } from '../prd/read.js';
import { latestSnapshot, type Snapshot } from '../prd/snapshots.js';
import { attachArtifact } from './attach.js';
import { fingerprintOfRow } from '../requirements/fingerprint.js';
import { makeTrace, type Trace } from './attempts.js';
import {
  addUsage, buildFlow, buildPages, flat, loadRequirement, missingProviderText, parseFlow,
  type ComposeDeps, type ComposeUsage, type FlowNode, type RequirementRow,
} from './compose.js';
import { renderFlowchart } from './flow.js';
import { head, lsTree, show, type MirrorResult } from '../codemirror/mirror.js';
import { type CodeIndex } from '../codemirror/code-index.js';
import { repoIndex, type BuiltIndex } from '../codemirror/index-store.js';
import { injectBanner } from '../locate/banner.js';
import { createExpand } from '../locate/expand.js';
import { recordLocate } from '../locate/ledger.js';
import { expandedKeywords, locateFromStructure, type ExpandFn } from '../locate/structure.js';
import type { LocateResult } from '../locate/types.js';
import { keywordsFrom, prdVersionOf, renderLocate } from './inspect.js';
import { withSnapshots } from '../locate/copy.js';
import {
  complete, extractJson, resolveProviderConfig,
  type ProviderConfig,
} from './provider.js';
import {
  answerTruncated, coerceAnswer, noJsonReason, normalizeFindingType,
  type ReviewFindingType,
} from './shape.js';
import { ARTIFACT_ROOT, artifactUrl } from './store.js';
import {
  findEmoji, renderWalkthrough, validateWalkmap,
  type Anno, type BuildResult, type Walkmap, type WalkmapNode,
} from './walkmap.js';

/**
 * 「评审材料」：把一份 PRD **逐字**过一遍，产出一份问题清单，再挂到同一套 UEmaster 三栏页上。
 *
 * 这个文件存在的理由是一句很直白的自省：在这之前，`stage=review` 只是把
 * `composeEvaluation` 又跑了一遍，唯一的不同是提示词里那句 `FOCUS.review`
 * （「把 PRD 完整走一遍」）——**它从来没有读过 PRD**。于是评审材料是评估材料的复印件，
 * 只是标题换了。这比「没有评审」更坏：它看起来像评审过。
 *
 * 所以这条路的判据与评估那条**只有一处相同**（图），其余全不一样：
 *
 * 1. **PRD 是输入，不是一个 URL。** 没有链接就拒绝（`REVIEW_NEEDS_PRD`），有链接但没有
 *    快照就先读（`readPrd`），读不到就停——没有 PRD 的评审是用标题在评审。
 *    （2026-11-08 裁定：链接这一关只在**评审材料**上，评估与走查保持原样。）
 * 2. **问题清单必须有据。** 每条问题带一句 PRD 原文（`quote`），我们会把它和 PRD 正文
 *    **逐字**比对（归一化空白与标点之后做子串判定）。找不到的那一条直接丢掉，
 *    并且记下来、原样回给模型重答一次。这与走查的「路径必须存在于 `lsTree`」是同一条
 *    纪律：模型嘴里的话不算证据，只有落在被审对象里的字符串才算。
 * 3. **问题必须挂在流程节点上。** 挂不到节点上的问题，在右栏没有位置可放——与
 *    `dropUnknownNodes` 同一个理由：零信息，而且会让人以为那一屏有内容。
 * 4. **一条都不剩 = 失败。** 空的问题清单不是「没毛病」，是这次评审没做成。
 *
 * 与 `compose.ts` 的分工：图那一段（`buildFlow`）与页面片段那一段（`buildPages`）
 * **原样复用**，因为「图算不算合格」和「展示要与 UEmaster 一致」这两件事只能有一份
 * 实现。这个文件只负责中间那一段（问题清单）与最后那份标注改写。
 */

// ─── 常量：六类、上限、预算 ─────────────────────────────────────────────────

/**
 * 六类问题，以及界面上用的中文标签。
 *
 * 为什么是封闭的六类而不是让模型自由命名：右栏那一行的小标题就是这里的标签，评审
 * 是要**横向比**的——「这份 PRD 缺了 5 处状态」这种话只有在类别稳定时才说得出来。
 * 模型不照这个枚举写（语料证明它不会），所以 `shape.ts` 的 `normalizeFindingType`
 * 负责把中文标签与近义写法收回来；收不回来的照样丢。
 */
export const REVIEW_TYPE_LABEL: Record<ReviewFindingType, string> = {
  // 文档自身：不用看代码也挑得出来
  dead_end: '死路',
  no_screen: '无页面步骤',
  missing_state: '缺状态',
  ambiguous: '歧义',
  no_acceptance: '缺验收口径',
  unbounded: '边界未定',
  // 改动层面：**必须先摸底代码现状**才说得出来，且必须带代码证据
  conflicts_current: '与现状冲突',
  misses_current_edge: '漏了现状的边界',
  no_migration: '没说怎么迁移',
};

/** 标题里数与标签的排列顺序：固定的，因为这是给人**横向比**的一行字。 */
export const REVIEW_TYPE_ORDER: readonly ReviewFindingType[] = [
  // 改动层面的排前面：它们是评审会上真正决定「这个方案站不站得住」的那几条。
  'conflicts_current', 'misses_current_edge', 'no_migration',
  'dead_end', 'no_screen', 'missing_state', 'ambiguous', 'no_acceptance', 'unbounded',
];

/** 问题清单的上限。再多也不该是一份材料，而是一篇文档。 */
export const MAX_FINDINGS = 12;

/** 问题清单最多问 2 次：首版 + 一轮修复（把被丢掉的条目回给模型）。 */
export const FINDINGS_ATTEMPTS = 2;

/** 一段 JSON 问题清单用不了多少 token；给多了只会让模型开始写解释。 */
// 实测（PAN-6 真跑）：这一格思考 26,581 字、答案 0 字——评审要通读 19k 字 PRD
// 再逐条对照，推理模型的思考量比生成量还大。给足空间，不然一次白烧 76 秒。
const FINDINGS_MAX_TOKENS = 40_000;

/**
 * 单次调用预算。**不再跟 compose 的 90 秒**：评审要通读 19k 字 PRD，
 * 推理模型在 findings 这一段实测思考 26k 字，90 秒连思考都跑不完（真跑撞过一次）。
 * 与 inspect 对齐到 420 秒。
 */
const CALL_TIMEOUT_MS = 420_000;

/** 右栏引文截前这么多字：标注是「一眼看到哪句话」，不是摘录全文。 */
// 引文展示长度。20 字实测读不出所以然（「文件和文件夹复选框统一放在列表项左侧；第」断开在半句里），
// 右栏宽度足够放 60 字：够看清说的是哪件事，又不至于把整段搬过来。
const QUOTE_EXCERPT = 60;

/**
 * 提示词里 PRD 正文的上限。
 *
 * 评估/走查截到 1 万字符是刻意的（它们要的是关键词与结构）；评审要的是**逐字引文**，
 * 截断会让后半份 PRD 里的真话变成「找不到的引文」——那是拿我们的预算去判模型造假。
 * 所以这里给到 12 万字符：真实 PRD（PAN-6 约 4.3 万）永远走不到上限，而它存在只是
 * 为了让一份 100 万字符的文档不会把一次调用撑爆。真截断时提示词与核对都只用**给出去的
 * 那一段**——「引文必须在 PRD 里」这句话的准确说法是「必须在你看到的 PRD 里」。
 */
export const PRD_PROMPT_MAX = 120_000;

// ─── 类型 ────────────────────────────────────────────────────────────────────

/** 一条通过核对的问题。 */
export type ReviewFinding = {
  type: ReviewFindingType;
  /** 现状证据：只有改动层面的三类有，且已拿镜像核过（`readFindings` 的硬门）。 */
  code?: { repo: string; path: string };
  /** 流程图里的节点 id（一定在 `nodes` 里，见 `readFindings`）。 */
  node: string;
  /** PRD 原文里的一句话，逐字。 */
  quote: string;
  /** 为什么这是问题（一句）。 */
  why: string;
};

/**
 * 被丢掉的一条，以及为什么。
 *
 * 为什么要留这个结构而不是只留一个计数：这一份会**原样回到提示词里**（模型要看到
 * 自己哪一句没对上），也要进 `uemaster_job_attempts.error`（人要看到这次拒收的构成）。
 * 一句「有 3 条不合格」对这两者都没用。
 */
export type FindingDrop = {
  reason: 'unknown_node' | 'quote_not_found' | 'bad_shape' | 'no_baseline' | 'code_not_found';
  /** 模型写的节点那一格（`unknown_node` 时就是它写错的原文）。 */
  node: string;
  /** 模型写的那句引文（`bad_shape` 时可能为空串）。 */
  quote: string;
  /** 一句中文，进提示词与留痕。 */
  detail: string;
};

export type ReviewStats = {
  prdVersion: string;
  prdHash: string;
  prdChars: number;
  prdTruncated: boolean;
  /** 图那一段问了几次（1..3）。 */
  flowAttempts: number;
  /** 问题清单问了几次（1..2）。 */
  findingsAttempts: number;
  /** 模型一共交回几条（含被丢的）。 */
  findingsRaw: number;
  /** 通过核对、进了材料的条数。 */
  findingsKept: number;
  /** 按类型分。 */
  counts: Record<ReviewFindingType, number>;
  /** 两轮加起来丢掉过的条目（`quote` 编造的、节点挂不上的、字段不全的）。 */
  drops: FindingDrop[];
  modelCalls: number;
  bytes: number;
  ms: number;
  usage: ComposeUsage;
};

export type ReviewOutcome = {
  url: string;
  artifactId: string;
  findings: ReviewFinding[];
  drops: FindingDrop[];
  stats: ReviewStats;
};

export type ReviewRequest = { requirementId: string; jobId?: string };

// ─── 依赖（测试注入用） ──────────────────────────────────────────────────────

/**
 * 四件事照抄 compose（同一套实现），另外几件是本文件自己的输入口。
 *
 * 为什么 `readPrd` / `latestSnapshot` / `attach` 也在这里：用例要能证明「没有快照时
 * 真的去读了」以及「零条命中时不落产物行」，而这两件事都不该靠真实网络与真实写盘。
 *
 * `grep` 与 `repoShape` 已经不在了（任务 9）：评审定位改走结构索引，那条 grep 退路
 * 已无调用者，留着它最大的害处是让「评审还有一条备用路」这句话看起来成立
 * （走查那边删掉同类型的死代码时用的是同一条理由）。
 */
export type ReviewDeps = ComposeDeps & {
  readPrd: (db: Db, actor: string, input: { requirementId: string }) => Promise<PrdReadResult>;
  latestSnapshot: (db: Db, requirementId: string) => Promise<Snapshot | null>;
  attach: typeof attachArtifact;
  /** 代码镜像：评审要先知道「现在是什么样」，才评得了「这个改动对不对」。 */
  head: typeof head;
  lsTree: typeof lsTree;
  show: typeof show;
  /** 静态索引：按索引定位（评审阶段没有可 grep 的代码，见 `locateFromStructure`）。 */
  repoIndex: (db: Db, repo: string, sha: string) => Promise<MirrorResult<BuiltIndex>>;
  /**
   * 扩展词：把标题/描述交给模型，要一组「代码里可能出现的词」。
   *
   * 可注入是因为真的那个要 provider 配置与留痕，而留痕绑在**本次作业**上（`jobId`
   * 为 null 时整条跳过）。所以 `reviewRequirement` 每次现造一个带留痕的实现，
   * 用例则注入一个假的——不发一次网。
   */
  expand?: ExpandFn;
};

/**
 * `gatherBaseline` 真正用得到的那五格。
 *
 * 为什么不让它收整个 `ReviewDeps`：那一格里有一半（图、页面片段、构建、PRD 读取）
 * 与「摸清现状」无关，而用例要能**只**摆出定位需要的东西。窄依赖也让「这一步读了
 * 什么」这件事在签名上就看得见。
 */
export type ReviewLocateDeps = {
  head: ReviewDeps['head'];
  lsTree: ReviewDeps['lsTree'];
  show: ReviewDeps['show'];
  repoIndex: ReviewDeps['repoIndex'];
  expand: ExpandFn;
};

const LIVE: ReviewDeps = {
  head, lsTree, show,
  repoIndex: (db, repo, sha) => repoIndex(db, repo, sha),
  complete,
  render: (mermaid) => renderFlowchart(mermaid),
  resolveConfig: resolveProviderConfig,
  build: (walkmap, assets) => renderWalkthrough(walkmap, assets),
  readPrd,
  latestSnapshot,
  attach: attachArtifact,
};

// ─── PRD 基线 ────────────────────────────────────────────────────────────────

export type ReviewPrd = {
  snapshot: Snapshot;
  version: string;
  /** 给模型看的那一段（正常情况就是全文）。 */
  text: string;
  chars: number;
  truncated: boolean;
};

/** 截断并**写明**截断：不写这一句，模型会以为 PRD 只有这些字。 */
export function prdForPrompt(markdown: string): { text: string; truncated: boolean } {
  if (markdown.length <= PRD_PROMPT_MAX) return { text: markdown, truncated: false };
  return { text: markdown.slice(0, PRD_PROMPT_MAX), truncated: true };
}

/**
 * 这条需求没有正式 PRD 链接时，评审材料给的那句中文（2026-11-08 裁定）。
 *
 * 一句话要说三件事：**现在缺什么**（没有正式 PRD 链接）、**为什么不能凑**（评审材料要
 * 先有 PRD——没有 PRD 的评审是照着标题在评，而它看起来像评审过）、**下一步动手做什么**
 * （在「信息 · PRD 链接」里补上，或把需求退回待设计补 PRD）。
 *
 * 只有这一份：`startGeneration`（按钮那一侧，落作业之前）与 `prdBaseline`（真正生成
 * 之前）都读它。两处各写一句，迟早出现「按钮说的修法」与「作业里说的修法」不是同一句话。
 */
export const REVIEW_NEEDS_PRD =
  '这条需求还没有正式 PRD 链接，评审材料要先有 PRD。'
  + '请在「信息 · PRD 链接」里补上，或先把需求退回待设计补 PRD。';

/**
 * 这一版 PRD 是哪一份：快照优先，没有才读。
 *
 * 「没有 PRD 就停」的顺序是硬的：**先看需求上有没有链接**，再看快照。
 * - 需求上没有链接（`prd_url` 为空）→ 直接拒绝，用 `REVIEW_NEEDS_PRD` 那句中文。
 *   这一条**不看快照**：库里留着上一版快照、链接却被清掉（或从来没补）时，接着往下
 *   走会产出一份读起来像「PRD 已经评过」的材料，而这条需求根本没有正式 PRD——
 *   那正是这条裁定要掐掉的形状；
 * - 有链接但读不下来 → `readPrd` 的原文（失败码与中文消息原样上抛，不翻译第二遍，
 *   与走查同一条口径）。
 */
async function prdBaseline(
  db: Db,
  actor: string,
  req: RequirementRow,
  deps: ReviewDeps,
): Promise<ReviewPrd> {
  if ((req.prd_url ?? '').trim() === '') {
    throw new AppError('prd_missing_url', REVIEW_NEEDS_PRD);
  }

  const latest = await deps.latestSnapshot(db, req.id);
  const snapshot = latest ?? await (async (): Promise<Snapshot> => {
    // 没有快照才去读：`readPrd` 要调企业微信 CLI（几秒 + 一次真实读盘）。
    // 有快照还去读，等于让「这一版评审的是哪一版 PRD」这件事跟着文档改动漂。
    const read = await deps.readPrd(db, actor, { requirementId: req.id });
    if (!read.ok) throw new AppError(`prd_${read.code}`, read.message);
    return read.data.snapshot;
  })();

  const markdown = snapshot.markdown;
  if (markdown.trim() === '') {
    throw new AppError('prd_empty', 'PRD 快照是空的：先重新读一次 PRD，再点评审');
  }
  const { text, truncated } = prdForPrompt(markdown);
  return {
    snapshot,
    version: prdVersionOf(markdown, snapshot.hash),
    text,
    chars: markdown.length,
    truncated,
  };
}

// ─── 提示词 2：问题清单 ──────────────────────────────────────────────────────

/** 节点清单在提示词里的那一段：`A  [页面]  进入寄养频道`。 */
function nodeLines(nodes: FlowNode[]): string[] {
  const NOUN_KIND: Record<FlowNode['kind'], string> = { process: '页面', decision: '判断', backend: '系统' };
  return nodes.map((node) => `  ${node.id}  [${NOUN_KIND[node.kind]}]  ${node.label}`);
}

/** PRD 正文那一段（含「这是全文 / 已截断」那句话）。 */
function prdBlock(prd: ReviewPrd): string[] {
  const note = prd.truncated
    ? `PRD 正文（已截断：只给你前 ${prd.text.length} 字符，全文 ${prd.chars} 字符；`
      + `后面 ${prd.chars - prd.text.length} 字符没给——引文只能从下面这段里取）`
    : `PRD 正文（全文 ${prd.chars} 字符，逐字原文）：`;
  return [note, prd.text];
}

/**
 * 提示词 2：只要一份问题清单。
 *
 * 为什么把「六类各是什么」写全而不是给六个名字：模型对 `dead_end` 的第一反应是
 * 「报错」，对 `missing_state` 的反应是「没有 loading」——两类会互相吃掉。写清判据，
 * 六类才有区分度，标题里那行「死路 2 / 缺状态 5」才可信。
 *
 * 为什么强调 quote 会被逐字核对：这句话是这份材料唯一的事实约束。不说，模型会写出
 * 「PRD 里提到要有面包屑」这种**正确但无法核对**的引文；说了，它才会去抄原文——
 * 而这个约束在 `readFindings` 里真的执行，不是为了吓唬它。
 */
// ─── 现状：评审的前提 ────────────────────────────────────────────────────────

/**
 * 评审前先摸底「现在是什么样」。
 *
 * 为什么这一步不能省：不知道现状，模型就只会挑文档措辞（歧义/缺验收），一条设计层面的
 * 意见都给不出来；更糟的是它会把「改一个已有功能」当成「做个新功能」重新设计一遍。
 * 实测就是如此——第一版评审画出来的流程是「进入PRD评审→打开PRD文档→逐步走查」，
 * 那不是产品的流程，是「做评审这件事」的流程。
 *
 * 任务 9 把取法换成了「结构检索 + 模型扩展词」（见 `locate/structure.ts` 的文件头）：
 * 评审发生在开工**之前**，代码可能压根不存在，所以不能问「历史里有没有做过」，只能问
 * 「这条需求在代码里会叫什么」。三条纪律与走查那边一字不差：
 *
 * 1. **三种结果不许合并**：读不到代码是 `absent`，读到了没有相似命名是 `none`。
 *    两句文案在 `copy.ts`，全仓一份；
 * 2. **扩展词失败即回落**：模型没配、超时、回的不是 JSON——都用 PRD 抽出来的原始关键词，
 *    评审照常出材料。**评审绝不因为「猜词的那个模型」挂了而失败**；
 * 3. **记账**（`locate_runs`，`stage: 'review'`）：一轮一条，写在**材料写出来之后**
 *    （`reviewRequirement` 末尾）。三种结果各是一个 `outcome`（`absent` / `none` / `low`），
 *    不是各记一条——分母的单位是「PM 拿到的材料数」。
 *
 * 这一段是**尽力而为**的：它的产出是材料里的一段话（`text`），不是评审的通过条件。
 */
export type Baseline = {
  /** 进提示词的现状描述（人读的几段话）。 */
  text: string;
  /**
   * 这份材料用了哪些仓库的哪个提交、那个提交是哪天的——写进标题，读者能追。
   *
   * `date` 是 2026-11-08 加的：材料顶部横幅要写「代码快照：<仓> @ <日期>」，而这一格
   * 原本只有 sha。sha 只有研发认得出，PM 要的是日期（以及「旧了」这句话）。
   */
  repos: Array<{ id: string; sha: string; date: string }>;
  /** 每个仓库 HEAD 上的路径集合，校验代码证据用。 */
  trees: Map<string, Set<string>>;
  /**
   * 这一次定位的结论（三种里的哪一种）。材料里那句话由 `renderLocate` 渲染，
   * 但结论本身也要交出去：用例与留痕要能分开断言「没读到」与「没有」，
   * 而两者的 `text` 只是一句话的差别，靠读字符串分辨迟早会被改坏。
   */
  locate: LocateResult;
};

/** 现状摘取的文件数/字节预算：够模型看出「现在怎么做的」，又不至于把仓库搬进提示词。 */
export const BASELINE_FILES = 6;
export const BASELINE_BYTES = 28_000;

/**
 * 评审要摸的两个仓。顺序就是候选清单的顺序（`locateFromStructure` 不跨仓重排）。
 *
 * 为什么写死而不是从设置里读：这两个仓是「这个产品的前端」这件事的定义，评审要的
 * 是「改动会落在哪儿」，而不是「用户在设置里填了哪些仓」。两个仓读不到都算 `absent`——
 * 一个仓没读到就出候选，等于把「半份现状」当一份交给 PM（见 `readBaselineInputs`）。
 */
export const BASELINE_REPOS = ['123pan-pc', '123pan-uni-app'] as const;

/** `gatherBaseline` 需要的全部输入，或者「为什么没读到」。 */
type BaselineInputs =
  | {
    ok: true;
    repos: Array<{ id: string; sha: string; date: string }>;
    trees: Map<string, Set<string>>;
    entries: Array<{ repo: string; index: CodeIndex }>;
  }
  | { ok: false; why: string };

/** 报错文本：`Error` 取 message，其余 `String()`——一句话能进材料就行。 */
function whyText(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error);
}

/**
 * 把「镜像 + 索引」全部拿到手；**任何一格拿不到就整段 `absent`**，并点名是哪一个仓。
 *
 * 为什么一个仓失败就整段 absent（而不是拿另一个仓的候选继续）：评审的结论只有一条
 * `LocateResult`，表达不了「pc 找到了、uni 没读到」。硬出候选的结果是材料写着
 * 「最可能的位置」，而实际上有一半代码我们没看见——这正是本仓修过两遍的那个形状
 * （失败被渲染成一个看起来正常的取值）。宁可在材料里说「代码没读到」。
 *
 * 索引**空**不算失败：那是「这个仓里没有前端文件」（后端仓），`locateAcross` 会给它
 * `source: 'grep'` 且一个候选都不贡献，最后结论是 `none`——我们确实查了，那棵树里没有。
 */
async function readBaselineInputs(db: Db, deps: ReviewLocateDeps): Promise<BaselineInputs> {
  const repos: Array<{ id: string; sha: string; date: string }> = [];
  const trees = new Map<string, Set<string>>();
  const entries: Array<{ repo: string; index: CodeIndex }> = [];

  try {
    for (const id of BASELINE_REPOS) {
      const h = await deps.head(id);
      if (!h.ok) return { ok: false, why: `${id}：${h.message}` };
      // 镜像仓已就位但一个提交都没有：没有 sha 就没有「对着哪一版代码评的」。
      if (h.data === null) return { ok: false, why: `${id}：镜像仓库还没有任何提交` };
      repos.push({ id, sha: h.data.sha, date: h.data.date });

      const tree = await deps.lsTree(id);
      if (!tree.ok) return { ok: false, why: `${id}：${tree.message}` };
      trees.set(id, new Set(tree.data));

      const indexed = await deps.repoIndex(db, id, h.data.sha);
      if (!indexed.ok) return { ok: false, why: `${id}：建结构索引失败（${indexed.message}）` };
      entries.push({ repo: id, index: indexed.data.index });
    }
  } catch (error) {
    // 镜像读口自己抛（ssh 层）也是「没读到」：消息原样带出去，PM 才有能催人的线索。
    return { ok: false, why: whyText(error) };
  }
  return { ok: true, repos, trees, entries };
}

/**
 * 需求自己的那几段话，拼成给模型的「描述」。
 *
 * 为什么是六问而不是 PRD：一次 4 秒的猜词调用里，19k 字的 PRD 既不是「描述」也买不起；
 * 六问是**需求自己的话**（提出人怎么描述这个改动），与「代码里会叫什么」最近。
 * 六格全空就是空串——手写一句话的需求在库里很常见，`expand` 那边据此整行不发描述。
 *
 * 截到 1200 字：六问每一格都可以很长，而这一层要的是「这条需求在做什么」，
 * 头几百字已经够了；再长只是把一个猜词任务变成一次阅读理解。
 */
const DESCRIPTION_MAX = 1_200;

export function descriptionOf(req: RequirementRow): string {
  const parts = [
    req.context, req.problem, req.outcome, req.surfaces, req.edge_cases, req.out_of_scope,
  ].map((part) => (part ?? '').trim()).filter((part) => part !== '');
  const text = parts.join('\n');
  return text.length <= DESCRIPTION_MAX ? text : `${text.slice(0, DESCRIPTION_MAX)}…`;
}

/**
 * 候选路径属于哪个仓。
 *
 * `Candidate` 不带 repo（那是任务 6 定的形状：跨仓清单只关心路径与理由）。索引与树来自
 * **同一个 sha**，所以路径反查仓是确定的；两个仓有同一条相对路径时取排在前面的那个——
 * 这种撞名在真实仓库里近乎不存在，而为此把候选清单拆成两份的代价（跨仓重排）更大。
 * 反查不到（索引比树旧？）就跳过：读不到正文的候选不该被当成「已经看过」。
 */
function repoOf(path: string, trees: Map<string, Set<string>>): string | null {
  for (const [id, set] of trees) {
    if (set.has(path)) return id;
  }
  return null;
}

/**
 * 摸底：结构索引上定位 → 把结论与代码片段拼成材料里那一段。**不记账**。
 *
 * 顺序是硬的：
 * 1. 读镜像 + 索引。读不到 → `absent`（**不调模型**：没有索引可搜时猜词是纯浪费）；
 * 2. 扩展词：`expandedKeywords(expand, 标题, 描述, PRD 关键词)`。任何失败都回落，
 *    一次都不重试（见 `structure.ts` 与 `expand.ts`）；
 * 3. `locateFromStructure`：结构命中一律 `low`，不重排、不跨仓比分数；
 * 4. 有候选才 `show` 正文：那几段是模型判断「与现状冲突」时唯一能引用的东西。
 *
 * **记账不在这里**（终审 Minor 4）：这一层只产出 `baseline.locate`，行由
 * `reviewRequirement` 在**材料真的写出来之后**再写。原来的写法是「先记账、后拼材料」，
 * 于是材料在 `review_empty` / `review_rejected` / `walkmap_rejected` 这几处失败时，
 * 库里仍然留着一条记录——而 `locate_runs` 是算准确率的分母，那一行指向的是一份
 * 从来没存在过的材料。挪到最后之后，「有行必有材料」是结构上成立的，不靠注释保证。
 *
 * 返回 `Baseline` 而不是 `Baseline | null`：以前的 `null` 表示「镜像没配」，材料里那句
 * 「这次没有代码现状可参考」把「没读到」与「没配」混成了一句。现在读不到就是 `absent`，
 * 材料里由 `ABSENT_LINE`（代码没读到，`origin: 'code'`）指名原因——而 `repos` 为空时
 * 标题仍写「未参考代码现状」，
 * 这一句照样诚实。
 */
export async function gatherBaseline(
  prd: ReviewPrd,
  req: RequirementRow,
  deps: ReviewLocateDeps,
  db: Db,
): Promise<Baseline> {
  const inputs = await readBaselineInputs(db, deps);

  if (!inputs.ok) {
    // 代码本身没读到：`renderLocate` 用默认的 `origin: 'code'`，第一句是「代码没读到」。
    const located: LocateResult = { kind: 'absent', why: inputs.why };
    return { text: renderLocate(located), repos: [], trees: new Map(), locate: located };
  }

  // 回落值取**全量** markdown，不是提示词里那份截断过的 `prd.text`：关键词只要词，
  // 而 PRD 后半段里的词对定位一样有用。
  const fallback = keywordsFrom(prd.snapshot.markdown, req.title);
  const keywords = await expandedKeywords(deps.expand, req.title, descriptionOf(req), fallback);
  const located = locateFromStructure(inputs.entries, keywords, { limit: BASELINE_FILES });

  const repoLine = `现状基线：${inputs.repos
    .map((r) => `${r.id}@${r.sha.slice(0, 8)}（${r.date.slice(0, 10)}）`).join(' / ')}`;

  // `none`：读到了、没有相似命名。这一句与 `absent` 必须长得不一样（`copy.ts`）。
  // `absent` 走不到这里——读不到代码时 `readBaselineInputs` 已经整段返回了；类型上它还在
  // 联合里，所以一并按结论渲染：不抛（评审不该因为一个不该发生的分支失败），也不假装有候选。
  if (located.kind !== 'candidates') {
    const text = `${renderLocate(located)}\n${repoLine}`;
    return {
      text,
      repos: inputs.repos.map(({ id, sha, date }) => ({ id, sha, date })),
      trees: inputs.trees,
      locate: located,
    };
  }

  // 有候选：把候选文件的正文读出来。预算与旧路径相同（`BASELINE_BYTES` / 每个 6KB），
  // 只是候选从哪来换了——旧路径是 grep 打分，现在是结构索引。
  const chunks: string[] = [];
  let left = BASELINE_BYTES;
  for (const item of located.items) {
    if (left <= 0) break;
    const repo = repoOf(item.path, inputs.trees);
    if (repo === null) continue;
    const body = await deps.show(repo, item.path, { maxBytes: Math.min(left, 6_000) });
    if (!body.ok) continue;
    left -= body.data.length;
    chunks.push(`【${repo}:${item.path}】\n${body.data}`);
  }

  const text = [
    // 这里的第一行永远是那三句结论之一（`copy.ts`）——**这是提示词文本**，读者是模型，
    // 它先看到「这是什么结论」，再看到「对着哪一版代码」和片段。PM 在产物里看到的
    // 第一行不是这段文字，而是 `injectBanner` 写死的横幅（同一个 `renderLocate`，
    // 但由代码插入，见 `locate/banner.ts`）。
    renderLocate(located),
    repoLine,
    ...(chunks.length === 0
      ? []
      : ['', '下面是这些位置**现在**的样子（从代码镜像只读取出，未经修改）：', '', ...chunks]),
  ].join('\n');
  return {
    text,
    repos: inputs.repos.map(({ id, sha, date }) => ({ id, sha, date })),
    trees: inputs.trees,
    locate: located,
  };
}

export function findingsPrompt(req: RequirementRow, prd: ReviewPrd, nodes: FlowNode[], baseline: Baseline | null = null): string {
  return [
    '你是需求评审助手。任务：照着这份 PRD 逐条读出「走不通、说不清」的地方，产出一份问题清单。',
    '',
    '这次的对象：',
    `  · 编号：PAN-${req.number}`,
    `  · 标题：${flat(req.title)}`,
    `  · 类型：${typeLabel(req.type)}　提出人：${flat(req.requester)}`,
    '  · 材料是「评审材料」：把 PRD 完整走一遍——评审就是照着它一步一步过，走不通的地方要看得出来。',
    '',
    ...prdBlock(prd),
    '',
    ...(baseline === null
      ? ['（这次没有代码现状可参考：只就 PRD 自身评，不要臆测现在是怎么做的。）', '']
      : [baseline.text, '']),
    '流程图已经定稿，节点清单（id / 形态 / 文案）：',
    ...nodeLines(nodes),
    '',
    '要交的东西：**一个** JSON 对象（不要代码围栏、不要解释），只有一个键 findings：',
    '{',
    '  "findings": [',
    '    { "type": "dead_end", "node": "C", "quote": "PRD 原文里的一句话", "why": "为什么这是问题（一句）" }',
    '    { "type": "conflicts_current", "node": "B", "quote": "…", "why": "…",',
    '      "code": { "repo": "123pan-pc", "path": "src/pages/Share/Search.tsx" } }',
    '  ]',
    '}',
    '',
    'type 只能是这六个，逐条对应（选最贴切的那一类，不要自造）：',
    '  dead_end      死路：走到这一步之后没有出口——没有下一步、没有返回、失败也没有去处。',
    '  no_screen     无页面步骤：流程里有这一步，PRD 却没给承接它的页面或状态。',
    '  missing_state 缺状态：只写了正常流程，加载中 / 空 / 失败 / 进行中 / 无权限没定义。',
    '  ambiguous     歧义：同一个词在 PRD 里指两样东西，或一句话有两个读法。',
    '  no_acceptance 缺验收口径：写了要做什么，但没写怎么算做到了——没有可验的判据。',
    '  unbounded     边界未定：数量、长度、并发、角色、权限、时间窗没定，实现只能靠猜。',
    '',
    '下面三类**必须用到上面的现状代码**才写得出来。写这三类时，除了 quote，还要给 code：',
    '  conflicts_current   与现状冲突：PRD 要的改法会推翻现有的行为/习惯——说清现在是什么。',
    '  misses_current_edge 漏了现状的边界：现有实现已经处理了某种情况（权限、空、失败），',
    '                      PRD 改版后没交代它还成不成立。',
    '  no_migration        没说怎么迁移：现在就有数据/历史/老入口，改了之后旧的怎么办没写。',
    '  这三类的 code 形如 { "repo": "123pan-pc", "path": "src/pages/x.ts" }，',
    '  path 必须是上面现状里**出现过的**那个文件（我们会逐条核，编的整条丢掉）。',
    '  没有可指的现状文件时，不要用这三类。',
    '',
    '硬性要求（逐条会被机器核对）：',
    ' 1. quote 必须是 PRD 原文里的一整句，**逐字复制**。我们会把它和 PRD 正文逐字比对',
    '    （只忽略空白与标点）：对不上的那一条会整条丢掉。不要改写、不要拼接两处、',
    '    不要总结成你自己的话。',
    ' 2. node 必须是上面清单里的 id（一个字母）。问题指不到具体节点时，选它最接近的那一个。',
    ' 3. 最多 12 条。只报**这份 PRD 里真的缺的**东西：PRD 已经写了的不要报成问题。',
    ' 4. 不要写功能建议、不要写「建议补充」这类客套话：why 一句话说清为什么这是问题。',
    ' 5. 全部中文。只输出 JSON 本身：第一个字符是 {，最后一个字符是 }。',
  ].join('\n');
}

/**
 * 修复提示词：上一版原文 + **哪几条没通过、为什么** + 规则再来一遍。
 *
 * 为什么要把 PRD 全文再贴一次：接口是无状态的，模型看不到上一轮的输入。不贴，
 * 它就只能靠记忆重写引文——而那正是被丢掉的原因。宁可多花一份输入 token，
 * 也不要拿一次调用换一份「改得更假」的清单。
 */
export function findingsRepairPrompt(
  req: RequirementRow,
  prd: ReviewPrd,
  nodes: FlowNode[],
  previous: string,
  problems: { drops: FindingDrop[]; why: string },
): string {
  const trimmed = previous.trim();
  const shown = trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}…` : trimmed;
  const reasons: string[] = [];
  for (const drop of problems.drops.slice(0, MAX_FINDINGS)) {
    reasons.push(`  · ${drop.detail}`);
  }
  if (reasons.length === 0) reasons.push(`  · ${problems.why}`);

  return [
    `上一版的问题清单没有过核对（PAN-${req.number}「${flat(req.title)}」评审材料）。请重发完整的清单。`,
    '',
    '上一版原文：',
    shown === '' ? '（空）' : shown,
    '',
    problems.drops.length === 0
      ? '没通过的原因：'
      : `这些条目被丢掉了（${problems.drops.length} 条），原因逐条在下面：`,
    ...reasons,
    '',
    ...prdBlock(prd),
    '',
    '节点清单（id / 形态 / 文案，node 只能取这里的 id）：',
    ...nodeLines(nodes),
    '',
    '重发**完整**的 JSON，形状不变：',
    '{"findings":[{"type","node","quote","why"}]}',
    '  · quote 逐字从上面的 PRD 原文复制，一个字都不改（会被逐字核对）；',
    '  · node 只能取上面清单里的 id；type 只能取那六个英文值之一；',
    '  · 最多 12 条，全部中文，只输出 JSON 本身。',
  ].join('\n');
}

// ─── 回话的解析与三条核对 ────────────────────────────────────────────────────

const TYPES = [
  'dead_end', 'no_screen', 'missing_state', 'ambiguous', 'no_acceptance', 'unbounded',
  'conflicts_current', 'misses_current_edge', 'no_migration',
] as const;

/** 需要现状代码支撑的三类：它们必须带 `code`，且 `code.path` 必须在镜像里存在。 */
const NEEDS_CODE = new Set<ReviewFindingType>(['conflicts_current', 'misses_current_edge', 'no_migration']);

const CodeRefSchema = z.object({
  repo: z.string().default(''),
  path: z.string().min(1),
}).passthrough();

const FindingSchema = z.object({
  type: z.preprocess(normalizeFindingType, z.enum(TYPES)),
  node: z.string().min(1),
  quote: z.string().min(1),
  why: z.string().min(1),
  /** 现状证据：`conflicts_current` / `misses_current_edge` / `no_migration` 必须有。 */
  code: CodeRefSchema.optional(),
});

/** 一行文字里去掉会被构建器拒掉的 emoji（PRD 原文里真的有）。 */
function safeText(text: string): string {
  const bad = new Set(findEmoji(text));
  if (bad.size === 0) return text;
  return [...text].filter((ch) => !bad.has(ch)).join('');
}

/**
 * 逐字核对用的归一化：两边走同一套。
 *
 * 为什么不是直接 `includes`：PRD 是 Markdown 表格，同一句话在原文里可能是
 * `| 全链接搜索 | 在当前分享链接内搜索全部文件和文件夹 |`，而模型抄出来的是
 * 「在当前分享链接内搜索全部文件和文件夹」——没有表格线、没有多余空格。**这是同一句话**，
 * 用原样字串判会把它判成编造。所以两边都：压掉空白（含全角空格）、去掉 markdown
 * 强调符与引用符、去掉中英文标点与引号，再判子串。
 *
 * 这条放宽的方向是**格式**，不是内容：只要模型换了词、改了语序、拼接了两处，
 * 归一化之后就一定对不上。这正是我们要拦的那一种。
 */
export function normalizeQuote(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[*_`~>#]/g, '')                 // markdown 强调 / 代码 / 引用 / 标题符
    .replace(/[\s\u3000]+/g, '')              // 空白（含全角空格）整个去掉
    .replace(/[「」『』“”‘’"']/g, '')          // 各种引号
    .replace(/[，。、；：？！,.;:?!—–\-…·|/\\()[\]{}【】]/g, '')
    .toLowerCase();
}

/** 这句话在 PRD 里吗（归一化之后）。空引文一律算找不到：`includes('')` 永远为真。 */
export function quoteInPrd(quote: string, prd: string): boolean {
  const needle = normalizeQuote(quote);
  if (needle === '') return false;
  return normalizeQuote(prd).includes(needle);
}

/** 模型写节点的那一格：`"C"`、`"节点 C"`、`"C（选择宠物）"` 都是同一个节点。 */
const NODE_PREFIX = /^(?:节点|node|step)\s*[:：]?\s*/i;

function matchNode(raw: string, ids: readonly string[]): string | null {
  const text = raw.trim().replace(NODE_PREFIX, '').replace(/^[「『"'（(]+/, '').trim();
  if (ids.includes(text)) return text;
  // `A 进入寄养频道` / `A（选择宠物）`：取开头那个 id。
  const head = /^([A-Za-z0-9_]+)/.exec(text)?.[1];
  if (head !== undefined && ids.includes(head)) return head;
  return null;
}

export type FindingsRead =
  | { ok: true; findings: ReviewFinding[]; dropped: FindingDrop[]; raw: number }
  | { ok: false; why: string };

/**
 * 读一份问题清单：JSON 抠得出来 + 形状认得 + **三条核对**（类型 / 节点 / 引文）。
 *
 * 三条核对的失败语义刻意不同：
 * - `type` 认不出来：`normalizeFindingType` 先试收（中文标签、近义写法），收不回来
 *   才算 `bad_shape`——它是「这条问题归哪一类」说不清，不是问题本身不存在。
 * - `node` 不在流程图里：丢。理由与 `dropUnknownNodes` 一致：挂不到节点上的问题，
 *   右栏没有位置可放，零信息。
 * - `quote` 在 PRD 里找不到：丢。这一条是这份材料的**事实底座**——模型编一句
 *   「PRD 要求支持面包屑」太容易了，而它一句话就能被证伪。
 *
 * 丢掉的每一条都写进 `dropped`（带一句中文），它要回提示词，也要进留痕。
 * 重复条目（同 type + node + quote）静默去重：那是同一句话写了两遍，不是造假，
 * 也不该为它烧一轮修复。
 */
export function readFindings(
  text: string,
  nodeIds: readonly string[],
  prd: string,
  baseline: Baseline | null = null,
): FindingsRead {
  // 截断要在解析之前认：截断的 JSON 会让 extractJson 退到内层对象，报成「缺字段」。
  if (answerTruncated(text)) return { ok: false, why: noJsonReason(text, FINDINGS_MAX_TOKENS) };
  const raw = extractJson<unknown>(text);
  if (raw === null) return { ok: false, why: noJsonReason(text, FINDINGS_MAX_TOKENS) };

  // 与两条老路共用同一层形状容错：顶层写成裸数组（只有 findings）也收——`coerceRoot`
  // 认识这种形状；它顺手把 `results` 之类别名改回 findings。
  const coerced = coerceAnswer(raw) as Record<string, unknown>;
  const list = coerced === null || typeof coerced !== 'object' ? null : coerced['findings'];
  if (!Array.isArray(list)) return { ok: false, why: 'JSON 里没有 findings 数组（顶层只该有这一个键）' };

  const findings: ReviewFinding[] = [];
  const dropped: FindingDrop[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    const parsed = FindingSchema.safeParse(item);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue === undefined ? '结构不对' : `${issue.path.join('.') || '(根)'}：${issue.message}`;
      const bag = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
      dropped.push({
        reason: 'bad_shape',
        node: typeof bag['node'] === 'string' ? bag['node'] : '',
        quote: typeof bag['quote'] === 'string' ? bag['quote'] : '',
        detail: `这条的字段不完整或类型不在六类里（${where}）`,
      });
      continue;
    }

    const node = matchNode(parsed.data.node, nodeIds);
    if (node === null) {
      dropped.push({
        reason: 'unknown_node',
        node: parsed.data.node,
        quote: parsed.data.quote,
        detail: `节点「${parsed.data.node}」不在流程图里（流程图只有 ${nodeIds.join(' / ')}）：`
          + '挂不到节点上的问题进不了这份材料',
      });
      continue;
    }

    if (!quoteInPrd(parsed.data.quote, prd)) {
      const shown = parsed.data.quote.replace(/\s+/g, ' ').trim();
      const short = shown.length > 30 ? `${shown.slice(0, 30)}…` : shown;
      dropped.push({
        reason: 'quote_not_found',
        node,
        quote: parsed.data.quote,
        detail: `引文「${short}」在 PRD 里找不到（可能是改写、总结，或者两处拼成了一句）——`
          + 'quote 必须逐字复制原文',
      });
      continue;
    }

    // 改动层面的三类必须带现状证据：没有代码支撑的「与现状冲突」就是空口断言。
    if (NEEDS_CODE.has(parsed.data.type)) {
      const code = parsed.data.code;
      const hasTree = baseline !== null && baseline.trees.size > 0;
      if (!hasTree) {
        dropped.push({
          reason: 'no_baseline',
          node,
          quote: parsed.data.quote,
          detail: `这一条是「${REVIEW_TYPE_LABEL[parsed.data.type]}」，但这次没有代码现状可核：`
            + '不知道现在怎么做的，就无从判断它跟现状冲突',
        });
        continue;
      }
      if (code === undefined) {
        dropped.push({
          reason: 'no_baseline',
          node,
          quote: parsed.data.quote,
          detail: `「${REVIEW_TYPE_LABEL[parsed.data.type]}」必须给 code（现在那个文件在哪）：`
            + '没有代码证据的现状判断不进这份材料',
        });
        continue;
      }
      // repo 没写全就按路径唯一命中的那个仓反推（与走查同一口径）。
      let repo = code.repo;
      if (repo === '' || !baseline!.trees.has(repo)) {
        const hits = [...baseline!.trees.entries()].filter(([, set]) => set.has(code.path)).map(([id]) => id);
        if (hits.length === 1) repo = hits[0]!;
      }
      const tree = baseline!.trees.get(repo);
      if (tree === undefined || !tree.has(code.path)) {
        dropped.push({
          reason: 'code_not_found',
          node,
          quote: parsed.data.quote,
          detail: `代码证据「${code.repo}:${code.path}」在镜像里找不到：`
            + 'code.path 必须是现状里真实存在的文件',
        });
        continue;
      }
      parsed.data.code = { repo, path: code.path };
    } else if (parsed.data.code !== undefined) {
      // 文档类不需要代码证据；给了也不采信（避免读者以为它被核过）。
      parsed.data.code = undefined;
    }

    const key = `${parsed.data.type}|${node}|${normalizeQuote(parsed.data.quote)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      type: parsed.data.type,
      node,
      quote: parsed.data.quote.replace(/\s+/g, ' ').trim(),
      why: parsed.data.why.replace(/\s+/g, ' ').trim(),
      ...(parsed.data.code === undefined ? {} : { code: parsed.data.code }),
    });
  }

  return { ok: true, findings, dropped, raw: list.length };
}

// ─── 标题与右栏标注 ──────────────────────────────────────────────────────────

/** 按类型计数（六类全给 0，缺的显示成 0 但标题里会过滤掉）。 */
export function countByType(findings: ReviewFinding[]): Record<ReviewFindingType, number> {
  const out = {
    dead_end: 0, no_screen: 0, missing_state: 0, ambiguous: 0, no_acceptance: 0, unbounded: 0,
    conflicts_current: 0, misses_current_edge: 0, no_migration: 0,
  } satisfies Record<ReviewFindingType, number>;
  for (const finding of findings) out[finding.type] += 1;
  return out;
}

/**
 * 标题里那一段「死路 2 / 缺状态 5 / 歧义 5」：只列**有的**那几类，顺序固定。
 *
 * 固定顺序不是洁癖：这一行是给人横向比的（「这条需求的毛病偏在哪一类」），顺序一跳，
 * 两份材料就不能并排看了。
 */
export function listCounts(findings: ReviewFinding[]): Array<[string, number]> {
  const counts = countByType(findings);
  return REVIEW_TYPE_ORDER
    .filter((type) => counts[type] > 0)
    .map((type) => [REVIEW_TYPE_LABEL[type], counts[type]] as [string, number]);
}

/**
 * 材料标题：`PAN-6「…」评审材料 · PRD v1.4 · 12 处：死路 2 / 缺状态 5 / 歧义 5`。
 *
 * 为什么把版本与分布写进标题：这一页会被截图发出去，而「这是哪一版 PRD 的评审」
 * 与「一共几处、都偏在哪一类」是那张图里最先被问的两件事。只写「评审材料」的标题，
 * 截图离开上下文之后就什么都不是了。
 */
export function reviewTitle(
  req: RequirementRow,
  prdVersion: string,
  findings: ReviewFinding[],
  baseline: Baseline | null = null,
): string {
  const parts = listCounts(findings).map(([label, n]) => `${label} ${n}`);
  // 基线写进标题：这一页会被截图发出去，「对着哪一版代码评的」必须留在图上。
  // 没有镜像时写「未参考代码现状」——那是一句**诚实**的话，不是免责声明。
  const base = baseline === null || baseline.repos.length === 0
    ? '未参考代码现状'
    : baseline.repos.map((r) => `${r.id}@${r.sha.slice(0, 8)}`).join(' / ');
  return `PAN-${req.number}「${flat(req.title)}」评审材料 · PRD ${prdVersion} · `
    + `${findings.length} 处：${parts.join(' / ')} · ${base}`;
}

/**
 * 一个节点的右栏标注。
 *
 * - 有问题的节点：一条问题一行，`[类型中文, "…（PRD：<引文前 20 字>）"]`。右栏就这么宽，
 *   引文只够放一句开头；要看全文去 PRD。
 * - **没问题的节点也要有一行**：`["无问题", "这一步没挑出问题"]`。空白标注在评审里是两个
 *   意思——「查过、没毛病」和「漏了没查」，读者分不出来。写上这一行，分不出来就消失了。
 */
export function findingsAnno(own: ReviewFinding[]): Anno[] {
  if (own.length === 0) return [['无问题', '这一步没挑出问题']];
  return own.map((finding): Anno => {
    const head = [...finding.quote].slice(0, QUOTE_EXCERPT).join('');
    const where = finding.code === undefined ? '' : `（现在：${finding.code.path}）`;
    const row: [string, string] = [
      REVIEW_TYPE_LABEL[finding.type],
      safeText(`「${head}」——${finding.why}${where}`),
    ];
    return row;
  });
}

/**
 * 把问题清单写进 walkmap：标题换成带版本与分布的那一句，每个节点的 `anno` 换成它自己的问题。
 *
 * 为什么在这里改而不是在提示词里让模型写：右栏的每一行都必须能追到一句 PRD 原文，
 * 而那句原文是**我们核过的**。让模型顺手把标注也写了，等于把刚核过的东西再交给它写一遍。
 * 页面片段（`wt-*` 的 HTML）仍然由模型画，一个字都不动——版式与内容是两件事。
 */
export function annotateWalkmap(
  walkmap: Walkmap,
  nodes: FlowNode[],
  findings: ReviewFinding[],
  title: string,
): Walkmap {
  const byNode = new Map<string, ReviewFinding[]>();
  for (const finding of findings) {
    const list = byNode.get(finding.node);
    if (list === undefined) byNode.set(finding.node, [finding]);
    else list.push(finding);
  }

  const mapped: Record<string, WalkmapNode> = {};
  for (const [id, meta] of Object.entries(walkmap.nodes)) {
    // 只改流程节点自己的标注；walkmap 里若还有别的 id（理论上没有），保留原样。
    const own = nodes.some((node) => node.id === id) ? findingsAnno(byNode.get(id) ?? []) : meta.anno;
    mapped[id] = { ...meta, anno: own };
  }
  // 默认停在哪一步：**第一条有问题的步骤**，不是流程图的第一节点。
  // 实测：模型把 12 条全挂在同一个节点上，打开产物却停在写着「无问题」的 A，
  // 第一眼像是没评审过——评审材料最不该给人的就是这个印象。
  const firstWithFindings = nodes.find((node) => (byNode.get(node.id) ?? []).length > 0)?.id;
  const defaultNode = firstWithFindings ?? walkmap.default_node;
  return { ...walkmap, title, default_node: defaultNode, nodes: mapped };
}

// ─── 主流程：问题清单 ────────────────────────────────────────────────────────

/** 被丢掉的那些条目压成一句中文（进 `attempts.error`，也进最终失败消息）。 */
export function dropsText(drops: FindingDrop[]): string {
  const byReason = new Map<FindingDrop['reason'], number>();
  for (const drop of drops) byReason.set(drop.reason, (byReason.get(drop.reason) ?? 0) + 1);
  const LABEL: Record<FindingDrop['reason'], string> = {
    unknown_node: '挂在流程图之外的节点上',
    quote_not_found: '引文在 PRD 里找不到',
    bad_shape: '字段不完整或类型不在九类里',
    no_baseline: '说是改动问题，却没给出代码现状',
    code_not_found: '给的代码文件在镜像里不存在',
  };
  const parts = [...byReason.entries()].map(([reason, n]) => `${n} 条${LABEL[reason]}`);
  return parts.join('、');
}

async function collectFindings(
  cfg: ProviderConfig,
  req: RequirementRow,
  prd: ReviewPrd,
  nodes: FlowNode[],
  baseline: Baseline | null,
  deps: ReviewDeps,
  usage: ComposeUsage,
  trace: Trace,
): Promise<{
  findings: ReviewFinding[];
  drops: FindingDrop[];
  raw: number;
  attempts: number;
  usage: ComposeUsage;
}> {
  const ids = nodes.map((node) => node.id);
  let prompt = findingsPrompt(req, prd, nodes, baseline);
  let spent = usage;

  /** 第一轮活下来的（第二轮整个坏掉时用它——它已经过过一次全量核对）。 */
  let firstSurvivors: ReviewFinding[] | null = null;
  let firstDrops: FindingDrop[] = [];
  let raw = 0;
  /**
   * 这一次评审**一共**丢掉过哪些条目（两轮相加）。
   *
   * 为什么不是只留最后一轮：被丢掉的条目正是这份材料最该被追问的地方——「模型编了
   * 几句 PRD 里没有的话」这个数字不会因为第二轮修好了就消失，它要进报告、进留痕。
   */
  const allDrops: FindingDrop[] = [];

  let chosen: { findings: ReviewFinding[]; drops: FindingDrop[] } | null = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= FINDINGS_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    const started = Date.now();
    const reply = await deps.complete(cfg, prompt, {
      maxTokens: FINDINGS_MAX_TOKENS,
      timeoutMs: CALL_TIMEOUT_MS,
    });
    const ms = Date.now() - started;
    // 接口层的失败**不消耗**修复次数，也不改写：它不是「清单不好」，重试也不会变好。
    // 但它是**一次要留的痕**：`output_chars: 0` + 服务端原文。
    if (!reply.ok) {
      await trace.write({
        attempt, phase: 'findings', promptChars: prompt.length, outputChars: 0, error: reply.error, ms,
      });
      throw new AppError('provider_error', reply.error);
    }
    spent = addUsage(spent, reply.usage);

    const read = readFindings(reply.text, ids, prd.text, baseline);
    if (!read.ok) {
      await trace.write({
        attempt, phase: 'findings', promptChars: prompt.length, outputChars: reply.text.length,
        error: read.why, ms,
      });
      if (attempt === FINDINGS_ATTEMPTS) {
        chosen = firstSurvivors !== null && firstSurvivors.length > 0
          ? { findings: firstSurvivors, drops: firstDrops }
          : { findings: [], drops: [] };
        break;
      }
      prompt = findingsRepairPrompt(req, prd, nodes, reply.text, { drops: [], why: read.why });
      continue;
    }

    raw = read.raw;
    allDrops.push(...read.dropped);
    if (attempt === 1) {
      firstSurvivors = read.findings;
      firstDrops = read.dropped;
    }

    const empty = read.findings.length === 0;
    await trace.write({
      attempt,
      phase: 'findings',
      promptChars: prompt.length,
      outputChars: reply.text.length,
      // 通过的那一次 error 为 null；被拒时写的是「怎么被拒的」——这一轮的构成，
      // 也就是抽屉里要回答的那个问题。
      error: empty
        ? `一条都没通过核对：${dropsText(read.dropped) || '回话里没有可用的条目'}`
        : (read.dropped.length === 0 ? null : `丢掉 ${read.dropped.length} 条：${dropsText(read.dropped)}`),
      ms,
    });

    // 没有丢任何东西 = 这一份就是最终答案，不必再花一次调用。
    if (!empty && read.dropped.length === 0) {
      chosen = { findings: read.findings, drops: read.dropped };
      break;
    }

    if (attempt === FINDINGS_ATTEMPTS) {
      // 最后一轮也还有被丢的：接受活下来的那些。第二轮**一条都没有**时退回第一轮
      // 活下来的那份——它已经过过一次全量核对，比一份空清单更接近事实。
      const survivors = firstSurvivors !== null && firstSurvivors.length > 0 ? firstSurvivors : [];
      chosen = empty
        ? { findings: survivors, drops: read.dropped.length > 0 ? read.dropped : firstDrops }
        : { findings: read.findings, drops: read.dropped };
      break;
    }

    // 有东西被丢掉（或一条都没活下来）：把「哪几条、为什么」原样回给模型，问一次。
    prompt = findingsRepairPrompt(req, prd, nodes, reply.text, {
      drops: read.dropped,
      why: empty ? '一条都没通过核对' : '',
    });
  }

  const final = chosen ?? { findings: firstSurvivors ?? [], drops: firstDrops };
  return {
    findings: final.findings.slice(0, MAX_FINDINGS),
    drops: allDrops.length > 0 ? allDrops : final.drops,
    raw,
    attempts,
    usage: spent,
  };
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

/**
 * 把一条需求做成一一份**读过 PRD** 的评审材料：PRD → 图 → 问题清单 → 页面片段 → 标注改写
 * → `build.py` 出 HTML → 写文件 → `attachArtifact(stage: 'review')`。
 *
 * 顺序是硬的，而且每一段失败都说清是哪一段：
 * 1. 配置（没有就点名缺哪一格）→ 需求行 → PRD 基线（快照优先，没有才读）；
 * 2. 图：**复用** `buildFlow`（同一份 `flowPrompt(req,'review')`、同一套形状判据）；
 * 3. 问题清单：问一次、核三条；有被丢的就带着原文再问一次；一条都不剩就失败；
 * 4. 页面片段：**复用** `buildPages`（同一版式），然后把它交的标注整片换成问题清单；
 * 5. 构建与 attach。写文件在 attach 之前（`attachArtifact` 会 stat 站内链接）。
 */
export async function reviewRequirement(
  db: Db,
  actor: string,
  request: ReviewRequest,
  deps: Partial<ReviewDeps> = {},
): Promise<ReviewOutcome> {
  const started = Date.now();
  const requirementId = parseRequirementId({ requirementId: request.requirementId });
  const full: ReviewDeps = { ...LIVE, ...deps };

  // 配置先于一切：没有 key 就没有这条路（`start.ts` 也按它选路）。
  const cfg = await full.resolveConfig();
  if (cfg === null) throw new AppError('provider_unconfigured', missingProviderText());

  const req = await loadRequirement(db, requirementId);
  // 与 compose 同一条规矩：指纹在读需求的这一刻取，不等到 attach（那时描述可能已经变了）。
  const inputHash = fingerprintOfRow(req);
  const prd = await prdBaseline(db, actor, req, full);

  let usage: ComposeUsage = { prompt: 0, completion: 0 };
  const trace = makeTrace(db, request.jobId ?? null, cfg.model);

  // 数一次一共问了几次模型：三段各自的 attempts 只有自己那一段的，而「这份材料花了
  // 几次调用」是报告与留痕都要用的数字。包一层 `complete` 是唯一不往 compose 里
  // 加参数的做法——`buildPages` 本来就不返回次数（它只关心过没过）。
  let calls = 0;
  const counted: ReviewDeps = {
    ...full,
    complete: (config, prompt, opts) => {
      calls += 1;
      return full.complete(config, prompt, opts);
    },
  };

  // ── 图：与评估材料同一段实现（判据只能有一份） ──
  const flow = await buildFlow(cfg, req, 'review', counted, usage, trace);
  usage = flow.usage;
  const svg = flow.check.svg ?? '';
  // 节点清单只解析一次：提示词 2、提示词 3、标注改写三处都用它，三处不会漂。
  const nodes = parseFlow(flow.mermaid).nodes;

  // ── 现状：先摸清「现在是什么样」，才评得了「这个改动对不对」 ──
  // 任务 9：结构索引上定位 + 模型扩展词。扩展词这一段是**尽力而为**的——
  // 没配模型、超时、回的不是 JSON 都只用 PRD 的原始关键词，评审照样出材料；
  // 失败原因写进 `uemaster_job_attempts` 的 `locate` 行（走 `trace`，与走查同一个阶段名）。
  const expand: ExpandFn = full.expand ?? createExpand({
    // 走 `counted` 而不是 `full.complete`：这是一次真实的模型调用，`stats.modelCalls` 要数它。
    complete: counted.complete,
    resolveConfig: full.resolveConfig,
    onAttempt: async (record) => {
      await trace.write({
        attempt: 1,
        phase: 'locate',
        promptChars: record.promptChars,
        outputChars: record.outputChars,
        error: record.error,
        ms: record.ms,
      });
    },
  });
  const baseline = await gatherBaseline(prd, req, {
    head: counted.head,
    lsTree: counted.lsTree,
    show: counted.show,
    repoIndex: counted.repoIndex,
    expand,
  }, db);

  // ── 问题清单 ──
  const found = await collectFindings(cfg, req, prd, nodes, baseline, counted, usage, trace);
  usage = found.usage;
  if (found.findings.length === 0) {
    throw new AppError(
      'review_empty',
      `评审一条可信的问题都没挑出来：${dropsText(found.drops) || '回话里没有可用的条目'}。`
        + '空的问题清单不是通过——这份评审没做成',
    );
  }

  // ── 页面片段：同一版式 ──
  const title = reviewTitle(req, prd.version, found.findings, baseline);
  const pages = await buildPages(cfg, req, 'review', nodes, { svg }, counted, usage, trace);
  usage = pages.usage;

  // 标注整片换成问题清单，再验一次：`anno` 是我们拼的，所以这一层是「我们自己没写错」。
  const walkmap = annotateWalkmap(pages.assembly.walkmap, nodes, found.findings, title);
  const report = validateWalkmap(walkmap, { svg, fragments: pages.assembly.fragments });
  if (!report.ok) {
    throw new AppError('review_rejected', `评审材料的标注没过校验：${report.errors.join('；')}`);
  }

  const buildStarted = Date.now();
  const built: BuildResult = await full.build(walkmap, { svg, fragments: pages.assembly.fragments });
  // 构建也要留痕：它是唯一一段「模型都对、产物还是出不来」的失败（Traceback、emoji、契约不符）。
  await trace.write({
    attempt: 1,
    phase: 'build',
    promptChars: 0,
    outputChars: built.html?.length ?? 0,
    error: built.ok && built.html !== undefined ? null : (built.error ?? built.errors.join('；')),
    ms: Date.now() - buildStarted,
  });
  if (!built.ok || built.html === undefined) {
    throw new AppError('walkmap_rejected', `评审材料构建失败：${built.error ?? built.errors.join('；')}`);
  }

  const file = path.join(ARTIFACT_ROOT, `PAN-${req.number}`, 'review.html');
  await mkdir(path.dirname(file), { recursive: true });
  // 横幅在**写盘之前**插（终审 Blocker 2）：那几句话原本只进提示词，材料里一个字都不带，
  // 于是落 `absent` 时 PM 只看到标题里一句「未参考代码现状」，`why`（唯一能拿去催人的
  // 线索）丢了。这一段由代码写死、模型不参与——模型正文里提没提它都一样。
  // 横幅 = 结论 + 「代码快照」：一句话说清「这是对着哪一版代码评的」，旧了就写旧
  // （`withSnapshots`，措辞在 `copy.ts`）。没有仓可写时它原样返回结论——那时结论本身
  // 就是「代码没读到」。
  const html = injectBanner(built.html, withSnapshots(renderLocate(baseline.locate), baseline.repos));
  await writeFile(file, html, 'utf8');

  const url = artifactUrl(file);
  const artifact = await full.attach(db, actor, {
    requirementId, stage: 'review', url, inputHash,
  });

  // 记账放在**材料写出来之后**（终审 Minor 4）。这一行描述的是「PM 真拿到了一份材料」，
  // 而 `locate_runs` 是算准确率的分母：`review_empty` / `review_rejected` /
  // `walkmap_rejected` 那几处失败都不会走到这里，所以「有行必有材料」不是靠注释，
  // 是靠位置。`recordLocate` 失败照旧往上抛（那是库坏了，与材料无关，更不许静默少一条）。
  await recordLocate(db, { requirementId: req.id, stage: 'review', result: baseline.locate });

  const counts = countByType(found.findings);
  return {
    url,
    artifactId: artifact.id,
    findings: found.findings,
    drops: found.drops,
    stats: {
      prdVersion: prd.version,
      prdHash: prd.snapshot.hash,
      prdChars: prd.chars,
      prdTruncated: prd.truncated,
      flowAttempts: flow.attempts,
      findingsAttempts: found.attempts,
      findingsRaw: found.raw,
      findingsKept: found.findings.length,
      counts,
      drops: found.drops,
      modelCalls: calls,
      bytes: Buffer.byteLength(built.html, 'utf8'),
      ms: Date.now() - started,
      usage,
    },
  };
}
