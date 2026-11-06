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

/**
 * 「B 路线」：一个对话模型 + vendored 排版器，自己把需求做成一份**查过**的评估材料。
 *
 * 为什么要有这条路：P2.6–P2.9 的生成是「甩一条 agent CLI」——它要本机装着、登录着、
 * 会自己决定写什么 HTML、还会绕过检查直接交回一份没排过版的图。owner 的要求是
 * 「我有一个 LLM 的 key，就这一件事」：一个有 key 的部署必须能产出材料。所以这里不再
 * 让模型「写 HTML」，只让它做两件它真的擅长的事——**画图**（一段受限语法的 mermaid）
 * 和**写页面说明**（一段结构化 JSON）；**HTML 由我们确定性渲染**，图由 vendored 的
 * 排版器**验过**才收。三者各归其位，材料就不再是「模型心情」的产物。
 *
 * 这条链路的核心不是提示词，是**判据**：
 *
 * 1. **引擎说合格 ≠ 图有用。** `flowlayout.py` 把语法垃圾当成一个节点（`"这不是
 *    mermaid"` → `nodes: 1`，退出 0）。所以除计数之外还判**形状**：少于 3 个节点或
 *    少于 2 条连线的回复一律算失败，与计数无关。
 * 2. **失败要能被修。** 每次拒收都把「上一版原文 + 引擎原文（含交叉/重叠的点）+
 *    具体要改什么」拼回提示词，最多 3 次；3 次都不行就把最后一句引擎错误交给用户
 *    ——他要看到的是「为什么」，不是「生成失败」。
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

/** 页面说明最多问 2 次（首版 + 一次改 JSON）。 */
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

/** 页面说明是 N 段结构化 JSON，给足余量。 */
const PAGES_MAX_TOKENS = 3000;

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
};

/** 真实的三个依赖：真 HTTP、真 Python 排版器、真配置解析。 */
const LIVE: ComposeDeps = {
  complete,
  render: (mermaid) => renderFlowchart(mermaid),
  resolveConfig: resolveProviderConfig,
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

// ─── 提示词 2：页面说明（结构化 JSON） ───────────────────────────────────────

/** 图里解析出来的一个节点。`kind` 决定页面上显示成「页面 / 系统 / 判断」。 */
export type FlowNode = { id: string; label: string; kind: 'process' | 'decision' | 'backend' };

/**
 * 页面说明的提示词。
 *
 * 为什么把 JSON 形状整个写进提示词：`extractJson` 只负责「从回话里抠出一个能
 * `JSON.parse` 的对象」，字段口径由这里定义、由 zod 校验。少一个字段模型不会自己
 * 补，多一个字段也不该让整份材料作废——所以 schema 允许缺省（`.default([])`），
 * 但要求**每个节点都有条目**（由 `readPages` 校验，缺一个就要重来）。
 */
export function pagesPrompt(req: RequirementRow, stage: Stage, nodes: FlowNode[]): string {
  const list = nodes.map((node) => `  ${node.id}  ${node.label}`).join('\n');

  return [
    `下面是 PAN-${req.number}「${flat(req.title)}」这张流程图已经定稿的节点（id 与文案）：`,
    list,
    '',
    `请为每个节点写一份页面说明，输出**一个** JSON 对象（不要代码围栏、不要解释），形状如下：`,
    '',
    '{',
    '  "nodes": [',
    '    {',
    '      "id": "A",',
    '      "kind": "page",',
    '      "title": "进入寄养频道",',
    '      "field": ["宠物类型（下拉）", "寄养日期（日期选择）"],',
    '      "button": ["下一步"],',
    '      "note": ["未登录时先走登录，不在这里拦"],',
    '      "states": [',
    '        { "name": "默认", "desc": ["展示频道介绍与入口按钮"] },',
    '        { "name": "加载中", "desc": ["骨架屏，不展示假数据"] }',
    '      ]',
    '    },',
    '    { "id": "B", "kind": "decision", "title": "是否登录？", "field": [], "button": [],',
    '      "note": ["判定依据：会话里有没有用户"], "states": [] },',
    '    { "id": "G", "kind": "system", "title": "门店接单后台", "field": ["订单号"],',
    '      "button": ["接单", "拒单"], "note": ["非前端环节：门店在后台看到这张单"], "states": [] }',
    '  ]',
    '}',
    '',
    '规则：',
    ' 1. id 必须与上面给的节点 id 一一对应，一个不多一个不少。',
    ` 2. kind 只能是 "page" | "system" | "decision"：用户看得到页面/弹层/表单的写 page，`,
    '    后台或外部系统写 system，流程图里的判断节点写 decision。',
    ' 3. page 必须有 title、至少 1 条 field、至少 1 条 button、至少 1 条 states；',
    '    field 是这一步的输入项（写清控件形态），button 是这一步能点的动作，',
    '    note 是约束、风险与「PRD 未提供」的推断（推断的就在 note 里标「PRD 未提供」）。',
    ' 4. states 是这一步的页面状态：默认 / 加载中 / 空 / 失败 / 无权限 / 超时……',
    '    正常流程至少要有「默认」；异常状态宁可多写，那是评审最常问的地方。',
    '    states 为空数组仅限 decision 与 system。',
    ' 5. 全部中文，每一条不超过 20 个字，不要 emoji。',
    ` 6. 这份材料的用途：${FOCUS[stage]}`,
    ' 7. 只输出 JSON 本身：第一个字符是 {，最后一个字符是 }。',
  ].join('\n');
}

/** 改 JSON 的提示词：上一版 + 哪里不合规 + 规则再来一遍。 */
export function pagesRepairPrompt(
  req: RequirementRow,
  stage: Stage,
  nodes: FlowNode[],
  previous: string,
  why: string,
): string {
  const trimmed = previous.trim();
  const shown = trimmed.length > 1200 ? `${trimmed.slice(0, 1200)}…` : trimmed;
  return [
    `上一版的页面说明不合规（PAN-${req.number}「${flat(req.title)}」${NOUN[stage]}）。`,
    '',
    '上一版原文：',
    shown === '' ? '（空）' : shown,
    '',
    `问题：${why}`,
    '',
    '节点清单（id 与文案，一个都不能少）：',
    nodes.map((node) => `  ${node.id}  ${node.label}`).join('\n'),
    '',
    '请重发**完整**的 JSON：{"nodes":[{"id","kind","title","field":[],"button":[],"note":[],"states":[{"name","desc":[]}]}]}。',
    'kind 只能是 page / system / decision；page 的 states 至少 1 条；全部中文；不要代码围栏、不要解释。',
    '只输出 JSON 本身。',
  ].join('\n');
}

// ─── 页面说明的 schema 与校验 ────────────────────────────────────────────────

const StateSchema = z.object({
  name: z.string().min(1),
  desc: z.array(z.string()).default([]),
});

const NodeDocSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['page', 'system', 'decision']),
  title: z.string().min(1),
  field: z.array(z.string()).default([]),
  button: z.array(z.string()).default([]),
  note: z.array(z.string()).default([]),
  states: z.array(StateSchema).default([]),
});

