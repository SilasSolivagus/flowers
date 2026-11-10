import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { AppError } from '../src/core/errors.js';
import { composeEvaluation } from '../src/core/uemaster/compose.js';
import { resolveProviderConfig } from '../src/core/uemaster/provider.js';
import { resolveStrategy, runJob } from '../src/core/uemaster/start.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { BRIEF } from './helpers/brief.js';
import { artifactExists, cleanArtifacts, siteFile } from './helpers/files.js';

/**
 * P2.10 / B 路线：一个对话模型 + vendored 排版器 → 一份**查过**的评估材料。
 *
 * 这一组用例里**没有一件事是 mock 的**，除了「谁来回话」：
 * - 图是**真的** `vendor/uemaster/flow-canvas/scripts/flowlayout.py` 排的（~130ms 一次），
 *   所以「引擎说合格」「引擎说重叠」都是引擎自己说的，不是我们假装它说的；
 * - provider 是一个真的 `http.createServer`（`127.0.0.1:0`），走真的 `fetch`、
 *   真的 `provider.complete`；它只是按脚本返回事先写好的文字；
 * - 库与文件系统也是真的。
 *
 * 要证明的六件事（外加两条管线接线）：
 * 1. 一次就过的快乐路径：产物落盘、attach、页面上有节点文案、SVG 内联、`attempts === 1`；
 * 2. 形状太小（2 节点 1 连线，引擎却会判合格）→ 修一次就过，而且**修图提示词里真的有
 *    节点数与连线数**；
 * 3. 引擎真的拒绝（重叠）→ 修一次就过，提示词里带着引擎原文与重叠点；
 * 4. 三次都画不对 → 失败，消息里是**最后一句引擎错误**，库里没有产物行、磁盘上没有文件；
 * 5. 没配模型接口 → 失败，消息里点名缺的那几个环境变量；
 * 6. 页面说明两次都不合法 → 失败，没有文件；
 * 7. 管线接线：配了 provider 时 `runJob` 不需要任何 CLI，作业形状不变
 *    （done + artifact_id + inbox → 待设计）；`resolveStrategy` 的规则是「只看配没配」。
 */

// ─── 一个真的 provider（按脚本回话） ────────────────────────────────────────

type Scripted = { status: number; body: string };

type Fake = {
  baseUrl: string;
  /** 每次请求带来的 prompt，按顺序。 */
  prompts: string[];
  enqueue: (...texts: string[]) => void;
  enqueueError: (status: number, message: string) => void;
  close: () => Promise<void>;
};

/** 一份 OpenAI 兼容的 chat 补全响应。 */
function chatBody(content: string): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 120, completion_tokens: 45 },
  });
}

