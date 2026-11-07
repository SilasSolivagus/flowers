#!/usr/bin/env tsx
/**
 * 把「待排期」的需求导成一张企微智能表格——**命令行入口**。
 *
 * 这一层只剩三件事：读 argv、打印、关连接池。真正的活（查哪些行、九列怎么拼、
 * CLI 怎么调、失败怎么说）全在 `src/core/export/queue.ts` 里，因为看板「待排期」
 * 列头那个「导出」按钮走的是**同一个函数**（P1b）。两边各留一份的实现，第一次
 * 改列序就会分岔，而这种事没人会去比对。
 *
 * 用法：
 *   npx tsx scripts/export-queue.ts             # 建一张新表，打印链接
 *   npx tsx scripts/export-queue.ts --dry-run   # 只打印将要写入的行，不建表
 *
 * 曾经写在这里的 `--append <docid|url>` 已经删掉：它只出现在这段注释里，代码里
 * 从来没有过这条分支（读注释的人会以为能追加，跑了才发现参数被忽略）。真要做
 * 追加，那是 `exportQueue` 的一个新入参，不是脚本多认一个 flag。
 */
import { pool } from '../src/db/client.js';
import {
  QUEUE_COLUMNS, exportQueue, loadQueueRows, recordValues,
} from '../src/core/export/queue.js';

const dryRun = process.argv.slice(2).includes('--dry-run');

if (dryRun) {
  const rows = await loadQueueRows();
  if (rows.length === 0) {
    console.log('待排期是空的，没有可导出的行。');
  } else {
    console.log(`${rows.length} 行，${QUEUE_COLUMNS.length} 列（${QUEUE_COLUMNS.join(' / ')}）`);
    for (const row of rows) {
      const values = recordValues(row);
      console.log(`  ${values.编号}  ${values.标题}  ${values.负责人}  ${values.停留天数} 天`);
    }
  }
} else {
  const outcome = await exportQueue();
  if (!outcome.ok) {
    // 失败说明中文原样打到 stderr，并以非 0 退出：脚本被别的脚本调用时也能判成败。
    console.error(outcome.message);
    process.exitCode = 1;
  } else {
    console.log(`已建表：${outcome.name} · ${outcome.rows} 行`);
    if (outcome.url !== '') console.log(outcome.url);
    console.log(`docid: ${outcome.docid}`);
  }
}

await pool.end();
