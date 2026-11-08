import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SSH_HOST, GIT_TIMEOUT_MS, gitArgv, grep, head, isNoisePath, isReadOnlyGitArgs,
  listRepos, lsTree, parseRepos, resolveMirrorConfig, show, truncateUtf8,
} from '../src/core/codemirror/mirror.js';
import { SHAPE_CAPS, classifyPath, repoShape } from '../src/core/codemirror/route.js';

/**
 * P3.1：走查的只读层。
 *
 * **一条 ssh 都不发、一张表都不读。** 夹具是当场 `git init --bare` 出来、当场 push
 * 进去的一个真仓（不是 mock 的 git 输出）：这样测的是真实的 `execFile`、真实的
 * 退出码、真实的 `git grep` 输出格式与真实的 UTF-8 截断。三件不真实的事都在配置
 * 那一层：仓库列表用环境变量给、ssh 主机名是一个 `.invalid` 域、以及那个跳过标记
 * 的 live 用例（`FLOWERS_MIRROR_SSH_HOST` 设了才会碰 owner 的机器）。
 *
 * 要钉住的是六件事：
 * 1. `lsTree` 里没有 `dist/`、`node_modules/`、`.asar`、锁文件、图片；
 * 2. `grep` 找得到源码里的中文，且**不**把 `.asar` 里的同一句带回来；
 * 3. `show` 读得到全文、读不到不存在的路径、超过上限时带一句截断标记；
 * 4. `head` 给出那个提交的 sha / 时间 / 标题；
 * 5. `repoShape` 分得清页面 / 接口 / 组件，且上限与截断标志一致；
 * 6. 未知仓库、坏 transport、连不上的 ssh 都给**中文失败**，一个都不抛。
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

/** 夹具里的源码文件：每条路径都在测一个分类或一条噪音规则。 */
const FIXTURE_FILES: Record<string, string> = {
  'src/router/router.js': [
    "import Login from '../pages/Login/login';",
    'export const routes = [',
    "  { path: '/login', component: 'pages/Login/login' },",
    "  { path: '/share', component: 'pages/Share/share' },",
    '];',
  ].join('\n'),
  'pages/Home/Home.tsx': "export default function Home() {\n  return <p>分享链接</p>;\n}\n",
  'api/user.ts': "export async function getUser(id: string) {\n  return fetch(`/api/user/${id}`);\n}\n",
  'src/i18n/zh.ts': "export const share = '分享链接';\nexport const copy = '复制链接';\n",
  'components/Button.tsx': "export function Button({ label }: { label: string }) {\n  return <button>{label}</button>;\n}\n",
  // 噪音：三个仓里真实存在的形状
  'dist/bundle.js': '(()=>{const share="分享链接"})();\n',
  'node_modules/x/index.js': 'module.exports = "分享链接";\n',
  'web-file/frontend/dist/web.asar': 'asar-header 分享链接 asar-footer\n',
  'public/logo.png': 'share-link-png',
  'yarn.lock': '# yarn lockfile v1\n"分享链接@^1.0.0":\n  version "1.0.0"\n',
};

const PAGE_CAP_FILES = SHAPE_CAPS.pages + 12; // 让 pages 一定超过上限

const COMMIT_SUBJECT = 'fixture: 走查用的最小仓';

type Fixture = { root: string; bare: string };

async function buildFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'flowers-mirror-'));
  const work = path.join(root, 'work');
  const bare = path.join(root, 'fixture.git');
  await mkdir(work, { recursive: true });

  for (const [name, content] of Object.entries(FIXTURE_FILES)) {
    const file = path.join(work, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  }
  // 页面多到超过上限：证明「截断」是一个真实的标志，不是一句注释。
  for (let i = 0; i < PAGE_CAP_FILES; i += 1) {
    const id = `P${String(i + 1).padStart(3, '0')}`;
    const file = path.join(work, 'pages', id, `${id}.tsx`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `export default function ${id}() {\n  return <div>${id}</div>;\n}\n`, 'utf8');
  }

  await gitCmd(work, ['init', '-q']);
  await gitCmd(work, ['add', '-A']);
  await gitCmd(work, ['commit', '-q', '-m', COMMIT_SUBJECT]);
  // bare 仓的 HEAD 必须指向 master：`git init --bare -b` 从 2.28 起才有，
  // 这里直接 symbolic-ref，任何 git 版本都一样。
  await gitCmd(root, ['init', '--bare', '-q', bare]);
  await gitCmd(bare, ['symbolic-ref', 'HEAD', 'refs/heads/master']);
  await gitCmd(work, ['push', '-q', bare, 'HEAD:refs/heads/master']);
  return { root, bare };
}

