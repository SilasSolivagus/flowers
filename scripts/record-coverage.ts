#!/usr/bin/env tsx
/**
 * 手工落一行 `repo_coverage`（带理由）——**只给「管道自己产不出这一行」的仓用**。
 *
 * ── 为什么需要有这个口子
 *
 * 「不遗不漏」的验收式子是 `count(ok) + count(ok=false) = 仓数`（减去显式排除）。而有两类
 * 仓永远走不到 `onboard-repos.ts` 的 `recordCoverage`：
 *
 * 1. **抽取把进程挂死**（同步阻塞，看门狗也不触发）——`platform-fontend` 实测；
 * 2. 镜像/HEAD 之外的环境问题（比如服务器盘满、ssh 在某次批量里整段坏掉），人只想记一条
 *    「本轮没测成，原因是 X」，而不是把整批重跑一遍。
 *
 * 没有这个口子，那两类仓在表里**一行都没有**——「没有行」和「测过且失败」在报告里长得
 * 一样，而这正是这张表存在的理由（一个仓要么被索引，要么**被明确记录为读不了，且有可查的
 * 原因**）。
 *
 * ── 它故意长得很别扭
 *
 * `--reason` 必填且必须是一句中文；写的是 `ok = false`（这个工具**不**能用来把一个仓
 * 标成成功）；`--head` 只在真的读到过 HEAD 时给。目的是让「手工记账」在表里留痕：
 * `head_sha` 是空的还是真的，读的人一眼能看出来。
 *
 * 用法：
 *   npx tsx scripts/record-coverage.ts --repo platform-fontend \
 *     --reason "索引挂起：抽取阶段同步阻塞（250 s 无进展，连 --index-timeout-s 都不触发）" \
 *     --head ee47b36de39c20f8ce96dd97861a0d65ef3586f8
 *
 * 退出码：0 写入成功 / 2 参数不合法或仓名不在清单里。
 */
import { db, pool } from '../src/db/client.js';
import { readCoverage, recordCoverage } from '../src/core/codemirror/repo-coverage.js';
import { readRepoInventory } from '../src/core/codemirror/repo-inventory.js';

type Args = { repo: string; reason: string; head: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { repo: '', reason: '', head: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === '--repo') { args.repo = argv[i + 1] ?? ''; i += 1; }
    else if (flag === '--reason') { args.reason = argv[i + 1] ?? ''; i += 1; }
    else if (flag === '--head') { args.head = argv[i + 1] ?? null; i += 1; }
    else if (flag === '--help' || flag === '-h') {
      console.log('用法：tsx scripts/record-coverage.ts --repo <仓名> --reason <中文原因> [--head <sha>]');
      process.exit(0);
    }
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.repo.trim() === '' || args.reason.trim() === '') {
    console.error('必须给 --repo 与 --reason（理由不能空：这一列就是这张表的全部价值）');
    return 2;
  }
  // 只允许给**清单里有的**仓记账：仓名拼错会悄悄造出一个永远不存在的仓的一行，
  // 而那一行会让 `count(ok)+count(false)` 的等式看起来是对的、实际是错的。
  const inv = await readRepoInventory();
  if (!inv.ok) {
    console.error(inv.message);
    return 2;
  }
  if (!inv.data.inventory.repos.some((entry) => entry.id === args.repo)) {
    console.error(`仓「${args.repo}」不在 config/repos.txt 里：先把它加进清单，再记账`);
    return 2;
  }
  const existing = await readCoverage(db, args.repo);
  await recordCoverage(db, {
    repo: args.repo,
    headSha: args.head ?? existing?.headSha ?? null,
    headDate: existing?.headDate ?? null,
    filesTotal: existing?.filesTotal ?? 0,
    filesIndexed: existing?.filesIndexed ?? 0,
    filesSkippedGenerated: existing?.filesSkippedGenerated ?? 0,
    pages: existing?.pages ?? 0,
    outlineFiles: existing?.outlineFiles ?? 0,
    imports: existing?.imports ?? 0,
    ok: false,
    error: args.reason.trim(),
  });
  console.log(`已记：${args.repo} ok=false（${args.reason.trim()}）`);
  return 0;
}

try {
  process.exitCode = await main();
} finally {
  await pool.end();
}
