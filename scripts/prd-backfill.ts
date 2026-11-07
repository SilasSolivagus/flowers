/**
 * 老系统的 PRD 链接回填（迁移 `0025_prd_url_backfill.sql`）的取数器与执行器。
 *
 *   npx tsx scripts/prd-backfill.ts              # 默认 dry-run：只打印会发生什么
 *   npx tsx scripts/prd-backfill.ts --emit       # 重新生成 src/db/seeds/prd-url-backfill.json
 *   npx tsx scripts/prd-backfill.ts --apply      # 装载种子 + 重跑 0025（幂等）
 *
 * ## 为什么是「种子文件 + 脚本」，而不是把 203 条塞进迁移
 *
 * `documents.external_url` 只在 Flower（老系统，生产实例）里。CI 与新克隆都没有那条
 * ssh 通道，而迁移文件是由 **pg 驱动**逐条执行的纯 SQL——它唯一能看见的数据就是文件
 * 自己的字节。于是把「数据」与「规则」分开：
 *
 * - **规则**在 `src/db/migrations/0025_prd_url_backfill.sql`（一条 `update ... from
 *   prd_url_backfill_seed`，幂等，判据全在里面，可 review）；
 * - **数据**在 `src/db/seeds/prd-url-backfill.json`（本脚本 `--emit` 生成，203 行
 *   `{title, url}`，按标题码点排序，一个 title 一行 diff）；
 * - 本脚本的 `--apply` 把种子装进 `prd_url_backfill_seed` 再**重跑 0025 那个文件**
 *   —— 跑的是迁移自己的 SQL，不是这里另抄一份口径。
 *
 * `npm run db:migrate` 同样会执行 0025：那时种子表还是空的（0025 自己建的空表），
 * 命中的行是 0 —— 空库/新克隆因此是「跑过、没东西可填」，而不是「报错」。
 *
 * ## 取数口径（`--emit`）
 *
 * 只认一件事：`documents.title` 与 `requirements.title` **全等**（不 trim、不归一化、
 * 不分大小写）。这是老系统里**唯一存在**的链接：
 *
 * - `entity_links` 是空表（0 行）；
 * - `requirements.brief_document_id` / `change_document_id` 全为 null（258 行里 0 行有值）；
 * - `documents.title` 里没有 PAN 号（0 行命中 `PAN-[0-9]`）。
 *
 * 而且 `documents.title` 本身就是**需求标题**：205 条带 URL 的文档标题，全部能在我们
 * 的 815 条需求里找到同名行。所以「按标题对上」不是猜测，是老系统里那条链接的全部。
 *
 * 歧义（同题多于一条需求）**不猜**：两个候选各写一半的概率是 50%，而写错的 PRD
 * 链接比没有链接更坏（`prd_snapshots` 与材料生成会把它当权威源）。这类只报出来，
 * 由 owner 选。
 *
 * ## 可撤销性
 *
 * 回填只写 `prd_url` 一列，且只写 `prd_url is null` 的迁移行。撤销是一条 SQL：
 *
 *   update requirements set prd_url = null
 *    where legacy_ref is not null and title in (select title from prd_url_backfill_seed);
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';

const SSH_HOST = process.env.FLOWER_SSH_HOST ?? 'dogyun';
const CONTAINER = process.env.FLOWER_PG_CONTAINER ?? 'flower-postgres-1';
const DB_NAME = process.env.FLOWER_DB_NAME ?? 'flower';
const DB_USER = process.env.FLOWER_DB_USER ?? 'flower_admin';

const SEED_PATH = path.join(process.cwd(), 'src/db/seeds/prd-url-backfill.json');
const MIGRATION_PATH = path.join(process.cwd(), 'src/db/migrations/0025_prd_url_backfill.sql');
const SEED_TABLE = 'prd_url_backfill_seed';

// ─── 取数 ────────────────────────────────────────────────────────────────────

/**
 * Flower 的 `documents` 全表（217 行）。
 *
 * 取全量而不是只取「有 URL」的 205 行：报告要能说清「600 条没有 PRD」里有多少是
 * **有文档但文档没有 URL**，那一半只有把空 URL 的行也拿回来才数得出来。
 *
 * 用 `copy ... to stdout` + base64：`json_agg` 里的换行会被 COPY 的 text 格式再转义
 * 一次，直接 `JSON.parse` 会炸（`migrate-flower.ts` 同一个坑，同一套解法）。
 */