// ─── 环境 ────────────────────────────────────────────────────────────────────

const ENV_KEYS = ['FLOWERS_MIRROR_TRANSPORT', 'FLOWERS_MIRROR_REPOS', 'FLOWERS_MIRROR_SSH_HOST'] as const;
const savedEnv = new Map<string, string | undefined>();
let fixture: Fixture;

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** 默认那一份：本地传输 + 一个仓库 + 主机名（给了它就不必读库）。 */
function useFixtureEnv(): void {
  setEnv({
    FLOWERS_MIRROR_TRANSPORT: 'local',
    FLOWERS_MIRROR_REPOS: JSON.stringify([{ id: 'fixture', path: fixture.bare }]),
    FLOWERS_MIRROR_SSH_HOST: DEFAULT_SSH_HOST,
  });
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  fixture = await buildFixture();
  useFixtureEnv();
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (fixture !== undefined) await rm(fixture.root, { recursive: true, force: true });
});

// ─── 噪音过滤 ────────────────────────────────────────────────────────────────

describe('isNoisePath：三个仓里真实存在的形状', () => {
  it('构建产物、依赖目录、二进制、锁文件都算噪音', () => {
    expect(isNoisePath('web-file/frontend/dist/web.asar')).toBe(true);
    expect(isNoisePath('dist/bundle.js')).toBe(true);
    expect(isNoisePath('build/main.js')).toBe(true);
    expect(isNoisePath('out/index.html')).toBe(true);
    expect(isNoisePath('node_modules/x/index.js')).toBe(true);
    expect(isNoisePath('assets/logo.png')).toBe(true);
    expect(isNoisePath('yarn.lock')).toBe(true);
    expect(isNoisePath('package-lock.json')).toBe(true);
    expect(isNoisePath('src/app.min.js')).toBe(true);
    expect(isNoisePath('src/app.js.map')).toBe(true);
  });

  it('源码不算噪音（build.js 是文件不是目录）', () => {
    expect(isNoisePath('src/router/router.js')).toBe(false);
    expect(isNoisePath('pages/Home/Home.tsx')).toBe(false);
    expect(isNoisePath('scripts/build.js')).toBe(false);
    expect(isNoisePath('src/i18n/zh.ts')).toBe(false);
  });

  /**
   * Go 生态的三条（2026-11-09，接 79 个仓之前）。
   *
   * 这三条的共同点：它们都**不是源码目录**，但里面的文件扩展名与源码一模一样
   * （`.go`），所以只靠 `CODE_EXT` 挡不住 —— `vendor/gorm.io/gorm/chainable_api.go`
   * 会被当成 `service`，`testdata/broken.go` 会被当成产品能力。
   */
  it('vendor / third_party / testdata 算噪音（Go 仓的依赖与夹具）', () => {
    // 依赖目录：go mod vendor 的产物，一仓能到几万条
    expect(isNoisePath('vendor/gorm.io/gorm/chainable_api.go')).toBe(true);
    expect(isNoisePath('vendor/modules.txt')).toBe(true);
    // 多模块仓的按模块 vendoring：`cmd/<bin>/vendor/` 也成立
    expect(isNoisePath('cmd/apisrv/vendor/github.com/gin-gonic/gin/gin.go')).toBe(true);
    // 第三方源码（Bazel 风格）
    expect(isNoisePath('third_party/protobuf/any.go')).toBe(true);
    // Go 工具链约定的测试数据目录（go build / go vet 都跳过它）
    expect(isNoisePath('service/testdata/case1.go')).toBe(true);
    expect(isNoisePath('testdata/expected.json')).toBe(true);
  });

  it('名字像但不该误伤：vendored.go / testdata.go 是文件，不是目录', () => {
    // 目录判定只看**非最后一段**：同一条规则在 `build.js` 上已经证明过一次。
    expect(isNoisePath('service/vendored.go')).toBe(false);
    expect(isNoisePath('service/testdata.go')).toBe(false);
    expect(isNoisePath('library/third_party.go')).toBe(false);
    // `vendorinfo/` 不是 `vendor/`（整段匹配，不是前缀匹配）
    expect(isNoisePath('library/vendorinfo/vendor.go')).toBe(false);
  });
});

