import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { blobIndex, treeEntry } from '../../db/schema.js';
import {
  CODE_EXT, assembleIndex, classifyKind, indexTimestamp, parseBlob,
  type AssembledSource, type BlobRefs, type CodeIndex,
} from './code-index.js';
import type { BlobRequest, TreeEntry } from './mirror.js';

/**
 * 静态索引的**存储层**：两块内容地址 + 一张按提交的映射表。
 *
 * ── 为什么推翻旧形状（那张 1.0 / 1.3 秒的账单）
 *
 * 旧表 `code_index` 的主键是 `(repo, sha)`，值是一份整棵树的 JSON 快照。实测建一份要
 * 1017–1095 ms（`123pan-uni-app`，141 个文件）与 1330 ms（`123pan-pc`，137 个文件）——
 * 贵不在解析，在「每次都要从镜像重读整棵树」。而新提交会让主键换一半 → **整份重建**：
 * 改两个文件，另外 139 个文件也重读、重解、重写。
 *
 * 两个仓还能忍；owner 的规划是 139 个仓，那时每个仓每个 HEAD 各一份，就是 139 秒起、
 * 每次提交再来一遍。所以这里换成「**同样的内容只解析一次，永远复用**」：
 *
 * - `blob_index`：主键是 **git blob id = 内容地址**。同一份内容出现在 40 个提交里、
 *   出现在两个仓里，都只有一行，也只解析一次。
 * - `tree_entry`：唯一按提交存的东西，而且只是一张 `path → blob` 的映射。一个改了
 *   600 个文件里 2 个的提交只多 2 行。
 *
 * ── 解析结果里为什么没有「解析后的仓内路径」
 *
 * `resolveSpecifier()` 要用**整棵树**：`@/` 指到哪、`./x` 相对哪个目录、后缀匹配谁的
 * 路径以它结尾。同一块 blob 在 A 仓可能落在 `src/components/B.tsx`，在 B 仓可能落在
 * 完全另一个位置。把解析结果写进共享的 blob 行，等于拿 A 仓的布局去解释 B 仓的代码。
 *
 * 所以 `blob_index.imports` 存的是**说明符 + 本地名绑定 + 路由声明**，全部未解析；
 * 解析发生在 `assembleIndex()` 里、用当前提交的树做。代价是每次读多几十次字符串比较
 * （实测两个真实仓各 3–8 ms），换来的是跨仓、跨提交复用不掺假。
 */

// ─── 形状 ────────────────────────────────────────────────────────────────────

/** `tree_entry` 的一行（去掉了 repo / commit：调用方已经拿着它们）。 */
export type TreeRow = { path: string; blobSha: string };

/** 一块已解析内容的落库形状（`blob_index` 去掉 `parsed_at`）。 */
export type BlobFacts = {
  blobSha: string;
  lang: string;
  size: number;
  symbols: string[];
  refs: BlobRefs;
};

/** 读回来的 blob 行。 */
export type StoredBlob = BlobFacts & { parsedAt: string };

/**
 * 一次同步的账（`scripts/index-sync.ts` 与报告里的那张表就取这四个数）。
 *
 * `reusedBlobs` = 这次提交用到的不重复 blob 数 − `newBlobs`。**它必须是可观察的**：
 * 同一个提交同步第二次时 `newBlobs` 与 `newEntries` 都必须是 0，否则「只解析一次」
 * 就只是一句说法。
 */
export type SyncReport = {
  /** 这一轮新解析并落库的 blob 数。 */
  newBlobs: number;
  /** 这一轮新写入的 `tree_entry` 行数。 */
  newEntries: number;
  /** 这一轮直接复用的 blob 数（库里本来就有）。 */
  reusedBlobs: number;
  /** 整轮耗时（毫秒，含 ssh 往返）。 */
  ms: number;
};

/** 一批插入的块大小：`tree_entry` 四列一行，500 行远低于 pg 的 65535 个参数上限。 */
const INSERT_CHUNK = 500;

