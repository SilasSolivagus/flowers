import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '../src/db/client.js';
import {
  classifyKind, conventionRoute, extractIndex, locate, locateOrFallback, resolveSpecifier,
  classifyKind as kindOf,
} from '../src/core/codemirror/code-index.js';
import {
  LIVE_INDEX_DEPS, buildIndex, dropIndex, readIndex, repoIndex, type IndexDeps,
} from '../src/core/codemirror/index-store.js';
import { DEFAULT_SSH_HOST, head, lsTreeEntries, showHeads } from '../src/core/codemirror/mirror.js';

/**
 * P4-10 第 1–2 步：静态索引 + 在索引上定位。
 *
 * **一条 ssh 都不发。** 夹具是当场 `git init --bare` 出来、当场 push 进去的两个真仓
 * （与 `codemirror.test.ts` 同一个做法）：这样测的是真实的 `execFile`、真实的
 * `ls-tree -l -z` 输出格式、真实的「多个 blob 拼在一起」的字节流。
 *
 * 要钉住七件事：
 * 1. 类别由路径决定，噪音（`dist/`、`node_modules/`、`.png`）不进索引；
 * 2. 路由能从 React 路由表里抽出来，也能从 `pages/<dir>/<name>` 目录约定里抽出来；
 * 3. 导入关系解析成仓内路径，`@/` 别名与目录导入（`/index`）都对；
 * 4. 导出符号抓得到（含 `export default X`、`<script setup>` 里的 `const`）；
 * 5. `locate` 把「路由命中的页面」排在「导出符号命中的服务」前面，且 `why` 说得出为什么；
 * 6. **后端仓（只有 `.go`）索引为空 → 调用方明说退回 grep**（不测 grep 的输出）；
 * 7. 同一个 `(repo, sha)` 建第二次**不再建**（读口计数不变、`built_at` 不变）。
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

/** React 那一半：路由表 + 页面 + 组件 + 服务 + 噪音。每条路径都在测一条规则。 */
const REACT_FILES: Record<string, string> = {
  'src/router/router.js': [
    "import { lazy } from 'react';",
    '',
    "const Search = lazy(() => import(/* webpackChunkName: \"search\" */ 'pages/Search/Search'));",
    '',
    'export const routes = [',
    '  { exact: true, path: \'/search\', component: Search, name: \'search\' },',
    '];',
    '',
    'export default routes;',
  ].join('\n'),
  'src/pages/Search/Search.tsx': [
    "import SearchEntrance from '@/components/SearchEntrance';",
    "import { searchFiles } from '@/services/share';",
    '',
    'export default function Search() {',
    '  return <SearchEntrance onSubmit={searchFiles} />;',
    '}',
    '',
    'export function SearchHeader() {',
    '  return <header>搜索</header>;',
    '}',
  ].join('\n'),
  'src/components/SearchEntrance/index.tsx': [
    "import { searchFiles } from '@/services/share';",
    '',
    'export function SearchEntrance({ onSubmit }: { onSubmit: typeof searchFiles }) {',
    '  return <input onChange={() => onSubmit()} />;',
    '}',
    '',
    'export default SearchEntrance;',
  ].join('\n'),
  // 目录约定那一半：这一页不在任何路由表里，只能靠 `pages/<dir>/<name>` 得到路由。
  'src/pages/Profile/Profile.vue': [
    '<template>',
    '  <view class="profile">{{ profile }}</view>',
    '</template>',
    '',
    "<script lang='ts' setup>",
    'const profile = ref(null)',
    'async function loadProfile() {',
    '  profile.value = await fetchProfile()',
    '}',
    '</script>',
  ].join('\n'),
  'src/services/share.ts': [
    '/** 分享相关接口。搜索文件就是这里发出去的。 */',
    'export async function searchFiles(keyword: string) {',
    '  return fetch(`/api/share/search?kw=${keyword}`);',
    '}',
    '',
    "export const shareLink = '/s/abc';",
  ].join('\n'),
  // 噪音三件套：打包产物、依赖目录、图片
  'dist/bundle.js': '(()=>{const search="搜索"})();\n',
  'node_modules/x/index.js': 'module.exports = "搜索";\n',
  'public/logo.png': 'png-bytes-搜索',
};

/** 后端仓：一个 JS/TS 页面都没有，索引必须是空的。 */
const GO_FILES: Record<string, string> = {
  'main.go': 'package main\n\nfunc main() {}\n',
  'pkg/util.go': 'package pkg\n\nfunc Search() {}\n',
};

type Fixture = { root: string; react: string; go: string };

