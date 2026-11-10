import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import {
  EMPTY_SURFACES, knownSurfaces, pagesOutlineMissing,
  type KnownSurface, type KnownSurfaces,
} from '../src/core/locate/copy.js';
import {
  composeEvaluation, flowPrompt, fragmentsPrompt, repairPrompt,
  type ComposeDeps, type RequirementRow, type FlowNode,
} from '../src/core/uemaster/compose.js';
import { loadKnownSurfaces } from '../src/core/uemaster/surfaces.js';
import { reviewRequirement, type ReviewDeps } from '../src/core/uemaster/review.js';
import type { BuiltIndex } from '../src/core/codemirror/index-store.js';
import type { FlowCheck } from '../src/core/uemaster/flow.js';
import type { MirrorResult } from '../src/core/codemirror/mirror.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { BRIEF } from './helpers/brief.js';
import { cleanArtifacts } from './helpers/files.js';

/**
 * 任务 4（含 Phase 1 复查的 C1 / C2 / I4 / I5）：把「现有页面 + 组件 + 引用数」接进评估提示词。
 *
 * 这里钉的是**四层**，每层坏法的后果完全不同：
 * 1. `knownSurfaces`：索引里的页面怎么收成提示词能吃的形状。收错了（拿别页的文件、
 *    漏掉页面目录下的组件、把 `tag` 占位当组件、重复列同一个组件）的后果不是格式问题——
 *    模型会据此说「这页已经有 X 了」或漏说「这页已经有 X」，而那是材料里唯一会被 PM
 *    当事实读的一句话。
 * 2. **覆盖率**（C1）：`complete === false` 时提示词必须把「不要假设清单之外还有页面」
 *    换成「本清单不完整」。没有这条信号，一句「共 N 个」的权威口吻会把失明说成看得全，
 *    被漏掉的页面全部变成「新增页面」——那正是本任务唯一那个指标。
 * 3. 提示词：有清单时要求「现有页面：<route>」/「新增页面」，**没有清单时一个字都不说**。
 * 4. 装配：`composeEvaluation` / `runJob` 真的把清单传进那两次调用。前三层绿而这一层
 *    断着，就是「测试全绿、材料照旧编页面」——本任务之前的原状。
 */

async function artifactCount(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`select count(*)::int as n from uemaster_artifacts`);
  return Number(res.rows[0]!.n);
}

const req = {
  id: 'r1', number: 42, title: '分享链接', type: 'feature', requester: '吕品',
  prd_url: null, context: null, problem: null, outcome: null, surfaces: null,
  edge_cases: null, out_of_scope: null, platforms: ['mobile'], priority: null,
} as unknown as RequirementRow;

/** 一份「完整」清单：三个字段都必须对，`complete: true` 才允许封闭世界的措辞。 */
function complete(surfaces: KnownSurface[]): KnownSurfaces {
  return { surfaces, total: surfaces.length, complete: true, note: null };
}

// ─── 1. 形状 ────────────────────────────────────────────────────────────────

