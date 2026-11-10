/**
 * 把「进了待排期」的需求写进企微汇总表（2026-11-10）。
 *
 * ```bash
 * npx tsx scripts/sheet-sync.ts              # 扫一轮（pending + failed）
 * npx tsx scripts/sheet-sync.ts --limit 20   # 这轮最多处理 20 条（默认 50）
 * ```
 *
 * 这个脚本本身不含规则：行怎么拼、A 列怎么去重、失败怎么记，全在
 * `src/core/sheet/`。这一层只做三件事——解析开关、调一次、把摘要打到 stdout。
 *
 * **为什么是脚本而不是请求里直接写**：见 `src/core/sheet/sync.ts` 的文件头。一句话——
 * 状态迁移不该被企微的可用性绑住。运维上它与 `scripts/wecom-dispatch.ts` 是同一类东西
 * （一个定时任务），cron 里两条并排即可：
 *
 * 每 10 分钟一次（cron 里那一行的分字段写 0,10,20,...，别写星号斜杠——它会提前关掉
 * 注释）：
 * `cd /path/to/flowers && npx tsx scripts/sheet-sync.ts >> /tmp/flowers-sheet.log 2>&1`
 *
 * 退出码：有 `failed` 时为 1（给 cron 一个响动），其余 0。`skipped` 不算失败——
 * 它是「表里已经有这一条」，重复执行时的正常结果。
 */
import { db, pool } from '../src/db/client.js';
import { sweepQueueSheet } from '../src/core/sheet/sync.js';
import { sheetTarget } from '../src/core/sheet/queue-sheet.js';

const DEFAULT_LIMIT = 50;

function parseArgs(argv: string[]): { limit: number } {
  let limit = DEFAULT_LIMIT;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--limit') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error('--limit 要一个正整数');
      limit = Math.floor(value);
      i += 1;
      continue;
    }
    // 拼错一个开关（--limits）被静默吞掉，等于以为限流了其实没有。
    throw new Error(`认不出的参数：${arg}（只认 --limit N）`);
  }
  return { limit };
}

const { limit } = parseArgs(process.argv.slice(2));
const target = sheetTarget();

try {
  const result = await sweepQueueSheet(db, { limit });
  if (!result.ok) {
    // 读不到 A 列就整轮不写：没有去重信息时硬写，是在赌「上次一定没写成功」。
    process.stderr.write(`这轮没写成：${result.message}\n`);
    process.exitCode = 1;
  } else {
    const { summary } = result;
    process.stdout.write(
      `企微汇总表同步｜${target.tab}｜这轮扫到 ${summary.scanned} 条\n`,
    );
    process.stdout.write(
      `写入 ${summary.written} · 表里已有 ${summary.skipped} · 失败 ${summary.failed}\n`,
    );
    if (summary.scanned === 0) {
      process.stdout.write('没有待写的行。\n');
    } else {
      for (const row of summary.rows) {
        process.stdout.write(`  [${row.state}] PAN-${row.number} ${row.message}\n`);
      }
    }
    if (summary.failed > 0) process.exitCode = 1;
  }
} finally {
  await pool.end();
}
