#!/usr/bin/env tsx
/**
 * 建一份静态索引 / 看一份已有的索引。
 *
 * 存在的理由：`repoIndex` 是**懒建**的（走查/评审第一次用到某个 sha 才建），所以
 * 「现在索引里有什么、建一次多久、定位到哪个文件」在跑完整条链路之前是看不见的。
 * 这个脚本把那份数字单独打出来，owner 才能在改动前后对比，而不必先烧一次模型调用。
 *
 * 用法：
 *   npx tsx scripts/index-repo.ts --repo 123pan-uni-app --dry-run
 *   npx tsx scripts/index-repo.ts --repo 123pan-uni-app
 *   npx tsx scripts/index-repo.ts --repo 123pan-pc --sha <sha> --rebuild
 *   npx tsx scripts/index-repo.ts --repo 123pan-uni-app --dry-run \
 *     --keywords "搜索,文件,目录,上一级"
 *
 * `--dry-run` **不写库**：建索引在内存里做一次，打印同一份摘要。用来量「首建多久」
 * 而不污染库里已有的那一行。
 */
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import { locate, summarize, type CodeIndex } from '../src/core/codemirror/code-index.js';
import { buildIndex, readIndex, repoIndex } from '../src/core/codemirror/index-store.js';
import { head } from '../src/core/codemirror/mirror.js';

type Args = {
  repo: string;
  sha: string | null;
  dryRun: boolean;
  rebuild: boolean;
  keywords: string[];
};

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { repo: '', sha: null, dryRun: false, rebuild: false, keywords: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    const next = (): string => {
      const value = argv[i + 1] ?? '';
      i += 1;
      return value;
    };
    if (flag === '--repo') args.repo = next();
    else if (flag === '--sha') args.sha = next();
    else if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--rebuild') args.rebuild = true;
    else if (flag === '--keywords') args.keywords = next().split(',').map((w) => w.trim()).filter((w) => w !== '');
    else if (flag === '--help' || flag === '-h') {
      console.log('用法：tsx scripts/index-repo.ts --repo <id> [--sha <sha>] [--dry-run] [--rebuild] [--keywords a,b]');
      process.exit(0);
    }
  }
  if (args.repo === '') {
    console.error('缺 --repo <id>（例如 --repo 123pan-uni-app）');
    process.exit(2);
  }
  return args;
}

/** 一份索引的人读摘要：与 §3.6 那张表的四行数字一一对应。 */
function printSummary(index: CodeIndex, buildMs: number, locateMs: number | null): void {
  const summary = summarize(index);
  console.log(`仓库      ${index.repo}@${index.sha.slice(0, 8)}`);
  console.log(`建索引    命中已有（0 ms）/ 本次 ${buildMs} ms`);
  console.log(`文件      ${summary.files} 个（${Object.entries(summary.byKind)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${kind} ${n}`)
    .join('、')}）`);
  console.log(`导入关系  ${summary.imports} 条`);
  console.log(`路由      ${summary.routes} 条（其中 ${summary.routesWithoutFile} 条解不出文件）`);
  console.log(`索引大小  ${summary.bytes} 字节`);
  console.log('前 20 条路由：');
  for (const route of summary.topRoutes) {
    console.log(`  ${route.route.padEnd(42)} → ${route.file === '' ? '（未解析）' : route.file}`
      + `${route.title === '' ? '' : `  「${route.title}」`}`);
  }
  if (locateMs !== null) console.log(`定位耗时  ${locateMs} ms`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let sha = args.sha;
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
    console.log(`HEAD      ${sha}（${headRes.data.date}）${headRes.data.subject}`);
  }

  if (args.dryRun) {
    // --dry-run：只在内存里建，**不写库**。
    const built = await buildIndex(args.repo, sha);
    if (!built.ok) {
      console.error(`建索引失败：${built.message}`);
      process.exitCode = 1;
      return;
    }
    let locateMs: number | null = null;
    if (args.keywords.length > 0) {
      const started = Date.now();
      const probes = locate(built.data.index, args.keywords);
      locateMs = Date.now() - started;
      console.log(`关键词    ${args.keywords.join('、')}`);
      probes.forEach((probe, i) => console.log(`  ${i + 1}. [${probe.score}] ${probe.path}  —— ${probe.why}`));
    }
    printSummary(built.data.index, built.data.buildMs, locateMs);
    console.log('（--dry-run：没有写库）');
    return;
  }

  const cached = await readIndex(db, args.repo, sha);
  const started = Date.now();
  const resolved = await repoIndex(db, args.repo, sha, { rebuild: args.rebuild });
  const totalMs = Date.now() - started;
  if (!resolved.ok) {
    console.error(`建索引失败：${resolved.message}`);
    process.exitCode = 1;
    return;
  }
  let locateMs: number | null = null;
  if (args.keywords.length > 0) {
    const locateStarted = Date.now();
    const probes = locate(resolved.data.index, args.keywords);
    locateMs = Date.now() - locateStarted;
    console.log(`关键词    ${args.keywords.join('、')}`);
    probes.forEach((probe, i) => console.log(`  ${i + 1}. [${probe.score}] ${probe.path}  —— ${probe.why}`));
  }
  console.log(`本轮      ${resolved.data.built ? `刚建（${resolved.data.buildMs} ms）` : '命中已有索引'}`
    + `，走完 ${totalMs} ms${cached === null ? '' : '（库里本来就有）'}`);
  printSummary(resolved.data.index, resolved.data.buildMs, locateMs);

  // 2026-11-08（P4-11）：索引的规模看的是 `blob_index` 的**行数**（内容地址，跨仓共享），
  // 不是「几份快照」。旧表 `code_index` 已经不再被写，不再报它。
  const rows = await db.execute<{ n: number; bytes: string }>(sql`
    select count(*)::int as n, coalesce(sum(pg_column_size(blob_index)), 0)::text as bytes
      from blob_index`);
  console.log(`库里共    ${rows.rows[0]?.n ?? 0} 块已解析内容，占 ${rows.rows[0]?.bytes ?? '0'} 字节`);
}

await main();
await pool.end();
