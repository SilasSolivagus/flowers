/**
 * 清理同名重复（2026-11-11）。
 *
 * 迁移把同一个规划拆成的多张卡都带过来了（联想PC 两条、支付宝两条、OpenAPI 七条…）。
 * 这一步只做**收口**：每一组留一条，其余搁置并注明「重复于 PAN-x」。
 *
 * 留谁：状态最靠前的那条（live > test > dev > ready > queue > review > design > inbox），
 * 同状态取**编号最大**（后建的通常是补录时更完整的那份）。已经搁置/拒绝的不动。
 *
 * 不碰已上线：一组里若输的那条已经上线，跳过整组并在报告里列出——「它发过版」这件事
 * 不能靠一次批量操作抹掉，要人来判断。
 *
 *   npx tsx scripts/dedupe-shelve.ts            # 只出清单
 *   npx tsx scripts/dedupe-shelve.ts --apply    # 真搁置（写事件，带 batch，不播报）
 */
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import { recordEvent } from '../src/core/events.js';
import { normalizeTitle } from '../src/core/requirements/duplicates.js';

const RANK: Record<string, number> = {
  inbox: 0, design: 1, review: 2, queue: 3, ready: 4, dev: 5, test: 6, live: 7,
  rejected: -1, shelved: -1,
};
const SKIP_STATES = new Set(['rejected', 'shelved']);

type Row = { id: string; number: number; title: string; state: string };

const apply = process.argv.includes('--apply');

const rows = await db.execute<Row>(sql`
  select id, number, title, state from requirements where deleted_at is null order by number`);

const groups = new Map<string, Row[]>();
for (const row of rows.rows) {
  const key = normalizeTitle(row.title);
  if (key === '') continue;
  groups.set(key, [...(groups.get(key) ?? []), { ...row, number: Number(row.number) }]);
}

let shelved = 0; let skipped = 0;
for (const [, group] of groups) {
  const active = group.filter((row) => !SKIP_STATES.has(row.state));
  if (active.length < 2) continue;
  const sorted = [...active].sort((a, b) => (RANK[b.state]! - RANK[a.state]!) || (b.number - a.number));
  const keeper = sorted[0]!;
  const losers = sorted.slice(1);

  if (losers.some((row) => row.state === 'live')) {
    skipped += losers.filter((row) => row.state === 'live').length;
    console.log(`跳过（输的那条已上线，要人判断）：${group.map((r) => `PAN-${r.number}(${r.state})`).join(' / ')}`);
    continue;
  }

  for (const loser of losers) {
    console.log(`PAN-${loser.number}(${loser.state}) → 搁置，重复于 PAN-${keeper.number}(${keeper.state})  「${loser.title}」`);
    if (!apply) continue;
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        update requirements set state = 'shelved', state_entered_at = now(),
               skip_reason = ${`重复于 PAN-${keeper.number}`}
         where id = ${loser.id}`);
      await recordEvent(tx, {
        requirementId: loser.id,
        actor: 'system',
        type: 'requirement.shelved',
        payload: {
          from: loser.state,
          to: 'shelved',
          reason: `同名重复，保留 PAN-${keeper.number}`,
          batch: 'dedupe-20261111',
        },
      });
    });
    shelved += 1;
  }
}

console.log(`\n${apply ? '已搁置' : '将搁置'} ${shelved} 条；跳过 ${skipped} 条（已上线）`);
await pool.end();
