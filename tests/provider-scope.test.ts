import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { resolveProvider } from '../src/core/uemaster/provider.js';
import { writeSetting } from '../src/core/uemaster/settings.js';
import { resetDb, seedPeople } from './helpers/db.js';
beforeEach(async () => { await resetDb(); await seedPeople();
  await writeSetting(db, 'provider.baseUrl', 'https://api.deepseek.com/v1');
  await writeSetting(db, 'provider.apiKey', 'sk-platform');
  await writeSetting(db, 'provider.model', 'deepseek-flash');
});
afterAll(async () => { await pool.end(); });
describe('平台 key 只给超管', () => {
  it('PM 没配自己的 → null（不再退回平台）', async () => {
    expect(await resolveProvider('吕品')).toBeNull();
  });
  it('超管 → platform', async () => {
    const r = await resolveProvider('房超');
    expect(r?.scope).toBe('platform');
  });
  it('成员自己配了 → member', async () => {
    const id = (await db.execute<{id:string}>(sql`select id from members where name='吕品'`)).rows[0]!.id;
    await db.execute(sql`insert into app_settings (key, value) values
      (${`member.${id}.provider.baseUrl`}, 'https://x/v1'),
      (${`member.${id}.provider.apiKey`}, 'sk-me'),
      (${`member.${id}.provider.model`}, 'm')`);
    expect((await resolveProvider('吕品'))?.scope).toBe('member');
  });
});
