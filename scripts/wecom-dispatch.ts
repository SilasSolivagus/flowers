/**
 * 企微推送（P4-07）：跑一轮，把**还没发过**的事件推给人，并把每一次尝试记下来。
 *
 * ```bash
 * npx tsx scripts/wecom-dispatch.ts              # 真发
 * npx tsx scripts/wecom-dispatch.ts --dry-run    # 只说会发什么，不发、不落库
 * npx tsx scripts/wecom-dispatch.ts --limit 2    # 每人每轮最多 2 条（默认 5）
 * npx tsx scripts/wecom-dispatch.ts --tick       # 先推进时钟，再补推送
 * ```
 *
 * 这个脚本本身不含任何规则：候选事件、档位、每人上限、去重、失败状态全在
 * `src/core/notify/dispatch.ts` 里（那里也是「tick 之后接着跑」的那个入口
 * `tickThenDispatch`）。这一层只做三件事——解析三个开关、调一次、把摘要打到 stdout。
 *
 * **摘要必须打到 stdout**：它是这个任务唯一的可观测面。一次「发了 0 条」的运行
 * 与一次「失败了 0 条」的运行在日志里必须长得不一样，否则停机一周之后没人说得清
 * 是没人需要通知，还是通知全卡住了。
 *
 * 退出码：有 `failed` 时为 1（给 cron 一个响动），其余 0。`skipped` 不算失败——
 * 它多半是「企微账号还没对上」，那件事要靠人去通讯录里看，不是重跑能好的。
 */
import { db, pool } from '../src/db/client.js';
import {
  DEFAULT_PER_MEMBER_LIMIT, dispatchWecom, tickThenDispatch,
  type DispatchSummary, type MemberRun,
} from '../src/core/notify/dispatch.js';

type Args = { dryRun: boolean; limit: number; tick: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, limit: DEFAULT_PER_MEMBER_LIMIT, tick: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--tick') {
      args.tick = true;
      continue;
    }
    if (arg === '--limit') {
      args.limit = Number(argv[i + 1] ?? Number.NaN);
      i += 1;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      args.limit = Number(arg.slice('--limit='.length));
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        '用法：tsx scripts/wecom-dispatch.ts [--dry-run] [--limit N] [--tick]\n',
      );
      process.exit(0);
    }
    // 认不出的参数不静默吞掉：一次拼错的开关（--dryrun）会让人以为在预览，其实发了。
    throw new Error(`认不出的参数：${arg}（只认 --dry-run / --limit N / --tick）`);
  }
  if (!Number.isFinite(args.limit)) args.limit = DEFAULT_PER_MEMBER_LIMIT;
  return args;
}

function line(run: MemberRun): string {
  const head = `${run.name}（${run.level}）`;
  if (run.lookupError !== null) return `${head}：没发 —— ${run.lookupError}`;
  const counts = `发 ${run.sent} · 失败 ${run.failed} · 跳过 ${run.skipped}`;
  const would = run.planned > 0 ? ` · 待发 ${run.planned}` : '';
  const parts = [``, `${head}：${counts}${would}`];
  for (const message of run.messages) {
    const first = message.content.split('\n')[0] ?? '';
    parts.push(`  [${message.status}] ${first}`);
  }
  return parts.join('\n');
}

function report(summary: DispatchSummary): void {
  const mode = summary.dryRun ? 'dry-run（什么都没发）' : '真发';
  process.stdout.write(
    `企微推送 ${mode}｜每人每轮上限 ${summary.perMemberLimit} 条\n`,
  );
  process.stdout.write(
    `合计：已发送 ${summary.sent} · 失败 ${summary.failed} · 跳过 ${summary.skipped}`
    + ` · 待发 ${summary.planned} · 关掉企微的成员 ${summary.disabled}\n`,
  );
  const active = summary.members.filter((run) => (
    run.messages.length > 0 || run.sent + run.failed + run.skipped > 0
  ));
  if (active.length === 0) {
    process.stdout.write('没有要发的东西。\n');
    return;
  }
  for (const run of active) process.stdout.write(`${line(run)}\n`);
}

const args = parseArgs(process.argv.slice(2));

try {
  if (args.tick) {
    const { moved, summary } = await tickThenDispatch(db, new Date(), {
      dryRun: args.dryRun,
      perMemberLimit: args.limit,
    });
    process.stdout.write(`时钟推进：${moved} 条需求前进了一步\n`);
    report(summary);
    await pool.end();
    process.exit(summary.failed > 0 ? 1 : 0);
  }

  const summary = await dispatchWecom(db, {
    dryRun: args.dryRun,
    perMemberLimit: args.limit,
  });
  report(summary);
  await pool.end();
  process.exit(summary.failed > 0 ? 1 : 0);
} catch (error) {
  process.stderr.write(`推送没有跑起来：${error instanceof Error ? error.message : String(error)}\n`);
  await pool.end();
  process.exit(2);
}
