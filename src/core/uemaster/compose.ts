import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { answerTruncated, coerceAnswer, noJsonReason, normalizeFrame, normalizeKind } from './shape.js';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { parseRequirementId } from '../validate.js';
import { attachArtifact } from './attach.js';
import { nextArtifactVersion, versionedFileOf } from './versions.js';
import { fingerprintOfRow } from '../requirements/fingerprint.js';
import { makeTrace, type Trace } from './attempts.js';
import { typeLabel } from '../requirements/type.js';
import { renderFlowchart, type FlowCheck } from './flow.js';
import { isStage, type Stage } from './packs.js';
import { evaluateReadsCode } from './features.js';
import {
  emptyOpenRow, openCount, openRows, readOpen, sanitizeOpen, type OpenQuestions,
} from './annotations.js';
import { EMPTY_SURFACES, PRODUCT_BODY_RULE } from '../locate/copy.js';
import type { KnownSurface, KnownSurfaces } from '../locate/copy.js';
import {
  countHtmlBodyHits, relocateHtmlBody, reportVocab, sanitizeAnno,
} from './body-language.js';
import {
  complete, extractJson, resolveProviderConfig,
  type ProviderConfig, type ProviderResult,
} from './provider.js';
import { artifactUrl } from './store.js';
import {
  MAX_STEPS, MAX_WHAT_CHARS, SEQUENCE_RULE, missingStepsReason, normalizeSteps, renderSequencePage,
  type SeqStep,
} from './sequence.js';
import {
  buildWalkmap, renderWalkthrough, validateWalkmap,
  type Anno, type BuildResult, type Frame, type NodeInput, type NodeKind,
  type PageInput, type Walkmap, type WalkmapAssets,
} from './walkmap.js';

/**
 * 「B 路线」：一个对话模型 + vendored 排版器，自己把需求做成一份**查过**的评估材料。
 *
 * 为什么要有这条路：P2.6–P2.9 的生成是「甩一条 agent CLI」——它要本机装着、登录着、
 * 会自己决定写什么 HTML、还会绕过检查直接交回一份没排过版的图。owner 的要求是
 * 「我有一个 LLM 的 key，就这一件事」：一个有 key 的部署必须能产出材料。所以这里
 * 让模型只做两件它真的擅长的事——**画图**（一段受限语法的 mermaid）与**画页面**
 * （每个节点一屏 `wt-*` 标记的 HTML 片段）；**成品 HTML 由 UEmaster 的 `build.py`
 * 产出**，不是我们拼的模板。这正是 owner 那句话的意思：「展示出来的东西和 uemaster
 * 效果一致，不要改」——一致的办法只有一个，就是**用它的构建器**。
 *
 * 三段各自的判据（缺一段，材料就退回「模型心情」）：
 * - 图：vendored 排版器的计数全 0 + 我们自己的形状判据；
 * - 页面片段：`wt-*` 词表、375/690 两种宽度、无 emoji、只写 body 内片段；
 * - 拼装：walkmap/1 契约（`walkmap.ts` 的校验器是 `build.py` 规则的镜像，先说话
 *   再 spawn，所以模型拿到的是一句中文而不是一份 Traceback）。
 *
 * 这条链路的核心不是提示词，是**判据**：
 *
 * 1. **引擎说合格 ≠ 图有用。** `flowlayout.py` 把语法垃圾当成一个节点（`"这不是
 *    mermaid"` → `nodes: 1`，退出 0）。所以除计数之外还判**形状**：少于 3 个节点或
 *    少于 2 条连线的回复一律算失败，与计数无关。
 * 2. **失败要能被修。** 每次拒收都把「上一版原文 + 引擎原文（含交叉/重叠的点）+
 *    具体要改什么」拼回提示词，图最多 3 次、页面片段最多 2 次；都不行就把最后那句
 *    （引擎的或校验器的）交给用户——他要看到的是「为什么」，不是「生成失败」。
 * 3. **降级要看得到。** 没配模型接口时说清缺哪一项；模型接口报错时**原样**带回
 *    （`分组 auto 下模型 x 的可用渠道不存在` 是 owner 换模型的唯一线索）。
 *
 * 与 `packs.ts` 的关系：那三份包是写给 **agent** 的（它自己去装 skill、自己写文件），
 * 这里是一条**不需要 agent** 的组装路径。两条路并存，`start.ts` 按「有没有配 provider」
 * 选一条（见 `resolveStrategy`）。
 */

// ─── 常量：判据与预算 ────────────────────────────────────────────────────────

/** 图这一关最多问 3 次（首版 + 两次修图）。 */
export const MAX_FLOW_ATTEMPTS = 3;

/** 页面片段最多问 2 次（首版 + 一次修：JSON 形状或 walkmap 契约都算）。 */
export const MAX_PAGES_ATTEMPTS = 2;

/**
 * 单次模型调用的超时：90 秒。
 *
 * 与 `provider.ts` 默认的 120 秒不同，因为这里一共产出 5 次调用（图 3 + 页 2）：
 * 90s × 5 = 7.5 分钟，仍然小于 `start.ts` 里 11 分钟的陈旧作业阈值——用户不会看到
 * 「明明失败了却显示正在生成中」。
 */
// 420 秒，不是 90。实测：推理模型在页面片段这一段单轮要 2 分钟起步——
// 90 秒会把**能成功的调用**判成超时（评审真跑撞过一次，白烧 90 秒）。
export const CALL_TIMEOUT_MS = 420_000;

/** 一段 mermaid 用不了多少 token；给多了只会让模型开始写解释。 */
const FLOW_MAX_TOKENS = 12_000;        // 实测 36% 的格被思考吃光：4k 对推理模型不够

/**
 * 页面片段的预算：N 屏 HTML + 标注。
 *
 * 比上一版（3000）翻倍，因为现在每屏都是**真的 HTML**（状态栏、导航、卡片、弹窗…），
 * 一屏 300–500 token 很正常，5 个页面节点就吃掉旧预算。给少了模型会开始截断，
 * 截断的 HTML 又会被 `wt-` 类校验拒掉——那是一次白花的调用。
 */
const FRAGMENTS_MAX_TOKENS = 24_000;    // 实测 11 格在 14k 撞顶被截断：一页 HTML 很占字

/** 形状判据（与本文件头「判据 1」对应）。上限刻意不判：图更大不是错。 */
const MIN_NODES = 3;
const MIN_EDGES = 2;

/** 阶段 → 材料名。与 `packs.ts` 的 `noun` 同口径，但这里是给模型看的。 */
const NOUN: Record<Stage, string> = { evaluate: '评估材料', review: '评审材料', inspect: '走查材料' };

/**
 * 评估（v1）用的正文规矩：把「研发参考」「代码坐标」「代码没读到」那几句摘掉。
 *
 * 为什么必须摘：那几句是给**读过代码**的材料写的（评审 / 走查），它们承诺「坐标由系统
 * 放进材料末尾的研发参考」、并允许「代码没读到 / 没找到」这类说法。评估这条路既不搬
 * 坐标、也没有「研发参考」小节（见 `composeEvaluation` 里 `relocateHtmlBody` 的注释），
 * 留着它们等于告诉模型「你可以谈代码」——而 v1 的材料里任何一句「代码里如何」都是编的。
 *
 * 为什么用过滤而不是另抄一份：抄一份就有两份正文规矩，改一处忘一处时两边开始漂，
 * 而这类漂移在材料里看不出来（只是某一句规矩某天不见了）。过滤的代价是**成对的行**
 * 要一起摘：「代码坐标是证据」那句下面跟着「你不要在正文里写，写了会被机器删掉」，
 * 只摘前一句会留下一个没有主语的半句。所以第三条判据是那半句的开头。
 */
const EVALUATE_BODY_RULE: readonly string[] = PRODUCT_BODY_RULE.filter((line) => !(
  /研发参考|代码坐标|代码没读到/.test(line)
  || line.trimStart().startsWith('你不要在正文里写')
));

/** 阶段 → 这份材料要回答的问题。写进提示词，模型才知道该往哪儿使劲。 */
const FOCUS: Record<Stage, string> = {
  evaluate: '讨论可行性——「这一步到底有没有页面、这么走通不通」',
  // 实测踩过的坑：只说「把 PRD 走一遍」，模型画出来的是**做评审这件事的流程**
  // （进入PRD评审 → 打开PRD文档 → 逐步走查），不是 PRD 描述的产品流程。
  // 评审材料要画的是**用户在产品里怎么走**，然后把问题挂到那几步上。
  review: '画 PRD 描述的**产品用户流程**（用户从进入功能到完成目标经过的那几步），'
    + '不是画「评审这件事怎么做」的流程；评审者照着这张图一步步过，走不通的地方挂在对应步骤上',
  inspect: '拿实现跟 PRD 对比——流程要按真实存在的页面画，不要照 PRD 修图',
};

// ─── 依赖（测试注入用） ──────────────────────────────────────────────────────

export type ComposeDeps = {
  complete: (cfg: ProviderConfig, prompt: string, opts?: { maxTokens?: number; timeoutMs?: number }) => Promise<ProviderResult>;
  render: (mermaid: string) => Promise<FlowCheck>;
  resolveConfig: () => Promise<ProviderConfig | null>;
  /** 拼好的 walkmap → HTML。真实实现是 vendored 的 `build.py`（子进程）。 */
  build: (walkmap: Walkmap, assets: WalkmapAssets) => Promise<BuildResult>;
  /**
   * 「现在有哪些页面」的读口（任务 4）。**缺省 = 不读**，提示词里因此一个字都不提
   * 现有页面——这是刻意的默认值，不是漏了：这个函数一走就是镜像 ssh + 索引装配
   * （几百毫秒到几秒），把它做成 LIVE 默认会让每一个直接调 `composeEvaluation`
   * 的用例、脚本都去连镜像，而这件事与「材料怎么写」无关。
   *
   * 真实路径（`start.ts` 的 `runJob`）显式注入 `() => loadKnownSurfaces(db)`。
   * 读失败由注入方吞成空数组（见 `loadKnown`）：上下文缺了不该让材料失败。
   */
  loadSurfaces?: () => Promise<KnownSurfaces>;
};

/** 真实的四个依赖：真 HTTP、真 Python 排版器、真配置解析、真 walkmap 构建器。 */
const LIVE: ComposeDeps = {
  complete,
  render: (mermaid) => renderFlowchart(mermaid),
  resolveConfig: resolveProviderConfig,
  build: (walkmap, assets) => renderWalkthrough(walkmap, assets),
};

/**
 * 拿「现有页面」清单；读不到就是空清单。
 *
 * 为什么吞异常：这份清单是**上下文**，不是结论。镜像连不上时材料的结论不该变成
 * 「代码没读到」——那是评审那条链路的 `absent`，它有专门的一句话（`copy.ts`）。
 * 评估这里少一段上下文，材料照旧成立，只是这一次材料**不计入基线**（报告里要写明）。
 */
export async function loadKnown(deps: ComposeDeps): Promise<KnownSurfaces> {
  if (deps.loadSurfaces === undefined) return EMPTY_SURFACES;
  try {
    return await deps.loadSurfaces();
  } catch {
    return EMPTY_SURFACES;
  }
}

/**
 * 评估这一版要不要拿「现有页面清单」。
 *
 * 单独一格是为了**可测**：`composeEvaluation` 要走真库 + 真模型，而「v1 不读代码」这条
 * 承诺的判据就是「`loadSurfaces` 这一次到底有没有被调用」。把判据放在这里，一条用例
 * 就能钉住它（把 `readsCode` 的短路删掉，用例变红），不必跑一整次生成。
 *
 * 默认值是**开还是关由 flag 决定**（`FEATURE_EVALUATE_READS_CODE`，默认关）；
 * 关的时候连读口都不碰——不是「读了但不用」：读口背后是一次镜像 ssh + 索引装配，
 * 而 v1 的材料里不会出现它读到的任何一个字。
 */
export async function knownForEvaluate(
  deps: ComposeDeps,
  readsCode: boolean = evaluateReadsCode(),
): Promise<KnownSurfaces> {
  if (!readsCode) return EMPTY_SURFACES;
  return loadKnown(deps);
}

// ─── 入参与出参 ──────────────────────────────────────────────────────────────

export type ComposeRequest = {
  requirementId: string;
  stage: Stage;
  /**
   * 这次组装属于哪条作业（P2.13）。有它才留痕：`uemaster_job_attempts.job_id` 是外键，
   * 而没有作业的调用（用例、脚本直接调 `composeEvaluation`）不该为了记录去编一条。
   *
   * 为什么不在这里收一个 `Trace`：留痕是压在作业上的，作业 id 是它唯一的键；
   * 把整支笔记进来，调用方就能塞一支假的，read 侧就对不上账了。
   */
  jobId?: string;
};