describe('knownSurfaces', () => {
  it('页面、标题、组件收成评估提示词能吃的形状（引用数没视图文件时为 null）', () => {
    const s = knownSurfaces({
      files: {}, imports: {}, routes: [], outline: {}, importedBy: {},
      pages: [{ route: '/pages/share/index', title: '分享页', source: 'pages.json' }],
    } as never);
    expect(s).toEqual({
      surfaces: [{ route: '/pages/share/index', title: '分享页', components: [], componentTotal: 0, importers: null }],
      total: 1,
      complete: true,
      note: null,
    });
  });

  it('同名的 .ts（apis/login.ts）不算这一页', () => {
    const s = knownSurfaces({
      pages: [{ route: '/login', title: null, source: 'router' }],
      files: {
        'src/pages/Login/login.tsx': 'x',
        'src/apis/login.ts': 'z',
      },
      outline: {
        'src/pages/Login/login.tsx': [{ kind: 'component-use', name: 'LoginForm', line: 3 }],
        'src/apis/login.ts': [{ kind: 'symbol', name: 'fetchAccountLogin', line: 9 }],
      },
      imports: {}, routes: [], importedBy: {},
    } as never);
    expect(s.surfaces).toHaveLength(1);
    expect(s.surfaces[0]!.components).toEqual(['LoginForm']);
  });

  /**
   * C2：`src/pages/Login/components/**` 是登录页的组成。第一版只看 `login.tsx` 自己，
   * 于是材料写「/login：没读到组件」——而登录页由这 8 个组件组成。
   */
  it('页面目录下的组件（components/**）算这一页，/login 的 8 个组件一个不少', () => {
    const s = knownSurfaces({
      pages: [{ route: '/login', title: null, source: 'router' }],
      files: {
        'src/pages/Login/login.tsx': 'x',
        'src/pages/Login/BindPhoneModal.tsx': 'x',
        'src/pages/Login/components/InputPassword/index.tsx': 'x',
        'src/pages/Login/components/VcodeInput/index.tsx': 'x',
        'src/pages/Login/components/blacklistModal/index.tsx': 'x',
        'src/pages/Login/components/HCaptcha/index.tsx': 'x',
        // 同一棵树上别的页面的目录：不能被算进 /login
        'src/pages/VideoPage/index.tsx': 'x',
        'src/apis/login.ts': 'x',
      },
      outline: {
        'src/pages/Login/BindPhoneModal.tsx': [{ kind: 'component-use', name: 'HFrame', line: 2 }],
        'src/pages/Login/components/InputPassword/index.tsx': [
          { kind: 'component-use', name: 'HInput', line: 9 },
          { kind: 'component-use', name: 'MfyIcon', line: 12 },
        ],
        'src/pages/Login/components/VcodeInput/index.tsx': [
          { kind: 'component-use', name: 'VcodeInputProps', line: 4 },
        ],
        'src/pages/Login/components/blacklistModal/index.tsx': [
          { kind: 'component-use', name: 'BaseModal', line: 3 },
          { kind: 'component-use', name: 'HButton', line: 7 },
        ],
        'src/pages/Login/components/HCaptcha/index.tsx': [
          { kind: 'component-use', name: 'HCaptcha', line: 3 },
          { kind: 'component-use', name: 'HCheckbox', line: 8 },
        ],
        'src/pages/VideoPage/index.tsx': [{ kind: 'component-use', name: 'VideoPlayer', line: 3 }],
        'src/apis/login.ts': [{ kind: 'symbol', name: 'fetchAccountLogin', line: 9 }],
      },
      imports: {}, routes: [], importedBy: {},
    } as never);
    expect(s.surfaces).toHaveLength(1);
    expect(s.surfaces[0]!.components).toEqual([
      'HFrame', 'HInput', 'MfyIcon', 'VcodeInputProps', 'BaseModal', 'HButton', 'HCaptcha', 'HCheckbox',
    ]);
    expect(s.surfaces[0]!.components).not.toContain('VideoPlayer');
    expect(s.surfaces[0]!.components).not.toContain('fetchAccountLogin');
  });

  /**
   * I4：`importedBy` 本来每次装配都算、生产路径零次读取。现在它每页给一个数，
   * 且只在 `files` 里有的文件上数（`importedBy` 的键可以不在 `files` 里）。
   */
  it('页面被几处引用：只数索引里有的文件，没视图文件的页写 null', () => {
    const s = knownSurfaces({
      pages: [
        { route: '/pages/share/index', title: '分享页', source: 'pages.json' },
        { route: '/pages/ghost/index', title: null, source: 'pages.json' },
      ],
      files: {
        'src/pages/share/index.vue': 'x',
        'src/pages/share/components/SearchBar.vue': 'x',
        'src/entry-a.ts': 'x',
        'src/entry-b.ts': 'x',
      },
      outline: { 'src/pages/share/index.vue': [{ kind: 'component-use', name: 'FileList', line: 2 }] },
      imports: {},
      importedBy: {
        // 第三个 import 者不在 `files` 里（`static/` 判 other、不进索引）：不许算进这个数
        'src/pages/share/index.vue': ['src/entry-a.ts', 'src/entry-b.ts', 'static/storeSdk.ts'],
        'src/pages/share/components/SearchBar.vue': ['src/pages/share/index.vue'],
        // 键不在 files 里：`static/storeSdk.ts` 那种，classifyKind 判 other 不进索引
        'src/pages/ghost/index.vue': ['static/storeSdk.ts'],
      },
    } as never);
    expect(s.surfaces.map((x) => [x.route, x.importers])).toEqual([
      ['/pages/share/index', 2],
      ['/pages/ghost/index', null],
    ]);
  });

  it('`tag` 是占位不给模型看；`symbol` 与 `component-use` 都收；重复项只留一次', () => {
    const s = knownSurfaces({
      pages: [{ route: '/pages/host/host', title: null, source: 'pages.json' }],
      files: { 'src/pages/host/host.vue': 'x' },
      outline: {
        'src/pages/host/host.vue': [
          { kind: 'component-use', name: 'Navigation', line: 1 },
          { kind: 'tag', name: 'view', line: 2 },
          { kind: 'component-use', name: 'Navigation', line: 3 },
          { kind: 'symbol', name: 'useHostStore', line: 9 },
        ],
      },
      imports: {}, routes: [], importedBy: {},
    } as never);
    expect(s.surfaces[0]!.components).toEqual(['Navigation', 'useHostStore']);
  });

  /** C1：截断不是静默的——`total` 是真数，`complete` 必须变 false。 */
  it('组件封顶 12 个、页面按 limit 截断，且截断后 complete=false（不能说共 3 个）', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ kind: 'component-use' as const, name: `C${i}`, line: i + 1 }));
    const s = knownSurfaces({
      pages: Array.from({ length: 5 }, (_, i) => ({ route: `/pages/p${i}/index`, title: null, source: 'pages.json' as const })),
      files: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`src/pages/p${i}/index.vue`, 'x'])),
      outline: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`src/pages/p${i}/index.vue`, many])),
      imports: {}, routes: [], importedBy: {},
    } as never, 3);
    expect(s.surfaces).toHaveLength(3);
    expect(s.surfaces[0]!.components).toHaveLength(12);
    // 封顶不是静默的：这一页一共有 20 个名字，提示词里要写明还有 8 个没列
    expect(s.surfaces[0]!.componentTotal).toBe(20);
    expect(s.total).toBe(5);
    expect(s.complete).toBe(false);
    expect(s.note).toContain('5');
    const line = flowPrompt(req, 'evaluate', complete(s.surfaces)).split('\n').find((l) => l.startsWith('  - /pages/p0/index'));
    expect(line).toContain('另有 8 个未列出，共 20 个');
  });
});

