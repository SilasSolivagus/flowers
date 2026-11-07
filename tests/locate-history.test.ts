import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_SSH_HOST, mergeHistory } from '../src/core/codemirror/mirror.js';
import { db } from '../src/db/client.js';
import {
  ensureHistory, readHistory, sinceFor, validateMerges, type FetchMerges,
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
