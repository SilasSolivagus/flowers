/**
 * 形状漂移语料跑批：**一次调用把所有「模型没照我们的形状写」都逼出来**。
 *
 *   npx tsx scripts/shape-corpus.ts \
 *     --requirements 1,2,6,7,10 --stages evaluate,review,inspect \
 *     --models deepseek-flash,deepseek-v4-pro --repeat 3 --concurrency 4
 *
 * 为什么要有这个脚本：应用里的解析器只用 zod 报**第一条**问题（`issues[0]`），而一次
 * 真实生成的代价是四分钟。于是「模型回话有几种写歪的方式」这件事，只能一条一条地
 * 撞、一条一条地修——修好 evidence 之后再跑一次才知道 anno 也歪了。这个脚本把
 * 「问模型」与「读回话」拆开：提示词用**应用自己的提示词构造函数**拼（不是抄一份），
 * 回话用**应用自己的解析函数**读，但读到的问题**全量**收下来（自己 `safeParse`，
 * 不是 `issues[0]`），而且每条原始回话先落盘再解析——批次跑到一半断了，语料还在。
 *
 * 三条硬口径：
 *
 * 1. **不碰 `inspect()` / `composeEvaluation()`**。那两个函数是「一次生成」的事务：
 *    任何一步不过就抛，于是第一批调用废掉后面的全部证据。这里直接调 `complete()`，
 *    一次调用一条记录，谁也不连累谁。
 * 2. **提示词与解析都走应用的那一份**。`flowPrompt` / `fragmentsPrompt` /
 *    `structurePrompt` / `verifyPrompt`、`readStructure` / `readVerify` /
 *    `readFragments`——抄一份提示词出来测，测的就是抄件的漂移了。
 * 3. **只观察，不修**。这个脚本不写库、不改 schema、不合并分支；它产出一份可复现的
 *    语料与一张分类表，容错该长什么样由读表的人决定。
 *
 * 两段式（一次跑批里同一格问两次）：
 *
 * - 第一段：`flow`（评估/评审）/ `structure`（走查）——产出流程节点与结论；
 * - 第二段：`pages`（评估/评审）/ `verify`（走查）——提示词里要放**第一段的产物**。
 *
 * 第二段的提示词因此**按需求取一份参考产物**（第一段里第一条通过的），同一需求下
 * 两个模型、三次重复拿到的是**同一份**提示词：漂移才可比。第一段全灭时第二段跳过
 * 并写明原因——拿一条没通过校验的结论去拼复核提示词，只会测到我们自己的错。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { repoShape } from '../src/core/codemirror/route.js';
import { grep, head, lsTree, show } from '../src/core/codemirror/mirror.js';
import { latestSnapshot, type Snapshot } from '../src/core/prd/snapshots.js';
import { renderFlowchart, type FlowCheck } from '../src/core/uemaster/flow.js';
import {
  complete, extractJson, resolveProviderConfig,
  type ProviderConfig, type ProviderResult,
} from '../src/core/uemaster/provider.js';
import {
  FragmentsSchema, assembleWalkmap, flowPrompt, fragmentsPrompt,
  mermaidIn, parseFlow, readFragments,
  type FlowNode,
} from '../src/core/uemaster/compose.js';
import {
  DEEP_READ_BUDGET, DEEP_READ_FILE_MAX, FLOW_CAP, FLOW_MIN, INSPECT_REPOS,
  StructureSchema, VerifySchema, citationsOf, keywordsFrom, prdVersionOf, rankCandidates,
  readStructure, readVerify, structurePrompt, validateStructure, verifyPrompt,
  type Finding, type PrdBaseline, type RepoBaseline, type Structure, type TreeIndex,
} from '../src/core/uemaster/inspect.js';
import { validateWalkmap } from '../src/core/uemaster/walkmap.js';

// ─── 计划 ────────────────────────────────────────────────────────────────────

type Stage = 'evaluate' | 'review' | 'inspect';
type Phase = 'flow' | 'pages' | 'structure' | 'verify';

const STAGES: readonly Stage[] = ['evaluate', 'review', 'inspect'];
const PHASE_OF: Record<Stage, { first: Phase; second: Phase }> = {
  evaluate: { first: 'flow', second: 'pages' },
  review: { first: 'flow', second: 'pages' },
  inspect: { first: 'structure', second: 'verify' },
};

/**
 * 每一格的输出预算。前两条与应用 `compose.ts` 的 `FLOW_MAX_TOKENS` /
 * `FRAGMENTS_MAX_TOKENS` 同值，后两条与 `inspect.ts` 的 `STRUCTURE_MAX_TOKENS` /
 * `VERIFY_MAX_TOKENS` 同值——**推理模型先把预算花在思考上**，给少了回话是空串
 * （`provider.ts` 会把这件事说成「模型把输出预算用在了思考上」）。
 */
// 与应用里的常量保持一致（不是各写一份）。早前这里落后于产品：应用已经抬到
// flow 12k / pages 24k，跑批还在用 4k / 14k，于是每一轮都复现出**已经不存在的**
// 截断——把「跑批参数旧了」误读成「产品还有 11 处漂移」。
const BUDGET: Record<Phase, number> = {
  flow: 12_000,
  pages: 24_000,
  structure: 32_000,
  verify: 64_000,
};

/** 单次调用超时：应用现在是 420 秒（1M 上下文的推理模型单轮能跑几分钟）。 */
const DEFAULT_TIMEOUT_MS = 420_000;

type Plan = {
  requirements: number[];
  stages: Stage[];
  models: string[];
  repeat: number;
  concurrency: number;
  timeoutMs: number;
  outRoot: string;
};

function argOf(argv: string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return null;
  return argv[i + 1] ?? null;
}

function listOf(argv: string[], name: string): string[] {
  const raw = argOf(argv, name);
  if (raw === null) return [];
  return raw.split(',').map((part) => part.trim()).filter((part) => part !== '');
}