/** 这一次组装一共花了多少 token（所有调用相加；服务端没给就记 0）。 */
export type ComposeUsage = { prompt: number; completion: number };

export type ComposeOutcome = {
  /** 站内路径，`attachArtifact` 收的就是它。 */
  url: string;
  /** 图这一关问了几次（1..3）。页面说明的重试不计数——它没参与「图对不对」。 */
  attempts: number;
  usage: ComposeUsage;
  /** 落库那行的 id：作业收口（`uemaster_jobs.artifact_id`）要用，不属于对外契约。 */
  artifactId: string;
  /** 正文 + 标注里违规词**清洗前**的处数（第二轮的可数指标；>0 = 流水线失误）。 */
  vocabHits: number;
  /** 清洗**之后**还剩几处（应当恒为 0）。 */
  vocabLeft: number;
};

export type RequirementRow = {
  id: string;
  number: number;
  title: string;
  /** `text` 可空（Ruling 1）：commercial / feature / null（未指定）。生成 prompt 里写「未指定」。 */
  type: string | null;
  requester: string;
  prd_url: string | null;
  /**
   * 六问（P4-02）。生成要它们，因为你正在写的材料是照着**描述**写的。
   *
   * 这一行在哪个时刻被读出来，决定了产物的指纹（见 `loadRequirement` 下面的注释）：
   * 生成可能跑 2–3 分钟，中途有人改描述是常态，所以指纹必须在**读需求的那一刻**
   * 就算出来、一路带下去，而不是等在 attach 那一刻现算。
   */
  context: string | null;
  problem: string | null;
  outcome: string | null;
  surfaces: string | null;
  edge_cases: string | null;
  out_of_scope: string | null;
  /** 平台（P4-08）：它参与指纹，所以生成入口必须把它读出来。 */
  platforms: string[] | null;
  /** 优先级（P4-09）：与平台同一条理由，它参与指纹。 */
  priority: string | null;
};

// ─── 提示词 1：只要一段 mermaid ──────────────────────────────────────────────

/**
 * 标题那一格：`pages.json` 里没写 title 的页面是 `null`，而 router 推出来的页面可能是
 * **空串**（`/pages/webview/webview` 实测就是空串）。两种都写「无标题」：提示词里出现
 * `- /pages/x（）` 这种括号套空，模型只会当它是格式噪音，我们要的是「这页没有标题这件事」。
 */
function titleOf(surface: KnownSurface): string {
  return (surface.title ?? '').trim() === '' ? '无标题' : surface.title!;
}

/**
 * 清单里的一行。两个提示词共用，免得一处改了标点、另一处忘了。
 *
 * `被 N 处引用`（I4）：`importedBy` 本来是每次装配都算、生产路径零次读取的死数据。
 * 一行只放一个数字、不放引用者名单——材料要的是「改这一页会波及几处」，一个数就够，
 * 列名单会把这一行变成文件清单，而清单是要被模型照着抄的。
 * `importers === null` 是「这一页没有视图文件」，与「0 处引用」不是一件事，所以分开写。
 */
function surfaceLine(surface: KnownSurface): string {
  const hidden = surface.componentTotal - surface.components.length;
  const components = surface.components.length > 0
    ? `已有组件 ${surface.components.join('、')}${hidden > 0 ? `（另有 ${hidden} 个未列出，共 ${surface.componentTotal} 个）` : ''}`
    : '没读到组件';
  const refs = surface.importers === null ? '没有视图文件' : `被 ${surface.importers} 处引用`;
  return `  - ${surface.route}（${titleOf(surface)}）：${components}；${refs}`;
}

/**
 * 「现有页面」那一段提示词。**清单为空时返回空数组**——调用方据此整段不写。
 *
 * 为什么空清单必须一个字都不说：材料里一旦出现「现有页面上什么都没有」，读的人
 * 会把它当成结论（他分不出「没读到索引」和「读到了、确实没有」），而这句话比不说
 * 更坏。本仓修过两遍同一个形状（`mergeHistory` 把 0 条吞成成功、`absent` 与
 * `none` 混用），所以这里是空数组，不是一句「（无）」。
 *
 * 为什么标注要占用节点文案的**第二行**（`<br>`）：图里的节点文案有 12 个汉字的上限
 * （第 5 条），而路由是 `/pages/share/index` 这种不能截断的东西。压成一行只能
 * 二选一：要么丢页面文案，要么截路由——两个都是把标注变成一知半解。所以第一行是
 * 页面文案、第二行是标注，`decodeLabel` 会把 `<br>` 压成空格，材料里读起来是一句话。
 *
 * 为什么把组件名也列出来：材料要能回答「这页已经有 `FileList` 了，别再说要新建一个
 * 文件列表」。「现有页面」只说得出「这页在」，说不出「这页里有什么」，那一句就只
 * 剩半个用处。组件名**只来自索引里这一页的视图文件**（口径见 `knownSurfaces`）。
 */
export function surfacesBlock(known: KnownSurfaces): string[] {
  if (known.surfaces.length === 0) return [];
  const first = known.surfaces[0]!;
  const exampleTitle = titleOf(first) === '无标题' ? '页面文案' : titleOf(first);
  const counted = known.total === known.surfaces.length
    ? `共 ${known.total} 个`
    : `共 ${known.total} 个，本次只列出前 ${known.surfaces.length} 个`;
  // C1 的裁决：清单不完整时**不许**说「不要假设清单之外还有页面」。
  // 同一句话在「清单是完整的」时是对的，在「只覆盖一个仓 / 截断了 / 某个仓轮廓没读到」
  // 时会把失明说成看得全，被漏掉的页面因此全被标成「新增」——那正是本任务要压的指标。
  const boundary = known.complete
    ? ['不要把清单里的页面标成新增，也不要假设清单之外还有页面。清单里的组件是这页已经有的，',
      '不要说它们要新建。写法示例：']
    : [
      '不要把清单里的页面标成新增。',
      `但这份清单**不完整**（${known.note ?? '只覆盖部分仓'}）：未列出的页面不等于不存在，`,
      '不要断言它不存在、也不要把它写成「新增页面」；只有清单里没有、且需求明确要求新做的才写「新增页面」。',
      '清单里的组件是这页已经有的，不要说它们要新建。写法示例：',
    ];
  return [
    '',
    `已知现有页面（来自代码索引，${counted}）。流程里落在这些页面上的步骤，必须标注：`,
    '  · 节点文案分两行，用 <br> 连接：第一行是页面文案（≤12 汉字），第二行是归属标注；',
    '  · 落在清单里的页面 → 第二行写「现有页面：<route>」，route 逐字抄清单里的写法；',
    '  · 不在清单里的 → 第二行只写「新增页面」。',
    ...boundary,
    `  A["${exampleTitle}<br>现有页面：${first.route}"]`,
    '清单（路由（标题）：已有组件；被 N 处引用 = 有 N 个文件 import 这一页的视图文件，',
    '步骤落在这页时把它写进材料——它就是「改这一页会波及几处」）：',
    ...known.surfaces.map(surfaceLine),
  ];
}

/**
 * 同一份清单的**页面片段版**。措辞与 `surfacesBlock` 不同，因为模型这一轮要交的是
 * HTML 而不是图：它已经拿到了图（标注在那上面写着），这里只需要它别把标注抹掉、
 * 别把已有的组件画成新发明的东西。
 *
 * 「title 原样保留」这句必须写：`fragmentsPrompt` 第 4 条本来就要求 title 用清单里的
 * 节点文案，但那是**总则**；素材里多了一份「现有页面」清单时，模型很容易在 title 里
 * 换成一句自己概括的页面名——那一换，材料里「这一步落在哪个现有页面」就没了，
 * 而它正是这份材料唯一能对上代码的一行字。
 */
export function fragmentsSurfacesBlock(known: KnownSurfaces): string[] {
  if (known.surfaces.length === 0) return [];
  return [
    '',
    '其中这些页面是**已经存在**的（来自代码索引）：',
    ...known.surfaces.map(surfaceLine),
    '这一类节点的 title 要原样保留流程图里的那行标注（「现有页面：<route>」或「新增页面」），',
    '不要删、不要概括成另一个页面名；页面里出现清单列出的组件时沿用它的名字与位置，',
    '不要换成自造的等价物；',
    // 与 `surfacesBlock` 同一条 C1 口径：清单不完整时，没列出的页面只是「不确定」。
    known.complete
      ? '清单之外的页面不要画。'
      : `这份清单不完整（${known.note ?? '只覆盖部分仓'}）：清单之外的页面只是不确定，不要把它画成「新增页面」。`,
    '清单里「被 N 处引用」是这一页视图文件被几个文件 import 了——页面片段里有归属说明时，',
    '把这一页的引用数一并写出来（它就是这一页改动的波及面）。',
  ];
}

/**
 * 「既不是页面、也不是服务端动作的步骤，从流程里删掉」——流程图提示词里的那一段（2026-11-09 第三轮）。
 *
 * 为什么需要这一段：节点分类学只有两种（落在页面上 / 发生在服务端），而 PRD 里总混着
 * 第三种东西——「第三方自己内部怎么处理」「线下谁去搬货」「开会评审这件事本身」。它们
 * 既不会被用户在界面上看见，也不会由我们的服务端执行，**不属于我们产品的流程**。
 * 模型原来只有两条坏路：硬画一屏界面（读者以为这一步有页面），或者硬写一组参与方
 * （读者以为服务端在做这件事）——两种都是假话，而这一整天清的就是这类假陈述。
 * 正确的做法是从图里删掉：少一步，读者不会读错；多一步编的，读者一定读错。
 *
 * 为什么要求它「删掉时说一行」：删掉一个 PRD 里写过的步骤而不说，读者会以为材料漏了。
 * 那一行（`已删去：<原步骤文案>`，`droppedNotesIn` 收走、`buildFlow` 用一行日志交代）
 * 让复核的人不去比对 PRD 也知道少了什么。
 *
 * 为什么提示词不是唯一防线：模型可能照样画出来，甚至给一屏编出来的界面。那时
 * `readFragments` / `readVerify` 的「判为后端流程但没有给出步骤」与 `validateWalkmap`
 * 的「既没有页面也没有后端流程」会把它整份退回——**宁可整份失败，也不要静默漏一步或
 * 静默编一步**，这是这条规则的下限。
 */
export const FLOW_DROP_RULE: readonly string[] = [
  '不属于产品流程的步骤不要画：一个步骤如果既不是用户在界面上能看到的，也不是服务端会做的事',
  '（例如「第三方自己内部怎么处理」「线下谁去搬货」「开会评审这件事本身」），把它从图里去掉。',
  '硬画成页面或硬写成服务端动作，读者会以为那一步真的这样发生。',
  '去掉之后在最后单独一行写「已删去：<原步骤文案>」——删了却不说，读者会以为材料漏了一步；',
  '一个都没去掉就什么都不要写（这一行不是必填）。',
] as const;

/**
 * 从模型的流程图回话里收走「已删去：…」那几行。
 *
 * 判据刻意窄：整行以「已删去」/「已去掉」/「已略去」开头（允许前面的列表符号与引用符），
 * 冒号（半角全角都收）之后才是原步骤文案。为什么不扫正文里的同名词：那一行是**回话的
 * 附带说明**，不是图的一部分——图里的节点文案里出现这几个字是正常的，不能当成删改记录。
 * 为什么行内别的位置不认：模型偶尔在解释里写「我删掉了 X」，那是它在自言自语；我们要的是
 * 一个固定形状（像 `searched` 那一格），这样它每次都得说，而我们也总能读。
 */
const DROP_NOTE = /^[\s>•·\-*]*(?:已删去|已去掉|已略去)\s*[:：]\s*(.+)$/u;

export function droppedNotesIn(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const hit = DROP_NOTE.exec(raw.trim());
    if (hit === null) continue;
    const what = (hit[1] ?? '').trim();
    if (what !== '') out.push(what);
  }
  return out;
}

/**
 * 「删了几步」那一行日志。
 *
 * 为什么走 stderr 而不是写进材料：这一行是**流水线的交代**（这一次删了什么），读者拿它
 * 对账用；写进材料里的位置应该由材料自己的版式决定，那是另一件事。与 `[body-language]`
 * 那一行同一个口径（见 `body-language.ts` 的 `reportVocab`）：不拦材料，但必须被看见。
 */
