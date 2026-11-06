import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { AppError } from '../src/core/errors.js';
import { saveSnapshot } from '../src/core/prd/snapshots.js';
import type { PrdReadResult } from '../src/core/prd/read.js';
import {
  findingsAnno, listCounts, readFindings, normalizeQuote, quoteInPrd, reviewRequirement, reviewTitle,
  type ReviewDeps,
} from '../src/core/uemaster/review.js';
import { runJob } from '../src/core/uemaster/start.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { artifactExists, cleanArtifacts, siteFile } from './helpers/files.js';

/**
 * P3.6 评审材料：**读过 PRD** 的评审，产出问题清单。
 *
 * 这一组和 `compose.test.ts` 同一个路子：除了「谁来回话」，没有一件事是 mock 的——
 * 图是真的 `flowlayout.py` 排的，HTML 是真的 `build.py` 出的，库与磁盘也是真的。
 *
 * 要证明的六件事（每一条都对应一次真实的坏法）：
 * 1. 快乐路径：3 条问题全部有据 → 产物落盘、标题带 PRD 版本与分布、右栏是那三条；
 * 2. **编出来的引文被丢掉**，而且修复提示词点名了那一句（这是这份材料唯一的事实底线）；
 * 3. 挂在流程图之外的节点被丢掉（`dropUnknownNodes` 的同一条理由）；
 * 4. 一条都不剩 → 失败，且不留产物行（空清单不是通过，是没做）；
 * 5. 没有快照 → 先 `readPrd`；有快照 → 不再读；
 * 6. 没有 `prd_url` → 一句点名它的中文，且一次模型调用都不发。
 *
 * 另外两条纯函数的用例（`readFindings` / `normalizeQuote`）也在这里：它们是「引文必须
 * 逐字」这条规则的**执行体**，写得对不对不该只靠一次端到端跑。
 */

// ─── 一个真的 provider（按脚本回话） ────────────────────────────────────────

type Scripted = { status: number; body: string };

type Fake = {
  baseUrl: string;
  prompts: string[];
  enqueue: (...texts: string[]) => void;
  close: () => Promise<void>;
};

function chatBody(content: string): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 100, completion_tokens: 40 },
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
      // 脚本用完还来问：不是「模型抽风」，是**用例写错了**，消息要一眼看得出来。
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
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

// ─── 夹具 ────────────────────────────────────────────────────────────────────

/** 与 `compose.test.ts` 同一份 5 节点图：主干 A→B→C→E，B 一条右分支到 D。 */
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

/**
 * 与 GOOD_FLOW 一一对应的页面片段。
 *
 * `anno` 故意写成占位内容：评审这条路上，右栏标注由**问题清单**改写（`findingsAnno`），
 * 模型自己写的标注会被整片换掉。这里留着它是为了证明「换掉」这件事真的发生了。
 */
const PAGES_JSON = JSON.stringify({
  nodes: [
    { id: 'A', kind: 'page', frame: 'phone', title: '进入寄养频道', html: PHONE,
      anno: [['内容', '模型自己写的标注会被换掉']] },
    { id: 'B', kind: 'decision', title: '是否登录？',
      anno: [['判定依据', '模型自己写的标注会被换掉']] },
    { id: 'C', kind: 'page', frame: 'phone', title: '选择宠物', html: PHONE,
      anno: [['字段', '模型自己写的标注会被换掉']] },
    { id: 'D', kind: 'page', frame: 'phone', title: '跳转登录', html: PHONE,
      anno: [['承接', '模型自己写的标注会被换掉']] },
    { id: 'E', kind: 'page', frame: 'wide', title: '提交订单', html: WIDE,
      anno: [['归属', '后台生成寄养单']] },
  ],
});

const PRD_TEXT = await readFile(new URL('./fixtures/prd-pan6.md', import.meta.url), 'utf8');

/** 三句**真实存在于** PRD 里的话，一句一类。 */
const QUOTE_DEAD_END = '有效分享页展示搜索入口；失效页不展示。';
const QUOTE_STATE = '最多保留 40 个字符；提交时去除首尾空格；纯空格不可搜索。';
const QUOTE_BOUND = '同一文件同一分享会话成功送审一次；前端会话去重，后端保持幂等。';

/** 一句**不在** PRD 里的话（模型编的那种：听起来完全合理）。 */
const QUOTE_FAKE = 'PRD 要求搜索历史跨会话同步';

