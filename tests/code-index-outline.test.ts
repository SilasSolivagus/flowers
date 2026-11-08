import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '../src/db/client.js';
import { readBlobRows } from '../src/core/codemirror/blob-index.js';
import { extractIndex, outlineOf, type CodeIndex } from '../src/core/codemirror/code-index.js';
import {
  assembleFor, clearAssembleCache, forgetBlobs, syncRepoIndex,
} from '../src/core/codemirror/index-store.js';
import { DEFAULT_SSH_HOST, lsTreeEntries } from '../src/core/codemirror/mirror.js';

/**
 * Task 2：一页里已经有哪些组件（outline 第一层）。
 *
 * 为什么要这一层：评估材料里最容易编的是「这个页面缺一个搜索框」——而搜索框可能已经
 * 在那一页的 `<template>` 里了。进入 script 解析 AST 之前，`outline` 先回答最粗的那个
 * 问题：**这一页的 template 用了哪些大写开头的标签**（大写 = 我们维护的组件，`div`/`li`
 * 不是）。这一层只做 `.vue`：uni-app 的页面就是 `.vue`，React 那一半等 tree-sitter。
 *
 * 落库这一半钉的是「outline 按内容地址存」：同一块 `.vue` 在 40 个提交里只有一行，
 * 而**本轮之前写下的行 `outline` 是 null**（列还不存在），它必须按 `[]` 读——一次
 * 读取不能因为一块老内容而整份失败。
 */

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

/** 纯函数装配入口：路径 + 内容 → 一份索引（不碰 git、不碰库）。 */
function indexOf(files: Record<string, string>): CodeIndex {
  const paths = Object.keys(files);
  return extractIndex({
    repo: 'fixture-outline',
    sha: '0123456789abcdef',
    all: paths,
    sources: paths.map((path) => ({ path, size: files[path]?.length ?? 0, text: files[path] ?? '' })),
  });
}

const VUE = `<template>
  <div class="wrap">
    <ShareHeader :title="t" />
    <SearchBar v-model="kw" />
    <ul><li v-for="f in list">{{ f.name }}</li></ul>
  </div>
</template>
<script setup lang="ts">
const kw = ref('');
</script>`;

describe('outlineOf', () => {
  it('只取 template 里的组件使用（大写开头标签），行号是全文行号', () => {
    expect(outlineOf('pages/share/index.vue', VUE)).toEqual([
      { kind: 'component-use', name: 'ShareHeader', line: 3 },
      { kind: 'component-use', name: 'SearchBar', line: 4 },
    ]);
  });

  it('小写 HTML 标签不算组件（div/ul/li 不是我们维护的东西）', () => {
    const names = outlineOf('a.vue', VUE).map((node) => node.name);
    expect(names).not.toContain('div');
    expect(names).not.toContain('ul');
    expect(names).not.toContain('li');
  });

  it('非 vue 文件返回空数组（这一层只做 vue）', () => {
    // 内容里就是有 template 也不算：这一层只对 `.vue` 有承诺。
    expect(outlineOf('src/util.ts', VUE)).toEqual([]);
  });

  it('template 里嵌套的 <template v-if> 不会截断后面的组件', () => {
    const nested = [
      '<template>',
      '  <div>',
      '    <template v-if="ok">',
      '      <ShareHeader />',
      '    </template>',
      '    <SearchBar />',
      '  </div>',
      '</template>',
    ].join('\n');
    expect(outlineOf('a.vue', nested).map((node) => node.name)).toEqual(['ShareHeader', 'SearchBar']);
  });

  it('template 不在第一行时行号照样对得上（前面有注释与空行）', () => {
    const vue = [
      '<!-- 页面：分享 -->',
      '',
      '<template>',
      '  <div>',
      '    <ShareHeader />',
      '  </div>',
      '</template>',
    ].join('\n');
    expect(outlineOf('a.vue', vue)).toEqual([{ kind: 'component-use', name: 'ShareHeader', line: 5 }]);
  });
});

describe('装配：outline 按路径挂到索引上', () => {
  it('只收有组件使用的 .vue 文件，.ts 不会出现在 outline 里', () => {
    const index = indexOf({
      'src/pages/share/index.vue': '<template>\n  <ShareHeader />\n  <SearchBar />\n</template>\n',
      'src/services/share.ts': 'export const a = 1;\n',
    });
    expect(index.outline['src/pages/share/index.vue']).toEqual([
      { kind: 'component-use', name: 'ShareHeader', line: 2 },
      { kind: 'component-use', name: 'SearchBar', line: 3 },
    ]);
    expect(Object.keys(index.outline)).toEqual(['src/pages/share/index.vue']);
  });
});

// ─── 落库：outline 按 blob 存，null 按 [] 读 ────────────────────────────────

const REPO_ENV = ['FLOWERS_MIRROR_TRANSPORT', 'FLOWERS_MIRROR_REPOS', 'FLOWERS_MIRROR_SSH_HOST'] as const;
const REPO = 'fixture-outline-repo';
const savedEnv = new Map<string, string | undefined>();
type Entry = { path: string; oid: string };
let fixture: { root: string; bare: string; sha: string; entries: Entry[] };

/**
 * 30 条页面、300 行：**整份读**才数得全（真仓 `pages.json` 是 250 行、27 条）。
 * 只要前 80 行时这里只能拿到 8 条——那正是这一层会「丢掉一半页面」的坏法。
 */
