/**
 * 端到端：**只有成员自己的 key**（平台上一条都没有）时，生成还能不能跑通。
 *
 * 走的是服务层与 worker 的真路径（`startGeneration` 的那两段：策略 → compose →
 * attach → 收口），只是不甩 detached 进程、直接在进程里跑 `runJob`。
 * 库是隔离的 `flowers_p212`，不碰共享的 flowers。
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { saveMemberProviderSettings } from '../src/core/uemaster/member-provider.js';
import { artifactFile } from '../src/core/uemaster/store.js';
import { resolveStrategy, jobStatus, runJob } from '../src/core/uemaster/start.js';

const key = execFileSync('python3', [
  '-c',
  "import yaml;print(yaml.safe_load(open('/Users/silas/.dsh/.credentials.yaml'))['refs']['AIONROUTER_API_KEY'])",
], { encoding: 'utf8' }).trim();

const who = await db.execute<{ id: string }>(sql`select id from members where name = '吕品'`);
const memberId = who.rows[0]!.id;
await saveMemberProviderSettings(db, memberId, {
  baseUrl: 'https://router.aionclaw.ai/v1', model: 'gpt-5.4-mini', apiKey: key,
});
console.log('platform rows:', (await db.execute<{ n: number }>(
  sql`select count(*)::int as n from app_settings where key like 'provider.%'`)).rows[0]!.n);
console.log('strategy 吕品:', (await resolveStrategy('吕品')).kind,
  '| strategy 房超:', (await resolveStrategy('房超')).kind);

const target = await db.execute<{ id: string; number: number; state: string }>(sql`
  select id, number, state from requirements where state = 'inbox' order by number limit 1`);
const req = target.rows[0]!;
console.log('target', `PAN-${req.number}`, req.state);

const started = Date.now();
const jobId = await db.transaction(async (tx) => {
  const ins = await tx.execute<{ id: string }>(sql`
    insert into uemaster_jobs (requirement_id, stage, status)
    values (${req.id}, 'evaluate', 'running') returning id`);
  return ins.rows[0]!.id;
});
await runJob(db, jobId, { actor: '吕品' });
console.log(`runJob ${((Date.now() - started) / 1000).toFixed(1)}s →`, await jobStatus(db, jobId));

const art = await db.execute<{ url: string }>(sql`
  select a.url from uemaster_jobs j join uemaster_artifacts a on a.id = j.artifact_id where j.id = ${jobId}`);
const url = art.rows[0]?.url;
if (url === undefined) { console.log('NO ARTIFACT'); await pool.end(); process.exit(1); }
const html = await readFile(artifactFile(url), 'utf8');
console.log('artifact', url, 'bytes', html.length, '| has svg:', html.includes('<svg'), '| title bytes:', html.slice(0, 0).length + 0);
const after = await db.execute<{ state: string }>(sql`select state from requirements where id = ${req.id}`);
console.log('state after:', after.rows[0]!.state);
await pool.end();