/** I5：整仓轮廓为空 = 没读到，不是「确实没有组件」。 */
describe('pagesOutlineMissing', () => {
  it('页面一个轮廓条目都没有 → true（0032 之前的行 outline 永远是 null）', () => {
    expect(pagesOutlineMissing({
      pages: [{ route: '/login', title: null, source: 'router' }],
      files: { 'src/pages/Login/login.tsx': 'x' },
      outline: {},
    } as never)).toBe(true);
  });

  it('有一页读到轮廓 → false；本来就没有页面 → false（没有什么可说的）', () => {
    expect(pagesOutlineMissing({
      pages: [{ route: '/login', title: null, source: 'router' }],
      files: { 'src/pages/Login/login.tsx': 'x' },
      outline: { 'src/pages/Login/login.tsx': [{ kind: 'component-use', name: 'LoginForm', line: 1 }] },
    } as never)).toBe(false);
    expect(pagesOutlineMissing({ pages: [], files: {}, outline: {} } as never)).toBe(false);
  });
});

// ─── 2. 提示词 ──────────────────────────────────────────────────────────────

const SURFACES = complete([
  { route: '/pages/share/index', title: '分享页', components: ['SearchBar', 'FileList'], componentTotal: 2, importers: 3 },
]);

describe('flowPrompt 带现有页面', () => {
  it('提示词里出现页面清单，且要求区分现有/新增', () => {
    const p = flowPrompt(req, 'evaluate', SURFACES);
    expect(p).toContain('/pages/share/index');
    expect(p).toContain('现有页面');
    expect(p).toContain('新增页面');
    // 组件也要点名：材料说「这页已经有 FileList」时必须有据
    expect(p).toContain('FileList');
    // I4：引用数进材料（一行一个数），并要求写在材料里
    expect(p).toContain('被 3 处引用');
    expect(p).toContain('波及');
  });

  it('清单完整时保留封闭世界那句（这一句只在完整时才成立）', () => {
    expect(flowPrompt(req, 'evaluate', SURFACES)).toContain('不要假设清单之外还有页面');
  });

  /** C1：不完整时**必须**撤掉封闭世界那句，并说明原因。 */
  it('清单不完整时撤掉「不要假设清单之外还有页面」，改成「本清单不完整」＋原因', () => {
    const partial: KnownSurfaces = {
      surfaces: SURFACES.surfaces, total: 60, complete: false,
      note: '本清单只覆盖 123pan-pc；123pan-uni-app 的组件轮廓没读到（可能还没按新口径重解析）；页面数超过上限，只列了前 40 个（共 60 个）',
    };
    const p = flowPrompt(req, 'evaluate', partial);
    expect(p).not.toContain('不要假设清单之外还有页面');
    expect(p).toContain('不完整');
    // 「共 N 个」必须是截断前的真数，且说清只列了几个
    expect(p).toContain('共 60 个');
    expect(p).toContain('本次只列出前 1 个');
    // 原因要进提示词，否则模型只知道「不完整」，不知道为什么
    expect(p).toContain('123pan-uni-app 的组件轮廓没读到');
    // 但清单里的页面仍然不许标新增（这一句在两种情况下都真）
    expect(p).toContain('不要把清单里的页面标成新增');
  });

  it('没有索引时不写这段（不能凭空说"现有页面上什么都没有"）', () => {
    const p = flowPrompt(req, 'evaluate', EMPTY_SURFACES);
    expect(p).not.toContain('现有页面');
    expect(p).not.toContain('新增页面');
    expect(p).not.toContain('代码索引');
  });

  it('修图提示词也要带着：改过的图不能把标注丢了', () => {
    const p = repairPrompt(req, 'evaluate', {
      mermaid: 'flowchart TD\n A["x"] --> B["y"]',
      check: { ok: false, crossings: 1, overlaps: 0, textOverflow: 0, warnings: [], report: null } as FlowCheck,
      shape: { nodes: [{ id: 'A', label: 'x', kind: 'process' }, { id: 'B', label: 'y', kind: 'process' }], edges: 1 },
    }, SURFACES);
    expect(p).toContain('/pages/share/index');
    expect(p).toContain('现有页面');
  });
});

