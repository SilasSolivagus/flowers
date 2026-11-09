import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportIn } from './flow.js';

/**
 * walkmap/1 契约的**我们这一侧**：类型、拼装、校验、以及跑一遍 vendored 的 `build.py`。
 *
 * 为什么要有这个文件而不是直接在 `compose.ts` 里拼 JSON：契约是**上游的**，不是我们
 * 发明的。`vendor/uemaster/flow-walkthrough/scripts/build.py` 已经定义了「什么算合格的
 * walkmap」——每个 SVG 节点都要有页面、状态组至少两个状态、页面片段不许有 emoji、
 * 弹窗态要用 `wt-screen` 包住……把这些规则抄进 TypeScript 的目的**不是**替代 build.py，
 * 而是**在 spawn 一个 Python 进程之前**就把话说清楚：模型写错了要能拿到一句中文去改，
 * 而不是拿到一份 `Traceback`。所以这里的校验是 build.py 那套 error 规则的镜像，
 * 判据逐条对齐（见 `validateWalkmap` 里的编号注释），越靠后越晚触发。
 *
 * 三层分工，缺一层都会坏：
 * 1. `buildWalkmap` —— 纯函数，把「节点 + 页面片段」拼成契约里的 JSON。同一份输入
 *    永远同一份字节，状态组因此可得。
 * 2. `validateWalkmap` —— 纯函数，逐条复述 build.py 的硬规则，错误是**中文句子**。
 * 3. `renderWalkthrough` —— 落临时目录、spawn `python3 build.py`、读回产物。
 *    产物是**它的**，不是我们拼的 HTML：这就是「和 uemaster 效果一致」的全部含义。
 *
 * 根从**模块位置**推、不认 `process.cwd()`（沿用 `flow.ts` / `store.ts` 的口径）：
 * 第二个调用方是 MCP server，它被别人的客户端起在任意目录里。
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** vendored 构建器入口。相对仓库根、与 cwd 无关。 */
export const BUILD_SCRIPT = path.join(REPO_ROOT, 'vendor/uemaster/flow-walkthrough/scripts/build.py');

/** 默认解释器。stdlib-only，不需要虚拟环境。 */
export const BUILD_PYTHON = 'python3';

/**
 * 超时。
 *
 * 实测一份 15 节点 / 13 页面的 walkmap 约 40ms；20s 是给「整页 HTML 很大」「磁盘很慢」
 * 留的余量，也是上限：与其把 web 请求挂死，不如报一句超时。
 */
export const BUILD_TIMEOUT_MS = 20_000;

/** 契约版本。build.py 只认主版本 1。 */
export const WALKMAP_SPEC = 'walkmap/1';

/** 临时目录里三个固定名字：与 `build.py` 的相对路径解析口径对齐。 */
export const SVG_FILE = 'flow.svg';
export const WALKMAP_FILE = 'walkmap.json';
export const OUTPUT_FILE = 'out.html';
/** 页面片段目录（`pages[].file` 写成 `pages/<id>.html`）。 */
export const PAGE_DIR = 'pages';

/**
 * 中栏（`.stage`）用哪一种框。
 *
 * `phone` / `wide` 是上游契约的两种设备框；`sequence` 是**我们这一侧的扩展**
 * （2026-11-09，见 `sequence.ts`）：后端节点的页面原型那一栏放的不是页面，是一张时序图。
 * 之所以要一个新的 frame 值而不是复用 `wide`：`wide` 在模板里是「浏览器窗口」——白底、
 * 边框、地址栏那一族样式；时序图要的是「一张图」，塞进浏览器窗口里会被读成页面。
 * 契约里多一个枚举值的代价是 build.py 也要认它（`__PAGES_SEQ__`，见 vendor README）。
 */
export type Frame = 'phone' | 'wide' | 'sequence';

/**
 * 节点形态。`page` 有页面片段；`system` / `decision` 没有页面，它们的原型是时序图
 * （2026-11-09 起；在此之前它们只有标注，标注还得折进相邻页面——纯后端流程因此整份出不来）。
 */
export type NodeKind = 'page' | 'system' | 'decision';

/** 标注的一行：`[小标题, 正文]`，可选的第三格是缺口等级（`p0`/`p1`/`p2`，build.py 支持）。 */
export type Anno = [string, string] | [string, string, string];

