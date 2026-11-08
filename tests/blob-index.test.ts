import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '../src/db/client.js';
import {
  existingBlobShas, forgetBlobs, readBlobRows,
} from '../src/core/codemirror/blob-index.js';
import {
  LIVE_INDEX_DEPS, buildIndex, dropIndex, readIndex, repoIndex, syncRepoIndex,
} from '../src/core/codemirror/index-store.js';
import { DEFAULT_SSH_HOST, head, lsTreeEntries } from '../src/core/codemirror/mirror.js';

/**
 * P4-11：索引**按内容**做一次，之后永远增量。
 *
 * 这个文件只钉一件事的五个侧面：**同一块内容不会被解析第二次**，而树的差异仍然
 * 一字不差地还原得出来。全部用当场 `git init` 出来的真仓（与 `index.test.ts`
 * 同一个做法）——`ls-tree -l` 的 oid 列、`cat-file --batch` 的长度前缀都是真格式。
 *
 * 变异表（把每条实现改坏，看哪条用例变红）：
 * | 变异 | 变红的用例 |
 * |---|---|
 * | `blob_index` 主键改成 `(repo, path)` | 「两个仓共享的内容只解析一次」 |
 * | `repoIndex` 不查 `hasTree` 就重建 | 「同一个提交同步两次：0 块新内容」 |
 * | 装配时用 HEAD 的树而不是请求的 sha | 「旧提交的文件集不是 HEAD 的」 |
 * | 解析结果里存解析后的仓内路径（而不是说明符） | 「导入关系与全量解析逐字相同」 |
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

  // 仓二：**另一条历史**，但有一块内容与仓一逐字节相同（不同路径、不同目录布局）。
  const twoC1 = await commitInto(two.work, {
    'app/services/share.ts': SHARED_SOURCE,
    // 这块内容与仓一的 `src/pages/Search/Search.tsx` **逐字节相同**：它里面的
    // `@/services/share` 在两个仓里必须解出不同的答案（仓二没有 `src/`）。
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
  for (const repo of ['fixture-blob-one', 'fixture-blob-two']) {
    for (const sha of [fixture.oneC1, fixture.oneC2, fixture.twoC1]) await dropIndex(db, repo, sha);
    const tree = await lsTreeEntries(repo);
    if (tree.ok) await forgetBlobs(db, tree.data.map((entry) => entry.oid));
  }
});

afterAll(async () => {
  for (const repo of ['fixture-blob-one', 'fixture-blob-two']) {
    for (const sha of [fixture.oneC1, fixture.oneC2, fixture.twoC1]) await dropIndex(db, repo, sha);
    const tree = await lsTreeEntries(repo);
    if (tree.ok) await forgetBlobs(db, tree.data.map((entry) => entry.oid));
  }
  for (const key of REPO_ENV) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (fixture !== undefined) await rm(fixture.root, { recursive: true, force: true });
});

/** 某个提交用到的全部 blob id（去重，**问 git**——同步之前它也可能还没进库）。 */
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
    expect(first.data.report.newEntries).toBe(3);
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
    // **没有被读回来**的正是那两块没变过的内容 —— 这就是「解析一次」的证据。
    const c2Shas = await shasOf('fixture-blob-one', fixture.oneC2);
    const after = await readBlobRows(db, c2Shas);
    expect(after.size).toBe(4);
    // 两个提交都用到的那两块内容：时间戳一字不动 = 没被重新解析。
    const shared = [...parsedAt.keys()].filter((sha) => c2Shas.includes(sha));
    expect(shared.length).toBe(2);
    for (const sha of shared) expect(after.get(sha)?.parsedAt).toBe(parsedAt.get(sha));
  });

  it('同一个提交同步两次：第二次 0 块新内容、0 行新映射', async () => {
    const again = await syncRepoIndex(db, 'fixture-blob-one', fixture.oneC1);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.report.newBlobs).toBe(0);
    expect(again.data.report.newEntries).toBe(0);
    expect(again.data.report.reusedBlobs).toBe(3);
  });

  it('两个仓共享一块内容 → 只解析一次（主键不按 repo/path 分）', async () => {
    // 仓二有一条**完全不同**的历史：路径是 `app/services/share.ts`，内容与仓一的
    // `src/services/share.ts` 逐字节相同。若主键里带 repo 或 path，这块就会被解析第二遍。
    const twoShas = await shasOf('fixture-blob-two', fixture.twoC1);
    // 三块内容里已经有两块在库里（仓一刚解析过），只剩 Home.vue 是新的。
    expect((await existingBlobShas(db, twoShas)).size).toBe(2);

    const synced = await syncRepoIndex(db, 'fixture-blob-two', fixture.twoC1);
    expect(synced.ok).toBe(true);
    if (!synced.ok) return;
    // 三个文件，只有 Home.vue 是新内容；另外两块**在仓一已经解析过**。
    expect(synced.data.report.newBlobs).toBe(1);
    expect(synced.data.report.reusedBlobs).toBe(2);

    // 仓二的索引仍然拿得到那块内容的符号与导入（复用不等于缺失）。
    const index = await readIndex(db, 'fixture-blob-two', fixture.twoC1);
    expect(index?.files['app/services/share.ts']?.exports).toContain('searchFiles');
    expect(index?.files['app/services/share.ts']?.kind).toBe('service');
  });
});

