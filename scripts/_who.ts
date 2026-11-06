import { pool } from '../src/db/client.js';
const seen = new Map<string, string>();
for (let i = 0; i < 80; i += 1) {
  const r = await pool.query(
    `select pid, coalesce(application_name,'-') as app, coalesce(client_addr::text,'local') as addr,
            state, left(coalesce(query,''),120) as q
       from pg_stat_activity where datname = current_database()`,
  );
  for (const row of r.rows as Array<{ pid: number; app: string; addr: string; state: string; q: string }>) {
    const id = `${row.pid}`;
    const val = `${row.app} ${row.addr} ${row.state} | ${row.q}`;
    if (!seen.has(id) || seen.get(id) !== val) seen.set(id, val);
  }
  await new Promise((res) => setTimeout(res, 100));
}
for (const [pid, val] of seen) console.log(pid, val.slice(0, 150));
await pool.end();