// ─── 契约里的四个结构 ────────────────────────────────────────────────────────

/**
 * 一份页面片段。
 *
 * `kind: 'sequence'` 的条目**不是页面**：它是后端节点的时序图（`id` 形如 `backend-A`，
 * `file` 里躺的是我们排好的 SVG）。放在同一个 `pages[]` 里，是因为 build.py 只认这一个
 * 容器：它按 `frame` 把条目分进中栏的三个框，时序图正好是第三个。
 */
export type WalkmapPage = { id: string; frame: Frame; file: string; kind?: 'sequence' };
export type WalkmapState = { id: string; label: string; node: string };
export type WalkmapStateGroup = { title: string; states: WalkmapState[] };
export type WalkmapNode = { page: string; state?: string; title: string; anno: Anno[] };

export type Walkmap = {
  spec: string;
  title: string;
  svg: string;
  default_node: string;
  pages: WalkmapPage[];
  state_groups: Record<string, WalkmapStateGroup>;
  nodes: Record<string, WalkmapNode>;
};

// ─── 拼装用的输入 ────────────────────────────────────────────────────────────

/** 一份页面片段（模型产出的那块 HTML）。`id` 由调用方定，必须稳定。 */
export type PageInput = { id: string; frame: Frame; html: string; kind?: 'sequence' };

/**
 * 一个节点的映射信息。
 *
 * 三态（2026-11-09 起）：
 * - `kind=page` 必须给 `page`（自己的一屏）；
 * - 后端节点（`system` / `decision`）给了时序步骤时，`page` 是它的伪页面 `backend-<id>`；
 * - 两者都没有的节点会被 `validateWalkmap` 拒收（那句话原来叫「页面「空」」，现在说清
 *   「既没有页面也没有后端流程」）。
 *
 * 第三轮（同日）不再给第三种节点兜底：原来「判为后端但没步骤」会被挂到最近的页面节点上，
 * 那条兜底产出的是一句假陈述（读者以为那一步有界面），已删掉。现在这种节点在生成路径上
 * 由 `compose.readFragments` / `inspect.readVerify` 用 `missingStepsReason` 更早、更具体
 * 地退回（「判为后端流程但没有给出步骤」）；能走到这里的只剩「既没有页面也没有步骤」，
 * 由 `validateWalkmap` 第 4 条说。**两句话不合并**：一句说意图与义务，一句说事实。
 */
export type NodeInput = {
  id: string;
  title: string;
  kind: NodeKind;
  /** 指向 `pages[].id`（页面或时序伪页面）。 */
  page?: string;
  anno?: Anno[];
};

export type WalkmapInput = {
  title: string;
  svg: string;
  nodes: NodeInput[];
  pages: PageInput[];
};

/** 页面片段的落盘名字。只用我们自己生成的 id，因此不需要清洗。 */
export function pageFile(id: string): string {
  return `${PAGE_DIR}/${id}.html`;
}

/**
 * 一组标题的公共前缀，用作状态组的组名。
 *
 * 为什么在这里猜：契约要求每组有 `title`，而模型只给了**状态**的标题
 * （`寄养首页 · 未预约` / `寄养首页 · 待门店确认`）。公共前缀正好是页面名，正是评审
 * 在右栏想看到的那一行。猜不出来（前缀不足 2 个字）就退回第一个标题——宁可写得笨，
 * 也不要一个空标题。
 */
export function commonTitle(labels: string[]): string {
  const first = labels[0] ?? '';
  let prefix = first;
  for (const label of labels.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < label.length && prefix[i] === label[i]) i += 1;
    prefix = prefix.slice(0, i);
  }
  // 前缀必然停在分隔符上（`寄养首页 · 未预约` → `寄养首页 · `）：去掉尾部空白与分隔符。
  const trimmed = prefix.replace(/[\s·、,，:：\-—|/]+$/u, '').trim();
  return trimmed.length >= 2 ? trimmed : first.trim();
}

