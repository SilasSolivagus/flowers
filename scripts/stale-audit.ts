#!/usr/bin/env tsx
/**
 * 「没有负责人 + 很久没人动」的审计——**只读**入口。
 *
 *   npx tsx scripts/stale-audit.ts                 # 人读摘要（三段计数 + 交叉统计）
 *   npx tsx scripts/stale-audit.ts --md            # 打印报告用的 markdown 数据小节
 *   npx tsx scripts/stale-audit.ts --json [path]   # 把 B 桶清单写成 JSON（默认落 docs/superpowers/plans/）
 *
 * 为什么要有这个脚本：owner 要把「收集」里那批没有负责人的需求推进 PM 群让人领，但推之前
 * 得先把「真在等人领」和「几个月没人碰、基本是死的」分开——把死需求推进群，两天就把
 * 频道烧了。所以这里只做一件事：**按活动时间把 195 条分桶**，并把 B 桶（疑似过期）
 * 落成一份机器可读的清单，给后面那次「批量拒绝」迁移吃。
 *
 * 口径全在 `src/core/requirements/stale-audit.ts`（纯函数，用例钉住）；这里只负责查库、
 * 打印、落文件。**一条 SQL 都不写**给「哪条算过期」——那是口径，不是查询。
 *
 * ## 只读
 *
 * 两条 `select`，没有事务、没有 `insert` / `update` / `delete`。跑一百遍库里的行一个字节
 * 都不会变：批量拒绝是**另一件事**，得由 owner 看过这份清单之后再单独做（并且要留下
 * 每条的原因）。这个脚本的产物只有 stdout 与那两个文件。
 *
 * ## 为什么 `--json` 落的是 B 桶而不是全部
 *
 * 后续迁移要的是「可以放心拒绝的那批」，那就是 B。A 桶的用途是「推群让人领」，那是人看
 * 的报告，不是迁移的输入。把 A 也塞进 JSON 只会让迁移多一道 `where`。
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import {
  IMPORT_EVENT_TYPE,
  buildAudit,
  type Audit,
  type AuditRow,
  type LiveRow,
} from '../src/core/requirements/stale-audit.js';

/** 报告与 JSON 落在同一个目录：一次审计的两份产物必须能一起被 review。 */
const OUT_DIR = 'docs/superpowers/plans';
const DEFAULT_JSON = path.join(OUT_DIR, '2026-11-08-stale-audit.json');

const USAGE = '用法：tsx scripts/stale-audit.ts [--md] [--json [path]]';

/**
 * 参数解析严格：只认 `--md` / `--json [path]` / `--help`。
 *
 * 与 `scripts/index-history.ts` 同一条理由：认错的参数被静默忽略时，人以为自己在看
 * 一份 A 桶的摘要，实际拿到的是另一份东西——审计脚本的每一条输出都会被当成结论引用。
 */
function parseArgs(argv: string[]): { md: boolean; json: string | null } {
  let md = false;
  let json: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--md') {
      md = true;
    } else if (arg === '--json') {
      // 容一个可选路径，但**不吞**下一个 flag：`--json --md` 应当是两条指令，不是
      // 一个叫 `--md` 的文件名。
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        json = next;
        i += 1;
      } else {
        json = DEFAULT_JSON;
      }
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`不认识的参数：${arg}`);
      console.error(USAGE);
      process.exit(2);
    }
  }
  return { md, json };
}

/**
 * 两条查询：没有负责人的需求、以及全部未删需求（只为「同题」「撞上已上线」）。
 *
 * 「没有负责人」= `owner_member_id is null`。**不是**「没有负责人或负责人已停用」：
 * 停用的账号仍然是记录在案的人，把它算成无主等于替 owner 说「这个人不算数了」。
 *
 * `lastEventAt` 在 SQL 里就把记账事件剔掉（`type <> IMPORT_EVENT_TYPE`），因为
 * 「哪些事件算活动」这件事在纯函数里也要说一遍——两边写同一个常量，不是两份字符串。
 */
async function loadRows(): Promise<{ ownerless: AuditRow[]; live: LiveRow[] }> {
  const ownerless = await db.execute<AuditRow>(sql`
    select r.id,
           r.number,
           r.title,
           r.state,
           r.state_entered_at as "stateEnteredAt",
           r.prd_url as "prdUrl",
           r.source,
           r.platforms,
           (select max(e.at) from events e
             where e.requirement_id = r.id and e.type <> ${IMPORT_EVENT_TYPE}) as "lastEventAt"
      from requirements r
     where r.deleted_at is null
       and r.owner_member_id is null
     order by r.number`);

  const live = await db.execute<LiveRow>(sql`
    select id, number, title, state
      from requirements
     where deleted_at is null
     order by number`);

  return { ownerless: ownerless.rows, live: live.rows };
}

