#!/usr/bin/env tsx
/**
 * 增量同步一个提交的静态索引（P4-11）。
 *
 * 存在的理由：`repoIndex()` 是**懒建**的（走查/评审第一次用到某个 sha 才建），所以
 * 「这一次到底解析了几块内容、复用了多少、花了多少毫秒」在跑完整条链路之前是看不见的。
 * 这个脚本把那四个数单独打出来，并且**可以重复跑**：同一个提交跑第二次必须是
 * 「0 块新内容 / 0 行新映射」——这就是「索引一次、之后只做增量」的可观察证据。
 *
 * 用法：
 *   npx tsx scripts/index-sync.ts --repo 123pan-uni-app
 *   npx tsx scripts/index-sync.ts --repo 123pan-pc --sha <sha>
 *   npx tsx scripts/index-sync.ts --repo 123pan-pc --sha <sha> --json
 *   npx tsx scripts/index-sync.ts --repo 123pan-pc --sha <sha> --rebuild
 *
 * `--rebuild` 只删这个提交的 `tree_entry` 行（**不动 blob 行**）：于是它量的是
 * 「映射重建 + 内容全复用」，与「内容也是新的」区分得开。
 */
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import { blobIndexStats } from '../src/core/codemirror/blob-index.js';
import { summarize, type CodeIndex } from '../src/core/codemirror/code-index.js';
import { dropIndex, syncRepoIndex } from '../src/core/codemirror/index-store.js';
import { head, lsTreeEntries } from '../src/core/codemirror/mirror.js';

type Args = { repo: string; sha: string | null; rebuild: boolean; json: boolean };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { repo: '', sha: null, rebuild: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    const next = (): string => {
      const value = argv[i + 1] ?? '';
      i += 1;
      return value;
    };
    if (flag === '--repo') args.repo = next();
    else if (flag === '--sha') args.sha = next();
    else if (flag === '--rebuild') args.rebuild = true;
    else if (flag === '--json') args.json = true;
    else if (flag === '--help' || flag === '-h') {
      console.log('用法：tsx scripts/index-sync.ts --repo <id> [--sha <sha>] [--rebuild] [--json]');
      process.exit(0);
    }
  }
  if (args.repo === '') {
    console.error('缺 --repo <id>（例如 --repo 123pan-uni-app）');
    process.exit(2);
  }
  return args;
}

async function treeRows(repo: string): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from tree_entry where repo = ${repo}`);
  return Number(res.rows[0]?.n ?? 0);
}

function printSummary(index: CodeIndex): void {
  const summary = summarize(index);
  console.log(`索引      ${summary.files} 个文件（${Object.entries(summary.byKind)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${kind} ${n}`)
    .join('、')}）、导入 ${summary.imports} 条、路由 ${summary.routes} 条`
    + `（${summary.routesWithoutFile} 条解不出文件）、${summary.bytes} 字节`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let sha = args.sha;
  let headDate = '';
  let headSubject = '';
  if (sha === null) {
    const headRes = await head(args.repo);
    if (!headRes.ok) {
      console.error(`读 HEAD 失败：${headRes.message}`);
      process.exitCode = 1;
      return;
    }
    if (headRes.data === null) {
      console.error(`镜像仓库 ${args.repo} 还没有任何提交`);
      process.exitCode = 1;
      return;
    }
    sha = headRes.data.sha;
    headDate = headRes.data.date;
    headSubject = headRes.data.subject;
  }

  if (args.rebuild) await dropIndex(db, args.repo, sha);

  const started = Date.now();
  const synced = await syncRepoIndex(db, args.repo, sha);
  const totalMs = Date.now() - started;
  if (!synced.ok) {
    console.error(`同步失败（${synced.code}）：${synced.message}`);
    process.exitCode = 1;
    return;
  }

  // 树有多大 / 有多少文件真的进索引：两趟额外的 ls-tree（**在计时之外**，只为报告）。
  const tree = await lsTreeEntries(args.repo, { ref: sha });
  const treeFiles = tree.ok ? tree.data.length : 0;
  const indexable = tree.ok
    ? tree.data.filter((entry) => /\.(?:ts|tsx|js|jsx|mjs|cjs|vue)$/i.test(entry.path)).length
    : 0;
  const stats = await blobIndexStats(db);
  const entries = await treeRows(args.repo);
  const report = synced.data.report;

  if (args.json) {
    console.log(JSON.stringify({
      repo: args.repo,
      sha,
      headDate,
      headSubject,
      treeFiles,
      indexable,
      ...report,
      totalMs,
      blobRows: stats.rows,
      blobBytes: stats.bytes,
      treeRows: entries,
      index: summarize(synced.data.index),
    }, null, 2));
    return;
  }

  console.log(`仓库      ${args.repo}@${sha.slice(0, 8)}${headDate === '' ? '' : `（${headDate}）${headSubject}`}`);
  console.log(`树        ${treeFiles} 个文件（其中 ${indexable} 个是可索引的源码）`);
  console.log(`本轮      新内容 ${report.newBlobs} 块、新映射 ${report.newEntries} 行、`
    + `复用 ${report.reusedBlobs} 块、耗时 ${report.ms} ms（整条 ${totalMs} ms）`);
  console.log(`去重      ${indexable} 个源码文件 → ${report.newBlobs + report.reusedBlobs} 块内容`);
  printSummary(synced.data.index);
  console.log(`库里      blob_index ${stats.rows} 行（${stats.bytes} 字节）／`
    + `tree_entry ${entries} 行（本仓全部提交）`);
}

await main();
await pool.end();
