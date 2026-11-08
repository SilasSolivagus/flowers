import type { Db } from '../../db/client.js';
import {
  CODE_EXT, HEAD_LINES, assembleIndex, classifyKind, parseBlob, summarize,
  type CodeIndex, type IndexSummary, type KindCounts,
} from './code-index.js';
import {
  assembleStored, dropTree, existingBlobShas, hasTree, readBlobRows, readTreeRows,
  writeBlobRows, writeTreeRows,
  type BlobFacts, type SyncReport,
} from './blob-index.js';
import {
  lsTreeEntries, readBlobHeads, showHeads,
  type MirrorResult,
} from './mirror.js';

/**
 * `repoIndex(repo, sha)` 的读写口 —— **索引一次，之后只做增量**（P4-11）。
 *
 * ── 旧形状为什么撑不住
 *
 * 旧路径的主键是 `(repo, sha)`，值是整棵树的 JSON 快照；新提交来了就整份重建。实测
 * 重建一次 1017–1095 ms（uni-app，141 个文件）/ 1330 ms（pc，137 个文件）——其中绝大
 * 多数时间花在「重新读、重新解析那些**没有变**的文件」。两个仓能忍，139 个仓不能：
 * 那是 139 秒起，且每次提交再来一遍。
 *
 * ── 新形状
 *
 * 解析按 **git blob id（内容地址）** 落一行（`blob_index`），提交只多一张
 * `path → blob` 的映射（`tree_entry`）。于是：
 * - 同一份内容在 40 个提交里 → 只解析一次；
 * - 一个改了 600 个文件里 2 个的提交 → 只多 2 行映射、最多 2 块新内容；
 * - 第二个仓与第一个仓共享的文件（README、配置、复制过去的组件）→ 一块都不重解析。
 *
 * `repoIndex()` 的**返回类型没变**（还是 `CodeIndex`）：`src/core/locate/structure.ts`
 * 与评审路径消费的是 `{ files, imports, routes }`，它们不该知道存储换过形状。
 * 装配由 `assembleStored()` 做——每次读现算（实测 3–8 ms），因为它必须看着**这一棵树**。
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
  /** `true` = 这一轮刚建；`false` = 命中已落库的那一份（`builtAt` 是旧的）。 */
  built: boolean;
  /** 建索引花掉的毫秒（命中时恒为 0）。 */
  buildMs: number;
};

// ─── 解析一块内容（内容地址的落点） ─────────────────────────────────────────

/** 内存里「sha → 已解析」的缓存：一次同步里同一块内容被多个路径引用时只解析一次。 */
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

// ─── 读 ──────────────────────────────────────────────────────────────────────

/**
 * 读一份已索引的 `(repo, sha)`。没有就是 `null`（「还没建」不是错误）。
 *
 * 它现在是一次**装配**：`tree_entry` 给出这个提交的 `path → blob`，`blob_index` 给出
 * 每块内容说了什么，`assembleIndex()` 用这棵树把说明符解析成仓内路径。`builtAt` 取
 * 最新的 `parsed_at`，所以同一个 sha 读两次得到同一个值（旧版靠 `code_index.built_at`）。
 */
export async function readIndex(db: Db, repo: string, sha: string): Promise<CodeIndex | null> {
  return assembleStored(db, repo, sha);
}

