import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_SSH_HOST, mergeHistory } from '../src/core/codemirror/mirror.js';

const git = (cwd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });

/** 同一条 git，但把作者/提交者时间钉死——`--since` 的边界得靠真日期来验。 */
const gitWhen = (cwd: string, args: string[], iso: string) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } },
      (error, stdout) => {
        if (error) reject(error); else resolve(stdout);
      },
    );
  });

let root = '';
let bare = '';

/**
 * 环境：**本地传输 + 把 `file://` URL 本身当仓库 id**。
 *
 * `resolveRepo` 只认配置里出现过的 id（这是对的：仓库列表是配置，不是探测），
 * 而 `id` 的合法性只看「非空的唯一字符串」——所以用例把 `file://<bare>` 这个 URL
 * 原样登记成 id，既保住了「调用方传 URL」的形状，又一条 ssh 都不发、一张表都不读。
 * `FLOWERS_MIRROR_SSH_HOST` 也给上：给了它就不必回落去读 `app_settings`。
 */
const ENV_KEYS = ['FLOWERS_MIRROR_TRANSPORT', 'FLOWERS_MIRROR_REPOS', 'FLOWERS_MIRROR_SSH_HOST'] as const;
const savedEnv = new Map<string, string | undefined>();

/** 登记一个仓库（id 就是 `file://` URL）并立刻写进环境变量。 */
const registered = new Map<string, string>();
function register(id: string, repoPath: string): string {
  registered.set(id, repoPath);
  process.env.FLOWERS_MIRROR_REPOS = JSON.stringify(
    [...registered].map(([key, value]) => ({ id: key, path: value })),
  );
  return id;
}

/** 造一个真仓：主干一次、特性分支一次、合并一次。**不发 ssh。** */
beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

  root = await mkdtemp(path.join(tmpdir(), 'flowers-history-'));
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  await git(work, ['init', '-q', '-b', 'master']);
  await git(work, ['config', 'user.email', 'dev@example.com']);
  await git(work, ['config', 'user.name', 'dev']);
  await git(work, ['config', 'commit.gpgsign', 'false']);

  await writeFile(path.join(work, 'README.md'), 'base\n');
  await git(work, ['add', '.']);
  await git(work, ['commit', '-q', '-m', 'chore: init']);

  await git(work, ['checkout', '-q', '-b', 'feat-userEquity-fjd']);
  await mkdir(path.join(work, 'src/pages/video'), { recursive: true });
  await writeFile(path.join(work, 'src/pages/video/video.vue'), '<template/>\n');
  await git(work, ['add', '.']);
  await git(work, ['commit', '-q', '-m', 'feat: 用户权益缩减']);
  await git(work, ['commit', '-q', '--allow-empty', '-m', 'feat: 弹窗文案调整']);

  await git(work, ['checkout', '-q', 'master']);
  await git(work, ['merge', '-q', '--no-ff', 'feat-userEquity-fjd', '-m', 'Merge #1 into master from feat-userEquity-fjd']);

  bare = path.join(root, 'mirror.git');
  await git(root, ['clone', '-q', '--bare', work, bare]);

  process.env.FLOWERS_MIRROR_TRANSPORT = 'local';
  process.env.FLOWERS_MIRROR_SSH_HOST = DEFAULT_SSH_HOST;
  registered.clear();
  register(`file://${bare}`, bare);
});
afterAll(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (root !== '') await rm(root, { recursive: true, force: true });
});

