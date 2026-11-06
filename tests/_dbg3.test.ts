import { it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';

it('who else', async () => {
  const r = await db.execute<{ pid: number; app: string; state: string; q: string }>(sql`
    select pid, coalesce(application_name,'') as app, state, left(coalesce(query,''),60) as q
      from pg_stat_activity where datname = current_database()`);
  for (const row of r.rows) console.log(row.pid, row.app, row.state, '|', row.q);
});
