import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { Runner } from '../notify/wecom.js';
import {
  QUEUE_SHEET_TARGET, appendQueueRow, queueSheetCells, readExistingIds, type QueueSheetSource,
} from './queue-sheet.js';

/**
 * 待排期 → 企微汇总表的**写库那一半**（2026-11-10）。
 *
 * 两件事：
 * 1. `enqueueQueueSheet`：在 `review_pass` 的同一个事务里登记一条 pending。
 *    同事务是刻意的——状态已经变成 `queue` 而台账上没有这一行的话，这条需求就再也
 *    不会被写进表了，而且没有任何痕迹说明它漏了。
 * 2. `sweepQueueSheet`：扫 pending / failed，读一次 A 列、逐条判断「表里有没有」，
 *    没有就追加。失败只记原因，不抛——一条写不进去不该让整轮停下。
 *
 * ── 幂等分两层
 *
 * - **台账层**：`unique (requirement_id, target)` + `on conflict do nothing`，
 *   重放、重进状态都不会登记第二行。
 * - **表格层**：追加前读 A 列，`PAN-<编号>` 已经在表里就跳过（并把台账标成 ok，
 *   `last_error` 写「表里已有」）。这一层管的是「上一次其实写成功了、但我们没收到回执」
 *   ——CLI 超时之后再跑一轮，不会写出两行。
 */

export type SweepSummary = {
  /** 这轮扫到的条数。 */
  scanned: number;
  /** 真的写进表里的条数。 */
  written: number;
  /** 表里已经有、跳过的条数。 */
  skipped: number;
  /** 写失败、留着下次再来的条数。 */
  failed: number;
  /** 每条的结果（脚本打印用）。 */
  rows: Array<{ number: number; state: 'ok' | 'skipped' | 'failed'; message: string }>;
};

type PendingRow = QueueSheetSource & { requirementId: string };

/**
 * 登记一条「该写进汇总表」。**在状态迁移的事务里调**。
 *
 * `on conflict do nothing`：同一条需求再次进待排期（理论上没有这条边，但迁移数据/人工
 * 补数据可能有）不该是错误，也不该覆盖已经成功的记录。
 */
/** 事务句柄：`db.transaction(cb)` 的 `tx` 与 `Db` 只差一个 `$client`，这里只要 execute。 */
type Executor = { execute: Db['execute'] };

export async function enqueueQueueSheet(tx: Executor, requirementId: string): Promise<void> {
  await tx.execute(sql`
    insert into sheet_sync (requirement_id, target, state)
    values (${requirementId}, ${QUEUE_SHEET_TARGET}, 'pending')
    on conflict (requirement_id, target) do nothing`);
}

/**
 * 待写的那几条。读 join 出来的行而不是先查需求再拼：owner 的名字、平台数组、六问
 * 都在 requirements 与 members 上，一次读完比 N+1 次干净。
 *
 * `deleted_at is null`：一条已经软删的需求不该被写进别人维护的表——写进去就删不掉了。
 */
async function loadPending(db: Db, limit: number): Promise<PendingRow[]> {
  const found = await db.execute<{
    id: string; number: number; title: string; owner: string | null; priority: string | null;
    platforms: string[] | null; outcome: string | null; problem: string | null;
    prd_url: string | null; remark: string | null;
  }>(sql`
    select r.id, r.number, r.title, m.name as owner, r.priority, r.platforms,
           r.outcome, r.problem, r.prd_url, r.remark
      from sheet_sync s
      join requirements r on r.id = s.requirement_id
      left join members m on m.id = r.owner_member_id
     where s.target = ${QUEUE_SHEET_TARGET}
       and s.state in ('pending', 'failed')
       and r.deleted_at is null
     order by s.created_at
     limit ${limit}`);

  return found.rows.map((row) => ({
    requirementId: row.id,
    number: Number(row.number),
    title: row.title,
    owner: row.owner,
    priority: row.priority,
    platforms: row.platforms ?? [],
    outcome: row.outcome,
    problem: row.problem,
    prdUrl: row.prd_url,
    remark: row.remark,
  }));
}

async function markOk(db: Db, requirementId: string, cells: string[], note: string | null): Promise<void> {
  await db.execute(sql`
    update sheet_sync
       set state = 'ok',
           attempts = attempts + 1,
           appended_at = ${note === null ? sql`now()` : sql`null`},
           last_error = ${note},
           row_values = ${JSON.stringify(cells)}::jsonb
     where requirement_id = ${requirementId} and target = ${QUEUE_SHEET_TARGET}`);
}

async function markFailed(db: Db, requirementId: string, cells: string[], message: string): Promise<void> {
  await db.execute(sql`
    update sheet_sync
       set state = 'failed',
           attempts = attempts + 1,
           last_error = ${message},
           row_values = ${JSON.stringify(cells)}::jsonb
     where requirement_id = ${requirementId} and target = ${QUEUE_SHEET_TARGET}`);
}

export type SweepDeps = {
  run?: Runner;
  bin?: string;
  doc?: string;
  tab?: string;
  timeoutMs?: number;
  limit?: number;
};

/**
 * 扫一轮。**不抛**：每种失败都变成 summary 里的计数与一行原因，让调用方（脚本）
 * 决定退出码。
 *
 * 先读一次 A 列再循环：一次 CLI 调用摊到这一轮所有行上；读失败就整轮不写
 * （没有去重信息时硬写，是在赌「上次一定没写成功」——赌输就是表里两行一样的数据）。
 */
export async function sweepQueueSheet(db: Db, deps: SweepDeps = {}): Promise<
  { ok: true; summary: SweepSummary } | { ok: false; message: string }
> {
  const limit = deps.limit ?? 50;
  const rows = await loadPending(db, limit);
  if (rows.length === 0) {
    return { ok: true, summary: { scanned: 0, written: 0, skipped: 0, failed: 0, rows: [] } };
  }

  const existing = await readExistingIds(deps);
  if (!existing.ok) return { ok: false, message: existing.message };
  const seen = new Set(existing.value);

  const summary: SweepSummary = { scanned: rows.length, written: 0, skipped: 0, failed: 0, rows: [] };

  for (const row of rows) {
    const cells = queueSheetCells(row);
    const id = cells[0] ?? '';

    if (id !== '' && seen.has(id)) {
      await markOk(db, row.requirementId, cells, '表里已有，跳过');
      summary.skipped += 1;
      summary.rows.push({ number: row.number, state: 'skipped', message: '表里已有' });
      continue;
    }

    const appended = await appendQueueRow(cells, deps);
    if (appended.ok) {
      await markOk(db, row.requirementId, cells, null);
      summary.written += 1;
      seen.add(id);
      summary.rows.push({ number: row.number, state: 'ok', message: '已写入' });
      continue;
    }

    await markFailed(db, row.requirementId, cells, appended.message);
    summary.failed += 1;
    summary.rows.push({ number: row.number, state: 'failed', message: appended.message });
  }

  return { ok: true, summary };
}
