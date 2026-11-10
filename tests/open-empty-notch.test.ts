import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { AppError } from '../src/core/errors.js';
import { readAttempts } from '../src/core/uemaster/attempts.js';
import { assembleWalkmap, composeEvaluation, readFragments } from '../src/core/uemaster/compose.js';
import type { SeqStep } from '../src/core/uemaster/sequence.js';
import type { FragmentDoc, PageFragment } from '../src/core/uemaster/compose.js';
import {
  EMPTY_OPEN_HEAD, EMPTY_OPEN_NOTE, NO_OPEN, openRows, readOpen,
} from '../src/core/uemaster/annotations.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { artifactExists, cleanArtifacts, siteFile } from './helpers/files.js';

/**
 * 「待确认一条都没有」不再是死判（2026-11-10，owner 裁决）。
 *
 * 事故的形状：模型两轮都没提待确认项 → `readFragments` 的 `requireOpen` 整份退回 →
 * `buildPages` 用完两次尝试 → 作业 failed。读者拿到的是一句「页面片段 2 次都没通过
 * 校验」，而那份图、那五个页面、那些标注其实全都在。
 *
 * 现在的口径：
 * - **重试照旧**：第一轮没提到就退回去再问一遍（那句话说得清补什么）；
 * - **第二轮照收**：一条都没有也出材料，右栏铺一行「本版没发现待确认项」+ 一句解释；
 * - **结构坏掉照旧判死**：少节点、JSON 不对、没有页面也没有步骤，每一轮都退。
 *
 * 三层判据分别钉在：`buildPages` 的豁免条件（只给第一轮 `requireOpen`）、
 * `assembleWalkmap` 铺哪一行、`readFragments` 的结构那几条没有一起松。
 */

// ─── 一个按脚本回话的 provider ──────────────────────────────────────────────

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
    usage: { prompt_tokens: 200, completion_tokens: 60 },
  });
}

async function startFake(): Promise<Fake> {
  const queue: Scripted[] = [];
  const prompts: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
        prompts.push(parsed.messages?.[0]?.content ?? '');
      } catch {
        prompts.push('');
      }
      const next = queue.shift()
        ?? { status: 500, body: JSON.stringify({ error: { message: '脚本用完了' } }) };
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(next.body);
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

// ─── 素材 ────────────────────────────────────────────────────────────────────

/** 5 节点图（引擎实测三个计数全 0：与 `compose.test.ts` 同一份）。 */
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
  '  <div class="wt-bottombar"><button class="wt-btn">提交</button></div>',
  '</div>',
].join('\n');

const WIDE = [
  '<div class="wt-browserbar"><i></i><i></i><i></i><span>门店后台 - 订单</span></div>',
  '<div class="wt-body"><table class="wt-table"><tr><th>订单号</th></tr><tr><td>PO-1</td></tr></table></div>',
].join('\n');

/**
 * 一份**两轮都没提待确认**的页面说明：结构完整、覆盖率齐、就是 `open` 整个缺席。
 *
 * 这正是要放行的那种回话——它读得懂、装得出来、只是右栏空着。
 */
const PAGES_NO_OPEN = JSON.stringify({
  nodes: [
    { id: 'A', kind: 'page', frame: 'phone', title: '进入寄养频道', html: PHONE,
      anno: [['内容', '按距离列出可寄养门店']] },
    { id: 'B', kind: 'decision', title: '是否登录？',
      steps: [
        { from: '页面', to: '服务端', what: '提交当前登录状态' },
        { from: '服务端', to: '服务端', what: '判断这个用户有没有登录过' },
      ],
      anno: [['判定依据', '会话里有没有用户']] },
    { id: 'C', kind: 'page', frame: 'phone', title: '选择宠物', html: PHONE,
      anno: [['字段', '宠物（列表单选）']] },
    { id: 'D', kind: 'page', frame: 'phone', title: '跳转登录', html: PHONE,
      anno: [['承接', '登录后回到本页']] },
    { id: 'E', kind: 'page', frame: 'wide', title: '提交订单', html: WIDE,
      anno: [['归属', '后台生成寄养单']] },
  ],
});

/** 一份结构就坏掉的回话：只有一个节点（图里五个），页面的还有两个没有 html。 */
const PAGES_BROKEN = JSON.stringify({
  nodes: [
    { id: 'A', kind: 'page', frame: 'phone', title: '进入寄养频道' },
  ],
});

// ─── 环境 ────────────────────────────────────────────────────────────────────

let fake: Fake | null = null;

async function useFake(): Promise<Fake> {
  fake = await startFake();
  process.env.FLOWERS_PROVIDER_BASE_URL = fake.baseUrl;
  process.env.FLOWERS_PROVIDER_API_KEY = 'sk-empty-open-test';
  process.env.FLOWERS_PROVIDER_MODEL = 'cheap-model';
  return fake;
}

function clearEnv(): void {
  delete process.env.FLOWERS_PROVIDER_BASE_URL;
  delete process.env.FLOWERS_PROVIDER_API_KEY;
  delete process.env.FLOWERS_PROVIDER_MODEL;
}

