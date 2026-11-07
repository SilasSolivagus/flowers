#!/usr/bin/env tsx
/**
 * 把「待排期」的需求导成一张企微智能表格。
 *
 * ── 为什么是智能表格而不是文件附件
 *
 * 待排期这一列是**会前要被逐条点过去**的东西：谁负责、等什么、挂哪个版本。发一个
 * xlsx 附件等于把一份快照扔进群里，第二天就对不上了。智能表格是一个链接，人可以
 * 接着在上面改，我们也能再导一次追加。
 *
 * ── 为什么走 cli 而不是自己调 API
 *
 * `wecom-cli` 已经把那套凭据、鉴权、文档权限封装好了（供应商自己的二进制），
 * 我们只负责把行拼成它要的形状。多发一层抽象只会多一处对不齐。
 *
 * 用法：
 *   npx tsx scripts/export-queue.ts                 # 建一张新表
 *   npx tsx scripts/export-queue.ts --dry-run       # 只打印将要写入的行
 *   npx tsx scripts/export-queue.ts --append <docid|url>   # 追加到一个已有智能表
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';

const run = promisify(execFile);

/** 导出哪些列。顺序就是表里的列顺序——与看板卡片上读者关心的东西一致。 */
const COLUMNS = [
  '编号', '标题', '类型', '负责人', '提出人', '等什么', '停留天数', 'PRD', '版本',
] as const;

type Row = {
  number: number;
  title: string;
  type: string;
  owner: string | null;
  requester: string;
  waiting: string;
  days: number;
  prd_url: string | null;
  release_name: string | null;
};

/**
 * 待排期 = `queue`。
 *
 * 「等什么」由状态本身决定（这一列里每条都在等排期），所以这里不重复写「等排期」；
 * 真正有信息量的是**它挂了哪个版本**与**停了几天**——排期要看的就是这两件事。
 */
async function queueRows(): Promise<Row[]> {
  const res = await db.execute<{
    number: number; title: string; type: string; owner: string | null;
    requester: string; days: number; prd_url: string | null; release_name: string | null;
  }>(sql`
    select r.number, r.title, r.type,
           m.name as owner,
           r.requester,
           greatest(0, date_part('day', now() - r.state_entered_at))::int as days,
           r.prd_url,
           rel.name as release_name
      from requirements r
      left join members m on m.id = r.owner_member_id
      left join releases rel on rel.id = r.release_id
     where r.state = 'queue' and r.deleted_at is null
     order by r.number`);

  return res.rows.map((row) => ({
    ...row,
    days: Number(row.days),
    // 这一列里每条都卡在同一件事上；把它写出来是为了让表格脱离看板也能读。
    waiting: '排期',
  }));
}

/**
 * 一行的 values：`{ 字段标题: 值 }`。
 *
 * 用**字段标题**当键（`--key-type field_title`）而不是 field_id：field_id 是建表时
 * 服务端生成的，我们手里没有，先建表再查一遍 ID 只为了发一次写入不值得。
 */
function toValues(row: Row): Record<string, string> {
  return {
    编号: `PAN-${row.number}`,
    标题: row.title,
    类型: row.type === 'commercial' ? '商业' : '功能',
    负责人: row.owner ?? '—',
    提出人: row.requester,
    等什么: row.waiting,
    停留天数: String(row.days),
    PRD: row.prd_url ?? '—',
    版本: row.release_name ?? '—',
  };
}

function toFields(): Array<{ field_title: string; field_type: string }> {
  return COLUMNS.map((title) => ({
    field_title: title,
    field_type: title === '停留天数' ? 'number' : 'text',
  }));
}

/** 跑一次 wecom-cli，把 `errcode != 0` 翻成异常（它自己是退出码 0 + errcode 的）。 */
async function wecomCli(args: string[]): Promise<{ docid?: string; url?: string }> {
  const { stdout } = await run('wecom-cli', args, { maxBuffer: 8 * 1024 * 1024, timeout: 60_000 });
  const parsed = JSON.parse(stdout) as { docid?: string; url?: string; errcode?: number; errmsg?: string };
  if (parsed.errcode !== undefined && parsed.errcode !== 0) {
    throw new Error(`${parsed.errmsg ?? '未知错误'}（errcode ${parsed.errcode}）`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');

  const rows = await queueRows();
  if (rows.length === 0) {
    console.log('待排期是空的，没有可导出的行。');
    return;
  }

  if (dryRun) {
    console.log(`${rows.length} 行，${COLUMNS.length} 列（${COLUMNS.join(' / ')}）`);
    for (const row of rows) {
      console.log(`  PAN-${row.number}  ${row.title}  ${row.owner ?? '—'}  ${row.days} 天`);
    }
    return;
  }

  const now = new Date();
  const stamp = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const name = `待排期需求 ${stamp}`;

  // 建表只带字段。**不用 `grid_data` 一次性写行**：实测 `record_count` 仍是 0，
  // 行没有落进去（字段到了、行没到）。分两步反而干净——建表、再批量写行，
  // 两步各自的错误也能分开报。
  const body: Record<string, unknown> = { name, sheet_title: '待排期', fields: toFields() };
  const created = await wecomCli(['smartsheet', 'create', '--json', JSON.stringify(body)]);
  const docid = created.docid;
  if (docid === undefined || docid === '') {
    console.error('建表没有返回 docid，无法继续写行。');
    process.exitCode = 1;
    return;
  }

  await wecomCli([
    'smartsheet', 'records', 'add',
    '--docid', docid,
    '--sheet-title', '待排期',
    '--key-type', 'field_title',
    '--records', JSON.stringify(rows.map((row) => ({ values: toValues(row) }))),
  ]);

  console.log(`已建表：${name} · ${rows.length} 行`);
  if (created.url !== undefined) console.log(created.url);
  console.log(`docid: ${docid}`);
}

await main();
await pool.end();
