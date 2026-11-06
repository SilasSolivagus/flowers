/**
 * MCP stdio 真机验证：用官方 SDK 的 client 起一个 `mcp/server.ts` 子进程，
 * 按真实 agent 的顺序把三个工具跑一遍。
 *
 *   npx tsx scripts/mcp-smoke.ts                 # 自动挑一条种子需求
 *   npx tsx scripts/mcp-smoke.ts <requirementId> # 指定需求
 *
 * 为什么要有这个脚本：`mcp/tools.ts` 是普通函数，直接 call 只能证明逻辑对；真正
 * 会坏的那一层是 stdio——JSON-RPC 握手、zod schema 与客户端看到的工具列表、
 * 异常有没有变成 `isError` 而不是把连接打崩。那三件事只有在另一个进程里跑才测得出来。
 *
 * 脚本里那一步「从包正文里抠出 public/uemaster/... 路径并写文件」不是作弊，它就是
 * agent 要做的事：**任务包自己说得清要写到哪**。抠不出来，说明包没写清。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { db, pool } from '../src/db/client.js';
import { getRequirementDetail } from '../src/core/read/detail.js';

const ACTOR = 'claude-code';

/** 一次 callTool 的结果：把多段 text 拼起来，isError 原样带出。 */
type CallResult = { isError: boolean; text: string };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallResult> {
  const res = await client.callTool({ name, arguments: args });
  const blocks = (res.content ?? []) as Array<{ type: string; text?: string }>;
  const text = blocks.map((b) => b.text ?? `[${b.type}]`).join('\n');
  return { isError: res.isError === true, text };
}

function head(title: string): void {
  console.log(`\n──── ${title} ──────────────────────────────────────────────`);
}

/** 从任务包正文里抠「交付：写到 public/uemaster/PAN-n/<stage>.html」。 */
function packFile(pack: string): string {
  const hit = pack.match(/public\/uemaster\/PAN-\d+\/[a-z]+\.html/);
  if (!hit) throw new Error('任务包里没有 public/uemaster/... 路径——包没写清交付位置');
  return hit[0];
}