function numberOf(argv: string[], name: string, fallback: number): number {
  const raw = argOf(argv, name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parsePlan(argv: string[]): Plan {
  const requirements = listOf(argv, 'requirements').map((part) => Number.parseInt(part, 10)).filter((n) => Number.isFinite(n));
  const stages = listOf(argv, 'stages').filter((part): part is Stage => (STAGES as readonly string[]).includes(part));
  const models = listOf(argv, 'models');
  if (requirements.length === 0) throw new Error('缺少 --requirements（例如 1,2,6,7,10）');
  if (stages.length === 0) throw new Error(`缺少 --stages（可选 ${STAGES.join('/')}）`);
  if (models.length === 0) throw new Error('缺少 --models（例如 deepseek-flash,deepseek-v4-pro）');
  return {
    requirements,
    stages,
    models,
    repeat: numberOf(argv, 'repeat', 3),
    concurrency: numberOf(argv, 'concurrency', 4),
    timeoutMs: numberOf(argv, 'timeout', DEFAULT_TIMEOUT_MS),
    outRoot: argOf(argv, 'out') ?? '/tmp/shape-corpus',
  };
}

// ─── 语料目录 ────────────────────────────────────────────────────────────────

function stamp(): string {
  const now = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** 只留文件名安全的字符：模型名里可能出现 `/`（`deepseek/flash`）。 */
function safeName(text: string): string {
  return text.replace(/[^A-Za-z0-9_.-]+/g, '_');
}

// ─── 记录 ────────────────────────────────────────────────────────────────────

/** zod 的 issue 压成可写进 JSON 的三格；`path` 用点号拼，读起来就是回话里的位置。 */
type IssueLite = { path: string; code: string; message: string };

/** 一条**形状漂移**：从原始回话里看出来的一处「没照我们的形状写」。 */
type Drift = {
  /** 归组用的稳定键（报告按它计数）。 */
  key: string;
  /** 现象（人读的一句话）。 */
  label: string;
  /** 我们的期望。 */
  expect: string;
  /** 模型原文片段（≤120 字）。 */
  snippet: string;
};

type Cell = {
  model: string;
  stage: Stage;
  phase: Phase;
  requirement: number;
  rep: number;
  /** 应用那条解析路径**收了**这份回话吗（不是「回话对不对」）。 */
  ok: boolean;
  /** 应用会给出的那一句「为什么不行」；通过时是空串。 */
  why: string;
  /** 原样 zod 的全量 issue（不是 issues[0]）。 */
  issues: IssueLite[];
  /** 解析通过之后仍然不过的语义问题（路径不存在、flows 数量…）。 */
  problems: string[];
  /** 页面片段过了 readFragments、但 walkmap 契约不过的问题（内容层，另算）。 */
  walkmap: string[];
  drift: Drift[];
  /** 形状指纹：同 sig 的两条回话，歪的是同一处。 */
  sig: string;
  promptChars: number;
  replyChars: number;
  excerpt: string;
  ms: number;
  /** 发了几次（>1 = 传输层抖动重试过）。 */
  attempts: number;
  /** 这一格最后用的 max_tokens。 */
  maxTokens: number;
  /** 思考吃光预算时抬过预算：从多少到多少、模型思考了多少字。 */
  budgetBump: { from: number; to: number; reasoningChars: number } | null;
  usage: { prompt: number; completion: number } | null;
  /** 接口层的失败原文（超时、4xx…）。有它就没有 replyChars。 */
  error: string | null;
  skipped: string | null;
  at: string;
};

function issueLite(issue: { path: (string | number)[]; code: string; message: string }): IssueLite {
  return { path: issue.path.join('.'), code: issue.code, message: issue.message };
}

function snippetOf(value: unknown, cap = 120): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length <= cap ? text : `${text.slice(0, cap)}…`;
}

function excerptOf(text: string, cap = 400): string {
  const flat = text.replace(/```/g, '`').replace(/\s+/g, ' ').trim();
  return flat.length <= cap ? flat : `${flat.slice(0, cap)}…`;
}

// ─── 漂移识别：只看原始回话，不看 zod 让不让过 ───────────────────────────────

const VERDICT_VALUES: readonly string[] = ['implemented', 'missing', 'extra', 'differs'];
const KIND_VALUES: readonly string[] = ['page', 'system', 'decision'];
const FRAME_VALUES: readonly string[] = ['phone', 'wide'];

/** 一级标题里出现这些词，说明模型在 JSON 之外还写了散文。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 结论的形状扫描（structure / verify 共用：两段回话的 `findings` 是同一个契约）。
 *
 * 为什么按**值**判而不按 zod 判：zod 只说「expected array」，说不出「模型把
 * `{repo,path}` 写成了 `"repo:path"`」——而那才是要写进分类表的那一行。
 */
function scanFindings(container: Record<string, unknown>, at: string, out: Drift[]): void {
  const findings = container.findings;
  if (findings === undefined) {
    if (Array.isArray(container.results)) {
      out.push({
        key: 'root.findings-under-results',
        label: '结论写在 `results` 键下',
        expect: '根对象里叫 `findings`',
        snippet: snippetOf(Object.keys(container)),
      });
      return;
    }
    return;
  }
  if (!Array.isArray(findings)) {
    out.push({
      key: 'root.findings-not-array',
      label: '`findings` 不是数组',
      expect: '`findings` 是数组，1–12 条',
      snippet: snippetOf(findings),
    });
    return;
  }
  if (findings.length === 0) {
    out.push({ key: 'root.findings-empty', label: '`findings` 是空数组', expect: '至少 1 条结论', snippet: '[]' });
  }
  findings.forEach((item, i) => {
    const where = `${at}[${i}]`;
    if (!isRecord(item)) {
      out.push({ key: 'finding.not-object', label: '结论不是对象', expect: '`{verdict, prd, code, evidence}`', snippet: snippetOf(item) });
      return;
    }
    const verdict = item.verdict;
    if (typeof verdict !== 'string') {
      out.push({ key: 'finding.verdict-not-string', label: '`verdict` 不是字符串', expect: '四选一枚举', snippet: snippetOf(verdict) });
    } else if (!VERDICT_VALUES.includes(verdict.trim().toLowerCase())) {
      // 键里带**具体写法的第一个词**：`implemented/一致` 与 `partial/部分实现` 是两条
      // 不同的漂移（前者是同一个判断的别名，后者是模型造了第五类），分类表要分得开。
      const alias = verdict.trim().split(/[/|｜、,，;；\s（()）]+/)[0] ?? verdict.trim();
      out.push({
        key: `finding.verdict-alias:${alias}`,
        label: `\`verdict\` 写了枚举之外的值：${JSON.stringify(verdict)}`,
        expect: 'implemented / missing / extra / differs 之一',
        snippet: snippetOf({ verdict, prd: item.prd }),
      });
    }
    for (const field of ['prd', 'code'] as const) {
      if (typeof item[field] !== 'string') {
        out.push({ key: `finding.${field}-missing`, label: `结论缺 \`${field}\`（或不是字符串）`, expect: `${field} 是一句中文短句`, snippet: snippetOf(item[field]) });
      }
    }
    const evidence = item.evidence;
    if (evidence === undefined) {
      // `missing` 允许空证据；其余 verdict 缺 evidence 是「判断没有依据」。
      if (typeof verdict === 'string' && !/missing|缺失/.test(verdict.toLowerCase())) {
        out.push({ key: 'finding.evidence-absent', label: '结论没有 `evidence` 键', expect: '非 missing 的结论至少一条证据', snippet: snippetOf(item) });
      }
    } else if (!Array.isArray(evidence)) {
      out.push({
        key: 'finding.evidence-not-array',
        label: `\`evidence\` 不是数组（是 ${typeof evidence}）`,
        expect: '`evidence: [{repo,path,note}]`',
        snippet: snippetOf(evidence),
      });
      // evidence 整个是一**个**字符串（不是数组）：与数组里那些字符串同一套分类，
      // 只是少了一层数组，所以这里的判断不能少——否则「repo:path 字符串」这条
      // 最常出现的漂移会在报告里显示成「没触发过」。
      if (typeof evidence === 'string') {
        out.push({
          key: /^[A-Za-z0-9_.-]+:/.test(evidence.trim()) ? 'evidence.string-with-repo-prefix' : 'evidence.string-bare-path',
          label: /^[A-Za-z0-9_.-]+:/.test(evidence.trim())
            ? '`evidence` 是一整条 `"repo:path"` 字符串（不是数组）'
            : '`evidence` 是一整条裸路径字符串（不是数组）',
          expect: '`evidence: [{repo, path, note}]`',
          snippet: snippetOf(evidence),
        });
      }
      // 一条字符串里用「、」拼了**多个** `repo:path`（实测 31/72 条）：扶正成对象之后
      // 整段会被当成一个路径，于是报「证据路径不存在」——形状过了，事实没过。
      if (typeof evidence === 'string') {
        const joined = evidence.split(/[、,，;；]/).filter((part) => /^[A-Za-z0-9_.-]+:/.test(part.trim()));
        if (joined.length > 1) {
          out.push({
            key: 'evidence.string-multiple-paths',
            label: `\`evidence\` 一条字符串里用「、」拼了 ${String(joined.length)} 个 \`repo:path\``,
            expect: '一个文件一条 evidence（扶正时按「、」拆开）',
            snippet: snippetOf(evidence),
          });
        }
      }
    } else {
      evidence.forEach((raw) => {
        if (typeof raw === 'string') {
          // 一条字符串里用「、」拼了**多个** `repo:path`（实测 31/72 条）：扶正成对象之后，
          // 整段会被当成一个路径，于是「证据不存在」。它比「少一层数组」更贵——形状对了，
          // 事实却过不了 lsTree。
          const joined = raw.split(/[、,，;；]/).filter((part) => /^[A-Za-z0-9_.-]+:/.test(part.trim()));
          if (joined.length > 1) {
            out.push({
              key: 'evidence.string-multiple-paths',
              label: `\`evidence\` 一条字符串里用「、」拼了 ${String(joined.length)} 个 \`repo:path\``,
              expect: '一个文件一条 evidence（或扶正时按「、」拆开）',
              snippet: snippetOf(raw),
            });
          }
          out.push({
            key: /^[A-Za-z0-9_.-]+:/.test(raw.trim()) ? 'evidence.string-with-repo-prefix' : 'evidence.string-bare-path',
            label: /^[A-Za-z0-9_.-]+:/.test(raw.trim())
              ? '`evidence` 元素是 `"repo:path"` 字符串'
              : '`evidence` 元素是裸路径字符串',
            expect: '`{repo, path, note}` 对象',
            snippet: snippetOf(raw),
          });
          return;
        }
        if (!isRecord(raw)) {
          out.push({ key: 'evidence.not-object', label: '`evidence` 元素既不是对象也不是字符串', expect: '`{repo,path,note}`', snippet: snippetOf(raw) });
          return;
        }
        const hasRepo = typeof raw.repo === 'string' && raw.repo.trim() !== '';
        const hasPath = typeof raw.path === 'string' && raw.path.trim() !== '';
        if (!hasRepo || !hasPath) {
          out.push({
            key: 'evidence.object-other-keys',
            label: `\`evidence\` 对象的键是 ${JSON.stringify(Object.keys(raw))}（没有 repo/path）`,
            expect: '`{repo, path, note}`',
            snippet: snippetOf(raw),
          });
        }
        if (raw.note !== undefined && typeof raw.note !== 'string') {
          out.push({ key: 'evidence.note-not-string', label: '`note` 不是字符串', expect: '一句话说明为什么这条能证明', snippet: snippetOf(raw.note) });
        }
      });
    }
    const searched = item.searched;
    if (searched !== undefined && !Array.isArray(searched)) {
      out.push({
        key: 'finding.searched-not-array',
        label: `\`searched\` 不是数组（是 ${typeof searched === 'string' ? '字符串' : typeof searched}）`,
        expect: '`searched: ["搜过的关键词"]`',
        snippet: snippetOf(searched),
      });
    }
    const missingLike = typeof verdict === 'string' && /missing|缺失/.test(verdict.toLowerCase());
    const hasEvidenceList = Array.isArray(evidence) && evidence.length > 0;
    if (missingLike && !hasEvidenceList && (searched === undefined || (Array.isArray(searched) && searched.length === 0))) {
      out.push({ key: 'finding.missing-no-scope', label: 'missing 既没给 `searched` 也没指一个「本该在哪」的文件', expect: '给 searched 或给一条本该在的路径', snippet: snippetOf(item) });
    }
  });
}

/** `flows` 的形状（只有 structure 段有）。 */
function scanFlows(container: Record<string, unknown>, out: Drift[]): void {
  const flows = container.flows;
  if (flows === undefined) {
    out.push({ key: 'root.flows-absent', label: '根对象没有 `flows`', expect: `flows ${FLOW_MIN}–${FLOW_CAP} 个`, snippet: snippetOf(Object.keys(container)) });
    return;
  }
  if (!Array.isArray(flows)) {
    out.push({ key: 'root.flows-not-array', label: '`flows` 不是数组', expect: `flows ${FLOW_MIN}–${FLOW_CAP} 个`, snippet: snippetOf(flows).slice(0, 80) });
    return;
  }
  if (flows.length < FLOW_MIN || flows.length > FLOW_CAP) {
    out.push({
      key: 'root.flows-count',
      label: `\`flows\` 有 ${flows.length} 个（要求 ${FLOW_MIN}–${FLOW_CAP}）`,
      expect: `${FLOW_MIN}–${FLOW_CAP} 个`,
      snippet: snippetOf(flows.map((f) => (isRecord(f) ? f.title : f))),
    });
  }
  flows.forEach((item) => {
    if (!isRecord(item)) {
      out.push({ key: 'flow.not-object', label: '`flows` 元素不是对象', expect: '`{id,title,kind}`', snippet: snippetOf(item) });
      return;
    }
    const kind = item.kind;
    if (typeof kind !== 'string' || !KIND_VALUES.includes(kind.trim().toLowerCase())) {
      out.push({
        key: 'flow.kind-alias',
        label: `\`flows[].kind\` 不是枚举值：${JSON.stringify(kind)}`,
        expect: 'page / decision / system',
        snippet: snippetOf({ id: item.id, title: item.title, kind }),
      });
    }
  });
}

/** 页面节点的形状（pages / verify 段共用）。 */
function scanNodes(container: Record<string, unknown>, out: Drift[]): void {
  const nodes = container.nodes;
  if (nodes === undefined) {
    out.push({ key: 'root.nodes-absent', label: '根对象没有 `nodes`', expect: '`nodes: [{id,kind,title,frame,html,anno}]`', snippet: snippetOf(Object.keys(container)) });
    return;
  }
  if (!Array.isArray(nodes)) {
    out.push({
      key: 'root.nodes-not-array',
      label: isRecord(nodes) ? '`nodes` 是对象映射而不是数组' : '`nodes` 不是数组',
      expect: '数组，每个流程节点一条',
      snippet: snippetOf(nodes).slice(0, 80),
    });
    return;
  }
  nodes.forEach((item) => {
    if (!isRecord(item)) {
      out.push({ key: 'node.not-object', label: '`nodes` 元素不是对象', expect: '`{id,kind,title,frame,html,anno}`', snippet: snippetOf(item) });
      return;
    }
    const id = typeof item.id === 'string' ? item.id : '(无 id)';
    const kind = item.kind;
    if (typeof kind !== 'string' || !KIND_VALUES.includes(kind.trim().toLowerCase())) {
      out.push({
        key: 'node.kind-alias',
        label: `节点 ${id} 的 \`kind\` 不是枚举值：${JSON.stringify(kind)}`,
        expect: 'page / system / decision',
        snippet: snippetOf({ id, kind }),
      });
    }
    const frame = item.frame;
    if (frame !== undefined && (typeof frame !== 'string' || !FRAME_VALUES.includes(frame.trim().toLowerCase()))) {
      out.push({
        key: 'node.frame-alias',
        label: `节点 ${id} 的 \`frame\` 不是枚举值：${JSON.stringify(frame)}`,
        expect: 'phone / wide',
        snippet: snippetOf({ id, frame }),
      });
    }
    const html = item.html;
    if (kind === 'page' && (typeof html !== 'string' || html.trim() === '')) {
      out.push({ key: 'node.page-no-html', label: `节点 ${id} 是 page 但没给 \`html\``, expect: '完整一屏 HTML 片段', snippet: snippetOf({ id, kind, html }) });
    }
    if ((kind === 'system' || kind === 'decision') && typeof html === 'string' && html.trim() !== '') {
      out.push({ key: 'node.nonpage-html', label: `节点 ${id} 是 ${kind} 却给了 \`html\``, expect: 'system/decision 只给 anno', snippet: snippetOf({ id, kind, html: html.slice(0, 40) }) });
    }
    if (typeof html === 'string' && html.trim() !== '' && !html.includes('<')) {
      out.push({ key: 'node.html-prose', label: `节点 ${id} 的 \`html\` 是描述文字而不是 HTML`, expect: '`<div class="wt-…">…</div>` 片段', snippet: snippetOf(html) });
    }
    const anno = item.anno;
    if (anno === undefined) {
      if (kind === 'page') out.push({ key: 'node.anno-absent', label: `节点 ${id} 没有 \`anno\``, expect: '1–3 条 `["小标题","正文"]`', snippet: snippetOf({ id }) });
      return;
    }
    if (!Array.isArray(anno)) {
      out.push({ key: 'node.anno-not-array', label: `节点 ${id} 的 \`anno\` 不是数组`, expect: '`[["小标题","正文"]]`', snippet: snippetOf(anno) });
      return;
    }
    if (anno.length > 0 && anno.every((row) => typeof row === 'string')) {
      out.push({
        key: 'node.anno-flat',
        label: `节点 ${id} 的 \`anno\` 是扁平字符串数组（少了一层）`,
        expect: '`[["小标题","正文"]]`',
        snippet: snippetOf(anno),
      });
      return;
    }
    if (anno.some((row) => isRecord(row))) {
      out.push({
        key: 'node.anno-object-rows',
        label: `节点 ${id} 的 \`anno\` 每项是对象`,
        expect: '`[["小标题","正文"]]`',
        snippet: snippetOf(anno.slice(0, 2)),
      });
      return;
    }
    const badRow = anno.find((row) => !Array.isArray(row) || row.length < 2 || row.length > 3 || row.some((cell) => typeof cell !== 'string'));
    if (badRow !== undefined) {
      out.push({ key: 'node.anno-row-shape', label: `节点 ${id} 的某条标注不是 2–3 个字符串`, expect: '`["小标题","正文"]`', snippet: snippetOf(badRow) });
    }
  });
}

/** 一份 JSON 回话的漂移清单。`root` 为 null 表示「回话里没有 JSON」。 */
function scanJson(raw: unknown, phase: 'structure' | 'verify' | 'pages'): Drift[] {
  const out: Drift[] = [];
  if (raw === null) {
    out.push({ key: 'root.no-json', label: '回话里没有 JSON 对象/数组', expect: '第一个字符是 `{`', snippet: '（无 JSON）' });
    return out;
  }
  if (Array.isArray(raw)) {
    out.push({
      key: 'root.array',
      label: '顶层是数组（丢了 flows/findings 这一层）',
      expect: phase === 'structure' ? '`{flows, findings}`' : '`{findings, nodes}`',
      snippet: snippetOf(raw).slice(0, 100),
    });
    return out;
  }
  if (!isRecord(raw)) {
    out.push({ key: 'root.not-object', label: '顶层不是对象', expect: '`{…}`', snippet: snippetOf(raw) });
    return out;
  }
  const expected = phase === 'structure' ? ['flows', 'findings'] : phase === 'verify' ? ['findings', 'nodes'] : ['nodes'];
  const extra = Object.keys(raw).filter((key) => !expected.includes(key));
  if (extra.length > 0) {
    out.push({
      key: 'root.extra-keys',
      label: `根对象多出键 ${JSON.stringify(extra)}`,
      expect: `只有 ${expected.join(' / ')}`,
      snippet: snippetOf(extra),
    });
  }
  if (phase !== 'pages') scanFindings(raw, 'findings', out);
  if (phase === 'structure') scanFlows(raw, out);
  if (phase !== 'structure') scanNodes(raw, out);
  return out;
}

/** mermaid 那段回话的漂移清单。 */
function scanFlowText(text: string): Drift[] {
  const out: Drift[] = [];
  const mermaid = mermaidIn(text);
  const shape = parseFlow(mermaid);
  const fenced = /```/.test(text);
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';
  const header = firstLine.toLowerCase().startsWith('flowchart') ? firstLine.toLowerCase().split(/\s+/)[0] ?? '' : '';

  if (fenced) {
    out.push({ key: 'flow.fenced', label: '回话包了 ``` 代码围栏', expect: '第一行就是 flowchart TD', snippet: snippetOf(text.slice(0, 60)) });
  }
  if (header === '') {
    out.push({ key: 'flow.no-header', label: '第一行不是 `flowchart TD`', expect: '第一行 `flowchart TD`', snippet: snippetOf(firstLine) });
  } else if (header !== 'flowchart') {
    out.push({ key: 'flow.graph-keyword', label: `用了 \`${firstLine.split(/\s+/)[0] ?? ''}\``, expect: '`flowchart TD`', snippet: snippetOf(firstLine) });
  }
  for (const [pattern, key, label] of [
    [/subgraph/i, 'flow.subgraph', '用了 `subgraph`'],
    [/classDef/i, 'flow.classDef', '用了 `classDef`'],
    [/^\s*style\s/i, 'flow.style', '用了 `style`'],
    [/click\s/i, 'flow.click', '用了 `click`'],
    [/%%/, 'flow.comment', '写了 `%%` 注释'],
  ] as const) {
    if (pattern.test(mermaid)) out.push({ key, label, expect: '纯 flowchart 节点 + 连线', snippet: snippetOf(mermaid.split('\n').find((line) => pattern.test(line)) ?? '') });
  }
  if (/\p{Extended_Pictographic}/u.test(text)) {
    out.push({ key: 'flow.emoji', label: '回话里有 emoji', expect: '无 emoji', snippet: snippetOf(text) });
  }
  if (shape.nodes.length < 3) {
    out.push({ key: 'flow.too-few-nodes', label: `只解析出 ${shape.nodes.length} 个节点`, expect: '3–8 个节点', snippet: snippetOf(mermaid).slice(0, 120) });
  }
  if (shape.edges < 2) {
    out.push({ key: 'flow.too-few-edges', label: `只解析出 ${shape.edges} 条连线`, expect: '至少 2 条连线', snippet: snippetOf(mermaid).slice(0, 120) });
  }
  // 一行里串了多段连线（`A --> B --> C`）：形状判据数得对（连线数没少），但 vendored
  // 排版器只认「单主干 + 右分支 + 回线」，实测直接拒（`节点 F,G,H 不符合…适用形态`）。
  const chained = mermaid.split('\n').find((line) => (line.match(/-->/g) ?? []).length >= 2);
  if (chained !== undefined) {
    out.push({
      key: 'flow.chained-edges',
      label: '一行里串了多段连线（`A --> B --> C`）',
      expect: '一条连线一行；分叉从判断节点单独出发',
      snippet: snippetOf(chained.trim()),
    });
  }
  const nonAsciiId = shape.nodes.find((node) => !/^[A-Za-z0-9_]+$/.test(node.id));
  if (nonAsciiId !== undefined) {
    out.push({ key: 'flow.non-ascii-id', label: `节点 id「${nonAsciiId.id}」不是字母数字`, expect: 'A、B、C…', snippet: snippetOf(nonAsciiId.id) });
  }
  const preamble = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')[0];
  if (preamble !== undefined && !preamble.toLowerCase().startsWith('flowchart') && !fenced) {
    out.push({ key: 'flow.preamble', label: '开头写了散文（「以下是流程图」之类）', expect: '只输出 mermaid 源码', snippet: snippetOf(preamble) });
  }
  return out;
}

function sigOf(drift: Drift[]): string {
  if (drift.length === 0) return 'clean';
  return [...new Set(drift.map((d) => d.key))].sort().join(' | ');
}

// ─── 依赖：配置、需求、PRD、镜像 ─────────────────────────────────────────────

type RequirementRow = {
  id: string;
  number: number;
  title: string;
  type: string;
  requester: string;
  prd_url: string | null;
};

async function loadRequirements(numbers: number[]): Promise<RequirementRow[]> {
  const res = await db.execute<RequirementRow>(sql`
    select id, number, title, type, requester, prd_url
      from requirements
     where number = any(${sql.raw(`array[${numbers.join(',')}]`)})
     order by number`);
  return res.rows.map((row) => ({ ...row, number: Number(row.number) }));
}

/**
 * 一个仓库的基线（与 `inspect.ts` 的 `baselineOf` 同一套读口与同一套排序）。
 *
 * 复制而不是导出：`baselineOf` 是私有的、且它 throw `AppError`；这里要的是
 * 「读不到就记一句、这一格跳过」，而不是让一个 ssh 抖动把整批停掉。
 */
async function baselineOf(repoId: string, keywords: string[]): Promise<RepoBaseline | null> {
  const [headRes, treeRes, shapeRes] = await Promise.all([head(repoId), lsTree(repoId), repoShape(repoId)]);
  if (!headRes.ok || headRes.data === null || !treeRes.ok || !shapeRes.ok) {
    process.stderr.write(`[mirror] ${repoId} 读不到：${!headRes.ok ? headRes.message : !treeRes.ok ? treeRes.message : !shapeRes.ok ? shapeRes.message : '空仓'}\n`);
    return null;
  }
  const perKeyword: Array<{ word: string; files: Set<string> }> = [];
  const results = await Promise.all(keywords.map((word) => grep(repoId, word, { max: 60 })));
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i]!;
    if (!result.ok) continue;
    const files = new Set<string>();
    for (const hit of result.data) if (treeRes.data.includes(hit.path)) files.add(hit.path);
    perKeyword.push({ word: keywords[i] ?? '', files });
  }
  return {
    id: repoId,
    sha: headRes.data.sha,
    date: headRes.data.date,
    subject: headRes.data.subject,
    files: treeRes.data.length,
    tree: new Set(treeRes.data),
    shape: shapeRes.data,
    candidates: rankCandidates(perKeyword),
  };
}

