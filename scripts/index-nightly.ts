#!/usr/bin/env tsx
/**
 * 索引夜间增量同步的**实现**（入口是 `scripts/index-nightly.sh`：锁、日志目录、退出码在
 * 那一层；这里只做「哪些仓 → 各自 HEAD → 各自 index-sync」）。
 *
 * 为什么不是一个纯 bash 脚本：仓列表住在 `app_settings.code.mirror.repos`，解析它的
 * 唯一权威是 `src/core/codemirror/mirror.ts` 的 `resolveMirrorConfig()`（env → 设置 →
 * 默认、整份作废不拼半份、路径必须绝对）。bash 里重写一遍那份解析，就是第二套口径——
 * 设置改成 `ssh` 或某个仓的 path 写错时，两套会给出不同答案，而这里给出的答案会
 * 悄悄「看起来跑过了」。
 *
 * 每个仓一律走 `scripts/index-sync.ts --json`（**同一个**索引路径，人手动跑的就是它），
 * 这样夜间日志里的数与本机手工验证的数可以逐字对照，不用信两套实现。
 *
 * 用法：
 *   tsx scripts/index-nightly.ts --log <path> [--help]
 *
 * 退出码：0 = 每个仓都成功（含「0 块新内容」，日志里能分辨）；3 = 至少一个仓失败
 *         （镜像连不上 / 仓没提交 / 索引失败）；2 = 读不到配置（设置或库）。
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { pool } from '../src/db/client.js';
import { head } from '../src/core/codemirror/mirror.js';
import { resolveMirrorConfig } from '../src/core/codemirror/mirror.js';
import { REPO_ROOT, dataLayout } from '../src/core/runtime-dir.js';

const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const INDEX_SYNC = path.join(REPO_ROOT, 'scripts', 'index-sync.ts');

/** 默认日志：与 `src/core/runtime-dir.ts` 的 data 根同一个地方（仓库外，git clean 碰不到）。 */
export const DEFAULT_LOG = path.join(dataLayout().root, 'logs', 'index-nightly.log');

function usage(): void {
  console.log([
    '用法：tsx scripts/index-nightly.ts --log <path>',
    '',
    '读 app_settings.code.mirror.repos，对每个仓取 HEAD，再跑 scripts/index-sync.ts。',
    `日志默认：${DEFAULT_LOG}`,
    '退出码：0 全部成功 / 3 至少一个仓失败 / 2 配置读不到。',
  ].join('\n'));
}

function parseArgs(argv: readonly string[]): { log: string } {
  let log = DEFAULT_LOG;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === '--help' || flag === '-h') {
      usage();
      process.exit(0);
    }
    if (flag === '--log') {
      log = argv[i + 1] ?? '';
      i += 1;
    }
  }
  return { log };
}

type Row = {
  ts: string;
  repo: string;
  sha: string | null;
  newBlobs: number | null;
  ms: number;
  error?: string;
};

function writeRow(log: string, row: Row): void {
  appendFileSync(log, `${JSON.stringify(row)}\n`, 'utf8');
}

/** 一行 JSON 的尾巴（`index-sync --json` 只打这一坨，但 stderr 上的警告不该混进来）。 */
function lastJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const { log } = parseArgs(process.argv.slice(2));
  mkdirSync(path.dirname(log), { recursive: true });

  const config = await resolveMirrorConfig();
  if (!config.ok) {
    // 配置读不到时**没有仓可写**：仍然留一行痕迹，否则夜里什么都没发生也看不出来。
    writeRow(log, {
      ts: new Date().toISOString(), repo: '(config)', sha: null, newBlobs: null, ms: 0,
      error: config.message,
    });
    console.error(`读不到镜像配置：${config.message}`);
    return 2;
  }

  let failed = 0;
  let newBlobs = 0;
  const started = Date.now();
  for (const repo of config.data.repos) {
    const headStarted = Date.now();
    const h = await head(repo.id);
    if (!h.ok) {
      writeRow(log, {
        ts: new Date().toISOString(), repo: repo.id, sha: null, newBlobs: null,
        ms: Date.now() - headStarted, error: h.message,
      });
      console.error(`[${repo.id}] 读 HEAD 失败：${h.message}`);
      failed += 1;
      continue;
    }
    if (h.data === null) {
      writeRow(log, {
        ts: new Date().toISOString(), repo: repo.id, sha: null, newBlobs: null,
        ms: Date.now() - headStarted, error: '镜像仓库还没有任何提交',
      });
      console.error(`[${repo.id}] 镜像仓库还没有任何提交`);
      failed += 1;
      continue;
    }

    const syncStarted = Date.now();
    // 用**当前这个 node** 起 tsx（而不是直接执行 `node_modules/.bin/tsx`）：那个入口的
    // shebang 是 `#!/usr/bin/env node`，launchd 的 PATH 里没有 node 时直接 exit 127。
    const child = spawnSync(process.execPath, [TSX, INDEX_SYNC, '--repo', repo.id, '--sha', h.data.sha, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, TZ: process.env.TZ ?? 'Asia/Shanghai' },
    });
    const ms = Date.now() - syncStarted;
    const parsed = lastJson(child.stdout ?? '') as { newBlobs?: unknown } | null;
    const blobs = typeof parsed?.newBlobs === 'number' ? parsed.newBlobs : null;

    if (child.status !== 0 || blobs === null) {
      const detail = (child.stderr ?? '').trim().split('\n').filter((line) => line !== '').slice(-3).join(' ');
      writeRow(log, {
        ts: new Date().toISOString(), repo: repo.id, sha: h.data.sha, newBlobs: null, ms,
        error: detail === '' ? `index-sync 退出码 ${String(child.status)}` : detail,
      });
      console.error(`[${repo.id}] 索引失败（${ms} ms）：${detail}`);
      failed += 1;
      continue;
    }

    newBlobs += blobs;
    writeRow(log, {
      ts: new Date().toISOString(), repo: repo.id, sha: h.data.sha, newBlobs: blobs, ms,
    });
    console.log(`[${repo.id}] ${h.data.sha.slice(0, 8)} 新内容 ${blobs} 块（${ms} ms）`);
  }

  // 收尾一行：把「这一轮算不算成功」写进日志本体——夜里的失败不该只靠退出码被发现
  // （launchd 与 cron 都不一定有人看邮件）。
  writeRow(log, {
    ts: new Date().toISOString(), repo: '(run)', sha: null, newBlobs, ms: Date.now() - started,
    ...(failed === 0 ? {} : { error: `${failed} 个仓失败` }),
  });
  return failed === 0 ? 0 : 3;
}

try {
  process.exitCode = await main();
} finally {
  await pool.end();
}
