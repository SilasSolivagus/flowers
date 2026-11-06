/**
 * 把「吕品」自己那三格写进库（key 从 owner 的凭据文件读，**不打印、不回显**）。
 *
 * 为什么用脚本而不是在页面上敲：页面上的 key 输入框要把值交给浏览器，而这个值
 * 不能出现在任何日志 / 终端 / 截图里。表单 → 测试 → 通过即存 这条路径由
 * 「填错 key」那一次真机操作与用例覆盖；这里只负责「库里有一份真的 key」。
 */
import { execFileSync } from 'node:child_process';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { saveMemberProviderSettings, memberProviderSettings } from '../src/core/uemaster/member-provider.js';

const key = execFileSync('python3', [
  '-c',
  "import yaml;print(yaml.safe_load(open('/Users/silas/.dsh/.credentials.yaml'))['refs']['AIONROUTER_API_KEY'])",
], { encoding: 'utf8' }).trim();

const found = await db.execute<{ id: string }>(sql`select id from members where name = '吕品'`);
const id = found.rows[0]?.id;
if (id === undefined) throw new Error('名册里没有吕品');
await saveMemberProviderSettings(db, id, {
  baseUrl: 'https://router.aionclaw.ai/v1',
  model: 'gpt-5.4-mini',
  apiKey: key,
});
const back = await memberProviderSettings(db, id);
console.log('member rows ok:', back !== null, '| baseUrl:', back?.baseUrl, '| model:', back?.model,
  '| key len:', back?.apiKey.length ?? 0, '| tail:', (back?.apiKey ?? '').slice(-4));
await pool.end();
