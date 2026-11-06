import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { parseRequirementId } from '../validate.js';
import { attachArtifact } from './attach.js';
import { renderFlowchart, type FlowCheck } from './flow.js';
import { isStage, type Stage } from './packs.js';
import {
  complete, extractJson, resolveProviderConfig,
  type ProviderConfig, type ProviderResult,
} from './provider.js';
import { ARTIFACT_ROOT, artifactUrl } from './store.js';
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
export const CALL_TIMEOUT_MS = 90_000;

/** 一段 mermaid 用不了多少 token；给多了只会让模型开始写解释。 */
const FLOW_MAX_TOKENS = 900;

/**
 * 页面片段的预算：N 屏 HTML + 标注。
 *
 * 比上一版（3000）翻倍，因为现在每屏都是**真的 HTML**（状态栏、导航、卡片、弹窗…），
 * 一屏 300–500 token 很正常，5 个页面节点就吃掉旧预算。给少了模型会开始截断，
 * 截断的 HTML 又会被 `wt-` 类校验拒掉——那是一次白花的调用。
 */
const FRAGMENTS_MAX_TOKENS = 6000;

/** 形状判据（与本文件头「判据 1」对应）。上限刻意不判：图更大不是错。 */
const MIN_NODES = 3;
const MIN_EDGES = 2;

/** 阶段 → 材料名。与 `packs.ts` 的 `noun` 同口径，但这里是给模型看的。 */
const NOUN: Record<Stage, string> = { evaluate: '评估材料', review: '评审材料', inspect: '走查材料' };

/** 阶段 → 这份材料要回答的问题。写进提示词，模型才知道该往哪儿使劲。 */
const FOCUS: Record<Stage, string> = {
  evaluate: '讨论可行性——「这一步到底有没有页面、这么走通不通」',
  review: '把 PRD 完整走一遍——评审就是照着它一步一步过，走不通的地方要看得出来',
  inspect: '拿实现跟 PRD 对比——流程要按真实存在的页面画，不要照 PRD 修图',
};

// ─── 依赖（测试注入用） ──────────────────────────────────────────────────────

export type ComposeDeps = {
  complete: (cfg: ProviderConfig, prompt: string, opts?: { maxTokens?: number; timeoutMs?: number }) => Promise<ProviderResult>;
  render: (mermaid: string) => Promise<FlowCheck>;
  resolveConfig: () => Promise<ProviderConfig | null>;
  /** 拼好的 walkmap → HTML。真实实现是 vendored 的 `build.py`（子进程）。 */
  build: (walkmap: Walkmap, assets: WalkmapAssets) => Promise<BuildResult>;
};

/** 真实的四个依赖：真 HTTP、真 Python 排版器、真配置解析、真 walkmap 构建器。 */
const LIVE: ComposeDeps = {
  complete,
  render: (mermaid) => renderFlowchart(mermaid),
  resolveConfig: resolveProviderConfig,
  build: (walkmap, assets) => renderWalkthrough(walkmap, assets),
};

// ─── 入参与出参 ──────────────────────────────────────────────────────────────

export type ComposeRequest = { requirementId: string; stage: Stage };

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
};

type RequirementRow = {
  id: string;
  number: number;
  title: string;
  type: string;
  requester: string;
  prd_url: string | null;
};

// ─── 提示词 1：只要一段 mermaid ──────────────────────────────────────────────

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
export function flowPrompt(req: RequirementRow, stage: Stage): string {
  const prd = req.prd_url === null
    ? '未提供（照需求标题与类型推断；推断的地方不要假装有依据）'
    : req.prd_url;

  return [
    '你是需求流程建模助手。把下面这条需求画成一张业务流程图（mermaid），只输出 mermaid 源码。',
    '',
    '需求：',
    `  · 编号：PAN-${req.number}`,
    `  · 标题：${flat(req.title)}`,
    `  · 类型：${flat(req.type)}`,
    `  · 提出人：${flat(req.requester)}`,
    `  · PRD：${flat(prd)}`,
    `  · 这次要做的是${NOUN[stage]}：${FOCUS[stage]}`,
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
    ' 7. 不要 ``` 代码围栏。第一行就是 flowchart TD，最后一行是最后一条连线。',
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
    '',
    '其余规则不变：第一行 flowchart TD；3–8 个节点；单主干 + 右分支；判断出边带「是」「否」；',
    '不要代码围栏、不要解释文字，只输出修好后的 mermaid 源码。',
  ].join('\n');
}

