import { it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { writeSetting, readSetting } from '../src/core/uemaster/settings.js';

it('three writes', async () => {
  await db.execute(sql`delete from app_settings`);
  for (const k of ['a.1', 'a.2', 'a.3']) {
    await writeSetting(db, k, `v-${k}`);
    const back = await readSetting(db, k);
    console.log('after write', k, '-> read', back);
  }
  const rows = await db.execute<{ key: string }>(sql`select key from app_settings order by key`);
  console.log('final', rows.rows.map((r) => r.key));
  const raw = await pool.query('select key from app_settings order by key');
  console.log('raw pool', raw.rows.map((r: { key: string }) => r.key));
});
