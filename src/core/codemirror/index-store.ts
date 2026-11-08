import type { Db } from '../../db/client.js';
import {
  CODE_EXT, HEAD_LINES, assembleIndex, classifyKind, parseBlob, summarize,
  type CodeIndex, type IndexSummary, type KindCounts,
} from './code-index.js';
import {
  existingBlobShas, forgetBlobs as forgetBlobRows, readBlobRows, writeBlobRows,
  type BlobFacts, type SyncReport,
} from './blob-index.js';
import {
  lsTreeEntries, readBlobHeads, showHeads,
  type MirrorResult,
} from './mirror.js';

/**
 * `repoIndex(repo, sha)` 的读写口 —— **解析一次，永远复用**（P4-11，第二版）。
 *
 * ── 两版之间最重要的一次自我推翻
 *
 * 第一版（迁移 0029）除了 `blob_index` 还建了一张 `tree_entry`（按提交的 `path → blob`
 * 映射）。它被实测判了死刑：**一个提交就是一整棵树**（638 行 uni-app / 575 行 pc），
 * 4 个提交 2422 行，按 `文件 × 提交` 增长，139 个仓时是几百万行——而它存的只是 git
 * 用 0.3 秒就能重新列出来的东西。真正的账单是**解析**（一块内容的符号与引用），不是
 * 列树。所以迁移 0030 把 `tree_entry` 整张删掉：
 *
 * - 装配 `(repo, sha)` 的索引 = **现读** `git ls-tree -r <sha>`（一次 ssh 往返，实测
 *   238–306 ms）+ 按 `blob_sha` join `blob_index`（一次 `in (…)` 查询）+ 在内存里装配；
 * - 树里某块内容**不在** `blob_index`（这个提交在完整同步之前就被读过）→ **当场解析并
 *   写回**，自愈，见 `assembleFor()`；
 * - 导入解析仍然在装配时对着**这棵树**做（说明符没有解析结果落库，理由见 `blob-index.ts`）。
 *
 * 代价是**每次读都付一次 `ls-tree`**：旧路径读一行 jsonb 只要 1–3 ms，现读装配要
 * 200–400 ms。这是这笔交易的正面——用「每次几百毫秒」换「表不随提交数增长」。
 * 因为同一轮走查/评审里同一个 `(repo, sha)` 经常被问好几次，这里另加一个**有界的
 * 进程内缓存**（只留最近 8 个 `(repo, sha)`，不做任何持久化）；它不是 0029 那张表，
 * 进程退出就没了，也不会随提交数增长。
 */

// ─── 依赖（测试注入用：一次 ssh 都不发） ─────────────────────────────────────

/**
 * 一块要读内容的 blob：带上路径只为「第一次见到它时的扩展名」（决定 `lang`），
 * 读取本身按 `blobSha` 去重。
 */
export type BlobReadRef = { blobSha: string; path: string; size: number };

export type ReadBlobsFn = (
  repo: string,
  refs: readonly BlobReadRef[],
  opts: { maxLines?: number },
) => Promise<MirrorResult<Map<string, string>>>;

/** 建索引用到的三个读口（第三个是 P4-11 新加的：一次 `cat-file --batch` 读回多块内容）。 */
export type IndexDeps = {
  lsTreeEntries: typeof lsTreeEntries;
  showHeads: typeof showHeads;
  /**
   * 按 blob id 批量读内容。可选：注入方只给老的两个读口时，退回
   * `blobReadsViaShowHeads()`（路径键的 `showHeads`）——`tests/index.test.ts` 就是
   * 这么注入的，它钉的是「一次 ls-tree + 一次批量读，不是每文件一趟」。
   */
  readBlobs?: ReadBlobsFn;
};

/** 生产环境的三个读口。`readBlobs` 走 `cat-file --batch`（协议自带长度前缀）。 */
export const LIVE_INDEX_DEPS: IndexDeps = {
  lsTreeEntries,
  showHeads,
  readBlobs: async (repo, refs, opts) => readBlobHeads(
    repo,
    refs.map((ref) => ({ blobSha: ref.blobSha, size: ref.size })),
    opts,
  ),
};

