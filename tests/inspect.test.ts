import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { AppError } from '../src/core/errors.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { DEFAULT_SSH_HOST, head } from '../src/core/codemirror/mirror.js';
import { hashMarkdown, saveSnapshot, type Snapshot } from '../src/core/prd/snapshots.js';
import { CALL_TIMEOUT_MS, DEEP_READ_BUDGET, INSPECT_REPOS, LIVE_LOCATE_DEPS, PRD_PROMPT_MAX, inspect, keywordsFrom, mermaidFromFlows, prdVersionOf, truncatePrd, validateStructure, type Finding, type InspectDeps, type Structure } from '../src/core/uemaster/inspect.js';
import { normalizeVerdict } from '../src/core/uemaster/shape.js';
import { ABSENT_HEADLINE, ABSENT_HISTORY_HEADLINE, CANDIDATES_LINE, CONFIRM_WITH_DEV, NOT_FOUND_HEADLINE } from '../src/core/locate/copy.js';
import type { ProviderConfig, ProviderResult } from '../src/core/uemaster/provider.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { artifactExists, cleanArtifacts, siteFile } from './helpers/files.js';

/**
 * P3.3：走查材料（PRD ⇄ 真实代码）。
 *
 * **一条 ssh 都不发、一次外网都不碰。** 但除了「谁来回话」之外每一样都是真的：
 * - 两个仓是当场 `git init --bare` + push 出来的真仓（不是 mock 的 ls-tree 输出），
 *   所以「路径存不存在」这件事由真 git 回答——这正是这条链路存在的理由；
 * - 排版是 vendored 的 `flowlayout.py` + `build.py`（真的 Python 子进程）；
 * - 库与文件系统是真的（`attachArtifact` 会 stat 那个站内链接）。
 *
 * 模型那一层是**注入的** `complete`：回话按脚本发，提示词原样留在数组里给用例断言。
 * 注入而不是起一个 127.0.0.1 的 http 服务，是因为这一组用例要断言的恰恰是
 * 「提示词里有没有那个编出来的路径」，回话的内容与传输无关。
 *
 * 要钉住的是七件事：
 * 1. 快乐路径：结论里的证据路径全部真实存在、材料落盘、attach、标题里有两个 sha；
 * 2. **编造的路径是硬失败**：修复提示词里必须有那个路径（这是镜像存在的全部意义）；
 * 3. `missing` 带证据路径 → 被拒；
 * 4. 没有 PRD 快照时调 `readPrd`；有快照时不调；
 * 5. 没配镜像 → 一句点名 `code.mirror.repos` 的中文，**一次模型调用都不发**；
 * 6. 材料里真的有 verdict 标注（一致 / 缺失 / …）；
 * 7. `runJob` 把「走查」接到这条链路上（而不是偷偷走评估管线）。
 */

// ─── 夹具：两个真的 bare 仓 ─────────────────────────────────────────────────