function pct(part: number, whole: number): string {
  if (whole === 0) return '0%';
  return `${((part / whole) * 100).toFixed(0)}%`;
}

/** 人读摘要：三段计数 + 四组交叉。`--md` 是同一份数据的 markdown 版。 */
function renderSummary(audit: Audit): string {
  const lines: string[] = [];
  const { buckets, actionable, terminal } = audit;
  lines.push(`范围：未删 + 没有负责人 = ${audit.total} 条（时效线 ${audit.staleDays} 天，截止 ${audit.cutoffDay}）`);
  lines.push(`  A 真需要人领：${buckets.fresh}`);
  lines.push(`  B 疑似过期  ：${buckets.stale}（其中 C 无任何记录 ${buckets.noEvents}）`);
  lines.push(`  终态 ${terminal.total} 条（${terminal.byState.map((row) => `${row.key} ${row.count}`).join(' / ')}）→ 不推群、不批量拒绝`);
  lines.push(`  可动作集（非终态）：${actionable.total} = A ${actionable.fresh} + B ${actionable.stale}`);
  lines.push(`PRD 链接：${audit.cross.prd.withPrd} / ${audit.total}（可动作集里只有 ${audit.cross.prd.actionableWithPrd} 条）`);
  lines.push(`同题（重复录入）：全库 ${audit.cross.duplicateTitles.totalGroups} 组，其中含无主行的 ${audit.cross.duplicateTitles.groups.length} 组 / 无主行 ${audit.cross.duplicateTitles.ownerlessRows} 条`);
  lines.push(`撞上已上线：${audit.cross.shippedAdjacent.count} 条`);
  lines.push('');
  lines.push('来源：');
  for (const row of audit.cross.source) {
    lines.push(`  ${row.key} ${row.count}（${pct(row.count, audit.total)}）· 其中疑似过期 ${row.stale}`);
  }
  lines.push('平台（按勾选计次，可多端）：');
  for (const row of audit.cross.platform) {
    lines.push(`  ${row.key} ${row.count} · 其中疑似过期 ${row.stale}`);
  }
  return lines.join('\n');
}

/**
 * 报告里的数据小节。
 *
 * 输出的这几节会被**原样**贴进 `docs/superpowers/plans/2026-11-08-stale-audit.md`，
 * 所以这里不写议论，只写数字与表格——报告里的判断由人写，数字由脚本写，两者分开，
 * 下次重跑只需要替换这几节。
 */
