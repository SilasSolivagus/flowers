/**
 * 把企微汇总表「待排期」那 22 行对进 flowers（2026-11-11 owner 的口径）。
 *
 * 规则（owner 逐条确认过）：
 * 1. **已经在做的（待开发 / 开发中 / 测试中 / 已上线）不动**——只在报告里列出来；
 * 2. 池子里**收集 / 待设计 / 待评审**里有同名需求的 → 把它挪进「待排期」；
 * 3. 池子里完全没有 → 新建一条，直接落在「待排期」；
 * 4. 两种落法都要：带上表里的 PRD 链接，并记「评审通过」（表里这些需求都过了评审）。
 *
 * 为什么直接写状态而不是走服务：`inbox → design → review → queue` 这条正路要过六问门
 * 与评审签字，而表里没有六问、也没有签字人。这批是**迁移**，与 `migrate-flower.ts`
 * 同一性质：写状态 + 写事件，事件里注明来源，方便以后审计。
 *
 * 用法：
 *   npx tsx scripts/import-sheet-queue.ts --rows /tmp/sheet_rows.json          # 只出计划
 *   npx tsx scripts/import-sheet-queue.ts --rows /tmp/sheet_rows.json --apply  # 落库
 */
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import { recordEvent } from '../src/core/events.js';

type SheetRow = {
  num: string; title: string; owner: string; pri: string; plat: string; prd: string;
};

/** 标题归一：去空白/括号/标点，小写；括号里的「（上迭代遗留）」这类注记一并去掉。 */
function norm(raw: string): string {
  return raw
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[【】\[\]《》「」（）()\s·、，,。.:：;；/|｜\-—_]/g, '')
    .toLowerCase();
}

const OWNER_ALIAS: Record<string, string> = {
  // 表里写的是「王妍、吕正豪」这种多人，取第一个在册的人即可（负责人只能一个）。
};

async function main(): Promise<void> {
  const rowsPath = process.argv.includes('--rows')
    ? process.argv[process.argv.indexOf('--rows') + 1]
    : '';
  const apply = process.argv.includes('--apply');
  if (!rowsPath) throw new Error('要给 --rows <json>');

  const rows = JSON.parse(readFileSync(rowsPath, 'utf8')) as SheetRow[];
  const existing = await db.execute<{
    id: string; number: number; title: string; state: string; prd_url: string | null;
  }>(sql`select id, number, title, state, prd_url from requirements where deleted_at is null`);
  const members = await db.execute<{ id: string; name: string }>(
    sql`select id, name from members where deactivated_at is null`);

  const IN_PROGRESS = new Set(['ready', 'dev', 'test', 'live']);
  const MOVABLE = new Set(['inbox', 'design', 'review']);

  const plan: Array<{ row: SheetRow; action: string; target?: typeof existing.rows[number] }> = [];
  for (const row of rows) {
    const key = norm(row.title);
    // 匹配用**包含**而不是相等：表里是「AI 搜索」，池子里可能是「AI 搜索（一期）」；
    // 相等会把这类判成「池里没有」，然后新建出一条重复需求。长度不足 4 的不参与包含匹配
    // （「S3」这种太短，会把一堆不相干的都算进来）。
    const hits = existing.rows.filter((r) => {
      const other = norm(r.title);
      if (other === key) return true;
      if (key.length < 4 || other.length < 4) return false;
      return other.includes(key) || key.includes(other);
    });
    // 多条命中时取「标题最像」的那条（归一后长度差最小），并列取编号小的。
    const byFit = [...hits].sort((a, b) => (
      Math.abs(norm(a.title).length - key.length) - Math.abs(norm(b.title).length - key.length)
    ) || a.number - b.number);
    const movable = byFit.find((r) => MOVABLE.has(r.state));
    const busy = hits.find((r) => IN_PROGRESS.has(r.state));
    if (movable) plan.push({ row, action: `挪到待排期（PAN-${movable.number} ${movable.state}）`, target: movable });
    else if (busy) plan.push({ row, action: `不动：已在做（PAN-${busy.number} ${busy.state}）`, target: busy });
    else if (hits.length > 0) plan.push({ row, action: `不动：其余状态（${hits.map((h) => `PAN-${h.number} ${h.state}`).join(' / ')}）` });
    else plan.push({ row, action: '新建到待排期' });
  }

  console.log(`共 ${rows.length} 行；${apply ? '真写' : '只出计划（加 --apply 才落库）'}`);
  for (const item of plan) console.log(`表${item.row.num.padStart(2)} ${item.row.title.slice(0, 24).padEnd(24)} → ${item.action}`);

  if (!apply) return;

  const ownerId = new Map(members.rows.map((m) => [m.name, m.id]));
  let moved = 0; let created = 0;
  for (const item of plan) {
    if (item.action.startsWith('不动')) continue;
    const prd = item.row.prd.trim() === '' ? null : item.row.prd.trim();
    const firstOwner = item.row.owner.split(/[、,，/]/)[0]?.trim() ?? '';
    const ownerMemberId = ownerId.get(firstOwner) ?? null;
    const priority = ({ P0: 'p0', P1: 'p1', P2: 'p2', P3: 'p3' } as Record<string, string>)[item.row.pri] ?? null;

    if (item.target) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          update requirements
             set state = 'queue', state_entered_at = now(),
                 prd_url = coalesce(${prd}, prd_url)
           where id = ${item.target!.id}`);
        await recordEvent(tx, {
          requirementId: item.target!.id, actor: 'system', type: 'requirement.state_changed',
          payload: { from: item.target!.state, to: 'queue', batch: 'sheet-queue-import-20261111' },
        });
        await recordEvent(tx, {
          requirementId: item.target!.id, actor: 'system', type: 'requirement.review_passed',
          payload: { importedFrom: '企微汇总表 kvf2dh', row: item.row.num, prdUrl: prd },
        });
      });
      moved += 1;
    } else {
      const inserted = await db.execute<{ id: string; number: number }>(sql`
        insert into requirements (title, state, state_entered_at, requester, owner_member_id,
                                  priority, prd_url, context)
        values (${item.row.title}, 'queue', now(), ${item.row.owner || '企微汇总表'},
                ${ownerMemberId}, ${priority}, ${prd}, ${null})
        returning id, number`);
      const row = inserted.rows[0]!;
      await db.transaction(async (tx) => {
        await recordEvent(tx, {
          requirementId: row.id, actor: 'system', type: 'requirement.created',
          payload: {
            importedFrom: '企微汇总表 kvf2dh',
            row: item.row.num,
            // batch 让这条事件不进通知（`read/notify.ts` 的 notBatch）：一次导入 8 条，
            // 每条都推给负责人就是刷屏。
            batch: 'sheet-queue-import-20261111',
          },
        });
        await recordEvent(tx, {
          requirementId: row.id, actor: 'system', type: 'requirement.review_passed',
          payload: { importedFrom: '企微汇总表 kvf2dh', row: item.row.num, prdUrl: prd },
        });
      });
      created += 1;
    }
  }
  console.log(`落库：挪动 ${moved} 条，新建 ${created} 条`);
}

main().finally(() => pool.end());
