/**
 * 批量搁置：把「停在那儿太久、没人再动」的需求一次性收掉（2026-11-10）。
 *
 * ```bash
 * npx tsx scripts/shelve-stale.ts                     # 预览（默认 dry-run）
 * npx tsx scripts/shelve-stale.ts --dry-run=false     # 真搁置
 * npx tsx scripts/shelve-stale.ts --days 180 --states inbox,design
 * ```
 *
 * ── 为什么需要它
 *
 * 803 条迁移数据里，收集列堆着 285 条（最早到 2026-03），已搁置 98、已拒绝 73。
 * 看板十列里最左边那一列被历史淹没，等于这个产品每天第一眼看到的是四个月前的垃圾。
 * 「简化」的第一件事不是加功能，是把这些卡收起来。
 *
 * ── 口径
 *
 * - **按状态的白名单**：默认只碰 `inbox`（收集）。搁置是「这件事不做了」，
 *   而收集列里躺着的正是「提了但没立项」的存量。
 * - **按时间**：默认 180 天。锚点分两种，因为迁移把时间压平了：
 *   `收集` 用 `created_at`（这条需求提出来多久了），其余状态用 `state_entered_at`
 *   （进这一步多久了）。
 *
 *   为什么收集不能用 `state_entered_at`：803 条迁移数据的 `state_entered_at` 全是
 *   迁移那一天（2026-11-07），照它算「停了多少天」每一条都只有 3 天——实测只筛出
 *   3 条，而按 `created_at` 算是 47 条。迁移保留了原始建单日期，那才是「提出来多久」。
 *   反过来，非收集状态里 `state_entered_at` 是真推进时间（原生需求的每一次 moveTo 都
 *   写它），所以那里用它。
 * - **默认 dry-run**：这条命令会改几十上百行，第一次必须是「先看清单」。
 *   真要执行得显式写 `--dry-run=false`。
 * - **逐条走服务**：调 `shelveRequirement`，不直接 UPDATE。权限、状态机、
 *   事件流、派单作废全在服务里；脚本只负责挑人、挑行、打印。
 * - **actor 是超管**：批量搁置没有「本人」可言。服务里的 `edit` 能力对超管放行，
 *   于是每一条都会在事件流里留下 `actor = 超管 + 原因 + 事件`。
 *
 * 退出码：有失败行时为 1。
 */
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import { shelveRequirement } from '../src/core/requirements/terminal.js';
import { STATE_LABEL, type State } from '../src/core/state-machine.js';
import { AppError } from '../src/core/errors.js';

type Args = { days: number; states: string[]; dryRun: boolean; actor: string | null };

const DEFAULT_DAYS = 180;
const DEFAULT_STATES = ['inbox'];
const SHELVABLE = ['inbox', 'design', 'review', 'queue', 'ready', 'dev', 'test'] as const;

function parseArgs(argv: string[]): Args {
  const args: Args = { days: DEFAULT_DAYS, states: DEFAULT_STATES, dryRun: true, actor: null };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run=false' || arg === '--apply') {
      args.dryRun = false;
      continue;
    }
    if (arg === '--dry-run' || arg === '--dry-run=true') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--days') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error('--days 要一个正整数');
      args.days = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === '--states') {
      const value = (argv[i + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (value.length === 0) throw new Error('--states 要给逗号分隔的状态，例如 inbox,design');
      const bad = value.filter((s) => !SHELVABLE.includes(s as (typeof SHELVABLE)[number]));
      if (bad.length > 0) throw new Error(`这些状态不能搁置：${bad.join('、')}（可搁置：${SHELVABLE.join(' / ')}）`);
      args.states = value;
      i += 1;
      continue;
    }
    if (arg === '--actor') {
      const value = argv[i + 1];
      if (!value) throw new Error('--actor 要给一个成员名字');
      args.actor = value;
      i += 1;
      continue;
    }
    // 拼错的开关被静默吞掉，等于以为在预览其实改了数据。
    throw new Error(`认不出的参数：${arg}（只认 --dry-run / --days N / --states a,b / --actor 名字）`);
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));

try {
  // 超管：批量操作没有「本人」，由部署的那个超管代表。库里只有一个 product_owner。
  const adminName = args.actor ?? (await db.execute<{ name: string }>(sql`
    select name from members where role = 'product_owner' and deactivated_at is null
     order by created_at limit 1`)).rows[0]?.name;
  if (!adminName) throw new Error('库里没有可用的超管（role = product_owner）');

  const rows = (await db.execute<{
    id: string; number: number; title: string; state: string; days: number;
  }>(sql`
    select r.id, r.number, r.title, r.state,
           floor(extract(epoch from now() - case when r.state = 'inbox' then r.created_at
                                                else r.state_entered_at end) / 86400)::int as days
      from requirements r
     where r.deleted_at is null
       and r.state = any(${sql.param(args.states)}::text[])
       and (case when r.state = 'inbox' then r.created_at else r.state_entered_at end)
           < now() - make_interval(days => ${args.days})
     order by r.state, r.number`)).rows;

  process.stdout.write(
    `搁置「停太久」的需求｜状态 ${args.states.join('/')}｜超过 ${args.days} 天｜`
    + `${args.dryRun ? 'dry-run（什么都没改）' : `真执行（actor=${adminName}）`}\n`,
  );
  process.stdout.write(`扫到 ${rows.length} 条\n`);

  if (rows.length === 0) {
    process.stdout.write('没有要收的。\n');
  } else {
    const preview = args.dryRun ? rows.slice(0, 20) : rows;
    for (const row of preview) {
      process.stdout.write(`  ${row.state} PAN-${row.number} 停 ${row.days} 天 ${row.title.slice(0, 40)}\n`);
    }
    if (args.dryRun && rows.length > preview.length) {
      process.stdout.write(`  …… 还有 ${rows.length - preview.length} 条（真执行时逐条打印）\n`);
    }
  }

  if (!args.dryRun && rows.length > 0) {
    let ok = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await shelveRequirement(db, adminName, {
          requirementId: row.id,
          // 原因里写清是脚本收的：一年后翻事件流，这一句要能解释「为什么它自己进了搁置」。
          // 状态写中文：这句话会原样进群播报（`group-dispatch` 把 reason 抄进引用行），
          // 群里读到「停在 inbox」会以为漏了翻译。
          reason: `长期未推进：停在「${STATE_LABEL[row.state as State] ?? row.state}」超过 ${row.days} 天（批量搁置）`,
        });
        ok += 1;
        process.stdout.write(`  [ok] PAN-${row.number}\n`);
      } catch (error) {
        failed += 1;
        const message = error instanceof AppError ? error.message : String(error);
        process.stdout.write(`  [failed] PAN-${row.number} ${message}\n`);
      }
    }
    process.stdout.write(`合计：搁置 ${ok} · 失败 ${failed}\n`);
    if (failed > 0) process.exitCode = 1;
  }
} finally {
  await pool.end();
}