/** 删一个提交的索引（重跑用：CLI 的 `--rebuild` 与用例）。**blob 行不删**（跨仓共享）。 */
export async function dropIndex(db: Db, repo: string, sha: string): Promise<void> {
  await dropTree(db, repo, sha);
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

  const sources = tree.data.filter((entry) => CODE_EXT.test(entry.path)
    && classifyKind(entry.path) !== 'other');
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

  const assembled = [...cache.values()];
  const bySha = new Map(assembled.map((facts) => [facts.blobSha, facts]));
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

/** 每个 blob 取第一次出现的那个路径（`lang` 只从它取，读取按 id 去重）。 */
function firstPerBlob(entries: readonly { path: string; oid: string; size: number }[]): BlobReadRef[] {
  const seen = new Map<string, BlobReadRef>();
  for (const entry of entries) {
    if (seen.has(entry.oid)) continue;
    seen.set(entry.oid, { blobSha: entry.oid, path: entry.path, size: entry.size });
  }
  return [...seen.values()];
}

// ─── 增量同步 ────────────────────────────────────────────────────────────────

export type SyncResult = {
  index: CodeIndex;
  report: SyncReport;
};

/**
 * 把 `(repo, sha)` 同步进库里，**只做缺的那部分**。
 *
 * 四步，一次同步最多两次 ssh 往返：
 * 1. `git ls-tree -r -l -z <sha>`（一次）——整棵树的 `path / oid / size`；
 * 2. 只插库里没有的 `tree_entry` 行（`on conflict do nothing`，回来几行就是几行）；
 * 3. 收集这个提交用到、而 `blob_index` 里没有的 blob id，用**一次**
 *    `git cat-file --batch` 读回来，解析、落库；
 * 4. 从库里装配 `CodeIndex` 返回，顺带给出 `{ newBlobs, newEntries, reusedBlobs, ms }`。
 *
 * 为什么第 2 步插的是**整棵树**（不只是进了索引的文件）：说明符解析要「谁的路径以它
 * 结尾」，那份路径集历来就是 `ls-tree` 去掉噪音后的全部文件（旧版 `all` 也是它）。
 * 存全树让解析行为一字不变；噪音（`dist/`、`node_modules/`、二进制）仍然不进表。
 */
export async function syncRepoIndex(
  db: Db,
  repo: string,
  sha: string,
  deps: IndexDeps = LIVE_INDEX_DEPS,
): Promise<MirrorResult<SyncResult>> {
  const started = Date.now();
  const clean = sha.trim();
  if (clean === '') {
    return { ok: false, code: 'bad_path', message: '建索引需要提交 sha（HEAD 那一行里的那个）' };
  }

  const tree = await deps.lsTreeEntries(repo, { ref: clean });
  if (!tree.ok) return tree;

  // 2) tree_entry：只插缺的。
  const rows = tree.data.map((entry) => ({ path: entry.path, blobSha: entry.oid }));
  const have = new Set((await readTreeRows(db, repo, clean)).map((row) => row.path));
  const fresh = rows.filter((row) => !have.has(row.path));
  const newEntries = await writeTreeRows(db, repo, clean, fresh);

  // 3) 缺的内容：一次批量读。**只读进了索引的那一批**——`jsonb`/`md`/字体/图片也在
  // `tree_entry` 里（说明符解析要那份路径集），但它们没有符号也没有导入，读回来只是把
  // ssh 往返变贵（实测 uni-app 全树 638 块 ≈ 十几 MB，索引只要 141 块 ≈ 0.6 MB）。
  const wanted = firstPerBlob(tree.data.filter((entry) => CODE_EXT.test(entry.path)
    && classifyKind(entry.path) !== 'other'));
  const known = await existingBlobShas(db, wanted.map((ref) => ref.blobSha));
  const missing = wanted.filter((ref) => !known.has(ref.blobSha));
  let newBlobs = 0;
  if (missing.length > 0) {
    const got = await readBlobsOf(deps)(repo, missing, { maxLines: HEAD_LINES });
    if (!got.ok) return got;
    const cache: ParseCache = new Map();
    for (const ref of missing) {
      const text = got.data.get(ref.blobSha);
      if (text === undefined) continue;
      parseInto(cache, ref.blobSha, ref.path, ref.size, text);
    }
    newBlobs = await writeBlobRows(db, [...cache.values()]);
  }

  // 4) 装配（从库里读，保证「返回的就是库里那份」）。
  const stored = await assembleStored(db, repo, clean);
  const index = stored ?? assembleIndex({
    repo, sha: clean, all: tree.data.map((entry) => entry.path), sources: [],
  });
  const report: SyncReport = {
    newBlobs,
    newEntries,
    reusedBlobs: Math.max(0, wanted.length - newBlobs),
    ms: Date.now() - started,
  };
  return { ok: true, data: { index, report } };
}

// ─── 懒建（生产路径） ────────────────────────────────────────────────────────

/**
 * `repoIndex(repo, sha)`：拿这一份索引，没有就同步一次（只解析缺的内容）。
 *
 * 失败一律是 `MirrorResult` 的中文失败（镜像读不到、仓库没配）：调用方按 §3.5 退回
 * grep，而不是让整条走查/评审失败。**同步到一半失败不写半份索引**——`tree_entry` 与
 * `blob_index` 各自 `on conflict do nothing`，重跑就是补齐，不会留下「看起来完整」的
 * 残树。
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

  if (!opts.rebuild && await hasTree(db, repo, cleanSha)) {
    const cached = await assembleStored(db, repo, cleanSha);
    if (cached !== null) return { ok: true, data: { index: cached, built: false, buildMs: 0 } };
  }

  const started = Date.now();
  if (!persist) {
    const built = await buildIndex(repo, cleanSha, deps);
    if (!built.ok) return built;
    return { ok: true, data: { index: built.data.index, built: true, buildMs: built.data.buildMs } };
  }

  const synced = await syncRepoIndex(db, repo, cleanSha, deps);
  if (!synced.ok) return synced;
  return {
    ok: true,
    data: { index: synced.data.index, built: true, buildMs: Date.now() - started },
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

export { readBlobRows };
export type { CodeIndex, IndexSummary, KindCounts, SyncReport };