async function startFake(): Promise<Fake> {
  const queue: Scripted[] = [];
  const prompts: string[] = [];

  const server: Server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      let prompt = '';
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
        prompt = parsed.messages?.[0]?.content ?? '';
      } catch {
        prompt = '';
      }
      prompts.push(prompt);
      const next = queue.shift();
      // 脚本用完了还来问：这不是「模型抽风」，是**用例写错了**，要让消息一眼能看出来。
      const answer: Scripted = next ?? {
        status: 500,
        body: JSON.stringify({ error: { message: `用例脚本里没有更多回话（第 ${prompts.length} 次调用）` } }),
      };
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(answer.body);
    });
  });

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    prompts,
    enqueue: (...texts: string[]) => {
      for (const text of texts) queue.push({ status: 200, body: chatBody(text) });
    },
    enqueueError: (status: number, message: string) => {
      queue.push({ status, body: JSON.stringify({ error: { message } }) });
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

// ─── 夹具 ────────────────────────────────────────────────────────────────────

/** 一份 5 节点图：主干 A→B→C→E，B 一条右分支到 D。引擎实测三个计数全 0。 */
const GOOD_FLOW = `flowchart TD
  A["进入寄养频道"] --> B{"是否登录？"}
  B -->|是| C["选择宠物"]
  B -->|否| D["跳转登录"]
  C --> E["提交订单"]
`;

/** 2 节点 1 连线：语法完全合法，引擎也判合格（计数全 0）——形状太小才是它的问题。 */
const SMALL_FLOW = `flowchart TD
  A["开始"] --> B["结束"]
`;

/**
 * 一份**重叠**的图：同一个判断节点挂了三条出边（是/否/游客），引擎实测 `overlaps: 1`
 * （重叠点是 D 与 H）。这是「引擎拒绝」这一路的真实素材，不是构造出来的假计数。
 */
const OVERLAP_FLOW = `flowchart TD
  A["进入寄养频道"] --> B{"是否登录？"}
  B -->|是| C["选择宠物"]
  B -->|否| D["跳转登录"]
  D --> C
  C --> E{"宠物是否已建档？"}
  E -->|是| F["提交订单"]
  E -->|否| G["新建宠物档案"]
  G --> F
  B -->|游客| H["浏览列表"]
  H --> F
`;

/** 一座孤岛：引擎认不出「单主干」，非零退出。节点 4、连线 2，但形状判据过得去。 */
const ISLAND_FLOW = `flowchart TD
  A["开始"] --> B["结束"]
  X["孤岛一"] --> Y["孤岛二"]
`;

/**
 * 与 GOOD_FLOW 的 5 个节点一一对应的页面片段。
 *
 * 这是**上游契约**的输入，不是我们发明的 JSON：`kind=page` 交一屏 `wt-*` 标记的 HTML，
 * `kind=decision` 只交标注（判断节点没有页面）。HTML 里的 `onclick="goNode('E')"`
 * 是契约里的联动 API，构建器会把它们接到左侧流程图上。
 */
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

/** 一条收集里的需求（无 PRD、类型齐全）：评估这条路走得通。 */
async function inbox() {
  return createRequirement(db, '吕品', { ...BRIEF, title: 'S3 协议支持', type: 'feature', requester: '孙建宏' });
}

/** 抓服务抛出来的错误：instance + code + message 都要对得上。 */
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

async function requirementState(id: string): Promise<string> {
  const res = await db.execute<{ state: string }>(sql`select state from requirements where id = ${id}`);
  return res.rows[0]!.state;
}

// ─── 环境 ────────────────────────────────────────────────────────────────────

let fake: Fake | null = null;

async function useFake(): Promise<Fake> {
  fake = await startFake();
  process.env.FLOWERS_PROVIDER_BASE_URL = fake.baseUrl;
  process.env.FLOWERS_PROVIDER_API_KEY = 'sk-compose-test';
  process.env.FLOWERS_PROVIDER_MODEL = 'cheap-model';
  return fake;
}

function clearEnv(): void {
  delete process.env.FLOWERS_PROVIDER_BASE_URL;
  delete process.env.FLOWERS_PROVIDER_API_KEY;
  delete process.env.FLOWERS_PROVIDER_MODEL;
}

beforeEach(async () => {
  await resetDb();
  await seedPeople();
  await cleanArtifacts();
  // 这一组用例只走 provider 这条路：CLI 的环境变量必须干净，否则「走哪条路」这件事
  // 会被一个残留变量改写。
  delete process.env.FLOWERS_GEN_CMD;
  clearEnv();
});

afterEach(async () => {
  clearEnv();
  if (fake !== null) {
    await fake.close();
    fake = null;
  }
});

afterAll(async () => {
  clearEnv();
  await cleanArtifacts();
  await pool.end();
});

// ─── 用例 ────────────────────────────────────────────────────────────────────

describe('composeEvaluation', () => {
  it('快乐路径：一次图 + 一次页面说明 → 产物落盘、attach、attempts=1', async () => {
    const provider = await useFake();
    const r = await inbox();
    provider.enqueue(GOOD_FLOW, PAGES_JSON);

    const out = await composeEvaluation(db, '吕品', { requirementId: r.id, stage: 'evaluate' });

    // 版本化文件名（2026-11-10）：第一版是 v001。
    const url = `/uemaster/PAN-${r.number}/evaluate-v001.html`;
    expect(out.url).toBe(url);
    expect(out.attempts).toBe(1);
    // 两次调用都带回了 token 用量（服务端给了 usage，我们只负责相加）。
    expect(out.usage.prompt).toBe(240);
    expect(out.usage.completion).toBe(90);

    expect(await artifactExists(url)).toBe(true);
    expect(await artifactCount()).toBe(1);
    // 2026-11-10 起那条规矩**不在了**：材料落地不改状态（材料是产物，立项是决定）。
    expect(await requirementState(r.id)).toBe('inbox');

    const html = await readFile(siteFile(url), 'utf8');
    // 1) 引擎的 SVG 是**内联**进文档的（不是 <img>，不是外链）
    expect(html).toContain('<svg id="flowsvg"');
    expect(html).toContain('data-flowspec="1"');
    // 2) 五个节点的文案都在（SVG 里 + 构建器的节点映射 JSON 里）
    for (const label of ['进入寄养频道', '是否登录？', '选择宠物', '跳转登录', '提交订单']) {
      expect(html).toContain(label);
    }
    // 3) 材料里只有标注才有的内容——标注来自提示词 2，页面来自 `wt-*` 片段
    expect(html).toContain('宠物（列表单选）');
    expect(html).toContain('没有宠物时引导去建档');
    // 4) 三栏骨架是 **build.py 的**：流程画布 / 设备框 / 标注面板 + 页面 div
    expect(html).toContain('class="flow-panel"');
    expect(html).toContain('id="flow-svg-light"');
    expect(html).toContain('id="frame-phone"');
    expect(html).toContain('class="page" id="p-A"');
    expect(html).toContain('wt-bottombar');
    expect(html).toContain('id="state-card"');
    // 5) 自足：没有外部资源
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);

    // 提示词 1 里带着需求本身与子集规则（模型读不到文件，规则只能写在提示里）
    expect(provider.prompts[0]).toContain('PAN-');
    expect(provider.prompts[0]).toContain('flowchart TD');
    expect(provider.prompts[0]).toContain('单主干');
    expect(provider.prompts[0]).toContain('subgraph');
    // 提示词 2 带着**已定稿**的节点清单与 page-guide 的关键规则
    expect(provider.prompts[1]).toContain('A  [页面]  进入寄养频道');
    expect(provider.prompts[1]).toContain('B  [判断]  是否登录？');
    expect(provider.prompts[1]).toContain('wt-screen');
    expect(provider.prompts[1]).toContain('375px');
  });

  it('形状太小 → 修一次；修图提示词里写着节点数与连线数', async () => {
    const provider = await useFake();
    const r = await inbox();
    // 第一版是 2 节点 1 连线的碎片：引擎会说「合格」（计数全 0），形状判据必须驳回它。
    provider.enqueue(SMALL_FLOW, GOOD_FLOW, PAGES_JSON);

    const out = await composeEvaluation(db, '吕品', { requirementId: r.id, stage: 'evaluate' });

    expect(out.attempts).toBe(2);
    expect(await artifactExists(out.url)).toBe(true);

    // 第 2 次调用就是修图提示词：它必须说清「上一版有几个节点几条线」。
    const repair = provider.prompts[1]!;
    expect(repair).toContain('2 个节点');
    expect(repair).toContain('1 条连线');
    expect(repair).toContain('要求是 3–8 个节点');
    // 也要带上上一版原文，模型才知道改哪一份
    expect(repair).toContain('A["开始"] --> B["结束"]');
  });

  it('引擎拒绝（重叠）→ 修一次；提示词里带着引擎原文与重叠点', async () => {
    const provider = await useFake();
    const r = await inbox();
    provider.enqueue(OVERLAP_FLOW, GOOD_FLOW, PAGES_JSON);

    const out = await composeEvaluation(db, '吕品', { requirementId: r.id, stage: 'evaluate' });

    expect(out.attempts).toBe(2);
    const repair = provider.prompts[1]!;
    // 引擎原文（带计数）
    expect(repair).toContain('重叠 1');
    // 报告里的定位（`overlap_points`）：这一点是从 `--check` 补跑里捞回来的
    expect(repair).toContain('引擎给的位置');
    expect(repair).toContain('重叠点');
    // 「改简单」的方向必须写出来，否则模型只会把图改得更复杂
    expect(repair).toContain('把图变简单');
  });

  it('三次都不对 → 失败；消息里是最后一句引擎错误，且不留产物', async () => {
    const provider = await useFake();
    const r = await inbox();
    // 孤岛：引擎直接拒绝（「单主干」），三次都一样
    provider.enqueue(ISLAND_FLOW, ISLAND_FLOW, ISLAND_FLOW);

    const error = await caught(composeEvaluation(db, '吕品', { requirementId: r.id, stage: 'evaluate' }));

    expect(error.code).toBe('flow_rejected');
    expect(error.message).toContain('3 次');
    expect(error.message).toContain('单主干');
    // 三次都问了，但**没有**第 4 次：上限是硬的
    expect(provider.prompts).toHaveLength(3);
    expect(await artifactCount()).toBe(0);
    expect(await artifactExists(`/uemaster/PAN-${r.number}/evaluate-v001.html`)).toBe(false);
    // 需求还在原地（没有材料 = 没有通行证）
    expect(await requirementState(r.id)).toBe('inbox');
  });

  it('没配模型接口 → 失败，消息点名缺哪几个设置', async () => {
    // 这一条**不**起 fake，也不设 env；`resetDb` 已经清掉了 app_settings 里的三格。
    const r = await inbox();
    expect(await resolveProviderConfig()).toBeNull();

    const error = await caught(composeEvaluation(db, '吕品', { requirementId: r.id, stage: 'evaluate' }));

    expect(error.code).toBe('provider_unconfigured');
    expect(error.message).toContain('FLOWERS_PROVIDER_BASE_URL');
    expect(error.message).toContain('FLOWERS_PROVIDER_API_KEY');
    expect(error.message).toContain('FLOWERS_PROVIDER_MODEL');
    expect(await artifactCount()).toBe(0);
  });

  it('接口报错 → 原文带回（不改写成「请求失败」）', async () => {
    const provider = await useFake();
    const r = await inbox();
    provider.enqueueError(400, '分组 auto 下模型 x 的可用渠道不存在');

    const error = await caught(composeEvaluation(db, '吕品', { requirementId: r.id, stage: 'evaluate' }));

    expect(error.code).toBe('provider_error');
    expect(error.message).toContain('分组 auto 下模型 x 的可用渠道不存在');
  });

  it('页面片段两次都不合法 → 失败，不留文件', async () => {
    const provider = await useFake();
    const r = await inbox();
    provider.enqueue(
      GOOD_FLOW,
      '好的，我先说结论：这一步是一个页面。（没有一个 JSON 对象）',
      // 结构合法、但只写了 A 一个节点：zod 过，覆盖率不过——这才是「少节点」那条路
      JSON.stringify({ nodes: [
        { id: 'A', kind: 'page', frame: 'phone', title: '进入寄养频道',
          html: '<div class="wt-screen"><div class="wt-body">x</div></div>', anno: [] },
      ] }),
    );

    const error = await caught(composeEvaluation(db, '吕品', { requirementId: r.id, stage: 'evaluate' }));

    expect(error.code).toBe('pages_rejected');
    // 第二次失败的原因是「少节点」：A 之外全缺
    expect(error.message).toContain('没有页面片段');
    expect(await artifactCount()).toBe(0);
    expect(await artifactExists(`/uemaster/PAN-${r.number}/evaluate-v001.html`)).toBe(false);
    // 图那一关只花了一次；页面说明问了两遍
    expect(provider.prompts).toHaveLength(3);
  });
});