async function inbox() {
  return createRequirement(db, '吕品', { title: '寄养频道改版', type: 'feature', requester: '孙建宏' });
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

// ─── 1. 拼装那一层：整份一条都没有时铺哪一行 ────────────────────────────────

const PAGE_HTML = '<div class="wt-screen"><div class="wt-body">寄养</div></div>';

const STEP: SeqStep = { from: '服务端', to: '服务端', what: '记一笔订单' };

/** 两个页面节点 + 一个后端节点，`open` 全空（`withOpen: false` 时连字段都没有）。 */
function doc(open?: { req: string[][]; dev: string[][] }, withOpen = false): FragmentDoc {
  const nodes: PageFragment[] = [
    {
      id: 'A', title: '进入寄养频道', kind: 'page', frame: 'phone', html: PAGE_HTML,
      anno: [['内容', '按距离列出可寄养门店']],
      ...(withOpen ? { open: readOpen(open ?? { req: [['失败怎么办', '停在哪一屏']], dev: [] }) } : {}),
    },
    {
      id: 'B', title: '选择宠物', kind: 'page', frame: 'phone',
      html: '<div class="wt-screen"><div class="wt-body">选宠物</div></div>',
      anno: [['字段', '宠物（列表单选）']],
    },
    { id: 'C', title: '服务端接单', kind: 'system', frame: 'phone', html: '', anno: [], steps: [STEP] },
  ];
  return { nodes };
}

describe('整份一条待确认都没有：右栏铺一行，而不是留白', () => {
  it('每个节点的右栏最后都是那一行，且文案逐字对得上 owner 的裁决', () => {
    const assembly = assembleWalkmap(doc(), { title: 'PAN-42', svg: '<svg/>' });
    for (const id of ['A', 'B', 'C']) {
      const anno = assembly.walkmap.nodes[id]!.anno;
      const last = anno[anno.length - 1]!;
      expect(last[0]).toBe(EMPTY_OPEN_HEAD);
      expect(last[1]).toBe(EMPTY_OPEN_NOTE);
    }
    // 铺在**每个**节点上：右栏跟着节点走，只铺一个节点等于另外几屏的右栏还是空的。
    expect(assembly.walkmap.nodes.A!.anno.length).toBe(2);
    // 组标题一条都不出现：空的那一组不铺标题（这条规矩一个字没动）。
    const all = Object.values(assembly.walkmap.nodes).flatMap((node) => node.anno);
    expect(all.some((row) => row[0] === '待需求方确认' || row[0] === '待研发确认')).toBe(false);
  });

  it('只要有一个节点提了问题，就不铺那一行（它说的是「整份」）', () => {
    const assembly = assembleWalkmap(
      doc({ req: [['失败怎么办', '停在哪一屏']], dev: [] }, true),
      { title: 'PAN-42', svg: '<svg/>' },
    );
    const all = Object.values(assembly.walkmap.nodes).flatMap((node) => node.anno);
    expect(all.some((row) => row[0] === EMPTY_OPEN_HEAD)).toBe(false);
    expect(assembly.walkmap.nodes.A!.anno[1]![0]).toBe('待需求方确认');
  });

  it('单个节点为空时仍然是「一行都不铺」——那一行不属于这一层', () => {
    expect(openRows(NO_OPEN)).toEqual([]);
  });
});

// ─── 2. 生成那一层：第二轮照收，结构坏掉照旧判死 ────────────────────────────

describe('buildPages 的两轮语义', () => {
  it('两轮都没提待确认 → 材料出来，右栏里就那一行（重试照旧：模型被问了两次）', async () => {
    const provider = await useFake();
    const r = await inbox();
    // 作业行建出来只为留痕：`uemaster_job_attempts.job_id` 是外键。
    const job = await db.execute<{ id: string }>(sql`
      insert into uemaster_jobs (requirement_id, stage, status)
      values (${r.id}, 'evaluate', 'running') returning id`);
    const jobId = job.rows[0]!.id;
    provider.enqueue(GOOD_FLOW, PAGES_NO_OPEN, PAGES_NO_OPEN);

    const out = await composeEvaluation(db, '吕品', { requirementId: r.id, stage: 'evaluate', jobId });

    // 重试没被删掉：图一次 + 页面两次。
    expect(provider.prompts).toHaveLength(3);
    // 第一次那一轮被这道门退回、第二次照收——两张留痕把这件事说死了。
    const pages = (await readAttempts(db, jobId)).filter((row) => row.phase === 'pages');
    expect(pages.map((row) => row.attempt)).toEqual([1, 2]);
    expect(pages[0]!.error).toContain('待需求方确认');
    expect(pages[1]!.error).toBeNull();
    // 退回去那一次说的是「补什么」：提示词里仍然写着两组。
    expect(provider.prompts[2]).toContain('待需求方确认');

    expect(await artifactExists(out.url)).toBe(true);
    expect(await artifactCount()).toBe(1);

    const html = await readFile(siteFile(out.url), 'utf8');
    expect(html).toContain(EMPTY_OPEN_HEAD);
    expect(html).toContain(EMPTY_OPEN_NOTE);
  });

  it('结构坏掉（页面没有 html）两轮都退，材料不出、不留文件', async () => {
    const provider = await useFake();
    const r = await inbox();
    provider.enqueue(GOOD_FLOW, PAGES_BROKEN, PAGES_BROKEN);

    const error = await caught(composeEvaluation(db, '吕品', { requirementId: r.id, stage: 'evaluate' }));

    expect(error.code).toBe('pages_rejected');
    // 这一句是结构那一层的原话：缺的是一屏 html，不是那一栏待确认。
    expect(error.message).toContain('是页面，但没有给 html');
    expect(await artifactCount()).toBe(0);
    expect(await artifactExists(`/uemaster/PAN-${r.number}/evaluate.html`)).toBe(false);
  });

  it('结构那一层没有跟着松：没有页面的节点照样被 `readFragments` 拒', () => {
    const text = JSON.stringify({
      nodes: [
        { id: 'A', kind: 'page', frame: 'phone', title: '进入寄养', html: PAGE_HTML },
        { id: 'B', kind: 'system', title: '接单' },
      ],
    });
    // 第二轮的口径（`requireOpen` 不传）：待确认缺席被放过，缺 steps 不被放过。
    const read = readFragments(text, ['A', 'B']);
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.why).toContain('B');
    expect(read.ok === false && read.why).toContain('steps');
  });
});
