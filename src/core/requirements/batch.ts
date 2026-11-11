import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { updateRequirement } from './manage.js';

/**
 * 批量改（2026-11-11，H3）。
 *
 * 起因（李嘉）：一项规划在旧系统里拆成好几张卡（企业版、直链二期），逐张改 20 条太慢；
 * 而「批量」最怕的是**无声覆盖**——手一抖把各自不同的进度抹平。
 *
 * 所以这个函数的契约是：**先给差异，再落库**。
 * - `dryRun: true`（默认）：只返回「会改成什么」，一个字节都不写；
 * - `dryRun: false`：逐条调 `updateRequirement`，成功与失败都逐条报告。
 *
 * 只收「描述类字段」（优先级 / 类型 / 备注 / 平台 / PRD）。负责人、版本、承诺日不走这里：
 * 它们各自有更严的规则（转交要条线、排期要日期），批量一把梭会把那些规则绕过去。
 */

export type BatchPatch = {
  priority?: string | null;
  type?: string | null;
  remark?: string | null;
  platforms?: string[] | null;
  prdUrl?: string | null;
};

export type BatchItemResult = {
  id: string;
  number: number | null;
  title: string | null;
  /** 这一条会被改的字段（dryRun 里也要有，人才能先看）。 */
  changes: Array<{ field: string; from: string | null; to: string | null }>;
  /** 落库结果：`applied` = 改了，`skipped` = 没变化，`failed` = 被拒（原因在 error）。 */
  status: 'applied' | 'skipped' | 'failed';
  error?: string;
};

export type BatchResult = {
  dryRun: boolean;
  total: number;
  items: BatchItemResult[];
  summary: { applied: number; skipped: number; failed: number };
};

const FIELD_LABEL: Record<string, string> = {
  priority: '优先级', type: '类型', remark: '备注', platforms: '平台', prdUrl: 'PRD 链接',
};

export async function batchUpdate(
  db: Db,
  actor: string,
  input: { ids: string[]; patch: BatchPatch; dryRun?: boolean },
): Promise<BatchResult> {
  const ids = [...new Set(input.ids.map((id) => id.trim()).filter((id) => id !== ''))];
  if (ids.length === 0) throw new AppError('invalid', '要给要改的需求 id');
  if (ids.length > 50) throw new AppError('invalid', '一次最多 50 条');
  const patch = Object.fromEntries(
    Object.entries(input.patch).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(patch).length === 0) throw new AppError('invalid', '没有任何要改的字段');

  const dryRun = input.dryRun !== false;
  const found = await db.execute<{
    id: string; number: number; title: string; priority: string | null; type: string | null;
    remark: string | null; platforms: string[] | null; prd_url: string | null;
  }>(sql`
    select id, number, title, priority, type, remark, platforms, prd_url
      from requirements
     where deleted_at is null and id = any(${sql.param(ids)}::uuid[])`);

  const byId = new Map(found.rows.map((row) => [row.id, row]));
  const items: BatchItemResult[] = [];

  for (const id of ids) {
    const row = byId.get(id);
    if (row === undefined) {
      items.push({ id, number: null, title: null, changes: [], status: 'failed', error: '需求不存在' });
      continue;
    }
    const changes = (Object.keys(patch) as string[]).map((field) => ({
      field: FIELD_LABEL[field] ?? field,
      from: currentOf(row, field),
      to: String((patch as Record<string, unknown>)[field] ?? ''),
    }));

    if (changes.every((change) => change.from === change.to)) {
      items.push({ id, number: row.number, title: row.title, changes, status: 'skipped' });
      continue;
    }
    if (dryRun) {
      items.push({ id, number: row.number, title: row.title, changes, status: 'applied' });
      continue;
    }
    try {
      await updateRequirement(db, actor, { requirementId: id, ...patch });
      items.push({ id, number: row.number, title: row.title, changes, status: 'applied' });
    } catch (error) {
      const message = error instanceof AppError ? error.message : String(error);
      items.push({ id, number: row.number, title: row.title, changes, status: 'failed', error: message });
    }
  }

  const summary = { applied: 0, skipped: 0, failed: 0 };
  for (const item of items) summary[item.status] += 1;
  return { dryRun, total: items.length, items, summary };
}

function currentOf(
  row: { priority: string | null; type: string | null; remark: string | null; platforms: string[] | null; prd_url: string | null },
  field: string,
): string | null {
  switch (field) {
    case 'priority': return row.priority;
    case 'type': return row.type;
    case 'remark': return row.remark;
    case 'platforms': return (row.platforms ?? []).join(',');
    case 'prdUrl': return row.prd_url;
    default: return null;
  }
}
