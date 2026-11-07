import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_SSH_HOST, mergeHistory } from '../src/core/codemirror/mirror.js';
import { db } from '../src/db/client.js';
import {
  grams, isFeatureMerge, locateFromHistory, mergeWeight, rankMerges,
} from '../src/core/locate/history.js';
import {
  ensureHistory, readHistory, sinceFor, validateMerges, type FetchMerges, type HistoryRow,
} from '../src/core/locate/history-store.js';

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

// ─── 落库：commit_history 与增量 ─────────────────────────────────────────────
//
// Task 2 修的是「镜像坏了要报失败」；这一段钉的是**接下来那一层不能把它糟蹋掉**：
// 失败必须原样返回（不是「0 条、一切正常」），重复调用必须 0 插入。
//
// 库是真库（`resetDb` 之外的用例也这么干）：`on conflict do nothing` 的语义、
// `jsonb` 的往返、`timestamptz` 的时区，只有真 Postgres 能验。
// 只清自己的行（仓 id 是 `file://…` 的临时目录），不 truncate——这张表里
// 可能已经有真实仓的历史，用例没有资格删它。

/** 库里某个仓有几行。直接问表：被测函数自己数得对不对，不能用它自己的数去验。 */
async function countRows(repo: string): Promise<number> {
  const res = await db.execute<{ n: string }>(sql`
    select count(*)::text as n from commit_history where repo = ${repo}`);
  return Number(res.rows[0]?.n ?? '0');
}

/** 库里某个仓的 sha 集合（排序后）。坏批次用例要证明的是「一个 sha 都没变」。 */
async function shasOf(repo: string): Promise<string[]> {
  const res = await db.execute<{ commit_sha: string }>(sql`
    select commit_sha from commit_history where repo = ${repo} order by commit_sha`);
  return res.rows.map((row) => row.commit_sha);
}

/** 两次合并的仓：2024 一次、2025 一次。增量口径只能靠真日期验。 */
let agedBare = '';

/** 同一**秒**里合并两次的仓：用来钉 since 的边界余量。 */
let twinBare = '';

beforeAll(async () => {
  const aged = path.join(root, 'aged');
  await mkdir(aged, { recursive: true });
  await git(aged, ['init', '-q', '-b', 'master']);
  await git(aged, ['config', 'user.email', 'dev@example.com']);
  await git(aged, ['config', 'user.name', 'dev']);
  await git(aged, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(aged, 'README.md'), 'base\n');
  await git(aged, ['add', '.']);
  await gitWhen(aged, ['commit', '-q', '-m', 'chore: init'], '2023-01-01T00:00:00+08:00');

  await git(aged, ['checkout', '-q', '-b', 'feat-old']);
  await writeFile(path.join(aged, 'old.ts'), 'export {};\n');
  await git(aged, ['add', '.']);
  await gitWhen(aged, ['commit', '-q', '-m', 'feat: 旧功能'], '2024-06-01T00:00:00+08:00');
  await git(aged, ['checkout', '-q', 'master']);
  await gitWhen(aged, ['merge', '-q', '--no-ff', 'feat-old', '-m', 'Merge #1 into master from feat-old'], '2024-06-02T00:00:00+08:00');

  await git(aged, ['checkout', '-q', '-b', 'feat-new']);
  await writeFile(path.join(aged, 'new.ts'), 'export {};\n');
  await git(aged, ['add', '.']);
  await gitWhen(aged, ['commit', '-q', '-m', 'feat: 新功能'], '2025-06-01T00:00:00+08:00');
  await git(aged, ['checkout', '-q', 'master']);
  await gitWhen(aged, ['merge', '-q', '--no-ff', 'feat-new', '-m', 'Merge #2 into master from feat-new'], '2025-06-02T00:00:00+08:00');

  agedBare = path.join(root, 'aged.git');
  await git(root, ['clone', '-q', '--bare', aged, agedBare]);
  register(`file://${agedBare}`, agedBare);

  // 同一时刻（逐秒相同）的两次合并。%cI 只到秒，所以「库里最新那一刻」可能对应两条
  // 合并——增量边界若退化成严格大于，被漏掉的那条就永远补不回来。
  const twin = path.join(root, 'twin');
  await mkdir(twin, { recursive: true });
  await git(twin, ['init', '-q', '-b', 'master']);
  await git(twin, ['config', 'user.email', 'dev@example.com']);
  await git(twin, ['config', 'user.name', 'dev']);
  await git(twin, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(twin, 'README.md'), 'base\n');
  await git(twin, ['add', '.']);
  await gitWhen(twin, ['commit', '-q', '-m', 'chore: init'], '2023-01-01T00:00:00+08:00');

  const sameMoment = '2025-06-02T10:00:00+08:00';
  for (const branch of ['feat-a', 'feat-b']) {
    await git(twin, ['checkout', '-q', '-B', branch, 'master']);
    await writeFile(path.join(twin, `${branch}.ts`), 'export {};\n');
    await git(twin, ['add', '.']);
    await gitWhen(twin, ['commit', '-q', '-m', `feat: ${branch}`], sameMoment);
    await git(twin, ['checkout', '-q', 'master']);
    await gitWhen(
      twin,
      ['merge', '-q', '--no-ff', branch, '-m', `Merge #2 into master from ${branch}`],
      sameMoment,
    );
  }

  twinBare = path.join(root, 'twin.git');
  await git(root, ['clone', '-q', '--bare', twin, twinBare]);
  register(`file://${twinBare}`, twinBare);

  // 上一轮（或上次失败的运行）可能留着行；仓 id 里带的是这次的临时目录，所以只清这些。
  await db.execute(sql`delete from commit_history where repo like 'file://%'`);
});