/** 深读段：与 `inspect.ts` 的 `deepRead` 同一口径（按引用顺序、40k 预算）。 */
type Excerpt = { repo: string; path: string; text: string; chars: number };

async function deepRead(findings: Finding[]): Promise<Excerpt[]> {
  const excerpts: Excerpt[] = [];
  let left = DEEP_READ_BUDGET;
  for (const citation of citationsOf(findings)) {
    if (left <= 0) break;
    const text = await show(citation.repo, citation.path, { maxBytes: Math.min(DEEP_READ_FILE_MAX, left) });
    if (!text.ok) continue;
    excerpts.push({ ...citation, text: text.data, chars: text.data.length });
    left -= text.data.length;
  }
  return excerpts;
}

// ─── 一次调用 ────────────────────────────────────────────────────────────────

type CallResult = {
  reply: ProviderResult;
  ms: number;
  /** 实际发了几次。>1 说明撞上了传输层抖动，不是模型的问题。 */
  attempts: number;
  /** 每一次的原文错误（重试过才有意义）。 */
  errors: string[];
  /** 这一格最后用的是哪个预算（没上调过就是会话计划里的那个）。 */
  maxTokens: number;
  /** 预算被「思考吃光」过：原预算是多少、模型思考了多少字。 */
  budgetBump: { from: number; to: number; reasoningChars: number } | null;
};

