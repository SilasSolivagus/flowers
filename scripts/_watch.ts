import { pool } from '../src/db/client.js';
await pool.query(`insert into app_settings (key, value) values ('sentinel.x','1') on conflict (key) do update set value='1'`);
let gone = 0;
const start = Date.now();
for (let i = 0; i < 60; i += 1) {
  await new Promise((r) => setTimeout(r, 300));
  const res = await pool.query(`select 1 from app_settings where key='sentinel.x'`);
  if (res.rowCount === 0) {
    gone += 1;
    console.log(`[${((Date.now() - start) / 1000).toFixed(1)}s] sentinel GONE (reset at ${new Date().toISOString()})`);
    await pool.query(`insert into app_settings (key, value) values ('sentinel.x','1') on conflict (key) do nothing`);
  }
}
console.log('done, resets seen:', gone);
const n = await pool.query('select count(*)::int as n from members');
console.log('members', n.rows[0].n);
await pool.end();
