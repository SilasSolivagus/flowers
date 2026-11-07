import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { codeIndex } from '../../db/schema.js';
import {
  CODE_EXT, HEAD_LINES, classifyKind, extractIndex, indexTimestamp, isEmptyIndex, summarize,
  type CodeIndex, type IndexFile, type IndexRoute, type IndexSummary, type KindCounts, type SourceEntry,
} from './code-index.js';
import {
  lsTreeEntries, showHeads,
  type MirrorResult, type TreeEntry,
} from './mirror.js';

/**
 * `code_index` 的读写口 + 懒建索引。
 *
 * **为什么主键是 `(repo, sha)` 就是全部失效策略**：索引描述的是「某个提交上的结构」。
 * 新提交来了，主键就换了一半——查不到、当场重建，绝不会拿旧索引去解释新代码。没有
 * TTL、没有「过期了重建」的分支，也就没有「索引与代码不一致」这个失败模式。
 *
 * **为什么懒建**：走查与评审都可能几周不碰某个仓。定时任务会在没人用的仓库上白花
 * ssh 往返；而「第一次用到时建一次」正好把成本放在真正需要它的时候，且此后同 sha
 * 零成本（实测首建 0.5–1 s，命中 <10 ms）。
 */

// ─── 形状 ────────────────────────────────────────────────────────────────────

/** 建索引用到的两个读口（测试注入用：一次 ssh 都不发）。 */
export type IndexDeps = {
  lsTreeEntries: typeof lsTreeEntries;
  showHeads: typeof showHeads;
};

export const LIVE_INDEX_DEPS: IndexDeps = { lsTreeEntries, showHeads };

export type BuiltIndex = {
  index: CodeIndex;
  /** `true` = 这一轮刚建；`false` = 命中已落库的那一份（`builtAt` 是旧的）。 */
  built: boolean;
  /** 建索引花掉的毫秒（命中时恒为 0）。 */
  buildMs: number;
};

// ─── 读 ──────────────────────────────────────────────────────────────────────

/**
 * 读一份已落库的索引。没有就是 `null`（「还没建」不是错误）。
 *
 * `built_at` 原样取出来当 `builtAt`：第二次读到的值必须与第一次相同，这正是用例
 * 钉「同一个 sha 不会重建」的方式。
 */
export async function readIndex(db: Db, repo: string, sha: string): Promise<CodeIndex | null> {
  const res = await db.execute<{
    files: Record<string, IndexFile>;
    imports: Record<string, string[]>;
    routes: IndexRoute[];
    built_at: string | Date;
  }>(sql`
    select files, imports, routes, built_at
      from code_index
     where repo = ${repo} and sha = ${sha}
     limit 1`);
  const row = res.rows[0];
  if (row === undefined) return null;
  return {
    repo,
    sha,
    files: row.files ?? {},
    imports: row.imports ?? {},
    routes: row.routes ?? [],
    // pg 把 timestamptz 交回来可能是 Date，也可能是它的文本表示（`2026-11-07 09:35:31+00`）。
    // 两条路都归到同一个 ISO 形状，否则「第二次读到的 built_at 等于第一次」没法比。
    builtAt: (row.built_at instanceof Date
      ? row.built_at.toISOString()
      : new Date(String(row.built_at)).toISOString()),
  };
}

// ─── 写 ──────────────────────────────────────────────────────────────────────

/**
 * 落库。`on conflict do nothing`：两个并发请求同时命中同一个「空索引」时，先写的那份
 * 赢，后写的不覆盖——覆盖会把 `built_at` 变新，于是「建了几次」这件事就查不出来了。
 */
export async function writeIndex(db: Db, index: CodeIndex): Promise<void> {
  await db.insert(codeIndex).values({
    repo: index.repo,
    sha: index.sha,
    files: index.files,
    imports: index.imports,
    routes: index.routes,
    builtAt: new Date(index.builtAt),
  }).onConflictDoNothing();
}

/** 删一份索引（重跑用：CLI 的 `--rebuild` 与用例）。 */
export async function dropIndex(db: Db, repo: string, sha: string): Promise<void> {
  await db.delete(codeIndex).where(and(eq(codeIndex.repo, repo), eq(codeIndex.sha, sha)));
}

// ─── 懒建 ────────────────────────────────────────────────────────────────────

/** 一次 `git ls-tree` + 一次批量 `git show`（每文件只取前 `HEAD_LINES` 行）。 */
export async function buildIndex(
  repo: string,
  sha: string,
  deps: IndexDeps = LIVE_INDEX_DEPS,
): Promise<MirrorResult<{ index: CodeIndex; buildMs: number }>> {
  const started = Date.now();
  const tree = await deps.lsTreeEntries(repo, { ref: sha });
  if (!tree.ok) return tree;

  const sources: TreeEntry[] = tree.data.filter((entry) => CODE_EXT.test(entry.path)
    && classifyKind(entry.path) !== 'other');
  if (sources.length === 0) {
    // 后端仓（只有 .go/.java）就是这一支：索引为空，调用方据此退回 grep。
    return {
      ok: true,
      data: {
        index: { repo, sha, files: {}, imports: {}, routes: [], builtAt: indexTimestamp() },
        buildMs: Date.now() - started,
      },
    };
  }

  const heads = await deps.showHeads(repo, sources, { maxLines: HEAD_LINES });
  if (!heads.ok) return heads;

  const entries: SourceEntry[] = [];
  for (const entry of sources) {
    const text = heads.data.get(entry.path);
    if (text === undefined) continue;
    entries.push({ path: entry.path, size: entry.size, text });
  }

  const index = extractIndex({
    repo,
    sha,
    all: tree.data.map((entry) => entry.path),
    sources: entries,
  });
  return { ok: true, data: { index, buildMs: Date.now() - started } };
}

/**
 * `repoIndex(repo, sha)`：拿这一份索引，没有就建一次并落库。
 *
 * 失败一律是 `MirrorResult` 的中文失败（镜像读不到、仓库没配）：调用方按 §3.5 退回
 * grep，而不是让整条走查/评审失败。**建到一半失败不写库**——一份残缺索引比没有更糟，
 * 因为它看起来是「这个仓就这些文件」。
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
    const cached = await readIndex(db, repo, cleanSha);
    if (cached !== null) return { ok: true, data: { index: cached, built: false, buildMs: 0 } };
  }

  const built = await buildIndex(repo, cleanSha, deps);
  if (!built.ok) return built;
  if (persist) await writeIndex(db, built.data.index);
  return { ok: true, data: { index: built.data.index, built: true, buildMs: built.data.buildMs } };
}

/** 空索引判定（转发一次，免得两个调用方各写一遍 `Object.keys(...).length === 0`）。 */
export function indexIsEmpty(index: CodeIndex): boolean {
  return isEmptyIndex(index);
}

/** 摘要（CLI 与报告共用）。 */
export function indexSummary(index: CodeIndex): IndexSummary {
  return summarize(index);
}

export type { CodeIndex, IndexSummary, KindCounts };