/**
 * 把老的 `showHeads`（`path → 前 N 行`）包成新的读口形状。
 *
 * 为什么留着这条路：`showHeads` 是**公开读口**，用例注入它来数往返次数；它读回来的
 * 内容与 `cat-file --batch` 一样（都是整块 blob 在本地切前 80 行）。两条路的差别只在
 * 「按路径还是按对象 id 去重」，而注入方的语义是「别发 ssh」，不是「必须按 id 读」。
 */
export function blobReadsViaShowHeads(show: typeof showHeads): ReadBlobsFn {
  return async (repo, refs, opts) => {
    const seen = new Map<string, BlobReadRef>();
    for (const ref of refs) if (!seen.has(ref.blobSha)) seen.set(ref.blobSha, ref);
    const wanted = [...seen.values()];
    if (wanted.length === 0) return { ok: true, data: new Map() };
    const got = await show(repo, wanted.map((ref) => ({
      path: ref.path, oid: ref.blobSha, size: ref.size,
    })), opts);
    if (!got.ok) return got;
    const out = new Map<string, string>();
    for (const ref of wanted) {
      const text = got.data.get(ref.path);
      if (text !== undefined) out.set(ref.blobSha, text);
    }
    return { ok: true, data: out };
  };
}

function readBlobsOf(deps: IndexDeps): ReadBlobsFn {
  return deps.readBlobs ?? blobReadsViaShowHeads(deps.showHeads);
}

export type BuiltIndex = {
  index: CodeIndex;
  /** `true` = 这一轮真的解析了内容（库里原本没有）；`false` = 全部复用 / 命中缓存。 */
  built: boolean;
  /** 这一轮花掉的毫秒（命中进程内缓存时恒为 0）。 */
  buildMs: number;
};

/** 一次装配的账。`parsedBlobs` > 0 就是「这次真的解析了新内容」。 */
export type AssembleResult = {
  index: CodeIndex;
  /** 这一轮现解析并写回的块数（自愈或首次接触）。 */
  parsedBlobs: number;
  /** 直接复用的块数。 */
  reusedBlobs: number;
  /** 装配耗时（含 `ls-tree` 的 ssh 往返）。 */
  assembleMs: number;
};

// ─── 解析一块内容（内容地址的落点） ─────────────────────────────────────────

/** 内存里「sha → 已解析」的缓存：同一轮里同一块内容被多个路径引用时只解析一次。 */
type ParseCache = Map<string, BlobFacts>;

function parseInto(
  cache: ParseCache,
  blobSha: string,
  path: string,
  size: number,
  text: string,
): BlobFacts {
  const hit = cache.get(blobSha);
  if (hit !== undefined) return hit;
  const parsed = parseBlob(text, path);
  const facts: BlobFacts = {
    blobSha,
    lang: parsed.lang,
    size,
    symbols: parsed.symbols,
    refs: parsed.refs,
  };
  cache.set(blobSha, facts);
  return facts;
}

/** 每个 blob 取第一次出现的那个路径（`lang` 只从它取，读取按 id 去重）。 */
function firstPerBlob(entries: readonly { path: string; oid: string; size: number }[]): BlobReadRef[] {
  const seen = new Map<string, BlobReadRef>();
  for (const entry of entries) {
    if (seen.has(entry.oid)) continue;
    seen.set(entry.oid, { blobSha: entry.oid, path: entry.path, size: entry.size });
  }
  return [...seen.values()];
}

/** 进了索引的那一批（扩展名对、类别不是 `other`）：只有它们的**内容**需要读。 */
function indexable<T extends { path: string }>(entries: readonly T[]): T[] {
  return entries.filter((entry) => CODE_EXT.test(entry.path) && classifyKind(entry.path) !== 'other');
}

// ─── 有界的进程内缓存 ───────────────────────────────────────────────────────

/**
 * 只留最近 `ASSEMBLE_CACHE_MAX` 个 `(repo, sha)` 的**装配结果**。
 *
 * 为什么需要它：装配要付一次 `ls-tree`（200–400 ms），而同一轮走查/评审里
 * `repoIndex()` 经常被同一个 sha 连问好几次（`inspect` 与 `review` 各自收一轮）。
 * 旧路径读一行 jsonb 只要 1–3 ms，这里靠一个小缓存把那几次拉回毫秒级。
 *
 * 为什么它不是 0029 那张 `tree_entry` 的还魂：它只在进程内、只留装配结果、上限 8 条、
 * 进程退出即消失，**不随提交数增长**。凡是改动了 `blob_index`（`forgetBlobs` /
 * `--rebuild`）的路径都会清掉它，所以它不会把旧内容喂给新请求。
 */
