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
 *   npx tsx scripts/index-sync.ts --repo 123pan-uni-app --force-reparse
 *
 * `--rebuild` 只清掉这个 `(repo, sha)` 的装配缓存（**不动 blob 行**）：内容地址是跨仓
 * 共享的，删它会让别的仓一起掉内容。
 *
 * `--force-reparse` 才是「按新口径重解析一遍」：解析器改了口径（0032 的 outline /
 * pages 就是这种情况）之后，库里那些行还在、`on conflict do nothing` 会让它们永远
 * 不被重写。所以它先 `ls-tree` 拿到这一棵树用到的 blob id，`forgetBlobs()` 删掉那些
 * 行，再同步——这一次每块内容都会真的被解析。**代价必须知道**：这些行是跨仓共享的，
 * 删掉之后别的仓、别的提交下一次装配会当场自愈（重解析一次），所以它是一次「全量
 * 重扫」而不是一次「增量」。
 */
import { db, pool } from '../src/db/client.js';
import { blobIndexStats, forgetBlobs } from '../src/core/codemirror/blob-index.js';
import { summarize, type CodeIndex } from '../src/core/codemirror/code-index.js';
import { dropIndex, syncRepoIndex } from '../src/core/codemirror/index-store.js';
import { head, lsTreeEntries } from '../src/core/codemirror/mirror.js';

type Args = {
  repo: string;
  sha: string | null;
  rebuild: boolean;
  /** 按新口径重解析这个提交用到的每一块内容（删 blob 行再同步）。 */
  forceReparse: boolean;
  json: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { repo: '', sha: null, rebuild: false, forceReparse: false, json: false };
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
    else if (flag === '--force-reparse') args.forceReparse = true;
    else if (flag === '--json') args.json = true;
    else if (flag === '--help' || flag === '-h') {
      console.log('用法：tsx scripts/index-sync.ts --repo <id> [--sha <sha>] [--rebuild] [--force-reparse] [--json]');
      process.exit(0);
    }
  }
  if (args.repo === '') {
    console.error('缺 --repo <id>（例如 --repo 123pan-uni-app）');
    process.exit(2);
  }
  return args;
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

  if (args.rebuild) dropIndex(args.repo, sha);

  // 重解析：删掉这一棵树用到的内容行（跨仓共享，别的仓下次装配会当场自愈）。
  let reparsed = 0;
  if (args.forceReparse) {
    const tree = await lsTreeEntries(args.repo, { ref: sha });
    if (!tree.ok) {
      console.error(`读不到 ${args.repo}@${sha.slice(0, 8)} 的树：${tree.message}`);
      process.exitCode = 1;
      return;
    }
    reparsed = await forgetBlobs(db, tree.data.map((entry) => entry.oid));
    dropIndex(args.repo, sha);
  }

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
      forceReparse: reparsed,
      blobRows: stats.rows,
      blobBytes: stats.bytes,
      index: summarize(synced.data.index),
    }, null, 2));
    return;
  }

  console.log(`仓库      ${args.repo}@${sha.slice(0, 8)}${headDate === '' ? '' : `（${headDate}）${headSubject}`}`);
  console.log(`树        ${treeFiles} 个文件（其中 ${indexable} 个是可索引的源码）`);
  // 没有「新映射」这个数了：0030 删掉 tree_entry 之后，装配是现读 `ls-tree`，一行都不写。
  console.log(`本轮      新内容 ${report.newBlobs} 块、复用 ${report.reusedBlobs} 块、`
    + `耗时 ${report.ms} ms（整条 ${totalMs} ms，含一次 ls-tree）`);
  console.log(`去重      ${indexable} 个源码文件 → ${report.newBlobs + report.reusedBlobs} 块内容`);
  if (args.forceReparse) console.log(`重解析    删掉 ${reparsed} 块内容行，这一轮按新口径重新解析`);
  printSummary(synced.data.index);
  const fromConfig = synced.data.index.pages.filter((page) => page.source === 'pages.json').length;
  console.log(`页面清单  ${synced.data.index.pages.length} 条（pages.json ${fromConfig} 条、`
    + `目录约定 ${synced.data.index.pages.length - fromConfig} 条）、`
    + `组件轮廓 ${Object.keys(synced.data.index.outline).length} 个文件`);
  console.log(`库里      blob_index ${stats.rows} 行（${stats.bytes} 字节）——这套索引只有这一张表`);
}

await main();
await pool.end();