// ─── lsTree ──────────────────────────────────────────────────────────────────

describe('lsTree', () => {
  it('列出源码，一个噪音路径都不带', async () => {
    const tree = await lsTree('fixture');
    expect(tree.ok).toBe(true);
    if (!tree.ok) return;
    const files = tree.data;
    expect(files).toContain('src/router/router.js');
    expect(files).toContain('pages/Home/Home.tsx');
    expect(files).toContain('api/user.ts');
    expect(files).toContain('src/i18n/zh.ts');
    expect(files).toContain('components/Button.tsx');
    expect(files).not.toContain('dist/bundle.js');
    expect(files).not.toContain('node_modules/x/index.js');
    expect(files).not.toContain('web-file/frontend/dist/web.asar');
    expect(files).not.toContain('public/logo.png');
    expect(files).not.toContain('yarn.lock');
    expect(files.every((name) => !isNoisePath(name))).toBe(true);
    expect(files).toHaveLength(PAGE_CAP_FILES + Object.keys(FIXTURE_FILES).length - 5);
  });

  it('prefix 只回一个子树', async () => {
    const tree = await lsTree('fixture', { prefix: 'src' });
    expect(tree.ok).toBe(true);
    if (!tree.ok) return;
    expect(tree.data).toContain('src/router/router.js');
    expect(tree.data.every((name) => name.startsWith('src/'))).toBe(true);
  });
});

// ─── grep ────────────────────────────────────────────────────────────────────

describe('grep', () => {
  it('找得到源码里的中文，且 .asar 里的同一句不会回来', async () => {
    const hits = await grep('fixture', '分享链接');
    expect(hits.ok).toBe(true);
    if (!hits.ok) return;
    const paths = hits.data.map((hit) => hit.path);
    expect(paths).toContain('src/i18n/zh.ts');
    expect(paths).toContain('pages/Home/Home.tsx');
    expect(paths).not.toContain('web-file/frontend/dist/web.asar');
    expect(paths).not.toContain('dist/bundle.js');
    expect(hits.data.every((hit) => !isNoisePath(hit.path))).toBe(true);
    const zh = hits.data.find((hit) => hit.path === 'src/i18n/zh.ts');
    expect(zh?.line).toBe(1);
    expect(zh?.text).toContain('分享链接');
  });

  it('paths 收窄范围；没命中是空数组，不是失败', async () => {
    const scoped = await grep('fixture', '分享链接', { paths: ['api'] });
    expect(scoped.ok).toBe(true);
    if (scoped.ok) expect(scoped.data).toHaveLength(0);

    const miss = await grep('fixture', '这句话不存在于任何文件');
    expect(miss.ok).toBe(true);
    if (miss.ok) expect(miss.data).toHaveLength(0);
  });

  it('max 截断结果（预算不会被噪音吃掉）', async () => {
    const capped = await grep('fixture', '分享链接', { max: 1 });
    expect(capped.ok).toBe(true);
    if (capped.ok) expect(capped.data.length).toBeLessThanOrEqual(1);
  });
});

// ─── show ────────────────────────────────────────────────────────────────────

describe('show', () => {
  it('返回文件原文', async () => {
    const text = await show('fixture', 'src/router/router.js');
    expect(text.ok).toBe(true);
    if (text.ok) {
      expect(text.data).toContain('pages/Login/login');
      expect(text.data).toContain('routes');
    }
  });

  it('不存在的路径是中文的类型化失败，不是异常', async () => {
    const missing = await show('fixture', 'src/nope.ts');
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe('git_failed');
      expect(missing.message).toContain('没有这个文件');
      expect(missing.message).toContain('src/nope.ts');
    }
  });

  it('绝对路径与 .. 在到达 git 之前就被拒', async () => {
    for (const bad of ['/etc/passwd', '../secrets.ts', 'src/../../x.ts', 'HEAD:src/i18n/zh.ts']) {
      const result = await show('fixture', bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('bad_path');
    }
  });

  it('maxBytes 之后截断并写明（中文不被切成替换符）', async () => {
    const full = await show('fixture', 'src/i18n/zh.ts');
    expect(full.ok).toBe(true);
    if (!full.ok) return;

    const cut = await show('fixture', 'src/i18n/zh.ts', { maxBytes: 16 });
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.data.length).toBeLessThan(full.data.length);
    expect(cut.data).toContain('已截断');
    expect(cut.data).toContain('16 字节');
    expect(cut.data).not.toContain('\ufffd');
    expect(cut.data.startsWith(full.data.slice(0, 3))).toBe(true);
  });
});

