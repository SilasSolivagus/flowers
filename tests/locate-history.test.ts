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
  process.env.FLOWERS_MIRROR_REPOS = JSON.stringify([{ id: `file://${bare}`, path: bare }]);
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
    process.env.FLOWERS_MIRROR_REPOS = JSON.stringify([
      { id: `file://${bare}`, path: bare },
      { id: `file://${plain}`, path: plain },
    ]);

    const res = await mergeHistory(`file://${plain}`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual([]);
  });
});
