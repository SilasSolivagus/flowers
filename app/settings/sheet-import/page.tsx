import Link from 'next/link';

import { db } from '../../../src/db/client';
import { currentMemberRow } from '../../../src/core/read/member';
import { isAdmin } from '../../../src/core/auth/roles';
import {
  DEFAULT_QUEUE_SHEET_DOC,
} from '../../../src/core/sheet/queue-sheet';
import {
  DEFAULT_QUEUE_SHEET_TAB,
} from '../../../src/core/sheet/queue-sheet';
import {
  applyReconcile, existingRequirements, readSheetRows, reconcile,
} from '../../../src/core/sheet/reconcile';
import { SheetImportForm } from './form';
import { Shell } from '../../components/Shell';

/**
 * 企微表核对页（2026-11-11，H4）。
 *
 * 一屏三列：表里那行 → 池里匹配到谁 → 建议怎么动。人逐条勾选后提交，
 * **不自动写库**：标题像不等于同一条，自动执行等于替人做决定。
 *
 * 只有超管能进：这一步会改存量卡片的状态，与「状态校准」同一档权限。
 */
export const dynamic = 'force-dynamic';

export default async function SheetImportPage() {
  const me = await currentMemberRow().catch(() => null);
  if (me === null || !isAdmin(me)) {
    return (
      <Shell>
        <main className="wrap">
          <h2>导入核对</h2>
          <p>这一页只有超管能打开。</p>
          <p><Link href="/settings">回设置</Link></p>
        </main>
      </Shell>
    );
  }

  const doc = process.env.FLOWERS_QUEUE_SHEET_DOC ?? DEFAULT_QUEUE_SHEET_DOC;
  const rows = await readSheetRows(doc, DEFAULT_QUEUE_SHEET_TAB).catch(() => []);
  const existing = await existingRequirements(db);
  const items = reconcile(rows, existing);
  const counts = {
    move: items.filter((item) => item.action === 'move').length,
    create: items.filter((item) => item.action === 'create').length,
    keep: items.filter((item) => item.action === 'keep').length,
  };

  return (
    <Shell>
      <main className="wrap">
        <h2>企微表 → 待排期核对</h2>
        <p className="muted">
          表里 {items.length} 行：建议挪 <b>{counts.move}</b>、新建 <b>{counts.create}</b>、
          不动 <b>{counts.keep}</b>。勾选后提交才会写库。
        </p>
        {items.length === 0 ? (
          <p>没读到表内容（检查 wecom-cli 授权与表格 id）。</p>
        ) : (
          <SheetImportForm
            items={items.map((item) => ({
              num: item.row.num,
              title: item.row.title,
              owner: item.row.owner,
              priority: item.row.priority,
              prd: item.row.prdUrl !== '',
              action: item.action,
              why: item.why,
              matched: item.match === null ? null : `PAN-${item.match.number} ${item.match.title}（${item.match.state}）`,
            }))}
            apply={applySheetImportAction}
          />
        )}
        <p><Link href="/settings">回设置</Link></p>
      </main>
    </Shell>
  );
}

/** 提交入口：按勾选的行号重新对一遍，再落库（不信任客户端传回来的匹配结果）。 */
async function applySheetImportAction(formData: FormData): Promise<{ ok: boolean; message: string }> {
  'use server';
  const me = await currentMemberRow().catch(() => null);
  if (me === null) return { ok: false, message: '未登录' };
  if (!isAdmin(me)) return { ok: false, message: '只有超管能做这一步' };
  const actor = me.name;
  const doc = process.env.FLOWERS_QUEUE_SHEET_DOC ?? DEFAULT_QUEUE_SHEET_DOC;
  const rows = await readSheetRows(doc, DEFAULT_QUEUE_SHEET_TAB);
  const existing = await existingRequirements(db);
  const wanted = new Set(formData.getAll('row').map((value) => String(value)));
  const picked = reconcile(rows, existing).filter((item) => wanted.has(item.row.num));
  const result = await applyReconcile(db, picked, actor);
  return { ok: true, message: `挪动 ${result.moved} 条，新建 ${result.created} 条，跳过 ${result.skipped} 条` };
}