// ─── 提示词 2：页面片段（上游 walkmap 契约的输入） ──────────────────────────

/** 图里解析出来的一个节点。`kind` 决定它该画页面还是只写标注。 */
export type FlowNode = { id: string; label: string; kind: 'process' | 'decision' | 'backend' };

/** 模型交回来的一份页面片段。`html` 我们**一个字都不改**，原样写进临时目录。 */
export type PageFragment = {
  id: string;
  title: string;
  kind: NodeKind;
  frame: Frame;
  /** `kind=page` 时是 body 内的片段；`system` / `decision` 是空串（它们没有页面）。 */
  html: string;
  anno: Anno[];
};

export type FragmentDoc = { nodes: PageFragment[] };

/** 图里的节点形态 → 契约里的节点形态。后台环节在上游叫 system。 */
export function kindOf(node: FlowNode): NodeKind {
  if (node.kind === 'decision') return 'decision';
  if (node.kind === 'backend') return 'system';
  return 'page';
}

/**
 * 提示词 2：每个节点交一份**页面片段**，不再是我们的私有 JSON。
 *
 * 为什么把 `page-guide.md` 的规则**抄进提示词**：模型读不到仓库里的文件。而这一版
 * 材料要过的关是上游的 `build.py`——它只认 `wt-*` 组件类、只认 375 / 690 两种宽度、
 * 见到 emoji 直接拒。这些规则写不进提示词，模型就会交一份自认为漂亮的 HTML，然后在
 * 校验那一步被整份打回。规则下面那些**会变的部分**（节点清单、状态、编号）才是每次
 * 不同的东西。
 *
 * 为什么 `system` / `decision` 只交标注：上游 SKILL.md 的原则是「无页面的步骤不建
 * 节点」。判断与后台环节本来就没有用户能看到的页面，硬画一个就是编页面。它们的
 * 说明写进标注（`anno`），由 `assembleWalkmap` 折进前一个页面节点——正是上游那句
 * "动作说明写进前一节点的标注"。
 */
