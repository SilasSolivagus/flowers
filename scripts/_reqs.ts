import { pool } from '../src/db/client.js';
const r = await pool.query(`select number, title, state, prd_url is not null as has_prd, id from requirements order by number`);
for (const row of r.rows) console.log(row.number, row.state, row.has_prd ? 'prd' : '-', row.title);
const a = await pool.query(`select count(*)::int as n from uemaster_artifacts`);
const j = await pool.query(`select count(*)::int as n from uemaster_jobs`);
console.log('artifacts', a.rows[0].n, 'jobs', j.rows[0].n);
await pool.end();