function findingsJson(items: Array<Record<string, string>>): string {
  return JSON.stringify({ findings: items });
}

const THREE_FINDINGS = findingsJson([
  { type: 'dead_end', node: 'C', quote: QUOTE_DEAD_END, why: '进了选择宠物之后没有回退路径' },
  // 故意用中文标签而不是英文枚举：`normalizeFindingType` 要把它收回来
  { type: '缺状态', node: 'C', quote: QUOTE_STATE, why: '没有写输入被截断时的提示' },
  { type: 'unbounded', node: 'E', quote: QUOTE_BOUND, why: '重试次数与间隔没定' },
]);

// ─── 库与文件 ────────────────────────────────────────────────────────────────

/** 一条带 PRD 链接的需求 + 一版快照（评审的输入就是它）。 */
async function reviewable(markdown = PRD_TEXT) {
  const created = await createRequirement(db, '吕品', {
    title: '分享页搜索补齐 H5 / APP',
    type: 'feature',
    requester: '孙建宏',
  });
  await db.execute(sql`
    update requirements
       set prd_url = 'https://doc.weixin.qq.com/doc/w3_AW4A1gbtAKYCNrNKOiCOyR7ykQKyF'
     where id = ${created.id}`);
  const { snapshot } = await saveSnapshot(db, '吕品', {
    requirementId: created.id,
    url: 'https://doc.weixin.qq.com/doc/w3_AW4A1gbtAKYCNrNKOiCOyR7ykQKyF',
    markdown,
  });
  return { ...created, snapshot };
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

async function attemptsOf(jobId: string): Promise<Array<{ phase: string; error: string | null }>> {
  const res = await db.execute<{ phase: string; error: string | null }>(sql`
    select phase, error from uemaster_job_attempts where job_id = ${jobId} order by created_at, attempt, id`);
  return res.rows;
}

// ─── 环境 ────────────────────────────────────────────────────────────────────

let fake: Fake | null = null;

async function useFake(): Promise<Fake> {
  fake = await startFake();
  process.env.FLOWERS_PROVIDER_BASE_URL = fake.baseUrl;
  process.env.FLOWERS_PROVIDER_API_KEY = 'sk-review-test';
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

// ─── 纯函数：引文核对与右上标题 ─────────────────────────────────────────────

describe('readFindings / 引文核对', () => {
  it('归一化只放宽格式：空白、标点、markdown 强调符都不算差异', () => {
    expect(normalizeQuote('**全链接** 搜索')).toBe('全链接搜索');
    expect(normalizeQuote('「全部文件」　　不存在父目录')).toBe('全部文件不存在父目录');
    expect(quoteInPrd('根目录统一显示“全部文件”，不存在父目录。', PRD_TEXT)).toBe(true);
  });

  it('改写过的引文对不上：这是这份材料唯一的事实底线', () => {
    expect(quoteInPrd(QUOTE_FAKE, PRD_TEXT)).toBe(false);
    // 两句话拼成一句也是编的：前半句和后半句各自存在，拼起来不存在。
    expect(quoteInPrd('有效分享页展示搜索入口同一文件同一分享会话成功送审一次', PRD_TEXT)).toBe(false);
  });

  it('三条核对：类型收成六选一、节点必须在流程里、引文必须逐字存在', () => {
    const text = findingsJson([
      { type: '死路', node: 'C', quote: QUOTE_DEAD_END, why: 'w1' },
      { type: 'ambiguous', node: '节点 E', quote: QUOTE_STATE, why: 'w2' },
      { type: 'no_acceptance', node: 'Z', quote: QUOTE_BOUND, why: 'w3' },
      { type: 'missing_state', node: 'C', quote: QUOTE_FAKE, why: 'w4' },
    ]);

    const read = readFindings(text, ['A', 'B', 'C', 'D', 'E'], PRD_TEXT);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    // 1、2 活下来（中文标签与「节点 E」都被收回来了），3、4 被丢
    expect(read.findings.map((f) => `${f.type}@${f.node}`)).toEqual(['dead_end@C', 'ambiguous@E']);
    expect(read.dropped.map((d) => d.reason)).toEqual(['unknown_node', 'quote_not_found']);
    expect(read.dropped[0]!.detail).toContain('不在流程图里');
    expect(read.dropped[1]!.detail).toContain('在 PRD 里找不到');
  });

  it('没有 findings 数组 → 结构化失败（不是「零条问题」）', () => {
    const read = readFindings('{"issues":[]}', ['A'], PRD_TEXT);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.why).toContain('findings');
  });

  it('标题：版本 + 总数 + 按类型分布；没问题的节点也要有一行「无问题」', () => {
    const req = {
      id: 'x', number: 6, title: '分享页搜索', type: 'feature', requester: '吕品', prd_url: null,
      context: null, problem: null, outcome: null, surfaces: null, edge_cases: null, out_of_scope: null,
    };
    const findings = [
      { type: 'dead_end' as const, node: 'C', quote: QUOTE_DEAD_END, why: 'w' },
      { type: 'dead_end' as const, node: 'C', quote: QUOTE_STATE, why: 'w' },
      { type: 'missing_state' as const, node: 'C', quote: QUOTE_BOUND, why: 'w' },
    ];
    const title = reviewTitle(req, 'v1.4', findings);
    // 结尾多一段基线：没有镜像时写「未参考代码现状」——这一句要留在标题上。
    expect(title).toBe('PAN-6「分享页搜索」评审材料 · PRD v1.4 · 3 处：死路 2 / 缺状态 1 · 未参考代码现状');
    expect(listCounts(findings)).toEqual([['死路', 2], ['缺状态', 1]]);

    const rows = findingsAnno(findings.slice(0, 1));
    expect(rows[0]![0]).toBe('死路');
    expect(rows[0]![1]).toContain('——');
    expect(findingsAnno([])).toEqual([['无问题', '这一步没挑出问题']]);
  });
});

// ─── 端到端 ──────────────────────────────────────────────────────────────────

describe('reviewRequirement', () => {
  it('快乐路径：3 条有据的问题 → 产物落盘、标题带版本与分布、右栏就是那三条', async () => {
    const provider = await useFake();
    const r = await reviewable();
    provider.enqueue(GOOD_FLOW, THREE_FINDINGS, PAGES_JSON);

    const out = await reviewRequirement(db, '吕品', { requirementId: r.id });

    const url = `/uemaster/PAN-${r.number}/review.html`;
    expect(out.url).toBe(url);
    expect(await artifactExists(url)).toBe(true);
    expect(await artifactCount()).toBe(1);

    // 三次调用：图 / 问题清单 / 页面片段（一条都没丢 → 不修，省下第四次）
    expect(provider.prompts).toHaveLength(3);
    expect(out.stats.modelCalls).toBe(3);
    expect(out.stats.findingsKept).toBe(3);
    expect(out.stats.drops).toEqual([]);
    expect(out.stats.prdVersion).toBe('v1.4');

    // 提示词 2 里带着**全文 PRD**（评审的输入就是它，不是一个 URL）
    expect(provider.prompts[1]).toContain('PRD 正文（全文');
    expect(provider.prompts[1]).toContain('有效分享页展示搜索入口');
    expect(provider.prompts[1]).toContain('A  [页面]  进入寄养频道');
    expect(provider.prompts[1]).toContain('quote 必须是 PRD 原文里的一整句');

    const html = await readFile(siteFile(url), 'utf8');
    // 标题：版本 + 总数 + 分布（截图发出去之后唯一还带着上下文的字）
    expect(html).toContain('评审材料 · PRD v1.4 · 3 处：死路 1 / 缺状态 1 / 边界未定 1');
    // 右栏是那三条：类型中文 + 引文（截前 20 字）
    expect(html).toContain('死路');
    expect(html).toContain('——');
    expect(html).toContain([...QUOTE_DEAD_END].slice(0, 20).join(''));
    // 模型自己写的标注被换掉了（右栏的内容不是它写的）
    expect(html).not.toContain('模型自己写的标注会被换掉');
    // 没有问题的节点也有一行，读者不会把「没毛病」看成「漏了」
    expect(html).toContain('无问题');
    expect(html).toContain('这一步没挑出问题');
    // 版式还是 UEmaster 那一套三栏
    expect(html).toContain('<svg id="flowsvg"');
    expect(html).toContain('class="flow-panel"');
    expect(html).toContain('class="anno-panel"');

    // 评审不是通行证：attach(review) 不推进状态（只有 evaluate 会）
    const state = await db.execute<{ state: string }>(sql`select state from requirements where id = ${r.id}`);
    expect(state.rows[0]!.state).toBe('inbox');
  }, 60_000);

  it('编出来的引文被丢掉，修复提示词点名那一句并重新贴上 PRD', async () => {
    const provider = await useFake();
    const r = await reviewable();
    // 第 1 版：一句真的 + 一句编的；第 2 版只留真的；再交页面片段
    provider.enqueue(
      GOOD_FLOW,
      findingsJson([
        { type: 'dead_end', node: 'C', quote: QUOTE_DEAD_END, why: '进了选择宠物之后没有回退路径' },
        { type: 'missing_state', node: 'C', quote: QUOTE_FAKE, why: '历史跨会话同步没有状态定义' },
      ]),
      findingsJson([
        { type: 'dead_end', node: 'C', quote: QUOTE_DEAD_END, why: '进了选择宠物之后没有回退路径' },
      ]),
      PAGES_JSON,
    );

    const out = await reviewRequirement(db, '吕品', { requirementId: r.id });

    expect(provider.prompts).toHaveLength(4);
    expect(out.stats.findingsAttempts).toBe(2);
    // 材料里只剩有据的那一条
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.quote).toBe(QUOTE_DEAD_END);

    // 那一条被记下来了：留在结果里，也进了留痕
    const drop = out.stats.drops.find((d) => d.reason === 'quote_not_found');
    expect(drop).toBeDefined();
    expect(drop!.quote).toBe(QUOTE_FAKE);

    // 修复提示词：点名那一句 + 说清为什么错 + 重新贴一遍 PRD（不然它只能靠记忆重写）
    const repair = provider.prompts[2]!;
    expect(repair).toContain('在 PRD 里找不到');
    expect(repair).toContain(QUOTE_FAKE);
    expect(repair).toContain('逐字');
    expect(repair).toContain('有效分享页展示搜索入口');
    // 上一版原文也在里面（模型得知道改哪一份）
    expect(repair).toContain('历史跨会话同步没有状态定义');

    const html = await readFile(siteFile(out.url), 'utf8');
    expect(html).toContain('1 处：死路 1');
    expect(html).not.toContain(QUOTE_FAKE);
  }, 60_000);

  it('挂在流程图之外的节点被丢掉（与 dropUnknownNodes 同一个理由）', async () => {
    const provider = await useFake();
    const r = await reviewable();
    provider.enqueue(
      GOOD_FLOW,
      findingsJson([
        { type: 'ambiguous', node: 'Z', quote: QUOTE_STATE, why: '这一条挂不到任何节点上' },
        { type: 'no_acceptance', node: 'E', quote: QUOTE_BOUND, why: '送审重试次数没定' },
      ]),
      findingsJson([
        { type: 'no_acceptance', node: 'E', quote: QUOTE_BOUND, why: '送审重试次数没定' },
      ]),
      PAGES_JSON,
    );

    const out = await reviewRequirement(db, '吕品', { requirementId: r.id });

    const drop = out.stats.drops.find((d) => d.reason === 'unknown_node');
    expect(drop).toBeDefined();
    expect(drop!.node).toBe('Z');
    expect(provider.prompts[2]).toContain('节点「Z」不在流程图里');
    expect(provider.prompts[2]).toContain('流程图只有 A / B / C / D / E');

    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.node).toBe('E');
    const html = await readFile(siteFile(out.url), 'utf8');
    expect(html).toContain('缺验收口径');
    expect(html).not.toContain('这一条挂不到任何节点上');
  }, 60_000);

  it('一条都不剩 → 失败，且不留产物行（空清单不是通过，是没做）', async () => {
    const provider = await useFake();
    const r = await reviewable();
    const allFake = findingsJson([
      { type: 'dead_end', node: 'C', quote: QUOTE_FAKE, why: '编的' },
      { type: 'ambiguous', node: 'C', quote: 'PRD 没写清楚失败怎么重试', why: '也是编的' },
    ]);
    provider.enqueue(GOOD_FLOW, allFake, allFake);

    const error = await caught(reviewRequirement(db, '吕品', { requirementId: r.id }));

    expect(error.code).toBe('review_empty');
    // 消息里点名**为什么**一条都不剩，而不是一句「生成失败」
    expect(error.message).toContain('引文在 PRD 里找不到');
    expect(error.message).toContain('空的问题清单不是通过');

    // 图 + 问题清单两轮；页面片段一次都没问过
    expect(provider.prompts).toHaveLength(3);
    expect(await artifactCount()).toBe(0);
    expect(await artifactExists(`/uemaster/PAN-${r.number}/review.html`)).toBe(false);
  }, 60_000);

  it('没有快照 → 先 readPrd；有快照 → 不再读', async () => {
    const provider = await useFake();
    const r = await reviewable();
    await db.execute(sql`delete from prd_snapshots where requirement_id = ${r.id}`);

    let reads = 0;
    const readPrd: ReviewDeps['readPrd'] = async (_db, _actor, input) => {
      reads += 1;
      const saved = await saveSnapshot(db, '吕品', {
        requirementId: input.requirementId,
        url: 'https://doc.weixin.qq.com/doc/w3_AW4A1gbtAKYCNrNKOiCOyR7ykQKyF',
        markdown: PRD_TEXT,
      });
      const result: PrdReadResult = {
        ok: true,
        data: { snapshot: saved.snapshot, created: true, title: null, kind: 'doc' },
      };
      return result;
    };

    provider.enqueue(GOOD_FLOW, THREE_FINDINGS, PAGES_JSON);
    const first = await reviewRequirement(db, '吕品', { requirementId: r.id }, { readPrd });
    expect(reads).toBe(1);
    expect(first.stats.prdVersion).toBe('v1.4');

    // 现在库里有快照了：再点一次评审就**不该**再读 PRD（读一次要几秒 + 一次真实网络）
    provider.enqueue(GOOD_FLOW, THREE_FINDINGS, PAGES_JSON);
    const second = await reviewRequirement(db, '吕品', { requirementId: r.id }, { readPrd });
    expect(reads).toBe(1);
    expect(second.stats.prdHash).toBe(first.stats.prdHash);
  }, 90_000);

  it('没有 prd_url → 一句点名它的中文，一次模型调用都不发', async () => {
    const provider = await useFake();
    const bare = await createRequirement(db, '吕品', {
      title: '没有 PRD 的需求',
      type: 'feature',
      requester: '孙建宏',
    });

    const error = await caught(reviewRequirement(db, '吕品', { requirementId: bare.id }));

    expect(error.code).toBe('prd_missing_url');
    expect(error.message).toContain('PRD 链接');
    expect(error.message).toContain('prd_url');
    // 评审没有 PRD 就是拿标题在评审：停在发出任何调用之前
    expect(provider.prompts).toHaveLength(0);
    expect(await artifactCount()).toBe(0);
  }, 30_000);

  it('没配模型接口 → 点名缺哪几个设置（与另外两条路同一句话）', async () => {
    const r = await reviewable();

    const error = await caught(reviewRequirement(db, '吕品', { requirementId: r.id }));

    expect(error.code).toBe('provider_unconfigured');
    expect(error.message).toContain('FLOWERS_PROVIDER_BASE_URL');
  }, 30_000);
});