/**
 * 由「谁和谁指向同一份页面片段」推出状态组。
 *
 * **规则**（也是本次唯一一处由我们决定的语义）：
 * - 页面片段按**内容**去重：两份完全相同的 html 是同一个页面（同一个 `pages[].id`）；
 * - 同一个页面被 **≥2 个 `kind=page` 的节点**引用 → 这一页有多个状态 → 建一个状态组，
 *   组名取公共前缀，每个状态的 `label` 取那个节点的标题，`id` 取节点 id（图里的 id
 *   本来就是稳定的短标识）；
 * - 只有一个节点指向的页面不建组：上游契约明确「单状态页面不建组、右侧不放按钮」。
 *
 * 为什么按片段内容而不是按「页面名」：提示词 2 里模型只交片段，没有页面 slug 这一列。
 * 与其让我们再编一个字段（模型会写歪，歪了又没法校验），不如用它已经交出来的东西——
 * 同一份字节就是同一页。代价写在报告的「还粗糙的地方」：真正的多状态页会被模型画成
 * **不同**的片段，那时它们不会自动成组（上游例子里的 `home` 五个状态就是这样）。
 */
export function deriveStateGroups(
  nodes: NodeInput[],
): Record<string, WalkmapStateGroup> {
  const byPage = new Map<string, NodeInput[]>();
  for (const node of nodes) {
    if (node.kind !== 'page' || node.page === undefined) continue;
    const list = byPage.get(node.page) ?? [];
    list.push(node);
    byPage.set(node.page, list);
  }

  const groups: Record<string, WalkmapStateGroup> = {};
  for (const [pageId, members] of byPage) {
    if (members.length < 2) continue;
    groups[pageId] = {
      title: commonTitle(members.map((m) => m.title)),
      states: members.map((m) => ({ id: m.id, label: m.title, node: m.id })),
    };
  }
  return groups;
}

/**
 * `{ title, svg, nodes, pages }` → walkmap/1 的 JSON 对象。
 *
 * 纯函数：不读磁盘、不看时钟。`svg` 写进 `svg: 'flow.svg'`（`renderWalkthrough` 会把它
 * 落在临时目录里的这个名字上），`pages[].file` 写成 `pages/<id>.html`。
 *
 * 状态组完全由 `deriveStateGroups` 推出，因此**同一份输入永远得到同一组按钮**；
 * 调用方不需要知道「怎么算一组」这件事。
 */
export function buildWalkmap(input: WalkmapInput): Walkmap {
  const pages: WalkmapPage[] = input.pages.map((page) => ({
    id: page.id,
    frame: page.frame,
    file: pageFile(page.id),
    ...(page.kind === 'sequence' ? { kind: 'sequence' as const } : {}),
  }));

  const nodes: Record<string, WalkmapNode> = {};
  for (const node of input.nodes) {
    const entry: WalkmapNode = { page: node.page ?? '', title: node.title, anno: node.anno ?? [] };
    nodes[node.id] = entry;
  }

  const groups = deriveStateGroups(input.nodes);
  // 代表节点自动归属其状态（契约：`state` 值形如 `组id/状态id`）。
  for (const [gid, group] of Object.entries(groups)) {
    for (const state of group.states) {
      const node = nodes[state.node];
      if (node !== undefined) node.state = `${gid}/${state.id}`;
    }
  }

  return {
    spec: WALKMAP_SPEC,
    title: input.title.trim(),
    svg: SVG_FILE,
    default_node: input.nodes[0]?.id ?? '',
    pages,
    state_groups: groups,
    nodes,
  };
}

// ─── 校验：build.py 的 error 规则镜像 ────────────────────────────────────────

/**
 * emoji 区间，与 `build.py` 的 `EMOJI_RANGES` 逐段一致。
 *
 * 为什么不直接 `/\p{Extended_Pictographic}/u`：那会连带拒掉 `①`、`→` 这类排版符号，
 * 而上游只拒这些区间。判据必须与构建器**同一套**，否则我们会拒掉 build.py 收的东西。
 */
const EMOJI_RANGES: Array<[number, number]> = [
  [0x1f000, 0x1faff], [0x2600, 0x27bf], [0x2b00, 0x2bff],
  [0xfe0f, 0xfe0f], [0x2705, 0x2705], [0x274c, 0x274c],
];

/** 找出文本里的 emoji（与 build.py 同一判据）。 */
export function findEmoji(text: string): string[] {
  const found: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (EMOJI_RANGES.some(([a, b]) => cp >= a && cp <= b)) found.push(ch);
  }
  return found;
}