afterAll(async () => {
  await db.execute(sql`delete from commit_history where repo like 'file://%'`);
});

describe('ensureHistory：增量补齐', () => {
  it('第一次写入，第二次不重复写；总数不变', async () => {
    const repo = `file://${bare}`;
    const first = await ensureHistory(db, repo);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.inserted).toBe(1);

    const second = await ensureHistory(db, repo);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.data.inserted).toBe(0);
      expect(second.data.total).toBe(1);
    }
    const rows = await readHistory(db, repo);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.files).toEqual(['src/pages/video/video.vue']);
  });

  it('镜像读不出来 → 失败原样返回，且一行都没写', async () => {
    // Task 2 的整个修轮就是为了这件事：路径配错必须**报错**，否则这条路径会被
    // 写成「这个仓没有合并」，之后 5 条真实历史都查不到，而且看起来一切正常。
    const gone = path.join(root, 'gone');
    await mkdir(gone, { recursive: true });
    await writeFile(path.join(gone, 'README.md'), '这不是仓库\n');
    const id = register(`file://${gone}`, gone);

    const res = await ensureHistory(db, id);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('git_failed');
    expect(res.message).toContain(gone);
    expect(await countRows(id)).toBe(0);
  });

  it('只补库里没有的那次合并：旧的不重写，新的补进来', async () => {
    const repo = `file://${agedBare}`;
    const first = await ensureHistory(db, repo);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.inserted).toBe(2);

    // 把最新那条删掉 = 「上一次跑到一半断了」。库里最新的那一刻退回 2024，
    // 所以下一次的 since 应该只够拿到 2025 那条（含边界，git 的 --since 是含等的）。
    const rows = await readHistory(db, repo);
    expect(rows).toHaveLength(2);
    await db.execute(sql`
      delete from commit_history where repo = ${repo} and commit_sha = ${rows[0]!.commitSha}`);

    const second = await ensureHistory(db, repo);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.inserted).toBe(1);
    expect(second.data.total).toBe(2);
  });

  it('库里最新那条比镜像里所有合并都新 → 0 插入，不报错', async () => {
    // 这条是增量口径的边界：since 取自库里的 max(merged_at)，镜像若没有任何
    // 比它更新的合并，git 会回空。那是「没有新东西」，不是失败——但**也不会**
    // 回填库里缺的旧行（历史只增不改的前提）。所以这里同时钉住「不报错」与
    // 「不回填」：假行留着，真实那次合并不会被顺手补进来。
    const repo = `file://${bare}`;
    await db.execute(sql`delete from commit_history where repo = ${repo}`);
    await db.execute(sql`
      insert into commit_history (repo, commit_sha, merged_at, branch, message, files)
      values (${repo}, ${'f'.repeat(40)}, '2099-01-01T00:00:00+08:00'::timestamptz, null, '未来', '[]'::jsonb)
      on conflict (repo, commit_sha) do nothing`);

    const res = await ensureHistory(db, repo);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.inserted).toBe(0);
    expect(res.data.total).toBe(1);
    const rows = await readHistory(db, repo);
    expect(rows.map((row) => row.commitSha)).toEqual(['f'.repeat(40)]);
  });

  it('同一瞬间的两次合并：删掉一条再跑，会补回来', async () => {
    // 注意这条用例**钉不住 1 秒余量**：git 今天对 `--since=<该合并自己的 %cI>` 是含等的，
    // 所以有没有余量它都过。它钉的是真实增量行为（同一秒的两条合并、删一条后能补回来）。
    // 「让 1 秒」这个契约由下面的 `sinceFor` 单元用例直接断言输出。
    const repo = `file://${twinBare}`;
    const first = await ensureHistory(db, repo);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.inserted).toBe(2);

    const rows = await readHistory(db, repo);
    expect(rows).toHaveLength(2);
    // 两条 merged_at 完全相同，排序靠 commit_sha 兜底（没有它，「最新一条」是不定的）。
    expect(rows[0]!.mergedAt).toBe(rows[1]!.mergedAt);
    await db.execute(sql`
      delete from commit_history where repo = ${repo} and commit_sha = ${rows[0]!.commitSha}`);

    const second = await ensureHistory(db, repo);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // 删掉的那条回来了，没删的那条没被重写。
    expect(second.data.inserted).toBe(1);
    expect(second.data.total).toBe(2);
  });

  it('sinceFor：边界正好往回让 1 秒，且不夹取纪元', () => {
    // 这三个值是契约本身（不是「顺手写下来的实现输出」）：改动余量、或者偷偷把边界
    // 夹到纪元零点，都会在这里红。
    expect(sinceFor('2025-06-02T02:00:00.000Z')).toBe('2025-06-02T01:59:59.000Z');
    expect(sinceFor(null)).toBeUndefined();
    // 1970 之前：如实往回退一秒，**不**夹到 1970-01-01。
    expect(sinceFor('1970-01-01T00:00:00.000Z')).toBe('1969-12-31T23:59:59.000Z');
    // Date 也收（库里的 max 可能已经是 Date）。
    expect(sinceFor(new Date('2025-06-02T02:00:00.000Z'))).toBe('2025-06-02T01:59:59.000Z');
  });

  it('坏批次：库里原本的行一个都不动（不是半写）', async () => {
    // 这条必须走 ensureHistory 本身：validateMerges 返回失败只证明「没有可写的行」，
    // 而真正要防的是**边校验边写**留下的半批。所以先真写真读一行，再拿一个含坏行的
    // 批次覆盖进去，断言行数与 sha 集合与调用前完全一致。
    const repo = `file://${bare}`;
    await db.execute(sql`delete from commit_history where repo = ${repo}`);
    const seeded = await ensureHistory(db, repo);
    expect(seeded.ok).toBe(true);
    const before = await shasOf(repo);
    expect(before).toHaveLength(1);

    // 头一条是「更新的」合并：一段式实现会先把它写进去，再栽在第二条的坏时间上。
    const badBatch: FetchMerges = async () => ({
      ok: true,
      data: [
        { sha: 'c'.repeat(40), mergedAt: '2026-01-01T00:00:00+08:00', branch: null, message: '新的', files: [] },
        { sha: 'd'.repeat(40), mergedAt: '不是时间', branch: null, message: '坏的', files: [] },
        { sha: 'e'.repeat(40), mergedAt: '2023-01-01T00:00:00+08:00', branch: null, message: '更旧的', files: [] },
      ],
    });

    const res = await ensureHistory(db, repo, { fetch: badBatch });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('d'.repeat(40));
    // 行数与 sha 集合都没变：一行都没写。
    expect(await shasOf(repo)).toEqual(before);
    expect(await countRows(repo)).toBe(1);
  });

  it('整批校验：一条坏时间 = 一行都不写', async () => {
    // 边校验边写的后果：坏行之前那半批已经落库，下一轮的 since 从新的 max 开始，
    // 坏行之后那些更旧的合并再也补不回来。所以校验必须整批先过一遍——这里直接钉
    // `validateMerges` 的返回值形状（失败时没有 data，调用方拿不到可写的行）。
    const good = { sha: 'a'.repeat(40), mergedAt: '2025-06-02T10:00:00+08:00', branch: 'feat-a', message: 'x', files: ['a.ts'] };
    const bad = { sha: 'b'.repeat(40), mergedAt: '   ', branch: null, message: 'y', files: [] };

    const whole = validateMerges('file://x', [good, bad]);
    expect(whole.ok).toBe(false);
    if (whole.ok) return;
    expect(whole.message).toContain('b'.repeat(40));
    // 失败时没有 data：一行都交不出去。
    expect('data' in whole).toBe(false);

    const okOnly = validateMerges('file://x', [good]);
    expect(okOnly.ok).toBe(true);
    if (!okOnly.ok) return;
    // 折成 UTC ISO：库里是 timestamptz，比较与展示都以这个形态为准。
    expect(okOnly.data[0]!.mergedAtIso).toBe('2025-06-02T02:00:00.000Z');
  });

  it('readHistory 只回一个仓的行，且最新的排在最前', async () => {
    const a = `file://${bare}`;
    const b = `file://${agedBare}`;
    // 上一条用例往 a 里塞了一条 2099 的假行，先清掉；两个仓都重新补齐一遍。
    await db.execute(sql`delete from commit_history where repo = ${a}`);
    for (const repo of [a, b]) {
      const res = await ensureHistory(db, repo);
      expect(res.ok).toBe(true);
    }

    const rowsA = await readHistory(db, a);
    const rowsB = await readHistory(db, b);
    expect(rowsA).toHaveLength(1);
    expect(rowsA.every((row) => row.repo === a)).toBe(true);
    expect(rowsB).toHaveLength(2);
    expect(rowsB.every((row) => row.repo === b)).toBe(true);
    // 最新在前：2025 那次合并排在 2024 那次之前。
    expect(rowsB[0]!.mergedAt >= rowsB[1]!.mergedAt).toBe(true);
    expect(rowsB[0]!.branch).toBe('feat-new');
    expect(rowsB[1]!.branch).toBe('feat-old');
    // 消息与文件都要能原样回读（jsonb 往返 + 中文不坏）。
    expect(rowsB[0]!.message).toContain('新功能');
    expect(rowsB[0]!.files).toEqual(['new.ts']);
  });
});

