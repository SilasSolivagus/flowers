/**
 * 回填负责人（2026-11-11）。
 *
 * 起因：企微表核对页新建需求时，把表里「负责人」那一列写进了 `requester`（提出人文本），
 * 没有绑到 `members`。于是待排期里 20 条没有负责人——看板上「等谁」一栏是空的。
 *
 * 规则：
 * - 只处理 `owner_member_id is null` 且未删除的需求；
 * - 从 `requester` 里取**第一个**姓名（「赵越、王妍」取赵越），与在册成员精确比对；
 * - 对不上（例如「饶阳明」不在七人名册）就跳过，原样列出来；
 * - 写一条 `requirement.owner_assigned`（actor=system，带 batch，不播报）。
 *
 *   npx tsx scripts/backfill-owner.ts            # 只出清单
 *   npx tsx scripts/backfill-owner.ts --apply    # 真写
 */
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import { recordEvent } from '../src/core/events.js';

const apply = process.argv.includes('--apply');

const members = (await db.execute<{ id: string; name: string }>(
  sql`select id, name from members where deactivated_at is null`)).rows;
const byName = new Map(members.map((m) => [m.name, m.id]));

const rows = (await db.execute<{
  id: string; number: number; title: string; requester: string | null; state: string;
}>(sql`
  select id, number, title, requester, state from requirements
   where deleted_at is null and owner_member_id is null
   order by number`)).rows;

let filled = 0; let skipped = 0;
for (const row of rows) {
  const first = (row.requester ?? '').split(/[、,，/\s]/)[0]?.trim() ?? '';
  const memberId = byName.get(first);
  if (memberId === undefined) {
    if (first !== '') { skipped += 1; console.log(`跳过 PAN-${row.number}「${row.title.slice(0, 16)}」——「${first}」不在名册`); }
    continue;
  }
  console.log(`PAN-${row.number}（${row.state}）→ 负责人 ${first}  「${row.title.slice(0, 18)}」`);
  if (!apply) { filled += 1; continue; }
  await db.transaction(async (tx) => {
    await tx.execute(sql`update requirements set owner_member_id = ${memberId} where id = ${row.id}`);
    await recordEvent(tx, {
      requirementId: row.id, actor: 'system', type: 'requirement.owner_assigned',
      payload: { from: null, to: first, batch: 'owner-backfill-20261111', reason: '按提出人姓名回填' },
    });
  });
  filled += 1;
}

console.log(`\n${apply ? '已回填' : '将回填'} ${filled} 条；跳过 ${skipped} 条（姓名不在名册）`);
await pool.end();
