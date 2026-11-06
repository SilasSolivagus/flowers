import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { readAttempts } from '../src/core/uemaster/attempts.js';
import { composeEvaluation } from '../src/core/uemaster/compose.js';
import { runJob, jobStatus } from '../src/core/uemaster/start.js';
import { attemptLine, classifyFailure, type AttemptView } from '../src/core/uemaster/trace.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { cleanArtifacts } from './helpers/files.js';

/**
 * P2.13：留痕与边界 toast 的**真库**用例。
 *
 * 这里除了「谁回话」之外没有一件事是假的：图由 vendored 的 `flowlayout.py` 真排，
 * provider 是一个真的 `http.createServer`（真 `fetch`、真 `provider.complete`、
 * 真脱敏），`uemaster_jobs` / `uemaster_job_attempts` 是真表。
 *
 * 要证明的四件事：
 * 1. **402**：作业 failed、`uemaster_jobs.error` 是服务端原文、尝试表有那一行
 *    （phase=flow、output_chars=0）、分类结果是「这个 key 余额不足」，且**浮层那段字里
 *    没有 key**；
 * 2. **成功也留痕**：三次调用三行（flow / pages / build），error 全为 null；
 * 3. **修图那一次也在**：第一次形状被拒、第二次过、页面两次不过 → 四行，且第一行能被
 *    `attemptLine` 压成 `第 1 次 · flow · 2 个节点 1 条连线被拒`；
 * 4. **构建被拒也有行**：`build.py` 那一段失败时不能只留在最后那句话里。
 */

// ─── 一个按脚本回话的 provider ──────────────────────────────────────────────

type Scripted = { status: number; body: string };

type Fake = {
  baseUrl: string;
  prompts: string[];
  enqueue: (...texts: string[]) => void;
  enqueueError: (status: number, message: string) => void;
  close: () => Promise<void>;
};