/**
 * 中文检索打分：把「需求标题」对上「哪几次合并」，再把那几次合并的文件聚合成候选。
 *
 * 这一组和上面两组不同——它是**纯函数**，不碰库、不碰 git、不碰时钟。理由不只是好测：
 * 打分一旦依赖「现在几点」「库里有几行」，同一份历史换天跑就可能给出不同排名，而这
 * 份排名的唯一用途是给人看「大概是这里」，飘一次就没人信了。
 *
 * 用例里的 fixture 用真名字（`src/pages/video/video.vue`、`用户权益缩减`），因为这一层
 * 要防的病就是「中文被翻译成英文标识符后再比」——用英文 fixture 测不出来。
 */
describe('中文检索打分', () => {
  type Row = HistoryRow;
  const mk = (
    commitSha: string,
    mergedAt: string,
    message: string,
    files: string[],
  ): Row => ({ repo: 'r', commitSha, mergedAt, branch: null, message, files });
  // `branch` 一律给 null：**判据里已经不看分支名**（这个仓的 `release-*` 分支上挂着的
  // 就是功能提交）。fixture 的路径默认落在功能目录（pages/ utils/ components/ …），
  // 因为在新的口径里「有没有碰功能路径」才是结构性的那条判据。

  /** 与 Task 5 brief 同一份 fixture：一次真命中、一次无关、一次共用同一个文件。 */
  const rows: Row[] = [
    mk('a'.repeat(40), '2026-11-03T00:00:00.000Z', '用户权益缩减 / 弹窗文案调整', ['src/pages/video/video.vue', 'src/utils/questions.ts']),
    mk('b'.repeat(40), '2026-10-20T00:00:00.000Z', '下载限速风控开发', ['src/components/common-modal/common-modal.vue']),
    mk('c'.repeat(40), '2026-10-01T00:00:00.000Z', '视频播放页样式调整', ['src/pages/video/video.vue']),
  ];

  it('切块：中文连续段切二字组、英文小写，别的一律不切', () => {
    const g = grams('用户权益缩减 userEquity');
    expect(g.has('权益')).toBe(true);
    expect(g.has('缩减')).toBe(true);
    expect(g.has('userequity')).toBe(true);
    // 严格二字组：不要单字、不要三字（单字会把「用」「户」这种高频噪音灌进来，
    // 三字组在跨词边界时又几乎凑不出来）。
    expect([...grams('用户权益')].sort()).toEqual(['户权', '权益', '用户']);
  });

  it('相近的那次合并排第一', () => {
    const ranked = rankMerges(rows, '用户部分权益缩减调整');
    expect(ranked[0]!.row.commitSha).toBe('a'.repeat(40));
    // 分数是 0..1 的覆盖率，不是「有点像」的形容词：排序只因它，展示不用它。
    expect(ranked[0]!.score).toBeGreaterThan(0);
    expect(ranked[0]!.score).toBeLessThanOrEqual(1);
  });

  it('取前 5 次合并，文件按出现次数聚合，并写出处', () => {
    const got = locateFromHistory(rows, '用户部分权益缩减调整');
    expect(got.kind).toBe('candidates');
    if (got.kind !== 'candidates') return;
    expect(got.confidence).toBe('low');
    expect(got.items[0]!.path).toBe('src/pages/video/video.vue');
    expect(got.items[0]!.source).toBe('history');
    // 出处必须是人能直接读进材料的一行：日期 MM-DD + 那次合并的第一句。
    expect(got.items[0]!.reason).toBe('出自 11-03「用户权益缩减」');
  });

  it('完全对不上 → none（不是空候选列表）', () => {
    const got = locateFromHistory(rows, '发票报销流程改造');
    expect(got.kind).toBe('none');
  });

  it('历史为空 → none', () => {
    expect(locateFromHistory([], '任何东西').kind).toBe('none');
  });

  it('查询里既没有中文也没有英文词 → none，不是崩', () => {
    // 「。！」是中文标点，不是汉字：它一个二字组都切不出来。若无词时还往下算，
    // 分母为 0 就是 0/0。
    expect([...grams('。！')]).toEqual([]);
    expect(locateFromHistory(rows, '。！').kind).toBe('none');
  });

  it('只差一个字的两次合并：换个输入顺序，排名一模一样', () => {
    // 同一天、同一批词，只有最后一个字不同 → 分数很容易相同。排序若只靠 score，
    // 结果就跟着 Array.sort 的实现走（同一份数据两次运行可能不同序）。
    const twinA = mk('d'.repeat(40), '2026-11-02T00:00:00.000Z', '用户权益缩减', ['src/pages/x.vue']);
    const twinB = mk('e'.repeat(40), '2026-11-02T00:00:00.000Z', '用户权益缩减免', ['src/pages/y.vue']);
    const forward = rankMerges([twinA, twinB], '用户权益缩减');
    const backward = rankMerges([twinB, twinA], '用户权益缩减');
    expect(forward.map((hit) => hit.row.commitSha)).toEqual(backward.map((hit) => hit.row.commitSha));
  });

  it('同分同日：按 sha 兜底成固定顺序（tie-break 是契约，不是碰巧）', () => {
    const sameA = mk('a'.repeat(40), '2026-11-02T00:00:00.000Z', '用户权益缩减', ['src/pages/x.vue']);
    const sameB = mk('b'.repeat(40), '2026-11-02T00:00:00.000Z', '用户权益缩减', ['src/pages/x.vue']);
    expect(rankMerges([sameB, sameA], '用户权益缩减').map((hit) => hit.row.commitSha))
      .toEqual(['a'.repeat(40), 'b'.repeat(40)]);
  });

  it('IDF 起作用：一个稀有的词命中，压过两个满语料都有的词', () => {
    // 这条钉的是「权重」而不是「命中个数」。若把 IDF 拿平（每个词都算 1）：R1 和 R2
    // 各命中 1 / 2 个词 → 同分 → 靠 tie-break 决定胜负，更新更早的 R2 会输给 R1。
    // 有 IDF 时：`文案` 在 4 条里出现 3 次（几乎不值钱）、`风控` 只出现 1 次（很值钱），
    // 于是 R2 明显胜出。这正是「按中文词面的稀有程度比」的意义。
    const flatText = [
      mk('a'.repeat(40), '2026-11-05T00:00:00.000Z', '文案调整提示', ['src/pages/faq.vue']),
      mk('b'.repeat(40), '2026-11-01T00:00:00.000Z', '下载风控开发', ['src/pages/risk.vue']),
      mk('c'.repeat(40), '2026-10-01T00:00:00.000Z', '文案样式修改', ['src/pages/style.vue']),
      mk('d'.repeat(40), '2026-09-01T00:00:00.000Z', '文案展示效果', ['src/pages/show.vue']),
    ];
    const ranked = rankMerges(flatText, '风控文案');
    expect(ranked[0]!.row.commitSha).toBe('b'.repeat(40));
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it('提交信息为空的那次合并：不崩，也不会赢', () => {
    const silent = mk('f'.repeat(40), '2026-11-05T00:00:00.000Z', '', [
      'src/pages/video/video.vue',
      'src/only-touched-by-silent-merge.ts',
    ]);
    const got = locateFromHistory([silent, ...rows], '用户部分权益缩减调整');
    expect(got.kind).toBe('candidates');
    if (got.kind !== 'candidates') return;
    // video.vue 也被空信息那次碰过，但出处必须是真匹配上的 a 那次。
    expect(got.items[0]!.path).toBe('src/pages/video/video.vue');
    expect(got.items[0]!.reason).toBe('出自 11-03「用户权益缩减」');
    // 空信息一个词都切不出来 → 它的独占文件根本不该出现。
    expect(got.items.map((item) => item.path)).not.toContain('src/only-touched-by-silent-merge.ts');
    // 只有空信息行 → 什么都没有，但也不能崩。
    expect(locateFromHistory([mk('g'.repeat(40), '2026-11-05T00:00:00.000Z', '', ['x.ts'])], '用户权益').kind)
      .toBe('none');
  });

  it('公用文件哪怕被 4 次杂合并碰过，也排在「被 3 次真合并抱住的实现文件」后面（相似度明显更高时）', () => {
    // 这条是聚合口径的全部要点，也是这一版换掉「count 优先」的原因：
    // count 奖励「被很多次合并碰过」的文件，而被很多次合并碰过的通常是公用件
    // （`src/utils/request.ts` 这种 HTTP 客户端），不是需求的实现。一次动了 50 个文件的
    // 合并对其中任何一个文件都说明不了什么，所以按合并宽度打折；见 `mergeWeight`。
    //
    // 本 fixture 里 `src/utils/request.ts` 被 4 次杂合并碰过（count=4）、
    // `src/pages/video/video.vue` 只被 3 次真合并抱过（count=3），而真合并的相似度
    // 明显更高——排序必须让实现文件在前。旧口径（count 优先）在这里会给出 request.ts。
    const wide = [
      'src/utils/request.ts',
      ...Array.from({ length: 49 }, (_, i) => `src/legacy/wide-${i}.ts`),
    ];
    const corpus: Row[] = [
      mk('1'.repeat(40), '2026-11-03T00:00:00.000Z', '用户权益缩减', ['src/pages/video/video.vue', 'src/types/video.ts']),
      mk('2'.repeat(40), '2026-11-02T00:00:00.000Z', 'feat: 用户权益缩减', ['src/pages/video/video.vue', 'src/services/equity.ts']),
      mk('3'.repeat(40), '2026-11-01T00:00:00.000Z', '用户权益缩减 / 弹窗文案调整', ['src/pages/video/video.vue', 'src/components/modal/modal.vue']),
      mk('4'.repeat(40), '2023-10-10T00:00:00.000Z', '缩减间距', wide),
      mk('5'.repeat(40), '2023-09-01T00:00:00.000Z', '缩减文案', ['src/utils/request.ts', 'src/utils/a.ts']),
      mk('6'.repeat(40), '2023-08-01T00:00:00.000Z', '缩减提示', ['src/utils/request.ts', 'src/utils/b.ts']),
      mk('7'.repeat(40), '2023-07-01T00:00:00.000Z', '缩减样式', ['src/utils/request.ts', 'src/utils/c.ts']),
    ];
    // 排序现在是「权重 → 路径」，`count` 不下场；这里 4 个实现文件权重相同（都是 0.5），
    // 顺序由路径决定，公用件因为权重只有 0.063 排在后面。
    // `top: 10` 让 7 次合并全部进入聚合：默认的 5 次里只装得下 3 次真合并 + 2 次杂合并，
    // 就凑不出「公用件 count=4 > 实现文件 count=3」这个形状（真数据里正是这个形状出的事：
    // 前 5 名里 3 次真合并都碰了 request.ts，第 4 名那条巨型合并又把它的 count 顶上去）。
    const got = locateFromHistory(corpus, '用户权益缩减', { top: 10 });
    expect(got.kind).toBe('candidates');
    if (got.kind !== 'candidates') return;
    // 三次真合并抱住的四个文件把前四名占满（权重相同 → 按路径升序），
    // 一个公用件都挤不进来。
    const paths = got.items.map((item) => item.path);
    expect(paths.slice(0, 4)).toEqual([
      'src/components/modal/modal.vue',
      'src/pages/video/video.vue',
      'src/services/equity.ts',
      'src/types/video.ts',
    ]);
    expect(got.items[0]!.reason).toContain('用户权益缩减');
    // 公用件（被 4 次杂合并碰过）与那条动了 50 个文件的杂合并的边角文件，一条都没进清单。
    expect(paths).not.toContain('src/utils/request.ts');
    expect(paths.some((path) => path.startsWith('src/legacy/'))).toBe(false);
  });

  it('发版杂活合并整条不参与打分：动 1 个文件、相似度近乎满分也不露面', () => {
    // 「重新打包」是结构性的机械动作。这条 fixture 刻意让它 1 个文件、相似度满分
    // （宽度打折与相似度都会偏向它），只有整条剔除才拦得住。
    const plumbing = mk('c'.repeat(40), '2026-11-04T00:00:00.000Z', 'feat: 用户权益缩减 / 重新打包', [
      'src/services/release-plumbing.ts',
    ]);
    const feature = mk('d'.repeat(40), '2026-11-03T00:00:00.000Z', 'feat: 用户权益缩减', [
      'src/pages/video/video.vue',
    ]);
    expect(isFeatureMerge(plumbing)).toBe(false);
    const got = locateFromHistory([plumbing, feature], '用户权益缩减');
    expect(got.kind).toBe('candidates');
    if (got.kind !== 'candidates') return;
    expect(got.items.map((item) => item.path)).toEqual(['src/pages/video/video.vue']);
    // 只剩杂活合并时，等于「这条历史里没有可用的合并」→ none。
    expect(locateFromHistory([plumbing], '用户权益缩减').kind).toBe('none');
  });

  it('只碰 package.json / 版本号文件的合并不参与打分的语料', () => {
    // 结构性判据：一个功能目录文件都没碰 → 剔。不需要去认它消息里写的是什么。
    const bump = mk('e'.repeat(40), '2026-11-04T00:00:00.000Z', 'feat: 用户权益缩减', [
      'package.json',
      'package-lock.json',
      'docs/CHANGELOG.md',
    ]);
    expect(isFeatureMerge(bump)).toBe(false);
    expect(locateFromHistory([bump], '用户权益缩减').kind).toBe('none');
    // 同一个仓里只要有一条真的碰了功能路径，它照旧能被打分。
    const real = mk('f'.repeat(40), '2026-11-03T00:00:00.000Z', 'feat: 用户权益缩减', [
      'package.json',
      'src/pages/video/video.vue',
    ]);
    expect(isFeatureMerge(real)).toBe(true);
  });

  it('消息里写了「回滚」但碰了 pages/ 的合并**要**参与（这条曾被误杀）', () => {
    // 「回滚」在真历史里是产品动作（把已上线的改动回滚），不是「撤销某人提交」：
    // `feat: 专业空间回滚-实名认证弹框文案修改` 就是那条需求的真合并。
    // 只有英文 `revert` 前缀才是 git 自己生成的还原提交。
    const rollbackFeature = mk('1'.repeat(40), '2026-11-03T00:00:00.000Z', 'feat: 用户权益回滚-弹窗文案修改', [
      'src/pages/video/video.vue',
    ]);
    expect(isFeatureMerge(rollbackFeature)).toBe(true);
    const got = locateFromHistory([rollbackFeature], '用户权益缩减');
    expect(got.kind).toBe('candidates');
    if (got.kind !== 'candidates') return;
    expect(got.items[0]!.path).toBe('src/pages/video/video.vue');
    // 反过来：`revert` 开头的合并剔掉。
    expect(isFeatureMerge(mk('2'.repeat(40), '2026-11-03T00:00:00.000Z', 'Revert "feat: 用户权益缩减"', ['src/pages/video/video.vue']))).toBe(false);
  });

  it('isFeatureMerge：分支名不参与判断，只看结构（revert / 杂活词 / 有没有功能路径）', () => {
    const withBranch = (branch: string | null, message: string, files: string[]) => ({
      ...mk('3'.repeat(40), '2026-11-01T00:00:00.000Z', message, files),
      branch,
    });
    // 发布分支上挂着的功能提交照用——上一版按分支判把它整条扔了，探针 2 的真答案就在里面。
    expect(isFeatureMerge(withBranch('release-download-limit-yl', 'feat: 下载限速风控开发', ['src/pages/x.vue']))).toBe(true);
    expect(isFeatureMerge(withBranch('master-1103', 'feat: 用户权益缩减', ['src/pages/x.vue']))).toBe(true);
    expect(isFeatureMerge(withBranch('feat-userEquity-fjd', 'feat: 用户权益缩减', ['src/pages/x.vue']))).toBe(true);
    // 结构性杂活词（压空白后比对，「合并 master」与「合并master」等价）。
    expect(isFeatureMerge(withBranch(null, 'feat: 合并master', ['src/pages/x.vue']))).toBe(false);
    expect(isFeatureMerge(withBranch(null, 'feat: 合并 master', ['src/pages/x.vue']))).toBe(false);
    expect(isFeatureMerge(withBranch(null, 'feat: Merge branch develop into release', ['src/pages/x.vue']))).toBe(false);
    expect(isFeatureMerge(withBranch(null, 'feat: 升级版本号到 3.2.7', ['src/pages/x.vue']))).toBe(false);
    expect(isFeatureMerge(withBranch(null, 'feat: 发版', ['src/pages/x.vue']))).toBe(false);
    // 没有功能路径文件 → 剔；只改 docs / package.json 的都属于这一类。
    expect(isFeatureMerge(withBranch(null, 'chore: bump deps', ['package.json']))).toBe(false);
    expect(isFeatureMerge(withBranch(null, 'feat: 修改文案', ['docs/PRD.md']))).toBe(false);
    // 停手：真需求里常见的「同步」「热备」不再当杂活词（这两个词曾经误杀真合并）。
    expect(isFeatureMerge(withBranch(null, 'feat: 同步通讯录到云端', ['src/pages/x.vue']))).toBe(true);
    expect(isFeatureMerge(withBranch(null, 'feat: 热备域名切换', ['src/pages/x.vue']))).toBe(true);
  });

  it('mergeWeight：文件数为 0 也不除零、不出 NaN，且合并越宽权重越小', () => {
    // 库里真有「动了 0 个源码文件」的合并（只改 package.json / 构建产物的那种）：
    // `log2(2 + 0) = 1`，权重就等于相似度，不该变成 Infinity 或 NaN。
    expect(mergeWeight(0.5, 0)).toBe(0.5);
    expect(Number.isNaN(mergeWeight(1, 0))).toBe(false);
    expect(mergeWeight(0.5, 1)).toBeCloseTo(0.3155, 4);
    expect(mergeWeight(0.5, 1)).toBeLessThan(mergeWeight(0.5, 0));
    expect(mergeWeight(0.5, 50)).toBeLessThan(mergeWeight(0.5, 1));
  });

  it('碰到 0 个源码文件的合并：不崩，也不让候选分变成 NaN', () => {
    const withEmpty = [...rows, mk('9'.repeat(40), '2026-11-04T00:00:00.000Z', '用户权益缩减', [])];
    const got = locateFromHistory(withEmpty, '用户部分权益缩减调整');
    expect(got.kind).toBe('candidates');
    if (got.kind !== 'candidates') return;
    expect(got.items[0]!.path).toBe('src/pages/video/video.vue');
    for (const item of got.items) expect(Number.isFinite(item.score)).toBe(true);
  });

  it('同分同 count：按路径字典序（按码点，不是按 locale）', () => {
    // 用 localeCompare 的话大小写顺序会随运行环境的 locale 变；候选表的顺序是给人数的，
    // 换台机器就换个顺序等于没有排序。
    const one = mk('a'.repeat(40), '2026-11-03T00:00:00.000Z', '用户权益缩减', ['src/pages/b.vue', 'src/pages/A.vue', 'src/pages/a.vue']);
    const got = locateFromHistory([one], '用户权益缩减');
    expect(got.kind).toBe('candidates');
    if (got.kind !== 'candidates') return;
    expect(got.items.map((item) => item.path)).toEqual(['src/pages/A.vue', 'src/pages/a.vue', 'src/pages/b.vue']);
  });

  it('只取前 5 次合并：第 6 名的独占文件不出现在候选里', () => {
    // top 是常量（后面还要调），所以这里钉的是「6 个候选合并里只用 5 个」这件事本身。
    const many = [
      mk('1'.repeat(40), '2026-11-06T00:00:00.000Z', '用户权益缩减', ['src/pages/rank1.vue']),
      mk('2'.repeat(40), '2026-11-05T00:00:00.000Z', '用户权益缩减', ['src/pages/rank2.vue']),
      mk('3'.repeat(40), '2026-11-04T00:00:00.000Z', '用户权益缩减', ['src/pages/rank3.vue']),
      mk('4'.repeat(40), '2026-11-03T00:00:00.000Z', '用户权益缩减', ['src/pages/rank4.vue']),
      mk('5'.repeat(40), '2026-11-02T00:00:00.000Z', '用户权益缩减', ['src/pages/rank5.vue']),
      mk('6'.repeat(40), '2026-11-01T00:00:00.000Z', '用户权益缩减', ['src/pages/rank6.vue']),
    ];
    expect(rankMerges(many, '用户权益缩减')).toHaveLength(5);
    const got = locateFromHistory(many, '用户权益缩减');
    expect(got.kind).toBe('candidates');
    if (got.kind !== 'candidates') return;
    expect(got.items.map((item) => item.path)).not.toContain('src/pages/rank6.vue');
    // limit 只截断、不重排。
    const two = locateFromHistory(many, '用户权益缩减', { limit: 2 });
    expect(two.kind).toBe('candidates');
    if (two.kind !== 'candidates') return;
    expect(two.items).toHaveLength(2);
  });

  it('候选永不为空：文件列表为空 / limit 为 0 → none，不是空清单', () => {
    // CANDIDATES_LINE 对空数组直接抛，所以检索层绝不能把「零个文件」交上去。
    // 两条路径都要落到 none：①那条合并一个文件都没有（新口径下它连功能合并都不算）；
    // ②`limit: 0` 把清单截成空。
    expect(locateFromHistory([mk('a'.repeat(40), '2026-11-03T00:00:00.000Z', '用户权益缩减', [])], '用户权益').kind)
      .toBe('none');
    const one = mk('b'.repeat(40), '2026-11-03T00:00:00.000Z', '用户权益缩减', ['src/pages/video/video.vue']);
    expect(locateFromHistory([one], '用户权益', { limit: 0 }).kind).toBe('none');
  });
});