// ─── 管线接线 ────────────────────────────────────────────────────────────────

describe('start.ts 接线', () => {
  it('runJob 的 review 走评审那条路：done + artifact_id + findings 留痕', async () => {
    const provider = await useFake();
    const r = await reviewable();
    provider.enqueue(GOOD_FLOW, THREE_FINDINGS, PAGES_JSON);

    const job = await db.execute<{ id: string }>(sql`
      insert into uemaster_jobs (requirement_id, stage, status)
      values (${r.id}, 'review', 'running') returning id`);
    const jobId = job.rows[0]!.id;

    await runJob(db, jobId, { actor: '吕品' });

    const row = await db.execute<{ status: string; error: string | null; artifact_id: string | null }>(sql`
      select status, error, artifact_id from uemaster_jobs where id = ${jobId}`);
    expect(row.rows[0]!.status).toBe('done');
    expect(row.rows[0]!.error).toBeNull();
    expect(row.rows[0]!.artifact_id).not.toBeNull();

    const url = `/uemaster/PAN-${r.number}/review.html`;
    expect(await artifactExists(url)).toBe(true);
    const html = await readFile(siteFile(url), 'utf8');
    // 走的是评审：标题带 PRD 版本与问题分布，而不是「评估材料」的标题
    expect(html).toContain('评审材料 · PRD v1.4');
    expect(html).not.toContain('评估材料');

    // 留痕按作业落库：图 / 问题清单 / 页面三段各有名字
    const phases = (await attemptsOf(jobId)).map((a) => a.phase);
    expect(phases).toContain('flow');
    expect(phases).toContain('findings');
    expect(phases).toContain('pages');
    // 都通过了，所以每一行的 error 都是 null
    expect((await attemptsOf(jobId)).every((a) => a.error === null)).toBe(true);
  }, 90_000);

  it('runJob 失败时作业收成 failed，原因就是那句中文', async () => {
    const provider = await useFake();
    const r = await reviewable();
    const allFake = findingsJson([{ type: 'dead_end', node: 'C', quote: QUOTE_FAKE, why: '编的' }]);
    provider.enqueue(GOOD_FLOW, allFake, allFake);

    const job = await db.execute<{ id: string }>(sql`
      insert into uemaster_jobs (requirement_id, stage, status)
      values (${r.id}, 'review', 'running') returning id`);
    const jobId = job.rows[0]!.id;

    await runJob(db, jobId, { actor: '吕品' });

    const row = await db.execute<{ status: string; error: string | null }>(sql`
      select status, error from uemaster_jobs where id = ${jobId}`);
    expect(row.rows[0]!.status).toBe('failed');
    expect(row.rows[0]!.error).toContain('空的问题清单不是通过');
    // 被拒的两轮都留了痕，且写着「怎么被拒的」
    const findingsRows = (await attemptsOf(jobId)).filter((a) => a.phase === 'findings');
    expect(findingsRows).toHaveLength(2);
    expect(findingsRows.every((a) => (a.error ?? '').includes('找不到'))).toBe(true);
  }, 90_000);
});