export function dropReportLine(tag: string, dropped: readonly string[]): string {
  return `[flow-drop] ${tag} 已删去 ${dropped.length} 个不属于产品流程的步骤：${dropped.join('、')}`;
}

/** 一行日志（删除清单为空时一个字都不打——「今天没删」不值得占一行）。 */
export function reportDropped(tag: string, dropped: readonly string[]): number {
  if (dropped.length === 0) return 0;
  process.stderr.write(`${dropReportLine(tag, dropped)}\n`);
  return dropped.length;
}

/**
 * 图这一关的提示词。
 *
 * 为什么把子集规则**抄进提示词**而不是说「按 flowspec-v1.md 画」：模型读不到文件。
 * 引擎只认「单主干 + 右分支 + 回线」这一种形态，`subgraph`、`classDef`、`-.->` 一律
 * 不是被拒就是被画歪；不把这些说出来，一半的回复会死在语法上，而每一次死都要花
 * 一次 90 秒的调用。
 *
 * 为什么强调「不要代码围栏 / 不要开场白」：围栏会被 `mermaidIn` 剥掉，但开场白
 * （「好的，这是流程图：」）里的中文如果漏进 mermaid，引擎会把它当成一个节点——
 * 那正是「语法垃圾也能过计数」的那条坑。
 */
export function flowPrompt(
  req: RequirementRow,
  stage: Stage,
  known: KnownSurfaces = EMPTY_SURFACES,
): string {
  const prd = req.prd_url === null
    ? '未提供（照需求标题与类型推断；推断的地方不要假装有依据）'
    : req.prd_url;

  return [
    '你是需求流程建模助手。把下面这条需求画成一张业务流程图（mermaid），只输出 mermaid 源码。',
    '',
    '需求：',
    `  · 编号：PAN-${req.number}`,
    `  · 标题：${flat(req.title)}`,
    `  · 类型：${typeLabel(req.type)}`,
    `  · 提出人：${flat(req.requester)}`,
    `  · PRD：${flat(prd)}`,
    `  · 这次要做的是${NOUN[stage]}：${FOCUS[stage]}`,
    ...surfacesBlock(known),
    '',
    '输出格式（硬性要求，逐条都会被机器校验）：',
    ' 1. 第一行必须是 flowchart TD；整段不超过 14 行。',
    ' 2. 节点只有三种写法：',
    '    · 普通步骤   A["进入寄养频道"]      （实线矩形）',
    '    · 判断       B{"是否登录？"}        （菱形）',
    '    · 后台环节   G[["门店接单后台"]]    （双边线灰底，非前端页面/系统动作都用这个）',
    ' 3. 连线写成 A --> B；从判断节点出发的连线**必须**带标签：B -->|是| C 与 B -->|否| D。',
    '    标签只能语义化（是/否/通过/不通过/超时），不要写「分支一」「情况A」。',
    ' 4. 3–8 个节点、至少 2 条连线。必须是一条**单主干**：主干自上而下串起主要步骤，',
    '    分支从判断节点出发沿右侧向下走，最后汇回主干。',
    '    不要画两个互不相连的孤岛，不要画回到自己前面很远的兜圈子。',
    ' 5. 节点文案用中文，一行不超过 12 个汉字；要换行就用 <br>。',
    ' 6. 禁止：subgraph、style、classDef、click、%% 注释、emoji、括号里套引号、',
    '    任何解释性文字（不要「以下是流程图」这类开场白）。',
    // 6b 两版：评估**不读代码**（v1），所以不许承诺「坐标由系统放进研发参考」——
    // 那份材料里根本没有那一节，写出来的坐标也没有一处是核对过的。评审 / 走查读代码，
    // 那句话照旧（它们的材料末尾真有「研发参考」小节）。
    stage === 'evaluate'
      ? ' 6b. 节点文案是**产品语言**：写用户在做什么（「选择要分享的文件」），不要写文件路径、'
        + '函数名或行号——读者是 PM，这些坐标对判断没有任何帮助（评估不读代码，图里写出来的'
        + '坐标没有一处是核对过的）。'
      : ' 6b. 节点文案是**产品语言**：写用户在做什么（「选择要分享的文件」），不要写文件路径、'
        + '函数名或行号——读者是 PM，代码坐标由系统放进材料末尾的「研发参考」，不写进图里。',
    ' 7. 不要 ``` 代码围栏。第一行就是 flowchart TD，最后一行是最后一条连线——唯一例外是',
    '    下面那条「已删去：…」（它写在最后，只写一行）。',
    '',
    ...FLOW_DROP_RULE,
    '',
    '只输出 mermaid 源码本身。',
  ].join('\n');
}

// ─── 修图提示词 ──────────────────────────────────────────────────────────────

/** 报告里那三组点（交叉/重叠/溢出的坐标）拼成一行人话。没有就返回空串。 */
function pointsOf(report: unknown): string {
  if (typeof report !== 'object' || report === null) return '';
  const pick = (key: string): unknown[] => {
    const value = (report as Record<string, unknown>)[key];
    return Array.isArray(value) ? value : [];
  };
  const groups: Array<[string, unknown[]]> = [
    ['交叉点', pick('crossing_points')],
    ['重叠点', pick('overlap_points')],
    ['溢出点', pick('textOverflow_points')],
  ];
  const parts: string[] = [];
  for (const [name, list] of groups) {
    for (const item of list.slice(0, 3)) parts.push(`${name} ${JSON.stringify(item)}`);
  }
  return parts.join('；');
}

export type FlowShape = { nodes: FlowNode[]; edges: number };

/** 「形状太小」这句话。测试会断言里面真的有节点数与连线数。 */
function shapeText(shape: FlowShape): string {
  return `上一版只有 ${shape.nodes.length} 个节点、${shape.edges} 条连线，`
    + `而要求是 ${MIN_NODES}–8 个节点、至少 ${MIN_EDGES} 条连线`;
}

/** 「布局不合格」这句话。优先用引擎自己那一句（它带计数）。 */
function engineText(check: FlowCheck): string {
  if (check.error !== undefined && check.error !== '') return check.error;
  return `布局不合格：交叉 ${check.crossings}、重叠 ${check.overlaps}、文字溢出 ${check.textOverflow}`;
}

/**
 * 修图提示词：上一版原文 + 引擎原文 + 要改什么。
 *
 * 三段缺一不可：
 * - 不给原文，模型会换一张全新的图（浪费一次调用，还可能踩另一条坑）；
 * - 不给引擎原文，它只能猜「哪里不好」，而引擎说的是坐标级的事实；
 * - 不给「要改什么」，它会把图改得更复杂——交叉几乎总是「太多分支」造成的，
 *   正确的方向是**变简单**。
 */
export function repairPrompt(
  req: RequirementRow,
  stage: Stage,
  previous: { mermaid: string; check: FlowCheck; shape: FlowShape },
  known: KnownSurfaces = EMPTY_SURFACES,
): string {
  const { mermaid, check, shape } = previous;
  const focus: string[] = [];

  if (!check.ok) {
    // 三个计数已经由 `--check` 补跑带回来了（见 `flow.ts` 的 `diagnose`）。
    // 全为 0 却仍然被拒，说明不是布局问题（形态超限、语法、emoji）——那时直接引用引擎原文。
    const counted = check.crossings + check.overlaps + check.textOverflow > 0;
    focus.push(counted
      ? `· 布局不合格：交叉 ${check.crossings}、重叠 ${check.overlaps}、文字溢出 ${check.textOverflow}。`
        + '合格标准是三项全为 0。'
      : `· 引擎拒绝了这份图：${engineText(check).replace(/[。.\s]+$/, '')}。`);
    const points = pointsOf(check.report);
    if (points !== '') focus.push(`  引擎给的位置：${points}`);
    focus.push('  常见成因：同一个判断节点挂了三条以上出边；分支链之间互相汇入；主干上出现跨级连线。');
    focus.push('  改法：把图变简单——一条主干串 3–5 个节点，判断节点只留「是」「否」两条出边，其余情况挪进节点文案。');
  }

  if (shape.nodes.length < MIN_NODES || shape.edges < MIN_EDGES) {
    focus.push(`· ${shapeText(shape)}。`);
    focus.push('  图太碎/太少，读的人看不出流程。至少要有「开始 → 判断 → 两条分支」这个最小骨架。');
  }

  return [
    `上一版 mermaid 没有通过检查（${NOUN[stage]}，PAN-${req.number}「${flat(req.title)}」）。请修好它。`,
    '',
    '上一版原文：',
    mermaid.trim(),
    '',
    '引擎原文：',
    engineText(check),
    check.report === null ? '' : JSON.stringify(check.report, null, 1),
    '',
    '要改的地方：',
    ...focus.filter((line) => line !== ''),
    ...surfacesBlock(known),
    '',
    '其余规则不变：第一行 flowchart TD；3–8 个节点；单主干 + 右分支；判断出边带「是」「否」；',
    '不要代码围栏、不要解释文字，只输出修好后的 mermaid 源码。',
    '',
    ...FLOW_DROP_RULE,
  ].join('\n');
}

// ─── 提示词 2：页面片段（上游 walkmap 契约的输入） ──────────────────────────

/**
 * 图里解析出来的一个节点。`kind` 决定它该画页面还是只写标注。
 *
 * `prev`（2026-11-10）：图里指向它的节点 id。只在拼 walkmap 时用一次——手机 chrome 的
 * 回退箭头「有没有前驱」由它决定（首页不画）。它不写进提示词清单，也不写进标注。
 */
export type FlowNode = {
  id: string;
  label: string;
  kind: 'process' | 'decision' | 'backend';
  prev?: string[];
};

/** 模型交回来的一份页面片段。`html` 我们**一个字都不改**，原样写进临时目录。 */
export type PageFragment = {
  id: string;
  title: string;
  kind: NodeKind;
  frame: Frame;
  /** `kind=page` 时是 body 内的片段；`system` / `decision` 是空串（它们没有页面）。 */
  html: string;
  anno: Anno[];
  /**
   * 后端节点（`system` / `decision`）的时序步骤（2026-11-09）。
   *
   * 为什么放在同一个结构里而不是另开一份清单：节点的标注、标题、形态都必须成组地
   * 从模型手里接过来；分成两份就会出现「有步骤的节点没有标注」这种对不上的情形。
   * `kind=page` 的节点即使给了 steps 也会被忽略（它有页面，页面就是它的原型）。
   */
  steps?: SeqStep[];
  /**
   * 右栏的两栏标注（2026-11-10，v1 的承诺里那两栏）。
   *
   * 与 `anno` 分开而不是塞进 `anno` 的第三格：`anno` 的第三格已经被缺口等级
   * （`p0/p1/p2`）占了，而两组问题**不是**一种标注——它们各有责任人与各自该问的东西
   * （见 `annotations.ts` 文件头）。拼装时由 `openRows` 铺回 `anno`，所以契约里
   * 看不到这个字段。
   */
  open?: OpenQuestions;
};

export type FragmentDoc = { nodes: PageFragment[] };

/** 图里的节点形态 → 契约里的节点形态。后台环节在上游叫 system。 */
export function kindOf(node: FlowNode): NodeKind {
  if (node.kind === 'decision') return 'decision';
  if (node.kind === 'backend') return 'system';
  return 'page';
}

/**
 * 提示词 2：每个节点交一份**页面片段**或**一组时序步骤**，不再是我们的私有 JSON。
 *
 * 为什么把 `page-guide.md` 的规则**抄进提示词**：模型读不到仓库里的文件。而这一版
 * 材料要过的关是上游的 `build.py`——它只认 `wt-*` 组件类、只认 375 / 690 两种宽度、
 * 见到 emoji 直接拒。这些规则写不进提示词，模型就会交一份自认为漂亮的 HTML，然后在
 * 校验那一步被整份打回。规则下面那些**会变的部分**（节点清单、状态、编号）才是每次
 * 不同的东西。
 *
 * 2026-11-09 改了两件事（同一个事故的两面，见 `sequence.ts` 与 plan
 * `2026-11-09-backend-sequence.md`）：
 *
 * 1. **节点分两类**：落在页面上的交页面片段；发生在服务端的（`system` / `decision`）
 *    交 `steps`（谁 → 谁 · 做什么）。原来的说法是「无页面的步骤只给标注、由系统折进
 *    前一个页面节点」，那句话对纯后端流程是不成立的：`PAN-815` 六个节点全是后端步骤，
 *    没有「前一个页面节点」，于是整份材料被 `validateWalkmap` 拒掉。
 * 2. **时序参与方是封闭词表**（`SEQUENCE_RULE`）：产品级角色，不许出现代码类名。
 *    这一条是 owner 的硬规矩——时序图是最容易把 `ShareController.refund()` 画进去的
 *    版式，而它必须读起来像产品文档。
 */
