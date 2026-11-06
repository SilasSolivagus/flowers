import { pool } from '../src/db/client.js';
const start = Date.now();
let last = 0;
const samples: number[] = [];
while (Date.now() - start < 15000) {
  await new Promise((r) => setTimeout(r, 500));
  const r = await pool.query(`select count(*)::int as n from _audit where what = 'truncate' and at > now() - interval '1 second'`);
  samples.push(r.rows[0].n);
}
console.log('truncates per second sample:', samples.join(','));
await pool.query('drop trigger if exists _audit_del on app_settings');
await pool.query('drop trigger if exists _audit_tr on app_settings');
await pool.query('drop function if exists _audit_row()');
await pool.query('drop function if exists _audit_trunc()');
await pool.query('drop table if exists _audit');
console.log('audit cleaned');
await pool.end();