const DOCUMENTS_SQL = `
copy (select encode(convert_to(coalesce(json_agg(x)::text, '[]'), 'utf8'), 'base64') from (
  select d.title,
         coalesce(d.external_url, '') as external_url,
         d.kind
    from documents d
) x) to stdout;
`;

type FlowerDoc = { title: string; external_url: string; kind: string };

function loadFlowerDocuments(): FlowerDoc[] {
  const res = spawnSync(
    'ssh',
    [SSH_HOST, `docker exec -i ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -t -A -q -f -`],
    { input: DOCUMENTS_SQL, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`读取 Flower 的 documents 失败（exit ${res.status}）：${res.stderr.trim()}`);
  }
  const line = res.stdout.split('\n').map((item) => item.trim()).filter(Boolean).pop();
  if (line === undefined) throw new Error('Flower 没有返回 documents。');
  // base64 字母表里没有反斜杠，所以删掉 COPY 转义出来的 `\n` 是安全的。
  const json = Buffer.from(line.replace(/\\n/g, ''), 'base64').toString('utf8');
  return JSON.parse(json) as FlowerDoc[];
}

type LocalReq = {
  number: number;
  legacy_ref: string | null;
  title: string;
  prd_url: string | null;
};

async function loadRequirements(): Promise<LocalReq[]> {
  const res = await db.execute<LocalReq>(sql`
    select number, legacy_ref, title, prd_url from requirements order by number`);
  return res.rows;
}

// ─── 配对（口径，与 0025 的 where 一一对应） ─────────────────────────────────

export type Pair = { title: string; url: string };

export type Ambiguous = {
  title: string;
  url: string;
  candidates: { number: number; migrated: boolean; prdUrl: string | null }[];
};

export type Plan = {
  pairs: Pair[];
  ambiguous: Ambiguous[];
  /** 迁移行里没有 PRD 的原因分类（合计 = 迁移行 − pairs.length）。 */
  gaps: {
    /** 一条同名文档都没有。 */
    noDocument: number[];
    /** 有同名文档，但文档的 external_url 是空的。 */
    documentWithoutUrl: number[];
    /** 有同名文档且有 URL，但同名需求不止一条（本题的 2 条）。 */
    ambiguous: number[];
    /** 已经填过（不该出现：迁移行里 prd_url 全为 null）。 */
    alreadyFilled: number[];
  };
  counts: { total: number; migrated: number; demo: number; docs: number; docsWithUrl: number };
};

/** 标题全等比较用的键：就是标题本身（刻意不做 trim / 归一化）。 */
const key = (title: string): string => title;

export function buildPlan(docs: FlowerDoc[], reqs: LocalReq[]): Plan {
  const withUrl = docs.filter((d) => d.external_url.trim() !== '');
  const withoutUrl = docs.filter((d) => d.external_url.trim() === '');

  // 同一标题在文档侧是否只有一条（217 行里没有重名，但这里有判据，让报告说得出来）。
  const urlDocTitles = new Map<string, FlowerDoc>();
  for (const d of withUrl) urlDocTitles.set(key(d.title), d);
  const emptyDocTitles = new Set(withoutUrl.map((d) => key(d.title)));

  const byTitle = new Map<string, LocalReq[]>();
  for (const r of reqs) {
    const k = key(r.title);
    const bucket = byTitle.get(k);
    if (bucket === undefined) byTitle.set(k, [r]);
    else bucket.push(r);
  }

  const pairs: Pair[] = [];
  const ambiguous: Ambiguous[] = [];
  const gaps: Plan['gaps'] = {
    noDocument: [], documentWithoutUrl: [], ambiguous: [], alreadyFilled: [],
  };

  // 文档侧驱动：只有「有 URL 的文档」能提供一条链接。
  for (const [title, doc] of urlDocTitles) {
    const matches = byTitle.get(title) ?? [];
    if (matches.length === 0) continue; // 与需求无关的文档（217 里的一条使用手册等）
    if (matches.length > 1) {
      // 歧义只在「这些候选里至少有迁移行、且都还没填」时才有意义。
      const open = matches.filter((r) => r.legacy_ref !== null && r.prd_url === null);
      if (open.length === 0) continue;
      ambiguous.push({
        title,
        url: doc.external_url,
        candidates: matches.map((r) => ({
          number: r.number, migrated: r.legacy_ref !== null, prdUrl: r.prd_url,
        })),
      });
      continue;
    }
    const only = matches[0]!;
    if (only.legacy_ref === null) continue; // 演示行不填（0025 的 legacy_ref 判据）
    if (only.prd_url !== null) continue;
    pairs.push({ title, url: doc.external_url });
  }

  // 缺口分类：迁移行里没被配上的那些。
  const paired = new Set(pairs.map((p) => key(p.title)));
  const ambiguousTitles = new Set(ambiguous.map((a) => key(a.title)));
  for (const r of reqs) {
    if (r.legacy_ref === null) continue;
    if (r.prd_url !== null) { gaps.alreadyFilled.push(r.number); continue; }
    const k = key(r.title);
    if (paired.has(k)) continue;
    if (ambiguousTitles.has(k)) gaps.ambiguous.push(r.number);
    else if (emptyDocTitles.has(k)) gaps.documentWithoutUrl.push(r.number);
    else gaps.noDocument.push(r.number);
  }

  // 排序用码点比较（不用 localeCompare）：同一个仓库在任何机器上 emit 出的字节一致。
  pairs.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  ambiguous.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));

  return {
    pairs,
    ambiguous,
    gaps,
    counts: {
      total: reqs.length,
      migrated: reqs.filter((r) => r.legacy_ref !== null).length,
      demo: reqs.filter((r) => r.legacy_ref === null).length,
      docs: docs.length,
      docsWithUrl: withUrl.length,
    },
  };
}

