import { pool } from '../src/db/client.js';
const c = await pool.query('select count(*)::int as n from app_settings');
console.log('app_settings rows:', c.rows[0].n);
const r = await pool.query('select key, value from app_settings order by key');
for (const row of r.rows as Array<{ key: string; value: string }>) {
  const v = row.key.toLowerCase().includes('apikey')
    ? `${row.value.slice(0, 3)}… len=${row.value.length} tail=${row.value.slice(-4)}`
    : row.value;
  console.log(row.key, '=', v);
}
const m = await pool.query('select id, name, role from members order by name');
console.log('members:', m.rows.map((x: {name: string}) => x.name).join(', '));
await pool.end();
