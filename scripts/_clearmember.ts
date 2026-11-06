import { pool } from '../src/db/client.js';
const r = await pool.query(`delete from app_settings where key like 'member.%'`);
console.log('deleted member rows:', r.rowCount);
const left = await pool.query(`select key from app_settings order by key`);
console.log(left.rows.map((x: { key: string }) => x.key).join(', '));
await pool.end();