/**
 * 「思考吃光了预算」这一句是 `provider.ts` 自己在 content 为空、reasoning_content
 * 非空时说的。它**不是**模型的形状问题——模型根本没来得及写答案。
 *
 * 处理方式：把预算抬到四倍再问一次，并把「抬过」这件事记在格子上。这样语料里既有
 * 「4k 不够」这条事实（`budgetBump`），又能拿到那份回话的形状（形状样本不丢）。
 * 上限 65536：两个可用模型实测都接受（见文档的「成本」一节）。
 */
const BUDGET_CEILING = 65_536;

function thinkingOnly(error: string): number | null {
  const match = /思考 (\d+) 字、答案 0 字/.exec(error);
  return match === null ? null : Number.parseInt(match[1] ?? '0', 10);
}

/** 传输层抖动 vs 模型的回答：前者重发一次，后者重发只会拿到同一个形状。 */
function transient(error: string): boolean {
  return /请求失败|请求超时|terminated|other side closed|socket|ECONNRESET|HTTP 5\d\d|HTTP 429|空内容/.test(error);
}

/**
 * 发一次调用，抖动重试一次。
 *
 * 为什么要有重试：并发下网关会偶发 `terminated（other side closed）`（实测一次
 * evaluate/pages），把它记成「模型失败」是错的——那一格什么都证明不了，白占一个
 * 样本。重试只对**传输层**开，形状类问题（JSON 不对）一次就是一次。
 */