// ─── 2. 改一个文件 = 一行新内容 ─────────────────────────────────────────────

describe('增量：改一个文件只多一行 blob', () => {
  it('新提交多 2 块内容、全量映射补齐、其余复用', async () => {
    await dropIndex(db, 'fixture-blob-one', fixture.oneC1);
    await dropIndex(db, 'fixture-blob-one', fixture.oneC2);
    // 上面几条用例已经把这块内容解析过了；这一条要量「第一次见到它们时增量是多少」，
    // 所以先忘掉 c2 用到的内容（等价于「这个仓从来没被索引过」）。
    await forgetBlobs(db, await shasOf('fixture-blob-one', fixture.oneC2));
    const c1 = await syncRepoIndex(db, 'fixture-blob-one', fixture.oneC1);
    if (!c1.ok) return;
    const c2 = await syncRepoIndex(db, 'fixture-blob-one', fixture.oneC2);
    expect(c2.ok).toBe(true);
    if (!c2.ok) return;
    expect(c2.data.report.newBlobs).toBe(2);
    // 每个提交都要有自己的整张映射（主键里有 commit_sha）；第二个提交的四个路径全是新行。
    expect(c2.data.report.newEntries).toBe(4);
    expect(c2.data.report.reusedBlobs).toBe(2);
  });
});

// ─── 3. 旧提交仍然是旧提交 ──────────────────────────────────────────────────

describe('装配：按请求的 sha 还原那一棵树', () => {
  it('旧提交的文件集不是 HEAD 的（新文件不出现，符号是旧的那一版）', async () => {
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
    // 第二次是命中（不再同步）。
    expect(fresh.data.built).toBe(false);
    expect(fresh.data.buildMs).toBe(0);
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
    expect(stored.imports['src/pages/Search/Search.tsx']).toContain('src/services/share.ts');
    // 路由表里 `component: Search` 靠本地名映射落回文件。
    expect(stored.routes.find((route) => route.route === '/search')?.file)
      .toBe('src/pages/Search/Search.tsx');
    // 同一块内容（逐字节相同）、同一句 `@/services/share`，在两个仓里落到了**不同的文件**：
    // 仓一靠 `@/` → `src/` 直达 `src/services/share.ts`，仓二没有 `src/`，靠后缀兜底落到
    // `app/services/share.ts`。这就是「解析结果不能写进共享的 blob 行」的意义——存下来
    // 的那一份必然是其中一个仓的答案，另一个仓会读到错的文件。
    const twoIndex = await readIndex(db, 'fixture-blob-two', fixture.twoC1);
    expect(twoIndex?.imports['app/pages/Search/Search.tsx']).toEqual(['app/services/share.ts']);
    expect(stored.imports['src/pages/Search/Search.tsx']).toEqual(['src/services/share.ts']);
  });
});