describe('fragmentsPrompt 带现有页面', () => {
  const nodes: FlowNode[] = [
    { id: 'A', label: '分享页', kind: 'process' },
    { id: 'B', label: '是否登录？', kind: 'decision' },
    { id: 'C', label: '提交', kind: 'process' },
  ];

  it('标着「现有页面」的节点，title 里那行标注原样保留', () => {
    const p = fragmentsPrompt(req, 'evaluate', nodes, SURFACES);
    expect(p).toContain('/pages/share/index');
    expect(p).toContain('现有页面');
    expect(p).toContain('原样保留');
    expect(p).toContain('被 3 处引用');
  });

  it('没有索引时一个字都不提', () => {
    const p = fragmentsPrompt(req, 'evaluate', nodes, EMPTY_SURFACES);
    expect(p).not.toContain('现有页面');
  });

  it('清单不完整时片段那一路也不说「清单之外的页面不要画」', () => {
    const p = fragmentsPrompt(req, 'evaluate', nodes, {
      ...SURFACES, complete: false, note: '本清单只覆盖 123pan-pc',
    });
    expect(p).not.toContain('清单之外的页面不要画');
    expect(p).toContain('不确定');
  });
});

// ─── 3. 读索引（镜像读不到就整段不写） ──────────────────────────────────────

function built(index: unknown): MirrorResult<BuiltIndex> {
  return { ok: true, data: { index: index as never, built: false, buildMs: 0 } };
}

