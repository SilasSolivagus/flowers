import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { resetDb, seedPeople } from '../tests/helpers/db.js';
import { memberProviderParts, memberProviderSettings, saveMemberProviderSettings } from '../src/core/uemaster/member-provider.js';
import { resolveProviderConfig } from '../src/core/uemaster/provider.js';

await resetDb();
await seedPeople();
const r = await db.execute<{ id: string }>(sql`select id from members where name = '吕品'`);
const id = r.rows[0]!.id;
console.log('id', id);
await saveMemberProviderSettings(db, id, { baseUrl: 'https://own.example/v1', apiKey: 'sk-own-ABCDEFGH9876', model: 'own-model' });
const rows = await db.execute<{ key: string; value: string }>(sql`select key, value from app_settings`);
console.log('rows', rows.rows.map((x) => [x.key, x.value.slice(0, 12)]));
console.log('parts', await memberProviderParts(db, id));
console.log('settings', await memberProviderSettings(db, id));
console.log('resolved', await resolveProviderConfig('吕品'));
await pool.end();