async function callModel(
  cfg: ProviderConfig,
  model: string,
  prompt: string,
  phase: Phase,
  timeoutMs: number,
): Promise<CallResult> {
  const started = Date.now();
  const errors: string[] = [];
  let maxTokens = BUDGET[phase];
  let budgetBump: CallResult['budgetBump'] = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const reply = await complete({ ...cfg, model }, prompt, { maxTokens, timeoutMs });
    if (reply.ok) return { reply, ms: Date.now() - started, attempts: attempt, errors, maxTokens, budgetBump };

    errors.push(reply.error);
    const reasoned = thinkingOnly(reply.error);
    if (reasoned !== null && budgetBump === null) {
      const bumped = Math.min(maxTokens * 4, BUDGET_CEILING);
      budgetBump = { from: maxTokens, to: bumped, reasoningChars: reasoned };
      process.stderr.write(`[budget] ${model} ${phase}：思考 ${String(reasoned)} 字吃光 ${String(maxTokens)}，抬到 ${String(bumped)}\n`);
      maxTokens = bumped;
      continue;
    }
    if (!transient(reply.error)) return { reply, ms: Date.now() - started, attempts: attempt, errors, maxTokens, budgetBump };
    if (attempt >= 3) return { reply, ms: Date.now() - started, attempts: attempt, errors, maxTokens, budgetBump };
    process.stderr.write(`[retry] ${model} ${phase}：${reply.error}\n`);
  }
  throw new Error('不可达');
}

/** 写一条原始回话。**先落盘再解析**：批次断了，语料还在。 */
function writeRaw(dir: string, name: string, payload: unknown): void {
  try {
    writeFileSync(path.join(dir, 'raw', `${name}.json`), JSON.stringify(payload, null, 1), 'utf8');
  } catch (error) {
    process.stderr.write(`[raw] 写不进 ${name}：${String(error)}\n`);
  }
}

// ─── 并发限流 ────────────────────────────────────────────────────────────────

function limiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = (): void => {
    active -= 1;
    const next = queue.shift();
    if (next !== undefined) next();
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

type CellKey = { model: string; stage: Stage; requirement: number; rep: number };

/**
 * 只重出报告：`--report-only <语料目录>`。
 *
 * 为什么要有：报告是一份**渲染**，语料是事实。改了表格分组、想按新口径重排，
 * 不该再花一轮调用。语料目录里只要有 report.json 就能重出 report.md。
 */
function rerender(dir: string): void {
  const data = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8')) as Report;
  const refreshed: Report = { ...data, ...derive(data.meta.plan, data.cells) };
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(refreshed, null, 1), 'utf8');
  writeFileSync(path.join(dir, 'report.md'), reportMarkdown(refreshed), 'utf8');
  process.stdout.write(`${path.join(dir, 'report.md')}\n`);
}

/**
 * 用**当前的扫描器**重算已有语料的 `drift`（`--rescan <语料目录>`）。
 *
 * 为什么要：扫描器本身会演进（这一批跑完才发现「一条字符串拼多个路径」「截断」
 * 这两种形状要单列）。语料是事实、扫描器是透镜——换透镜不该再花一轮调用。
 * 回话原文在 `raw/` 里，重扫只读本地文件。
 */
function rescan(dir: string): void {
  const data = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8')) as Report;
  for (const cell of data.cells) {
    if (cell.skipped !== null || cell.replyChars === 0) continue;
    const name = `${safeName(cell.model)}-${cell.stage}-${String(cell.requirement)}-${String(cell.rep)}-${cell.phase}`;
    let text = '';
    try {
      const raw = JSON.parse(readFileSync(path.join(dir, 'raw', `${name}.json`), 'utf8')) as { reply?: { text?: string } };
      text = raw.reply?.text ?? '';
    } catch {
      continue;
    }
    if (text === '') continue;
    if (cell.phase === 'flow') {
      cell.drift = scanFlowText(text);
    } else {
      cell.drift = scanJson(extractJson<unknown>(text), cell.phase === 'structure' ? 'structure' : cell.phase === 'pages' ? 'pages' : 'verify');
    }
    cell.sig = sigOf(cell.drift);
  }
  const refreshed: Report = { ...data, ...derive(data.meta.plan, data.cells) };
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(refreshed, null, 1), 'utf8');
  writeFileSync(path.join(dir, 'report.md'), reportMarkdown(refreshed), 'utf8');
  process.stdout.write(`${path.join(dir, 'report.md')}\n`);
}

async function main(): Promise<void> {
  const rescanned = argOf(process.argv.slice(2), 'rescan');
  if (rescanned !== null) {
    rescan(rescanned);
    return;
  }
  const only = argOf(process.argv.slice(2), 'report-only');
  if (only !== null) {
    rerender(only);
    return;
  }
  const plan = parsePlan(process.argv.slice(2));
  const cfg = await resolveProviderConfig();
  if (cfg === null) {
    process.stderr.write('未配置模型接口：provider.baseUrl / provider.apiKey / provider.model 三格不全\n');
    process.exitCode = 1;
    return;
  }

  const dir = path.join(plan.outRoot, stamp());
  mkdirSync(path.join(dir, 'raw'), { recursive: true });
  writeFileSync(
    path.join(dir, 'plan.json'),
    JSON.stringify({ plan, baseUrl: cfg.baseUrl, defaultModel: cfg.model, budget: BUDGET, startedAt: new Date().toISOString() }, null, 1),
    'utf8',
  );

  const started = Date.now();
  const run = limiter(plan.concurrency);
  const requirements = await loadRequirements(plan.requirements);
  const found = new Set(requirements.map((row) => row.number));
  for (const number of plan.requirements) {
    if (!found.has(number)) process.stderr.write(`[plan] PAN-${number} 不在库里，跳过\n`);
  }

  /** 一格一条：`cell` 先建好（顺序稳定），`run` 只负责往里填。 */
  type Job = { cell: Cell; run: () => Promise<void> };
  const wave1: Job[] = [];

  // ── 第一段：flow（评估/评审）/ structure（走查） ──
  for (const row of requirements) {
    for (const stage of plan.stages) {
      const phase = PHASE_OF[stage].first;
      const snapshot = stage === 'inspect' ? await snapshotOf(row) : null;
      const skip = stage === 'inspect' && snapshot === null
        ? `PAN-${String(row.number)} 没有 PRD 快照（prd_url 是 .example 假地址），inspect 用不了`
        : null;
      const built = skip === null ? await buildFirstPrompt(row, stage) : null;
      const prompt = built?.prompt ?? '';
      const why = skip ?? (built === null ? `PAN-${row.number} ${stage} 的前置读不到（PRD/镜像），整格跳过` : null);

      for (const model of plan.models) {
        for (let rep = 1; rep <= plan.repeat; rep += 1) {
          if (why !== null) {
            wave1.push({ cell: skippedCell(model, stage, phase, row.number, rep, why), run: async () => {} });
            continue;
          }
          const cell = blankCell({ model, stage, requirement: row.number, rep }, phase, prompt.length);
          const state: FirstState = { cell, text: '', ok: false, doc: null, nodes: [], svg: '' };
          wave1.push({ cell, run: () => callAndRead(cfg, dir, plan, model, stage, phase, row, rep, prompt, state) });
        }
      }
    }
  }

  await Promise.all(wave1.map((job) => run(async () => {
    try {
      await job.run();
    } catch (error) {
      job.cell.error = `跑批脚本自己抛错：${String(error)}`;
      job.cell.why = job.cell.error;
    }
  })));
  process.stderr.write(`[wave1] ${String(wave1.length)} 格，已用 ${String(Math.round((Date.now() - started) / 1000))} 秒\n`);

  // ── 第二段：pages（评估/评审）/ verify（走查） ──
  // 提示词里要放第一段的产物。同一需求下取**一份参考产物**（第一条通过的），
  // 于是两个模型、三次重复拿到的是同一份提示词：漂移才可比。
  const wave2: Job[] = [];
  for (const row of requirements) {
    for (const stage of plan.stages) {
      const phase = PHASE_OF[stage].second;
      const pool = wave1.map((job) => job.cell).filter((cell) => cell.stage === stage && cell.requirement === row.number && cell.skipped === null);
      if (pool.length === 0) continue;
      const okCells = pool.filter((cell) => cell.ok);
      const refCell = okCells[0] ?? pool.find((cell) => (pendingNodes.get(cell)?.length ?? 0) > 0) ?? null;
      const refDoc = (okCells.find((cell) => pendingDoc.has(cell)) !== undefined
        ? pendingDoc.get(okCells.find((cell) => pendingDoc.has(cell))!)
        : null) ?? null;
      const refNodes = refCell === null ? [] : pendingNodes.get(refCell) ?? [];
      const refSvg = pool.map((cell) => pendingSvg.get(cell) ?? '').find((svg) => svg !== '') ?? '';
      const trees = builtPrd.get(row.number)?.trees;

      let prompt: string | null = null;
      let skipWhy = '';
      if (stage === 'inspect') {
        if (refDoc === null || trees === undefined) {
          skipWhy = `PAN-${row.number} 的 structure 段没有一条通过校验，拼不出复核提示词`;
        } else {
          const excerpts = await deepRead(refDoc.findings);
          prompt = verifyPrompt(row, builtPrd.get(row.number)!.prd, refDoc.flows, refDoc.findings, excerpts);
        }
      } else if (refNodes.length === 0) {
        skipWhy = `PAN-${row.number} 的 flow 段没有一条解析出节点，拼不出页面片段提示词`;
      } else {
        prompt = fragmentsPrompt(row, stage, refNodes);
      }

      for (const model of plan.models) {
        for (let rep = 1; rep <= plan.repeat; rep += 1) {
          if (prompt === null) {
            wave2.push({ cell: skippedCell(model, stage, phase, row.number, rep, skipWhy), run: async () => {} });
            continue;
          }
          const cell = blankCell({ model, stage, requirement: row.number, rep }, phase, prompt.length);
          const text = prompt;
          wave2.push({
            cell,
            run: () => callSecond(cfg, dir, plan, model, stage, phase, row, rep, text, cell, { refNodes, refSvg, refDoc, trees }),
          });
        }
      }
    }
  }

  await Promise.all(wave2.map((job) => run(async () => {
    try {
      await job.run();
    } catch (error) {
      job.cell.error = `跑批脚本自己抛错：${String(error)}`;
      job.cell.why = job.cell.error;
    }
  })));

  const cells = [...wave1.map((job) => job.cell), ...wave2.map((job) => job.cell)];
  const elapsedMs = Date.now() - started;
  const report = buildReport(plan, cfg, dir, cells, elapsedMs);
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 1), 'utf8');
  writeFileSync(path.join(dir, 'report.md'), reportMarkdown(report), 'utf8');
  process.stdout.write(`${path.join(dir, 'report.md')}\n`);
  await pool.end();
}