const UNI_INDEX = {
  pages: [{ route: '/pages/share/index', title: '分享页', source: 'pages.json' }],
  files: { 'src/pages/share/index.vue': 'x' },
  outline: { 'src/pages/share/index.vue': [{ kind: 'component-use', name: 'FileList', line: 4 }] },
  imports: {}, routes: [], importedBy: { 'src/pages/share/index.vue': ['src/pages/fav/index.vue'] },
};

const PC_INDEX = {
  pages: [{ route: '/login', title: null, source: 'router' }],
  files: { 'src/pages/Login/login.tsx': 'y' },
  outline: { 'src/pages/Login/login.tsx': [{ kind: 'component-use', name: 'LoginForm', line: 2 }] },
  imports: {}, routes: [], importedBy: {},
};

const OK_HEAD = async () => ({
  ok: true, data: { sha: 'a'.repeat(40), date: '2026-11-01T00:00:00+08:00', subject: 'x' },
}) as never;

describe('loadKnownSurfaces', () => {
  it('把仓里的页面拼成一份清单，顺序 = 仓的顺序，两仓都读到才 complete', async () => {
    const s = await loadKnownSurfaces(db, {
      head: OK_HEAD,
      repoIndex: async (_db, repo) => built(repo === '123pan-uni-app' ? UNI_INDEX : PC_INDEX),
    });
    expect(s.surfaces.map((x) => x.route)).toEqual(['/pages/share/index', '/login']);
    expect(s.total).toBe(2);
    expect(s.complete).toBe(true);
    expect(s.note).toBeNull();
  });

  it('任何一个仓读不到 → 整段不写（半个清单比没有清单更坏）', async () => {
    const s = await loadKnownSurfaces(db, {
      head: async (repo) => (repo === '123pan-uni-app'
        ? ({ ok: false, code: 'bad_config', message: '镜像连不上' } as never)
        : OK_HEAD()),
      repoIndex: async () => built(UNI_INDEX),
    });
    expect(s).toEqual(EMPTY_SURFACES);
  });

  it('第二个仓失败也要整段不写：不能交一份「只有 uni-app」的清单', async () => {
    let n = 0;
    const s = await loadKnownSurfaces(db, {
      head: OK_HEAD,
      repoIndex: async () => {
        n += 1;
        return n === 1 ? built(UNI_INDEX) : ({ ok: false, code: 'bad_path', message: '建索引失败' } as never);
      },
    });
    expect(s).toEqual(EMPTY_SURFACES);
  });

  /**
   * C1 第 3 条 / I5：整仓轮廓为空（0032 之前索引过的仓就是这一格）→ 这一仓按「没读到」
   * 处理：它的页面不进清单，`complete` 变 false，原因写进 `note`。绝不写「每页都没读到组件」。
   */
  it('一个仓的轮廓整仓为空 → 这一仓的页面不进清单，complete=false 并写明原因', async () => {
    const legacyPc = { ...PC_INDEX, outline: {} };
    const s = await loadKnownSurfaces(db, {
      head: OK_HEAD,
      repoIndex: async (_db, repo) => built(repo === '123pan-uni-app' ? UNI_INDEX : legacyPc),
    });
    expect(s.surfaces.map((x) => x.route)).toEqual(['/pages/share/index']);
    expect(s.complete).toBe(false);
    expect(s.note).toContain('123pan-pc');
    expect(s.note).toContain('组件轮廓没读到');
    // 真页面数仍然算上被跳过那一仓的页：它存在，只是没读到
    expect(s.total).toBe(2);
  });

  it('被跳过的仓在提示词里留下「只覆盖」而不是「共 1 个」的口吻', async () => {
    const legacyPc = { ...PC_INDEX, outline: {} };
    const s = await loadKnownSurfaces(db, {
      head: OK_HEAD,
      repoIndex: async (_db, repo) => built(repo === '123pan-uni-app' ? UNI_INDEX : legacyPc),
    });
    const p = flowPrompt(req, 'evaluate', s);
    expect(p).not.toContain('不要假设清单之外还有页面');
    expect(p).toContain('本清单只覆盖 123pan-uni-app');
    expect(p).toContain('共 2 个');
  });
});

// ─── 4. 装配：composeEvaluation 真的把清单传了进去 ──────────────────────────

