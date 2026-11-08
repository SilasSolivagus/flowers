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
 * 每个仓处理完就写一行 `mirror_health`（迁移 0031），循环结束再判一次新鲜度：
 * 「这个仓的代码停在哪天」必须落库，否则它只活在这份日志里，而日志没人读
 * （2026-11-08 第一环失败那天就是这样，`123pan-cross-frontend` 停在 10-21 十几天）。
 * 判完变旧的仓会写一条 `mirror.stale` 事件（超管在铃铛里看到），所以这里不需要
 * 第二个 scheduler——检查住在**已经每天在跑的那件事**里。
 *
 * 退出码：0 = 每个仓都成功（含「0 块新内容」，日志里能分辨）；3 = 至少一个仓失败
 *         （镜像连不上 / 仓没提交 / 索引失败 / 新鲜度检查本身出错）；2 = 读不到配置
 *         （设置或库）。
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { db, pool } from '../src/db/client.js';
import { head } from '../src/core/codemirror/mirror.js';
import { resolveMirrorConfig } from '../src/core/codemirror/mirror.js';
import { checkMirrorFreshness, recordMirrorHealth } from '../src/core/codemirror/health.js';
import { readRepoInventory, staleThresholdsOf } from '../src/core/codemirror/repo-inventory.js';
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

  // 清单 vs 设置的漂移：这一层**仍然按设置跑**（`resolveMirrorConfig()` 是唯一权威：
  // 传输方式、path 都在那一份里），但清单是「人以为有哪些仓」的那份。两者不一致时，
  // 夜里的日志必须说出来——2026-11-08 的 `123pan-cross-frontend` 正是「设置里有、
  // shell 数组里没有」：服务器不抓、镜像停在 10-21，而这里一片绿。
  //
  // 只记一行、不改退出码：这是**告警**（下一步是跑 `scripts/repos-apply.ts`），
  // 不是这次的同步失败——把告警塞进退出码会让「3 = 至少一个仓失败」这句话变模糊。
  // 按仓的陈旧阈值：与漂移检查共用**同一次**清单读取（同一个文件、同一轮判断）。
  // 读不到清单时留 `undefined`，`checkMirrorFreshness` 就退回全局 7 天——一条坏掉的
  // 清单不该把新鲜度检查也一起变成瞎的，但要在日志里说清它退回了哪种口径。
  let thresholds: Record<string, number | null> | undefined;
  try {
    const inventory = await readRepoInventory();
    if (inventory.ok) {
      thresholds = staleThresholdsOf(inventory.data.inventory.repos);
      const listed = inventory.data.inventory.repos.map((entry) => entry.id);
      const configured = config.data.repos.map((repo) => repo.id);
      const missing = listed.filter((id) => !configured.includes(id));
      const extra = configured.filter((id) => !listed.includes(id));
      if (missing.length > 0 || extra.length > 0) {
        const detail = [
          missing.length === 0 ? '' : `清单有、设置没有：${missing.join('、')}`,
          extra.length === 0 ? '' : `设置有、清单没有：${extra.join('、')}`,
        ].filter((part) => part !== '').join('；');
        writeRow(log, {
          ts: new Date().toISOString(), repo: '(inventory)', sha: null, newBlobs: null, ms: 0,
          error: `${detail}（跑 scripts/repos-apply.ts 对齐）`,
        });
        console.error(`仓清单与设置漂移：${detail}`);
      }
    } else {
      // 清单读不到不算失败（可能还没建），但要说一句：这个检查从此是瞎的。
      writeRow(log, {
        ts: new Date().toISOString(), repo: '(inventory)', sha: null, newBlobs: null, ms: 0,
        error: `读不到仓清单，漂移检查跳过：${inventory.message}`,
      });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeRow(log, {
      ts: new Date().toISOString(), repo: '(inventory)', sha: null, newBlobs: null, ms: 0,
      error: `漂移检查出错（不影响本轮同步）：${detail}`,
    });
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
      // sha / date 传 null：**不抹掉**上一次已知的 HEAD（`recordMirrorHealth` 用
      // coalesce 保留）。读者仍要能说出「它停在 2026-10-21」，那是通知正文里最有用的一半。
      await recordMirrorHealth(db, {
        repo: repo.id, headSha: null, headDate: null, ok: false, error: h.message,
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
      await recordMirrorHealth(db, {
        repo: repo.id, headSha: null, headDate: null, ok: false,
        error: '镜像仓库还没有任何提交',
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
      // HEAD 读到了（sha / date 是这一轮的），但索引没跟上：`ok = false` 且**带上**
      // 它读到的那一天——下一轮判新鲜度时，这行说的是「代码到 10-21，索引失败」。
      await recordMirrorHealth(db, {
        repo: repo.id, headSha: h.data.sha, headDate: h.data.date, ok: false,
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
    await recordMirrorHealth(db, {
      repo: repo.id, headSha: h.data.sha, headDate: h.data.date, ok: true, error: null,
    });
    console.log(`[${repo.id}] ${h.data.sha.slice(0, 8)} 新内容 ${blobs} 块（${ms} ms）`);
  }

  // 新鲜度：判的是**刚才写下的那些行**，所以只能在循环之后。判的仓列表来自配置
  // （不是表），理由见 `health.ts` 文件头第 4 条。它自己出错也算这一轮失败：一条
  // 「检查坏了」的静默，等于把这一项又变回日志里的一句话。
  try {
    const healthStarted = Date.now();
    const alerts = await checkMirrorFreshness(db, {
      repos: config.data.repos.map((repo) => repo.id),
      now: new Date(),
      ...(thresholds === undefined ? {} : { staleAfterDays: thresholds }),
    });
    for (const alert of alerts) {
      console.log(`[${alert.repo}] 镜像变旧：${alert.reason === 'failed' ? alert.error : `${alert.days} 天前`}`);
    }
    writeRow(log, {
      ts: new Date().toISOString(), repo: '(health)', sha: null, newBlobs: null,
      ms: Date.now() - healthStarted,
      ...(alerts.length === 0 ? {} : { error: `已提醒 ${alerts.map((a) => a.repo).join('、')}` }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeRow(log, {
      ts: new Date().toISOString(), repo: '(health)', sha: null, newBlobs: null, ms: 0,
      error: `新鲜度检查失败：${detail}`,
    });
    console.error(`新鲜度检查失败：${detail}`);
    failed += 1;
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
