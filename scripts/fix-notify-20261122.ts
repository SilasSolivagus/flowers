#!/usr/bin/env tsx
/**
 * 2026-11-22 一次性修复：作废 9 条卡死重发的历史失败个人通知、关闭赵越直推、核验房超通道。
 *
 *   npx tsx scripts/fix-notify-20261122.ts            # 默认 dry-run 预览
 *   npx tsx scripts/fix-notify-20261122.ts --apply    # 真正执行落库
 */
import { db, pool } from '../src/db/client.js';
import { applyNotifyCleanup20261122 } from '../src/core/notify/cleanup-20261122.js';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write('用法：tsx scripts/fix-notify-20261122.ts [--dry-run | --apply]\n');
  process.exit(0);
}
for (const arg of argv) {
  if (arg !== '--dry-run' && arg !== '--apply') {
    process.stderr.write(`未知参数：${arg}（只认 --dry-run / --apply）\n`);
    process.exit(2);
  }
}

const apply = argv.includes('--apply');

try {
  const res = await applyNotifyCleanup20261122(db, { dryRun: !apply });
  process.stdout.write(
    `=== Flower 个人推送清理（${res.dryRun ? 'DRY-RUN 预览' : 'APPLY 已执行'}）===\n`,
  );
  process.stdout.write(`1. 历史卡死 failed 通知作废：${res.voidedCount} 条\n`);
  for (const item of res.voidedItems) {
    process.stdout.write(
      `   - ${item.memberName} seq=${item.eventSeq} (${item.createdAt}) id=${item.id}\n`,
    );
  }
  process.stdout.write(
    `2. 赵越个人企微直推：${res.zhaoDisabled ? `已设为 ${res.zhaoPrefsAfter}（保留站内与群播报）` : '未找到成员'}\n`,
  );
  process.stdout.write(
    `3. 房超个人通道：userid=${res.fangUserid ?? '无'} · 清理旧个人 webhook=${res.fangWebhookCleared} · 核验=${res.fangVerifyDetail}\n`,
  );
  if (!res.fangVerified) {
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