/** `in (…)` 查询的块大小（同样的理由，再留一点余量）。 */
const SELECT_CHUNK = 1000;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function isoOf(value: unknown): string {
  // pg 把 timestamptz 交回来可能是 Date，也可能是文本表示（`2026-11-07 09:35:31+00`）。
  // 两条路都归到同一个 ISO 形状，否则「第二次读到的 parsed_at 等于第一次」没法比。
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

// ─── 读 ──────────────────────────────────────────────────────────────────────

/** 一个提交的全部 `path → blob`（**树序**：路径字典序，路由去重依赖这个顺序）。 */
export async function readTreeRows(db: Db, repo: string, commitSha: string): Promise<TreeRow[]> {
  const rows = await db
    .select({ path: treeEntry.path, blobSha: treeEntry.blobSha })
    .from(treeEntry)
    .where(and(eq(treeEntry.repo, repo), eq(treeEntry.commitSha, commitSha)))
    .orderBy(asc(treeEntry.path));
  return rows.map((row) => ({ path: row.path, blobSha: row.blobSha }));
}

/** 这些 blob id 里哪些已经有解析结果（增量同步的「复用」就是这一问）。 */
export async function existingBlobShas(db: Db, shas: readonly string[]): Promise<Set<string>> {
  const known = new Set<string>();
  for (const chunk of chunks([...new Set(shas)], SELECT_CHUNK)) {
    if (chunk.length === 0) continue;
    const rows = await db
      .select({ blobSha: blobIndex.blobSha })
      .from(blobIndex)
      .where(inArray(blobIndex.blobSha, chunk));
    for (const row of rows) known.add(row.blobSha);
  }
  return known;
}

/** 读回若干块内容的解析结果。 */
export async function readBlobRows(db: Db, shas: readonly string[]): Promise<Map<string, StoredBlob>> {
  const out = new Map<string, StoredBlob>();
  for (const chunk of chunks([...new Set(shas)], SELECT_CHUNK)) {
    if (chunk.length === 0) continue;
    const rows = await db
      .select()
      .from(blobIndex)
      .where(inArray(blobIndex.blobSha, chunk));
    for (const row of rows) {
      out.set(row.blobSha, {
        blobSha: row.blobSha,
        lang: row.lang ?? '',
        size: Number(row.size),
        symbols: (row.symbols as string[] | null) ?? [],
        refs: (row.imports as BlobRefs | null) ?? { specs: [], locals: {}, routes: [] },
        parsedAt: isoOf(row.parsedAt),
      });
    }
  }
  return out;
}

// ─── 写 ──────────────────────────────────────────────────────────────────────

/**
 * 写 `tree_entry`，返回**真正插进去的行数**。
 *
 * `on conflict do nothing` 有两个作用：同一个提交同步两次时第二轮插入 0 行（这就是
 * 「增量」的可观察证据），以及两个进程同时同步同一个提交时不互相炸。
 */
export async function writeTreeRows(
  db: Db,
  repo: string,
  commitSha: string,
  rows: readonly TreeRow[],
): Promise<number> {
  let inserted = 0;
  for (const chunk of chunks(rows, INSERT_CHUNK)) {
    if (chunk.length === 0) continue;
    const back = await db
      .insert(treeEntry)
      .values(chunk.map((row) => ({
        repo, commitSha, path: row.path, blobSha: row.blobSha,
      })))
      .onConflictDoNothing()
      .returning({ path: treeEntry.path });
    inserted += back.length;
  }
  return inserted;
}

/** 写 `blob_index`，返回真正插进去的行数（已存在的块不覆盖：`parsed_at` 必须留住）。 */
export async function writeBlobRows(db: Db, blobs: readonly BlobFacts[]): Promise<number> {
  let inserted = 0;
  for (const chunk of chunks(blobs, INSERT_CHUNK)) {
    if (chunk.length === 0) continue;
    const back = await db
      .insert(blobIndex)
      .values(chunk.map((blob) => ({
        blobSha: blob.blobSha,
        lang: blob.lang,
        size: blob.size,
        symbols: blob.symbols,
        imports: blob.refs,
      })))
      .onConflictDoNothing()
      .returning({ blobSha: blobIndex.blobSha });
    inserted += back.length;
  }
  return inserted;
}

/** 删一个提交的映射（重跑用；**不删 blob 行**——它们是跨仓共享的内容地址）。 */
export async function dropTree(db: Db, repo: string, commitSha: string): Promise<void> {
  await db.delete(treeEntry).where(and(eq(treeEntry.repo, repo), eq(treeEntry.commitSha, commitSha)));
}

/**
 * 「忘掉」这些内容（删 `blob_index` 行）。
 *
 * 平时没人该调它：内容地址的价值就是永不重解析。两个例外：
 * - 用例要量「必须解析时是几次往返 / 解析了几块」——内容跨用例共享，不先忘掉就量成了复用；
 * - 解析器改了口径、要给已有的内容重新解析一次（此时应当整表重算，而不是逐个仓扫）。
 */
export async function forgetBlobs(db: Db, shas: readonly string[]): Promise<number> {
  let dropped = 0;
  for (const chunk of chunks([...new Set(shas)], SELECT_CHUNK)) {
    if (chunk.length === 0) continue;
    const back = await db
      .delete(blobIndex)
      .where(inArray(blobIndex.blobSha, chunk))
      .returning({ blobSha: blobIndex.blobSha });
    dropped += back.length;
  }
  return dropped;
}

/** 整张 `blob_index` 的行数与字节数（CLI / 报告用：**行数才是 139 个仓的规模指标**）。 */
export async function blobIndexStats(db: Db): Promise<{ rows: number; bytes: number }> {
  const res = await db.execute<{ n: number; bytes: string }>(sql`
    select count(*)::int as n, coalesce(sum(pg_column_size(blob_index)), 0)::text as bytes
      from blob_index`);
  const row = res.rows[0];
  return { rows: Number(row?.n ?? 0), bytes: Number(row?.bytes ?? 0) };
}

// ─── 装配：把「一块内容说了什么」还原成一份 `CodeIndex` ─────────────────────

/**
 * 从库里装配 `(repo, sha)` 的索引。没有这个提交的任何 `tree_entry` 行 → `null`
 * （「还没索引」不是错误，与旧 `readIndex` 同一个口径）。
 *
 * `builtAt` 取「这份索引里最新的那块内容的解析时刻」：它跨读稳定（`index.test.ts` 用
 * 「同一个 sha 读两次 builtAt 相同」钉住这件事），而且比「刚才」更有信息量——它回答的
 * 是「这份结构是什么时候被读懂的」。
 */
export async function assembleStored(
  db: Db,
  repo: string,
  sha: string,
): Promise<CodeIndex | null> {
  const rows = await readTreeRows(db, repo, sha);
  if (rows.length === 0) return null;
  const blobs = await readBlobRows(db, rows.map((row) => row.blobSha));

  const sources: AssembledSource[] = [];
  let newest = 0;
  for (const row of rows) {
    if (!CODE_EXT.test(row.path) || classifyKind(row.path) === 'other') continue;
    const blob = blobs.get(row.blobSha);
    // 映射在、内容不在：说明某一次同步中断在「写完 tree_entry、还没写 blob」之间。
    // 少一个文件比编一个空文件好——旧路径也是这个口径（读失败的文件不进索引）。
    if (blob === undefined) continue;
    sources.push({
      path: row.path,
      size: blob.size,
      lang: blob.lang,
      symbols: blob.symbols,
      refs: blob.refs,
    });
    const at = Date.parse(blob.parsedAt);
    if (Number.isFinite(at) && at > newest) newest = at;
  }

  return assembleIndex({
    repo,
    sha,
    all: rows.map((row) => row.path),
    sources,
    builtAt: newest > 0 ? new Date(newest).toISOString() : indexTimestamp(),
  });
}

/** 一个提交在库里有没有完整的一行映射（`repoIndex` 的命中判据）。 */
export async function hasTree(db: Db, repo: string, commitSha: string): Promise<boolean> {
  const rows = await db
    .select({ path: treeEntry.path })
    .from(treeEntry)
    .where(and(eq(treeEntry.repo, repo), eq(treeEntry.commitSha, commitSha)))
    .limit(1);
  return rows.length > 0;
}

export type { BlobRequest, TreeEntry };