const ASSEMBLE_CACHE_MAX = 8;
const assembleCache = new Map<string, CodeIndex>();

function cacheKey(repo: string, sha: string): string {
  return `${repo}\u0000${sha}`;
}

/** 清缓存（不传就清空）。`forgetBlobs`、`dropIndex`、用例都走它。 */
export function clearAssembleCache(repo?: string, sha?: string): void {
  if (repo === undefined) {
    assembleCache.clear();
    return;
  }
  if (sha === undefined) {
    for (const key of [...assembleCache.keys()]) {
      if (key.startsWith(`${repo}\u0000`)) assembleCache.delete(key);
    }
    return;
  }
  assembleCache.delete(cacheKey(repo, sha));
}

function cacheGet(repo: string, sha: string): CodeIndex | null {
  return assembleCache.get(cacheKey(repo, sha)) ?? null;
}

function cacheSet(repo: string, sha: string, index: CodeIndex): void {
  const key = cacheKey(repo, sha);
  assembleCache.delete(key);
  assembleCache.set(key, index);
  while (assembleCache.size > ASSEMBLE_CACHE_MAX) {
    const oldest = assembleCache.keys().next().value;
    if (oldest === undefined) break;
    assembleCache.delete(oldest);
  }
}

// ─── 装配（生产路径的核心） ─────────────────────────────────────────────────

/**
 * 现读一棵树 + join `blob_index` → `CodeIndex`。
 *
 * 三步，最多两次 ssh 往返：
 * 1. `git ls-tree -r -l -z <sha>`（一次）：这一棵树的 `path / blob id / size`。
 *    **这就是 `tree_entry` 被删掉之后替代它的东西**——同一份信息，git 每次现给，
 *    不占我们一行存储；
 * 2. `select … from blob_index where blob_sha in (…)`：库里已有的解析结果；
 * 3. 树里有、库里没有的块 → **一次 `git cat-file --batch` 读回来、解析、写回库**
 *    （自愈：一个提交在完整同步之前被读过、或有人手动删过几行，下一次装配就补齐；
 *    写回用 `on conflict do nothing`，所以两个请求同时自愈同一块内容也不会互相覆盖）。
 *
 * 返回的 `index.builtAt` 取「这份索引里最新的那块内容的解析时刻」——跨读稳定
 * （同一个 sha 读两次得到同一个值），而且比「刚才」更有信息量。
 */
export async function assembleFor(
  db: Db,
  repo: string,
  sha: string,
  deps: IndexDeps = LIVE_INDEX_DEPS,
): Promise<MirrorResult<AssembleResult>> {
  const started = Date.now();
  const clean = sha.trim();
  if (clean === '') {
    return { ok: false, code: 'bad_path', message: '建索引需要提交 sha（HEAD 那一行里的那个）' };
  }

  const tree = await deps.lsTreeEntries(repo, { ref: clean });
  if (!tree.ok) return tree;

  const wanted = firstPerBlob(indexable(tree.data));
  const stored = await readBlobRows(db, wanted.map((ref) => ref.blobSha));
  const missing = wanted.filter((ref) => !stored.has(ref.blobSha));
  let parsedBlobs = 0;

  if (missing.length > 0) {
    const got = await readBlobsOf(deps)(repo, missing, { maxLines: HEAD_LINES });
    if (!got.ok) return got;
    const cache: ParseCache = new Map();
    for (const ref of missing) {
      const text = got.data.get(ref.blobSha);
      // 读不回来的块不进索引（少一个文件比编一个空文件好）；它下一轮还会被当成缺失再试。
      if (text === undefined) continue;
      parseInto(cache, ref.blobSha, ref.path, ref.size, text);
    }
    parsedBlobs = await writeBlobRows(db, [...cache.values()]);
    if (parsedBlobs > 0) {
      // 刚写进去的 parsed_at 由库给（now()），重新读一遍拿到确切值：`builtAt` 要用它。
      for (const [blobSha, row] of await readBlobRows(db, [...cache.keys()])) stored.set(blobSha, row);
    }
  }

  const sources = [];
  let newest = 0;
  for (const entry of tree.data) {
    if (!CODE_EXT.test(entry.path) || classifyKind(entry.path) === 'other') continue;
    const blob = stored.get(entry.oid);
    // 树里有、库里也没有、这次也没读回来：跳过（见上面那条注释）。
    if (blob === undefined) continue;
    sources.push({
      path: entry.path,
      size: blob.size,
      lang: blob.lang,
      symbols: blob.symbols,
      refs: blob.refs,
    });
    const at = Date.parse(blob.parsedAt);
    if (Number.isFinite(at) && at > newest) newest = at;
  }

  const index = assembleIndex({
    repo,
    sha: clean,
    all: tree.data.map((entry) => entry.path),
    sources,
    builtAt: newest > 0 ? new Date(newest).toISOString() : undefined,
  });
  return {
    ok: true,
    data: {
      index,
      parsedBlobs,
      reusedBlobs: Math.max(0, wanted.length - parsedBlobs),
      assembleMs: Date.now() - started,
    },
  };
}