describe('mergeHistory：一次合并 = 一条记录', () => {
  it('取回分支名、两条中文提交信息、以及这次合并动过的文件', async () => {
    const res = await mergeHistory(`file://${bare}`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(1);
    const [m] = res.data;
    expect(m!.branch).toBe('feat-userEquity-fjd');
    expect(m!.message).toContain('用户权益缩减');
    expect(m!.message).toContain('弹窗文案调整');
    expect(m!.files).toEqual(['src/pages/video/video.vue']);
    expect(m!.mergedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('仓里没有合并提交 → 空数组，不是错误', async () => {
    // 一个**真**没有合并的仓（单条提交）：`git rev-list --merges` 什么都不吐，
    // 那必须是 `[]`，不是失败。从 `work` 克隆不行——它已经带着上面那次合并了。
    const solo = path.join(root, 'solo');
    await mkdir(solo, { recursive: true });
    await git(solo, ['init', '-q', '-b', 'master']);
    await git(solo, ['config', 'commit.gpgsign', 'false']);
    await writeFile(path.join(solo, 'index.ts'), 'export {};\n');
    await git(solo, ['add', '.']);
    await git(solo, ['-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-q', '-m', 'chore: init']);

    const plain = path.join(root, 'plain.git');
    await git(root, ['clone', '-q', '--bare', solo, plain]);
    // 新仓要登记进仓库列表（与 beforeAll 里同一条约定：`file://` URL 当 id）。
    register(`file://${plain}`, plain);

    const res = await mergeHistory(`file://${plain}`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual([]);
  });

  // ─── 失败与增量：脚本里的 git 出错**不能**被静默成「空历史」 ────────────────
  //
  // 这一组的存在原因：`git rev-list … | while read` 的退出码是**管道最后一个命令**
  // 的，rev-list 失败会被吞掉，于是「路径配错 / 镜像没建好 / --since 拆错」全都
  // 变成 `ok([])`。Task 3 会把它当「这个仓没有合并」写进库——错得看不出来。
  // 四个用例在修好之前**全部**应当是红的。

  it('路径不是 git 仓库 → 中文失败，不是 ok([])', async () => {
    const notRepo = path.join(root, 'not-a-repo');
    await mkdir(notRepo, { recursive: true });
    await writeFile(path.join(notRepo, 'README.md'), '这不是仓库\n');
    register(`file://${notRepo}`, notRepo);

    const res = await mergeHistory(`file://${notRepo}`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('git_failed');
    // 报错要点名是哪个仓——owner 见过太多「读取失败」而不知道是哪一个。
    expect(res.message).toContain(notRepo);
  });

  it('since 不合法 → 失败（而不是把全部合并都当「比它新」）', async () => {
    const res = await mergeHistory(`file://${bare}`, { since: 'garbage-date' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('bad_config');
    expect(res.message).toContain('garbage-date');
  });

  it('since 带空格 → 仍然取到（不能被 shell 拆成两个参数）', async () => {
    const res = await mergeHistory(`file://${bare}`, { since: '2026-01-01 00:00:00' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(1);
  });

  it('since 真的过滤：只留比边界新的合并，且是全量的子集', async () => {
    const dated = path.join(root, 'dated');
    await mkdir(dated, { recursive: true });
    await git(dated, ['init', '-q', '-b', 'master']);
    await git(dated, ['config', 'user.email', 'dev@example.com']);
    await git(dated, ['config', 'user.name', 'dev']);
    await git(dated, ['config', 'commit.gpgsign', 'false']);
    await writeFile(path.join(dated, 'README.md'), 'base\n');
    await git(dated, ['add', '.']);
    await gitWhen(dated, ['commit', '-q', '-m', 'chore: init'], '2023-01-01T00:00:00+08:00');

    // 旧合并：2024 年。
    await git(dated, ['checkout', '-q', '-b', 'feat-old']);
    await writeFile(path.join(dated, 'old.ts'), 'export {};\n');
    await git(dated, ['add', '.']);
    await gitWhen(dated, ['commit', '-q', '-m', 'feat: 旧功能'], '2024-06-01T00:00:00+08:00');
    await git(dated, ['checkout', '-q', 'master']);
    await gitWhen(dated, ['merge', '-q', '--no-ff', 'feat-old', '-m', 'Merge #1 into master from feat-old'], '2024-06-02T00:00:00+08:00');

    // 新合并：2025 年。
    await git(dated, ['checkout', '-q', '-b', 'feat-new']);
    await writeFile(path.join(dated, 'new.ts'), 'export {};\n');
    await git(dated, ['add', '.']);
    await gitWhen(dated, ['commit', '-q', '-m', 'feat: 新功能'], '2025-06-01T00:00:00+08:00');
    await git(dated, ['checkout', '-q', 'master']);
    await gitWhen(dated, ['merge', '-q', '--no-ff', 'feat-new', '-m', 'Merge #2 into master from feat-new'], '2025-06-02T00:00:00+08:00');

    const datedBare = path.join(root, 'dated.git');
    await git(root, ['clone', '-q', '--bare', dated, datedBare]);
    register(`file://${datedBare}`, datedBare);

    const all = await mergeHistory(`file://${datedBare}`);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.data).toHaveLength(2);

    // 边界带空格：既是过滤用例，也是「$2 必须被引用」的用例。
    const inc = await mergeHistory(`file://${datedBare}`, { since: '2025-01-01 00:00:00' });
    expect(inc.ok).toBe(true);
    if (!inc.ok) return;
    expect(inc.data).toHaveLength(1);
    const [only] = inc.data;
    expect(only!.branch).toBe('feat-new');
    expect(only!.mergedAt >= '2025-01-01').toBe(true);
    // 增量必须是全量的子集：否则「缺就补」会把两条不同的合并混成一条。
    expect(all.data.some((row) => row.sha === only!.sha)).toBe(true);
  });
});
