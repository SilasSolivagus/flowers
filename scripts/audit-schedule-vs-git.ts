#!/usr/bin/env tsx
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync, statSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
export const MAX_DIGEST_CHARS = 600;
export type Card = { number: number; title: string; state: string; enteredAt: string | Date; dueAt: string | Date | null; testAt: string | Date | null };
export type Commit = { repo: string; date: string; subject: string };

export function parseArgs(argv: string[]): { dryRun: boolean } {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--help' || arg === '-h') return { dryRun: true };
    else throw new Error(`未知参数：${arg}（只认 --dry-run）`);
  }
  return { dryRun };
}

function dateOf(value: string | Date | null): number | null {
  if (value === null) return null;
  const at = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(at) ? at : null;
}
export function filterCards(cards: Card[], now = new Date()): Card[] {
  const current = now.getTime(), soon = current + 5 * 864e5, stuck = current - 10 * 864e5;
  return cards.filter((c) => {
    const due = dateOf(c.dueAt), test = dateOf(c.testAt), entered = dateOf(c.enteredAt);
    return (due !== null && due <= soon) || (test !== null && test <= soon) || (c.state === 'dev' && entered !== null && entered < stuck);
  });
}
export function formatDigest(cards: Card[], commits: Commit[], now = new Date()): string {
  const lines = [`## 排期 vs Git · ${now.toISOString().slice(0, 10)}`, `近 7 天提交：${commits.length} 个${commits.length ? `（${commits.slice(0, 4).map(c => `${c.repo}: ${c.subject}`).join('；')}）` : '；镜像内无近期提交'}`];
  if (!cards.length) lines.push('近期无到期/测试卡或开发停滞卡。');
  for (const c of cards) {
    const due = dateOf(c.dueAt), test = dateOf(c.testAt), entered = dateOf(c.enteredAt);
    const late = due !== null && due < now.getTime();
    const stuck = c.state === 'dev' && entered !== null && entered < now.getTime() - 10 * 864e5;
    const promise = test !== null && test < now.getTime() + 5 * 864e5 ? `测试 ${new Date(test).toISOString().slice(0, 10)}` : due === null ? '无交付日期' : `交付 ${new Date(due).toISOString().slice(0, 10)}`;
    lines.push(`- ${late ? '逾期' : stuck ? '停滞' : '排期'} #${c.number} ${c.title}（${c.state}；${promise}）${late || stuck ? ' ⚠' : ''}`);
  }
  const full = lines.join('\n');
  if (full.length <= MAX_DIGEST_CHARS) return full;
  return `${full.slice(0, MAX_DIGEST_CHARS - 1).replace(/\s+$/, '')}…`;
}

export async function synthesizeDigest(cards: Card[], commits: Commit[], now = new Date()): Promise<string> {
  const facts = formatDigest(cards, commits, now);
  const prompt = `根据以下排期与提交事实写简洁中文 Markdown 审计摘要，突出可疑的无提交、逾期/静默卡。不得添加事实，最多 600 字符。\n${facts}`;
  const binary = process.env.DSH_BIN ?? 'dsh';
  let command = binary, args = ['headless', prompt];
  // Some installs ship dsh as a Node CLI symlink whose target lacks its executable bit.
  // Run that same CLI through Node so execFile remains shell-free and works in cron too.
  try {
    const info = statSync(binary);
    if ((info.mode & 0o111) === 0) { command = process.execPath; args = [path.resolve(path.dirname(binary), readlinkSync(binary)), 'headless', prompt]; }
  } catch { /* let execFile report a missing/unusable configured binary */ }
  const { stdout } = await exec(command, args, { timeout: 120_000, maxBuffer: 128 * 1024 });
  const text = stdout.trim();
  return text.length <= MAX_DIGEST_CHARS ? text : `${text.slice(0, MAX_DIGEST_CHARS - 1).replace(/\s+$/, '')}…`;
}

function enqueueDigest(digest: string, dateKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/opt/123pan/tools/bin/wecom-enqueue', ['--channel', 'aibot', '--target', 'silas', '--type', 'markdown', '--dedup-key', `flowers-git-audit:${dateKey}`, '--stdin'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `wecom-enqueue exited ${code}`)));
    child.stdin.end(digest);
  });
}

function loadProductionEnv(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const file = path.join(root, '.env.production');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/.exec(line);
    if (!match || process.env[match[1]!] !== undefined) continue;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]!] = value;
  }
}

export async function scanMirrors(roots: string[], since = '7 days ago'): Promise<Commit[]> {
  const dirs: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some(e => e.name === 'HEAD') && entries.some(e => e.name === 'objects')) { dirs.push(dir); return; }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
  };
  for (const root of roots) if (existsSync(root) && statSync(root).isDirectory()) walk(root, 0);
  const commits: Commit[] = [];
  for (const dir of dirs) {
    const repo = path.basename(dir).replace(/\.git$/, '');
    try {
      const { stdout } = await exec('git', ['--git-dir', dir, 'log', `--since=${since}`, '--format=%cs%x09%s', '-n', '30'], { timeout: 20_000, maxBuffer: 1024 * 1024 });
      for (const row of stdout.trim().split('\n')) { const [date, ...subject] = row.split('\t'); if (date) commits.push({ repo, date, subject: subject.join('\t') }); }
    } catch { /* an unreadable mirror is not a commit */ }
  }
  return commits;
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv.slice(2));
  loadProductionEnv();
  const { db, pool } = await import('../src/db/client.js');
  const { sql } = await import('drizzle-orm');
  try {
    const result = await db.execute<Card>(sql`select number, title, state, state_entered_at as "enteredAt", commit_due_at as "dueAt", commit_test_at as "testAt" from requirements where deleted_at is null and state in ('ready','dev','test') and (commit_due_at <= now() + interval '5 days' or commit_due_at < now() or commit_test_at <= now() + interval '5 days' or (state = 'dev' and state_entered_at < now() - interval '10 days')) order by coalesce(commit_due_at, commit_test_at), number`);
    const roots = (process.env.REPO_ROOT ?? '/srv/123pan-mirror:/srv/123pan-mirror-gl').split(':').filter(Boolean);
    const commits = await scanMirrors(roots);
    const digest = await synthesizeDigest(filterCards(result.rows, new Date()), commits);
    if (dryRun) { process.stdout.write(`${digest}\n`); return; }
    const key = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    await enqueueDigest(digest, key);
    process.stdout.write(`已入队：${key}\n`);
  } finally { await pool.end(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