/** 页面片段里至少要有一种 `wt-` 组件类，否则在设备框里是一块裸排版。 */
const WT_CLASS = /\bwt-[a-z-]+/;

/** 片段不能是整份文档：模板只把 `pages[]` 的内容放进 `<div class="page">` 里。 */
const DOCUMENT_TAG = /<\/?(?:html|head|body)\b/i;

const SVG_NODE = /data-node="([\w-]+)"/g;

/**
 * 校验时需要额外拿到的东西。
 *
 * `Walkmap` 里的 `svg` 是**文件名**（`flow.svg`），不是 SVG 正文——契约就这么定义的
 * （`pages[].file` 同此口径）。所以「SVG 里有没有契约标记」「SVG 节点是否都映射了」
 * 这两条只能由调用方把正文递进来。不给就跳过（JSON 层面的规则照查）。
 * `fragments` 同理：页面正文不在 walkmap 里，在 `pages/*.html` 里。
 */
export type WalkmapContext = {
  /** SVG 正文（不是路径）。 */
  svg?: string;
  /** 页面 id → 片段正文。 */
  fragments?: Record<string, string>;
};

export type WalkmapReport = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

/**
 * 校验一份 walkmap。
 *
 * 规则编号与 `build.py` 的报错一一对应（`节点 %s 引用了未定义页面 %s` 等），语言换成
 * 调用方要的那几句中文。顺序也照抄：先 spec、再页面、再节点、再状态组、最后默认节点。
 * 这样「先报哪一条」在两边是一致的，修复提示词不会因为我们换个顺序而漂。
 *
 * `fragments` 可选：给了才能做三条**读内容**的检查（页面片段不存在、含 emoji、
 * 没使用 `wt-` 类）。build.py 是读文件的，我们在拼装阶段手上只有字符串，所以这一层
 * 由调用方把片段一并递进来；不给就跳过（JSON 层面的规则仍然全查）。
 *
 * 返回而不抛：调用方要拿这些句子去**修**（重问一次模型），抛异常只适合「修不了」。
 */
