import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { AppError } from '../src/core/errors.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { composeEvaluation, type ComposeDeps } from '../src/core/uemaster/compose.js';
import { renderFlowchart } from '../src/core/uemaster/flow.js';
import {
  BUILD_SCRIPT, WALKMAP_FILE, buildWalkmap, commonTitle, findEmoji, materializeWalkmap,
  pageFile, renderWalkthrough, validateWalkmap,
  type NodeInput, type PageInput, type Walkmap,
} from '../src/core/uemaster/walkmap.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { BRIEF } from './helpers/brief.js';
import { REPO_ROOT, artifactExists, cleanArtifacts, siteFile } from './helpers/files.js';

/**
 * walkmap/1 契约的我们这一侧：拼装、校验、以及**和上游逐字节对齐**。
 *
 * 这一组用例里没有一件东西是假的，除了「模型说什么」：
 * - 校验规则跑的是真的 `validateWalkmap`，构建器跑的是真的
 *   `vendor/uemaster/flow-walkthrough/scripts/build.py`（子进程、真 Python）；
 * - 字节一致性那一条还要再跑一次 `/tmp/uem` 里的**上游原件**，两边读同一份输入
 *   （同一个目录、同一个 walkmap.json），产物必须一模一样；
 * - 数据库与文件系统也是真的（与 `compose.test.ts` 同一套夹具）。
 *
 * 上游的 `examples/` 刻意没有 vendor 进仓库（见 `vendor/uemaster/README.md`），
 * 所以用到它的用例在本机 `/tmp/uem` 不存在时**跳过**，而不是失败：跳过是「样本不在」，
 * 失败是「我们对不上」，这两件事不能混。
 */

// ─── 上游样本 ────────────────────────────────────────────────────────────────

const UPSTREAM = '/tmp/uem/skills/flow-walkthrough';
const UPSTREAM_BUILD = path.join(UPSTREAM, 'scripts/build.py');
const UPSTREAM_EXAMPLE = path.join(UPSTREAM, 'examples');

