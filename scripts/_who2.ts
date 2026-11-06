import { pool } from '../src/db/client.js';
const hits = new Set<string>();
for (let i = 0; i < 400; i += 1) {
  const r = await pool.query(
    `select pid, state, left(coalesce(query,''), 200) as q from pg_stat_activity where datname = current_database()`,
  );
  for (const row of r.rows as Array<{ pid: number; state: string; q: string }>) {
    if (/truncate|delete from app_settings|insert into members/i.test(row.q)) {
      hits.add(`${row.pid} ${row.state} ${row.q.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }
  await new Promise((res) => setTimeout(res, 20));
}
console.log([...hits].join('\n') || 'no truncate seen');
await pool.end();