/** 第一段跑完要把「结论/节点/SVG」交给第二段：挂在 cell 上比并行数组好对齐。 */
const pendingDoc = new WeakMap<Cell, Structure>();
const pendingNodes = new WeakMap<Cell, FlowNode[]>();
const pendingSvg = new WeakMap<Cell, string>();

async function callAndRead(
  cfg: ProviderConfig,
  dir: string,
  plan: Plan,
  model: string,
  stage: Stage,
  phase: Phase,
  row: RequirementRow,
  rep: number,
  prompt: string,
  state: FirstState,
): Promise<void> {
  const cell = state.cell;
  const name = `${safeName(model)}-${stage}-${String(row.number)}-${String(rep)}-${phase}`;
  const { reply, ms, attempts, errors, maxTokens, budgetBump } = await callModel(cfg, model, prompt, phase, plan.timeoutMs);
  writeRaw(dir, name, { model, stage, phase, requirement: row.number, rep, prompt, reply, ms, attempts, errors, maxTokens, budgetBump, at: new Date().toISOString() });
  cell.ms = ms;
  cell.attempts = attempts;
  cell.maxTokens = maxTokens;
  cell.budgetBump = budgetBump;
  cell.at = new Date().toISOString();
  if (!reply.ok) {
    cell.error = reply.error;
    cell.why = reply.error;
    return;
  }
  cell.replyChars = reply.text.length;
  cell.usage = reply.usage === undefined ? null : { prompt: reply.usage.prompt ?? 0, completion: reply.usage.completion ?? 0 };
  cell.excerpt = excerptOf(reply.text);
  state.text = reply.text;
  await readFirst(cell, state, phase);
  if (state.doc !== null) pendingDoc.set(cell, state.doc);
  if (state.nodes.length > 0) pendingNodes.set(cell, state.nodes);
  if (state.svg !== '') pendingSvg.set(cell, state.svg);
}

async function callSecond(
  cfg: ProviderConfig,
  dir: string,
  plan: Plan,
  model: string,
  stage: Stage,
  phase: Phase,
  row: RequirementRow,
  rep: number,
  prompt: string,
  cell: Cell,
  ref: { refNodes: FlowNode[]; refSvg: string; refDoc: Structure | null; trees: TreeIndex | undefined },
): Promise<void> {
  const name = `${safeName(model)}-${stage}-${String(row.number)}-${String(rep)}-${phase}`;
  const { reply, ms, attempts, errors, maxTokens, budgetBump } = await callModel(cfg, model, prompt, phase, plan.timeoutMs);
  writeRaw(dir, name, { model, stage, phase, requirement: row.number, rep, prompt, reply, ms, attempts, errors, maxTokens, budgetBump, at: new Date().toISOString() });
  cell.ms = ms;
  cell.attempts = attempts;
  cell.maxTokens = maxTokens;
  cell.budgetBump = budgetBump;
  cell.at = new Date().toISOString();
  if (!reply.ok) {
    cell.error = reply.error;
    cell.why = reply.error;
    return;
  }
  cell.replyChars = reply.text.length;
  cell.usage = reply.usage === undefined ? null : { prompt: reply.usage.prompt ?? 0, completion: reply.usage.completion ?? 0 };
  cell.excerpt = excerptOf(reply.text);
  if (phase === 'pages') {
    readPages(cell, reply.text, ref.refNodes, row, stage === 'review' ? 'review' : 'evaluate', ref.refSvg);
  } else if (ref.refDoc !== null && ref.trees !== undefined) {
    readVerifyCell(cell, reply.text, ref.refDoc, ref.trees);
  }
}

// ─── 提示词：第一段 ─────────────────────────────────────────────────────────

type BuiltPrd = { prd: PrdBaseline; keywords: string[]; repos: RepoBaseline[]; trees: TreeIndex };

/** 按需求缓存 PRD + 镜像基线：一个需求 6 格（2 模型 × 3 次）用同一份提示词。 */
const builtPrd = new Map<number, BuiltPrd>();
const snapshotCache = new Map<number, Snapshot | null>();

async function snapshotOf(row: RequirementRow): Promise<Snapshot | null> {
  const cached = snapshotCache.get(row.number);
  if (cached !== undefined) return cached;
  const snapshot = await latestSnapshot(db, row.id);
  snapshotCache.set(row.number, snapshot);
  return snapshot;
}

async function buildFirstPrompt(
  row: RequirementRow,
  stage: Stage,
): Promise<{ prompt: string } | null> {
  if (stage !== 'inspect') {
    return { prompt: flowPrompt(row, stage) };
  }
  let prep = builtPrd.get(row.number);
  if (prep === undefined) {
    const snapshot = await snapshotOf(row);
    if (snapshot === null || snapshot.markdown.trim() === '') return null;
    const prd: PrdBaseline = {
      url: snapshot.url,
      markdown: snapshot.markdown,
      hash: snapshot.hash,
      version: prdVersionOf(snapshot.markdown, snapshot.hash),
      chars: snapshot.markdown.length,
    };
    const keywords = keywordsFrom(prd.markdown, row.title);
    const repos: RepoBaseline[] = [];
    for (const repoId of INSPECT_REPOS) {
      const repo = await baselineOf(repoId, keywords);
      if (repo === null) return null;
      repos.push(repo);
    }
    prep = { prd, keywords, repos, trees: new Map(repos.map((repo) => [repo.id, repo.tree])) };
    builtPrd.set(row.number, prep);
  }
  return { prompt: structurePrompt(row, prep.prd, prep.repos, prep.keywords) };
}

// ─── 解析：与应用同一条路，但全量收 issue ──────────────────────────────────

function blankCell(key: CellKey, phase: Phase, promptChars: number): Cell {
  return {
    model: key.model,
    stage: key.stage,
    phase,
    requirement: key.requirement,
    rep: key.rep,
    ok: false,
    why: '',
    issues: [],
    problems: [],
    walkmap: [],
    drift: [],
    sig: 'clean',
    promptChars,
    replyChars: 0,
    excerpt: '',
    ms: 0,
    attempts: 0,
    maxTokens: 0,
    budgetBump: null,
    usage: null,
    error: null,
    skipped: null,
    at: new Date().toISOString(),
  };
}

function skippedCell(model: string, stage: Stage, phase: Phase, requirement: number, rep: number, why: string): Cell {
  const cell = blankCell({ model, stage, requirement, rep }, phase, 0);
  cell.skipped = why;
  cell.why = why;
  return cell;
}

type FirstState = {
  cell: Cell;
  text: string;
  ok: boolean;
  doc: Structure | null;
  nodes: FlowNode[];
  svg: string;
};

/**
 * 第一段的解析。
 *
 * 两件事分开记：
 * - `issues`：**原样** `Schema.safeParse` 的**全部** issue（zod 一次给全，不是 `issues[0]`），
 *   这是分类表的原料；
 * - `why`：应用那条路（`readStructure` / `readFragments`，带现有的扶正）会说的那一句。
 */