describe('现状：改动层面的三类必须有代码证据', () => {
  const TREE = new Map([
    ['123pan-pc', new Set(['src/pages/Share/Search.tsx'])],
    ['123pan-uni-app', new Set(['src/pages/search/search.vue'])],
  ]);
  const baseline = {
    text: '现状基线：123pan-pc@afff7295',
    repos: [{ id: '123pan-pc', sha: 'afff7295aaaa' }],
    trees: TREE,
  } as never;

  it('没有现状时，改动类问题被丢掉（不知道现在怎么做，就无从判断冲突）', () => {
    const text = JSON.stringify({
      findings: [{
        type: 'conflicts_current', node: 'A', quote: 'PRD 原文',
        why: '会改掉现在的默认行为',
        code: { repo: '123pan-pc', path: 'src/pages/Share/Search.tsx' },
      }],
    });
    const out = readFindings(text, ['A'], 'PRD 原文', null);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.findings).toHaveLength(0);
      expect(out.dropped[0]!.reason).toBe('no_baseline');
    }
  });

  it('给了 code 但文件在镜像里不存在 → 丢掉（空口断言的现状判断不准进材料）', () => {
    const text = JSON.stringify({
      findings: [{
        type: 'no_migration', node: 'A', quote: 'PRD 原文', why: '旧数据没交代',
        code: { repo: '123pan-pc', path: 'src/pages/Share/Nope.tsx' },
      }],
    });
    const out = readFindings(text, ['A'], 'PRD 原文', baseline);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.findings).toHaveLength(0);
      expect(out.dropped[0]!.reason).toBe('code_not_found');
    }
  });

  it('code 是真的 → 收下，并带上那个文件（读者能去看一眼）', () => {
    const text = JSON.stringify({
      findings: [{
        type: 'misses_current_edge', node: 'A', quote: 'PRD 原文',
        why: '现在有「无权限文件夹」这个态，改版后没交代',
        code: { repo: '123pan-pc', path: 'src/pages/Share/Search.tsx' },
      }],
    });
    const out = readFindings(text, ['A'], 'PRD 原文', baseline);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.findings).toHaveLength(1);
      expect(out.findings[0]!.code).toEqual({ repo: '123pan-pc', path: 'src/pages/Share/Search.tsx' });
    }
  });

  it('repo 没写全但路径只在一个仓里 → 反推', () => {
    const text = JSON.stringify({
      findings: [{
        type: 'no_migration', node: 'A', quote: 'PRD 原文', why: 'x',
        code: { repo: '', path: 'src/pages/search/search.vue' },
      }],
    });
    const out = readFindings(text, ['A'], 'PRD 原文', baseline);
    if (out.ok) expect(out.findings[0]!.code?.repo).toBe('123pan-uni-app');
  });

  it('文档类给了 code 也不采信（避免读者以为它被核过）', () => {
    const text = JSON.stringify({
      findings: [{
        type: 'ambiguous', node: 'A', quote: 'PRD 原文', why: '两种读法',
        code: { repo: '123pan-pc', path: 'src/pages/Share/Search.tsx' },
      }],
    });
    const out = readFindings(text, ['A'], 'PRD 原文', baseline);
    if (out.ok) expect(out.findings[0]!.code).toBeUndefined();
  });
});