async function upstreamReady(): Promise<boolean> {
  try {
    await readFile(UPSTREAM_BUILD, 'utf8');
    await readFile(path.join(UPSTREAM_EXAMPLE, 'walkmap.json'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

const hasUpstream = await upstreamReady();

/** 跑一次 Python，**永远 resolve**（退出码是数据，不是异常）。 */
function runPy(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('python3', args, { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      resolve({
        code: e === null ? 0 : (typeof e.code === 'number' ? e.code : null),
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
  });
}

/** stdout 里的报告 JSON（build.py 先打报告再打一行「已生成 …」）。 */
type Printed = { errors?: string[]; warnings?: string[]; pages?: number; nodes?: number };

function reportOf(stdout: string): Printed {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  try {
    return JSON.parse(stdout.slice(start, end + 1)) as Printed;
  } catch {
    return {};
  }
}

// ─── 夹具 ────────────────────────────────────────────────────────────────────

/** 一屏手机页面片段。只用 `wt-*` 类，没有 emoji。 */
const PHONE_A = [
  '<div class="wt-screen">',
  '  <div class="wt-statusbar"><span>9:41</span><span class="wt-sb-icons"></span></div>',
  '  <div class="wt-nav"><span class="wt-nav-title">寄养</span></div>',
  '  <div class="wt-body"><div class="wt-card"><div class="wt-li-title">最近的寄养门店</div></div></div>',
  '  <div class="wt-bottombar"><button class="wt-btn" onclick="goNode(\'B\')">立即预约</button></div>',
  '</div>',
].join('\n');

/** 同一页面的第二个状态：弹窗态 = 原页面 + `wt-modal`（page-guide 的写法）。 */
const PHONE_A_MODAL = PHONE_A.replace('</div>\n</div>', '</div>\n  <div class="wt-modal"><div class="wt-dialog">'
  + '<div class="wt-dialog-title">本周约满</div><div class="wt-dialog-body">选个别的日期试试</div>'
  + '<div class="wt-dialog-actions"><button class="wt-btn">好</button></div></div></div>\n</div>');

/** 后台页面片段（690 宽的 wide 框）。 */
const WIDE_G = [
  '<div class="wt-browserbar"><i></i><i></i><i></i><span>门店后台 - 接单</span></div>',
  '<div class="wt-body"><table class="wt-table"><tr><th>提交时间</th><th>操作</th></tr>',
  '<tr><td>09-28 14:32</td><td><button class="wt-btn wt-btn-sm" onclick="goNode(\'C\')">接单</button></td></tr>',
  '</table></div>',
].join('\n');

const GOOD_FLOW = `flowchart TD
  A["进入寄养频道"] --> B{"是否登录？"}
  B -->|是| C["选择宠物"]
  B -->|否| D["跳转登录"]
  C --> E["提交订单"]
`;

/** 3 节点 / 2 连线的图：A、C 是页面，B 是判断（没有页面）。 */
const SMALL_FLOW = `flowchart TD
  A["进入寄养频道"] --> B{"是否签约？"}
  B -->|是| C["寄养首页"]
`;

/** 与 GOOD_FLOW 的 5 个节点一一对应；只有 `kind=page` 的节点给 html。 */
function fragmentsDoc(overrides: Partial<Record<string, string>> = {}): string {
  const nodes = [
    { id: 'A', kind: 'page', frame: 'phone', title: '进入寄养频道', html: PHONE_A,
      anno: [['内容', '按距离列出可寄养门店']] },
    { id: 'B', kind: 'decision', title: '是否登录？', anno: [['判定依据', '会话里有没有用户']] },
    { id: 'C', kind: 'page', frame: 'phone', title: '选择宠物', html: PHONE_A_MODAL,
      anno: [['字段', '宠物为必填']] },
    { id: 'D', kind: 'page', frame: 'phone', title: '跳转登录', html: PHONE_A,
      anno: [['承接', '登录后回到频道']] },
    { id: 'E', kind: 'page', frame: 'wide', title: '提交订单', html: WIDE_G,
      anno: [['归属', '后台生成寄养单']] },
  ];
  return JSON.stringify({ nodes });
}

/** 把上游 pet-boarding 样本读成「我们的输入」。 */
async function upstreamExample(): Promise<{ walkmap: Walkmap; fragments: Record<string, string>; svgText: string }> {
  const raw = JSON.parse(await readFile(path.join(UPSTREAM_EXAMPLE, 'walkmap.json'), 'utf8')) as {
    title: string; svg: string; pages: Array<{ id: string; frame: 'phone' | 'wide'; file: string }>;
    nodes: Record<string, { page: string; title: string; anno?: Array<[string, string]> }>;
  };
  const fragments: Record<string, string> = {};
  const pages: PageInput[] = [];
  for (const page of raw.pages) {
    const html = await readFile(path.join(UPSTREAM_EXAMPLE, page.file), 'utf8');
    pages.push({ id: page.id, frame: page.frame, html });
    fragments[page.id] = html;
  }
  const svg = await readFile(path.join(UPSTREAM_EXAMPLE, raw.svg), 'utf8');
  const nodes: NodeInput[] = Object.entries(raw.nodes).map(([id, meta]) => ({
    id,
    title: meta.title,
    kind: 'page',
    page: meta.page,
    anno: meta.anno ?? [],
  }));
  return { walkmap: buildWalkmap({ title: raw.title, svg, nodes, pages }), fragments, svgText: svg };
}

// ─── 环境 ────────────────────────────────────────────────────────────────────

const temps: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

beforeEach(async () => {
  await resetDb();
  await seedPeople();
  await cleanArtifacts();
});

afterAll(async () => {
  await cleanArtifacts();
  for (const dir of temps) await rm(dir, { recursive: true, force: true }).catch(() => {});
  await pool.end();
});

// ─── 用例：拼装 ──────────────────────────────────────────────────────────────

describe('buildWalkmap', () => {
  it('同一份片段只落一个页面文件；共用它的两个节点成一组状态', () => {
    const walkmap = buildWalkmap({
      title: 'PAN-1「寄养」评估材料',
      svg: '<svg data-flowspec="1"></svg>',
      pages: [{ id: 'p-A', frame: 'phone', html: PHONE_A }],
      nodes: [
        { id: 'A', title: '寄养首页 · 未预约', kind: 'page', page: 'p-A', anno: [] },
        { id: 'C', title: '寄养首页 · 待确认', kind: 'page', page: 'p-A', anno: [] },
        { id: 'B', title: '是否登录？', kind: 'decision', page: 'p-A', anno: [] },
      ],
    });

    expect(walkmap.spec).toBe('walkmap/1');
    expect(walkmap.pages).toEqual([{ id: 'p-A', frame: 'phone', file: pageFile('p-A') }]);
    expect(walkmap.svg).toBe('flow.svg');
    expect(walkmap.default_node).toBe('A');
    // 判断节点不参与成组：组里只有两个页面节点
    expect(Object.keys(walkmap.state_groups)).toEqual(['p-A']);
    expect(walkmap.state_groups['p-A']!.states.map((s) => s.label)).toEqual(['寄养首页 · 未预约', '寄养首页 · 待确认']);
    // 代表节点自动归属状态（契约里的 `组id/状态id`）
    expect(walkmap.nodes['A']!.state).toBe('p-A/A');
    expect(walkmap.nodes['C']!.state).toBe('p-A/C');
    expect(walkmap.nodes['B']!.state).toBeUndefined();
  });

  it('组名取标题的公共前缀；猜不出来就退回第一个标题', () => {
    expect(commonTitle(['寄养首页 · 未预约', '寄养首页 · 待门店确认'])).toBe('寄养首页');
    expect(commonTitle(['进入寄养频道', '选择宠物'])).toBe('进入寄养频道');
  });

  it.skipIf(!hasUpstream)('上游 pet-boarding 样本过我们的拼装后，build.py --check 通过', async () => {
    const { walkmap, fragments, svgText } = await upstreamExample();
    const report = validateWalkmap(walkmap, { svg: svgText, fragments });
    expect(report.errors).toEqual([]);

    const dir = await tempDir('flowers-example-');
    await materializeWalkmap(dir, walkmap, { svg: svgText, fragments });
    const run = await runPy([BUILD_SCRIPT, WALKMAP_FILE, '--check'], dir);

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const printed = reportOf(run.stdout);
    expect(printed.errors).toEqual([]);
    // 15 个 SVG 节点全部有映射；页面数等于「不同片段」的去重结果
    expect(printed.nodes).toBe(15);
    expect(printed.pages).toBe(13);
    // 已知代价（报告里写明）：样本里 A 与 C 共用同一个页面文件，按「同一片段 = 同一页」
    // 推导出的状态组会被 build.py 提醒「页面无差异」。这是 warning，不是 error。
    expect(printed.warnings?.length ?? 0).toBeGreaterThan(0);
    expect(printed.warnings?.[0]).toContain('使用同一页面');
  });
});

// ─── 用例：校验（build.py 的 error 规则镜像） ────────────────────────────────

describe('validateWalkmap', () => {
  function base(): Walkmap {
    return buildWalkmap({
      title: 'PAN-1「寄养」评估材料',
      svg: '<svg data-flowspec="1"></svg>',
      pages: [{ id: 'p-A', frame: 'phone', html: PHONE_A }],
      nodes: [{ id: 'A', title: '进入寄养频道', kind: 'page', page: 'p-A', anno: [] }],
    });
  }

  /**
   * 这条判据是 `PAN-815` 那次事故的守门人（纯后端流程，六个节点都没有页面 →
   * `assembleWalkmap` 挂到空页面上 → 整份被拒）。**拒收本身一字不让**，改的只是那句话：
   * 原来叫「引用了不存在的页面「空」」，读的人不知道下一步该干什么；现在说清两条出路
   * （给页面，或给时序步骤）——模型与人都能照着改。
   */
  it('节点既没有页面也没有后端流程 → 中文 rejects，并说清两条出路', () => {
    const walkmap = base();
    walkmap.nodes['Z'] = { page: 'p-不存在', title: '幽灵节点', anno: [] };

    const report = validateWalkmap(walkmap);
    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toContain('节点 Z 既没有页面也没有后端流程');
    expect(report.errors.join('\n')).toContain('steps');
    expect(report.errors.join('\n')).toContain('p-不存在');
  });

  it('状态组只有一个状态 → 中文 rejects：状态组 Y 少于两个状态', () => {
    const walkmap = base();
    walkmap.state_groups = { home: { title: '寄养首页', states: [{ id: 'none', label: '未预约', node: 'A' }] } };
    walkmap.nodes['A']!.state = 'home/none';

    const report = validateWalkmap(walkmap);
    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toContain('状态组 home 少于两个状态');
  });

  it('片段没用 wt- 类、含 emoji、是整份文档 → 三条都点名', () => {
    const walkmap = base();
    const report = validateWalkmap(walkmap, {
      svg: '<svg data-flowspec="1"></svg>',
      fragments: { 'p-A': '<html><body><div class="card">好的 😀</div></body></html>' },
    });

    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toContain('没有使用 wt- 组件类');
    expect(report.errors.join('\n')).toContain('含 emoji');
    expect(report.errors.join('\n')).toContain('整份文档');
  });

  it('emoji 判据与 build.py 的区间一致：`→` 不算 emoji，`✅` 算', () => {
    expect(findEmoji('A → B')).toEqual([]);
    expect(findEmoji('好的 ✅')).toContain('✅');
  });
});

// ─── 用例：与上游逐字节一致（除一处有记录的本地补丁） ──────────────────────

/**
 * 我们对 vendored 模板打的**唯一**一处补丁（2026-11-08）：
 * 全屏时把中栏与右栏撤掉，否则全屏画布左下角会露出手机框的一条边。
 *
 * 这件事改变了 `vendor/uemaster/README.md` 里「我们改了什么：没有改」那句话，所以
 * 字节比对必须跟着改，而且改法要能把「只多了这一块」钉住：
 * 把这一块从我们的产物里剥掉之后，剩下的必须与上游**逐字节相同**；同时这一块必须
 * 真的出现在我们的产物里（否则这条比对就成了「两边都没这块」的假绿灯）。
 *
 * 为什么剥而不是直接放宽成「包含」：放宽之后，任何一处模板改动都不再有人管——
 * 而那正是 vendoring 唯一能防住的事（上游一升级，我们这侧的差异就没人知道了）。
 * 补丁本身写在 `templates/walkthrough.html` 里、带 `本地补丁（2026-11-08，非上游）` 开头，
 * 整块剥除靠这两个锚点。
 */
const PATCH_START = '/* 本地补丁（2026-11-08，非上游）';
const PATCH_RULE = '.flow-panel.fs ~ .stage, .flow-panel.fs ~ .anno-panel { display: none; }';

/**
 * 第二块补丁（2026-11-09）：后端流程那一格。**这段比对仍然只认「补丁」两个字**：
 * 剥掉之后剩下的必须与上游逐字节相同，所以补丁的边界必须是模板里能唯一认出来的锚点，
 * 而不是「凡是我们加的都不要」——后者等于把 vendoring 的全部意义让掉。
 *
 * 为什么边界用一对标记而不是某条规则：这块补丁在**两个文件的三处**（模板的 CSS 段、
 * 模板的 `.stage` 容器、`build.py` 的一行 replace）。模板里那两段以
 * `本地补丁结束（2026-11-09）` 收尾，成对剥除；`build.py` 那一行在模板产物里不留痕
 * （`__PAGES_SEQ__` 被替换成空串，而空串跟着容器一起被剥掉了），因此不需要额外处理。
 */
const PATCH2_START = '本地补丁（2026-11-09，非上游）';
const PATCH2_END = '本地补丁结束（2026-11-09）';

/**
 * 第三块补丁（2026-11-10）：手机 chrome（状态栏 + 导航栏）归模板，模型只交内容区。
 *
 * 三处、同一个标记：模板的 CSS 段（`.wt-sb-ico` / `.wt-nav-back` / `.page` 定位）、模板里
 * 那份 `<template id="wt-chrome-phone">` 定义（取走之后从产物里摘掉，所以产物里看不到）、
 * 以及 `build.py` 逐页注入的那一段（每张手机页面各一份，start/end 成对）。剥除口径与
 * 2026-11-09 那块相同：从 start 标记所在行剥到 end 标记所在行（含换行），剩下的必须与
 * 上游逐字节相同——所以剥完之后的页面 div 又只剩 `<div class="page">\n片段\n</div>`。
 */
const PATCH3_START = '本地补丁（2026-11-10，非上游）';
const PATCH3_END = '本地补丁结束（2026-11-10）';

/** 剥掉那块补丁（含它上面的注释）。找不到就原样返回——让 byte 比对自己去红。 */
function withoutLocalPatch(html: string): string {
  let out = html;
  // ① 2026-11-09 / 2026-11-10 的成对补丁：整段（标记 → 结束标记所在行）连行尾换行一起剥。
  //    两块用同一条口径，只是标记不同——所以这里按「(start, end) 对」循环，而不是写两遍。
  const pairs: Array<[string, string]> = [
    [PATCH2_START, PATCH2_END],
    [PATCH3_START, PATCH3_END],
  ];
  for (const [startMark, endMark] of pairs) {
    for (;;) {
      const from = out.indexOf(startMark);
      if (from < 0) break;
      const end = out.indexOf(endMark, from);
      if (end < 0) break;
      const lineEnd = out.indexOf('\n', end);
      const to = lineEnd < 0 ? out.length : lineEnd + 1;
      // 起点回退到行首：注释是从行首开始的，回退之后剥掉的是整行。
      let lineStart = from;
      while (lineStart > 0 && out[lineStart - 1] !== '\n') lineStart -= 1;
      // 补丁是「空行 + 块」插进去的（读起来才不挤），所以剥的时候把它前面那一行空行一起剥；
      // 不然剩下的产物比上游多一个换行，字节比对会以「差 1 个字节」的形式红掉。
      if (lineStart > 0 && (lineStart - 2 < 0 || out[lineStart - 2] === '\n')) lineStart -= 1;
      out = out.slice(0, lineStart) + out.slice(to);
    }
  }
  // ② 2026-11-08 的那一条规则。
  const start = out.indexOf(PATCH_START);
  if (start < 0) return out;
  const end = out.indexOf(PATCH_RULE, start);
  if (end < 0) return out;
  const to = end + PATCH_RULE.length;
  // 连它后面的那个换行一起剥：上游那一段是「`}` + 换行 + 下一条规则」。
  return out.slice(0, start) + out.slice(to + (out[to] === '\n' ? 1 : 0));
}

describe('与上游 build.py 逐字节一致', () => {
  it.skipIf(!hasUpstream)('同一份 walkmap：剥掉那一处本地补丁后 byte-identical', async () => {
    const { walkmap, fragments, svgText } = await upstreamExample();
    const dir = await tempDir('flowers-bytes-');
    await materializeWalkmap(dir, walkmap, { svg: svgText, fragments });

    const mine = await runPy([BUILD_SCRIPT, WALKMAP_FILE, '-o', 'mine.html'], dir);
    const theirs = await runPy([UPSTREAM_BUILD, WALKMAP_FILE, '-o', 'theirs.html'], dir);
    expect(mine.code).toBe(0);
    expect(theirs.code).toBe(0);

    // 报告本身也必须一样：counts/errors/warnings 逐字相同（`已生成` 那一行带输出文件名，
    // 两个命令的 -o 不同，所以只比报告 JSON）
    expect(reportOf(mine.stdout)).toEqual(reportOf(theirs.stdout));
    expect(reportOf(mine.stdout).errors).toEqual([]);

    const a = await readFile(path.join(dir, 'mine.html'), 'utf8');
    const b = await readFile(path.join(dir, 'theirs.html'), 'utf8');

    // 1. 三块补丁真的在产物里（模板 → build.py → 产物这条链没断）
    expect(a).toContain(PATCH_RULE);
    expect(a).toContain(PATCH2_END);
    expect(a).toContain('id="frame-seq"');
    expect(a).toContain('class="wt-sb-ico"');
    // 2. 剥掉它之后逐字节相同：除了这一块，模板与上游一个字都不差
    expect(withoutLocalPatch(a)).toBe(b);
    // 3. 补丁只多出那几十个字节，不是把整段模板换掉了
    expect(Buffer.byteLength(a)).toBeGreaterThan(40_000);
    expect(Buffer.byteLength(a) - Buffer.byteLength(b))
      .toBe(Buffer.byteLength(a) - Buffer.byteLength(withoutLocalPatch(a)));
  });
});

describe('本地补丁（2026-11-10）成对、可整块剥除', () => {
  it('模板剥完之后一个 2026-11-10 标记都不剩，上游那套 CSS 盒子图标原样在', async () => {
    const tpl = await readFile(
      path.join(REPO_ROOT, 'vendor/uemaster/flow-walkthrough/templates/walkthrough.html'), 'utf8');
    expect(tpl).toContain(PATCH3_START);
    const stripped = withoutLocalPatch(tpl);
    // 成对：剥完不该剩半块（剩半块意味着有一条结束标记被漏写，字节比对会以「多几行」红掉）
    expect(stripped).not.toContain('2026-11-10');
    expect(stripped).not.toContain('wt-chrome-phone');
    // 我们只在补丁块里覆盖上游规则，上游那几条一个字都没动
    expect(stripped).toContain('.wt-sb-icons { position: relative; width: 22px; height: 10px;');
    expect(stripped).toContain('.wt-nav-back { width: 10px; height: 10px;');
  });
});

// ─── 用例：compose 端到端 ────────────────────────────────────────────────────

/** 按脚本回话的 provider：真 `complete` 的形状，假的数据。 */
function fakeProvider(replies: string[]): { deps: Partial<ComposeDeps>; prompts: string[] } {
  const prompts: string[] = [];
  const queue = [...replies];
  return {
    prompts,
    deps: {
      resolveConfig: async () => ({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-walkmap-test', model: 'fake' }),
      complete: async (_cfg, prompt) => {
        prompts.push(prompt);
        const next = queue.shift();
        if (next === undefined) return { ok: false, error: '用例脚本里没有更多回话' };
        return { ok: true, text: next, usage: { prompt: 100, completion: 50 } };
      },
      render: (mermaid) => renderFlowchart(mermaid),
      build: (walkmap, assets) => renderWalkthrough(walkmap, assets),
    },
  };
}

async function inbox() {
  return createRequirement(db, '吕品', { ...BRIEF, title: 'S3 协议支持', type: 'feature', requester: '孙建宏' });
}

async function caught(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected AppError, nothing thrown');
}

describe('composeEvaluation → build.py 的产物', () => {
  it('两段页面片段 → 落盘的 HTML 是 build.py 的三栏骨架，不是我们的模板', async () => {
    const fake = fakeProvider([SMALL_FLOW, JSON.stringify({
      nodes: [
        { id: 'A', kind: 'page', frame: 'phone', title: '进入寄养频道', html: PHONE_A,
          anno: [['内容', '按距离列出可寄养门店']],
          // v1（2026-11-10）：评估材料必须给右栏两组待确认，否则整份退回（requireOpen）。
          open: { req: [['验收口径', '这一步算做完的标准是什么']], dev: [['状态', '这一屏有几种状态']] } },
        { id: 'B', kind: 'decision', title: '是否签约？',
        steps: [
          { from: '页面', to: '服务端', what: '提交当前签约状态' },
          { from: '服务端', to: '服务端', what: '判断客户有没有签约主体' },
        ],
          anno: [['判定依据', '会话里有没有签约主体']] },
        { id: 'C', kind: 'page', frame: 'phone', title: '寄养首页', html: PHONE_A_MODAL,
          anno: [['状态', '未预约时展示入口']] },
      ],
    })]);
    const r = await inbox();

    const out = await composeEvaluation(db, '吕品', { requirementId: r.id, stage: 'evaluate' }, fake.deps);

    // 版本化文件名（2026-11-10）：第一版是 v001。
    const url = `/uemaster/PAN-${r.number}/evaluate-v001.html`;
    expect(out.url).toBe(url);
    expect(await artifactExists(url)).toBe(true);

    const html = await readFile(siteFile(url), 'utf8');
    // 三栏骨架是 build.py 的：流程画布 / 设备框 / 标注面板
    expect(html).toContain('class="layout"');
    expect(html).toContain('class="flow-panel"');
    expect(html).toContain('id="flow-svg-light"');
    expect(html).toContain('id="frame-phone"');
    expect(html).toContain('id="frame-wide"');
    expect(html).toContain('class="anno-panel"');
    expect(html).toContain('id="state-card"');
    // 引擎的 SVG 内联、契约标记在
    expect(html).toContain('data-flowspec="1"');
    expect(html).toContain('data-node="A"');
    // 页面片段按契约进了设备框，并且用的是模板的 wt-* 组件（不是我们的 class）
    expect(html).toContain('class="page" id="p-A"');
    expect(html).toContain('wt-statusbar');
    expect(html).toContain('wt-modal');
    expect(html).toContain('wt-bottombar');
    // 判断节点**不**挂到最近的页面上（2026-11-09 第三轮删掉的那条兜底）：它有自己的
    // 时序伪页面 `backend-B`，进的是第三格（build.py 用 json.dumps 的默认分隔符）。
    expect(html).toContain('"B": {"page": "backend-B"');
    expect(html).toContain('id="backend-B"');
    expect(html).toContain('class="seq-svg"');
    // 节点标注进了右栏
    expect(html).toContain('按距离列出可寄养门店');
    expect(html).toContain('会话里有没有签约主体');
    // 自足：没有外部资源
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);

    // 提示词 2 里必须有 page-guide 的关键规则（模型读不到文件，规则只能写进提示里）
    const ask = fake.prompts[1]!;
    expect(ask).toContain('A  [页面]  进入寄养频道');
    expect(ask).toContain('B  [判断]  是否签约？');
    expect(ask).toContain('wt-screen');
    expect(ask).toContain('375px');
    expect(ask).toContain('690px');
    expect(ask).toContain('emoji');
    expect(ask).toContain('一个状态一份片段');
    expect(ask).toContain("goNode('节点id')");
  });

  it('节点被判为后端却没给步骤 → 重问一次，仍不通过才失败；构建器一次都没跑', async () => {
    let built = 0;
    const noPage = JSON.stringify({
      nodes: [
        { id: 'A', kind: 'decision', title: '是否签约？', anno: [['判定依据', '会话里有没有主体']] },
        { id: 'B', kind: 'decision', title: '是否已登录？', anno: [['判定依据', '会话里有没有用户']] },
        { id: 'C', kind: 'decision', title: '是否已约满？', anno: [['判定依据', '当日空位数']] },
      ],
    });
    const fake = fakeProvider([SMALL_FLOW, noPage, noPage]);
    const deps: Partial<ComposeDeps> = {
      ...fake.deps,
      build: async () => {
        built += 1;
        return { ok: false, errors: ['不该跑到这里'], warnings: [] };
      },
    };
    const r = await inbox();

    const error = await caught(composeEvaluation(db, '吕品', { requirementId: r.id, stage: 'evaluate' }, deps));

    expect(error.code).toBe('pages_rejected');
    expect(error.message).toContain('页面片段 2 次都没通过校验');
    // 第二次的失败原因是「判为后端流程但没有给出步骤」——读回话那一层的原话（Gap 1），
    // 说清缺什么、该怎么补；不是「一个页面片段都没有」那句事实陈述（两句不合并）
    expect(error.message).toContain('判为后端流程但没有给出步骤');
    expect(error.message).toContain('节点「A 是否签约？」');
    expect(error.message).not.toContain('一个页面片段都没有');
    expect(built).toBe(0);
    expect(fake.prompts).toHaveLength(3);
    expect(await artifactExists(`/uemaster/PAN-${r.number}/evaluate-v001.html`)).toBe(false);
  });

  it('片段里没有 wt- 类 → 带这句中文重问一次，第二次合规就过', async () => {
    const bad = JSON.stringify({
      nodes: [
        { id: 'A', kind: 'page', frame: 'phone', title: '进入寄养频道', html: '<div class="card">门店列表</div>', anno: [],
          open: { req: [['边界', '最多几条']] } },
        { id: 'B', kind: 'decision', title: '是否签约？',
        steps: [
          { from: '页面', to: '服务端', what: '提交当前签约状态' },
          { from: '服务端', to: '服务端', what: '判断客户有没有签约主体' },
        ],
          anno: [] },
        { id: 'C', kind: 'page', frame: 'phone', title: '寄养首页', html: PHONE_A, anno: [] },
      ],
    });
    const good = JSON.stringify({
      nodes: [
        { id: 'A', kind: 'page', frame: 'phone', title: '进入寄养频道', html: PHONE_A, anno: [],
          open: { req: [['边界', '最多几条']] } },
        { id: 'B', kind: 'decision', title: '是否签约？',
        steps: [
          { from: '页面', to: '服务端', what: '提交当前签约状态' },
          { from: '服务端', to: '服务端', what: '判断客户有没有签约主体' },
        ],
          anno: [] },
        { id: 'C', kind: 'page', frame: 'phone', title: '寄养首页', html: PHONE_A_MODAL, anno: [] },
      ],
    });
    const fake = fakeProvider([SMALL_FLOW, bad, good]);
    const r = await inbox();

    const out = await composeEvaluation(db, '吕品', { requirementId: r.id, stage: 'evaluate' }, fake.deps);

    expect(await artifactExists(out.url)).toBe(true);
    // 修片段的提示词里带着校验器那一句原话，模型才知道改什么
    expect(fake.prompts[2]).toContain('没有使用 wt- 组件类');
    expect(fake.prompts[2]).toContain('上一版原文');
  });

  it('落库与推进照旧：evaluate 材料 → 需求进待设计，且只 attach 一次', async () => {
    const fake = fakeProvider([SMALL_FLOW, JSON.stringify({
      nodes: [
        { id: 'A', kind: 'page', frame: 'phone', title: '进入寄养频道', html: PHONE_A, anno: [],
          open: { req: [['边界', '最多几条']] } },
        { id: 'B', kind: 'decision', title: '是否签约？',
        steps: [
          { from: '页面', to: '服务端', what: '提交当前签约状态' },
          { from: '服务端', to: '服务端', what: '判断客户有没有签约主体' },
        ],
          anno: [] },
        { id: 'C', kind: 'page', frame: 'phone', title: '寄养首页', html: PHONE_A_MODAL, anno: [] },
      ],
    })]);
    const r = await inbox();

    await composeEvaluation(db, '吕品', { requirementId: r.id, stage: 'evaluate' }, fake.deps);

    const rows = await db.execute<{ n: number }>(sql`select count(*)::int as n from uemaster_artifacts`);
    expect(Number(rows.rows[0]!.n)).toBe(1);
    const state = await db.execute<{ state: string }>(sql`select state from requirements where id = ${r.id}`);
    // 2026-11-10 起生成不改状态：材料落库、需求仍在收集，立项要单独点。
    expect(state.rows[0]!.state).toBe('inbox');
  });
});
