/**
 * 把平台那三行 provider.* 写回去（key 从 owner 的凭据文件读，**不打印**）。
 *
 * 为什么是个脚本：`tests/provider.test.ts` 的 beforeEach 会 `delete from app_settings
 * where key like 'provider.%'`，所以每一次整轮 vitest 之后这三行都会消失。收口时跑一遍。
 */
import { execFileSync } from 'node:child_process';
import { db, pool } from '../src/db/client.js';
import { saveProviderSettings } from '../src/core/uemaster/settings.js';

const read = (ref: string): string =>
  execFileSync('python3', ['-c', `import yaml;print(yaml.safe_load(open('/Users/silas/.dsh/.credentials.yaml'))['refs']['${ref}'])`], { encoding: 'utf8' }).trim();

await saveProviderSettings(db, {
  baseUrl: 'https://router.aionclaw.ai/v1',
  model: 'gpt-5.4-mini',
  apiKey: read('AIONROUTER_API_KEY'),
});

const rows = await db.execute<{ key: string; n: number }>(
  // 只报「有几行、长度多少」，绝不报值。
  (await import('drizzle-orm')).sql`select key, length(value)::int as n from app_settings where key like 'provider.%' order by key`,
);
for (const row of rows.rows) console.log(row.key, `len=${row.n}`);
const counts = await db.execute<{ m: number; r: number; v: number }>(
  (await import('drizzle-orm')).sql`select (select count(*)::int from members) as m,
    (select count(*)::int from requirements) as r,
    (select count(*)::int from releases) as v`,
);
console.log('counts', counts.rows[0]);
await pool.end();
