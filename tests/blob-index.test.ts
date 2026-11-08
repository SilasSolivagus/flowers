import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '../src/db/client.js';
import { existingBlobShas, readBlobRows } from '../src/core/codemirror/blob-index.js';
import {
  LIVE_INDEX_DEPS, assembleFor, buildIndex, clearAssembleCache, forgetBlobs, readIndex,
  repoIndex, syncRepoIndex,
} from '../src/core/codemirror/index-store.js';
import { DEFAULT_SSH_HOST, lsTreeEntries } from '../src/core/codemirror/mirror.js';

/**
 * P4-11（第二版）：索引**按内容**做一次，树**每次现读**。
 *
 * 第一版还建了一张 `tree_entry`（按提交的 `path → blob` 映射），被实测判了死刑：
 * 一个提交就是一整棵树（638 / 575 行），按 `文件 × 提交` 增长。迁移 0030 把它删了，
 * 装配改成「现读 `git ls-tree -r <sha>` + join `blob_index`」。这个文件钉的是：
 *
 * 1. **同一块内容只解析一次**（`parsed_at` 不变、读口不再请求它）；
 * 2. 同一个提交同步两次 → 0 块新内容；
 * 3. 旧提交装配出来是**那一棵树**（不是 HEAD 的）——`tree_entry` 删掉之后这条性质还在；
 * 4. 库里缺一块内容时**当场解析并写回**（自愈），第二次不再解析；
 * 5. 装配两次不会重复插内容行；同一块内容在两个仓里也只解析一次。
 *
 * 全部用当场 `git init` 出来的真仓（与 `index.test.ts` 同一个做法）：`ls-tree -l` 的
 * oid 列、`cat-file --batch` 的长度前缀都是真格式。
 *
 * 变异表：
 * | 变异 | 变红的用例 |
 * |---|---|
 * | 装配时不查 `blob_index`、每次都重解析 | 「两个提交共享一个没变过的文件」 |
 * | 装配时按 HEAD 的树拼（而不是请求的 sha） | 「旧提交的文件集不是 HEAD 的」 |
 * | 缺一块内容时跳过（不自愈） | 「库里缺一块 → 当场解析并写回」 |
 * | `blob_index` 主键带 repo / path | 「两个仓共享一块内容」 |
 * | 解析结果里存解析后的仓内路径 | 「装配与全量解析逐字相同」（`tests/index.test.ts` 也钉） |
 */

// ─── 夹具 ────────────────────────────────────────────────────────────────────