const GOOD_FLOW = `flowchart TD
  A["进入寄养频道"] --> B{"是否登录？"}
  B -->|是| C["选择宠物"]
  B -->|否| D["跳转登录"]
  C --> E["提交订单"]
`;

const PHONE = [
  '<div class="wt-screen">',
  '  <div class="wt-statusbar"><span>9:41</span><span class="wt-sb-icons"></span></div>',
  '  <div class="wt-nav"><span class="wt-nav-title">寄养</span></div>',
  '  <div class="wt-body"><div class="wt-card"><div class="wt-li-title">最近的寄养门店</div></div></div>',
  '  <div class="wt-bottombar"><button class="wt-btn" onclick="goNode(\'E\')">提交</button></div>',
  '</div>',
].join('\n');

const WIDE = [
  '<div class="wt-browserbar"><i></i><i></i><i></i><span>门店后台 - 订单</span></div>',
  '<div class="wt-body"><table class="wt-table"><tr><th>订单号</th></tr><tr><td>PO-1</td></tr></table></div>',
].join('\n');

const PAGES_JSON = JSON.stringify({
  nodes: [
    { id: 'A', kind: 'page', frame: 'phone', title: '进入寄养频道', html: PHONE,
      anno: [['内容', '按距离列出可寄养门店'], ['操作', '点提交进入确认']],
      open: { req: [['失败怎么办', '提交失败时停在哪一屏']], dev: [['状态', '这一屏有几种状态']] }, },
    { id: 'B', kind: 'decision', title: '是否登录？',
      steps: [
        { from: '页面', to: '服务端', what: '提交当前登录状态' },
        { from: '服务端', to: '服务端', what: '判断这个用户有没有登录过' },
      ],
      anno: [['判定依据', '会话里有没有用户']] },
    { id: 'C', kind: 'page', frame: 'phone', title: '选择宠物', html: PHONE,
      anno: [['字段', '宠物（列表单选）'], ['空态', '没有宠物时引导去建档']] },
    { id: 'D', kind: 'page', frame: 'phone', title: '跳转登录', html: PHONE,
      anno: [['承接', '登录后回到本页']] },
    { id: 'E', kind: 'page', frame: 'wide', title: '提交订单', html: WIDE,
      anno: [['归属', '后台生成寄养单']] },
  ],
});