const PAGES_JSON = JSON.stringify({
  pages: Array.from({ length: 30 }, (_, i) => ({
    path: `pages/p${i}/index`,
    style: { navigationBarTitleText: `第 ${i} 页` },
  })),
}, null, 2);

/** 组件出现在第 105 行：同样只有整份读才看得见（见 `index-store.ts` 的 `clipFor`）。 */
const SHARE_VUE = [
  '<template>',
  '  <div class="share">',
  '    <ShareHeader />',
  '    <SearchBar v-model="kw" />',
  ...Array.from({ length: 100 }, (_, i) => `    <div class="filler-${i}" />`),
  '    <LateShareBar />',
  '  </div>',
  '</template>',
  '',
  '<script setup lang="ts">',
  'const kw = ref("");',
  '</script>',
].join('\n');
const SEARCH_VUE = '<template>\n  <SearchBar v-model="kw" />\n</template>\n';

beforeAll(async () => {
  for (const key of REPO_ENV) savedEnv.set(key, process.env[key]);
  const root = await mkdtemp(path.join(tmpdir(), 'flowers-outline-'));
  const work = path.join(root, 'work');
  const bare = path.join(root, `${REPO}.git`);
  await mkdir(work, { recursive: true });
  await gitCmd(work, ['init', '-q']);
  for (const [file, content] of Object.entries({
    'src/pages.json': PAGES_JSON,
    'src/pages/share/index.vue': SHARE_VUE,
    'src/pages/search/search.vue': SEARCH_VUE,
  })) {
    const target = path.join(work, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  await gitCmd(work, ['add', '-A']);
  await gitCmd(work, ['commit', '-q', '-m', 'outline fixture']);
  await gitCmd(root, ['init', '--bare', '-q', bare]);
  await gitCmd(bare, ['symbolic-ref', 'HEAD', 'refs/heads/master']);
  await gitCmd(work, ['push', '-q', bare, 'HEAD:refs/heads/master']);
  const sha = (await gitCmd(work, ['rev-parse', 'HEAD'])).trim();

  process.env.FLOWERS_MIRROR_TRANSPORT = 'local';
  process.env.FLOWERS_MIRROR_SSH_HOST = DEFAULT_SSH_HOST;
  process.env.FLOWERS_MIRROR_REPOS = JSON.stringify([{ id: REPO, path: bare }]);

  const tree = await lsTreeEntries(REPO, { ref: sha });
  if (!tree.ok) throw new Error(`读不到夹具仓的树：${tree.message}`);
  fixture = { root, bare, sha, entries: tree.data.map((entry) => ({ path: entry.path, oid: entry.oid })) };

  // `blob_index` 不参与 `resetDb` 的 truncate：谁写谁收口。
  clearAssembleCache();
  await forgetBlobs(db, fixture.entries.map((entry) => entry.oid));
});

afterAll(async () => {
  clearAssembleCache();
  if (fixture !== undefined) {
    await forgetBlobs(db, fixture.entries.map((entry) => entry.oid));
    await rm(fixture.root, { recursive: true, force: true });
  }
  for (const key of REPO_ENV) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('落库：outline / pages 按内容地址存', () => {
  it('同步之后两块 .vue 的 outline 非空，pages.json 的 pages 非空，装配带得出来', async () => {
    const synced = await syncRepoIndex(db, REPO, fixture.sha);
    expect(synced.ok).toBe(true);
    if (!synced.ok) return;

    const rows = await readBlobRows(db, fixture.entries.map((entry) => entry.oid));
    const outlines = [...rows.values()].filter((row) => row.outline.length > 0);
    expect(outlines.length).toBe(2);
    expect(outlines.map((row) => row.outline.map((node) => node.name)))
      .toContainEqual(['ShareHeader', 'SearchBar', 'LateShareBar']);

    const pagesRow = [...rows.values()].find((row) => row.pages.length > 0);
    // 30 条一条不少（第 30 条在第 300 行附近，只有整份读才数得到）。
    expect(pagesRow?.pages.length).toBe(30);
    expect(pagesRow?.pages[29]).toEqual({ route: '/pages/p29/index', title: '第 29 页', source: 'pages.json' });

    const assembled = await assembleFor(db, REPO, fixture.sha);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    // 第 106 行的组件也在里面：outline 看的是整份 template，不是文件头 80 行。
    expect(assembled.data.index.outline['src/pages/share/index.vue']).toContainEqual(
      { kind: 'component-use', name: 'LateShareBar', line: 105 },
    );
    expect(assembled.data.index.pages.map((page) => page.route)).toContain('/pages/p29/index');
  });

  it('outline 是 null 的老行按 [] 读，装配不报错', async () => {
    const share = fixture.entries.find((entry) => entry.path === 'src/pages/share/index.vue');
    expect(share).toBeDefined();
    if (share === undefined) return;

    // 模拟「这块内容在本轮之前就索引过」：0032 之前写下的行，outline 列就是 null。
    await db.execute(sql`update blob_index set outline = null where blob_sha = ${share.oid}`);
    clearAssembleCache();

    const assembled = await assembleFor(db, REPO, fixture.sha);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    // 少一块 outline 只是「这一页没有组件清单」，不是一次失败；另一页的清单还在。
    expect(assembled.data.index.outline['src/pages/share/index.vue']).toBeUndefined();
    expect(assembled.data.index.outline['src/pages/search/search.vue']?.map((node) => node.name))
      .toEqual(['SearchBar']);
  });
});