// ─── emit ────────────────────────────────────────────────────────────────────

/**
 * 写种子文件。
 *
 * 手工排版而不是 `JSON.stringify(…, null, 2)`：后者把一条配对拆成 4 行，203 条就是
 * 800 多行，review 时看不出「哪几条被加进来/删掉了」。这里**一条配对一行**，排序固定，
 * 于是任何一次重新生成都只剩真正变化的那几行 diff——这份文件是数据，它唯一的用途
 * 就是被人看。
 *
 * `generatedAt` 用本地日期（`en-CA` 就是 `YYYY-MM-DD`）：`toISOString()` 是 UTC，
 * 早上 8 点之前生成的会写成前一天，而报告里对的是本地那一天。
 */
function emit(plan: Plan): void {
  const head = {
    source: 'Flower documents（kind=change，external_url 非空）via ssh dogyun',
    linkBasis: 'documents.title = requirements.title（全等，不 trim / 不归一化）',
    generatedAt: new Date().toLocaleDateString('en-CA'),
    count: plan.pairs.length,
  };
  const headLines = Object.entries(head).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const pairLines = plan.pairs.map((p) => `    ${JSON.stringify({ title: p.title, url: p.url })}`);
  const text = `{\n${headLines.join(',\n')},\n  "pairs": [\n${pairLines.join(',\n')}\n  ]\n}\n`;
  JSON.parse(text); // 写坏了自己炸，别把一份解析不了的种子留在仓库里
  writeFileSync(SEED_PATH, text, 'utf8');
  console.log(`写入 ${path.relative(process.cwd(), SEED_PATH)}：${plan.pairs.length} 条配对。`);
}

// ─── apply ───────────────────────────────────────────────────────────────────

type SeedFile = { count: number; pairs: Pair[] };

function readSeed(): SeedFile {
  const parsed = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as SeedFile;
  if (!Array.isArray(parsed.pairs)) throw new Error(`${SEED_PATH} 里没有 pairs 数组。`);
  for (const p of parsed.pairs) {
    if (typeof p.title !== 'string' || typeof p.url !== 'string' || p.title === '') {
      throw new Error('种子文件里有空的 title / url：0025 会把空 URL 当成一条 PRD 链接。');
    }
  }
  return parsed;
}

/**
 * `db` 与事务里的 `tx` 在 `execute` 上是同一个形状（`tx` 是 `PgDatabase` 的子类），
 * 所以两个入口共用这一份 helper：回填要么全在事务里跑（dry-run 用回滚实现），
 * 要么不跑——不另建一条「用 db 直接跑」的路径，否则 dry-run 与 apply 会分成两套口径。
 */
type Executor = Pick<typeof db, 'execute'>;

/** 把种子装进 `prd_url_backfill_seed`（幂等：内容没变就不写）。 */
async function loadSeed(tx: Executor, pairs: Pair[]): Promise<number> {
  if (pairs.length === 0) return 0;
  const values = pairs.map((p) => sql`(${p.title}, ${p.url})`);
  const res = await tx.execute(sql`
    insert into prd_url_backfill_seed (title, url)
    values ${sql.join(values, sql`, `)}
    on conflict (title) do update
       set url = excluded.url, loaded_at = now()
     where prd_url_backfill_seed.url is distinct from excluded.url`);
  return res.rowCount ?? 0;
}