function gitCmd(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'flowers',
        GIT_AUTHOR_EMAIL: 'flowers@example.test',
        GIT_COMMITTER_NAME: 'flowers',
        GIT_COMMITTER_EMAIL: 'flowers@example.test',
      },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(' ')}\n${String(stderr)}`));
      else resolve(String(stdout));
    });
  });
}

/**
 * 两个仓的文件。
 *
 * 内容里刻意放了 PRD 里的业务词（分享链接 / 搜索 / 面包屑 / 全链接搜索）：
 * 阶段一的关键词真的会从 `tests/fixtures/prd-pan6.md` 里抽出来，命中这几个文件，
 * 于是「候选文件集」不是空的——那正是提示词里要出现的两样东西之一。
 */
const PC_FILES: Record<string, string> = {
  'src/router/router.js': [
    "import Share from '../pages/Share/Share';",
    'export const routes = [',
    "  { path: '/share', component: Share },",
    '];',
  ].join('\n'),
  'src/pages/Share/Share.tsx': [
    'export default function Share() {',
    '  // 分享链接的工具栏：搜索入口还在右上角图标里，没有换成输入框样式',
    '  return <header className="share-toolbar">分享链接 搜索</header>;',
    '}',
  ].join('\n'),
  'src/pages/Share/Search.tsx': [
    'export function Search() {',
    '  // 独立搜索状态：关键词、最近搜索、全链接搜索范围切换',
    '  return <main>全链接搜索</main>;',
    '}',
  ].join('\n'),
  'src/components/Breadcrumb.tsx': [
    'export function Breadcrumb() {',
    '  // 面包屑：全部文件 → 父级 → 当前目录（H5 走查要看这个组件到底有没有）',
    '  return <nav>面包屑</nav>;',
    '}',
  ].join('\n'),
  'src/api/share.ts': "export const searchInShare = (key: string) => fetch(`/api/share/search?key=${key}`);\n",
  'dist/bundle.js': 'const x = "分享链接 搜索";\n',
};

const UNI_FILES: Record<string, string> = {
  'pages.json': JSON.stringify({ pages: [{ path: 'pages/share/index' }] }, null, 2),
  'pages/share/index.vue': [
    '<template>',
    '  <view class="share">分享链接 搜索入口</view>',
    '</template>',
  ].join('\n'),
  'pages/share/search.vue': '<template><view>全链接搜索 最近搜索</view></template>\n',
  'pages/invoice/apply.vue': '<template><view>发票报销申请</view></template>\n',
};

type Fixture = { root: string; repos: Record<string, string>; shas: Record<string, string> };

/**
 * 每个仓的**那次合并**：从功能分支合进来、消息里带 PRD 的业务词。
 *
 * 走查的定位自 Task 8 起只认合并历史（`commit_history`），所以夹具必须是一个「这条
 * 功能是怎么合进来的」能查得到的真仓——只有一次初始提交的仓在历史里是**空的**，
 * 那时定位只能给出 `none`，走查的候选段就永远测不到了。合并消息与改动文件都照真实
 * 场景写：消息是第一段（`出自 11-07「…」` 就取它），改动落在功能路径上。
 */
const MERGES: Record<string, Array<{ message: string; file: string; add: string }>> = {
  '123pan-pc': [{
    message: 'feat: 分享页搜索补齐 / 工具栏搜索入口改成输入框',
    file: 'src/pages/Share/Share.tsx',
    add: '  // 合并带进来的改动：工具栏的搜索入口（走查要能追到这次合并）',
  }],
  '123pan-uni-app': [
    {
      message: 'feat: 分享页搜索补齐 / 全链接搜索默认范围',
      file: 'pages/share/index.vue',
      add: '  <!-- 合并带进来的改动：分享页搜索入口 -->',
    },
    {
      // 第二条合并在标题上**完全不重合**：它只跟需求描述（六问里的 `context`）对得上。
      // 检索式只有标题（见 `locateQuery`），所以这条合并在走查里**永远不该进候选**——
      // 它存在的意义就是把那条裁定的代价钉出来：描述走不进检索，这条需求就定位不到。
      // 把描述拼回检索式（`queryOfRequirement` 追加六问）时，下面的用例会红。
      message: 'feat: 发票报销审批流对接 / 开票信息校验',
      file: 'pages/invoice/apply.vue',
      add: '  <!-- 合并带进来的改动：报销申请页 -->',
    },
  ],
};

async function buildFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'flowers-inspect-'));
  const repos: Record<string, string> = {};
  const shas: Record<string, string> = {};
  const filesByRepo: Record<string, Record<string, string>> = {
    '123pan-pc': PC_FILES,
    '123pan-uni-app': UNI_FILES,
  };

  for (const id of INSPECT_REPOS) {
    const work = path.join(root, `${id}-work`);
    const bare = path.join(root, `${id}.git`);
    await mkdir(work, { recursive: true });
    for (const [name, content] of Object.entries(filesByRepo[id] ?? {})) {
      const file = path.join(work, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, 'utf8');
    }
    await gitCmd(work, ['init', '-q']);
    await gitCmd(work, ['add', '-A']);
    await gitCmd(work, ['commit', '-q', '-m', `fixture: ${id}`]);

    // 真的功能合并（`--no-ff`：走查读的是 `rev-list --merges`）——定位的输入就是它。
    const merges = MERGES[id] ?? [];
    for (let i = 0; i < merges.length; i += 1) {
      const merge = merges[i]!;
      const branch = `feat-${id}-${i}`;
      await gitCmd(work, ['checkout', '-q', '-b', branch]);
      const changed = path.join(work, merge.file);
      await writeFile(changed, `${await readFile(changed, 'utf8')}${merge.add}\n`, 'utf8');
      await gitCmd(work, ['add', '-A']);
      await gitCmd(work, ['commit', '-q', '-m', merge.message]);
      await gitCmd(work, ['checkout', '-q', '-']);
      await gitCmd(work, ['merge', '-q', '--no-ff', '-m', merge.message, branch]);
    }

    await gitCmd(root, ['init', '--bare', '-q', bare]);
    await gitCmd(bare, ['symbolic-ref', 'HEAD', 'refs/heads/master']);
    await gitCmd(work, ['push', '-q', bare, 'HEAD:refs/heads/master']);
    repos[id] = bare;
    shas[id] = (await gitCmd(work, ['rev-parse', 'HEAD'])).trim();
  }

  return { root, repos, shas };
}

// ─── 假 provider（按脚本回话） ───────────────────────────────────────────────

/**
 * 一个按脚本回话的 `complete`。
 *
 * 它只做三件事：把提示词原样留下（用例要断言「提示词里有没有那个编出来的路径」）、
 * 按队列发下一条回话、数调用次数（「没配镜像时一次都不许发」要靠它）。
 * 队列空了**不静默**：那说明用例脚本写错了，错误消息里带着第几次。
 */
type Fake = {
  prompts: string[];
  queue: string[];
  enqueue: (...texts: string[]) => void;
  calls: () => number;
};

let fake: Fake;

function newFake(): Fake {
  fake = {
    prompts: [],
    queue: [],
    enqueue: (...texts: string[]) => { fake.queue.push(...texts); },
    calls: () => fake.prompts.length,
  };
  return fake;
}

/** 注入给 `inspect` 的那两格：一个按脚本回话的 `complete`、一份钉死的配置。 */
function deps(extra: Partial<InspectDeps> = {}): Partial<InspectDeps> {
  return {
    resolveConfig: async (): Promise<ProviderConfig> => ({
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-inspect-test',
      model: 'fake-model',
    }),
    complete: async (_cfg, prompt): Promise<ProviderResult> => {
      fake.prompts.push(prompt);
      const next = fake.queue.shift();
      if (next === undefined) {
        return { ok: false, error: `用例脚本里没有更多回话了（第 ${fake.prompts.length} 次调用）` };
      }
      return { ok: true, text: next, usage: { prompt: 100, completion: 50 } };
    },
    ...extra,
  };
}

// ─── 环境 ────────────────────────────────────────────────────────────────────

const ENV_KEYS = [
  'FLOWERS_MIRROR_TRANSPORT', 'FLOWERS_MIRROR_REPOS', 'FLOWERS_MIRROR_SSH_HOST',
  'FLOWERS_PROVIDER_BASE_URL', 'FLOWERS_PROVIDER_API_KEY', 'FLOWERS_PROVIDER_MODEL',
] as const;
const savedEnv = new Map<string, string | undefined>();
let fixture: Fixture;

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function useFixtureEnv(): void {
  process.env.FLOWERS_MIRROR_TRANSPORT = 'local';
  process.env.FLOWERS_MIRROR_REPOS = JSON.stringify(
    INSPECT_REPOS.map((id) => ({ id, path: fixture.repos[id] })),
  );
  process.env.FLOWERS_MIRROR_SSH_HOST = DEFAULT_SSH_HOST;
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  fixture = await buildFixture();
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (fixture !== undefined) await rm(fixture.root, { recursive: true, force: true });
  await cleanArtifacts();
  await pool.end();
});

beforeEach(async () => {
  await resetDb();
  await seedPeople();
  await cleanArtifacts();
  newFake();
  clearEnv();
  useFixtureEnv();
});

afterEach(() => {
  clearEnv();
});

// ─── 回话脚本 ────────────────────────────────────────────────────────────────

const PRD_TEXT = await readFile(new URL('./fixtures/prd-pan6.md', import.meta.url), 'utf8');

const STRUCTURE_OK = JSON.stringify({
  flows: [
    { id: 'A', title: '分享页搜索入口', kind: 'page' },
    { id: 'B', title: '是否已输关键词', kind: 'decision' },
    { id: 'C', title: '搜索结果列表', kind: 'page' },
  ],
  findings: [
    {
      verdict: 'implemented',
      prd: '分享页工具栏要有搜索入口',
      code: '工具栏里有一个搜索图标（还没换成输入框样式）',
      evidence: [{ repo: '123pan-pc', path: 'src/pages/Share/Share.tsx', note: '工具栏就是这一屏' }],
    },
    {
      verdict: 'missing',
      prd: 'H5 面包屑：全部文件 → 父级 → 当前目录',
      code: '未找到',
      evidence: [],
      searched: ['面包屑', '全部文件', '目录导航'],
    },
    {
      verdict: 'differs',
      prd: '子文件夹结果态默认全链接搜索',
      code: 'uni-app 里默认还是当前文件夹',
      evidence: [{ repo: '123pan-uni-app', path: 'pages/share/search.vue', note: '默认范围写在这里' }],
    },
  ],
});

const PAGE_HTML = [
  '<div class="wt-screen">',
  '  <div class="wt-statusbar"><span>9:41</span><span class="wt-sb-icons"></span></div>',
  '  <div class="wt-nav"><span class="wt-nav-title">分享</span></div>',
  '  <div class="wt-body"><div class="wt-card"><div class="wt-li-title">文件列表</div></div></div>',
  '  <div class="wt-bottombar"><button class="wt-btn" onclick="goNode(\'C\')">搜索</button></div>',
  '</div>',
].join('\n');

const VERIFY_OK = JSON.stringify({
  nodes: [
    {
      id: 'A', kind: 'page', frame: 'phone', title: '分享页搜索入口', html: PAGE_HTML,
      anno: [['一致', '分享页工具栏已有搜索图标'], ['差距', 'PRD 要的输入框样式还没做']],
    },
    {
      id: 'B', kind: 'decision', title: '是否已输关键词',
      anno: [['缺失', 'PRD 要求空关键词不请求，代码里没有这个判断']],
    },
    {
      id: 'C', kind: 'page', frame: 'phone', title: '搜索结果列表', html: PAGE_HTML.replace('文件列表', '搜索结果'),
      anno: [['不一致', '默认范围还是当前文件夹'], ['缺口', '面包屑没有实现']],
    },
  ],
});

async function snapshotOf(requirementId: string, markdown = PRD_TEXT): Promise<Snapshot> {
  const { snapshot } = await saveSnapshot(db, '吕品', {
    requirementId,
    url: 'https://doc.weixin.qq.com/doc/w3_AW4A1gbtAKYCNrNKOiCOyR7ykQKyF',
    markdown,
  });
  return snapshot;
}

/** 一条带 PRD 的需求（走查要有 prd_url：`runJob` 的前置判断）。 */
async function inspectable(
  markdown = PRD_TEXT,
  extra: { title?: string; context?: string } = {},
) {
  const created = await createRequirement(db, '吕品', {
    title: extra.title ?? '分享页搜索补齐 H5 / APP',
    type: 'feature',
    requester: '孙建宏',
    ...(extra.context === undefined ? {} : { context: extra.context }),
  });
  await db.execute(sql`
    update requirements
       set prd_url = 'https://doc.weixin.qq.com/doc/w3_AW4A1gbtAKYCNrNKOiCOyR7ykQKyF'
     where id = ${created.id}`);
  await snapshotOf(created.id, markdown);
  return created;
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

async function artifactCount(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`select count(*)::int as n from uemaster_artifacts`);
  return Number(res.rows[0]!.n);
}

// ─── 纯函数 ──────────────────────────────────────────────────────────────────

describe('纯函数：关键词、版本、图、校验', () => {
  it('关键词从引号文案 + 标题 + 正文 n-gram 里来，且互不包含', () => {
    const words = keywordsFrom(PRD_TEXT, '分享页搜索补齐 H5 / APP');
    expect(words.length).toBeGreaterThan(0);
    expect(words.length).toBeLessThanOrEqual(8);
    // 业务词真的抽得出来（不是「可以」「需要」这类胶水词）
    expect(words.some((word) => /搜索|面包屑|分享|全链接/.test(word))).toBe(true);
    expect(words).not.toContain('可以');
    // 互不包含：没有「分享页搜索」和「搜索」同时出现
    for (const a of words) {
      for (const b of words) {
        if (a === b) continue;
        expect(a.includes(b)).toBe(false);
      }
    }
  });

  it('版本号取正文里最大的那个（v1.0 是初版，v1.4 是这一版）', () => {
    expect(prdVersionOf(PRD_TEXT, 'abc12345')).toBe('v1.4');
    expect(prdVersionOf('没有版本号的正文', 'deadbeef1234')).toBe('未标版本#deadbeef');
  });

  it('PRD 截断到 10k，并交代截了多少', () => {
    const { text, truncated } = truncatePrd(PRD_TEXT);
    expect(truncated).toBe(true);
    expect(text.length).toBe(PRD_PROMPT_MAX);
    expect(truncatePrd('短正文').truncated).toBe(false);
  });

  it('flows → 一条主干 mermaid（节点形态决定括号）', () => {
    const mermaid = mermaidFromFlows([
      { id: 'A', title: '分享页搜索入口', kind: 'page' },
      { id: 'B', title: '是否登录', kind: 'decision' },
      { id: 'C', title: '后台送审', kind: 'system' },
    ]);
    expect(mermaid.startsWith('flowchart TD')).toBe(true);
    expect(mermaid).toContain('A["分享页搜索入口"]');
    expect(mermaid).toContain('B{"是否登录"}');
    expect(mermaid).toContain('C[["后台送审"]]');
    expect(mermaid).toContain('A --> B');
    expect(mermaid).toContain('B --> C');
  });

  it('verdict 的写法容错：missing/缺失、一致、implemented（一致）都归一，别的不收', () => {
    // 这一条来自真实跑出来的第一版回话：模型把枚举值和自己要写的中文标注粘在一起。
    expect(normalizeVerdict('missing/缺失')).toBe('missing');
    expect(normalizeVerdict('differs | 不一致')).toBe('differs');
    expect(normalizeVerdict('implemented（一致）')).toBe('implemented');
    expect(normalizeVerdict('一致')).toBe('implemented');
    expect(normalizeVerdict('  Extra ')).toBe('extra');
    // 认不出来的原样交回去，让 zod 自己拒
    expect(normalizeVerdict('大概还没做')).toBe('大概还没做');
  });

  it('校验器：编造的路径、differs 无证据点名、missing 给不出任何指向也点名', () => {
    const trees = new Map([['123pan-pc', new Set(['src/pages/Share/Share.tsx'])]]);
    const base = (findings: Finding[]): Structure => ({
      flows: [
        { id: 'A', title: 'x', kind: 'page' },
        { id: 'B', title: 'y', kind: 'page' },
        { id: 'C', title: 'z', kind: 'page' },
      ],
      findings,
    });

    const madeUp = validateStructure(base([{
      verdict: 'implemented', prd: 'p', code: 'c',
      evidence: [{ repo: '123pan-pc', path: 'src/pages/share/Search.tsx', note: '' }],
    }]), trees);
    expect(madeUp.ok).toBe(false);
    expect(madeUp.problems.join('；')).toContain('src/pages/share/Search.tsx');

    const missingWithEvidence = validateStructure(base([{
      verdict: 'missing', prd: 'p', code: '未找到', searched: ['x'],
      evidence: [{ repo: '123pan-pc', path: 'src/pages/Share/Share.tsx', note: '' }],
    }]), trees);
    // 新语义：missing 指到真实存在的文件是允许的（那是"本该在的位置"）。
    expect(missingWithEvidence.ok).toBe(true);

    // 但既没 searched 也没指任何位置 → 拒（读者无从判断搜索覆盖面）。
    const missingBlind = validateStructure(base([{ verdict: 'missing', prd: 'p', code: '未找到', evidence: [] }]), trees);
    expect(missingBlind.ok).toBe(false);
    expect(missingBlind.problems.join('；')).toContain('覆盖面');

    const differsNoEvidence = validateStructure(base([{ verdict: 'differs', prd: 'p', code: 'c', evidence: [] }]), trees);
    expect(differsNoEvidence.ok).toBe(false);
    expect(differsNoEvidence.problems.join('；')).toContain('没有任何证据路径');

    const ok = validateStructure(base([{
      verdict: 'implemented', prd: 'p', code: 'c',
      evidence: [{ repo: '123pan-pc', path: 'src/pages/Share/Share.tsx', note: 'n' }],
    }]), trees);
    expect(ok.ok).toBe(true);
  });
});

// ─── 主流程 ──────────────────────────────────────────────────────────────────

describe('inspect：PRD ⇄ 真实代码', () => {
  it('快乐路径：证据路径全部真实存在、材料落盘、标题里有两个 sha', async () => {
    const r = await inspectable();
    fake.enqueue(STRUCTURE_OK, VERIFY_OK);

    const out = await inspect(db, '吕品', { requirementId: r.id }, deps());

    expect(out.url).toBe(`/uemaster/PAN-${r.number}/inspect.html`);
    expect(await artifactExists(out.url)).toBe(true);
    expect(await artifactCount()).toBe(1);

    // 1) 两段模型调用：结构一次 + 复核一次
    expect(fake.calls()).toBe(2);
    // 2) 提示词 1 带着 PRD（截断并写明）、**合并历史定位出来的**位置与两个仓的 HEAD
    expect(fake.prompts[0]).toContain('已截断');
    expect(fake.prompts[0]).toContain('分享页搜索补齐 H5 / APP');
    // Task 8 起这一段只由合并历史给出（不是 grep 命中）：那一次合并动的文件必须在场，
    // 而且带着「出自哪天」的出处。断言从这里改成**新契约**，而不是放宽。
    expect(fake.prompts[0]).toContain('阶段一：代码位置');
    expect(fake.prompts[0]).toContain('最可能的位置（待研发确认）：');
    expect(fake.prompts[0]).toContain('`src/pages/Share/Share.tsx` ← 出自');
    expect(fake.prompts[0]).toContain('`pages/share/index.vue` ← 出自');
    // 读到了就不许出现「没能在代码里定位到」——两种结论不能同时成立
    expect(fake.prompts[0]).not.toContain('没能在代码里定位到');
    for (const id of INSPECT_REPOS) expect(fake.prompts[0]).toContain(`${id}@`);
    // 3) 提示词 2 带着被引用文件的**正文**（不是路径）
    expect(fake.prompts[1]).toContain('工具栏里有一个搜索图标');
    expect(fake.prompts[1]).toContain('goNode');

    // 4) 结论与数字
    expect(out.stats.findings).toBe(3);
    expect(out.stats.verdicts).toEqual({ implemented: 1, missing: 1, extra: 0, differs: 1 });
    expect(out.stats.cited).toBe(2);
    expect(out.stats.citedValid).toBe(2);
    expect(out.stats.deepRead).toBe(2);
    expect(out.stats.deepReadChars).toBeLessThanOrEqual(DEEP_READ_BUDGET);
    expect(out.stats.flows).toBe(3);
    expect(out.stats.structureAttempts).toBe(1);
    expect(out.stats.verifyAttempts).toBe(1);
    expect(out.stats.bytes).toBeGreaterThan(0);
    expect(out.stats.prdVersion).toBe('v1.4');

    // 5) 标题里有**两个** sha —— 读者能指着它说「我看的是这一版代码」
    const html = await readFile(siteFile(out.url), 'utf8');
    for (const id of INSPECT_REPOS) {
      const sha8 = fixture.shas[id]!.slice(0, 8);
      expect(html).toContain(`${id}@${sha8}`);
      expect(out.stats.repos.find((repo) => repo.id === id)?.sha).toBe(fixture.shas[id]);
    }
    expect(html).toContain('PRD v1.4');

    // 6) 三栏骨架是 build.py 的；verdict 标注真的进了材料
    expect(html).toContain('<svg id="flowsvg"');
    expect(html).toContain('class="flow-panel"');
    expect(html).toContain('一致');
    expect(html).toContain('缺失');
    expect(html).toContain('不一致');
    // 走查的图是「按真实流程节点串出来的」，节点文案必须都在
    for (const label of ['分享页搜索入口', '是否已输关键词', '搜索结果列表']) {
      expect(html).toContain(label);
    }
  }, 60_000);

  it('编造的路径是硬失败：修复提示词里必须有那个路径，第二次改对就能过', async () => {
    const r = await inspectable();
    fake.enqueue(
      // 第一版：路径大小写与目录都不对（真实的模型最爱犯这个错）
      JSON.stringify({
        flows: [
          { id: 'A', title: '分享页搜索入口', kind: 'page' },
          { id: 'B', title: '是否已输关键词', kind: 'decision' },
          { id: 'C', title: '搜索结果列表', kind: 'page' },
        ],
        findings: [{
          verdict: 'implemented', prd: '分享页工具栏要有搜索入口', code: '已有',
          evidence: [{ repo: '123pan-pc', path: 'src/pages/share/Search.tsx', note: '猜的' }],
        }],
      }),
      STRUCTURE_OK,
      VERIFY_OK,
    );

    const out = await inspect(db, '吕品', { requirementId: r.id }, deps());

    expect(out.stats.structureAttempts).toBe(2);
    const repair = fake.prompts[1]!;
    expect(repair).toContain('src/pages/share/Search.tsx');
    expect(repair).toContain('不存在');
    expect(out.stats.citedValid).toBe(out.stats.cited);
  }, 60_000);

  it('编造的路径两次都不改 → 失败，消息里带着那个路径，不留产物', async () => {
    const r = await inspectable();
    const bad = JSON.stringify({
      flows: [
        { id: 'A', title: '分享页搜索入口', kind: 'page' },
        { id: 'B', title: '是否已输关键词', kind: 'decision' },
        { id: 'C', title: '搜索结果列表', kind: 'page' },
      ],
      findings: [{
        verdict: 'implemented', prd: 'p', code: 'c',
        evidence: [{ repo: '123pan-pc', path: 'src/pages/share/Ghost.tsx', note: '' }],
      }],
    });
    fake.enqueue(bad, bad);

    const error = await caught(inspect(db, '吕品', { requirementId: r.id }, deps()));

    expect(error.code).toBe('inspect_invalid');
    expect(error.message).toContain('src/pages/share/Ghost.tsx');
    expect(fake.calls()).toBe(2); // 上限是硬的：没有第 3 次
    expect(await artifactCount()).toBe(0);
    expect(await artifactExists(`/uemaster/PAN-${r.number}/inspect.html`)).toBe(false);
  }, 60_000);

  it('missing 带了证据路径 → 接受（那是"它本该在的位置"，读者能去看一眼）', async () => {
    const r = await inspectable();
    const contradictory = JSON.stringify({
      flows: [
        { id: 'A', title: '分享页搜索入口', kind: 'page' },
        { id: 'B', title: '是否已输关键词', kind: 'decision' },
        { id: 'C', title: '搜索结果列表', kind: 'page' },
      ],
      findings: [{
        verdict: 'missing', prd: '面包屑', code: '未找到',
        evidence: [{ repo: '123pan-pc', path: 'src/components/Breadcrumb.tsx', note: '一边说没有一边引' }],
        searched: ['面包屑'],
      }],
    });
    fake.enqueue(contradictory, VERIFY_OK);

    // 新语义：missing 指到「它本该在的文件」是**好事**，不该被拒。
    // 这条用例原来断言相反（早前规则禁止 missing 带证据），实测被真实模型打回后改的。
    const out = await inspect(db, '吕品', { requirementId: r.id }, deps());
    expect(out.url).toContain('/uemaster/PAN-');
    expect(await artifactCount()).toBe(1);
  }, 60_000);

  it('描述不进检索式：标题对不上、只有 context 对得上时，材料写「没能定位到」（裁定的代价）', async () => {
    // 标题与两条合并都不重合；只有描述（六问里的 `context`）提到发票报销审批流。
    // 走查的检索式现在只有标题（理由与三组实测见 inspect.ts 的 locateQuery），所以这条
    // 需求在历史里是**找不到**的——这个用例就是那条裁定的代价，写出来让它可见。
    const r = await inspectable(PRD_TEXT, { title: '老系统的一个小需求', context: '发票报销审批流要能对接' });
    fake.enqueue(STRUCTURE_OK, VERIFY_OK);

    await inspect(db, '吕品', { requirementId: r.id }, deps());

    const prompt = fake.prompts[0]!;
    expect(prompt).toContain('没能在代码里定位到这条需求的实现。');
    // 描述里那个词找到的那条合并，这次不该出现（描述不参与）
    expect(prompt).not.toContain('`pages/invoice/apply.vue` ←');
    // 标题也照样不重合，所以那两次分享页合并同样不该出现
    expect(prompt).not.toContain('`src/pages/Share/Share.tsx` ←');
  }, 30_000);

  it('只有一个仓的历史读不到：材料里写明「代码读到了、历史没读到」，另一仓候选照常，账记一行', async () => {
    const r = await inspectable();
    fake.enqueue(STRUCTURE_OK, VERIFY_OK);

    const blindRepo = '123pan-uni-app';
    const out = await inspect(db, '吕品', { requirementId: r.id }, deps({
      locateDeps: {
        ...LIVE_LOCATE_DEPS,
        // 按仓决定成败：这才是真实运维里最常见的样子（一个镜像挂了、另一个还好）
        ensureHistory: async (_db, repo) => (repo === blindRepo
          ? { ok: false, code: 'git_failed', message: '读合并历史失败：镜像 ssh 连接超时' }
          : { ok: true, data: { inserted: 0, total: 1, ms: 1 } }),
        readHistory: async (_db, repo) => (repo === blindRepo ? [] : []),
      },
    }));

    // 1) 不抛：还有一个仓能判，材料照出
    expect(out.url).toContain('/uemaster/PAN-');
    expect(fake.calls()).toBe(2);

    // 2) 提示词里那一仓写的是**历史**那一句（终审 Blocker 1）：代码读到了，不许说成没读到
    const prompt = fake.prompts[0]!;
    expect(prompt).toContain(ABSENT_HISTORY_HEADLINE);
    expect(prompt).not.toContain(ABSENT_HEADLINE);
    expect(prompt).toContain('镜像 ssh 连接超时');
    expect(prompt).toContain(blindRepo);
    // 3) 另一条禁令也在：不许给读不到的仓下判断
    expect(prompt).toContain('不要给这些仓下任何现状判断');

    // 4) 账记**一行**（终审 Minor 3：一轮一行；两仓合成一条，absent 压过 none）
    const rows = await db.execute<{ outcome: string; stage: string; candidates: number }>(sql`
      select outcome, stage, candidates from locate_runs order by created_at`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ outcome: 'absent', stage: 'inspect', candidates: 0 });

    // 5) 单看 outcome 只知道「有个仓没读到」，`detail` 才点名是哪一个（修复二波）。
    //    这一轮是「一仓 absent + 一仓 none」，不是半盲的 low——所以下面那条 low 的用例
    //    才需要 `detail` 兜底。
    const detail = await db.execute<{
      detail: { repos: Record<string, { kind: string; why?: string }> };
    }>(sql`select detail from locate_runs`);
    expect(detail.rows[0]!.detail.repos[blindRepo]).toEqual({
      kind: 'absent',
      why: '读合并历史失败：镜像 ssh 连接超时',
    });
  }, 30_000);

  /**
   * 修复二波：记账挪到产物之后（与评审那条路同口径）。
   *
   * 原来的写法在两次模型调用之前就落库，于是 `walkmap_rejected` 之后库里留着一条指向
   * **从未存在过的材料**的行——而 `locate_runs` 是算准确率的分母。
   *
   * 变异：把 `recordInspectRound` 挪回 `locateRoundForInspect`（判完就记）→ 这条红。
   */
  it('材料构建失败（walkmap_rejected）→ 库里一行都不留', async () => {
    const r = await inspectable();
    fake.enqueue(STRUCTURE_OK, VERIFY_OK);

    const error = await caught(inspect(db, '吕品', { requirementId: r.id }, deps({
      build: async () => ({ ok: false, errors: ['build.py 起不来'], warnings: [] }),
    })));

    expect(error.code).toBe('walkmap_rejected');
    expect(await artifactCount()).toBe(0);
    const rows = await db.execute<{ stage: string }>(sql`select stage from locate_runs`);
    expect(rows.rows).toEqual([]);
  }, 30_000);

  it('两个仓的历史都读不到 → **照样出材料**，横幅第一句是「代码读到了、合并历史没读到」，且不下任何现状判断', async () => {
    const r = await inspectable();
    fake.enqueue(STRUCTURE_OK, VERIFY_OK);

    const out = await inspect(db, '吕品', { requirementId: r.id }, deps({
      locateDeps: {
        ...LIVE_LOCATE_DEPS,
        ensureHistory: async () => ({
          ok: false, code: 'git_failed', message: '镜像 ssh 连接超时（mirror@example.test:22）',
        }),
        readHistory: async () => [],
      },
    }));

    // 1) 终审 Blocker 1 的裁决：这条路径上 HEAD / lsTree / repoShape 都读到了，
    //    能出的部分（流程主干 + PRD 侧结论）照出，不再整份消失。
    expect(out.url).toContain('/uemaster/PAN-');
    expect(await artifactCount()).toBe(1);

    // 2) 提示词里是「历史没读到」那一句 + 原因，绝不是「代码没读到」
    const prompt = fake.prompts[0]!;
    expect(prompt).toContain(ABSENT_HISTORY_HEADLINE);
    expect(prompt).toContain('镜像 ssh 连接超时');
    expect(prompt).not.toContain(ABSENT_HEADLINE);
    // （`代码里没有` 这四个字在提示词的 verdict 定义里本来就出现，不能拿来当判据）

    // 3) 产物里也写着（横幅由代码写，见下一条用例），统计里记着 absent
    expect(out.stats.locate).toEqual(Object.fromEntries(INSPECT_REPOS.map((id) => [id, 'absent'])));
    expect(out.stats.candidates).toEqual(Object.fromEntries(INSPECT_REPOS.map((id) => [id, 0])));
    const html = await readFile(siteFile(out.url), 'utf8');
    expect(html).toContain(ABSENT_HISTORY_HEADLINE);
  }, 30_000);

  /**
   * 终审 Blocker 2：那几句话必须进**产物**，而且由代码写、模型不参与。
   *
   * 三种情况各出一次材料，断言横幅**逐字**带着 `copy.ts` 的输出。这组用例的价值不在
   * 「横幅有没有出现」，而在于它是**独立于模型**的：`fake` 的回话（`STRUCTURE_OK` /
   * `VERIFY_OK`）里一个字都不提定位结论，横幅照样在。
   */
  describe('材料顶部的定位横幅（由代码写，模型不参与）', () => {
    /** 把横幅那段文字抠出来（去标签 → 一行一段）。 */
    function bannerTextOf(html: string): string {
      const match = /<section class="locate-banner"[\s\S]*?<\/section>/.exec(html);
      expect(match, '产物里没有定位横幅').not.toBeNull();
      return match![0]
        .replace(/<[^>]+>/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .join('\n');
    }

    it('有候选：横幅按仓给出「最可能的位置（待研发确认）」+ 出处 + 收尾', async () => {
      const r = await inspectable();
      fake.enqueue(STRUCTURE_OK, VERIFY_OK);

      const out = await inspect(db, '吕品', { requirementId: r.id }, deps());
      const html = await readFile(siteFile(out.url), 'utf8');
      const banner = bannerTextOf(html);

      // 两仓的候选不同 → 按仓标出（同样的结论才去重成一句）
      for (const id of INSPECT_REPOS) expect(banner).toContain(`[${id}]`);
      expect(banner).toContain('最可能的位置（待研发确认）：');
      expect(banner).toContain('`src/pages/Share/Share.tsx` ← 出自');
      expect(banner).toContain('以上是线索，不是结论。');
      expect(banner).toContain(CONFIRM_WITH_DEV);

      // 横幅在最前面：正文骨架（svg / 三栏）都在它之后
      expect(html.indexOf('locate-banner')).toBeLessThan(html.indexOf('<svg id="flowsvg"'));
      expect(html.indexOf('locate-banner')).toBeLessThan(html.indexOf('class="flow-panel"'));
    }, 60_000);

    it('读到了但没找到：横幅逐字是「没能定位到」那一句，一个字不多', async () => {
      const r = await inspectable();
      fake.enqueue(STRUCTURE_OK, VERIFY_OK);

      const out = await inspect(db, '吕品', { requirementId: r.id }, deps({
        locateDeps: {
          ...LIVE_LOCATE_DEPS,
          ensureHistory: async () => ({ ok: true, data: { inserted: 0, total: 0, ms: 1 } }),
          readHistory: async () => [],
        },
      }));
      const banner = bannerTextOf(await readFile(siteFile(out.url), 'utf8'));

      // 两仓结论相同 → 只说一遍（去重），且逐字等于 copy 的输出
      expect(banner).toBe(`${NOT_FOUND_HEADLINE}${CONFIRM_WITH_DEV}`);
      expect(banner).not.toContain(ABSENT_HEADLINE);
    }, 60_000);

    it('历史读不到：横幅逐字是「代码读到了、合并历史没读到」那一句 + 原因', async () => {
      const r = await inspectable();
      fake.enqueue(STRUCTURE_OK, VERIFY_OK);

      const why = '镜像 ssh 连接超时（mirror@example.test:22）';
      const out = await inspect(db, '吕品', { requirementId: r.id }, deps({
        locateDeps: {
          ...LIVE_LOCATE_DEPS,
          ensureHistory: async () => ({ ok: false, code: 'git_failed', message: why }),
          readHistory: async () => [],
        },
      }));
      const banner = bannerTextOf(await readFile(siteFile(out.url), 'utf8'));

      expect(banner.startsWith(ABSENT_HISTORY_HEADLINE)).toBe(true);
      // why 一个字都不许丢：那是 PM 唯一能拿去催人的线索
      expect(banner).toContain(`（原因：${why}）`);
      expect(banner).toContain(CONFIRM_WITH_DEV);
      // 「代码没读到」是另一半的措辞，不许出现在这条路径上
      expect(banner).not.toContain(ABSENT_HEADLINE);
    }, 60_000);
  });

  it('没有 PRD 快照 → 先 readPrd；有快照 → 不读', async () => {
    const r = await inspectable();
    // 把那条快照删掉：走查必须先读 PRD
    await db.execute(sql`delete from prd_snapshots where requirement_id = ${r.id}`);

    let readCalls = 0;
    const readPrdStub: NonNullable<InspectDeps['readPrd']> = async (_db, _actor, input) => {
      readCalls += 1;
      const snapshot = await snapshotOf(input.requirementId);
      return { ok: true, data: { snapshot, created: true, title: null, kind: 'doc' } };
    };

    fake.enqueue(STRUCTURE_OK, VERIFY_OK);
    const first = await inspect(db, '吕品', { requirementId: r.id }, deps({ readPrd: readPrdStub }));
    expect(readCalls).toBe(1);
    expect(first.stats.prdVersion).toBe('v1.4');

    // 现在库里有快照了：再走一次就**不该**再读 PRD（读一次要几秒 + 一次真实网络）
    fake.enqueue(STRUCTURE_OK, VERIFY_OK);
    const second = await inspect(db, '吕品', { requirementId: r.id }, deps({ readPrd: readPrdStub }));
    expect(readCalls).toBe(1);
    expect(second.stats.prdHash).toBe(first.stats.prdHash);
  }, 90_000);
});

// ─── 没有镜像：一条模型调用都不许发 ─────────────────────────────────────────

describe('没有代码镜像', () => {
  it('给一句点名 code.mirror.repos 的中文，且一次模型调用都不发', async () => {
    const r = await inspectable();
    // 环境里的三格全撤掉；库也被 resetDb 清过，所以 `code.mirror.repos` 是空的
    clearEnv();
    fake.enqueue(STRUCTURE_OK, VERIFY_OK);

    const error = await caught(inspect(db, '吕品', { requirementId: r.id }, deps()));

    expect(error.code).toBe('mirror_unconfigured');
    expect(error.message).toContain('code.mirror.repos');
    expect(error.message).toContain('FLOWERS_MIRROR_REPOS');
    expect(fake.calls()).toBe(0);
    expect(await artifactCount()).toBe(0);
  }, 30_000);
});

// ─── 接线：runJob 把 inspect 接到走查上 ─────────────────────────────────────

describe('runJob：走查走的是 inspect，不是评估管线', () => {
  it('没有镜像 → 作业收成 failed，错误点名缺的配置（不偷偷降级）', async () => {
    const r = await inspectable();
    // 配了模型接口（于是 strategy 是 provider）、但**没有**镜像：走查必须在这里停下，
    // 而不是退回 compose 的评估管线——那样产物是对的、结论全是编的。
    clearEnv();
    process.env.FLOWERS_PROVIDER_BASE_URL = 'http://127.0.0.1:9/v1';
    process.env.FLOWERS_PROVIDER_API_KEY = 'sk-inspect-test';
    process.env.FLOWERS_PROVIDER_MODEL = 'fake-model';

    const job = await db.execute<{ id: string }>(sql`
      insert into uemaster_jobs (requirement_id, stage, status)
      values (${r.id}, 'inspect', 'running') returning id`);
    const jobId = job.rows[0]!.id;

    const { runJob } = await import('../src/core/uemaster/start.js');
    await runJob(db, jobId, { actor: '吕品' });

    const row = await db.execute<{ status: string; error: string | null; artifact_id: string | null }>(sql`
      select status, error, artifact_id from uemaster_jobs where id = ${jobId}`);
    expect(row.rows[0]!.status).toBe('failed');
    expect(row.rows[0]!.error).toContain('代码镜像');
    expect(row.rows[0]!.error).toContain('code.mirror.repos');
    expect(row.rows[0]!.artifact_id).toBeNull();
    expect(await artifactCount()).toBe(0);
  }, 30_000);

});

// ─── 基线本身 ────────────────────────────────────────────────────────────────

describe('镜像基线', () => {
  it('head 给出夹具仓的 sha（标题里那两个数字的来源）', async () => {
    const pc = await head('123pan-pc');
    expect(pc.ok).toBe(true);
    if (pc.ok) expect(pc.data?.sha).toBe(fixture.shas['123pan-pc']);
  });

  it('单次调用有上限，但得容得下会思考的模型', () => {
    // 原来卡 150s。实测 deepseek-flash 在复核段要思考 50k 字、单轮 120s 以上，
    // 150s 会把**能成功的调用**判成超时。上限放宽到 7 分钟，同时留一个天花板
    // 防止配错时一次作业挂死（4 次调用 × 7 分钟 = 28 分钟封顶）。
    expect(CALL_TIMEOUT_MS).toBeLessThanOrEqual(420_000);
    expect(CALL_TIMEOUT_MS).toBeGreaterThan(150_000);
  });
});