export function fragmentsPrompt(req: RequirementRow, stage: Stage, nodes: FlowNode[]): string {
  const list = nodes
    .map((node) => `  ${node.id}  [${KIND_NOUN[kindOf(node)]}]  ${node.label}`)
    .join('\n');

  return [
    `你在为 PAN-${req.number}「${flat(req.title)}」画走查页面。`,
    `这份材料是${NOUN[stage]}：${FOCUS[stage]}`,
    '',
    '流程图已经定稿，节点清单（id / 形态 / 文案）：',
    list,
    '',
    '请为每个节点交一份页面片段，规则如下（来自 flow-walkthrough 的 page-guide，逐条会被机器校验）：',
    ' 1. 设备框就是用户的手机屏幕或浏览器窗口：框里每一段文字都必须是上线后用户真的会看到的内容。',
    '    设计理由、边界条件、「本期不做 / 待确认」、演示操作说明一律不写；元素下方不加解释性的小字。',
    ' 2. 手机页面按 375px 宽画（frame 写 phone）；后台与网页页面放 690px 宽的窗口（frame 写 wide）。',
    ' 3. 只用模板内置的 wt-* 组件类，不自带 <style>、不引外部资源：',
    '    wt-screen（整屏容器）、wt-statusbar、wt-nav（wt-nav-back / wt-nav-title / wt-nav-action）、',
    '    wt-titlebar、wt-body、wt-card、wt-section、wt-list / wt-list-item / wt-li-main / wt-li-title /',
    '    wt-li-sub / wt-li-extra / wt-li-arrow、wt-input、wt-btn（整行主按钮）/ wt-btn-ghost / wt-btn-sm、',
    '    wt-badge、wt-dimtext、wt-tabs / wt-tab / wt-on、wt-empty、wt-img、wt-bottombar、',
    '    wt-modal / wt-dialog / wt-dialog-title / wt-dialog-body / wt-dialog-actions、wt-toast、',
    '    wt-browserbar（后台地址栏）、wt-table。',
    ' 4. 只写 body 内的片段：不要 <html>、<head>、<body>、<script>、<style>。',
    ' 5. 一个状态一份片段：同一页面因规则不同而出现的态（弹窗、toast、空态、只读态）各写一份；',
    '    弹窗态 = 原页面 + wt-modal（放在 wt-screen 里），toast 态 = 原页面 + wt-toast。',
    '    不同状态之间共用的那部分结构必须一模一样，评审才比得出来。',
    ` 6. 页面上能推进流程的按钮写 onclick="goNode('节点id')"，id 必须是上面清单里的 id。`,
    ' 7. 不用 emoji（构建器硬校验，出现即整份材料被拒）。图片用 wt-img 占位，图标用文字占位。',
    ' 8. 只画需求里有的内容，不自行添加功能；PRD 没给的细节用中性占位内容，不要写「PRD 未提供」。',
    '',
    '输出：**一个** JSON 对象（不要代码围栏、不要解释），nodes 里每个节点一条：',
    '{',
    '  "nodes": [',
    '    { "id": "A", "kind": "page", "frame": "phone", "title": "进入寄养频道",',
    '      "html": "<div class=\\"wt-screen\\"><div class=\\"wt-statusbar\\"><span>9:41</span>'
      + '<span class=\\"wt-sb-icons\\"></span></div><div class=\\"wt-nav\\">'
      + '<span class=\\"wt-nav-title\\">寄养</span></div><div class=\\"wt-body\\">'
      + '<div class=\\"wt-card\\">…</div></div></div>",',
    '      "anno": [["内容", "按距离列出可寄养门店"], ["操作", "点「立即预约」后判断是否首次预约"]] },',
    '    { "id": "B", "kind": "decision", "title": "是否登录？",',
    '      "anno": [["判定依据", "会话里有没有用户"]] }',
    '  ]',
    '}',
    '',
    '规则：',
    ' 1. id 必须与清单一一对应，一个不多一个不少；kind 与清单里的形态一致。',
    ' 2. kind=page 必须给 frame 与 html（html 是完整可渲染的一屏，不是描述）；',
    '    kind=system / decision **不要**给 html——流程图里它本来就没有页面，只给 anno。',
    ' 3. anno 是右栏标注：每项 ["小标题", "正文"]，小标题 2–6 个字，正文一句话；',
    '    要指页面位置时写成「[A] 顶部状态卡片」，编号只写在标注里、不画进页面。',
    '    每页 1–3 条，只写设计约束、判定依据、边界与风险，不要重复页面里已有的文案。',
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
    '',
    '重发**完整**的 JSON，形状不变：',
    '{"nodes":[{"id","kind","frame","title","html","anno":[["小标题","正文"]]}]}',
    'kind=page 给 frame 与 html；kind=system / decision 只给 anno，不要给 html。',
    'html 只用 wt-* 组件类、只写 body 内片段、不用 emoji；一个状态一份片段；',
    '页面上推进流程的按钮写 onclick="goNode(\'节点id\')"。全部中文，只输出 JSON 本身。',
  ].join('\n');
}

// ─── 页面片段的 schema 与校验 ────────────────────────────────────────────────

const AnnoSchema = z.array(z.string().min(1)).min(2).max(3);

const FragmentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['page', 'system', 'decision']),
  title: z.string().min(1),
  frame: z.enum(['phone', 'wide']).default('phone'),
  html: z.string().default(''),
  anno: z.array(AnnoSchema).default([]),
});

const FragmentsSchema = z.object({ nodes: z.array(FragmentSchema).min(1) });

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
 * 不许有（它们没有页面，硬画一个就是编）。
 *
 * 这一层**不查** `wt-*` 类与 emoji：那是 walkmap 契约的事，由 `validateWalkmap` 说，
 * 报错格式也统一在那里（一句话、可重试）。两层分工清楚，错误就不会两处各说一半。
 */
export function readFragments(
  text: string,
  ids: string[],
): { ok: true; doc: FragmentDoc } | { ok: false; why: string } {
  const raw = extractJson<unknown>(text);
  if (raw === null) return { ok: false, why: '回话里没有 JSON 对象（第一个字符就该是 {）' };

  const parsed = FragmentsSchema.safeParse(raw);
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

    nodes.push({
      id: node.id,
      title: node.title,
      kind: node.kind,
      frame: node.frame,
      html: node.kind === 'page' ? html : '',
      anno: toAnno(node.anno),
    });
  }

  const missing = ids.filter((id) => !seen.has(id));
  if (missing.length > 0) return { ok: false, why: `这些节点没有页面片段：${missing.join('、')}` };
  const extra = [...seen].filter((id) => !ids.includes(id));
  if (extra.length > 0) return { ok: false, why: `多出了图里不存在的节点：${extra.join('、')}` };

  return { ok: true, doc: { nodes } };
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
  /** 没有自己的页面、被挂到别的节点页面上的环节（判断 / 系统）。 */
  detached: Array<{ node: string; page: string }>;
};

/**
 * 页面片段 → walkmap/1 的 JSON。三条规则，全部写在这里：
 *
 * 1. **一份片段一个页面**：内容完全相同的片段共用同一个 `pages[].id`（id 取第一次
 *    出现的节点 id，前缀 `p-`），所以「同一页」在 walkmap 里只有一个文件。
 * 2. **同一页面被多个页面节点使用 = 一组状态**：组名取这些标题的公共前缀
 *    （「寄养首页 · 未预约」→「寄养首页」），状态的 label 就是节点标题；单状态不建组
 *    （上游硬规则：右侧不放按钮）。推导在 `deriveStateGroups`。
 * 3. **判断 / 系统环节没有自己的页面**：它们不建 `pages` 条目，而是挂到**前一个**
 *    页面节点的页面上（没有前一个就挂后一个），标注留在自己身上——所以点它不会
 *    变成死点，右栏写的正是「这一步为什么在这里」。上游口径是「无页面的步骤不建
 *    节点、动作说明写进前一节点的标注」；我们的流程图里这种节点已经画出来了，
 *    能做的只有把它挂到它发生的那个页面上，而不是替它编一个页面。
 *
 * 纯函数：不读磁盘、不看时钟。同一份片段永远得到同一份 walkmap。
 */