const PagesSchema = z.object({ nodes: z.array(NodeDocSchema).min(1) });

export type PagesDoc = z.infer<typeof PagesSchema>;
export type NodeDoc = z.infer<typeof NodeDocSchema>;

/**
 * 校验一份页面说明：JSON 抠得出来 + zod 通过 + **节点全覆盖**。
 *
 * 「节点全覆盖」是这里唯一一条超出 zod 的规矩：少一个节点，成品页面上那里就是一个
 * 空壳，而空壳在评审里比「没有这一步」更误导——看图的人会以为这一步真的没有页面。
 * 多出来的节点直接告错（不静默丢弃）：那是模型把图改错了的信号。
 */
export function readPages(text: string, ids: string[]): { ok: true; doc: PagesDoc } | { ok: false; why: string } {
  const raw = extractJson<unknown>(text);
  if (raw === null) return { ok: false, why: '回话里没有 JSON 对象（第一个字符就该是 {）' };

  const parsed = PagesSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? '结构不对' : `${issue.path.join('.') || '(根)'}：${issue.message}`;
    return { ok: false, why: `JSON 结构不对 —— ${where}` };
  }

  const seen = new Set<string>();
  for (const node of parsed.data.nodes) {
    if (seen.has(node.id)) return { ok: false, why: `节点 ${node.id} 写了两遍` };
    seen.add(node.id);
  }
  const missing = ids.filter((id) => !seen.has(id));
  if (missing.length > 0) return { ok: false, why: `这些节点没有说明：${missing.join('、')}` };
  const extra = [...seen].filter((id) => !ids.includes(id));
  if (extra.length > 0) return { ok: false, why: `多出了图里不存在的节点：${extra.join('、')}` };

  return { ok: true, doc: parsed.data };
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

