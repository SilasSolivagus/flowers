import { pool } from '../src/db/client.js';
const r = await pool.query(`select key, length(value)::int as n from app_settings order by key`);
console.log(r.rows.map((x: { key: string; n: number }) => `${x.key}(len=${x.n})`).join('\n'));
const c = await pool.query(`select (select count(*)::int from members) as m, (select count(*)::int from requirements) as r`);
console.log('counts', c.rows[0]);
await pool.end();
