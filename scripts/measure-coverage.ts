#!/usr/bin/env tsx
/**
 * 补测覆盖率：对 `config/repos.txt` 里的**每一个仓**量一行 `repo_coverage`，**不克隆、不走 ssh**。
 *
 * ── 为什么需要这个脚本（而不是再跑一次 `onboard-repos.ts`）
 *
 * `onboard-repos.ts` 是**接入**流程：它的活是「服务器上还没有 → 建 bare 仓 → 索引 → 记账」，
 * 所以它写死 `ssh <host> git …`，并在 `transport !== 'ssh'` 时直接退出（对它是对的：
 * 它的参数是服务器约定：盘在哪、`du`/`df` 怎么读）。
 *
 * 2026-11-09 的 cutover 把镜像搬到了本机盘（`transport = local`），于是「量覆盖率」这件事
 * 跟着接入那套一起离线了：`repo_coverage` 里只有 codeup 那一批，GitLab 那 75 个仓
 * **一行都没有**。表看起来是完整的，缺口却是安静的。
 *
 * 测量本身不依赖传输方式：`measureRepo()`（`src/core/codemirror/coverage-measure.ts`）
 * 走 `mirror.ts` 的只读层，`local` / `ssh` 两种都认。所以这里的活只有三件：
 * 读清单 → 逐仓 `head()` + `measureRepo()` + `recordCoverage()` → 把结果说清楚。
 *
 * ── 它记什么、不记什么
 *
 * - 记：`files_total`（`ls-tree` 去噪后的文件数）、`files_indexed`、`files_skipped_generated`、
 *   `pages`、`outline_files`、`imports`、`ok`、`error` —— 与 `onboard-repos.ts` **同一份**
 *   测量代码、**同一行**形状；
 * - 不记：镜像大小、clone 结果、磁盘闸。那些是部署事实，不是覆盖率。
 *
 * ── 用法
 *
 *   npx tsx scripts/measure-coverage.ts                 # 全清单，逐个重测
 *   npx tsx scripts/measure-coverage.ts --resume        # 同一个 HEAD 且上一轮 ok 的跳过
 *   npx tsx scripts/measure-coverage.ts --only fe-tool  # 只测一个（调试用）
 *   npx tsx scripts/measure-coverage.ts --json          # 给上层脚本
 *
 * 退出码：0 全部 ok（含跳过）/ 3 至少一个仓 ok=false / 2 清单或配置读不到。
 */
import { readFile } from 'node:fs/promises';

import path from 'node:path';

import { db, pool } from '../src/db/client.js';
import { measureRepo, zeroCauseOf, type ZeroCause } from '../src/core/codemirror/coverage-measure.js';
import { head, lsTreeEntries, resolveMirrorConfig, type MirrorResult } from '../src/core/codemirror/mirror.js';
import {
  recordCoverage, readCoverage, shouldSkip, listCoverage, type CoverageRow,
} from '../src/core/codemirror/repo-coverage.js';
import {
  inventoryPath, inventoryToRepos, readRepoInventory, reposSettingJson, REPO_EXCLUDED_PATH,
  type InventoryLine, type RepoSource,
} from '../src/core/codemirror/repo-inventory.js';
import { REPO_ROOT } from '../src/core/runtime-dir.js';

type Args = {
  resume: boolean;
  only: string | null;
  json: boolean;
  /** 单仓索引的墙钟上限。**同步死循环会无视它**（事件循环都不转），所以只用来看异步卡住。 */
  indexTimeoutMs: number;
};

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { resume: false, only: null, json: false, indexTimeoutMs: 120_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === '--resume') args.resume = true;
    else if (flag === '--only') { args.only = argv[i + 1] ?? null; i += 1; }
    else if (flag === '--json') args.json = true;
    else if (flag === '--index-timeout-s') {
      const value = Number(argv[i + 1] ?? '');
      if (Number.isFinite(value) && value > 0) args.indexTimeoutMs = Math.round(value * 1000);
      i += 1;
    } else if (flag === '--help' || flag === '-h') {
      console.log('用法：tsx scripts/measure-coverage.ts [--resume] [--only <仓名>] [--json] [--index-timeout-s N]');
      process.exit(0);
    }
  }
  return args;
}

/** 一行结果的内部形状（打印与 JSON 都用它）。 */
type Outcome = {
  repo: string;
  source: RepoSource | 'excluded';
  ok: boolean;
  headSha: string | null;
  filesTotal: number;
  filesIndexed: number;
  filesSkippedGenerated: number;
  pages: number;
  outlineFiles: number;
  imports: number;
  error: string | null;
  zeroCause: ZeroCause | null;
  ms: number;
};

