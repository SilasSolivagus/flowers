import { inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { blobIndex } from '../../db/schema.js';
import type { BlobRefs } from './code-index.js';

/**
 * 静态索引的**存储层**：一件事——一块内容（git blob id）说了什么。
 *
 * ── 为什么是内容地址（那张 1.0 / 1.3 秒的账单）
 *
 * 旧表 `code_index` 的主键是 `(repo, sha)`，值是一份整棵树的 JSON 快照。实测建一份要
 * 1017–1095 ms（`123pan-uni-app`，141 个文件）与 1330 ms（`123pan-pc`，137 个文件）——
 * 贵不在解析，在「每次都要从镜像重读整棵树」。而新提交会让主键换一半 → **整份重建**：
 * 改两个文件，另外 139 个文件也重读、重解、重写。两个仓能忍；owner 的规划是 139 个仓，
 * 那时每个仓每个 HEAD 各一份就是 139 秒起、每次提交再来一遍。
 *
 * 所以这一层只缓存**贵的那一半**：解析一块内容（抽符号、抽引用）要几十毫秒的话，
 * 列一棵树只要 0.3 秒的 ssh 往返、且 git 本来就干这个。于是：
 *
 * - 保留：`blob_index` —— 主键是内容地址，同一份内容在 40 个提交、2 个仓里都只有一行；
 * - **删掉**：0029 那张 `tree_entry`（按提交的 `path → blob`）。它一个提交就是一整棵树
 *   （638 / 575 行），按 `文件 × 提交` 增长，139 个仓时是几百万行——存的是 git 用
 *   0.3 秒就能重新吐出来的东西。装配时现读 `git ls-tree -r <sha>`，直接与
 *   `blob_index.blob_sha` join（见 `index-store.ts` 的 `assembleFor()`）。
 *
 * ── 解析结果里为什么没有「解析后的仓内路径」
 *
 * `resolveSpecifier()` 要用**整棵树**：`@/` 指到哪、`./x` 相对哪个目录、后缀匹配谁的
 * 路径以它结尾。同一块 blob 在 A 仓可能落在 `src/components/B.tsx`，在 B 仓可能落在
 * 完全另一个位置。把解析结果写进共享的 blob 行，等于拿 A 仓的布局去解释 B 仓的代码。
 * 所以 `imports` 存的是**说明符 + 本地名绑定 + 路由声明**，全部未解析；解析发生在
 * `assembleIndex()` 里、用当前提交的树做。
 */

// ─── 形状 ────────────────────────────────────────────────────────────────────

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
 * 一次同步的账（`scripts/index-sync.ts` 与报告里的那张表就取这几个数）。
 *
 * `reusedBlobs` = 这次提交用到的不重复 blob 数 − `newBlobs`。**它必须是可观察的**：
 * 同一个提交同步第二次时 `newBlobs` 必须是 0，否则「只解析一次」就只是一句说法。
 *
 * 没有 `newEntries` 这个数了：0030 之后没有按提交的行可写——这正是这次推翻的结论。
 */
export type SyncReport = {
  /** 这一轮新解析并落库的 blob 数。 */
  newBlobs: number;
  /** 这一轮直接复用的 blob 数（库里本来就有）。 */
  reusedBlobs: number;
  /** 整轮耗时（毫秒，含 ssh 往返）。 */
  ms: number;
};

/** 一批插入的块大小：五列一行，500 行远低于 pg 的 65535 个参数上限。 */
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

/** 这些 blob id 里哪些已经有解析结果（装配时的「复用」就是这一问）。 */
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
 * 写 `blob_index`，返回真正插进去的行数。
 *
 * `on conflict do nothing` 是这一层唯一的并发与幂等机制：同一块内容第二次到达时插 0 行
 * （`parsed_at` 保住原来的值——**这就是「只解析一次」的可观察证据**），两个进程同时
 * 解析同一块内容时也不会互相炸（先写的赢，后写的丢弃，代价是多解析一次）。
 */
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

/**
 * 「忘掉」这些内容（删 `blob_index` 行）。
 *
 * 平时没人该调它：内容地址的价值就是永不重解析。三个例外：
 * - 用例要量「必须解析时是几次往返 / 解析了几块」——内容跨用例共享，不先忘掉就量成了复用；
 * - 用例要量「缺一块内容时的自愈」（删掉一块，下次装配应当现解析并写回）；
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

/** `blob_index` 的行数与字节数（CLI / 报告用：**行数才是 139 个仓的规模指标**）。 */
export async function blobIndexStats(db: Db): Promise<{ rows: number; bytes: number }> {
  const res = await db.execute<{ n: number; bytes: string }>(sql`
    select count(*)::int as n, coalesce(sum(pg_column_size(blob_index)), 0)::text as bytes
      from blob_index`);
  const row = res.rows[0];
  return { rows: Number(row?.n ?? 0), bytes: Number(row?.bytes ?? 0) };
}
