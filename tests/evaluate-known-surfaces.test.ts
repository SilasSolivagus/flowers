import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { knownSurfaces, type KnownSurface } from '../src/core/locate/copy.js';
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
import { cleanArtifacts } from './helpers/files.js';

/**
 * 任务 4：把「现有页面 + 组件」接进评估提示词。
 *
 * 这里钉的是**三层**，每层坏法的后果完全不同：
 * 1. `knownSurfaces`：索引里的页面怎么收成提示词能吃的形状。收错了（拿别页的文件、
 *    把 `tag` 占位当组件、重复列同一个组件）的后果不是格式问题——模型会据此说
 *    「这页已经有 X 了」，而那是材料里唯一会被 PM 当事实读的一句话。
 * 2. 提示词：有清单时要求「现有页面：<route>」/「新增页面」，**没有清单时一个字都不说**。
 *    后半句是硬约束：说「现有页面上什么都没有」比不说更坏，它把「没读索引」冒充成
 *    「读过了、确实没有」。
 * 3. 装配：`composeEvaluation` / `runJob` 真的把清单传进那两次调用。前两层绿而这一层
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

// ─── 1. 形状 ────────────────────────────────────────────────────────────────

describe('knownSurfaces', () => {
  it('把页面、标题、组件收成评估提示词能吃的形状', () => {
    const s = knownSurfaces({
      files: {}, imports: {}, routes: [], outline: {}, importedBy: {},
      pages: [{ route: '/pages/share/index', title: '分享页', source: 'pages.json' }],
    } as never);
    expect(s).toEqual([{ route: '/pages/share/index', title: '分享页', components: [] }]);
  });

  it('只认这一页的视图文件：同名的 .ts（apis/login.ts）不算这一页', () => {
    const s = knownSurfaces({
      pages: [{ route: '/login', title: null, source: 'router' }],
      files: {
        'src/pages/Login/login.tsx': 'x',
        'src/pages/Login/components/InputPassword/index.tsx': 'y',
        'src/apis/login.ts': 'z',
      },
      outline: {
        'src/pages/Login/login.tsx': [{ kind: 'component-use', name: 'LoginForm', line: 3 }],
        'src/pages/Login/components/InputPassword/index.tsx': [{ kind: 'component-use', name: 'MfyIcon', line: 25 }],
        'src/apis/login.ts': [{ kind: 'symbol', name: 'fetchAccountLogin', line: 9 }],
      },
      imports: {}, routes: [], importedBy: {},
    } as never);
    expect(s).toHaveLength(1);
    expect(s[0]!.components).toEqual(['LoginForm']);
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
    expect(s[0]!.components).toEqual(['Navigation', 'useHostStore']);
  });

  it('组件封顶 12 个、页面按 limit 截断（提示词不是仓库清单）', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ kind: 'component-use' as const, name: `C${i}`, line: i + 1 }));
    const s = knownSurfaces({
      pages: Array.from({ length: 5 }, (_, i) => ({ route: `/pages/p${i}/index`, title: null, source: 'pages.json' as const })),
      files: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`src/pages/p${i}/index.vue`, 'x'])),
      outline: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`src/pages/p${i}/index.vue`, many])),
      imports: {}, routes: [], importedBy: {},
    } as never, 3);
    expect(s).toHaveLength(3);
    expect(s[0]!.components).toHaveLength(12);
  });
});

// ─── 2. 提示词 ──────────────────────────────────────────────────────────────

const SURFACES: KnownSurface[] = [
  { route: '/pages/share/index', title: '分享页', components: ['SearchBar', 'FileList'] },
];

describe('flowPrompt 带现有页面', () => {
  it('提示词里出现页面清单，且要求区分现有/新增', () => {
    const p = flowPrompt(req, 'evaluate', SURFACES);
    expect(p).toContain('/pages/share/index');
    expect(p).toContain('现有页面');
    expect(p).toContain('新增页面');
    // 组件也要点名：材料说「这页已经有 FileList」时必须有据
    expect(p).toContain('FileList');
  });

  it('没有索引时不写这段（不能凭空说"现有页面上什么都没有"）', () => {
    const p = flowPrompt(req, 'evaluate', []);
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
  });

  it('没有索引时一个字都不提', () => {
    const p = fragmentsPrompt(req, 'evaluate', nodes, []);
    expect(p).not.toContain('现有页面');
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
  imports: {}, routes: [], importedBy: {},
};

describe('loadKnownSurfaces', () => {
  it('把仓里的页面拼成一份清单，顺序 = 仓的顺序', async () => {
    const s = await loadKnownSurfaces(db, {
      head: async () => ({ ok: true, data: { sha: 'a'.repeat(40), date: '2026-11-01T00:00:00+08:00', subject: 'x' } }) as never,
      repoIndex: async (_db, repo) => built(repo === '123pan-uni-app' ? UNI_INDEX : {
        pages: [{ route: '/login', title: null, source: 'router' }],
        files: { 'src/pages/Login/login.tsx': 'y' },
        outline: { 'src/pages/Login/login.tsx': [{ kind: 'component-use', name: 'LoginForm', line: 2 }] },
        imports: {}, routes: [], importedBy: {},
      }),
    });
    expect(s.map((x) => x.route)).toEqual(['/pages/share/index', '/login']);
  });

  it('任何一个仓读不到 → 整段不写（半个清单比没有清单更坏）', async () => {
    const s = await loadKnownSurfaces(db, {
      head: async (repo) => (repo === '123pan-uni-app'
        ? ({ ok: false, code: 'bad_config', message: '镜像连不上' } as never)
        : ({ ok: true, data: { sha: 'c'.repeat(40), date: '2026-11-01T00:00:00+08:00', subject: 'x' } } as never)),
      repoIndex: async () => built(UNI_INDEX),
    });
    expect(s).toEqual([]);
  });

  it('第二个仓失败也要整段不写：不能交一份「只有 uni-app」的清单', async () => {
    let n = 0;
    const s = await loadKnownSurfaces(db, {
      head: async () => ({ ok: true, data: { sha: 'b'.repeat(40), date: '2026-11-01T00:00:00+08:00', subject: 'x' } }) as never,
      repoIndex: async () => {
        n += 1;
        return n === 1 ? built(UNI_INDEX) : ({ ok: false, code: 'bad_path', message: '建索引失败' } as never);
      },
    });
    expect(s).toEqual([]);
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
      anno: [['内容', '按距离列出可寄养门店'], ['操作', '点提交进入确认']] },
    { id: 'B', kind: 'decision', title: '是否登录？', anno: [['判定依据', '会话里有没有用户']] },
    { id: 'C', kind: 'page', frame: 'phone', title: '选择宠物', html: PHONE,
      anno: [['字段', '宠物（列表单选）'], ['空态', '没有宠物时引导去建档']] },
    { id: 'D', kind: 'page', frame: 'phone', title: '跳转登录', html: PHONE,
      anno: [['承接', '登录后回到本页']] },
    { id: 'E', kind: 'page', frame: 'wide', title: '提交订单', html: WIDE,
      anno: [['归属', '后台生成寄养单']] },
  ],
});

/** 四个依赖全部注入：一次网、一个 Python 都不发，钉的只是「提示词里有什么」。 */
function fakeDeps(prompts: string[], surfaces: () => Promise<KnownSurface[]>): Partial<ComposeDeps> {
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
    const r = await createRequirement(db, '吕品', { title: '分享页搜索补齐', type: 'feature', requester: '孙建宏' });
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
  it('两次调用都带清单：图那一次说「现有页面」，片段那一次保留标注', async () => {
    const prompts: string[] = [];
    const r = await createRequirement(db, '吕品', { title: 'S3 协议支持', type: 'feature', requester: '孙建宏' });
    await composeEvaluation(db, '吕品', { requirementId: r.id, stage: 'evaluate' },
      fakeDeps(prompts, async () => SURFACES));

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('/pages/share/index');
    expect(prompts[1]).toContain('/pages/share/index');
    expect(await artifactCount()).toBe(1);
  });

  it('没有清单（读索引失败 / 没配镜像）时提示词一个字都不提', async () => {
    const prompts: string[] = [];
    const r = await createRequirement(db, '吕品', { title: 'S3 协议支持', type: 'feature', requester: '孙建宏' });
    await composeEvaluation(db, '吕品', { requirementId: r.id, stage: 'evaluate' },
      fakeDeps(prompts, async () => { throw new Error('镜像连不上'); }));

    expect(prompts).toHaveLength(2);
    for (const p of prompts) expect(p).not.toContain('现有页面');
    // 读索引失败不该让材料失败——它是上下文，不是结论
    expect(await artifactCount()).toBe(1);
  });
});