// ─── 读 ──────────────────────────────────────────────────────────────────────

/**
 * 读一份索引（先看进程内缓存，再看镜像 + 库）。读不到镜像就是 `null`——调用方据此
 * 退回 grep（与旧版「没有索引」同一个出口）。
 *
 * 注意它**不再是「查库有没有」**：库里只有内容，没有「这个提交的索引」这种东西。
 * 「有没有索引」这个问题的答案现在是「镜像读得到吗」。
 */
export async function readIndex(
  db: Db,
  repo: string,
  sha: string,
  deps: IndexDeps = LIVE_INDEX_DEPS,
): Promise<CodeIndex | null> {
  const cached = cacheGet(repo, sha.trim());
  if (cached !== null) return cached;
  const assembled = await assembleFor(db, repo, sha, deps);
  if (!assembled.ok) return null;
  cacheSet(repo, sha.trim(), assembled.data.index);
  return assembled.data.index;
}

/**
 * 忘掉一个 `(repo, sha)` 的装配结果（缓存）。**不删任何内容行**：`blob_index` 是跨仓
 * 共享的内容地址，删它会让别的仓、别的提交一起掉内容。重跑用 `--rebuild`。
 */
export function dropIndex(repo: string, sha: string): void {
  clearAssembleCache(repo, sha);
}

/** 删内容行 + 清缓存（用例收口、`--forget` 用）。缓存必须一起清，否则会读到旧结果。 */
export async function forgetBlobs(db: Db, shas: readonly string[]): Promise<number> {
  clearAssembleCache();
  return forgetBlobRows(db, shas);
}

// ─── 全量建（不写库；`--dry-run` 与纯函数用例走它） ─────────────────────────

/**
 * 从镜像读一整棵树、解析每一块内容、装配成索引。**不碰数据库**，所以没有复用——
 * 它的用途就是量「全量建一次要多久」（旧口径 1.0 / 1.3 秒的那张表）与纯函数回归。
 *
 * 即便不落库，这里也按 blob id 去重：同一个仓里两份内容完全相同的文件只解析一次
 * （实测两个真实仓里都有这种情况：复制出来的组件、空的 `index.ts`）。
 */
export async function buildIndex(
  repo: string,
  sha: string,
  deps: IndexDeps = LIVE_INDEX_DEPS,
): Promise<MirrorResult<{ index: CodeIndex; buildMs: number }>> {
  const started = Date.now();
  const tree = await deps.lsTreeEntries(repo, { ref: sha });
  if (!tree.ok) return tree;

  const sources = indexable(tree.data);
  // 后端仓（只有 .go/.java）就是这一支：索引为空，调用方据此退回 grep。
  if (sources.length === 0) {
    return {
      ok: true,
      data: {
        index: assembleIndex({ repo, sha, all: tree.data.map((entry) => entry.path), sources: [] }),
        buildMs: Date.now() - started,
      },
    };
  }

  const first = firstPerBlob(sources);
  const got = await readBlobsOf(deps)(repo, first, { maxLines: HEAD_LINES });
  if (!got.ok) return got;

  const cache: ParseCache = new Map();
  for (const ref of first) {
    const text = got.data.get(ref.blobSha);
    if (text === undefined) continue;
    parseInto(cache, ref.blobSha, ref.path, ref.size, text);
  }

  const bySha = new Map([...cache.values()].map((facts) => [facts.blobSha, facts]));
  const index = assembleIndex({
    repo,
    sha,
    all: tree.data.map((entry) => entry.path),
    sources: sources.flatMap((entry) => {
      const facts = bySha.get(entry.oid);
      if (facts === undefined) return [];
      return [{
        path: entry.path,
        size: facts.size,
        lang: facts.lang,
        symbols: facts.symbols,
        refs: facts.refs,
      }];
    }),
  });
  return { ok: true, data: { index, buildMs: Date.now() - started } };
}