type ExcludedEntry = { path: string; id: string; reason: string };

/** `config/repos-excluded.txt`：`<组路径><TAB><理由>`。读不到就当没有（它不是清单）。 */
async function readExcluded(): Promise<ExcludedEntry[]> {
  let text = '';
  try {
    text = await readFile(path.join(REPO_ROOT, REPO_EXCLUDED_PATH), 'utf8');
  } catch {
    return [];
  }
  const out: ExcludedEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [fullPath, ...rest] = line.split('\t');
    const clean = (fullPath ?? '').trim();
    if (clean === '') continue;
    const segments = clean.split('/');
    out.push({ path: clean, id: segments.at(-1) ?? clean, reason: rest.join(' ').trim() });
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const loaded = await readRepoInventory(inventoryPath());
  if (!loaded.ok) {
    console.error(loaded.message);
    return 2;
  }
  const { inventory } = loaded.data;
  // 仓列表注入 `resolveMirrorConfig()` 的最优先级来源：`transport` / `sshHost` 仍从设置读，
  // 只有 `repos` 被清单盖住——与 `onboard-repos.ts` 同一条路，所以两边的 `head()` /
  // `lsTreeEntries()` / 索引装配认的是同一批仓。
  process.env.FLOWERS_MIRROR_REPOS = reposSettingJson(inventoryToRepos(inventory.repos));
  const config = await resolveMirrorConfig();
  if (!config.ok) {
    console.error(`读不到镜像配置：${config.message}`);
    return 2;
  }

  const targets: InventoryLine[] = args.only === null
    ? inventory.repos
    : inventory.repos.filter((entry) => entry.id === args.only);
  if (targets.length === 0) {
    console.error(`清单里没有仓「${args.only ?? ''}」`);
    return 2;
  }

  const excluded = await readExcluded();
  console.log(`清单      ${loaded.data.file}（${inventory.repos.length} 个仓，本轮 ${targets.length} 个）`);
  console.log(`镜像传输  ${config.data.transport}${config.data.transport === 'ssh' ? `（${config.data.sshHost}）` : ''}`);
  console.log(`显式排除  ${excluded.length} 个（见 ${REPO_EXCLUDED_PATH}，单独列出，不进表）`);

  const outcomes: Outcome[] = [];
  const startedAll = Date.now();

  for (const entry of targets) {
    const started = Date.now();
    const base: Outcome = {
      repo: entry.id, source: entry.source, ok: false, headSha: null, filesTotal: 0, filesIndexed: 0,
      filesSkippedGenerated: 0, pages: 0, outlineFiles: 0, imports: 0, error: null, zeroCause: null, ms: 0,
    };
    try {
      if (args.resume) {
        const existing = await readCoverage(db, entry.id);
        const headRes = await head(entry.id);
        if (headRes.ok && headRes.data !== null && shouldSkip(existing, headRes.data.sha)) {
          const row: Outcome = {
            ...base, ok: true, headSha: headRes.data.sha,
            filesTotal: existing?.filesTotal ?? 0,
            filesIndexed: existing?.filesIndexed ?? 0,
            filesSkippedGenerated: existing?.filesSkippedGenerated ?? 0,
            pages: existing?.pages ?? 0,
            outlineFiles: existing?.outlineFiles ?? 0,
            imports: existing?.imports ?? 0,
            ms: Date.now() - started,
          };
          outcomes.push(row);
          console.log(`[${entry.id}] 跳过（同一个 HEAD 已测过且 ok）`);
          continue;
        }
      }

      const headRes: MirrorResult<{ sha: string; date: string; subject: string } | null> = await head(entry.id);
      if (!headRes.ok || headRes.data === null) {
        const error = headRes.ok ? '镜像里没有任何提交' : headRes.message;
        // 读不到 HEAD 就**不猜**任何数：一行 `ok=false` + 原因，比五行半真的数有用。
        await recordCoverage(db, {
          repo: entry.id, headSha: null, headDate: null, filesTotal: 0, filesIndexed: 0,
          filesSkippedGenerated: 0, pages: 0, outlineFiles: 0, imports: 0, ok: false, error,
        });
        base.error = error;
        base.ms = Date.now() - started;
        outcomes.push(base);
        console.error(`[${entry.id}] 失败：${error}`);
        continue;
      }

      const measured = await withTimeout(measureRepo(db, entry.id, headRes.data.sha), args.indexTimeoutMs);
      if (!measured.ok) {
        await recordCoverage(db, {
          repo: entry.id, headSha: headRes.data.sha, headDate: headRes.data.date,
          filesTotal: 0, filesIndexed: 0, filesSkippedGenerated: 0, pages: 0, outlineFiles: 0,
          imports: 0, ok: false, error: measured.error,
        });
        base.error = measured.error;
        base.headSha = headRes.data.sha;
        base.ms = Date.now() - started;
        outcomes.push(base);
        console.error(`[${entry.id}] 失败：${measured.error}`);
        continue;
      }

      const row: CoverageRow = {
        repo: entry.id, headSha: headRes.data.sha, headDate: headRes.data.date,
        ...measured.counts, ok: true, error: null,
      };
      await recordCoverage(db, row);

      // `files_indexed = 0` 是这张表要解释的那一格：真去列一次树，按扩展名给一个词的原因。
      let zeroCause: ZeroCause | null = null;
      if (measured.counts.filesIndexed === 0) {
        const tree = await lsTreeEntries(entry.id, { ref: headRes.data.sha });
        zeroCause = zeroCauseOf(tree.ok ? tree.data : [], measured.counts.filesSkippedGenerated);
      }

      const outcome: Outcome = {
        repo: entry.id, source: entry.source, ok: true, headSha: headRes.data.sha,
        ...measured.counts, error: null, zeroCause, ms: Date.now() - started,
      };
      outcomes.push(outcome);
      console.log(
        `[${entry.id}] ok  files ${String(outcome.filesTotal)}`
        + ` → indexed ${String(outcome.filesIndexed)}`
        + `（generated ${String(outcome.filesSkippedGenerated)}）`
        + ` pages ${String(outcome.pages)} outline ${String(outcome.outlineFiles)}`
        + ` imports ${String(outcome.imports)}  ${String(outcome.ms)}ms`
        + (zeroCause === null ? '' : `  原因=${zeroCause}`),
      );
    } catch (error) {
      // 一个仓的任何异常都不许逸出：批量的价值在于「其余 215 个照跑」。
      const detail = error instanceof Error ? error.message : String(error);
      base.error = `测量抛错：${detail}`;
      base.ms = Date.now() - started;
      outcomes.push(base);
      console.error(`[${entry.id}] 抛错：${detail}`);
    }
  }

  const elapsedMs = Date.now() - startedAll;
  const okRows = outcomes.filter((outcome) => outcome.ok);
  const badRows = outcomes.filter((outcome) => !outcome.ok);
  const zeroRows = okRows.filter((outcome) => outcome.filesIndexed === 0);
  const causeCounts = new Map<string, number>();
  for (const row of zeroRows) {
    const key = row.zeroCause ?? 'other';
    causeCounts.set(key, (causeCounts.get(key) ?? 0) + 1);
  }

  console.log('');
  console.log(`ok=true   ${okRows.length}`);
  console.log(`ok=false  ${badRows.length}`);
  for (const row of badRows) console.log(`  × ${row.repo}：${row.error ?? ''}`);
  console.log(`files_indexed=0  ${zeroRows.length}`);
  for (const row of zeroRows) console.log(`  · ${row.repo}（${row.zeroCause ?? 'other'}，树里 ${row.filesTotal} 个文件）`);
  console.log(`原因分布  ${[...causeCounts].map(([cause, count]) => `${cause} ${count}`).join(' / ')}`);
  console.log('');
  console.log('显式排除（不进表，必须单独列出，不许静默消失）：');
  for (const entry of excluded) console.log(`  ⊘ ${entry.id}：${entry.reason}`);
  console.log('');
  console.log(`耗时 ${(elapsedMs / 1000).toFixed(1)} s`);

  if (args.json) {
    const dbRows = await listCoverage(db);
    console.log(JSON.stringify({
      measured: outcomes.length,
      ok: okRows.length,
      failed: badRows.length,
      zeroIndexed: zeroRows.map((row) => ({ repo: row.repo, cause: row.zeroCause })),
      causeCounts: Object.fromEntries(causeCounts),
      excluded: excluded.map((entry) => ({ id: entry.id, path: entry.path, error: entry.reason })),
      rowsInTable: dbRows.length,
      okInTable: dbRows.filter((row) => row.ok).length,
      elapsedMs,
    }));
  }

  return badRows.length === 0 ? 0 : 3;
}

/** 异步上界。**它的边界写在 `onboard-repos.ts` 里**：同步死循环不响应它。 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | { ok: false; error: string }> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<{ ok: false; error: string }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ ok: false, error: `索引超过 ${Math.round(ms / 1000)} 秒没有返回（异步挂住，不是解析慢）` });
    }, ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

try {
  process.exitCode = await main();
} finally {
  await pool.end();
  // 被 withTimeout 放掉的那条 promise 还占着句柄，`pool.end()` 等不到它；不硬退就是挂住。
  setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref();
}