export function fragmentsPrompt(
  req: RequirementRow,
  stage: Stage,
  nodes: FlowNode[],
  known: KnownSurfaces = EMPTY_SURFACES,
): string {
  const list = nodes
    .map((node) => `  ${node.id}  [${KIND_NOUN[kindOf(node)]}]  ${node.label}`)
    .join('\n');

  return [
    `你在为 PAN-${req.number}「${flat(req.title)}」画走查页面。`,
    `这份材料是${NOUN[stage]}：${FOCUS[stage]}`,
    '',
    '流程图已经定稿，节点清单（id / 形态 / 文案）：',
    list,
    ...fragmentsSurfacesBlock(known),
    ...(stage === 'evaluate' ? EVALUATE_BODY_RULE : PRODUCT_BODY_RULE),
    ...SEQUENCE_RULE,
    '',
    '页面节点（kind=page）请交一份页面片段，规则如下（来自 flow-walkthrough 的 page-guide，逐条会被机器校验）：',
    ' 1. 设备框就是用户的手机屏幕或浏览器窗口：框里每一段文字都必须是上线后用户真的会看到的内容。',
    '    设计理由、边界条件、「本期不做 / 待确认」、演示操作说明一律不写；元素下方不加解释性的小字。',
    ' 2. 手机页面按 375px 宽画（frame 写 phone）；后台与网页页面放 690px 宽的窗口（frame 写 wide）。',
    ' 3. 只用模板内置的 wt-* 组件类，不自带 <style>、不引外部资源：',
    '    wt-body（内容区，片段从这里开始）、wt-titlebar、wt-card、wt-section、wt-list / wt-list-item / wt-li-main / wt-li-title /',
    '    wt-li-sub / wt-li-extra / wt-li-arrow、wt-input、wt-btn（整行主按钮）/ wt-btn-ghost / wt-btn-sm、',
    '    wt-badge、wt-dimtext、wt-tabs / wt-tab / wt-on、wt-empty、wt-img、wt-bottombar、',
    '    wt-modal / wt-dialog / wt-dialog-title / wt-dialog-body / wt-dialog-actions、wt-toast、',
    '    wt-browserbar（后台地址栏）、wt-table。',
    ' 4. 只写 body 内的片段：不要 <html>、<head>、<body>、<script>、<style>。',
    ' 4b. **手机外壳（状态栏 + 导航栏）由模板画，你不要画**：片段从 wt-body 开始，',
    '    不要写 wt-screen、wt-statusbar、wt-sb-icons、wt-nav（含 wt-nav-back / wt-nav-title /',
    '    wt-nav-action）。理由：图标是模板里的内联 SVG，你拿 CSS 盒子和符号拼出来的顶栏',
    '    在任何缩放下都读成一个畸形小方块（真材料 PAN-47 就是这样）；而且同一块外壳每页',
    '    必须长得一模一样，评审才比得出页面内容的差别。导航栏标题由系统按节点文案填，',
    '    首页也不会出现回退箭头——这两件事都不用你写。',
    ' 5. 一个状态一份片段：同一页面因规则不同而出现的态（弹窗、toast、空态、只读态）各写一份；',
    '    弹窗态 = 原页面 + wt-modal（与 wt-body 并列），toast 态 = 原页面 + wt-toast。',
    '    不同状态之间共用的那部分结构必须一模一样，评审才比得出来。',
    ` 6. 页面上能推进流程的按钮写 onclick="goNode('节点id')"，id 必须是上面清单里的 id。`,
    ' 7. 不用 emoji（构建器硬校验，出现即整份材料被拒）。图片用 wt-img 占位，图标用文字占位。',
    ' 8. 只画需求里有的内容，不自行添加功能；PRD 没给的细节用中性占位内容，不要写「PRD 未提供」。',
    '',
    '输出：**一个** JSON 对象（不要代码围栏、不要解释），nodes 里每个节点一条：',
    '{',
    '  "nodes": [',
    '    { "id": "A", "kind": "page", "frame": "phone", "title": "进入寄养频道",',
    '      "html": "<div class=\\"wt-body\\"><div class=\\"wt-card\\">…</div>'
      + '<button class=\\"wt-btn\\">立即预约</button></div>",',
    '      "anno": [["内容", "按距离列出可寄养门店"], ["操作", "点「立即预约」后判断是否首次预约"]],',
    '      "open": {',
    '        "req": [["失败怎么办", "门店列表加载失败时停在这一屏还是退回上一屏，是否保留已选门店"]],',
    '        "dev": [["状态", "这一屏有加载中、空列表、失败三种态，各显示什么"]] } },',
    '    { "id": "B", "kind": "system", "title": "门店接单后台",',
    '      "steps": [',
    '        { "from": "服务端", "to": "运营后台", "what": "把订单推给门店" },',
    '        { "from": "运营后台", "to": "服务端", "what": "门店接单" },',
    '        { "from": "服务端", "to": "通知渠道", "what": "给用户发接单通知" }',
    '      ],',
    '      "anno": [["内容", "门店接单后才有寄养位"]] },',
    '    { "id": "C", "kind": "decision", "title": "是否登录？",',
    '      "steps": [',
    '        { "from": "页面", "to": "服务端", "what": "带上当前登录状态" },',
    '        { "from": "服务端", "to": "服务端", "what": "判断这个用户有没有登录过" }',
    '      ],',
    '      "anno": [["判定依据", "会话里有没有用户"]] }',
    '  ]',
    '}',
    '',
    '规则：',
    ' 1. id 必须与清单一一对应，一个不多一个不少；kind 与清单里的形态一致。',
    ' 2. kind=page 必须给 frame 与 html（html 是完整可渲染的一屏，不是描述），不要给 steps；',
    `    kind=system / decision **不要**给 html，必须给 steps（1–${MAX_STEPS} 步，每步 ≤${MAX_WHAT_CHARS} 字）。`,
    ' 3. anno 是右栏的**事实标注**：每项 ["小标题", "正文"]，小标题 2–6 个字，正文一句话；',
    '    要指页面位置时写成「[A] 顶部状态卡片」，编号只写在标注里、不画进页面。',
    '    每页 1–3 条，只写这一屏有什么、判定依据是什么，不要重复页面里已有的文案。',
    ' 3b. open 是右栏的**两组待确认问题**，一格都不能合并（责任人不同）：',
    '    · "req"（待需求方确认）= PRD / 六问没写清的产品问题：失败怎么办、这次不做什么、',
    '      验收口径、边界条件；这一类只有提需求的人能回答。',
    '    · "dev"（待研发确认）= 实现层面要研发回答的问题：这一页有哪些状态、跳去哪里、',
    '      失败怎么提示；这一类只有做的人能回答。',
    '    两条铁律：**只问不答**（你不知道答案，就别写成结论）；**每个节点至少一条**',
    '    （放在哪一组都行；某一组确实没有问题就给空数组 []，不要为凑数编一条）。',
    '    每项同样 ["小标题", "正文"]，正文一句话，写清「问的是什么、答了会影响什么」。',
    ' 4. title 用清单里的节点文案，不要改写。全部中文。',
    ' 5. 只输出 JSON 本身：第一个字符是 {，最后一个字符是 }。',
  ].join('\n');
}

/**
 * 改片段的提示词：上一版原文 + **哪一条规则没过** + 规则再来一遍。
 *
 * `why` 可能是两种东西，但模型看到的形状是一样的：
 * - `readFragments` 的 JSON / 覆盖率问题（少节点、多节点、结构不对）；
 * - `validateWalkmap` 的一句话（「节点 X 没有对应的页面」「页面 X 的片段没有使用 wt- 类」）。
 * 两者都写成「问题：…」，因为对模型而言都是「你交的这份哪里不合规」。
 */