function chatBody(content: string): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 300, completion_tokens: 80 },
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
      const next = queue.shift() ?? { status: 500, body: JSON.stringify({ error: { message: '脚本用完了' } }) };
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
    enqueueError: (status: number, message: string) => {
      queue.push({ status, body: JSON.stringify({ error: { message } }) });
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

// ─── 素材 ────────────────────────────────────────────────────────────────────

/** 5 节点图（引擎实测三个计数全 0）。 */
const GOOD_FLOW = `flowchart TD
  A["进入寄养频道"] --> B{"是否登录？"}
  B -->|是| C["选择宠物"]
  B -->|否| D["跳转登录"]
  C --> E["提交订单"]
`;

/** 2 节点 1 连线：语法合法、引擎判合格——形状太小才是它的问题。 */
const SMALL_FLOW = `flowchart TD
  A["开始"] --> B["结束"]
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

// ─── 夹具 ────────────────────────────────────────────────────────────────────

let fake: Fake | null = null;

async function useFake(): Promise<Fake> {
  fake = await startFake();
  process.env.FLOWERS_PROVIDER_BASE_URL = fake.baseUrl;
  process.env.FLOWERS_PROVIDER_API_KEY = 'sk-trace-0123456789abcdef0123456789abcdef';
  process.env.FLOWERS_PROVIDER_MODEL = 'cheap-model';
  return fake;
}

function clearEnv(): void {
  delete process.env.FLOWERS_PROVIDER_BASE_URL;
  delete process.env.FLOWERS_PROVIDER_API_KEY;
  delete process.env.FLOWERS_PROVIDER_MODEL;
}

/** 一条收集里的需求（无 PRD，评估这条路走得通）。 */
async function inbox(): Promise<{ id: string; number: number }> {
  const r = await createRequirement(db, '吕品', { title: 'S3 协议支持', type: 'feature', requester: '孙建宏' });
  return { id: r.id, number: r.number };
}

/** 直接落一条 running 作业：走 `startGeneration` 会真去 spawn 一个 worker，用例不要那个。 */
async function newJob(requirementId: string): Promise<string> {
  const res = await db.execute<{ id: string }>(sql`
    insert into uemaster_jobs (requirement_id, stage, status)
    values (${requirementId}, 'evaluate', 'running')
    returning id`);
  return res.rows[0]!.id;
}

type AttemptRow = {
  attempt: number; phase: string; model: string;
  prompt_chars: number; output_chars: number; error: string | null; ms: number;
};

async function dbAttempts(jobId: string): Promise<AttemptRow[]> {
  const res = await db.execute<AttemptRow>(sql`
    select attempt, phase, model, prompt_chars, output_chars, error, ms
      from uemaster_job_attempts
     where job_id = ${jobId}
     order by created_at, attempt, id`);
  return res.rows;
}

async function jobRow(jobId: string): Promise<{ status: string; error: string | null }> {
  const res = await db.execute<{ status: string; error: string | null }>(sql`
    select status, error from uemaster_jobs where id = ${jobId}`);
  return res.rows[0]!;
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

// ─── 用例 ────────────────────────────────────────────────────────────────────

describe('uemaster_job_attempts', () => {
  it('402 insufficient_quota：作业 failed、error 是原文、留痕一行、分类给出余额不足、且不含 key', async () => {
    const provider = await useFake();
    const r = await inbox();
    const jobId = await newJob(r.id);

    // 服务端把整条 Authorization 回显进 error.message（真实网关干过这件事）：
    // provider.ts 会在落库之前把 key 洗成 ***，留痕与浮层都必须拿到洗过的那句。
    provider.enqueueError(402, `insufficient_quota for key ${process.env.FLOWERS_PROVIDER_API_KEY}`);

    await runJob(db, jobId, { actor: '吕品' });

    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toContain('insufficient_quota');

    const rows = await dbAttempts(jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.phase).toBe('flow');
    expect(rows[0]!.attempt).toBe(1);
    expect(rows[0]!.model).toBe('cheap-model');
    expect(rows[0]!.output_chars).toBe(0);
    expect(rows[0]!.prompt_chars).toBeGreaterThan(0);
    expect(rows[0]!.ms).toBeGreaterThanOrEqual(0);
    expect(rows[0]!.error).toContain('insufficient_quota');

    // 界面那一层：`jobStatus` 把留痕带回来，分类给出人话标题。
    const view = await jobStatus(db, jobId);
    expect(view?.attempts).toHaveLength(1);
    const failure = classifyFailure(view!.error!);
    expect(failure.kind).toBe('quota');
    expect(failure.title).toBe('这个 key 余额不足');

    // 浮层上那两行字（标题 + 原文）里一个字都不能是 key。
    const toastText = [failure.title, failure.detail ?? '', attemptLine(view!.attempts[0]!)]
      .join('\n');
    expect(toastText).not.toContain(process.env.FLOWERS_PROVIDER_API_KEY);
    expect(toastText).not.toContain('***'.repeat(1) + process.env.FLOWERS_PROVIDER_API_KEY);
    // 原文里的 key 位置确实是 ***（证明洗过，而不是「恰好没出现」）。
    expect(view!.error).toContain('key ***');
  });

  it('成功也留痕：三次调用三行（flow / pages / build），error 全为 null', async () => {
    const provider = await useFake();
    const r = await inbox();
    const jobId = await newJob(r.id);
    provider.enqueue(GOOD_FLOW, PAGES_JSON);

    await runJob(db, jobId, { actor: '吕品' });

    const job = await jobRow(jobId);
    expect(job.status).toBe('done');
    expect(job.error).toBeNull();

    const rows = await dbAttempts(jobId);
    expect(rows.map((x) => `${x.phase}#${x.attempt}`)).toEqual(['flow#1', 'pages#1', 'build#1']);
    expect(rows.every((x) => x.error === null)).toBe(true);
    expect(rows.map((x) => x.output_chars > 0)).toEqual([true, true, true]);
    expect(rows[0]!.prompt_chars).toBeGreaterThan(0);
    expect(rows[1]!.prompt_chars).toBeGreaterThan(0);
    // 构建没有提示词：输入是 walkmap，不是文字。
    expect(rows[2]!.prompt_chars).toBe(0);

    // 成功的作业在抽屉里不显示任何东西：`jobStatus` 的 attempts 只喂给「详情」，
    // 而「详情」只挂在失败分支上（见 GenerateButton）。
    const view = await jobStatus(db, jobId);
    expect(view?.status).toBe('done');
    expect(view?.attempts).toHaveLength(3);
  });

  it('修图与改片段的每一次都在：flow#1 被形状拒、flow#2 过、pages 两次不过', async () => {
    const provider = await useFake();
    const r = await inbox();
    const jobId = await newJob(r.id);
    provider.enqueue(SMALL_FLOW, GOOD_FLOW, '这不是 JSON', '这也不是 JSON');

    await runJob(db, jobId, { actor: '吕品' });

    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toContain('页面片段 2 次都没通过校验');

    const rows = await dbAttempts(jobId);
    expect(rows.map((x) => `${x.phase}#${x.attempt}`)).toEqual([
      'flow#1', 'flow#2', 'pages#1', 'pages#2',
    ]);
    expect(rows[0]!.error).toContain('只有 2 个节点、1 条连线');
    expect(rows[1]!.error).toBeNull();
    expect(rows[2]!.error).toContain('没有 JSON 对象');
    expect(rows[3]!.error).not.toBeNull();
    // 第一次被拒、第二次通过：抽屉里读得出来「改一次就过了」。
    expect(rows[1]!.output_chars).toBeGreaterThan(0);

    // 抽屉那一行字（`attemptLine` 是纯函数，这里用**真**行数据跑一遍）。
    const views: AttemptView[] = await readAttempts(db, jobId);
    expect(views).toHaveLength(4);
    expect(attemptLine(views[0]!)).toBe('第 1 次 · flow · 2 个节点 1 条连线被拒');
    expect(attemptLine(views[1]!)).toBe(`第 2 次 · flow · ${rows[1]!.output_chars} 字`);
    // 后两行是校验器的原话：压平、截断，不改写（这一句短，没被截）。
    expect(attemptLine(views[2]!)).toBe('第 1 次 · pages · 回话里没有 JSON 对象（第一个字符就该是 {）');
    expect(attemptLine(views[3]!).startsWith('第 2 次 · pages · ')).toBe(true);
  });

  it('构建被拒也有行：build#1 带着 build.py 的那句话，作业仍是 failed', async () => {
    const provider = await useFake();
    const r = await inbox();
    const jobId = await newJob(r.id);
    provider.enqueue(GOOD_FLOW, PAGES_JSON);

    await expect(composeEvaluation(db, '吕品', { requirementId: r.id, stage: 'evaluate', jobId }, {
      build: async () => ({ ok: false, errors: ['构建器拒绝了 emoji'], warnings: [] }),
    })).rejects.toThrow(/走查页构建失败/);

    const rows = await dbAttempts(jobId);
    expect(rows.map((x) => `${x.phase}#${x.attempt}`)).toEqual(['flow#1', 'pages#1', 'build#1']);
    expect(rows[2]!.error).toContain('构建器拒绝了 emoji');
    expect(rows[2]!.output_chars).toBe(0);
  });
});