/** 页面说明这一关：问 → `extractJson` → zod + 全覆盖 → 不合规就再问一次。 */
async function buildPages(
  cfg: ProviderConfig,
  req: RequirementRow,
  stage: Stage,
  nodes: FlowNode[],
  deps: ComposeDeps,
  usage: ComposeUsage,
): Promise<{ doc: PagesDoc; usage: ComposeUsage }> {
  const ids = nodes.map((node) => node.id);
  let prompt = pagesPrompt(req, stage, nodes);
  let spent = usage;
  let why = '';

  for (let attempt = 1; attempt <= MAX_PAGES_ATTEMPTS; attempt += 1) {
    const reply = await deps.complete(cfg, prompt, { maxTokens: PAGES_MAX_TOKENS, timeoutMs: CALL_TIMEOUT_MS });
    if (!reply.ok) throw new AppError('provider_error', reply.error);
    spent = addUsage(spent, reply.usage);

    const read = readPages(reply.text, ids);
    if (read.ok) return { doc: read.doc, usage: spent };

    why = read.why;
    if (attempt === MAX_PAGES_ATTEMPTS) break;
    prompt = pagesRepairPrompt(req, stage, nodes, reply.text, why);
  }

  throw new AppError(
    'pages_rejected',
    `页面说明 ${MAX_PAGES_ATTEMPTS} 次都没通过校验：${why}`,
  );
}

// ─── 产物：确定性渲染 ────────────────────────────────────────────────────────

const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/** HTML 转义（文本与属性共用一份）。节点文案来自模型，必须当**数据**写进文档。 */
function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

const KIND_TEXT: Record<NodeDoc['kind'], string> = { page: '页面', system: '系统', decision: '判断' };

/** 一个节点在左侧列表里的那一行。 */
function listItem(node: FlowNode, doc: NodeDoc | undefined): string {
  const kind = doc?.kind ?? (node.kind === 'decision' ? 'decision' : node.kind === 'backend' ? 'system' : 'page');
  const title = doc?.title ?? node.label;
  return [
    '      <li>',
    `        <button type="button" class="node-btn" data-node="${esc(node.id)}">`,
    `          <span class="nid">${esc(node.id)}</span>`,
    `          <span class="ntitle">${esc(title)}</span>`,
    `          <span class="nkind ${kind}">${KIND_TEXT[kind]}</span>`,
    '        </button>',
    '      </li>',
  ].join('\n');
}

/** 中栏：一个节点的页面（或系统/判断规则）。 */
function paneOf(node: FlowNode, doc: NodeDoc | undefined, first: boolean): string {
  const kind = doc?.kind ?? (node.kind === 'decision' ? 'decision' : node.kind === 'backend' ? 'system' : 'page');
  const title = doc?.title ?? node.label;
  const blocks: string[] = [];

  if (doc !== undefined && doc.field.length > 0) {
    blocks.push([
      '        <section class="blk">',
      '          <h3>字段</h3>',
      '          <ul class="items">',
      ...doc.field.map((item) => `            <li>${esc(item)}</li>`),
      '          </ul>',
      '        </section>',
    ].join('\n'));
  }
  if (doc !== undefined && doc.button.length > 0) {
    blocks.push([
      '        <section class="blk">',
      '          <h3>按钮</h3>',
      '          <div class="btns">',
      ...doc.button.map((item) => `            <span class="btn">${esc(item)}</span>`),
      '          </div>',
      '        </section>',
    ].join('\n'));
  }
  if (doc !== undefined && doc.note.length > 0) {
    blocks.push([
      '        <section class="blk">',
      '          <h3>说明</h3>',
      '          <ul class="items">',
      ...doc.note.map((item) => `            <li>${esc(item)}</li>`),
      '          </ul>',
      '        </section>',
    ].join('\n'));
  }
  if (blocks.length === 0) {
    blocks.push('        <p class="empty">这一版没有写这一步的内容。</p>');
  }

  return [
    `      <div class="pane${kind === 'page' ? '' : ' pane-wide'}" data-pane="${esc(node.id)}"${first ? '' : ' hidden'}>`,
    '        <div class="frame">',
    `          <div class="frame-bar"><span class="nid">${esc(node.id)}</span>`
      + `<strong>${esc(title)}</strong><span class="nkind ${kind}">${KIND_TEXT[kind]}</span></div>`,
    '          <div class="frame-body">',
    ...blocks,
    '          </div>',
    '        </div>',
    '      </div>',
  ].join('\n');
}