// ─── 增量同步入口 ────────────────────────────────────────────────────────────

export type SyncResult = {
  index: CodeIndex;
  report: SyncReport;
};

/**
 * 把一个 `(repo, sha)` 同步进库，顺带给出 `{ newBlobs, reusedBlobs, ms }`。
 *
 * 它与 `assembleFor()` 是同一件事，差别只在「要不要那份账」：装配是读路径（读不到就
 * 退回 grep），同步是**预热**路径（脚本用它把整棵树读进来、把账打出来）。
 *
 * 同一个提交跑第二次必须是 `newBlobs: 0` ——这是「只解析一次」的唯一可观察证据，
 * 也是这轮 reshape 的验收口径。
 */
export async function syncRepoIndex(
  db: Db,
  repo: string,
  sha: string,
  deps: IndexDeps = LIVE_INDEX_DEPS,
): Promise<MirrorResult<SyncResult>> {
  clearAssembleCache(repo, sha.trim());
  const assembled = await assembleFor(db, repo, sha, deps);
  if (!assembled.ok) return assembled;
  cacheSet(repo, sha.trim(), assembled.data.index);
  return {
    ok: true,
    data: {
      index: assembled.data.index,
      report: {
        newBlobs: assembled.data.parsedBlobs,
        reusedBlobs: assembled.data.reusedBlobs,
        ms: assembled.data.assembleMs,
      },
    },
  };
}

// ─── 懒建（生产路径） ────────────────────────────────────────────────────────

/**
 * `repoIndex(repo, sha)`：拿这一份索引（现读装配，命中缓存就零成本）。
 *
 * 失败一律是 `MirrorResult` 的中文失败（镜像读不到、仓库没配）：调用方按 §3.5 退回
 * grep，而不是让整条走查/评审失败。
 *
 * `rebuild: true` 绕过缓存并**重新解析**（它不删内容行——内容地址是跨仓共享的，
 * 要重解析请用 `forgetBlobs`）。
 */
export async function repoIndex(
  db: Db,
  repo: string,
  sha: string,
  opts: { deps?: IndexDeps; persist?: boolean; rebuild?: boolean } = {},
): Promise<MirrorResult<BuiltIndex>> {
  const deps = opts.deps ?? LIVE_INDEX_DEPS;
  const persist = opts.persist ?? true;
  const cleanSha = sha.trim();
  if (cleanSha === '') {
    return { ok: false, code: 'bad_path', message: '建索引需要提交 sha（HEAD 那一行里的那个）' };
  }

  if (!opts.rebuild) {
    const cached = cacheGet(repo, cleanSha);
    if (cached !== null) return { ok: true, data: { index: cached, built: false, buildMs: 0 } };
  }

  const started = Date.now();
  if (!persist) {
    const built = await buildIndex(repo, cleanSha, deps);
    if (!built.ok) return built;
    return { ok: true, data: { index: built.data.index, built: true, buildMs: built.data.buildMs } };
  }

  const assembled = await assembleFor(db, repo, cleanSha, deps);
  if (!assembled.ok) return assembled;
  cacheSet(repo, cleanSha, assembled.data.index);
  return {
    ok: true,
    data: {
      index: assembled.data.index,
      built: assembled.data.parsedBlobs > 0,
      buildMs: Date.now() - started,
    },
  };
}

/** 空索引判定（转发一次，免得两个调用方各写一遍 `Object.keys(...).length === 0`）。 */
export function indexIsEmpty(index: CodeIndex): boolean {
  return Object.keys(index.files).length === 0;
}

/** 摘要（CLI 与报告共用）。 */
export function indexSummary(index: CodeIndex): IndexSummary {
  return summarize(index);
}

export { existingBlobShas, readBlobRows };
export type { CodeIndex, IndexSummary, KindCounts, SyncReport };
