import { execFile } from 'node:child_process';
import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { recordEvent } from '../events.js';

/**
 * 企微汇总表「待排期」→ flowers 的核对（2026-11-11，H4）。
 *
 * 三方各说一件事，这一层把它们摆到一屏里：
 * - **表里**：人手工维护的 22 行（有 PRD 链接，评审在表里算过了）；
 * - **池里**：flowers 现有的需求（可能同名、可能已经在做）；
 * - **库里**：谁在什么状态。
 *
 * 输出是**建议**，不是自动执行：每条给出「匹配到谁 / 会怎么动 / 差在哪」，人逐条勾选后
 * 才落库（`applyReconcile`）。自动匹配永远只是候选——标题像不等于同一条。
 */

export type SheetRow = {
  num: string;
  title: string;
  owner: string;
  priority: string;
  platforms: string;
  prdUrl: string;
};

export type ExistingRequirement = {
  id: string; number: number; title: string; state: string;
};

export type ReconcileAction = 'move' | 'create' | 'keep';

export type ReconcileItem = {
  row: SheetRow;
  /** 匹配到的池里那条（没有就是 null）。 */
  match: ExistingRequirement | null;
  /** 建议动作：挪进待排期 / 新建 / 不动（已经在做）。 */
  action: ReconcileAction;
  /** 为什么是这个建议（中文一句话）。 */
  why: string;
  /** 表里有、池里缺的字段（只做提示，不参与判断）。 */
  diff: string[];
};

/** 标题归一：去括号注记、标点、空格，小写。 */
export function normTitle(raw: string): string {
  return raw
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[【】\[\]《》「」（）()\s·、，,。.:：;；/|｜\-—_]/g, '')
    .toLowerCase();
}

const IN_PROGRESS = new Set(['ready', 'dev', 'test', 'live']);
const MOVABLE = new Set(['inbox', 'design', 'review']);

/** 纯函数：表行 × 池子 → 建议。 */
export function reconcile(rows: SheetRow[], existing: ExistingRequirement[]): ReconcileItem[] {
  return rows.map((row) => {
    const key = normTitle(row.title);
    const hits = existing.filter((item) => {
      const other = normTitle(item.title);
      if (other === key) return true;
      if (key.length < 4 || other.length < 4) return false;
      return other.includes(key) || key.includes(other);
    });
    const byFit = [...hits].sort((a, b) => (
      Math.abs(normTitle(a.title).length - key.length) - Math.abs(normTitle(b.title).length - key.length)
    ) || a.number - b.number);
    const movable = byFit.find((item) => MOVABLE.has(item.state));
    const busy = byFit.find((item) => IN_PROGRESS.has(item.state));

    const diff: string[] = [];
    if (row.prdUrl !== '') diff.push('表里有 PRD 链接（池里可能没有）');

    if (movable) {
      return {
        row, match: movable, action: 'move',
        why: `池里同名那条在「${stateText(movable.state)}」，挪进待排期`,
        diff,
      };
    }
    if (busy) {
      return {
        row, match: busy, action: 'keep',
        why: `已经在做（${stateText(busy.state)}），不动`,
        diff,
      };
    }
    return {
      row, match: byFit[0] ?? null, action: 'create',
      why: byFit.length === 0 ? '池里没有，新建到待排期' : '池里有同名但状态不适用，新建到待排期',
      diff,
    };
  });
}

function stateText(state: string): string {
  return ({
    inbox: '收集', design: '待设计', review: '待评审', queue: '待排期',
    ready: '待开发', dev: '开发中', test: '测试中', live: '已上线',
    rejected: '已拒绝', shelved: '已搁置',
  } as Record<string, string>)[state] ?? state;
}

/** 读汇总表（服务端）；行解析与导入脚本同一套字段位置。 */
export async function readSheetRows(
  docId: string,
  sheetId: string,
  range = 'A1:K60',
): Promise<SheetRow[]> {
  const out = await new Promise<string>((resolve, reject) => {
    execFile('wecom-cli', [
      'sheet', 'ranges', 'get', '--docid', docId, '--sheet-id', sheetId, '--range', range,
    ], { timeout: 15_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
  const payload = JSON.parse(out) as { content?: string };
  const lines = (payload.content ?? '').split('\n').filter((line) => line.trim() !== '');
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const prdCell = cells[9] ?? '';
    const link = /\((https?:\/\/[^)]+)\)/.exec(prdCell);
    return {
      num: (cells[0] ?? '').trim(),
      title: (cells[1] ?? '').trim(),
      owner: (cells[2] ?? '').trim(),
      priority: (cells[3] ?? '').trim(),
      platforms: (cells[5] ?? '').trim(),
      prdUrl: link?.[1] ?? '',
    };
  }).filter((row) => row.title !== '');
}

/** 极简 CSV 行解析：够用即可（表里没有带逗号的引号字段）。 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of line) {
    if (char === '"') { quoted = !quoted; continue; }
    if (char === ',' && !quoted) { out.push(current); current = ''; continue; }
    current += char;
  }
  out.push(current);
  return out;
}

/** 读池子（未删除的需求）。 */
export async function existingRequirements(db: Db): Promise<ExistingRequirement[]> {
  const res = await db.execute<ExistingRequirement>(sql`
    select id, number, title, state from requirements where deleted_at is null order by number`);
  return res.rows.map((row) => ({ ...row, number: Number(row.number) }));
}

/**
 * 落库：只处理人勾选的条目。`move` 直接把状态摆到待排期（迁移性质，事件带 batch），
 * `create` 新建一条落在待排期。两条都补 PRD 链接与「评审通过」记录。
 */
export async function applyReconcile(
  db: Db, items: ReconcileItem[], actor: string,
): Promise<{ moved: number; created: number; skipped: number }> {
  let moved = 0; let created = 0; let skipped = 0;
  for (const item of items) {
    if (item.action === 'keep') { skipped += 1; continue; }
    const prd = item.row.prdUrl.trim() === '' ? null : item.row.prdUrl.trim();
    if (item.action === 'move' && item.match !== null) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          update requirements
             set state = 'queue', state_entered_at = now(), prd_url = coalesce(${prd}, prd_url)
           where id = ${item.match!.id}`);
        await recordEvent(tx, {
          requirementId: item.match!.id, actor, type: 'requirement.state_changed',
          payload: { from: item.match!.state, to: 'queue', batch: 'sheet-reconcile-20261111' },
        });
        await recordEvent(tx, {
          requirementId: item.match!.id, actor, type: 'requirement.review_passed',
          payload: { importedFrom: '企微汇总表 kvf2dh', row: item.row.num, prdUrl: prd, batch: 'sheet-reconcile-20261111' },
        });
      });
      moved += 1;
    } else {
      const inserted = await db.execute<{ id: string }>(sql`
        insert into requirements (title, state, state_entered_at, requester, prd_url)
        values (${item.row.title}, 'queue', now(), ${item.row.owner || '企微汇总表'}, ${prd})
        returning id`);
      const id = inserted.rows[0]!.id;
      await db.transaction(async (tx) => {
        await recordEvent(tx, {
          requirementId: id, actor, type: 'requirement.created',
          payload: { importedFrom: '企微汇总表 kvf2dh', row: item.row.num, batch: 'sheet-reconcile-20261111' },
        });
        await recordEvent(tx, {
          requirementId: id, actor, type: 'requirement.review_passed',
          payload: { importedFrom: '企微汇总表 kvf2dh', row: item.row.num, prdUrl: prd, batch: 'sheet-reconcile-20261111' },
        });
      });
      created += 1;
    }
  }
  return { moved, created, skipped };
}