async function readFirst(cell: Cell, state: FirstState, phase: Phase): Promise<void> {
  const raw = extractJson<unknown>(state.text);
  if (phase === 'flow') {
    // 与 `buildFlow` 同一套判据：先抠 mermaid，再数形状，再交给本地排版器。
    // 引擎报错（`subgraph` 之类）也是漂移——应用会因为它整份退回。
    const mermaid = mermaidIn(state.text);
    const shape = parseFlow(mermaid);
    const check: FlowCheck = await renderFlowchart(mermaid);
    state.nodes = shape.nodes;
    state.svg = check.ok && check.svg !== undefined ? check.svg : '';
    const tooSmall = shape.nodes.length < 3 || shape.edges < 2;
    const engine = check.ok
      ? ''
      : check.error ?? `交叉 ${String(check.crossings)}、重叠 ${String(check.overlaps)}、文字溢出 ${String(check.textOverflow)}`;
    cell.issues = [];
    cell.drift = scanFlowText(state.text);
    cell.sig = sigOf(cell.drift);
    cell.ok = check.ok && !tooSmall;
    cell.why = [engine, tooSmall ? `只有 ${String(shape.nodes.length)} 个节点、${String(shape.edges)} 条连线` : '']
      .filter((part) => part !== '').join('；');
    state.ok = cell.ok;
    return;
  }

  if (phase === 'structure') {
    const parsedRaw = StructureSchema.safeParse(raw === null ? {} : raw);
    cell.issues = parsedRaw.success ? [] : parsedRaw.error.issues.map(issueLite);
    cell.drift = scanJson(raw, 'structure');
    cell.sig = sigOf(cell.drift);
    const trees = builtPrd.get(cell.requirement)?.trees ?? new Map<string, Set<string>>();
    const read = readStructure(state.text, [...trees.keys()]);
    if (!read.ok) {
      cell.why = read.why;
      cell.ok = false;
      return;
    }
    const checked = validateStructure(read.doc, trees);
    cell.problems = checked.problems;
    cell.ok = checked.ok;
    cell.why = checked.ok ? '' : checked.problems[0] ?? '结论没过校验';
    if (checked.ok) {
      state.ok = true;
      state.doc = read.doc;
      state.nodes = read.doc.flows.map((flow) => ({
        id: flow.id,
        label: flow.title,
        kind: flow.kind === 'decision' ? 'decision' : flow.kind === 'system' ? 'backend' : 'process',
      }));
    }
    return;
  }

  throw new Error(`第一段不该是 ${phase}`);
}

function readPages(
  cell: Cell,
  text: string,
  refNodes: FlowNode[],
  row: RequirementRow,
  stage: 'evaluate' | 'review',
  svg: string,
): void {
  const raw = extractJson<unknown>(text);
  const parsedRaw = FragmentsSchema.safeParse(raw === null ? {} : raw);
  cell.issues = parsedRaw.success ? [] : parsedRaw.error.issues.map(issueLite);
  cell.drift = scanJson(raw, 'pages');
  cell.sig = sigOf(cell.drift);

  const ids = refNodes.map((node) => node.id);
  const read = readFragments(text, ids);
  if (!read.ok) {
    cell.why = read.why;
    cell.ok = false;
    return;
  }
  // JSON + 覆盖率过了，再看 walkmap 契约（wt-* 类、emoji、状态组）：那是内容层，
  // 与形状分开记——混在一起会让「模型写歪了形状」和「模型写歪了页面」读不清。
  try {
    const title = `PAN-${row.number}「${row.title}」${stage === 'evaluate' ? '评估材料' : '评审材料'}`;
    const assembled = assembleWalkmap({ nodes: read.doc.nodes }, { title, svg });
    const report = validateWalkmap(assembled.walkmap, { svg, fragments: assembled.fragments });
    cell.walkmap = report.errors.slice(0, 8);
  } catch (error) {
    cell.walkmap = [`walkmap 拼装抛错：${String(error)}`];
  }
  cell.ok = true;
  cell.why = '';
}

function readVerifyCell(cell: Cell, text: string, ref: Structure, trees: TreeIndex): void {
  const raw = extractJson<unknown>(text);
  const parsedRaw = VerifySchema.safeParse(raw === null ? {} : raw);
  cell.issues = parsedRaw.success ? [] : parsedRaw.error.issues.map(issueLite);
  cell.drift = scanJson(raw, 'verify');
  cell.sig = sigOf(cell.drift);

  const read = readVerify(text, ref.flows.map((flow) => flow.id), trees);
  cell.ok = read.ok;
  cell.why = read.ok ? '' : read.why;
}

// ─── 报告 ────────────────────────────────────────────────────────────────────

type Group = { count: number; excerpt: string; models: Set<string> };

function tally(map: Map<string, Group>, key: string, model: string, excerpt: string): void {
  const seen = map.get(key);
  if (seen === undefined) {
    map.set(key, { count: 1, excerpt, models: new Set([model]) });
    return;
  }
  seen.count += 1;
  seen.models.add(model);
}

type Report = {
  meta: {
    dir: string;
    startedAt: string;
    finishedAt: string;
    elapsedMs: number;
    baseUrl: string;
    defaultModel: string;
    plan: Omit<Plan, 'outRoot'> & { outRoot: string };
    budget: Record<Phase, number>;
  };
  counts: {
    cells: number;
    called: number;
    ok: number;
    rejected: number;
    providerError: number;
    skipped: number;
    /** 回话为空、且原因是「思考吃光预算」的格数（含抬预算后救回来的）。 */
    thinkingStarved: number;
    /** 抬过预算的格数。 */
    budgetBumped: number;
    tokens: { prompt: number; completion: number };
    perCell: Array<{ stage: Stage; phase: Phase; model: string; requirement: number; ok: number; total: number; skipped: number }>;
  };
  why: Array<{ stage: Stage; phase: Phase; why: string; count: number; models: string[]; excerpt: string }>;
  taxonomy: Array<{ stage: Stage; phase: Phase; key: string; label: string; expect: string; count: number; models: string[]; excerpt: string }>;
  unobserved: string[];
  cells: Cell[];
};

/**
 * 从格子重新算一遍派生块（计数 / why / 分类表 / 未触发清单）。
 *
 * 为什么派生而**不把算好的结果存起来复用**：报告是一份渲染，语料是事实。`--report-only`
 * 拿到的 `report.json` 可能是更早一版脚本写的（少了新加的列），从 `cells` 重算就永远
 * 不会出现「表头多了 stage、行里是 undefined」这种半旧半新的报告。
 */
function derive(plan: Plan, cells: Cell[]): Pick<Report, 'counts' | 'why' | 'taxonomy' | 'unobserved'> {
  // **截断**是这一层最容易漏的一条：JS 的「括号没闭合」和「模型写坏了」在报错上长得
  // 一模一样（`extractJson` 甚至会在外层坏掉时退到内层那个能解析的 `{`，于是报
  // 「nodes：Required」）。判据放在这里而不在扫描器里：它看的是**调用事实**
  // （completion 顶到 max_tokens），不是回话文本。
  for (const cell of cells) {
    if (cell.usage === null || cell.maxTokens <= 0) continue;
    if (cell.usage.completion < cell.maxTokens) continue;
    cell.drift = [...cell.drift, {
      key: 'reply.truncated',
      label: '回话被输出预算截断（completion 顶到 max_tokens）',
      expect: '回话完整闭合；或把这一段的 max_tokens 调大',
      snippet: `completion=${String(cell.usage.completion)} / max_tokens=${String(cell.maxTokens)}`,
    }];
    cell.sig = sigOf(cell.drift);
  }

  const called = cells.filter((cell) => cell.skipped === null && (cell.replyChars > 0 || cell.error !== null));
  const ok = called.filter((cell) => cell.ok);
  const providerError = called.filter((cell) => cell.error !== null);
  const tokens = { prompt: 0, completion: 0 };
  for (const cell of cells) {
    tokens.prompt += cell.usage?.prompt ?? 0;
    tokens.completion += cell.usage?.completion ?? 0;
  }

  const perCell: Report['counts']['perCell'] = [];
  for (const stage of plan.stages) {
    for (const phase of new Set([PHASE_OF[stage].first, PHASE_OF[stage].second])) {
      for (const model of plan.models) {
        for (const requirement of plan.requirements) {
          const group = cells.filter((cell) => cell.stage === stage && cell.phase === phase && cell.model === model && cell.requirement === requirement);
          if (group.length === 0) continue;
          perCell.push({
            stage,
            phase,
            model,
            requirement,
            ok: group.filter((cell) => cell.ok).length,
            total: group.filter((cell) => cell.skipped === null).length,
            skipped: group.filter((cell) => cell.skipped !== null).length,
          });
        }
      }
    }
  }

  const whyMap = new Map<string, Group>();
  for (const cell of cells) {
    if (cell.ok || cell.why === '' || cell.skipped !== null) continue;
    tally(whyMap, `${cell.stage}\u0000${cell.phase}\u0000${cell.why}`, cell.model, cell.excerpt);
  }
  const why = [...whyMap.entries()]
    .map(([key, group]) => {
      const [stage, phase, text] = key.split('\u0000');
      return {
        stage: stage as Stage,
        phase: phase as Phase,
        why: text ?? '',
        count: group.count,
        models: [...group.models].sort(),
        excerpt: group.excerpt,
      };
    })
    .sort((a, b) => b.count - a.count);

  const taxonomyMap = new Map<string, Group & { label: string; expect: string }>();
  for (const cell of cells) {
    for (const drift of cell.drift) {
      const key = `${cell.stage}\u0000${cell.phase}\u0000${drift.key}`;
      const seen = taxonomyMap.get(key);
      if (seen === undefined) {
        taxonomyMap.set(key, { count: 1, excerpt: drift.snippet, models: new Set([cell.model]), label: drift.label, expect: drift.expect });
        continue;
      }
      seen.count += 1;
      seen.models.add(cell.model);
    }
  }
  const taxonomy = [...taxonomyMap.entries()]
    .map(([key, group]) => {
      const [stage, phase, driftKey] = key.split('\u0000');
      return {
        stage: stage as Stage,
        phase: phase as Phase,
        key: driftKey ?? '',
        label: group.label,
        expect: group.expect,
        count: group.count,
        models: [...group.models].sort(),
        excerpt: group.excerpt,
      };
    })
    .sort((a, b) => a.stage.localeCompare(b.stage) || a.phase.localeCompare(b.phase) || b.count - a.count);

  return {
    counts: {
      cells: cells.length,
      called: called.length,
      ok: ok.length,
      rejected: called.length - ok.length - providerError.length,
      providerError: providerError.length,
      skipped: cells.filter((cell) => cell.skipped !== null).length,
      thinkingStarved: cells.filter((cell) => cell.budgetBump !== null || /思考/.test(cell.error ?? '')).length,
      budgetBumped: cells.filter((cell) => cell.budgetBump !== null).length,
      tokens,
      perCell,
    },
    why,
    taxonomy,
    // 键里可能带值（`finding.verdict-alias:partial/部分实现`），所以按前缀比。
    unobserved: KNOWN_DRIFTS.filter((known) => !taxonomy.some((row) => row.key === known || row.key.startsWith(`${known}:`))),
  };
}

