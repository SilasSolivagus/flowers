#!/usr/bin/env tsx
/**
 * 把镜像的合并历史补进 `commit_history`，或只看一眼现在库里有啥。
 *
 * 存在的理由：`ensureHistory` 是增量落库（pc 533 条要读 16 秒），定位每次都要问它，
 * 所以「这次到底插进去了几条、库里现在有多少、最早/最晚是哪天」在跑一次定位之前
 * 是看不见的。这个脚本把那些数字单独打出来，owner 才能在改动前后对比，也才能确认
 * 「第二次跑插入了 0」——幂等这件事必须能当场验证，不能只写在注释里。
 *
 * 用法：
 *   npx tsx scripts/index-history.ts --repo 123pan-uni-app --repo 123pan-pc
 *   npx tsx scripts/index-history.ts --repo 123pan-uni-app --dry-run
 *
 * `--dry-run` **不写库**：只读镜像（`mergeHistory` 全量）+ 读一次表，打印同一份摘要。
 * 用来量「首建要多久、会有多少条」而不污染库里已有的那几行。
 */
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import { mergeHistory } from '../src/core/codemirror/mirror.js';
import { ensureHistory, readHistory, type HistoryRow } from '../src/core/locate/history-store.js';

type Args = { repos: string[]; dryRun: boolean };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { repos: [], dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === '--repo') {
      // 可多次：一次把两个仓都补齐（合起来 657 条，读一轮就够了）。
      const value = (argv[i + 1] ?? '').trim();
      i += 1;
      if (value !== '') args.repos.push(value);
    } else if (flag === '--dry-run') {
      args.dryRun = true;
    } else if (flag === '--help' || flag === '-h') {
      console.log('用法：tsx scripts/index-history.ts --repo <id> [--repo <id>] [--dry-run]');
      process.exit(0);
    }
  }
  if (args.repos.length === 0) {
    console.error('缺 --repo <id>（例如 --repo 123pan-uni-app，可给多次）');
    process.exit(2);
  }
  return args;
}

/**
 * 上海日历日。
 *
 * 表里是 `timestamptz`，**回读是 UTC**（`2026-11-06T13:00:00.000Z` = 北京时间 21:00）。
 * 直接切前 10 位会把晚上合并的条目显示成前一天，而镜像给的 `%cI` 本来就是 +08:00。
 * 两处都折成同一把尺子（固定 +08:00；1991 年后中国没有夏令时）。
 */
const SHANGHAI_OFFSET_MS = 8 * 3600_000;
function dayOf(iso: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '????';
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/** 一行消息压缩成一段：提交信息可能很长（` / ` 拼起来的十几条），报告里放不下。 */
function short(text: string, max = 56): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one === '' ? '（无提交信息）' : (one.length <= max ? one : `${one.slice(0, max - 1)}…`);
}

/** 前 3 个文件：一次合并动几十个文件是常事，报告里要的是「大概在哪」。 */
function someFiles(files: readonly string[], max = 3): string {
  if (files.length === 0) return '（没有源码文件）';
  const head = files.slice(0, max).join('、');
  return files.length > max ? `${head} 等 ${files.length} 个` : head;
}

type Line = { at: string; branch: string | null; message: string; files: string[] };

/** 一个仓的摘要头：条数 / 最早 / 最晚。`total` 与日期来自同一次读数。 */
function header(label: string, total: number, rows: readonly Line[]): string {
  if (total === 0 || rows.length === 0) return `${label}  ${total} 条`;
  const newest = rows[0]!;
  const oldest = rows[rows.length - 1]!;
  return `${label}  ${total} 条（${dayOf(oldest.at)} … ${dayOf(newest.at)}）`;
}

/** 最新 5 条：日期、分支、消息、前 3 个文件。表格之外的第二行缩进对齐。 */
function printRows(rows: readonly Line[]): void {
  for (const row of rows.slice(0, 5)) {
    // 分支名最长的有 30 多个字符（`release-revert-professional-space`），不截会顶歪整列；
    // 截到 21 + 省略号是 22 格，正好是这一列的对齐宽度。
    const raw = row.branch === null ? '（无分支）' : row.branch;
    const branch = raw.length > 22 ? `${raw.slice(0, 21)}…` : raw.padEnd(22);
    console.log(`  ${dayOf(row.at)}  ${branch} ${short(row.message)}`);
    console.log(`  ${' '.repeat(12)}${someFiles(row.files)}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let failed = false;

  for (const repo of args.repos) {
    if (args.dryRun) {
      // 只读：镜像全量取一次（不传 since，等价于「首建会拿到的全部」），表只查不写。
      const started = Date.now();
      const got = await mergeHistory(repo);
      if (!got.ok) {
        console.error(`读合并历史失败：${repo}：${got.message}`);
        failed = true;
        continue;
      }
      const stored = await readHistory(db, repo);
      const mirrorMs = Date.now() - started;
      const mirrorRows: Line[] = got.data.map((m) => ({
        at: m.mergedAt, branch: m.branch, message: m.message, files: m.files,
      }));
      console.log(`${header(repo, mirrorRows.length, mirrorRows)}  ← 镜像（${mirrorMs} ms）`);
      console.log(`  库里 ${stored.length} 条（--dry-run：没有写库）`);
      printRows(mirrorRows);
      console.log('');
      continue;
    }

    const synced = await ensureHistory(db, repo);
    if (!synced.ok) {
      console.error(`补齐合并历史失败：${repo}：${synced.message}`);
      failed = true;
      continue;
    }
    // 摘要从**表里**读：`inserted` 是本次动作，而这里要的是「库里现在有什么」，
    // 两者在同一次运行里常常不同（第二次跑就是 inserted 0、total 不变）。
    const rows = await readHistory(db, repo);
    const lines: Line[] = rows.map((row: HistoryRow) => ({
      at: row.mergedAt, branch: row.branch, message: row.message, files: row.files,
    }));
    console.log(`${header(repo, synced.data.total, lines)}  本次插入 ${synced.data.inserted} 条（${synced.data.ms} ms）`);
    printRows(lines);
    console.log('');
  }

  const totals = await db.execute<{ repos: number; n: string }>(sql`
    select count(distinct repo)::int as repos, count(*)::text as n from commit_history`);
  console.log(`commit_history 合计 ${totals.rows[0]?.n ?? '0'} 行，覆盖 ${totals.rows[0]?.repos ?? 0} 个仓`
    + `${args.dryRun ? '（--dry-run：没有写库）' : ''}`);
  if (failed) process.exitCode = 1;
}

await main();
await pool.end();
