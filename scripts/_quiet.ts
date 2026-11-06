import { pool } from '../src/db/client.js';
// 3 秒内 members 有没有被清空（resetDb 的 truncate 会连 members 一起清）。
let quiet = 0;
for (let i = 0; i < 40; i += 1) {
  const r = await pool.query('select count(*)::int as n from members');
  if (r.rows[0].n > 0) quiet += 1;
  await new Promise((res) => setTimeout(res, 250));
}
console.log('quiet samples', quiet, '/ 40');
await pool.end();