export function assembleWalkmap(doc: FragmentDoc, opts: { title: string; svg: string }): Assembly {
  const pageOf = new Map<string, string>();
  const pages: PageInput[] = [];
  const fragments: Record<string, string> = {};

  const nodes: NodeInput[] = [];
  const pageNode = new Map<string, NodeInput>();
  const detached: Array<{ node: string; page: string }> = [];

  /** 折标注用：离这个下标最近的页面节点（先往前找、再往后找）。 */
  const nearestPage = (index: number): NodeInput | undefined => {
    for (let i = index - 1; i >= 0; i -= 1) {
      const hit = pageNode.get(doc.nodes[i]!.id);
      if (hit !== undefined) return hit;
    }
    for (let i = index + 1; i < doc.nodes.length; i += 1) {
      const hit = pageNode.get(doc.nodes[i]!.id);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  doc.nodes.forEach((fragment, index) => {
    if (fragment.kind !== 'page' || fragment.html === '') {
      const host = nearestPage(index);
      // 没有任何页面节点时校验会说「一个页面片段都没有」；这里先按无页面记。
      if (host === undefined) {
        nodes.push({ id: fragment.id, title: fragment.title, kind: fragment.kind, anno: fragment.anno });
        return;
      }
      detached.push({ node: fragment.id, page: host.page ?? '' });
      nodes.push({ id: fragment.id, title: fragment.title, kind: fragment.kind, page: host.page, anno: fragment.anno });
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

    const node: NodeInput = {
      id: fragment.id,
      title: fragment.title,
      kind: 'page',
      page: pageId,
      anno: fragment.anno,
    };
    pageNode.set(fragment.id, node);
    nodes.push(node);
  });

  return {
    walkmap: buildWalkmap({ title: opts.title, svg: opts.svg, nodes, pages }),
    fragments,
    detached,
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
export function parseFlow(mermaid: string): FlowShape {
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
  for (const raw of mermaid.split('\n')) {
    const line = raw.trim();
    if (line === '' || HEADER.test(line) || CLASS_LINE.test(line)) continue;
    const parts = line.split('-->');
    if (parts.length === 1) continue;
    edges += parts.length - 1;
    for (const part of parts) {
      // `-->|是| C`：`|` 那一节是边标签，不是节点 id。
      const clean = part.replace(/^\|[^|]*\|/, '').trim();
      const id = /^([A-Za-z0-9_]+)/.exec(clean)?.[1];
      if (id !== undefined) note(id);
    }
  }

  return { nodes: order.map((id) => byId.get(id)!), edges };
}

// ─── 小工具 ──────────────────────────────────────────────────────────────────

/** 标题/类型里的换行会把提示词的分节改写掉，先压成单行。 */
function flat(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function addUsage(total: ComposeUsage, usage?: { prompt?: number; completion?: number }): ComposeUsage {
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
    + '在「设置」里填这三格，或用这三个环境变量注入之后再试。';
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

async function loadRequirement(db: Db, requirementId: string): Promise<RequirementRow> {
  const res = await db.execute<RequirementRow>(sql`
    select id, number, title, type, requester, prd_url
      from requirements
     where id = ${requirementId}`);
  const row = res.rows[0];
  if (!row) throw new AppError('not_found', '需求不存在');
  return { ...row, number: Number(row.number) };
}

/**
 * 图这一关：问 → 验（引擎 + 形状）→ 不行就带着引擎原文再问，最多 3 次。
 *
 * 两次失败的语义刻意分开，因为它们要喂给模型的话完全不同：
 * - **引擎拒**（`ok:false`）：语法/形态/布局问题，要它「改简单」；
 * - **形状太小**（引擎说 ok，但节点 < 3 或连线 < 2）：语法的垃圾也能过计数，
 *   要它「补出最小骨架」。
 * 两者同时成立时两句都写进去——模型一次只修一半的代价是又一轮 90 秒。
 */
async function buildFlow(
  cfg: ProviderConfig,
  req: RequirementRow,
  stage: Stage,
  deps: ComposeDeps,
  usage: ComposeUsage,
): Promise<{ mermaid: string; check: FlowCheck; attempts: number; usage: ComposeUsage }> {
  let prompt = flowPrompt(req, stage);
  let spent = usage;

  for (let attempt = 1; attempt <= MAX_FLOW_ATTEMPTS; attempt += 1) {
    const reply = await deps.complete(cfg, prompt, { maxTokens: FLOW_MAX_TOKENS, timeoutMs: CALL_TIMEOUT_MS });
    // 接口层的失败**不消耗**修图次数，也不改写：它不是「图不好」，重试也不会变好。
    if (!reply.ok) throw new AppError('provider_error', reply.error);
    spent = addUsage(spent, reply.usage);

    const mermaid = mermaidIn(reply.text);
    const shape = parseFlow(mermaid);
    const check = await deps.render(mermaid);
    const tooSmall = shape.nodes.length < MIN_NODES || shape.edges < MIN_EDGES;

    if (check.ok && !tooSmall) {
      return { mermaid, check, attempts: attempt, usage: spent };
    }

    const why = [
      check.ok ? '' : engineText(check),
      tooSmall ? shapeText(shape) : '',
    ].filter((part) => part !== '').join('；');

    if (attempt === MAX_FLOW_ATTEMPTS) {
      throw new AppError(
        'flow_rejected',
        `流程图 ${MAX_FLOW_ATTEMPTS} 次都没通过检查：${why}`,
      );
    }
    prompt = repairPrompt(req, stage, { mermaid, check, shape });
  }

  // 循环不可能走到这里（最后一次一定 return 或 throw）；留着是为了让类型收敛。
  throw new AppError('flow_rejected', '流程图没有通过检查');
}

/**
 * 页面片段这一关：问 → 读（zod + 全覆盖）→ 拼 walkmap → 校验（build.py 的规则镜像）
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
async function buildPages(
  cfg: ProviderConfig,
  req: RequirementRow,
  stage: Stage,
  nodes: FlowNode[],
  flow: { svg: string },
  deps: ComposeDeps,
  usage: ComposeUsage,
): Promise<{ assembly: Assembly; warnings: string[]; usage: ComposeUsage }> {
  const ids = nodes.map((node) => node.id);
  const title = `PAN-${req.number}「${flat(req.title)}」${NOUN[stage]}`;
  let prompt = fragmentsPrompt(req, stage, nodes);
  let spent = usage;
  let why = '';

  for (let attempt = 1; attempt <= MAX_PAGES_ATTEMPTS; attempt += 1) {
    const reply = await deps.complete(cfg, prompt, { maxTokens: FRAGMENTS_MAX_TOKENS, timeoutMs: CALL_TIMEOUT_MS });
    if (!reply.ok) throw new AppError('provider_error', reply.error);
    spent = addUsage(spent, reply.usage);

    const read = readFragments(reply.text, ids);
    if (!read.ok) {
      why = read.why;
    } else {
      const assembly = assembleWalkmap(read.doc, { title, svg: flow.svg });
      const report = validateWalkmap(assembly.walkmap, { svg: flow.svg, fragments: assembly.fragments });
      if (report.ok) return { assembly, warnings: report.warnings, usage: spent };
      // 校验器的原话直接当 `why`：它就是我们要在界面上说的那一句。
      why = report.errors.join('；');
    }

    if (attempt === MAX_PAGES_ATTEMPTS) break;
    prompt = fragmentsRepairPrompt(req, stage, nodes, reply.text, why);
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
 * `artifact_missing`），而且它在同一个事务里把 inbox 的需求推到待设计。文件先落地，
 * 这一步就只剩「验 + 记」。
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
  let usage: ComposeUsage = { prompt: 0, completion: 0 };

  const flow = await buildFlow(cfg, req, stage, full, usage);
  usage = flow.usage;

  const svg = flow.check.svg ?? '';
  // 节点清单只解析一次：提示词 2、拼 walkmap、日志都用它，三处不会漂。
  const nodes = parseFlow(flow.mermaid).nodes;
  const pages = await buildPages(cfg, req, stage, nodes, { svg }, full, usage);
  usage = pages.usage;

  const built = await full.build(pages.assembly.walkmap, {
    svg,
    fragments: pages.assembly.fragments,
  });
  if (!built.ok || built.html === undefined) {
    throw new AppError('walkmap_rejected', `走查页构建失败：${built.error ?? built.errors.join('；')}`);
  }

  const file = path.join(ARTIFACT_ROOT, `PAN-${req.number}`, `${stage}.html`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, built.html, 'utf8');

  const url = artifactUrl(file);
  const artifact = await attachArtifact(db, actor, { requirementId, stage, url });

  return { url, attempts: flow.attempts, usage, artifactId: artifact.id };
}