/** 一条需求现在有几条事件（用来证明 plan 是纯读）。 */
async function eventCount(requirementId: string): Promise<number> {
  const res = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from events where requirement_id = ${requirementId}`,
  );
  return Number(res.rows[0]?.n ?? 0);
}

async function pickRequirement(argv: string | undefined): Promise<{ id: string; number: number }> {
  if (argv !== undefined) {
    const res = await db.execute<{ id: string; number: number }>(
      sql`select id, number from requirements where id = ${argv}`,
    );
    if (res.rows[0] === undefined) throw new Error(`没有这条需求：${argv}`);
    return res.rows[0];
  }
  const res = await db.execute<{ id: string; number: number; title: string; state: string }>(
    sql`select id, number, title, state from requirements order by number limit 1`,
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error('库里没有需求：先跑 npm run seed -- --reset');
  console.log(`（自动挑中 PAN-${row.number}「${row.title}」state=${row.state}）`);
  return { id: row.id, number: row.number };
}

async function main(): Promise<void> {
  const { id: requirementId, number } = await pickRequirement(process.argv[2]);
  const ghost = '00000000-0000-4000-8000-000000000000';

  // 子进程：就是 `npm run mcp` 跑的那条命令本体。env 显式带上 DATABASE_URL，
  // 并指定 actor —— 这条值会进 events.actor，是「谁交的这份材料」的唯一证据。
  const transport = new StdioClientTransport({
    command: path.resolve('node_modules/.bin/tsx'),
    args: ['mcp/server.ts'],
    cwd: process.cwd(),
    env: { ...(process.env as Record<string, string>), FLOWERS_MCP_ACTOR: ACTOR },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'flowers-smoke', version: '1.0.0' });

  await client.connect(transport);
  let written: string | null = null;

  try {
    head('1. initialize → tools/list（客户端看到的工具）');
    const list = await client.listTools();
    for (const tool of list.tools) {
      console.log(`  ${tool.name.padEnd(18)} ${(tool.description ?? '').slice(0, 40)}…`);
      console.log(`  ${' '.repeat(18)} required=${JSON.stringify(tool.inputSchema.required ?? [])}`);
    }

    head(`2. uemaster_plan  PAN-${number} stage=evaluate`);
    // 纯读的证据：这条需求的事件条数在 plan 前后必须一样。
    const before = await eventCount(requirementId);
    const planned = await call(client, 'uemaster_plan', { requirementId, stage: 'evaluate' });
    const after = await eventCount(requirementId);
    console.log(`isError=${planned.isError}  事件数：plan 前 ${before} / plan 后 ${after}（不改状态、不写事件）`);
    console.log(planned.text);

    head('3. 按包里的交付行写文件（agent 干的活）');
    const file = packFile(planned.text);
    written = file;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '<!doctype html><meta charset="utf-8"><h1>占位产物</h1>', 'utf8');
    console.log(`  写成 ${file}`);

    const url = `/${file.replace(/^public\//, '')}`;
    head(`4. uemaster_attach  url=${url}`);
    const attached = await call(client, 'uemaster_attach', { requirementId, stage: 'evaluate', url });
    console.log(`isError=${attached.isError}`);
    console.log(attached.text);

    head('5. requirement_show（agent 据此决定下一步）');
    const shown = await call(client, 'requirement_show', { requirementId });
    console.log(`isError=${shown.isError}`);
    console.log(shown.text);

    head('6. 反例：每一种失败都必须是 isError，且说的是中文，连接不断');
    const planCases: Array<[string, Record<string, unknown>]> = [
      ['stage 不认识', { requirementId, stage: 'design' }],
      ['缺 requirementId', { stage: 'evaluate' }],
      ['需求不存在', { requirementId: ghost, stage: 'evaluate' }],
      ['ID 不是 uuid', { requirementId: 'PAN-7', stage: 'evaluate' }],
    ];
    for (const [label, args] of planCases) {
      const got = await call(client, 'uemaster_plan', args);
      console.log(`  plan · ${label.padEnd(14)} isError=${got.isError}  ${got.text.split('\n')[0]}`);
    }
    // attach 的失败走的是领域层（attachArtifact），文案与 plan 那几条不同源。
    const attachCases: Array<[string, Record<string, unknown>]> = [
      ['文件没写', { requirementId, stage: 'review', url: `/uemaster/PAN-${number}/review.html` }],
      ['非法链接', { requirementId, stage: 'review', url: 'javascript:alert(1)' }],
      ['需求不存在', { requirementId: ghost, stage: 'review', url: 'https://x/y.html' }],
    ];
    for (const [label, args] of attachCases) {
      const got = await call(client, 'uemaster_attach', args);
      console.log(`  attach · ${label.padEnd(12)} isError=${got.isError}  ${got.text.split('\n')[0]}`);
    }
    // 反例之后工具还能正常调：证明这些错误没有把进程打崩。
    const alive = await call(client, 'requirement_show', { requirementId });
    console.log(`  反例之后仍可调用：requirement_show isError=${alive.isError}（连接没断）`);

    head('7. 时间线（events）与抽屉（getRequirementDetail 的 refs）');
    const events = await db.execute<{ seq: number; type: string; actor: string; payload: string }>(
      sql`select seq, type, actor, payload from events
           where requirement_id = ${requirementId} and type = 'uemaster.attached'
           order by seq desc limit 1`,
    );
    console.log('  events:', JSON.stringify(events.rows[0] ?? null));

    const detail = await getRequirementDetail(requirementId);
    console.log('  refs:', JSON.stringify(detail?.refs ?? null, null, 2));
  } finally {
    await client.close();
    // 占位文件不进仓库：public/uemaster/ 是 .gitignore 里的运行期目录，用完就删。
    // `--keep` 留着它，给「抽屉里点得开」这类要人眼看一步的验证用。
    if (written !== null && !process.argv.includes('--keep')) {
      await rm(written, { force: true });
      console.log(`\n（已删掉占位文件 ${written}）`);
    } else if (written !== null) {
      console.log(`\n（保留占位文件 ${written}，--keep）`);
    }
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('验证失败：', error);
  process.exitCode = 1;
});