describe('truncateUtf8', () => {
  it('切在汉字中间时退到字符边界', () => {
    const buffer = Buffer.from('分享链接分享链接', 'utf8');
    const text = truncateUtf8(buffer, 7);
    expect(text).toBe('分享');
    expect(text).not.toContain('\ufffd');
  });
});

// ─── head ────────────────────────────────────────────────────────────────────

describe('head', () => {
  it('给出那个提交的 sha / 时间 / 标题', async () => {
    const info = await head('fixture');
    expect(info.ok).toBe(true);
    if (!info.ok || info.data === null) throw new Error('head 应该有那个提交');
    const expected = (await gitCmd(fixture.bare, ['rev-parse', 'HEAD'])).trim();
    expect(info.data.sha).toBe(expected);
    expect(info.data.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(info.data.subject).toBe(COMMIT_SUBJECT);
    expect(info.data.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ─── repoShape ───────────────────────────────────────────────────────────────

describe('repoShape', () => {
  it('分类正确，且上限与截断标志一致', async () => {
    const shape = await repoShape('fixture');
    expect(shape.ok).toBe(true);
    if (!shape.ok) return;

    // 树序是字典序，`src/router/router.js` 排在第 121 个之后——所以它**不在**
    // 这个被截到 120 条的表里（这正是 truncated.pages 要说明的事）。它作为
    // 「页面」的身份由 classifyPath 那条用例钉住。
    expect(shape.data.pages).toContain('pages/Home/Home.tsx');
    expect(shape.data.pages).toContain('pages/P001/P001.tsx');
    expect(shape.data.pages).not.toContain('src/router/router.js');
    expect(shape.data.pages).not.toContain('api/user.ts');
    expect(shape.data.api).toContain('api/user.ts');
    expect(shape.data.components).toContain('components/Button.tsx');

    // 上限：页面超了（132 个），被截到 120 并且如实标记。
    expect(shape.data.pages).toHaveLength(SHAPE_CAPS.pages);
    expect(shape.data.truncated.pages).toBe(true);
    expect(shape.data.api.length).toBeLessThanOrEqual(SHAPE_CAPS.api);
    expect(shape.data.truncated.api).toBe(false);
    expect(shape.data.components.length).toBeLessThanOrEqual(SHAPE_CAPS.components);
    expect(shape.data.caps).toEqual({ ...SHAPE_CAPS });

    // totalFiles 数的是去噪音之后的文件
    const tree = await lsTree('fixture');
    expect(tree.ok).toBe(true);
    if (tree.ok) expect(shape.data.totalFiles).toBe(tree.data.length);
    // 两张表不重叠：一条路径只会被归到一类
    const all = [...shape.data.pages, ...shape.data.api, ...shape.data.components];
    expect(new Set(all).size).toBe(all.length);
  });

  it('classifyPath 认三种布局（React / uni-app / 通用）', () => {
    expect(classifyPath('src/router/router.js')).toBe('page');
    expect(classifyPath('pages/Home/Home.tsx')).toBe('page');
    expect(classifyPath('pages.json')).toBe('page');
    expect(classifyPath('views/report/Index.vue')).toBe('page');
    expect(classifyPath('src/app/dashboard/page.tsx')).toBe('page');
    expect(classifyPath('api/user.ts')).toBe('api');
    expect(classifyPath('src/services/order.ts')).toBe('api');
    expect(classifyPath('src/utils/request.js')).toBe('api');
    expect(classifyPath('components/Button.tsx')).toBe('component');
    expect(classifyPath('src/widgets/card.tsx')).toBe('component');
    expect(classifyPath('src/utils/date.ts')).toBeNull();
    // 样式表不算「页面」：真实仓里 `pages/**/index.less` 与页面同目录。
    expect(classifyPath('src/pages/Login/index.less')).toBeNull();
    expect(classifyPath('pages/Home/Home.css')).toBeNull();
  });
});

// ─── 失败都是中文数据 ────────────────────────────────────────────────────────

describe('配置与失败', () => {
  it('未知仓库 id', async () => {
    const tree = await lsTree('nope');
    expect(tree.ok).toBe(false);
    if (!tree.ok) {
      expect(tree.code).toBe('unknown_repo');
      expect(tree.message).toContain('未知的镜像仓库');
      expect(tree.message).toContain('fixture');
    }
  });

  it('坏 transport 点名是哪一格', async () => {
    setEnv({
      FLOWERS_MIRROR_TRANSPORT: 'ftp',
      FLOWERS_MIRROR_REPOS: JSON.stringify([{ id: 'fixture', path: fixture.bare }]),
      FLOWERS_MIRROR_SSH_HOST: DEFAULT_SSH_HOST,
    });
    const repos = await listRepos();
    expect(repos.ok).toBe(false);
    if (!repos.ok) {
      expect(repos.code).toBe('bad_config');
      // env 这一层报的是环境变量名；设置那一层报的是键名（见下一条用例）。
      expect(repos.message).toContain('FLOWERS_MIRROR_TRANSPORT');
      expect(repos.message).toContain('ftp');
    }
    useFixtureEnv();
  });

  it('设置里的坏 transport 点名 code.mirror.transport', async () => {
    setEnv({
      FLOWERS_MIRROR_REPOS: JSON.stringify([{ id: 'fixture', path: fixture.bare }]),
      FLOWERS_MIRROR_SSH_HOST: DEFAULT_SSH_HOST,
    });
    // 所有设置都读回 'ftp'：走的是 settings 那一层，报的应当是键名而不是 env 名。
    const ftpDb = { execute: async () => ({ rows: [{ value: 'ftp' }] }) } as unknown as Parameters<typeof resolveMirrorConfig>[0];
    const config = await resolveMirrorConfig(ftpDb);
    expect(config.ok).toBe(false);
    if (!config.ok) {
      expect(config.code).toBe('bad_config');
      expect(config.message).toContain('code.mirror.transport');
      expect(config.message).toContain('ftp');
    }
    useFixtureEnv();
  });

  it('缺 repos 时说清该填哪个键、哪个环境变量', async () => {
    setEnv({
      FLOWERS_MIRROR_TRANSPORT: 'local',
      FLOWERS_MIRROR_SSH_HOST: DEFAULT_SSH_HOST,
    });
    // 一个什么都不返回的库句柄：不碰真库，也保证走的是「没有这一行」那条路。
    const emptyDb = { execute: async () => ({ rows: [] }) } as unknown as Parameters<typeof resolveMirrorConfig>[0];
    const config = await resolveMirrorConfig(emptyDb);
    expect(config.ok).toBe(false);
    if (!config.ok) {
      expect(config.code).toBe('bad_config');
      expect(config.message).toContain('code.mirror.repos');
      expect(config.message).toContain('FLOWERS_MIRROR_REPOS');
    }
    useFixtureEnv();
  });

  it('repos 配置坏了整份作废（不拼半份）', () => {
    const notJson = parseRepos('{oops', 'env');
    expect(notJson.ok).toBe(false);
    const noId = parseRepos('[{"path":"/srv/x.git"}]', 'env');
    expect(noId.ok).toBe(false);
    if (!noId.ok) expect(noId.message).toContain('缺 id');
    const relative = parseRepos('[{"id":"x","path":"srv/x.git"}]', 'env');
    expect(relative.ok).toBe(false);
    if (!relative.ok) expect(relative.message).toContain('绝对路径');
    const dup = parseRepos('[{"id":"x","path":"/srv/a.git"},{"id":"x","path":"/srv/b.git"}]', 'env');
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.message).toContain('两次');
  });

  it('连不上的 ssh 是一句中文失败，不是异常', async () => {
    setEnv({
      FLOWERS_MIRROR_TRANSPORT: 'ssh',
      FLOWERS_MIRROR_REPOS: JSON.stringify([{ id: 'fixture', path: '/srv/123pan-mirror/123pan-pc.git' }]),
      FLOWERS_MIRROR_SSH_HOST: 'flowers-test.invalid',
    });
    const started = Date.now();
    const tree = await lsTree('fixture');
    expect(tree.ok).toBe(false);
    if (!tree.ok) {
      expect(['git_failed', 'timeout']).toContain(tree.code);
      expect(tree.message).toContain('ssh');
      // stderr 的尾巴要跟着回来：真正的原因（域名解析不了）不能被吞掉。
      expect(tree.message.length).toBeGreaterThan(10);
    }
    expect(Date.now() - started).toBeLessThan(GIT_TIMEOUT_MS + 5000);
    useFixtureEnv();
  });
});

// ─── argv 形状与只读白名单 ──────────────────────────────────────────────────

describe('argv 与只读白名单', () => {
  it('本地与远端都是 argv 数组，没有 shell', () => {
    const local = gitArgv({ transport: 'local', sshHost: DEFAULT_SSH_HOST }, '/srv/x.git', ['ls-tree', 'HEAD']);
    expect(local).toEqual(['git', '--git-dir=/srv/x.git', 'ls-tree', 'HEAD']);

    const remote = gitArgv({ transport: 'ssh', sshHost: 'dogyun' }, '/srv/x.git', ['show', 'HEAD:a b.ts']);
    expect(remote[0]).toBe('ssh');
    expect(remote).toContain('BatchMode=yes');
    expect(remote).toContain('dogyun');
    expect(remote.slice(-4)).toEqual(['git', '--git-dir=/srv/x.git', 'show', 'HEAD:a b.ts']);
  });

  it('写命令与 --output 一律拒绝', () => {
    expect(isReadOnlyGitArgs(['ls-tree', '-r', 'HEAD'])).toBe(true);
    expect(isReadOnlyGitArgs(['grep', '-n', '-e', 'x', 'HEAD'])).toBe(true);
    for (const bad of [
      ['checkout', 'master'],
      ['update-ref', 'refs/heads/x', 'HEAD'],
      ['push', 'origin', 'master'],
      ['gc'],
      ['show', '--output=/tmp/x', 'HEAD:a'],
      ['log', '--output=/tmp/x'],
      ['reset', '--hard'],
    ]) {
      expect(isReadOnlyGitArgs(bad)).toBe(false);
    }
  });

  it('本模块真的只有那四个读口', async () => {
    const repos = await listRepos();
    expect(repos.ok).toBe(true);
    if (repos.ok) expect(repos.data).toEqual([{ id: 'fixture', path: fixture.bare }]);
  });
});

// ─── live smoke：默认跳过，只有人显式点了才碰 owner 的机器 ──────────────────

const LIVE_HOST = process.env.FLOWERS_MIRROR_SSH_HOST;

/**
 * 这个用例**只在** `FLOWERS_MIRROR_SSH_HOST` 由人显式设成（例如 `dogyun`）时才跑：
 * CI 没有那条环境变量，因此永远不会 ssh 到 47.115.229.192。跑它不是「跑测试」，
 * 是一次人工检查——所以它同时打印读到的 HEAD，方便对着服务器上的 git log 核。
 */
describe.skipIf(LIVE_HOST === undefined || LIVE_HOST === '')('live smoke：真实 dogyun 镜像', () => {
  it('能读到 123pan-pc 的 HEAD、路由文件与一次中文 grep', async () => {
    setEnv({
      FLOWERS_MIRROR_TRANSPORT: 'ssh',
      FLOWERS_MIRROR_REPOS: JSON.stringify([
        { id: '123pan-pc', path: '/srv/123pan-mirror/123pan-pc.git' },
        { id: '123pan-uni-app', path: '/srv/123pan-mirror/123pan-uni-app.git' },
        { id: '123pan-cross-frontend', path: '/srv/123pan-mirror/123pan-cross-frontend.git' },
      ]),
      FLOWERS_MIRROR_SSH_HOST: LIVE_HOST as string,
    });

    const info = await head('123pan-pc');
    expect(info.ok).toBe(true);
    if (info.ok && info.data !== null) console.log('live head:', info.data.sha, info.data.subject);

    const routes = await show('123pan-pc', 'src/router/router.js');
    expect(routes.ok).toBe(true);
    if (routes.ok) expect(routes.data).toContain('pages/');

    const hits = await grep('123pan-pc', '分享链接', { max: 20 });
    expect(hits.ok).toBe(true);
    if (hits.ok) {
      expect(hits.data.every((hit) => !isNoisePath(hit.path))).toBe(true);
      console.log('live grep 命中:', hits.data.map((hit) => hit.path).join(', '));
    }

    const shape = await repoShape('123pan-pc');
    expect(shape.ok).toBe(true);
    if (shape.ok) {
      expect(shape.data.pages.length).toBeGreaterThan(0);
      console.log('live shape:', shape.data.totalFiles, 'files;', shape.data.pages.length, 'pages');
    }
  });
});