/** 四个依赖全部注入：一次网、一个 Python 都不发，钉的只是「提示词里有什么」。 */
function fakeDeps(prompts: string[], surfaces: () => Promise<KnownSurfaces>): Partial<ComposeDeps> {
  const replies = [GOOD_FLOW, PAGES_JSON];
  return {
    resolveConfig: async () => ({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' }),
    complete: async (_cfg: unknown, prompt: string) => {
      prompts.push(prompt);
      return {
        ok: true,
        text: replies[Math.min(prompts.length - 1, replies.length - 1)] ?? '',
        usage: { prompt: 10, completion: 5 },
      };
    },
    render: async () => ({
      ok: true, crossings: 0, overlaps: 0, textOverflow: 0, warnings: [], report: null,
      svg: '<svg data-flowspec="1"></svg>',
    }),
    build: async () => ({ ok: true, html: '<html><body>ok</body></html>', errors: [], warnings: [] }),
    loadSurfaces: surfaces,
  } as never;
}

// ─── 5. 评审那条链路的调用点也要传（`review.ts` 的 `buildFlow` / `buildPages`） ──

/**
 * 评审材料与评估材料用的是**同一份**清单。这一条钉的是「调用点没忘」：
 * `reviewRequirement` 里那两行参数一漏，评审就退回「每条需求都像新功能」——
 * 而全量测试照样全绿（提示词里少一段话，没有任何断言会响）。
 */
describe('reviewRequirement 也带现有页面', () => {
  it('图与页面片段两次调用都带清单', async () => {
    const prompts: string[] = [];
    const r = await createRequirement(db, '吕品', { ...BRIEF, title: '分享页搜索补齐', type: 'feature', requester: '孙建宏' });
    await db.execute(sql`
      update requirements set prd_url = 'https://doc.weixin.qq.com/doc/w3_testPRD'
       where id = ${r.id}`);
    const markdown = '分享页要有搜索入口。搜索结果为空时给提示。';

    const deps: Partial<ReviewDeps> = {
      ...fakeDeps(prompts, async () => SURFACES),
      latestSnapshot: async () => ({
        id: 's1', requirementId: r.id, url: 'https://doc.weixin.qq.com/doc/w3_testPRD',
        markdown, hash: 'h1', fetchedAt: new Date('2026-11-08T00:00:00+08:00'),
      }) as never,
      // 镜像读不到：评审照样出材料（`absent`），这一条用例只关心提示词里有什么
      head: async () => ({ ok: false, code: 'bad_config', message: '镜像没配' }) as never,
      expand: async () => null,
    } as never;

    // 三段回话：图 → 问题清单 → 页面片段
    const replies = [GOOD_FLOW, JSON.stringify({
      findings: [{ type: 'dead_end', node: 'C', quote: '分享页要有搜索入口。', why: '点了搜索没有结果页' }],
    }), PAGES_JSON];
    const counted: Partial<ReviewDeps> = {
      ...deps,
      complete: async (_cfg: unknown, prompt: string) => {
        prompts.push(prompt);
        return { ok: true, text: replies[Math.min(prompts.length - 1, replies.length - 1)] ?? '', usage: {} };
      },
    } as never;

    await reviewRequirement(db, '吕品', { requirementId: r.id }, counted);

    expect(prompts.length).toBeGreaterThanOrEqual(3);
    expect(prompts[0]).toContain('/pages/share/index');
    expect(prompts[2]).toContain('/pages/share/index');
  });
});

beforeEach(async () => {
  await resetDb();
  await seedPeople();
  await cleanArtifacts();
});

afterEach(async () => {
  await cleanArtifacts();
});

afterAll(async () => {
  await pool.end();
});

describe('composeEvaluation 把现有页面接进提示词', () => {
  /**
   * v1（2026-11-10）：评估**默认不读代码索引**（`FEATURE_EVALUATE_READS_CODE` 默认关）。
   * 这一组的三条因此分两种走法：
   * - 关着（v1 的样子）→ 即使读口交了清单，提示词里一个字都没有，而且读口**没被调用**；
   * - 打开（v1.1 的路，能力没删）→ 两次调用都带清单，与原来逐字一致。
   */
  const ENV = 'FEATURE_EVALUATE_READS_CODE';

  async function compose(prompts: string[], surfaces: () => Promise<KnownSurfaces>) {
    const r = await createRequirement(db, '吕品', { ...BRIEF, title: 'S3 协议支持', type: 'feature', requester: '孙建宏' });
    await composeEvaluation(db, '吕品', { requirementId: r.id, stage: 'evaluate' },
      fakeDeps(prompts, surfaces));
    return r;
  }

  it('v1 默认：评估不读代码——读口一次都不调，提示词里没有「现有页面」', async () => {
    const prompts: string[] = [];
    let calls = 0;
    await compose(prompts, async () => { calls += 1; return SURFACES; });

    expect(calls).toBe(0);
    expect(prompts).toHaveLength(2);
    for (const p of prompts) {
      expect(p).not.toContain('现有页面');
      expect(p).not.toContain('代码索引');
    }
    expect(await artifactCount()).toBe(1);
  });

  it('打开开关：两次调用都带清单（图那一次说「现有页面」，片段那一次保留标注）', async () => {
    process.env[ENV] = '1';
    try {
      const prompts: string[] = [];
      await compose(prompts, async () => SURFACES);

      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain('/pages/share/index');
      expect(prompts[1]).toContain('/pages/share/index');
      expect(await artifactCount()).toBe(1);
    } finally {
      delete process.env[ENV];
    }
  });

  it('没有清单（读索引失败 / 没配镜像）时提示词一个字都不提', async () => {
    process.env[ENV] = '1';
    try {
      const prompts: string[] = [];
      await compose(prompts, async () => { throw new Error('镜像连不上'); });

      expect(prompts).toHaveLength(2);
      for (const p of prompts) expect(p).not.toContain('现有页面');
      // 读索引失败不该让材料失败——它是上下文，不是结论
      expect(await artifactCount()).toBe(1);
    } finally {
      delete process.env[ENV];
    }
  });
});
