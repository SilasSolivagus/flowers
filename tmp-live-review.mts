import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from './src/db/client.js';
import { startGeneration, jobStatus } from './src/core/uemaster/start.js';

const found = await db.execute<{ id: string; number: number; title: string }>(
  sql`select id, number, title from requirements where number = 6`);
const req = found.rows[0];
if (!req) throw new Error('PAN-6 不在库里');

const t0 = Date.now();
const { jobId } = await startGeneration(db, '吕品', { requirementId: req.id, stage: 'review' });
console.log('job', jobId);

let view = await jobStatus(db, jobId);
for (let i = 0; i < 240 && view !== null && view.status === 'running'; i += 1) {
  await new Promise((r) => setTimeout(r, 2500));
  view = await jobStatus(db, jobId);
}
const elapsed = Date.now() - t0;
console.log('status', view?.status, 'error', view?.error);
console.log('url', view?.url);
console.log('elapsed_s', (elapsed / 1000).toFixed(1));

const attempts = await db.execute<{ attempt: number; phase: string; model: string; prompt_chars: number; output_chars: number; error: string | null; ms: number }>(
  sql`select attempt, phase, model, prompt_chars, output_chars, error, ms from uemaster_job_attempts where job_id = ${jobId} order by created_at, attempt, id`);
for (const row of attempts.rows) {
  console.log(`  attempt#${row.attempt} ${row.phase} ${row.model} prompt=${row.prompt_chars} out=${row.output_chars} ms=${row.ms} err=${row.error === null ? 'null' : row.error.slice(0, 160)}`);
}

if (view?.url) {
  const file = path.join('/Users/silas/flowers/data', `.${view.url}`);
  const info = await stat(file);
  const html = await readFile(file, 'utf8');
  const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? '';
  console.log('title', title);
  console.log('bytes', info.size);
  const nodesText = /var NODES = ([\s\S]*?);\n/.exec(html)?.[1] ?? '{}';
  const nodes = JSON.parse(nodesText) as Record<string, { title: string; anno: string[][] }>;
  const labels: Record<string, number> = {};
  for (const [id, node] of Object.entries(nodes)) {
    console.log(`  ${id} ${node.title}: ${node.anno.map((a) => a[0]).join(' | ')}`);
    for (const row of node.anno) labels[row[0]] = (labels[row[0]] ?? 0) + 1;
  }
  console.log('anno_labels', JSON.stringify(labels));
  const prd = await db.execute<{ n: string }>(sql`select count(*)::text as n from prd_snapshots where requirement_id = ${req.id}`);
  console.log('prd_snapshots', prd.rows[0]?.n);
}
await pool.end();