async function buildRepo(root: string, name: string, files: Record<string, string>): Promise<string> {
  const work = path.join(root, `${name}-work`);
  const bare = path.join(root, `${name}.git`);
  await mkdir(work, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(work, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  await gitCmd(work, ['init', '-q']);
  await gitCmd(work, ['add', '-A']);
  await gitCmd(work, ['commit', '-q', '-m', `fixture: ${name}`]);
  await gitCmd(root, ['init', '--bare', '-q', bare]);
  await gitCmd(bare, ['symbolic-ref', 'HEAD', 'refs/heads/master']);
  await gitCmd(work, ['push', '-q', bare, 'HEAD:refs/heads/master']);
  return bare;
}

// ─── 环境 ────────────────────────────────────────────────────────────────────

const ENV_KEYS = ['FLOWERS_MIRROR_TRANSPORT', 'FLOWERS_MIRROR_REPOS', 'FLOWERS_MIRROR_SSH_HOST'] as const;
const savedEnv = new Map<string, string | undefined>();
let fixture: Fixture;
let reactSha = '';
let goSha = '';

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  const root = await mkdtemp(path.join(tmpdir(), 'flowers-index-'));
  const react = await buildRepo(root, 'fixture-react', REACT_FILES);
  const go = await buildRepo(root, 'fixture-go', GO_FILES);
  fixture = { root, react, go };

  process.env.FLOWERS_MIRROR_TRANSPORT = 'local';
  process.env.FLOWERS_MIRROR_SSH_HOST = DEFAULT_SSH_HOST;
  process.env.FLOWERS_MIRROR_REPOS = JSON.stringify([
    { id: 'fixture-react', path: react },
    { id: 'fixture-go', path: go },
  ]);

  // 库里可能留着上一轮的行（code_index 不参与 `resetDb` 的 truncate）：先删干净。
  for (const repo of ['fixture-react', 'fixture-go']) {
    for (const sha of (await lsTreeShas(repo))) await dropIndex(db, repo, sha);
  }
  const reactHead = await head('fixture-react');
  const goHead = await head('fixture-go');
  if (!reactHead.ok || reactHead.data === null) throw new Error('夹具仓读不到 HEAD');
  if (!goHead.ok || goHead.data === null) throw new Error('夹具仓读不到 HEAD');
  reactSha = reactHead.data.sha;
  goSha = goHead.data.sha;
  await dropIndex(db, 'fixture-react', reactSha);
  await dropIndex(db, 'fixture-go', goSha);
});

/** 库里已有的 sha（清理用）：不依赖 head，直接问表。 */
async function lsTreeShas(repo: string): Promise<string[]> {
  const { sql } = await import('drizzle-orm');
  const res = await db.execute<{ sha: string }>(sql`select sha from code_index where repo = ${repo}`);
  return res.rows.map((row) => row.sha);
}

afterAll(async () => {
  await dropIndex(db, 'fixture-react', reactSha);
  await dropIndex(db, 'fixture-go', goSha);
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (fixture !== undefined) await rm(fixture.root, { recursive: true, force: true });
});

// ─── 1. 类别与噪音 ──────────────────────────────────────────────────────────