/** 右栏：同一节点的状态。 */
function statesOf(node: FlowNode, doc: NodeDoc | undefined, first: boolean): string {
  const states = doc?.states ?? [];
  const body = states.length === 0
    ? ['        <p class="empty">这一步没有写状态。</p>']
    : [
      '        <ol class="state-list">',
      ...states.flatMap((state) => [
        '          <li>',
        `            <strong>${esc(state.name)}</strong>`,
        state.desc.length === 0 ? '' : '            <ul class="items">',
        ...state.desc.map((item) => `              <li>${esc(item)}</li>`),
        state.desc.length === 0 ? '' : '            </ul>',
        '          </li>',
      ]),
      '        </ol>',
    ];
  return [
    `      <div class="states" data-states="${esc(node.id)}"${first ? '' : ' hidden'}>`,
    `        <p class="who">${esc(doc?.title ?? node.label)}</p>`,
    ...body.filter((line) => line !== ''),
    '      </div>',
  ].join('\n');
}

const CSS = `
:root { --ink:#1b1c1f; --mute:#6b6f76; --line:#e3e5e8; --bg:#f6f7f9; --card:#fff; --accent:#2f6df6; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif; }
.head { padding:18px 24px 14px; background:var(--card); border-bottom:1px solid var(--line); }
.head .pan { display:inline-block; font-size:12px; letter-spacing:.04em; color:var(--mute); }
.head h1 { margin:4px 0 6px; font-size:20px; line-height:1.3; }
.head .meta { margin:0; font-size:12px; color:var(--mute); }
.wrap { display:grid; grid-template-columns:minmax(340px,470px) minmax(320px,1fr) minmax(200px,290px);
  gap:14px; padding:16px 20px 32px; align-items:start; }
.col { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
.h2 { margin:0 0 10px; font-size:13px; font-weight:600; color:var(--mute); letter-spacing:.02em; }
.h2 .hint { font-weight:400; }
.svg-box { overflow:auto; border:1px solid var(--line); border-radius:8px; background:#fff; }
.svg-box svg { display:block; width:100%; height:auto; }
.node-list { list-style:none; margin:12px 0 0; padding:0; display:flex; flex-direction:column; gap:6px; }
.node-btn { display:flex; width:100%; gap:8px; align-items:center; padding:7px 9px; text-align:left;
  border:1px solid var(--line); border-radius:8px; background:#fff; cursor:pointer; font:inherit; color:inherit; }
.node-btn:hover { border-color:var(--accent); }
.node-btn.on { border-color:var(--accent); box-shadow:0 0 0 2px rgba(47,109,246,.15); }
.nid { flex:none; min-width:22px; padding:1px 5px; border-radius:5px; background:var(--bg);
  color:var(--mute); font-size:11px; text-align:center; }
.ntitle { flex:1; font-size:13px; line-height:1.35; }
.nkind { flex:none; font-size:11px; padding:1px 6px; border-radius:999px; border:1px solid var(--line); color:var(--mute); }
.nkind.page { border-color:#bcd0fb; color:#2557c9; background:#f2f6ff; }
.nkind.system { border-color:#c9ccd2; color:#4d5259; background:#f1f2f4; }
.nkind.decision { border-color:#e6d5a8; color:#8a6a15; background:#fdf7e6; }
.pane[hidden], .states[hidden] { display:none; }
.frame { border:1px solid var(--line); border-radius:12px; overflow:hidden; }
.pane-wide .frame { border-style:dashed; }
.frame-bar { display:flex; gap:8px; align-items:center; padding:9px 12px; background:var(--bg); border-bottom:1px solid var(--line); }
.frame-bar strong { font-size:14px; }
.frame-body { padding:12px; display:flex; flex-direction:column; gap:12px; }
.blk h3 { margin:0 0 6px; font-size:12px; color:var(--mute); font-weight:600; }
.items { margin:0; padding-left:18px; font-size:13px; line-height:1.6; }
.btns { display:flex; flex-wrap:wrap; gap:8px; }
.btn { padding:6px 14px; border-radius:7px; background:var(--accent); color:#fff; font-size:13px; }
.empty { margin:0; font-size:12px; color:var(--mute); }
.who { margin:0 0 8px; font-size:13px; font-weight:600; }
.state-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:10px; }
.state-list > li { border-left:2px solid var(--line); padding-left:10px; }
.state-list strong { font-size:13px; }
@media (max-width:1100px) { .wrap { grid-template-columns:1fr; } }
`.trim();

