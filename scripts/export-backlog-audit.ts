#!/usr/bin/env tsx
/**
 * 纯只读导出 Flower 存量异常需求卡对账单（33 条缺版本时钟跳过卡 + 20 组同名重复卡）。
 *
 *   npx tsx scripts/export-backlog-audit.ts                       # 打印到 stdout
 *   npx tsx scripts/export-backlog-audit.ts --out /path/audit.md  # 写入指定文件
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { db, pool } from '../src/db/client.js';
import {
  collectBacklogAudit,
  renderBacklogAuditMarkdown,
} from '../src/core/requirements/backlog-audit.js';

function parseArgs(argv: string[]): { outPath: string | null } {
  let outPath: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--out') {
      const val = argv[i + 1];
      if (!val || val.startsWith('--')) {
        throw new Error('--out 需要指定输出文件路径');
      }
      outPath = resolve(val);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('用法：tsx scripts/export-backlog-audit.ts [--out <path>]\n');
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}（只认 --out <path>）`);
    }
  }
  return { outPath };
}

const { outPath } = parseArgs(process.argv.slice(2));

try {
  const audit = await collectBacklogAudit(db, new Date());
  const markdown = renderBacklogAuditMarkdown(audit);
  if (outPath !== null) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, markdown, 'utf8');
    process.stdout.write(
      `已导出只读对账单：${outPath}（缺版本卡 ${audit.missingReleaseCards.length} 条 · 同名重复 ${audit.duplicateGroups.length} 组）\n`,
    );
  } else {
    process.stdout.write(markdown);
  }
} finally {
  await pool.end();
}