export function fragmentsRepairPrompt(
  req: RequirementRow,
  stage: Stage,
  nodes: FlowNode[],
  previous: string,
  why: string,
  known: KnownSurfaces = EMPTY_SURFACES,
): string {
  const trimmed = previous.trim();
  const shown = trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}…` : trimmed;
  return [
    `上一版的页面片段没有过校验（PAN-${req.number}「${flat(req.title)}」${NOUN[stage]}）。`,
    '',
    '上一版原文：',
    shown === '' ? '（空）' : shown,
    '',
    `问题：${why}`,
    '',
    '节点清单（id / 形态 / 文案，一个都不能少）：',
    nodes.map((node) => `  ${node.id}  [${KIND_NOUN[kindOf(node)]}]  ${node.label}`).join('\n'),
    ...fragmentsSurfacesBlock(known),
    ...(stage === 'evaluate' ? EVALUATE_BODY_RULE : PRODUCT_BODY_RULE),
    ...SEQUENCE_RULE,
    '',
    '重发**完整**的 JSON，形状不变：',
    '{"nodes":[{"id","kind","frame","title","html","anno":[["小标题","正文"]],'
      + '"open":{"req":[["小标题","正文"]],"dev":[]},"steps":[{"from","to","what"}]}]}',
    'kind=page 给 frame 与 html；kind=system / decision 不给 html，给 steps（谁 → 谁 · 做什么，'
      + `1–${MAX_STEPS} 步，每步 ≤${MAX_WHAT_CHARS} 字）。`,
    'html 只用 wt-* 组件类、只写 body 内片段、不用 emoji；一个状态一份片段；',
    '页面上推进流程的按钮写 onclick="goNode(\'节点id\')"。全部中文，只输出 JSON 本身。',
  ].join('\n');
}

// ─── 页面片段的 schema 与校验 ────────────────────────────────────────────────

const AnnoSchema = z.array(z.string().min(1)).min(2).max(3);

const FragmentSchema = z.object({
  id: z.string().min(1),
  kind: z.preprocess(normalizeKind, z.enum(['page', 'system', 'decision'])),
  title: z.string().min(1),
  frame: z.preprocess(normalizeFrame, z.enum(['phone', 'wide'])).default('phone'),
  html: z.string().default(''),
  anno: z.array(AnnoSchema).default([]),
  /**
   * 后端节点的时序步骤（2026-11-09）。**故意不在这里定形状**：`sequence.ts` 的
   * `normalizeSteps` 已经把三种写法（对象、三元数组、别名参与方）都收下了，而它有
   * 自己的中文报错（第几步、哪个词不在词表里）。在 zod 里再编一套形状校验，
   * 模型会拿到 `steps.0.from：Required` 这种它读不懂的话。
   */
  steps: z.unknown().optional(),
  /**
   * 右栏的两组待确认问题（2026-11-10）。与 `steps` 同一个理由不定形状：
   * `annotations.readOpen` 收得下两种组名别名、对象写法和单条字符串，而它的兜底是
   * 「交空」而不是报错——一条 `open.req: Expected array, received object` 对模型
   * 没有任何指向性，白烧一次 420 秒的调用。
   */
  open: z.unknown().optional(),
});

export const FragmentsSchema = z.object({ nodes: z.array(FragmentSchema).min(1) });

function toAnno(pairs: string[][]): Anno[] {
  return pairs.map((pair) => (pair.length >= 3
    ? [pair[0]!, pair[1]!, pair[2]!] as Anno
    : [pair[0]!, pair[1]!] as Anno));
}

/**
 * 校验一份页面片段回话：JSON 抠得出来 + zod 通过 + **节点全覆盖** + 每条 kind 的义务。
 *
 * 与 `readPages` 同一套覆盖率口径（少一个节点就重来：空壳页面在评审里比「没有这一步」
 * 更误导），多出来的是 kind 的义务：`page` 必须有能看的一屏 html，`system` / `decision`
 * 不许有（它们没有页面，硬画一个就是编），而且**必须给时序步骤**（2026-11-09）：
 * 后端节点没有页面，它的原型就是那张时序图；不给步骤就等于「判了它是服务端的事，却不说
 * 它做了什么」，整份退回（`missingStepsReason`）。上一版这里放过它、交给拼装阶段挂页面，
 * 结果读者把服务端的一步读成「界面上有这一屏」——那次收紧是本轮 Gap 1。
 *
 * 这一层**不查** `wt-*` 类与 emoji：那是 walkmap 契约的事，由 `validateWalkmap` 说，
 * 报错格式也统一在那里（一句话、可重试）。两层分工清楚，错误就不会两处各说一半。
 */
export function readFragments(
  text: string,
  ids: string[],
  /**
   * 要不要**再问一次**「右栏两组待确认」（2026-11-10）。
   *
   * 只有**评估**这一路的第一轮要：v1 承诺的是「三栏材料」，右栏那两栏就是承诺本身，
   * 所以第一次没提到就退回去再问一遍。
   * 评审 / 走查不走这一条——它们的右栏是问题清单 / 差异清单（`review.ts` / `inspect.ts`
   * 会把模型交的标注整片换掉），在这里要求两组待确认等于让它们交一份会被丢掉的东西。
   * 默认 `false`：这个函数有多个调用方，默认值必须是最不改变别人行为的那一个。
   *
   * **它不是死判**：第二轮一条都没有照样收（`buildPages` 只给第一轮传 `true`），
   * 右栏由 `assembleWalkmap` 铺 `emptyOpenRow()`。见那一段的注解。
   */
  opts: { requireOpen?: boolean } = {},
): { ok: true; doc: FragmentDoc } | { ok: false; why: string } {
  // 截断要在解析之前认：截断的 JSON 会让 extractJson 退到内层对象，报成「缺字段」。
  if (answerTruncated(text)) return { ok: false, why: noJsonReason(text) };
  const raw = extractJson<unknown>(text);
  if (raw === null) return { ok: false, why: noJsonReason(text) };

  // 与走查共用同一层形状容错：anno 少一层数组、frame 写成中文、kind 写成"判断"、
  // 顶层写成数组——这些早前只有走查那条路在收，评估材料这条一直裸奔。
  const parsed = FragmentsSchema.safeParse(coerceAnswer(raw, [], ids));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? '结构不对' : `${issue.path.join('.') || '(根)'}：${issue.message}`;
    return { ok: false, why: `JSON 结构不对 —— ${where}` };
  }

  const seen = new Set<string>();
  const nodes: PageFragment[] = [];
  for (const node of parsed.data.nodes) {
    if (seen.has(node.id)) return { ok: false, why: `节点 ${node.id} 写了两遍` };
    seen.add(node.id);

    const html = node.html.trim();
    if (node.kind === 'page') {
      if (html === '') return { ok: false, why: `节点 ${node.id} 是页面，但没有给 html` };
      if (!html.includes('<')) return { ok: false, why: `节点 ${node.id} 的 html 不是 HTML 片段` };
    }

    /**
     * 后端节点的时序步骤（2026-11-09）。**判为后端就必须给步骤**（第三轮收紧的地方）：
     * 上一版这里放过「没有 steps」的节点，由拼装阶段挂到最近的页面节点上——那是为了让
     * 旧材料不变样。代价是一句假话：一步发生在服务端的事，读者会看见一屏界面，于是得出
     * 「这一步在界面上」。现在改成整份退回，理由与措辞见 `missingStepsReason`。
     *
     * 两种错**不混成一句**：没给 steps → 那句话（说清缺什么、该怎么补）；给了但写错 →
     * 「节点 X 的第 2 步：…」（说清是哪一步、哪个词不合格）。前者是义务，后者是写法。
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

    nodes.push({
      id: node.id,
      title: node.title,
      kind: node.kind,
      frame: node.frame,
      html: node.kind === 'page' ? html : '',
      anno: toAnno(node.anno),
      open: readOpen(node.open),
      ...(steps.length > 0 ? { steps } : {}),
    });
  }

  const missing = ids.filter((id) => !seen.has(id));
  if (missing.length > 0) return { ok: false, why: `这些节点没有页面片段：${missing.join('、')}` };
  const extra = [...seen].filter((id) => !ids.includes(id));
  if (extra.length > 0) return { ok: false, why: `多出了图里不存在的节点：${extra.join('、')}` };

  /**
   * 右栏两栏标注（2026-11-10）：**整份一条都没有** → 退回一次，让模型补。
   *
   * 为什么判「整份」而不是「每个节点」：这一层手里有节点清单，能说清是哪个节点缺；
   * 但一份材料里十几个节点，任何一屏都可能真的一个问题都没有（比如那一屏只是展示
   * 一句话）。判到每个节点，一次漏写就整份退回、重烧两分钟，而读者看到的东西一个
   * 字不会变好。
   *
   * **它不是「整份材料的死判」（owner 裁决，同日改）**：这里说「再问一次」，而不是
   * 「这份作废」。区别在调用方——`buildPages` 只在**第一次尝试**要这一条，第二次
   * 一条都没有就照收，右栏铺 `emptyOpenRow()` 那一行（「本版没发现待确认项」）。
   * 理由：模型在两轮里都提不出问题，最可能的原因是这份需求真的写得完整；为它再烧
   * 一个两分钟的调用、把材料判失败，读者一个字也拿不到。空右栏要说话，但不是用
   * 「生成失败」说。
   *
   * 这句话必须说清「补什么」而不是「格式不对」：`open` 是这版新增的字段，模型第一次
   * 很容易整个漏掉——所以第一次问到它时，得说清两组各问什么。
   */
  const asked = nodes.reduce((sum, node) => sum + openCount(node.open), 0);
  if (opts.requireOpen === true && asked === 0) {
    return {
      ok: false,
      why: '右栏的两组待确认一条都没有 —— 每个节点至少要在 open 里给一条：'
        + 'req（待需求方确认：失败怎么办、这次不做什么、验收口径、边界条件）或 '
        + 'dev（待研发确认：这一页有哪些状态、跳去哪里、失败怎么提示）；'
        + '某一组确实没有问题就给空数组 []',
    };
  }


  return { ok: true, doc: { nodes } };
}

// ─── 手机 chrome：归模板，不归模型（2026-11-10）────────────────────────────────

/**
 * 片段里那几个「手机外壳」包装类：改契约之后只该由模板画。
 *
 * 为什么要有这套剥离（而不是只改提示词）：提示词只约束**下一次**生成。旧的提示词还在
 * 缓存包与重试路径里，模型也会自己发挥——它见过别的例子里有 statusbar，就会照抄一份。
 * 两份状态栏叠在一起是最坏的呈现：读者看到两条时间、两组图标，还以为是页面内容。
 * 而这件事没有任何一层会报错（HTML 合法、wt- 类合法），所以只能在这里兜住。
 */
const CHROME_CLASSES = ['wt-statusbar', 'wt-nav'] as const;

/**
 * 把一棵「同标签名元素」从字符串里删掉（配平嵌套），返回删掉之后的新串。
 *
 * 为什么不用 DOM 解析器：这一层没有 DOM（服务端、无依赖），而片段是我们**允许**的
 * 那种片段（wt-* 类、没有脚本）。用配平扫描足够，而且它不会顺手「修好」别的东西——
 * 这一层只该剥外壳，别的字节一个字都不动。
 */
function removeElementByClass(html: string, cls: string): { html: string; removed: boolean } {
  const opener = /<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  for (let m = opener.exec(html); m !== null; m = opener.exec(html)) {
    const attrs = m[2] ?? '';
    const classMatch = /\bclass\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    const classList = classMatch === null ? '' : (classMatch[2] ?? classMatch[3] ?? '');
    if (!classList.split(/\s+/).includes(cls)) continue;
    const tag = m[1]!.toLowerCase();
    const start = m.index;
    const openEnd = start + m[0].length;
    // 自闭合（`<div class="wt-nav" />`）：只吃开标签。
    if (/\/\s*>$/.test(m[0])) {
      return { html: html.slice(0, start) + html.slice(openEnd), removed: true };
    }
    const closer = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    closer.lastIndex = openEnd;
    let depth = 1;
    for (let c = closer.exec(html); c !== null; c = closer.exec(html)) {
      depth += c[1] === '/' ? -1 : 1;
      if (depth === 0) {
        const end = c.index + c[0].length;
        return { html: html.slice(0, start) + html.slice(end), removed: true };
      }
    }
    // 没有配平的收尾：只吃开标签，剩下的留给后面的校验去说——吞掉内容比留个残壳更坏。
    return { html: html.slice(0, start) + html.slice(openEnd), removed: true };
  }
  return { html, removed: false };
}

/** 整段就是一个 `<div class="wt-screen">…</div>` 时，把这层壳去掉（模板会再包一层）。 */
function unwrapScreen(html: string): { html: string; removed: boolean } {
  const text = html.trim();
  // 变量名不叫 opener：同名的正则字面量在另一个函数里带 `g`，而那条「exec 循环必须带 g」
  // 的守卫是按**标识符**认声明的，同名两处会互相覆盖——叫 head 就不会被读成同一条正则。
  const head = /^<div\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i.exec(text);
  if (head === null) return { html, removed: false };
  const classMatch = /\bclass\s*=\s*("([^"]*)"|'([^']*)')/i.exec(head[1] ?? '');
  const classList = classMatch === null ? '' : (classMatch[2] ?? classMatch[3] ?? '');
  if (!classList.split(/\s+/).includes('wt-screen')) return { html, removed: false };
  const closer = /<\/?div\b[^>]*>/gi;
  closer.lastIndex = head[0].length;
  let depth = 1;
  for (let c = closer.exec(text); c !== null; c = closer.exec(text)) {
    depth += c[0].startsWith('</') ? -1 : 1;
    if (depth !== 0) continue;
    const end = c.index + c[0].length;
    if (end !== text.length) return { html, removed: false };  // 壳外面还有东西：不动
    return { html: text.slice(head[0].length, c.index).trim(), removed: true };
  }
  return { html, removed: false };
}

/**
 * 剥掉模型自带的手机外壳，只留内容区（2026-11-10 的契约改动）。
 *
 * 契约现在是「模板画 chrome，模型交内容」：合法的片段从 `<div class="wt-body">` 起，
 * 状态栏与导航栏由模板填。旧片段是 `<div class="wt-screen"><div class="wt-statusbar">…
 * </div><div class="wt-nav">…</div><div class="wt-body">…</div></div>`。这里把前者化成
 * 后者，于是**新旧片段走同一条渲染路径**，产物里永远只有一条状态栏。
 *
 * `parts` 是剥掉了什么（`wt-statusbar` / `wt-nav` / `wt-screen`），调用方据此打一行日志：
 * 一次生成里剥了几处，是「提示词没跟上」还是「缓存包还是旧的」，看这一行就知道。
 */
export function stripPhoneChrome(html: string): { html: string; parts: string[] } {
  const parts: string[] = [];
  let out = html;
  for (const cls of CHROME_CLASSES) {
    // 循环到没有再出现：一份片段里写两条状态栏也照剥（那也是双份）。
    let count = 0;
    for (;;) {
      const step = removeElementByClass(out, cls);
      if (!step.removed) break;
      out = step.html;
      count += 1;
    }
    if (count > 0) parts.push(cls);
  }
  const screen = unwrapScreen(out);
  if (screen.removed) {
    parts.push('wt-screen');
    out = screen.html;
  }
  return parts.length === 0 ? { html, parts } : { html: out.trim(), parts };
}

const CHROME_NOUN: Record<string, string> = {
  'wt-statusbar': '状态栏',
  'wt-nav': '导航栏',
  'wt-screen': '整屏容器',
};

/** 一行日志：这一份材料里剥掉了哪几处模型自带的 chrome（没剥就一个字都不打）。 */
export function stripReportLine(tag: string, stripped: Assembly['stripped']): string {
  const what = stripped
    .map((item) => `${item.id}（${item.parts.map((part) => CHROME_NOUN[part] ?? part).join(' + ')}）`)
    .join('、');
  return `[phone-chrome] ${tag} 已剥掉模型自带的手机 chrome：${what}`;
}

/** 打一行日志并返回剥掉了几份片段数（0 时不占一行，与 `reportDropped` 同口径）。 */
export function reportStripped(tag: string, stripped: Assembly['stripped']): number {
  if (stripped.length === 0) return 0;
  process.stderr.write(`${stripReportLine(tag, stripped)}\n`);
  return stripped.length;
}

// ─── 拼 walkmap：片段 → 契约 JSON ────────────────────────────────────────────

/** 形态在提示词清单里的名字。 */
const KIND_NOUN: Record<NodeKind, string> = { page: '页面', system: '系统', decision: '判断' };

/** 片段内容的**身份**：同一份字节就是同一个页面（去重、成组的唯一依据）。 */
function fragmentKey(html: string): string {
  return html.replace(/\r\n/g, '\n').trim();
}

export type Assembly = {
  walkmap: Walkmap;
  /** 页面 id → 片段原文。`renderWalkthrough` 会把它落成真实文件。 */
  fragments: Record<string, string>;
  /**
   * 拿到时序伪页面的节点（2026-11-09）：`page` 是 `backend-<节点id>`。
   *
   * 为什么要交出来：材料生成之后要能回答「这一份里到底有几张时序图、每张几步」——
   * 那是这次改动唯一可数的证据（报告与日志都用它），从 walkmap 里反推反而要猜。
   */
  sequences: Array<{ node: string; page: string; steps: number }>;
  /**
   * 标注里被搬走的技术词原句（2026-11-09 第二轮）。
   *
   * 走查 / 评审把它搬进末尾「研发参考」；评估那条路**不用它**——评估不读代码，被搬走的
   * 多半是模型想象出来的名字，写进「研发参考」等于把想象写成证据（与坐标那一条同理由）。
   */
  moved: string[];
  /** 标注里清洗**之前**有多少处违规词。这是流水线的失误数，不是材料的缺陷数。 */
  annoRaw: number;
  /** 标注里清洗**之后**还剩多少处（应当恒为 0；不为 0 说明改写/搬走漏了一条路）。 */
  annoLeft: number;
  /**
   * 从片段里剥掉的手机 chrome（2026-11-10）：节点 id + 剥掉了哪几个包装类。
   *
   * 为什么把这件事**交出去**而不是在这里打日志：这个函数是纯函数（同一份片段永远
   * 同一份 walkmap，用例靠它做断言），一行 stderr 会让它不再纯。调用方拿到这个数组，
   * 用 `reportStripped` 打一行——剥掉的东西必须被看见，否则「模板画的」和「模型画的」
   * 又混成一件事。
   */
  stripped: Array<{ id: string; parts: string[] }>;
};

/**
 * 页面片段 → walkmap/1 的 JSON。四条规则，全部写在这里：
 *
 * 1. **一份片段一个页面**：内容完全相同的片段共用同一个 `pages[].id`（id 取第一次
 *    出现的节点 id，前缀 `p-`），所以「同一页」在 walkmap 里只有一个文件。
 * 2. **同一页面被多个页面节点使用 = 一组状态**：组名取这些标题的公共前缀
 *    （「寄养首页 · 未预约」→「寄养首页」），状态的 label 就是节点标题；单状态不建组
 *    （上游硬规则：右侧不放按钮）。推导在 `deriveStateGroups`。
 * 3. **后端节点有自己的时序伪页面**（2026-11-09，本次改动的核心）：`system` / `decision`
 *    节点带了步骤时，给它建一个 `id: backend-<节点id>`、`frame: sequence`、`kind: sequence`
 *    的伪页面，里面是我们确定性排出来的 SVG。点这个节点，中栏换的就是这张图。
 *
 *    这条规则替换掉了原来那句「挂到**前一个**页面节点的页面上」。为什么原来那样做、
 *    现在为什么不做了：原来上游的口径是「无页面的步骤不建节点、动作说明写进前一节点的
 *    标注」；我们的流程图里这种节点已经画出来了，只能挂一个页面上去。但那句话在
 *    **一个页面节点都没有**的流程里是空的——`PAN-815`（纯后端回调）六个节点全是
 *    系统/判断步骤，于是六个节点都挂到空字符串上，`validateWalkmap` 整份拒收
 *    （「引用了不存在的页面「空」」，连试两轮都出不来）。owner 的裁定是「没有页面的
 *    节点不再强行挂页面，改成挂后端流程区块，页面原型那一栏放一张时序图」。
 * 4. **判为后端却没有步骤的节点不留任何页面**（2026-11-09 第三轮删掉的那条兜底）：
 *    原来它会被挂到**最近的页面节点**上（先往前找、再往后找），理由是「旧材料不许因为
 *    这次改动而变样」。那条理由站不住：兜底产出的是一句**假陈述**——一步发生在服务端的事，
 *    读者在左栏点开它，看到的是邻居那一屏，于是得出「这一步在界面上」。它也正是本项目
 *    这一天在清的那一类缺陷。
 *
 *    现在这种节点会以「既没有页面也没有后端流程」被 `validateWalkmap` 拒收（那句旧话在
 *    `walkmap.ts` 第 4 条）。正常生成路径上它更早被拦住：`readFragments` / `readVerify`
 *    用 `missingStepsReason` 整份退回，那句话说得更具体（判为后端流程、缺 steps）。
 *    两句**不合并**：一句说意图与义务，一句说事实。
 *
 * 纯函数：不读磁盘、不看时钟。同一份片段永远得到同一份 walkmap。
 */
export function assembleWalkmap(
  doc: FragmentDoc,
  opts: {
    title: string;
    svg: string;
    /**
     * 「这些节点在图里有前驱」（2026-11-10）：决定手机导航栏画不画回退箭头。
     * 不传就按「除第一个节点外都有」处理——见 `nodes0.forEach` 里那段注解。
     */
    hasPrev?: ReadonlySet<string>;
  },
): Assembly {
  // ── 缺口 / 建议那一档：标注比正文更严（2026-11-09 第二轮）──
  //
  // 为什么在**这里**洗而不是等 `relocateHtmlBody`：`build.py` 把 walkmap 的 JSON 原样塞进
  // `<script>`，而那一层按「正文文本节点」处理时会把脚本整块跳过（不跳过就会把页面脚本
  // 删成残句）。所以标注必须在上游洗——它同时也是唯一知道「哪一行是 verdict、哪一行是
  // 缺口」的地方：verdict 按正文档，其余按缺口档（`sanitizeAnno`）。
  const chrome: Array<{ id: string; parts: string[] }> = [];
  const cleaned = doc.nodes.map((fragment) => {
    // 手机 chrome 的兜底（2026-11-10）：契约改了，模型只交内容区；但旧提示词、缓存包、
    // 或者模型自己发挥，仍会交一份自带 statusbar/nav 的整屏片段。这里把那一层剥掉，
    // **永不静默双份**：一条页面上只能有一条状态栏。剥了什么由调用方打一行日志。
    const stripped = stripPhoneChrome(fragment.html);
    if (stripped.parts.length > 0) chrome.push({ id: fragment.id, parts: stripped.parts });
    const result = sanitizeAnno(fragment.anno);
    const anno = result.rows.map((row): Anno =>
      (row.length >= 3 ? [row[0]!, row[1]!, row[2]!] : [row[0]!, row[1]!]));
    /**
     * 两组待确认也过同一道网（2026-11-10）。它们**不是** `anno` 的一部分，但在右栏里
     * 是同一列文字，读者分不出哪一句归哪条规矩——所以规矩只能有一条：技术词照拦。
     * 清洗之后再 `openRows` 铺行：组标题是我们写的固定文案，不参与清洗（见 `sanitizeOpen`）。
     */
    const open = sanitizeOpen(fragment.open);
    return { fragment: { ...fragment, html: stripped.html }, anno, open: open.rows, result, openResult: open };
  });
  const moved = cleaned.flatMap((item) => item.result.moved);
  const annoRaw = cleaned.reduce((sum, item) => sum + item.result.raw + item.openResult.raw, 0);
  const annoLeft = cleaned.reduce((sum, item) => sum + item.result.left + item.openResult.left, 0);
  /**
   * 右栏最终的行序：先这一屏的事实标注（它说什么），再两组待确认（还差什么决定）。
   * 顺序不能反过来：问题挂在「这一屏有什么」之后才读得懂问的是哪一屏的哪件事。
   *
   * **整份一条待确认都没有时**（owner 裁决，2026-11-10）：右栏铺一行「本版没发现待
   * 确认项」，而不是留一列空白。为什么铺在**每个节点**上、而不是只铺第一个：
   * 右栏是跟着节点走的，读者点到哪一屏就看哪一屏的右栏。只铺一个节点，另外九屏的
   * 右栏依旧是空的——而「点开是空的」正是这条裁决要修的那件事。
   *
   * 这一行是**我们的固定文案**（`emptyOpenRow`），与组标题同一条规矩：不过 `sanitize`
   * 那道网，因为里面不归模型写。
   */
  const noOpenAtAll = cleaned.reduce((sum, item) => sum + openCount(item.open), 0) === 0;
  const stand: Anno[] = noOpenAtAll ? [emptyOpenRow()] : [];
  const nodes0: PageFragment[] = cleaned.map((item) => ({
    ...item.fragment,
    anno: [...item.anno, ...openRows(item.open), ...stand],
  }));

  const pageOf = new Map<string, string>();
  const pages: PageInput[] = [];
  const fragments: Record<string, string> = {};

  const nodes: NodeInput[] = [];
  const sequences: Array<{ node: string; page: string; steps: number }> = [];

  nodes0.forEach((fragment, index) => {
    if (fragment.kind !== 'page' || fragment.html === '') {
      // ① 后端节点带步骤 → 它自己的时序伪页面（本次改动的核心，见上面规则 3）。
      const steps = fragment.steps ?? [];
      if (steps.length > 0) {
        const pageId = `backend-${fragment.id}`;
        const html = renderSequencePage(steps, fragment.title);
        pages.push({ id: pageId, frame: 'sequence', html, kind: 'sequence' });
        fragments[pageId] = html;
        sequences.push({ node: fragment.id, page: pageId, steps: steps.length });
        nodes.push({
          id: fragment.id,
          title: fragment.title,
          kind: fragment.kind,
          page: pageId,
          anno: fragment.anno,
        });
        return;
      }

      // ② 判为后端却没有步骤 → **不留任何页面**（规则 4）：兜底挂页面会说假话。
      //    这里不抛：`assembleWalkmap` 是纯函数，它只把事实摊开（这个节点没有落点），
      //    由 `validateWalkmap` 用一句能照着改的中文拒收。生成路径上更早的一句话在
      //    `readFragments` / `readVerify`（`missingStepsReason`）。
      nodes.push({ id: fragment.id, title: fragment.title, kind: fragment.kind, anno: fragment.anno });
      return;
    }

    const key = fragmentKey(fragment.html);
    let pageId = pageOf.get(key);
    if (pageId === undefined) {
      pageId = `p-${fragment.id}`;
      pageOf.set(key, pageId);
      pages.push({ id: pageId, frame: fragment.frame, html: fragment.html });
      fragments[pageId] = fragment.html;
    }

    /**
     * 回退箭头归模板（2026-11-10）：只在这一页**确实有前驱**时给。
     *
     * `opts.hasPrev` 由调用方从图里算好（`parseFlow` 的 `prev`）；没有传的时候退回
     * 「不是第一个节点」——`inspect` 那条路的主干是一条线性链，根就是第一个，这个退路
     * 与精确答案同值。两条都只有一个目的：首页不许出现一个点不回去的箭头。
     */
    const back = opts.hasPrev === undefined ? index > 0 : opts.hasPrev.has(fragment.id);
    const node: NodeInput = {
      id: fragment.id,
      title: fragment.title,
      kind: 'page',
      page: pageId,
      anno: fragment.anno,
      ...(back ? { back: true } : {}),
    };
    nodes.push(node);
  });

  return {
    walkmap: buildWalkmap({ title: opts.title, svg: opts.svg, nodes, pages }),
    fragments,
    sequences,
    moved,
    annoRaw,
    annoLeft,
    stripped: chrome,
  };
}

// ─── mermaid 的取文、解析与形状 ──────────────────────────────────────────────

const FENCE = /```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)```/;
const HEADER = /^(flowchart|graph)\s+(TD|TB|BT|LR|RL)\s*;?$/i;

/** 一行里出现了节点声明（`A["x"]` / `A{"x"}` / `A[["x"]]`）。 */
const DECLARES = /^[A-Za-z0-9_]+\s*\[\[|^[A-Za-z0-9_]+\s*[\[{]/;
const CLASS_LINE = /^class\s+[A-Za-z0-9_,\s]+$/;

/**
 * 从模型的回话里取出 mermaid 正文。
 *
 * 四步，每一步都对应一种真实的回话形状：
 * 1. 有围栏就取围栏里的（模型最爱干的事）；围栏是它**明确标注**的代码块。
 * 2. 找到第一行 `flowchart TD`（或 `graph TD`），丢掉它前面的开场白。
 * 3. 从那一行往下只收「像 mermaid」的行：空行、含 `-->`、节点声明、`class ...`。
 *    第一条不像的就停——**这一段是防坑的关键**：引擎会把「以上就是这张图」当成一个
 *    节点（`nodes` 加一），于是一段垃圾也能过计数。
 * 4. 没有 `flowchart` 行就整段返回并补一行表头（模型常忘了写），让引擎去说它哪里不对。
 */
export function mermaidIn(text: string): string {
  const fenced = FENCE.exec(text);
  const body = (fenced === null ? text : (fenced[1] ?? '')).replace(/\r\n/g, '\n');
  const lines = body.split('\n');

  const start = lines.findIndex((line) => HEADER.test(line.trim()));
  if (start < 0) {
    const kept = lines.filter((line) => {
      const line2 = line.trim();
      return line2 === '' || line2.includes('-->') || DECLARES.test(line2) || CLASS_LINE.test(line2);
    });
    return ['flowchart TD', ...kept].join('\n').trim();
  }

  const out = [lines[start]!.trim()];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (line === '' || line.includes('-->') || DECLARES.test(line) || CLASS_LINE.test(line)) {
      out.push(line);
      continue;
    }
    break;
  }
  return out.join('\n').trim();
}

/** 节点声明：id + 括号 + 引号里的文案。`[[` 要先于 `[` 匹配。 */
const NODE_DECL = /([A-Za-z0-9_]+)\s*(\[\[|\[|\{)\s*"([^"]*)"\s*(\]\]|\]|\})/g;

function decodeLabel(text: string): string {
  return text.replace(/<br\s*\/?>/gi, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * 解析一份（已通过检查的）mermaid：节点（id/文案/形态）与连线数。
 *
 * 为什么自己解析而不是问引擎：引擎的报告里有 `nodes` 与 `edges` 两个**数字**，没有
 * 文案；而提示词 2 与左侧节点列表要的正是「id + 文案」。同一份文本解析一次，图、
 * 列表、提示词三处就永远一致。
 *
 * 文案里可能出现的 `<br>` 折行在这里压成空格：它在 SVG 里是换行，在 HTML 里是
 * 一行字，压平之后两处读起来是同一句话。
 */
/**
 * 把一行里串起来的链拆成两两一条边。
 *
 * 为什么必须有：模型很爱写 `A --> B --> C`（132 次调用里出现 2 格），mermaid 本身
 * 允许，但**排版引擎只认一行一条边**——直接喂进去，整张图被拒，一次调用白花。
 * 这是**等价改写**，不改语义：链 a→b→c 就是两条边。
 * 边标签跟着它所在的那一段走：`A -->|是| B -->|否| C` = A→B 是、B→C 否。
 */
export function normalizeMermaid(mermaid: string): string {
  const out: string[] = [];
  for (const raw of mermaid.split('\n')) {
    const line = raw.trim();
    if (line === '' || !line.includes('-->')) { out.push(raw); continue; }
    const parts = line.split('-->');
    if (parts.length <= 2) { out.push(raw); continue; }
    const strip = (part: string): { label: string; body: string } => {
      const t = part.trim();
      const m = /^(\|[^|]*\|)\s*(.*)$/.exec(t);
      return m === null ? { label: '', body: t } : { label: m[1]!, body: m[2]!.trim() };
    };
    const parts2 = parts.map(strip);
    for (let i = 0; i < parts2.length - 1; i++) {
      const left = parts2[i]!.body;
      const next = parts2[i + 1]!;
      // 标签属于"从左边指向右边"的那条边，所以取右段的标签前缀。
      const label = next.label === '' ? '' : next.label;
      out.push(`${left} -->${label === '' ? '' : label} ${next.body}`);
    }
  }
  return out.join('\n');
}

export function parseFlow(mermaid: string): FlowShape {
  mermaid = normalizeMermaid(mermaid);
  const byId = new Map<string, FlowNode>();
  const order: string[] = [];

  const note = (id: string, label?: string, kind?: FlowNode['kind']): void => {
    const known = byId.get(id);
    if (known === undefined) {
      byId.set(id, { id, label: label ?? id, kind: kind ?? 'process' });
      order.push(id);
      return;
    }
    // 后出现的声明补齐文案/形态：`A --> B` 先出现时只有 id。
    if (label !== undefined && label !== '') known.label = label;
    if (kind !== undefined) known.kind = kind;
  };

  NODE_DECL.lastIndex = 0;
  for (let match = NODE_DECL.exec(mermaid); match !== null; match = NODE_DECL.exec(mermaid)) {
    const id = match[1]!;
    const open = match[2]!;
    const label = decodeLabel(match[3] ?? '');
    const kind: FlowNode['kind'] = open === '[[' ? 'backend' : open === '{' ? 'decision' : 'process';
    note(id, label, kind);
  }

  let edges = 0;
  /**
   * 谁指向谁（2026-11-10）。只留下每个节点的**前驱 id**：手机 chrome 的回退箭头要说
   * 「这一页在流程里有没有上一步」，而这个事实只有图知道。链 `A --> B --> C` 在这里已经
   * 被 `normalizeMermaid` 拆成两两一条，所以逐段相邻取一对就是全部边。
   */
  const preds = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    if (from === to) return;
    const list = preds.get(to) ?? [];
    if (!list.includes(from)) list.push(from);
    preds.set(to, list);
  };
  const idsIn = (line: string): string[] => line.split('-->')
    // `-->|是| C`：`|` 那一节是边标签，不是节点 id。
    .map((part) => /^([A-Za-z0-9_]+)/.exec(part.replace(/^\|[^|]*\|/, '').trim())?.[1])
    .filter((id): id is string => id !== undefined);

  for (const raw of mermaid.split('\n')) {
    const line = raw.trim();
    if (line === '' || HEADER.test(line) || CLASS_LINE.test(line)) continue;
    const parts = line.split('-->');
    if (parts.length === 1) continue;
    edges += parts.length - 1;
    const ids = idsIn(line);
    for (let i = 0; i < ids.length - 1; i += 1) link(ids[i]!, ids[i + 1]!);
    for (const id of ids) note(id);
  }

  return {
    nodes: order.map((id) => {
      const node = byId.get(id)!;
      const prev = preds.get(id);
      return prev === undefined ? node : { ...node, prev };
    }),
    edges,
  };
}

// ─── 小工具 ──────────────────────────────────────────────────────────────────

/** 标题/类型里的换行会把提示词的分节改写掉，先压成单行。 */
export function flat(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

export function addUsage(total: ComposeUsage, usage?: { prompt?: number; completion?: number }): ComposeUsage {
  return {
    prompt: total.prompt + (usage?.prompt ?? 0),
    completion: total.completion + (usage?.completion ?? 0),
  };
}

const ENV_KEYS = ['FLOWERS_PROVIDER_BASE_URL', 'FLOWERS_PROVIDER_API_KEY', 'FLOWERS_PROVIDER_MODEL'] as const;

/**
 * 「没配模型接口」这句话，**点名缺哪一项**。
 *
 * `resolveProviderConfig()` 只在三格齐全时给配置、否则给 null，所以它不告诉我们缺的是
 * 哪一格。用户要的是「我该去哪儿填」，不是「未配置」四个字：这里逐个看环境变量，
 * 把空的那几个名字直接写进消息里，并指出库里也没有完整三格。
 */
export function missingProviderText(): string {
  const absent = ENV_KEYS.filter((key) => (process.env[key] ?? '').trim() === '');
  const names = absent.length > 0 ? absent.join('、') : ENV_KEYS.join('、');
  return `未配置模型接口：${names} 没有设置，库里也没有完整的「接口地址 + API Key + 模型名」。`
    + '平台统一模型只对超管本人开放——请到「设置 · 我的 → 模型」填自己的接口地址、API Key 与模型名。';
    + '在「设置」里填这三格，或用这三个环境变量注入之后再试。';
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

export async function loadRequirement(db: Db, requirementId: string): Promise<RequirementRow> {
  const res = await db.execute<RequirementRow>(sql`
    select id, number, title, type, requester, prd_url,
           context, problem, outcome, surfaces, edge_cases, out_of_scope, platforms, priority
      from requirements
     where id = ${requirementId} and deleted_at is null`);
  const row = res.rows[0];
  if (!row) throw new AppError('not_found', '需求不存在');
  return { ...row, number: Number(row.number) };
}

/**
 * 图这一关：问 → 验（引擎 + 形状）→ 不行就带着引擎原文再问，最多 3 次。
 *
 * 导出给 `review.ts` 复用：评审的第一段与评估**是同一件事**（同一份 `flowPrompt(req,
 * 'review')`、同一套形状判据、同三格计数全 0 的验收），只是第三段不同。抄一份实现
 * 就等于让两条路的「图算不算合格」慢慢分叉——那是两份材料里最不该有差别的一处。
 *
 * 两次失败的语义刻意分开，因为它们要喂给模型的话完全不同：
 * - **引擎拒**（`ok:false`）：语法/形态/布局问题，要它「改简单」；
 * - **形状太小**（引擎说 ok，但节点 < 3 或连线 < 2）：语法的垃圾也能过计数，
 *   要它「补出最小骨架」。
 * 两者同时成立时两句都写进去——模型一次只修一半的代价是又一轮 90 秒。
 *
 * P2.13：**每一次调用都留一行痕**（`trace`）。原来只有最后一句话活着（`uemaster_jobs.error`），
 * 于是「三次都画不对」与「一次都没发出去」在界面上长得一模一样。留痕不改变判据、
 * 不改变重试预算、不改变最终那句话——它只是把每一次的结果抄一份到旁边。
 */
export async function buildFlow(
  cfg: ProviderConfig,
  req: RequirementRow,
  stage: Stage,
  deps: ComposeDeps,
  usage: ComposeUsage,
  trace: Trace,
  known: KnownSurfaces = EMPTY_SURFACES,
): Promise<{
  mermaid: string;
  check: FlowCheck;
  attempts: number;
  usage: ComposeUsage;
  /**
   * 模型在这一版里**主动删掉**的步骤（`已删去：…` 那几行，见 `FLOW_DROP_RULE`）。
   *
   * 为什么要交出来：删掉一个 PRD 里写过的步骤而没人知道，读者会以为材料漏了。这一格
   * 让调用方打一行日志交代清楚，不用去比对 PRD 才知道少了什么。
   */
  dropped: string[];
}> {
  let prompt = flowPrompt(req, stage, known);
  let spent = usage;

  for (let attempt = 1; attempt <= MAX_FLOW_ATTEMPTS; attempt += 1) {
    const started = Date.now();
    const reply = await deps.complete(cfg, prompt, { maxTokens: FLOW_MAX_TOKENS, timeoutMs: CALL_TIMEOUT_MS });
    const ms = Date.now() - started;
    const promptChars = prompt.length;
    // 接口层的失败**不消耗**修图次数，也不改写：它不是「图不好」，重试也不会变好。
    // 但它是一行要留的痕：`output_chars: 0` + 服务端原文，正是「这一次什么都没回来」。
    if (!reply.ok) {
      await trace.write({
        attempt, phase: 'flow', promptChars, outputChars: 0, error: reply.error, ms,
      });
      throw new AppError('provider_error', reply.error);
    }
    spent = addUsage(spent, reply.usage);

    const mermaid = mermaidIn(reply.text);
    // 「已删去：…」是回话里图之外的那几行（`mermaidIn` 会在第一条不像 mermaid 的行处停下，
    // 所以它们不会污染图）；只在这一版被接受时交出去，前几版的删改记录已经不生效了。
    const dropped = droppedNotesIn(reply.text);
    const shape = parseFlow(mermaid);
    const check = await deps.render(mermaid);
    const tooSmall = shape.nodes.length < MIN_NODES || shape.edges < MIN_EDGES;

    const why = [
      check.ok ? '' : engineText(check),
      tooSmall ? shapeText(shape) : '',
    ].filter((part) => part !== '').join('；');

    await trace.write({
      attempt,
      phase: 'flow',
      promptChars,
      outputChars: reply.text.length,
      // 通过的那一次 error 为 null：抽屉里「第 2 次 · flow · 1203 字」读起来是「这次成了」。
      error: check.ok && !tooSmall ? null : why,
      ms,
    });

    if (check.ok && !tooSmall) {
      return { mermaid, check, attempts: attempt, usage: spent, dropped };
    }

    if (attempt === MAX_FLOW_ATTEMPTS) {
      throw new AppError(
        'flow_rejected',
        `流程图 ${MAX_FLOW_ATTEMPTS} 次都没通过检查：${why}`,
      );
    }
    prompt = repairPrompt(req, stage, { mermaid, check, shape }, known);
  }

  // 循环不可能走到这里（最后一次一定 return 或 throw）；留着是为了让类型收敛。
  throw new AppError('flow_rejected', '流程图没有通过检查');
}

/**
 * 页面片段这一关：问 → 读（zod + 全覆盖）→ 拼 walkmap → 校验（build.py 的规则镜像）
 *
 * 同样导出给 `review.ts`：评审的第三段要的是**同一版式**的 UEmaster 三栏页（owner：
 * 展示要与 UEmaster 一致，不要自己改版式），差别只在右栏标注的内容由问题清单改写。
 * → 不合规就带着**那一句话**再问一次。
 *
 * 为什么把「拼装 + 校验」放进重试循环里：模型交的东西有两种坏法——JSON 形状不对
 * （`readFragments` 说），和 JSON 合法但 walkmap 不合格（`validateWalkmap` 说，
 * 例如某页没有片段、片段没用 `wt-*` 类、状态组只剩一个状态）。对模型而言这两种
 * 都是「这份哪里不合规」，修法也一样：整份重发。所以它们共用一次重试预算，
 * 也共用同一句 `why`。
 *
 * 为什么**先校验再 spawn**：spawn 一个 Python 进程去解释一份已经知道是错的东西，
 * 只会在错误信息前面多一层 `Traceback`。校验过了再交给 build.py，它的报错就只
 * 剩「我们自己的 bug」这一类。
 */
export async function buildPages(
  cfg: ProviderConfig,
  req: RequirementRow,
  stage: Stage,
  nodes: FlowNode[],
  flow: { svg: string },
  deps: ComposeDeps,
  usage: ComposeUsage,
  trace: Trace,
  known: KnownSurfaces = EMPTY_SURFACES,
): Promise<{ assembly: Assembly; warnings: string[]; usage: ComposeUsage }> {
  const ids = nodes.map((node) => node.id);
  // 回退箭头只认图（2026-11-10）：有入边的节点才算「有上一步」，首页因此没有箭头。
  const hasPrev = new Set(nodes.filter((node) => (node.prev ?? []).length > 0).map((node) => node.id));
  const title = `PAN-${req.number}「${flat(req.title)}」${NOUN[stage]}`;
  let prompt = fragmentsPrompt(req, stage, nodes, known);
  let spent = usage;
  let why = '';

  for (let attempt = 1; attempt <= MAX_PAGES_ATTEMPTS; attempt += 1) {
    const started = Date.now();
    const reply = await deps.complete(cfg, prompt, { maxTokens: FRAGMENTS_MAX_TOKENS, timeoutMs: CALL_TIMEOUT_MS });
    const ms = Date.now() - started;
    const promptChars = prompt.length;
    if (!reply.ok) {
      await trace.write({
        attempt, phase: 'pages', promptChars, outputChars: 0, error: reply.error, ms,
      });
      throw new AppError('provider_error', reply.error);
    }
    spent = addUsage(spent, reply.usage);

    // 两条待确认那一条**只在第一轮**要求（2026-11-10，owner 裁决）。
    //
    // 第二轮还是要这样问，但一条都没提到就**照收**：模型两轮都提不出问题，最可能的
    // 原因是这份需求本身写得完整。为它把整份材料判死，读者一个字都拿不到；而空右栏
    // 的那件事已经由 `assembleWalkmap` 用一行「本版没发现待确认项」说清楚了。
    // 结构性坏掉（少节点、JSON 不对、没有页面也没有步骤）不在这条豁免里——那些
    // 仍然在每一轮都判退，因为它们是「这份东西读不了」，不是「这一栏空着」。
    const read = readFragments(reply.text, ids, {
      requireOpen: stage === 'evaluate' && attempt === 1,
    });
    let passed: { assembly: Assembly; warnings: string[] } | null = null;
    if (!read.ok) {
      why = read.why;
    } else {
      const assembly = assembleWalkmap(read.doc, { title, svg: flow.svg, hasPrev });
      const report = validateWalkmap(assembly.walkmap, { svg: flow.svg, fragments: assembly.fragments });
      if (report.ok) {
        // 剥过模型自带的手机 chrome 就打一行（没剥不占行）：这一行是流水线的交代，
        // 与 `[flow-drop]` 同口径——不拦材料，但复核的人得看得见。
        reportStripped(`PAN-${req.number} ${stage}`, assembly.stripped);
        passed = { assembly, warnings: report.warnings };
      }
      // 校验器的原话直接当 `why`：它就是我们要在界面上说的那一句。
      else why = report.errors.join('；');
    }

    await trace.write({
      attempt,
      phase: 'pages',
      promptChars,
      // 回话长度不是「有效的页面数」：一份被拒的 JSON 也照样有长度，那正是要看的东西
      // （`output_chars` 很大 + 被拒 = 形状错了；= 0 = 模型什么都没答）。
      outputChars: reply.text.length,
      error: passed === null ? why : null,
      ms,
    });

    if (passed !== null) return { ...passed, usage: spent };

    if (attempt === MAX_PAGES_ATTEMPTS) break;
    prompt = fragmentsRepairPrompt(req, stage, nodes, reply.text, why, known);
  }

  throw new AppError(
    'pages_rejected',
    `页面片段 ${MAX_PAGES_ATTEMPTS} 次都没通过校验：${why}`,
  );
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

/**
 * 把一条需求做成一份**查过**的评估材料，落盘、attach、返回站内路径。
 *
 * 顺序是硬的：先拿配置（没有就点名缺什么）→ 图（3 次上限，验过才收）→ 页面片段
 * （2 次上限，JSON + walkmap 契约）→ **build.py 出 HTML** → 写文件 → `attachArtifact`。
 *
 * 材料本身不再是我们的模板：第二段之后的 HTML 由 vendored 的 `build.py` 产出，
 * 与 UEmaster 的 flow-walkthrough 技能的产物是同一份实现、同一套样式。我们这一侧
 * 只负责「把模型交的片段拼成契约要求的样子」，以及「在 spawn 之前把话说清楚」。
 *
 * 为什么写文件在 attach 之前：`attachArtifact` 会 stat 站内链接（没有文件就是
 * `artifact_missing`）。文件先落地，这一步就只剩「验 + 记」。
 *
 * 2026-11-10 起它**不改需求状态**（以前 attach 会在同一个事务里把 inbox 推到待设计）：
 * 生成材料只是一个动作，立项是另一个动作。所以这里也不再有「材料落地但迁移失败」
 * 那种半成品要回滚——文件写出去就是一份历史版本，产物行记下来就是一次发生过的生成。
 *
 * 失败一律抛 `AppError`：`runJob` 接住它写进 `uemaster_jobs.error`，用户看到的就是
 * 这句话。所以每一句都必须说清「哪里不行」，不能出现「生成失败」四个字。
 */
export async function composeEvaluation(
  db: Db,
  actor: string,
  request: ComposeRequest,
  deps: Partial<ComposeDeps> = {},
): Promise<ComposeOutcome> {
  if (!isStage(request.stage)) {
    throw new AppError('invalid_stage', '阶段只能是 evaluate、review、inspect 之一');
  }
  const requirementId = parseRequirementId({ requirementId: request.requirementId });
  const stage = request.stage;
  const full: ComposeDeps = { ...LIVE, ...deps };

  const cfg = await full.resolveConfig();
  if (cfg === null) throw new AppError('provider_unconfigured', missingProviderText());

  const req = await loadRequirement(db, requirementId);
  /**
   * 这次生成是照着哪一版描述做的（P4-02）：在**读完需求**的这一刻取指纹，然后一路
   * 带到 `attachArtifact`。attach 要跑完 2–3 分钟才发生，那时现算会得到一个「照着
   * 新版做的」的假结论（见 `requirements/fingerprint.ts` 文件头）。
   */
  const inputHash = fingerprintOfRow(req);
  let usage: ComposeUsage = { prompt: 0, completion: 0 };

  // 留痕的笔：作业 id 从请求来（用例里没有作业，笔就是空写）。模型名绑在笔上——
  // 一次作业里所有调用用的是同一份配置，跟着每次调用传一遍只多一处能写错的地方。
  const trace = makeTrace(db, request.jobId ?? null, cfg.model);

  /**
   * 现有页面清单（任务 4）：只在这里读一次，图与页面片段两段共用同一份。
   * 读失败 → 空数组 → 提示词里整段不写（见 `loadKnown` 与 `surfacesBlock`）。
   *
   * v1（2026-11-10）：**评估默认不读代码索引**（`FEATURE_EVALUATE_READS_CODE` 默认关）。
   * 理由不是性能，是诚实：那份清单说的是「代码里现在有哪些页面、每页有什么组件」，
   * 而 v1 的评估材料只承诺「按需求描述推出来的流程」。把清单掺进来，材料里就会出现
   * 「现有页面：/pages/share/index」这种**没人核对过的断言**——索引可能旧了一周，
   * 而读者会把它当现状。清单为空时 `surfacesBlock` 整段不写，于是提示词里
   * 一个字都不提「代码里现在怎么做的」，v1 的承诺因此成立。
   */
  const known = await knownForEvaluate(full);

  const flow = await buildFlow(cfg, req, stage, full, usage, trace, known);
  usage = flow.usage;
  // 模型删掉了不属于产品流程的步骤 → 打一行交代（删了什么、删了几步）。
  // 这一行不是「警告」也不是「失败」：删对了就是对的，只是复核的人得看得见。
  reportDropped(`PAN-${req.number} ${stage}`, flow.dropped);

  const svg = flow.check.svg ?? '';
  // 节点清单只解析一次：提示词 2、拼 walkmap、日志都用它，三处不会漂。
  const nodes = parseFlow(flow.mermaid).nodes;
  const pages = await buildPages(cfg, req, stage, nodes, { svg }, full, usage, trace, known);
  usage = pages.usage;

  const buildStarted = Date.now();
  const built = await full.build(pages.assembly.walkmap, {
    svg,
    fragments: pages.assembly.fragments,
  });
  const buildMs = Date.now() - buildStarted;
  // 构建也要留痕：它是三段里唯一一段「模型都对、但产物还是出不来」的失败
  // （`build.py` 的 Traceback、emoji、契约不符）。`prompt_chars` 记 0——这一段没有提示词，
  // 输入是 walkmap 不是文字；`output_chars` 是它吐出来的 HTML 长度（失败时通常为 0）。
  await trace.write({
    attempt: 1,
    phase: 'build',
    promptChars: 0,
    outputChars: built.html?.length ?? 0,
    error: built.ok && built.html !== undefined
      ? null
      : (built.error ?? built.errors.join('；')),
    ms: buildMs,
  });
  if (!built.ok || built.html === undefined) {
    throw new AppError('walkmap_rejected', `走查页构建失败：${built.error ?? built.errors.join('；')}`);
  }

  /**
   * 产物落到**版本化的文件名**（2026-11-10 owner 的第一次纠正）：`evaluate-v003.html`。
   *
   * 以前是写死的 `evaluate.html`：重做一次就把上一份覆盖掉，而库里照样多一行——库说
   * 「两版」，盘上只有一份。材料不可重建，覆盖就是丢（见 `versions.ts` 文件头）。
   * 版本号取「库里行数」与「盘上最大版本号」的大者 + 1，所以既不会覆盖历史，也不会
   * 与一次失败留下的孤儿文件撞名。
   */
  const version = await nextArtifactVersion(db, requirementId, req.number, stage);
  const file = versionedFileOf(req.number, stage, version);
  await mkdir(path.dirname(file), { recursive: true });
  /**
   * 正文那一层（2026-11-09）：页面片段与标注都是给 PM 读的，所以先过 `relocateHtmlBody`
   * 把代码坐标剥掉。**这一条路没有「研发参考」**：评估的输入是需求本身（PRD 只是额外
   * 依据），它**不读代码**，因此没有任何一个坐标是经过核对的。
   *
   * 于是这里只剥、不搬：被剥掉的那些路径不能出现在末尾的「研发参考」里——那一节是给
   * 研发照着点开的证据，而这一条路上它们全是模型的想象（它连仓都没读）。把想象写成
   * 证据，比正文里有一句研发黑话坏得多。剥掉之后正文就只剩产品语言，这正是评估材料
   * 该有的样子；确实需要坐标的读者去看评审或走查材料。
   */
  const dropped: string[] = [];
  const html = relocateHtmlBody(built.html, dropped);
  /**
   * 可数指标（2026-11-09 第二轮）：模型这一版写了多少处实现词、剥完之后还剩几处。
   *
   * 计数口径与材料里读者看到的一致——正文文本节点（跳过属性、`<script>`、`<style>`），
   * 再加上标注那一档（`assembly.annoRaw` / `annoLeft`，那一档在 `assembleWalkmap` 里
   * 已经按缺口档洗过）。>0 就是流水线的失误：材料照出（本仓吃够了「整份不出」的苦），
   * 但这个数必须留在日志与 `stats` 里。
   */
  const vocabHits = pages.assembly.annoRaw + countHtmlBodyHits(built.html);
  const vocabLeft = pages.assembly.annoLeft + countHtmlBodyHits(html);
  reportVocab(`PAN-${req.number} ${stage}`, vocabHits, vocabLeft);
  await writeFile(file, html, 'utf8');

  const url = artifactUrl(file);
  const artifact = await attachArtifact(db, actor, { requirementId, stage, url, inputHash });

  return { url, attempts: flow.attempts, usage, artifactId: artifact.id, vocabHits, vocabLeft };
}