export function validateWalkmap(
  walkmap: Walkmap,
  context: WalkmapContext = {},
): WalkmapReport {
  const fragments = context.fragments;
  const svgText = context.svg;
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. spec 必须是 walkmap/1（build.py：缺少 spec / 主版本不兼容）。
  const major = walkmap.spec.split('/')[1]?.split('.')[0] ?? '';
  if (!walkmap.spec.startsWith('walkmap/') || major !== WALKMAP_SPEC.split('/')[1]) {
    errors.push(`walkmap 的 spec 必须是 ${WALKMAP_SPEC}（现在是「${walkmap.spec || '空'}」）`);
  }

  // 2. 标题与 SVG 契约标记（build.py：SVG 缺少 data-flowspec="1"）。
  if (walkmap.title.trim() === '') errors.push('walkmap 缺少标题');
  if (walkmap.svg.trim() === '') errors.push('walkmap 缺少 svg 路径');
  if (svgText !== undefined && !svgText.toLowerCase().includes('data-flowspec="1"')) {
    errors.push('流程图 SVG 缺少 data-flowspec="1" 契约标记（需要 flow-canvas flowspec/1 的产物）');
  }

  // 3. 页面：id 唯一、frame 合法、片段存在。
  const pageIds = new Set<string>();
  const seqPages = new Set<string>();
  for (const page of walkmap.pages) {
    if (pageIds.has(page.id)) errors.push(`页面 ${page.id} 定义了两次`);
    pageIds.add(page.id);
    if (page.frame !== 'phone' && page.frame !== 'wide' && page.frame !== 'sequence') {
      errors.push(`页面 ${page.id} 的 frame 只能是 phone、wide 或 sequence（现在是「${String(page.frame)}」）`);
    }
    if (page.frame === 'sequence' || page.kind === 'sequence') seqPages.add(page.id);
  }
  if (walkmap.pages.length === 0) errors.push('walkmap 里一个页面片段都没有');

  // 4. 每个节点都必须落在某个页面或某张后端流程图上——「节点 X 没有对应的页面」。
  //
  // 这一条是 2026-11-09 那条事故的守门人：`PAN-815`（纯后端流程）里六个节点都是
  // 系统/判断步骤，`assembleWalkmap` 把它们挂到空页面上，于是整份材料被这一条拒掉，
  // 而那句话是「引用了不存在的页面「空」」——没人看得懂。现在挂载规则改了（后端节点
  // 拿到自己的时序伪页面），**这条判据一字不让**：既没页面也没步骤的节点照旧拒收，
  // 但话改成能照着改的说法。
  //
  // 它为什么**不是**「判为后端但没步骤」的那句话（`missingStepsReason`）：契约里没有
  // `kind` 这一格，这一层只看得见「没有落点」这个事实，看不见模型的意图。所以两句分工：
  // 读回话那一层说「你判它是服务端的事，就说明它在服务端做什么」（能照着补），这一层说
  // 「它既没有页面也没有后端流程」（兜底，防的是绕过提示词直接拼 walkmap 的调用方）。
  // 合并成一句的代价：模型不知道该补 steps 还是该换回页面——那正好是两件不同的事。
  for (const [id, meta] of Object.entries(walkmap.nodes)) {
    if (!pageIds.has(meta.page)) {
      errors.push(
        `节点 ${id} 既没有页面也没有后端流程：要么它落在一张页面上（给 html 与 frame），`
        + `要么它是一组服务端步骤（给 steps：谁 → 谁 · 做什么）；现在是「${meta.page || '空'}」`,
      );
    }
    if (meta.title.trim() === '') errors.push(`节点 ${id} 缺少标题`);
    for (const pair of meta.anno) {
      const bad = findEmoji(pair.join(''));
      if (bad.length > 0) errors.push(`节点 ${id} 的标注含 emoji 字符 ${bad.slice(0, 5).join('')}`);
    }
  }

  // 5. 状态组：至少两个状态、id/label/node 齐全、代表节点存在、state 归属正确。
  const owner = new Map<string, string>();
  for (const [gid, group] of Object.entries(walkmap.state_groups)) {
    if (group.states.length < 2) {
      errors.push(`状态组 ${gid} 少于两个状态（单状态页面不建组、右侧不放按钮）`);
    }
    if (group.title.trim() === '') warnings.push(`状态组 ${gid} 没有组名`);
    const seenPage = new Map<string, string>();
    for (const state of group.states) {
      if (state.id === '' || state.label.trim() === '') {
        errors.push(`状态组 ${gid} 的状态缺少 id 或 label`);
        continue;
      }
      const rep = walkmap.nodes[state.node];
      if (rep === undefined) {
        errors.push(`状态组 ${gid} 的状态 ${state.id} 引用了不存在的节点 ${state.node}`);
        continue;
      }
      const key = `${gid}/${state.id}`;
      if (rep.state !== undefined && rep.state !== key) {
        errors.push(`节点 ${state.node} 是状态 ${key} 的代表节点，但又声明了 state=${rep.state}`);
      }
      owner.set(key, state.node);
      const dup = seenPage.get(rep.page);
      if (dup !== undefined) {
        warnings.push(`状态组 ${gid} 的状态 ${dup} 与 ${state.id} 使用同一页面 ${rep.page}：页面无差异就不是真正的状态，建议合并`);
      }
      seenPage.set(rep.page, state.id);
    }
  }
  for (const [id, meta] of Object.entries(walkmap.nodes)) {
    if (meta.state === undefined) continue;
    if (!owner.has(meta.state)) {
      errors.push(`节点 ${id} 的 state=${meta.state} 不在任何状态组里`);
    }
  }

  // 6. default_node 必须在映射里。
  if (walkmap.default_node !== '' && walkmap.nodes[walkmap.default_node] === undefined) {
    errors.push(`默认节点 ${walkmap.default_node} 不在映射里`);
  }

  // 7. 读内容的三条（给了片段才查）。
  if (fragments !== undefined) {
    for (const page of walkmap.pages) {
      const html = fragments[page.id];
      if (html === undefined) {
        errors.push(`页面 ${page.id} 没有对应的片段内容`);
        continue;
      }
      const bad = findEmoji(html);
      if (bad.length > 0) errors.push(`页面 ${page.id} 的片段含 emoji 字符 ${bad.slice(0, 5).join('')}`);
      /**
       * 时序图那一格查的是**另一套**：它不是页面片段，不该要求 `wt-*` 组件类
       * （那是手机/浏览器框里的东西，SVG 图里一个都没有）。替代判据两条：
       * 图真的画出来了（有 `<svg`）、参与方至少出现一个（`seq-actor` 是参与方框的类名）。
       * 这两条盯的是「伪页面建了、内容是空的」——那会让节点点开是一片白，
       * 比整份拒收更难发现。
       */
      if (seqPages.has(page.id)) {
        if (!html.includes('<svg')) {
          errors.push(`节点页面 ${page.id} 的后端流程图没有画出来（片段里没有 SVG）`);
        } else if (!html.includes('seq-actor')) {
          errors.push(`节点页面 ${page.id} 的后端流程图里没有参与方（至少要有一个「谁 → 谁」的角色）`);
        }
        continue;
      }
      if (!WT_CLASS.test(html)) {
        errors.push(`页面 ${page.id} 的片段没有使用 wt- 组件类（模板只提供这套样式，写成别的类名在设备框里没有样式）`);
      }
      if (DOCUMENT_TAG.test(html)) {
        errors.push(`页面 ${page.id} 的片段是整份文档：只放 body 内的片段，不要 <html>/<head>/<body>`);
      }
    }
  }

  // 8. SVG 与映射的差集只是 warning（build.py 同一口径：点了没反应 / 映射里有幽灵）。
  if (svgText !== undefined) {
    SVG_NODE.lastIndex = 0;
    const svgNodes = new Set<string>();
    for (let m = SVG_NODE.exec(svgText); m !== null; m = SVG_NODE.exec(svgText)) svgNodes.add(m[1]!);
    for (const id of [...svgNodes].filter((id) => walkmap.nodes[id] === undefined).sort()) {
      warnings.push(`SVG 节点 ${id} 未配置映射（点击将无响应）`);
    }
    for (const id of Object.keys(walkmap.nodes).filter((id) => !svgNodes.has(id)).sort()) {
      warnings.push(`映射中的节点 ${id} 在 SVG 里不存在`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ─── 跑一遍 build.py ─────────────────────────────────────────────────────────

export type BuildOptions = {
  timeoutMs?: number;
  scriptPath?: string;
  python?: string;
};

export type BuildResult = WalkmapReport & {
  /** `ok` 为真时才有：build.py 写出来的整份 HTML。 */
  html?: string;
  /** build.py 的机器可读报告（`--check` 与 `-o` 都会打印）。 */
  report?: unknown;
  /** 构建器起不来 / 超时 / 报错时说的一句话。 */
  error?: string;
};

/**
 * 落盘需要的正文：SVG 与页面片段。
 *
 * 为什么不从 `walkmap` 里取：`walkmap.svg` / `pages[].file` 是**文件名**（契约如此），
 * 正文只有调用方手上有。三处（落盘、校验、字节比对）用同一个形状，就不会出现
 * 「校验看的是路径、落盘写的是正文」这种只在一处对的事故。
 */
export type WalkmapAssets = {
  /** SVG 正文。 */
  svg: string;
  /** 页面 id → 片段正文。 */
  fragments: Record<string, string>;
};

/**
 * 把一份 walkmap 落成 build.py 认得的三样东西：`flow.svg`、`pages/*.html`、`walkmap.json`。
 *
 * 单独抽出来是为了**能被逐字节比较**：同一个目录既可以直接跑 vendored 的 build.py，
 * 也可以跑上游克隆里的那个，两边读到的输入完全一样（这也是「效果一致」的证明方式）。
 * `pages[].file` / `svg` 已经是相对名字，这里不再改写——改写就会和契约漂。
 */
export async function materializeWalkmap(
  dir: string,
  walkmap: Walkmap,
  assets: WalkmapAssets,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, SVG_FILE), assets.svg, 'utf8');
  await mkdir(path.join(dir, PAGE_DIR), { recursive: true });
  for (const page of walkmap.pages) {
    await writeFile(path.join(dir, page.file), assets.fragments[page.id] ?? '', 'utf8');
  }
  await writeFile(path.join(dir, WALKMAP_FILE), JSON.stringify(walkmap, null, 2), 'utf8');
}

type Run = {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  spawnError?: string;
};

/**
 * 跑一次 `execFile`，把四种失败压成同一种形状（与 `flow.ts` 同一套，**永远 resolve**）。
 *
 * 为什么用 `execFile` 而不是 `exec`：喂进去的是模型写的 HTML 与中文标题，里面的
 * 反引号、`$()` 在 argv 数组里只是字符；走 shell 就是把它们交给 shell 解释一遍。
 */
function run(args: string[], cwd: string, timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      args[0] as string,
      args.slice(1),
      { cwd, timeout: timeoutMs, killSignal: 'SIGTERM', maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string }) | null;
        if (!e) {
          resolve({ code: 0, signal: null, timedOut: false, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
          return;
        }
        if (typeof e.code === 'string') {
          resolve({ code: null, signal: null, timedOut: false, stdout: '', stderr: '', spawnError: `${e.code}: ${e.message}` });
          return;
        }
        const timedOut = Boolean(e.killed) && (e.signal === 'SIGTERM' || e.signal === 'SIGKILL');
        resolve({
          code: typeof e.code === 'number' ? e.code : null,
          signal: e.signal ?? null,
          timedOut,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
  });
}

function tail(text: string, max = 800): string {
  const t = text.trim();
  return t.length <= max ? t : `…${t.slice(-max)}`;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * 跑一遍 vendored 的 `build.py`，把它的产物**原样**交回来。
 *
 * 顺序是硬的：临时目录里先落下三样东西（`flow.svg`、`pages/*.html`、`walkmap.json`），
 * 再 `python3 build.py walkmap.json -o out.html`。`build.py` 的 `svg` / `pages[].file`
 * 都是相对 walkmap 文件解析的，所以 cwd 与文件名都按它的口径来（`SVG_FILE` 等常量）。
 *
 * 失败不抛：退出码非 0 时它也**先打印报告**（errors 是中文句子），把报告里的 errors
 * 原样交回去，调用方拿它去修或在界面上说清为什么。只有「起不来 / 超时 / 报告读不懂」
 * 才是 `error` 一句话。
 */
export async function renderWalkthrough(
  walkmap: Walkmap,
  assets: WalkmapAssets,
  options: BuildOptions = {},
): Promise<BuildResult> {
  const timeoutMs = options.timeoutMs ?? BUILD_TIMEOUT_MS;
  const script = options.scriptPath ?? BUILD_SCRIPT;
  const python = options.python ?? BUILD_PYTHON;

  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'flowers-walkmap-'));

    await materializeWalkmap(dir, walkmap, assets);

    const result = await run(
      [python, script, WALKMAP_FILE, '-o', OUTPUT_FILE],
      dir,
      timeoutMs,
    );

    if (result.spawnError !== undefined) {
      return { ok: false, errors: [], warnings: [], error: `构建器起不来（${result.spawnError}）` };
    }
    if (result.timedOut) {
      return { ok: false, errors: [], warnings: [], error: `构建器超时（${timeoutMs}ms 未结束，已终止）` };
    }

    const report = reportIn(result.stdout);
    const errors = typeof report === 'object' && report !== null
      ? stringsOf((report as Record<string, unknown>)['errors'])
      : [];
    const warnings = typeof report === 'object' && report !== null
      ? stringsOf((report as Record<string, unknown>)['warnings'])
      : [];

    if (result.code !== 0 || errors.length > 0) {
      const why = errors.join('；') || tail(result.stderr) || tail(result.stdout)
        || `构建器退出码 ${result.code ?? result.signal ?? '?'}`;
      return { ok: false, errors: errors.length > 0 ? errors : [why], warnings, report, error: why };
    }

    let html: string;
    try {
      html = await readFile(path.join(dir, OUTPUT_FILE), 'utf8');
    } catch (e) {
      return {
        ok: false,
        errors: [],
        warnings,
        report,
        error: `报告说没问题，但没有产物：${e instanceof Error ? e.message : String(e)}`,
      };
    }

    return { ok: true, errors: [], warnings, report, html };
  } catch (e) {
    // 只可能是 mkdtemp/writeFile 这类宿主侧失败（磁盘满、TMPDIR 不可写）。
    return { ok: false, errors: [], warnings: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