describe('分类：路径即约定', () => {
  it('页面 / 组件 / 服务 / 路由表分得清', () => {
    expect(kindOf('src/pages/Search/Search.tsx')).toBe('page');
    expect(kindOf('src/views/home/index.vue')).toBe('page');
    expect(kindOf('src/components/SearchEntrance/index.tsx')).toBe('component');
    expect(kindOf('src/services/share.ts')).toBe('service');
    expect(kindOf('src/api/user.ts')).toBe('service');
    expect(kindOf('src/stores/config.ts')).toBe('state');
    expect(kindOf('src/hooks/useSearch.ts')).toBe('state');
    expect(kindOf('src/router/router.js')).toBe('route');
    expect(kindOf('src/pages.json')).toBe('route');
    // 认不出的不进索引：类型、工具函数、配置文件不会是「这个功能在哪」的答案。
    expect(kindOf('src/types/file.ts')).toBe('other');
    expect(kindOf('main.go')).toBe('other');
  });

  it('噪音路径一个都不进索引', async () => {
    const tree = await lsTreeEntries('fixture-react');
    expect(tree.ok).toBe(true);
    if (!tree.ok) return;
    const paths = tree.data.map((entry) => entry.path);
    expect(paths).toContain('src/pages/Search/Search.tsx');
    expect(paths.some((p) => p.startsWith('dist/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect(paths.some((p) => p.endsWith('.png'))).toBe(false);

    const built = await buildIndex('fixture-react', reactSha);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(Object.keys(built.data.index.files).some((p) => p.startsWith('dist/'))).toBe(false);
    expect(built.data.index.files['src/pages/Search/Search.tsx']?.kind).toBe('page');
  });
});

// ─── 2. 路由 ────────────────────────────────────────────────────────────────

describe('路由：路由表 + 目录约定', () => {
  it('React 路由表里 path 与 component 配对，落得到文件', async () => {
    const built = await buildIndex('fixture-react', reactSha);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const search = built.data.index.routes.find((route) => route.route === '/search');
    expect(search).toBeDefined();
    expect(search?.file).toBe('src/pages/Search/Search.tsx');
    expect(search?.title).toBe('search');
  });

  it('`pages/<dir>/<name>` 约定也产出路由，`index` 取目录名', async () => {
    const built = await buildIndex('fixture-react', reactSha);
    if (!built.ok) return;
    const profile = built.data.index.routes.find((route) => route.file === 'src/pages/Profile/Profile.vue');
    expect(profile?.route).toBe('/Profile');
    // 约定只认 `pages/<dir>/<name>` 这一层：再深的子组件不造路由。
    expect(conventionRoute('pages/Search/components/Item/index.tsx')).toBeNull();
    expect(conventionRoute('pages/Search/index.tsx')).toBe('/Search');
    expect(conventionRoute('pages/Search/helpers.ts')).toBeNull();
  });
});

// ─── 3. 导入关系 ────────────────────────────────────────────────────────────

describe('导入：解析成仓内路径', () => {
  it('`@/` 别名、目录导入、相对路径都解得开', async () => {
    const built = await buildIndex('fixture-react', reactSha);
    if (!built.ok) return;
    const fromPage = built.data.index.imports['src/pages/Search/Search.tsx'] ?? [];
    expect(fromPage).toContain('src/components/SearchEntrance/index.tsx');
    expect(fromPage).toContain('src/services/share.ts');

    const files = new Set([
      'src/components/SearchEntrance/index.tsx',
      'src/services/share.ts',
      'src/pages/Search/Search.tsx',
    ]);
    expect(resolveSpecifier('@/services/share', 'src/pages/Search/Search.tsx', files))
      .toBe('src/services/share.ts');
    expect(resolveSpecifier('./x', 'src/pages/Search/Search.tsx', files)).toBeNull();
    // 外部包不进索引：`vue` 不是仓里的文件。
    expect(resolveSpecifier('vue', 'src/pages/Search/Search.tsx', files)).toBeNull();
  });
});

// ─── 4. 导出符号 ────────────────────────────────────────────────────────────

describe('导出符号', () => {
  it('函数 / 默认导出 / `<script setup>` 的顶层声明都抓得到', async () => {
    const built = await buildIndex('fixture-react', reactSha);
    if (!built.ok) return;
    const files = built.data.index.files;
    expect(files['src/services/share.ts']?.exports).toContain('searchFiles');
    expect(files['src/pages/Search/Search.tsx']?.exports).toEqual(
      expect.arrayContaining(['Search', 'SearchHeader']),
    );
    expect(files['src/components/SearchEntrance/index.tsx']?.exports).toContain('SearchEntrance');
    expect(files['src/pages/Profile/Profile.vue']?.exports).toEqual(
      expect.arrayContaining(['profile', 'loadProfile']),
    );
  });
});

// ─── 5. 定位 ────────────────────────────────────────────────────────────────

describe('locate：在索引上打分', () => {
  it('路由命中的页面排第一，导出符号命中的服务在后面，且 why 说得清', async () => {
    const built = await buildIndex('fixture-react', reactSha);
    if (!built.ok) return;
    const probes = locate(built.data.index, ['搜索', '分享', '文件']);
    expect(probes.length).toBeGreaterThan(0);
    expect(probes[0]?.path).toBe('src/pages/Search/Search.tsx');
    expect(probes[0]?.route).toBe('/search');
    expect(probes[0]?.score).toBe(19); // 路由 10 + 文件名 6 + 导出符号 3
    expect(probes[0]?.why).toContain('路由 /search');
    expect(probes[0]?.why.length).toBeGreaterThan(0);

    const serviceRank = probes.findIndex((probe) => probe.path === 'src/services/share.ts');
    expect(serviceRank).toBeGreaterThan(0); // 页面在服务之前
    // 组件被命中的路由直接 import：一跳图，分数低于页面、高于纯符号命中。
    const component = probes.find((probe) => probe.path === 'src/components/SearchEntrance/index.tsx');
    expect(component?.score).toBe(13); // 名字 6 + 被引用 4 + 导出符号 3
    expect(component?.why).toContain('直接引用');
  });

  it('通用词只在没有别的线索时才算数', async () => {
    const built = await buildIndex('fixture-react', reactSha);
    if (!built.ok) return;
    // 「文件」是通用词：只给通用词时仍然给得出候选（退回通用词那一趟）。
    const onlyGeneric = locate(built.data.index, ['文件']);
    expect(onlyGeneric.length).toBeGreaterThan(0);
    // 有非通用词时，通用词不参与：搜索页仍然是第一。
    const mixed = locate(built.data.index, ['文件', '搜索']);
    expect(mixed[0]?.path).toBe('src/pages/Search/Search.tsx');
  });
});

// ─── 6. 降级 ────────────────────────────────────────────────────────────────

describe('降级：索引为空就明说退回 grep', () => {
  it('只有 .go 的仓 → 空索引 → 调用方选 grep（不测 grep 的输出）', async () => {
    const built = await buildIndex('fixture-go', goSha);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(Object.keys(built.data.index.files)).toEqual([]);
    expect(built.data.index.routes).toEqual([]);

    const choice = locateOrFallback(built.data.index, ['搜索']);
    expect(choice.source).toBe('grep');
    if (choice.source === 'grep') expect(choice.reason).toContain('grep');

    // 有索引时走索引——哪怕候选为空（「这个功能不在这个仓」是个真答案）。
    const react = await buildIndex('fixture-react', reactSha);
    if (!react.ok) return;
    const indexed = locateOrFallback(react.data.index, ['完全不存在的词']);
    expect(indexed.source).toBe('index');
    expect(locateOrFallback(null, ['搜索']).source).toBe('grep');
  });
});

// ─── 7. 同一个 sha 不重建 ───────────────────────────────────────────────────

describe('懒建：同一个 (repo, sha) 第二次不重建', () => {
  it('读口调用次数不变，built_at 不变', async () => {
    await dropIndex(db, 'fixture-react', reactSha);
    let trees = 0;
    let shows = 0;
    const counting: IndexDeps = {
      lsTreeEntries: (...args) => {
        trees += 1;
        return LIVE_INDEX_DEPS.lsTreeEntries(...args);
      },
      showHeads: (...args) => {
        shows += 1;
        return LIVE_INDEX_DEPS.showHeads(...args);
      },
    };

    const first = await repoIndex(db, 'fixture-react', reactSha, { deps: counting });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.built).toBe(true);
    expect(trees).toBe(1);
    expect(shows).toBe(1);
    const builtAt = first.data.index.builtAt;

    const second = await repoIndex(db, 'fixture-react', reactSha, { deps: counting });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.built).toBe(false);
    expect(second.data.buildMs).toBe(0);
    expect(trees).toBe(1); // 一次都没多发
    expect(shows).toBe(1);
    expect(second.data.index.builtAt).toBe(builtAt);

    const stored = await readIndex(db, 'fixture-react', reactSha);
    expect(stored?.builtAt).toBe(builtAt);
    expect(stored?.routes.length).toBe(2);
  });

  it('建一次是两次往返：一次 ls-tree、一次批量 show（不是每文件一趟）', async () => {
    await dropIndex(db, 'fixture-react', reactSha);
    let calls = 0;
    const counting: IndexDeps = {
      lsTreeEntries: (...args) => {
        calls += 1;
        return LIVE_INDEX_DEPS.lsTreeEntries(...args);
      },
      showHeads: (repo, entries, opts) => {
        calls += 1;
        // 五个源码文件必须是**一批**读回来的。
        expect(entries.length).toBeGreaterThanOrEqual(5);
        return showHeads(repo, entries, opts);
      },
    };
    const built = await repoIndex(db, 'fixture-react', reactSha, { deps: counting });
    expect(built.ok).toBe(true);
    expect(calls).toBe(2);
  });
});

// ─── 附带：extractIndex 是纯函数（不碰镜像也能验规则） ───────────────────────

describe('extractIndex：纯函数', () => {
  it('只给文件头部就能拼出三张表', () => {
    const index = extractIndex({
      repo: 'pure',
      sha: 'f'.repeat(40),
      all: ['src/pages/A/A.tsx', 'src/components/B/index.tsx', 'src/pages/B/B.tsx'],
      sources: [
        {
          path: 'src/pages/A/A.tsx',
          size: 10,
          text: "import B from '@/components/B';\nexport default function A() { return <B />; }\n",
        },
        { path: 'src/components/B/index.tsx', size: 10, text: 'export default 1;\n' },
        { path: 'src/pages/B/B.tsx', size: 10, text: 'export default 1;\n' },
      ],
      builtAt: '2026-01-01T00:00:00.000Z',
    });
    expect(index.builtAt).toBe('2026-01-01T00:00:00.000Z');
    expect(index.imports['src/pages/A/A.tsx']).toEqual(['src/components/B/index.tsx']);
    expect(index.files['src/components/B/index.tsx']?.kind).toBe('component');
    expect(classifyKind('src/pages/A/A.tsx')).toBe('page');
    expect(index.routes.map((route) => route.route)).toEqual(['/A', '/B']);
  });
});
