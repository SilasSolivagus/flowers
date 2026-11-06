import { pool } from '../src/db/client.js';
const r = await pool.query(`select id, state from requirements where state = 'inbox' limit 1`);
console.log(r.rows[0]?.id ?? 'none', r.rows[0]?.state ?? '');
await pool.end();