function renderMarkdown(audit: Audit): string {
  const { buckets, actionable, terminal } = audit;
  const lines: string[] = [];
  lines.push('## 2 计数');
  lines.push('');
  lines.push(`跑这一遍的时刻 ${audit.now}，时效线 ${audit.staleDays} 天 → 截止 ${audit.cutoff}（北京时间 ${audit.cutoffDay}）。`);
  lines.push('');
  lines.push('| 桶 | 口径 | 条数 |');
  lines.push('|---|---|---|');
  lines.push(`| — | 范围：未删 + 没有负责人 | ${audit.total} |`);
  lines.push(`| A | 最后一次活动在 ${audit.staleDays} 天以内 | ${buckets.fresh} |`);
  lines.push(`| B | 最后一次活动在 ${audit.staleDays} 天以前（含） | ${buckets.stale} |`);
  lines.push(`| C | B 里「一条业务事件都没有」的那一档 | ${buckets.noEvents} |`);
  lines.push('');
  lines.push(`终态 ${terminal.total} 条（${terminal.byState.map((row) => `${row.key} ${row.count}`).join(' / ')}）`
    + '也在上面的范围里，但它们是**结论**：不推群、不进批量拒绝。');
  lines.push('');
  lines.push(`可动作集（非终态）= ${actionable.total} 条，其中 A ${actionable.fresh} / B ${actionable.stale}。`);
  lines.push('');
  lines.push(`## 3 B 桶清单（${audit.staleRows.length} 条，最旧的在前）`);
  lines.push('');
  lines.push('| 编号 | 标题 | 状态 | 最后活动 | 停了几天 | 有业务事件 |');
  lines.push('|---|---|---|---|---|---|');
  for (const row of audit.staleRows) {
    lines.push(`| PAN-${row.number} | ${row.title.replace(/\|/g, '\\|')} | ${row.state} | ${row.lastActivityAt} | ${row.idleDays} | ${row.hasEvents ? '是' : '否'} |`);
  }
  lines.push('');
  lines.push('## 4 四组交叉');
  lines.push('');
  lines.push('### 4.1 PRD 链接');
  lines.push('');
  lines.push('| 项 | 条数 |');
  lines.push('|---|---|');
  lines.push(`| 有 PRD 链接 | ${audit.cross.prd.withPrd} |`);
  lines.push(`| 没有 PRD 链接 | ${audit.cross.prd.withoutPrd} |`);
  lines.push(`| 非终态且有 PRD（能被评审的） | ${audit.cross.prd.actionableWithPrd} |`);
  lines.push('');
  lines.push('### 4.2 同题（重复录入）');
  lines.push('');
  lines.push(`全库 ${audit.cross.duplicateTitles.totalGroups} 组同题（组内 2 条以上未删需求），其中 ${audit.cross.duplicateTitles.groups.length} 组里有没有负责人的行，共 ${audit.cross.duplicateTitles.ownerlessRows} 条。`);
  lines.push('');
  if (audit.cross.duplicateTitles.groups.length === 0) {
    lines.push('（无）');
  } else {
    lines.push('| 标题 | 组内编号 | 全部无主 |');
    lines.push('|---|---|---|');
    for (const group of audit.cross.duplicateTitles.groups) {
      const members = group.rows
        .map((row) => `PAN-${row.number}(${row.state}${row.ownerless ? '·无主' : ''})`)
        .join('、');
      lines.push(`| ${group.title.replace(/\|/g, '\\|')} | ${members} | ${group.allOwnerless ? '是' : '否'} |`);
    }
  }
  lines.push('');
  lines.push('### 4.3 来源分布');
  lines.push('');
  lines.push('| 来源 | 条数 | 占比 | 其中疑似过期 |');
  lines.push('|---|---|---|---|');
  for (const row of audit.cross.source) {
    lines.push(`| ${row.key} | ${row.count} | ${pct(row.count, audit.total)} | ${row.stale} |`);
  }
  lines.push('');
  lines.push('### 4.4 平台分布');
  lines.push('');
  lines.push('按勾选计次：一条需求勾了 3 个端就算 3 次，所以各行相加 **大于** 总数。');
  lines.push('');
  lines.push('| 平台 | 条数 | 其中疑似过期 |');
  lines.push('|---|---|---|');
  for (const row of audit.cross.platform) {
    lines.push(`| ${row.key} | ${row.count} | ${row.stale} |`);
  }
  lines.push('');
  lines.push('### 4.5 撞上已上线');
  lines.push('');
  lines.push(`${audit.cross.shippedAdjacent.count} 条`
    + (audit.cross.shippedAdjacent.count === 0
      ? '（标题与另一条 `state = live` 的需求全等，排除自己）——没有「同一件事已经在跑」的收集项。'
      : `：${audit.cross.shippedAdjacent.numbers.map((n) => `PAN-${n}`).join('、')}`));
  lines.push('');
  lines.push('### 4.6 没算的那一项');
  lines.push('');
  for (const line of audit.cross.skipped) lines.push(`- ${line}`);
  return lines.join('\n');
}

const args = parseArgs(process.argv.slice(2));

/**
 * `now` 取一次进程启动的时刻，整份报告只用这一个值。
 *
 * 不让每条 SQL 各自 `now()`：那样「截止」「停了几天」「分桶」会来自三个略微不同的
 * 时刻，边界上的行可能在 A 与 B 之间被算成半条。
 */
const now = new Date();

const { ownerless, live } = await loadRows();
const audit = buildAudit({ ownerless, live, now });

if (args.json !== null) {
  const payload = {
    generatedAt: audit.now,
    cutoff: audit.cutoff,
    cutoffDay: audit.cutoffDay,
    staleDays: audit.staleDays,
    scope: 'requirements where deleted_at is null and owner_member_id is null',
    buckets: audit.buckets,
    terminal: audit.terminal,
    actionable: audit.actionable,
    cross: audit.cross,
    // 批量拒绝的输入：B 桶逐行。`terminal: true` 的行不在候选集里（已经上线 / 已拒绝 /
    // 已搁置的东西不该被「再拒绝一次」），迁移那边按这一列过滤，而不是自己猜状态。
    staleRows: audit.staleRows,
  };
  writeFileSync(args.json, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`已写 ${args.json}（B 桶 ${audit.staleRows.length} 条）`);
}

if (args.md) {
  console.log(renderMarkdown(audit));
} else if (args.json === null) {
  console.log(renderSummary(audit));
  if (audit.staleRows.length > 0) {
    console.log('');
    console.log('B 桶最旧的 10 条：');
    for (const row of audit.staleRows.slice(0, 10)) {
      console.log(`  PAN-${row.number}  ${row.lastActivityAt}  停了 ${row.idleDays} 天  ${row.state}  ${row.title}`);
    }
  }
}

await pool.end();