describe('策略与作业管线', () => {
  it('resolveStrategy：配了 provider 就 provider，没配就 cli（只看配没配）', async () => {
    expect((await resolveStrategy()).kind).toBe('cli');

    await useFake();
    const strategy = await resolveStrategy();
    expect(strategy.kind).toBe('provider');
    if (strategy.kind === 'provider') {
      expect(strategy.config.model).toBe('cheap-model');
    }
  });

  it('runJob 走 provider：不需要任何 CLI，作业形状不变（done + artifact_id + 待设计）', async () => {
    const provider = await useFake();
    const r = await inbox();
    provider.enqueue(GOOD_FLOW, PAGES_JSON);

    const job = await db.execute<{ id: string }>(sql`
      insert into uemaster_jobs (requirement_id, stage, status)
      values (${r.id}, 'evaluate', 'running') returning id`);
    const jobId = job.rows[0]!.id;
    const url = `/uemaster/PAN-${r.number}/evaluate-v001.html`;

    await runJob(db, jobId, { actor: '吕品' });

    const row = await db.execute<{ status: string; error: string | null; artifact_id: string | null }>(sql`
      select status, error, artifact_id from uemaster_jobs where id = ${jobId}`);
    expect(row.rows[0]!.status).toBe('done');
    expect(row.rows[0]!.error).toBeNull();
    expect(row.rows[0]!.artifact_id).not.toBeNull();
    expect(await artifactExists(url)).toBe(true);
    // 2026-11-10 起生成不改状态（材料是产物，立项是决定）。
    expect(await requirementState(r.id)).toBe('inbox');
    // 一个 key、零 CLI：两次模型调用就是全部劳动
    expect(provider.prompts).toHaveLength(2);
  });

  it('runJob 失败：作业收成 failed，错误就是那句中文原因', async () => {
    const provider = await useFake();
    const r = await inbox();
    provider.enqueue(ISLAND_FLOW, ISLAND_FLOW, ISLAND_FLOW);

    const job = await db.execute<{ id: string }>(sql`
      insert into uemaster_jobs (requirement_id, stage, status)
      values (${r.id}, 'evaluate', 'running') returning id`);
    const jobId = job.rows[0]!.id;

    await runJob(db, jobId, { actor: '吕品' });

    const row = await db.execute<{ status: string; error: string | null; artifact_id: string | null }>(sql`
      select status, error, artifact_id from uemaster_jobs where id = ${jobId}`);
    expect(row.rows[0]!.status).toBe('failed');
    expect(row.rows[0]!.artifact_id).toBeNull();
    expect(row.rows[0]!.error).toContain('单主干');
    expect(await requirementState(r.id)).toBe('inbox');
  });
});