/** 逐条执行 0025 的 SQL（按 drizzle 的分隔符切），返回被 update 改掉的行数。 */
async function runMigrationFile(tx: Executor, text: string = migrationText()): Promise<number> {
  let changed = 0;
  for (const statement of text.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed === '') continue;
    const res = await tx.execute(sql.raw(trimmed));
    // `create table if not exists` 也给 rowCount=0；只有 update 会带出非零。
    changed += res.rowCount ?? 0;
  }
  return changed;
}

function migrationText(): string {
  return readFileSync(MIGRATION_PATH, 'utf8');
}

type Stats = {
  total: number; migrated: number; demo: number;
  migratedWithPrd: number; demoWithPrd: number;
};

async function stats(tx: Executor): Promise<Stats> {
  const res = await tx.execute<Stats>(sql`
    select count(*)::int                                                    as total,
           count(*) filter (where legacy_ref is not null)::int               as migrated,
           count(*) filter (where legacy_ref is null)::int                   as demo,
           count(*) filter (where legacy_ref is not null
                              and prd_url is not null)::int                  as "migratedWithPrd",
           count(*) filter (where legacy_ref is null
                              and prd_url is not null)::int                  as "demoWithPrd"
      from requirements`);
  return res.rows[0]!;
}

const ROLLBACK = Symbol('rollback');

async function apply(pairs: Pair[], dryRun: boolean): Promise<void> {
  const before = await stats(db);
  console.log('执行前：', JSON.stringify(before));

  let changed = 0;
  let seeded = 0;
  try {
    await db.transaction(async (tx) => {
      // 种子表由 0025 建。表不存在 = 这张库还没跑过迁移，先给一句能照做的报错，
      // 而不是让 pg 抛 `relation "prd_url_backfill_seed" does not exist`。
      const exists = await tx.execute<{ t: string | null }>(
        sql`select to_regclass(${SEED_TABLE})::text as t`,
      );
      if (exists.rows[0]?.t == null) {
        throw new Error(`库里没有 ${SEED_TABLE}：先跑 \`npm run db:migrate\`（0025 建这张表）。`);
      }
      seeded = await loadSeed(tx, pairs);
      changed = await runMigrationFile(tx);
      if (dryRun) throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }

  const after = dryRun ? before : await stats(db);
  console.log(`种子表：装载 ${seeded} 行${dryRun ? '（dry-run，已回滚）' : ''}`);
  console.log(`0025：${dryRun ? '将会' : '已'}写入 ${changed} 条 prd_url`);
  console.log(dryRun ? '（dry-run 未写库）执行后：' : '执行后：', JSON.stringify(after));
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

function printPlan(plan: Plan): void {
  const c = plan.counts;
  console.log(`需求 ${c.total} 条（迁移 ${c.migrated} · 演示 ${c.demo}）`);
  console.log(`文档 ${c.docs} 条，其中带 external_url ${c.docsWithUrl} 条`);
  console.log(`一对一 ${plan.pairs.length} 条`);
  console.log(`歧义 ${plan.ambiguous.length} 条（不填，交 owner 选）：`);
  for (const a of plan.ambiguous) {
    console.log(`  「${a.title}」`);
    console.log(`    ${a.url}`);
    console.log(`    候选：${a.candidates.map((x) => `PAN-${x.number}${x.migrated ? '' : '（演示）'}`).join(' · ')}`);
  }
  const g = plan.gaps;
  console.log(`迁移行里没有 PRD 的 ${g.noDocument.length + g.documentWithoutUrl.length + g.ambiguous.length + g.alreadyFilled.length} 条：`);
  console.log(`  一条同名文档都没有 ${g.noDocument.length}`);
  console.log(`  有同名文档但文档没有 URL ${g.documentWithoutUrl.length}`);
  console.log(`  同名文档有 URL 但同名需求不止一条（歧义） ${g.ambiguous.length}`);
  if (g.alreadyFilled.length > 0) console.log(`  已经填过 ${g.alreadyFilled.length}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const emitSeed = argv.includes('--emit');
  const applyNow = argv.includes('--apply');
  const dryRun = argv.includes('--dry-run') || !applyNow;

  if (emitSeed) {
    const docs = loadFlowerDocuments();
    const reqs = await loadRequirements();
    const plan = buildPlan(docs, reqs);
    printPlan(plan);
    emit(plan);
    return;
  }

  const seed = readSeed();
  console.log(`种子文件：${seed.pairs.length} 条（${path.relative(process.cwd(), SEED_PATH)}）`);
  await apply(seed.pairs, dryRun);
  if (dryRun) console.log('加 --apply 才会写库。');
}

await main();
await pool.end();