function buildReport(plan: Plan, cfg: ProviderConfig, dir: string, cells: Cell[], elapsedMs: number): Report {
  return {
    meta: {
      dir,
      startedAt: new Date(Date.now() - elapsedMs).toISOString(),
      finishedAt: new Date().toISOString(),
      elapsedMs,
      baseUrl: cfg.baseUrl,
      defaultModel: cfg.model,
      plan: { ...plan, outRoot: plan.outRoot },
      budget: BUDGET,
    },
    ...derive(plan, cells),
    cells,
  };
}

/**
 * 「已知会漂」的清单（来自上一轮真实跑批的观察）。
 *
 * 报告末尾把**这一次没见到**的列出来：那几行是「不能保证已处理」的那一段——
 * 只有被真实回话触发过的漂移，才有资格写进「已观察 / 已覆盖」。
 */
const KNOWN_DRIFTS: string[] = [
  'evidence.string-with-repo-prefix',
  'evidence.object-other-keys',
  'evidence.string-multiple-paths',
  'node.anno-flat',
  'node.anno-object-rows',
  'node.frame-alias',
  'node.kind-alias',
  'node.page-no-html',
  'finding.searched-not-array',
  'finding.verdict-alias',
  'finding.missing-no-scope',
  'root.array',
  'reply.truncated',
  'flow.chained-edges',
  'flow.subgraph',
];

const EXPECT_OF: Record<string, string> = {
  'root.no-json': '第一个字符是 `{`',
  'root.array': '`{flows, findings}` / `{findings, nodes}`',
  'root.extra-keys': '只有约定的键',
  'root.findings-under-results': '根对象里叫 `findings`',
  'root.findings-empty': '至少 1 条结论',
  'finding.verdict-alias': '四选一枚举',
  'finding.searched-not-array': '`searched: ["…"]`',
  'finding.missing-no-scope': 'missing 要给 `searched` 或指一个「本该在哪」的文件',
  'evidence.string-with-repo-prefix': '`{repo, path, note}`',
  'evidence.string-multiple-paths': '一个文件一条 evidence',
  'evidence.object-other-keys': '`{repo, path, note}`',
  'evidence.note-not-string': '`note` 一句话',
  'node.anno-flat': '`[["小标题","正文"]]`',
  'node.anno-object-rows': '`[["小标题","正文"]]`',
  'node.frame-alias': '`phone` / `wide`',
  'node.kind-alias': '`page` / `system` / `decision`',
  'node.page-no-html': 'kind=page 必须给一屏 HTML',
  'node.html-prose': 'HTML 片段，不是描述',
  'flow.fenced': '第一行 `flowchart TD`',
  'flow.no-header': '第一行 `flowchart TD`',
  'flow.subgraph': '不用 subgraph',
  'flow.chained-edges': '一条连线一行',
  'reply.truncated': '回话完整闭合（或调大这一段的 max_tokens）',
};

function reportMarkdown(report: Report): string {
  const lines: string[] = [];
  const { meta, counts } = report;
  lines.push('# 形状漂移语料报告', '');
  lines.push(`- 语料目录：\`${meta.dir}\``);
  lines.push(`- 接口：\`${meta.baseUrl}\`（模型：${meta.plan.models.join('、')}；默认 ${meta.defaultModel}）`);
  lines.push(`- 计划：需求 ${meta.plan.requirements.map((n) => `PAN-${n}`).join('、')}；阶段 ${meta.plan.stages.join('、')}；每格重复 ${meta.plan.repeat} 次；并发 ${meta.plan.concurrency}；单次超时 ${Math.round(meta.plan.timeoutMs / 1000)} 秒`);
  lines.push(`- 预算：${Object.entries(meta.budget).map(([phase, tokens]) => `${phase} ${tokens}`).join(' / ')}`);
  lines.push(`- 用时：${(meta.elapsedMs / 1000 / 60).toFixed(1)} 分钟（${meta.startedAt} → ${meta.finishedAt}）`);
  lines.push(`- 调用：${counts.called} 次（成功收下 ${counts.ok}、被拒 ${counts.rejected}、接口层失败 ${counts.providerError}、跳过 ${counts.skipped}）`);
  lines.push(`- 预算：思考吃光预算 ${counts.thinkingStarved} 格，其中 ${counts.budgetBumped} 格抬到四倍后才拿到回话`);
  lines.push(`- token：prompt ${counts.tokens.prompt} / completion ${counts.tokens.completion}`);
  lines.push('');

  lines.push('## 每格成败', '', '| 阶段 | 段 | 模型 | 需求 | 通过/调用 | 跳过 |', '| --- | --- | --- | --- | --- | --- |');
  for (const row of counts.perCell) {
    lines.push(`| ${row.stage} | ${row.phase} | ${row.model} | PAN-${row.requirement} | ${row.ok}/${row.total} | ${row.skipped} |`);
  }
  lines.push('');

  lines.push('## 失败原因（按 阶段·段 分组，每条一个 why）', '');
  const stages = [...new Set(report.why.map((row) => `${row.stage}\u0000${row.phase}`))];
  for (const key of stages) {
    const [stage, phase] = key.split('\u0000');
    lines.push(`### ${stage} · ${phase}`, '');
    for (const row of report.why.filter((item) => item.stage === stage && item.phase === phase)) {
      lines.push(`- ×${row.count}（${row.models.join('、')}）${row.why}`);
      lines.push(`  - 原文：\`${row.excerpt.replace(/\|/g, '\\|')}\``);
    }
    lines.push('');
  }
  if (report.why.length === 0) lines.push('（没有失败）', '');

  lines.push('## 形状漂移分类表', '');
  lines.push('| 阶段 | 段 | 现象 | 模型原文片段 | 出现次数 | 我们的期望 |', '| --- | --- | --- | --- | --- | --- |');
  for (const row of report.taxonomy) {
    const snippet = row.excerpt.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${row.stage} | ${row.phase} | ${row.label.replace(/\|/g, '\\|')} | \`${snippet}\` | ${row.count} | ${row.expect.replace(/\|/g, '\\|')} |`);
  }
  if (report.taxonomy.length === 0) lines.push('| — | — | 这一批没有观察到形状漂移 | — | 0 | — |');
  lines.push('');

  lines.push('## 这一批没触发到的已知漂移', '');
  if (report.unobserved.length === 0) lines.push('（上一轮表里的每一条都复现了）');
  for (const key of report.unobserved) {
    lines.push(`- \`${key}\`：${EXPECT_OF[key] ?? '（无备注）'}`);
  }
  lines.push('');

  lines.push('## 逐格明细', '');
  lines.push('| 模型 | 阶段 | 段 | PAN | rep | ok | why | 形状指纹 |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const cell of report.cells) {
    lines.push(`| ${cell.model} | ${cell.stage} | ${cell.phase} | ${cell.requirement} | ${cell.rep} | ${cell.ok ? '✓' : cell.skipped !== null ? 'skip' : '✗'} | ${(cell.why || '').replace(/\|/g, '\\|').slice(0, 120)} | ${cell.sig} |`);
  }
  lines.push('');
  return lines.join('\n');
}

process.on('SIGINT', () => {
  process.stderr.write('\n[中断] 已落盘的原始回话在 raw/ 下；report 只有跑完才会写\n');
  process.exit(130);
});

await main();