function gitCmd(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'flowers',
          GIT_AUTHOR_EMAIL: 'flowers@example.test',
          GIT_COMMITTER_NAME: 'flowers',
          GIT_COMMITTER_EMAIL: 'flowers@example.test',
        },
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args.join(' ')}\n${String(stderr)}`));
        else resolve(String(stdout));
      },
    );
  });
}

/** 两个仓共用的那块内容：`blob_index` 的跨仓复用就靠它。 */
const SHARED_SOURCE = [
  'export async function searchFiles(keyword: string) {',
  '  return fetch(`/api/share/search?kw=${keyword}`);',
  '}',
  '',
  "export const shareLink = '/s/abc';",
].join('\n');

const ROUTER = [
  "import { lazy } from 'react';",
  '',
  "const Search = lazy(() => import('pages/Search/Search'));",
  '',
  'export const routes = [',
  "  { path: '/search', component: Search, name: 'search' },",
  '];',
].join('\n');

const SEARCH_PAGE = [
  "import { searchFiles } from '@/services/share';",
  '',
  'export default function Search() {',
  '  return <button onClick={() => searchFiles("")}>搜索</button>;',
  '}',
].join('\n');

/** 第二个提交：只改一块内容，**加一个新文件**（好让「旧提交的文件集」能被区分出来）。 */
const SHARED_SOURCE_V2 = [
  SHARED_SOURCE,
  '',
  'export function shareStats() {',
  '  return { total: 0 };',
  '}',
].join('\n');

type Fixture = { root: string; one: string; two: string; oneC1: string; oneC2: string; twoC1: string };

const REPO_ENV = ['FLOWERS_MIRROR_TRANSPORT', 'FLOWERS_MIRROR_REPOS', 'FLOWERS_MIRROR_SSH_HOST'] as const;
const REPOS = ['fixture-blob-one', 'fixture-blob-two'] as const;
const savedEnv = new Map<string, string | undefined>();
let fixture: Fixture;

async function commitInto(work: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(work, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  await gitCmd(work, ['add', '-A']);
  await gitCmd(work, ['commit', '-q', '-m', message]);
  return (await gitCmd(work, ['rev-parse', 'HEAD'])).trim();
}

async function initRepo(root: string, name: string): Promise<{ work: string; bare: string }> {
  const work = path.join(root, `${name}-work`);
  const bare = path.join(root, `${name}.git`);
  await mkdir(work, { recursive: true });
  await gitCmd(work, ['init', '-q']);
  await gitCmd(root, ['init', '--bare', '-q', bare]);
  await gitCmd(bare, ['symbolic-ref', 'HEAD', 'refs/heads/master']);
  return { work, bare };
}

/** 夹具里所有提交用到的全部 blob id（收口用）。 */
async function allFixtureShas(): Promise<string[]> {
  if (fixture === undefined) return [];
  const shas = new Set<string>();
  for (const repo of REPOS) {
    for (const sha of [fixture.oneC1, fixture.oneC2, fixture.twoC1]) {
      const tree = await lsTreeEntries(repo, { ref: sha });
      if (tree.ok) for (const entry of tree.data) shas.add(entry.oid);
    }
  }
  return [...shas];
}

beforeAll(async () => {
  for (const key of REPO_ENV) savedEnv.set(key, process.env[key]);
  const root = await mkdtemp(path.join(tmpdir(), 'flowers-blob-'));
  const one = await initRepo(root, 'fixture-blob-one');
  const two = await initRepo(root, 'fixture-blob-two');

  // 仓一：c1 = 三个文件；c2 = 只改 share.ts（并加一个组件）。
  const oneC1 = await commitInto(one.work, {
    'src/router/router.js': ROUTER,
    'src/pages/Search/Search.tsx': SEARCH_PAGE,
    'src/services/share.ts': SHARED_SOURCE,
  }, 'c1');
  await gitCmd(one.work, ['push', '-q', one.bare, 'HEAD:refs/heads/master']);
  const oneC2 = await commitInto(one.work, {
    'src/services/share.ts': SHARED_SOURCE_V2,
    'src/components/share-badge/index.tsx': 'export default function ShareBadge() { return <i />; }\n',
  }, 'c2');
  await gitCmd(one.work, ['push', '-q', one.bare, 'HEAD:refs/heads/master']);

  // 仓二：**另一条历史**，但有两块内容与仓一逐字节相同（不同路径、不同目录布局）。
  const twoC1 = await commitInto(two.work, {
    'app/services/share.ts': SHARED_SOURCE,
    // 这块内容与仓一的 `src/pages/Search/Search.tsx` **逐字节相同**：它里面的
    // `@/services/share` 在两个仓里必须解出不同的答案（仓一有 `src/`，仓二没有）。
    'app/pages/Search/Search.tsx': SEARCH_PAGE,
    'app/views/Home/Home.vue': "<template><view /></template>\n\n<script setup>\nconst home = 1\n</script>\n",
  }, 'two-c1');
  await gitCmd(two.work, ['push', '-q', two.bare, 'HEAD:refs/heads/master']);

  fixture = { root, one: one.bare, two: two.bare, oneC1, oneC2, twoC1 };

  process.env.FLOWERS_MIRROR_TRANSPORT = 'local';
  process.env.FLOWERS_MIRROR_SSH_HOST = DEFAULT_SSH_HOST;
  process.env.FLOWERS_MIRROR_REPOS = JSON.stringify([
    { id: 'fixture-blob-one', path: one.bare },
    { id: 'fixture-blob-two', path: two.bare },
  ]);

  // `blob_index` 不参与 `resetDb` 的 truncate（见 `src/db/reset.ts`）：谁写谁收口。
  clearAssembleCache();
  await forgetBlobs(db, await allFixtureShas());
});

afterAll(async () => {
  clearAssembleCache();
  await forgetBlobs(db, await allFixtureShas());
  for (const key of REPO_ENV) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (fixture !== undefined) await rm(fixture.root, { recursive: true, force: true });
});

/** 某个提交用到的全部 blob id（去重，**问 git**——库里没有「这个提交」这种东西了）。 */
async function shasOf(repo: string, sha: string): Promise<string[]> {
  const tree = await lsTreeEntries(repo, { ref: sha });
  if (!tree.ok) throw new Error(`读不到 ${repo}@${sha.slice(0, 8)} 的树：${tree.message}`);
  return [...new Set(tree.data.map((entry) => entry.oid))];
}

// ─── 1. 同一块内容只解析一次 ────────────────────────────────────────────────

describe('内容寻址：同一块内容只解析一次', () => {
  it('两个提交共享一个没变过的文件 → 那块 blob 第二次不再读、parsed_at 不变', async () => {
    const first = await syncRepoIndex(db, 'fixture-blob-one', fixture.oneC1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 三个文件、三块内容：全量解析。
    expect(first.data.report.newBlobs).toBe(3);
    expect(first.data.report.reusedBlobs).toBe(0);

    const before = await readBlobRows(db, await shasOf('fixture-blob-one', fixture.oneC1));
    expect(before.size).toBe(3);
    const parsedAt = new Map([...before].map(([sha, row]) => [sha, row.parsedAt]));

    // 第二个提交：只改了 share.ts，另外两块内容一模一样。
    const requested: string[] = [];
    const second = await syncRepoIndex(db, 'fixture-blob-one', fixture.oneC2, {
      ...LIVE_INDEX_DEPS,
      readBlobs: (repo, refs, opts) => {
        for (const ref of refs) requested.push(ref.blobSha);
        return LIVE_INDEX_DEPS.readBlobs!(repo, refs, opts);
      },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // 新提交里只有两块内容库里没有：改过的 share.ts 与新增的组件。
    expect(second.data.report.newBlobs).toBe(2);
    expect(second.data.report.reusedBlobs).toBe(2);
    // 两个提交都用到的那两块（`Search.tsx` / `router.js`）**根本没有被请求**——这就是
    // 「只解析一次」的证据；被改过的 share.ts 是**另一块内容**（新的 blob id），所以它
    // 不在复用名单里。
    const c2Shas = await shasOf('fixture-blob-one', fixture.oneC2);
    const shared = [...parsedAt.keys()].filter((sha) => c2Shas.includes(sha));
    expect(shared.length).toBe(2);
    for (const sha of shared) expect(requested).not.toContain(sha);

    const after = await readBlobRows(db, c2Shas);
    expect(after.size).toBe(4);
    for (const sha of shared) expect(after.get(sha)?.parsedAt).toBe(parsedAt.get(sha));
  });

  it('同一个提交同步两次：第二次 0 块新内容', async () => {
    const again = await syncRepoIndex(db, 'fixture-blob-one', fixture.oneC1);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.report.newBlobs).toBe(0);
    expect(again.data.report.reusedBlobs).toBe(3);
  });

  it('两个仓共享一块内容 → 只解析一次（主键不按 repo/path 分）', async () => {
    const twoShas = await shasOf('fixture-blob-two', fixture.twoC1);
    // 三块内容里已经有两块在库里（仓一刚解析过），只剩 Home.vue 是新的。
    expect((await existingBlobShas(db, twoShas)).size).toBe(2);

    const synced = await syncRepoIndex(db, 'fixture-blob-two', fixture.twoC1);
    expect(synced.ok).toBe(true);
    if (!synced.ok) return;
    expect(synced.data.report.newBlobs).toBe(1);
    expect(synced.data.report.reusedBlobs).toBe(2);

    // 仓二的索引仍然拿得到那块内容的符号与导入（复用不等于缺失）。
    const index = await readIndex(db, 'fixture-blob-two', fixture.twoC1);
    expect(index?.files['app/services/share.ts']?.exports).toContain('searchFiles');
    expect(index?.files['app/services/share.ts']?.kind).toBe('service');
  });
});

// ─── 2. 自愈：库里缺一块就当场解析并写回 ────────────────────────────────────

describe('自愈：树里有、库里没有的块', () => {
  it('缺一块 → 这次装配解析它并写回；下一次不再解析', async () => {
    const shas = await shasOf('fixture-blob-one', fixture.oneC2);
    // 模拟「这个提交在完整同步之前就被读过」：手动删掉一块内容。
    const victim = shas[0]!;
    expect(await forgetBlobs(db, [victim])).toBe(1);
    expect((await existingBlobShas(db, [victim])).size).toBe(0);

    const healed = await assembleFor(db, 'fixture-blob-one', fixture.oneC2);
    expect(healed.ok).toBe(true);
    if (!healed.ok) return;
    expect(healed.data.parsedBlobs).toBe(1);
    // 自愈之后内容还在，而且装配出来的文件数不多不少（缺一块不会让整份索引残缺）。
    expect((await existingBlobShas(db, [victim])).size).toBe(1);
    expect(Object.keys(healed.data.index.files).length).toBe(4);

    const again = await assembleFor(db, 'fixture-blob-one', fixture.oneC2);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.parsedBlobs).toBe(0);
    expect(again.data.reusedBlobs).toBe(4);
  });

  it('装配两次不会重复插内容行（行数不变）', async () => {
    const before = (await readBlobRows(db, await shasOf('fixture-blob-one', fixture.oneC2))).size;
    const a = await assembleFor(db, 'fixture-blob-one', fixture.oneC2);
    const b = await assembleFor(db, 'fixture-blob-one', fixture.oneC2);
    expect(a.ok && b.ok).toBe(true);
    const after = (await readBlobRows(db, await shasOf('fixture-blob-one', fixture.oneC2))).size;
    expect(after).toBe(before);
    // 两个仓、三个提交用到的不重复内容一共 6 块：仓一 5 块（含被改掉的 share.ts 旧版
    // 与新版各一块）+ 仓二的 Home.vue；仓二另外两块与仓一逐字节相同，一行都不多。
    const all = new Set([
      ...(await shasOf('fixture-blob-one', fixture.oneC1)),
      ...(await shasOf('fixture-blob-one', fixture.oneC2)),
      ...(await shasOf('fixture-blob-two', fixture.twoC1)),
    ]);
    expect(all.size).toBe(6);
    expect((await readBlobRows(db, [...all])).size).toBe(6);
  });
});

// ─── 3. 旧提交仍然是旧提交（tree_entry 删了，性质不变） ─────────────────────

describe('装配：按请求的 sha 现读那一棵树', () => {
  it('旧提交的文件集不是 HEAD 的（新文件不出现，符号是旧的那一版）', async () => {
    clearAssembleCache();
    const old = await repoIndex(db, 'fixture-blob-one', fixture.oneC1);
    const fresh = await repoIndex(db, 'fixture-blob-one', fixture.oneC2);
    expect(old.ok).toBe(true);
    expect(fresh.ok).toBe(true);
    if (!old.ok || !fresh.ok) return;

    const oldFiles = Object.keys(old.data.index.files).sort();
    const newFiles = Object.keys(fresh.data.index.files).sort();
    expect(oldFiles).toEqual([
      'src/pages/Search/Search.tsx',
      'src/router/router.js',
      'src/services/share.ts',
    ]);
    expect(newFiles).toContain('src/components/share-badge/index.tsx');
    expect(newFiles).not.toEqual(oldFiles);

    // 同一路径在两棵树上的内容不同 → 符号表也跟着不同（装配用的是各自那块 blob）。
    expect(old.data.index.files['src/services/share.ts']?.exports).not.toContain('shareStats');
    expect(fresh.data.index.files['src/services/share.ts']?.exports).toContain('shareStats');
    // 第二次读同一个 sha 命中进程内缓存（不再付一次 ls-tree）。
    const cached = await repoIndex(db, 'fixture-blob-one', fixture.oneC2);
    expect(cached.ok).toBe(true);
    if (cached.ok) {
      expect(cached.data.built).toBe(false);
      expect(cached.data.buildMs).toBe(0);
    }
  });
});

// ─── 4. 导入解析与旧口径逐字相同 ────────────────────────────────────────────

describe('装配：导入与路由和「全量解析」逐字相同', () => {
  it('库里的装配结果 == 一次性全量解析的结果（files / imports / routes）', async () => {
    const stored = await readIndex(db, 'fixture-blob-one', fixture.oneC1);
    const full = await buildIndex('fixture-blob-one', fixture.oneC1);
    expect(stored).not.toBeNull();
    expect(full.ok).toBe(true);
    if (stored === null || !full.ok) return;

    // `@/services/share` 这类别名在**读的时候**用当前树解析：装配结果必须与旧路径一致。
    expect(stored.files).toEqual(full.data.index.files);
    expect(stored.imports).toEqual(full.data.index.imports);
    expect(stored.routes).toEqual(full.data.index.routes);
    expect(stored.imports['src/pages/Search/Search.tsx']).toEqual(['src/services/share.ts']);
    // 路由表里 `component: Search` 靠本地名映射落回文件。
    expect(stored.routes.find((route) => route.route === '/search')?.file)
      .toBe('src/pages/Search/Search.tsx');

    // 同一块内容（逐字节相同）、同一句 `@/services/share`，在两个仓里落到了**不同的文件**：
    // 仓一靠 `@/` → `src/` 直达 `src/services/share.ts`，仓二没有 `src/`，靠后缀兜底落到
    // `app/services/share.ts`。这就是「解析结果不能写进共享的 blob 行」的意义——存下来
    // 的那一份必然是其中一个仓的答案，另一个仓会读到错的文件。
    const twoIndex = await readIndex(db, 'fixture-blob-two', fixture.twoC1);
    expect(twoIndex?.imports['app/pages/Search/Search.tsx']).toEqual(['app/services/share.ts']);
  });
});
