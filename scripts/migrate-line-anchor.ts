import { pool } from '../src/db/client.js';
import { realignOpenReviewAssignments } from '../src/db/line-anchor.js';

/**
 * `npm run db:anchor` —— P4-06 的数据迁移（一次性的，可以重复跑）。
 *
 * 为什么是脚本而不是 `src/db/migrations/*.sql`：这次改的是**权限锚点**，要动的数据是
 * 「还开着的评审派单」——它不是 schema 变化，而是一次需要说清楚「动了哪几条、哪几条
 * 留给超管」的重算。drizzle 的迁移文件只有「跑过 / 没跑过」两种状态，没有地方放这份
 * 报告；而这份报告正是这一支存在的理由（错签字比没人签更坏，所以每一条作废都要能
 * 指名道姓地交代）。
 *
 * 输出三段：改派的、作废的、本来就对的。一条都没动也照常打印——「跑过了、什么都不用
 * 改」与「忘了跑」在屏幕上必须长得不一样。
 */

const report = await realignOpenReviewAssignments();

console.log('P4-06 评审派单重算：按「负责人的条线」');
console.log(`  改派 ${report.moved.length} 条，作废 ${report.voided.length} 条，本来就对 ${report.kept} 条`);

for (const row of report.moved) {
  console.log(`  PAN-${row.number}「${row.title}」${row.from} → ${row.to}`);
}
for (const row of report.voided) {
  console.log(`  PAN-${row.number}「${row.title}」作废 ${row.reviewer} 的派单：${row.why}`);
}
if (report.voided.length > 0) {
  console.log('  作废的这几条现在只有超管能签（抽屉的评审段会显示「作废」）。');
}
if (report.moved.length === 0 && report.voided.length === 0) {
  console.log('  没有需要改动的派单。');
}

await pool.end();
