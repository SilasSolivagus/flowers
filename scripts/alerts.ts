/**
 * 告警一轮（2026-11-11，H1 P0）。
 *
 *   npx tsx scripts/alerts.ts            # 只报不送（默认）
 *   npx tsx scripts/alerts.ts --apply    # 真发到群机器人（6 小时冷却）
 *
 * 默认 dry-run：告警是一件会吵到人的事，第一次跑先看清它会说什么。
 */
import { pool } from '../src/db/client.js';
import { runAlerts } from '../src/core/alerts/run.js';

const apply = process.argv.includes('--apply');

const run = await runAlerts({ dryRun: !apply });
console.log(JSON.stringify({
  checkedAt: run.checkedAtIso,
  dryRun: run.dryRun,
  snapshot: run.snapshot,
  alerts: run.alerts.map((a) => `${a.level} ${a.title}：${a.detail}`),
  sent: run.sent,
  suppressed: run.suppressed,
  failed: run.failed,
}, null, 2));

await pool.end();
process.exit(run.failed.length > 0 ? 2 : 0);