/** 切换的脚本：点图上的节点、点左侧列表，三栏一起动。没有外部依赖、没有构建。 */
const SCRIPT = `
(function () {
  var panes = Array.prototype.slice.call(document.querySelectorAll('[data-pane]'));
  var states = Array.prototype.slice.call(document.querySelectorAll('[data-states]'));
  var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-node]'));
  function show(id) {
    panes.forEach(function (el) { el.hidden = el.getAttribute('data-pane') !== id; });
    states.forEach(function (el) { el.hidden = el.getAttribute('data-states') !== id; });
    nodes.forEach(function (el) {
      var on = el.getAttribute('data-node') === id;
      if (el.tagName.toLowerCase() === 'button') el.classList.toggle('on', on);
      else el.classList.toggle('sel', on);
    });
    var ring = document.getElementById('sel-ring');
    var group = document.querySelector('[data-node="' + id + '"]:not(button)');
    if (ring && group && group.getBBox) {
      var b = group.getBBox();
      ring.setAttribute('x', b.x - 7);
      ring.setAttribute('y', b.y - 7);
      ring.setAttribute('width', b.width + 14);
      ring.setAttribute('height', b.height + 14);
      ring.setAttribute('visibility', 'visible');
    }
  }
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var hit = target.closest('[data-node]');
    if (hit) show(hit.getAttribute('data-node'));
  });
  if (nodes.length > 0) show(nodes[0].getAttribute('data-node'));
})();
`.trim();

export type ArtifactInput = {
  req: RequirementRow;
  stage: Stage;
  svg: string;
  nodes: FlowNode[];
  doc: PagesDoc;
};

/**
 * 把「先验过」的三样东西拼成一份自足 HTML：左=流程图 + 节点列表，中=页面，右=状态。
 *
 * 为什么 HTML 由我们写而不是让模型写：
 * - 模型写的 HTML 每一次都不一样，改一个字就要重看一遍整页；
 * - 这里的三栏是**同一份数据**的三个视图（mermaid 节点、页面 JSON、状态 JSON），
 *   渲染是纯函数——同一份输入永远得到同一份字节，评审看到的东西就不会漂。
 *
 * 自足：样式与脚本内联、无 CDN、无相对资源。产物经 `/uemaster/...` 出去时带有
 * `Content-Security-Policy: sandbox allow-scripts; default-src 'none'`（见路由），
 * 所以内联的 style/script 是**唯一**能用的东西——引一个外部字体就会静默失效。
 */
export function renderArtifact(input: ArtifactInput): string {
  const { req, stage, svg, nodes, doc } = input;
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const title = `PAN-${req.number}「${flat(req.title)}」${NOUN[stage]}`;
  const meta = `类型 ${flat(req.type)} · 提出人 ${flat(req.requester)}`
    + ` · ${NOUN[stage]} · ${nodes.length} 个流程节点`;

  const items = nodes.map((node) => listItem(node, byId.get(node.id))).join('\n');
  const panes = nodes.map((node, index) => paneOf(node, byId.get(node.id), index === 0)).join('\n');
  const states = nodes.map((node, index) => statesOf(node, byId.get(node.id), index === 0)).join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
${CSS}
</style>
</head>
<body>
<header class="head">
  <span class="pan">PAN-${req.number}</span>
  <h1>${esc(flat(req.title))}</h1>
  <p class="meta">${esc(meta)}</p>
</header>
<main class="wrap">
  <aside class="col">
    <h2 class="h2">业务流程</h2>
    <div class="svg-box">
${svg.trim()}
    </div>
    <h2 class="h2" style="margin-top:14px">流程节点 <span class="hint">（点图上节点或这里的行切换）</span></h2>
    <ol class="node-list">
${items}
    </ol>
  </aside>
  <section class="col">
    <h2 class="h2">页面</h2>
${panes}
  </section>
  <aside class="col">
    <h2 class="h2">状态</h2>
${states}
  </aside>
</main>
<script>
${SCRIPT}
</script>
</body>
</html>
`;
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

/**
 * 把一条需求做成一份**查过**的评估材料，落盘、attach、返回站内路径。
 *
 * 顺序是硬的：先拿配置（没有就点名缺什么）→ 图（3 次上限，验过才收）→ 页面说明
 * （2 次上限，schema + 全覆盖）→ 渲染 → 写文件 → `attachArtifact`。
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

  // 节点清单只解析一次：提示词 2、左侧列表、中右两栏都用它，三处不会漂。
  const nodes = parseFlow(flow.mermaid).nodes;
  const pages = await buildPages(cfg, req, stage, nodes, full, usage);
  usage = pages.usage;

  const html = renderArtifact({ req, stage, svg: flow.check.svg ?? '', nodes, doc: pages.doc });

  const file = path.join(ARTIFACT_ROOT, `PAN-${req.number}`, `${stage}.html`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, html, 'utf8');

  const url = artifactUrl(file);
  const artifact = await attachArtifact(db, actor, { requirementId, stage, url });

  return { url, attempts: flow.attempts, usage, artifactId: artifact.id };
}
