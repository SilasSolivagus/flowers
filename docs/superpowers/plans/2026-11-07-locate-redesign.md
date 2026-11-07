# 定位重做 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「从需求找到代码现状」这件事在找不到时老实说找不到，在找到时只给线索不给结论；走查用 git 历史，评审用结构索引 + 模型扩展词。

**Architecture:** 两个互不依赖的定位模块（`locate/history.ts` 走查、`locate/structure.ts` 评审），共享一个候选数据形状（`locate/types.ts`）和一段「看不到代码」的固定文案（`locate/copy.ts`）。历史来自新表 `commit_history`（一次合并 = 一个功能落地），结构来自已有的 `code_index`。每次定位落一条账到 `locate_runs`，攒够 30 条人工案例后再定准确率门槛。

**Tech Stack:** Next 16.4.5 App Router（`--webpack`）、TypeScript strict、drizzle-orm、Postgres 17（docker `flowers-db-1`，宿主端口 54330）、Vitest（`fileParallelism: false`）、tsx 脚本、`node:child_process` 的 `execFile`（github 风格 argv，无 shell）。

**Spec:** `docs/superpowers/specs/2026-11-07-locate-redesign-design.md`

## Global Constraints

- 全部文案用简体中文；代码标识符用英文。文案里的数字与路径保持原样。
- **不新增任何依赖。** 检索打分自己写（中文二字组 + 英文词 + IDF），不引 BM25 库、不引 embedding。
- **一个会话只跑一个 vitest**：`tests/helpers/db.ts` 的 `resetDb` 会 truncate 真实库，两个 vitest 并行会互相清空对方的数据。
- `npx vitest run` 会清掉 `app_settings` 与所有业务数据；**每次收尾必须再跑** `bash /tmp/restore-demo.sh`，然后核对 `provider.*` / `code.mirror.*` 与 PAN-6 的 `prd_url` 在位（不要把 key 打印出来）。
- 迁移文件名用 drizzle 顺序号：**下一个是 `0016`**（`0015` 是 `code_index`）。新增表要同时改三处：`src/db/migrations/0016_*.sql`、`src/db/migrations/meta/_journal.json`、`src/db/schema.ts`。
- **新表必须加进 `src/db/reset.ts` 的 truncate 列表**，否则用例之间会串数据。
- 每个 commit 之前跑 `npx tsc --noEmit`。
- **第一版不允许材料里出现「这个功能就在这里」这种肯定句**（spec §7）。置信度只有 `high` / `low`，第一版所有定位一律 `low`。
- **`CANDIDATES_LINE(items)` 对空数组抛错，不许渲染空清单**（Task 4 实施时定的，偏离本文原稿）：空清单会输出「最可能的位置（待研发确认）：」却没有任何条目，等于断言了没建立的事实。没有候选必须走 `{ kind: 'none' }`。
- 「读不到代码」与「代码里没有」必须是两句不同的话，任何地方都不许混用。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/db/migrations/0016_commit_history.sql` | 建 `commit_history` 与 `locate_runs` 两张表 |
| `src/db/schema.ts` | 两张表的 drizzle 定义（追加在 `codeIndex` 之后） |
| `src/db/reset.ts` | truncate 列表加两张新表 |
| `src/core/codemirror/mirror.ts` | **新增** `mergeHistory(repoId)` 读口：一次 ssh 取回全部合并记录 |
| `src/core/locate/history-store.ts` | 建表/增量写入/读取 `commit_history`（`buildHistory`、`ensureHistory`、`readHistory`） |
| `src/core/locate/types.ts` | `Candidate`、`LocateResult`、`Confidence` |
| `src/core/locate/copy.ts` | 「看不到代码」「定位不到」「不确定」三句话 + 材料里那两段 |
| `src/core/locate/history.ts` | 中文检索打分 → 前 5 条合并 → 文件聚合 |
| `src/core/locate/structure.ts` | 模型扩展词 → 结构索引检索 |
| `src/core/locate/ledger.ts` | 每次定位记一条账 |
| `src/core/uemaster/inspect.ts` | 走查改走 `history.ts`；读不到代码时 fail-closed |
| `src/core/uemaster/review.ts` | 评审改走 `structure.ts`；同样 fail-closed |
| `scripts/index-history.ts` | `--repo <id> [--dry-run]`：建历史表并打印摘要 |
| `scripts/bench-locate.ts` | 增加「三档分布」输出 |
| `tests/locate-history.test.ts` | 检索打分与聚合（纯函数 + 夹具仓） |
| `tests/locate-structure.test.ts` | 扩展词与降级 |

---

### Task 1: `commit_history` 与 `locate_runs` 两张表

**Files:**
- Create: `src/db/migrations/0016_commit_history.sql`
- Modify: `src/db/schema.ts`（追加在 `codeIndex` 定义之后）
- Modify: `src/db/migrations/meta/_journal.json`
- Modify: `src/db/reset.ts:62`
- Test: `tests/helpers/schema.test.ts`（已存在，加一条断言）

**Interfaces:**
- Produces: 表 `commit_history(repo, commit_sha, merged_at, branch, message, files)`、`locate_runs(id, requirement_id, stage, outcome, candidates, hit, created_at)`；drizzle 导出 `commitHistory`、`locateRuns`。

- [ ] **Step 1: 写迁移 SQL**

```sql
CREATE TABLE IF NOT EXISTS "commit_history" (
	"repo" text NOT NULL,
	"commit_sha" text NOT NULL,
	"merged_at" timestamp with time zone NOT NULL,
	"branch" text,
	"message" text NOT NULL,
	"files" jsonb NOT NULL,
	CONSTRAINT "commit_history_repo_sha_pk" PRIMARY KEY("repo","commit_sha")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commit_history_merged_at" ON "commit_history" USING btree ("merged_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locate_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requirement_id" uuid,
	"stage" text NOT NULL,
	"outcome" text NOT NULL,
	"candidates" integer NOT NULL,
	"hit" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locate_runs_created_at" ON "locate_runs" USING btree ("created_at");
```

- [ ] **Step 2: 加 drizzle 定义**（追加到 `src/db/schema.ts`，紧跟 `codeIndex`）

```ts
/**
 * 一次合并 = 一个功能落地。
 *
 * 粒度故意不是「一次提交」：一条特性分支里会有十几次提交（`fix: 改个字母` 也算），
 * 只有它最后合并进主干的那一刻，文件清单才是这个功能的完整位置。
 */
export const commitHistory = pgTable('commit_history', {
  repo: text('repo').notNull(),
  commitSha: text('commit_sha').notNull(),
  mergedAt: timestamp('merged_at', { withTimezone: true }).notNull(),
  /** `feat-userEquity-fjd` 里的 `userEquity` 是唯一白给的中英对照线索。 */
  branch: text('branch'),
  /** 该分支全部非合并提交信息，用「 / 」拼接。 */
  message: text('message').notNull(),
  /** 该次合并动过的源码文件。 */
  files: jsonb('files').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.repo, t.commitSha] }),
  at: index('commit_history_merged_at').on(t.mergedAt),
}));

/**
 * 每次定位的账。第一版不设门槛，只记账——攒够 30 条人工案例再定线。
 *
 * `outcome` 三值：`none`（一个都没找到）/ `low`（找到候选但不确定）/ `absent`（代码没读到）。
 * 三值不能合并成一个布尔：`absent` 是「我们没看」，`none` 是「我们看了但没有」。
 */
export const locateRuns = pgTable('locate_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  requirementId: uuid('requirement_id'),
  stage: text('stage').notNull(),
  outcome: text('outcome').notNull(),
  candidates: integer('candidates').notNull(),
  hit: boolean('hit'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ at: index('locate_runs_created_at').on(t.createdAt) }));
```

- [ ] **Step 3: 写进 journal**

`src/db/migrations/meta/_journal.json` 的 `entries` 追加：

```json
{
  "idx": 16,
  "version": "7",
  "when": 1794043671318,
  "tag": "0016_commit_history",
  "breakpoints": true
}
```

**`when` 必须是「上一条的 `when` + 1」，不能随便写一个看起来合理的毫秒值。**
实测代价：初稿写的 `1762500000000` 比 `0015` 的 `1794043671317` 还小，drizzle 的 pg dialect
只跑 `lastDbMigration.created_at < folderMillis` 的条目——于是 `db:migrate` **退出码 0、
一张表都没建**，而下一步的 psql 检查才炸。**绿色的迁移不等于跑过的迁移。**
以后再加迁移，取 `select max(created_at) from drizzle.__drizzle_migrations` 再加 1。

- [ ] **Step 4: 加进 truncate 列表**

`src/db/reset.ts:62` 那条 `truncate ...` 里加两张表：

```ts
await db.execute(sql`truncate requirements, review_assignments, prd_snapshots, events, releases, notification_reads, notify_deliveries, members, app_settings, commit_history, locate_runs restart identity cascade`);
```

- [ ] **Step 5: 迁移并验表存在**

```bash
npm run db:migrate
docker exec -i flowers-db-1 psql -U postgres -d flowers -tAc "select count(*) from commit_history; select count(*) from locate_runs;"
```

Expected: 两条 `0`，不报错。

- [ ] **Step 6: 在 schema 自检里加断言**

`tests/helpers/schema.test.ts` 追加：

```ts
it('commit_history 与 locate_runs 存在，且主键与索引齐', async () => {
  const res = await db.execute<{ table_name: string }>(sql`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_name in ('commit_history','locate_runs')
     order by 1`);
  expect(res.rows.map((r) => r.table_name)).toEqual(['commit_history', 'locate_runs']);
});
```

- [ ] **Step 7: 跑测试**

Run: `npx vitest run tests/helpers/schema.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/db/migrations/0016_commit_history.sql src/db/migrations/meta/_journal.json src/db/schema.ts src/db/reset.ts tests/helpers/schema.test.ts
git commit -m "feat(db): commit_history 与 locate_runs 两张表"
```

---

### Task 2: 从镜像读合并历史

**Files:**
- Modify: `src/core/codemirror/mirror.ts`（追加导出，在 `showHeads` 之后）
- Test: `tests/locate-history.test.ts`（新建，本任务先放读口用例）

**Interfaces:**
- Consumes: `runGit`（文件内私有）、`resolveRepo`（文件内私有）
- Produces:
  ```ts
  export type MergeRecord = {
    sha: string;
    mergedAt: string;   // 'YYYY-MM-DDTHH:mm:ssZ'
    branch: string | null;
    message: string;    // 该分支非合并提交信息，' / ' 拼接
    files: string[];
  };
  export function mergeHistory(repoId: string, opts?: { since?: string }): Promise<MirrorResult<MergeRecord[]>>;
  ```

- [ ] **Step 1: 写失败的测试**（`tests/locate-history.test.ts`，先建夹具）

```ts
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mergeHistory } from '../src/core/codemirror/mirror.js';

const git = (cwd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });

let root = '';
let bare = '';

/** 造一个真仓：主干一次、特性分支一次、合并一次。**不发 ssh。** */
beforeAll(async () => {
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
});
afterAll(async () => { if (root !== '') await rm(root, { recursive: true, force: true }); });

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
    const plain = path.join(root, 'plain.git');
    await git(root, ['clone', '-q', '--bare', path.join(root, 'work'), plain]);
    const res = await mergeHistory(`file://${plain}`);
    expect(res.ok).toBe(true);
    if (res.ok) expect(Array.isArray(res.data)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/locate-history.test.ts`
Expected: FAIL，`mergeHistory is not a function`

- [ ] **Step 3: 实现读口**（追加到 `src/core/codemirror/mirror.ts`）

```ts
/** 一条合并记录。`files` 只含源码扩展名——docs/、png、package.json 不是「功能的位置」。 */
export type MergeRecord = {
  sha: string;
  mergedAt: string;
  branch: string | null;
  message: string;
  files: string[];
};

const HISTORY_SRC = /\.(tsx?|jsx?|vue)$/i;
/** 记录之间用 \u0001 分隔，字段之间用 \u0002——提交信息里可能有换行与竖线。 */
const REC = '\u0001';
const FLD = '\u0002';

/**
 * 一次 ssh 取回全部合并记录。
 *
 * 为什么把 git 脚本写在远端而不是每条合并来一次往返：657 条合并 = 657 次 ssh，
 * 实测要十几分钟。这里远端跑一个循环，一次把结果吐回来，约 40 秒。
 *
 * `since` 用于增量：只取比它新的合并（历史只增不改，所以「缺就补」永远安全）。
 */
export async function mergeHistory(
  repoId: string,
  opts: { since?: string } = {},
): Promise<MirrorResult<MergeRecord[]>> {
  const resolved = await resolveRepo(repoId);
  if ('ok' in resolved) return resolved;

  const sinceArg = opts.since === undefined ? '' : `--since=${JSON.stringify(opts.since)}`;
  const script = [
    `cd ${JSON.stringify(resolved.path)} || exit 9`,
    `git rev-list --merges ${sinceArg} HEAD | while read m; do`,
    `  at=$(git log -1 --format=%cI $m)`,
    `  subj=$(git log -1 --format=%s $m)`,
    `  br=$(printf %s "$subj" | sed -n 's/.*from \\([^ ]*\\).*/\\1/p')`,
    `  msgs=$(git log --no-merges --format=%s $m^1..$m 2>/dev/null | tr '\\n' '|' | sed 's/|$//')`,
    `  files=$(git diff --name-only $m^1 $m 2>/dev/null | grep -E '\\.(tsx?|jsx?|vue)$' | tr '\\n' ',')`,
    `  printf '%s${FLD}%s${FLD}%s${FLD}%s${FLD}%s${REC}' "$m" "$at" "$br" "$msgs" "$files"`,
    `done`,
  ].join('\n');

  const run = await runGit(sshArgv(resolved, 'bash', ['-lc', script]), { timeoutMs: 240_000 });
  if (run.spawnError !== null) return fail('mirror_failed', `跑不动 git：${run.spawnError}`);
  if (run.timedOut) return fail('mirror_failed', '读合并历史超时');
  if (run.exitCode !== 0) return fail('mirror_failed', `读合并历史失败：${run.stderr.slice(0, 200)}`);

  const out: MergeRecord[] = [];
  for (const rec of run.stdout.toString('utf8').split(REC)) {
    if (rec.trim() === '') continue;
    const [sha, at, br, msgs, files] = rec.split(FLD);
    if (sha === undefined || at === undefined) continue;
    out.push({
      sha: sha.trim(),
      mergedAt: at.trim(),
      branch: br === undefined || br.trim() === '' ? null : br.trim(),
      message: (msgs ?? '').split('|').filter((s) => s.trim() !== '').join(' / '),
      files: (files ?? '').split(',').filter((f) => f !== '' && HISTORY_SRC.test(f)),
    });
  }
  return ok(out);
}
```

> 若文件里没有 `sshArgv(resolved, …)` 这个助手，就照 `show` / `lsTree` 里现成的代码构造 argv（它们已经处理了 local 与 ssh 两种 transport）。**不要另起一套 transport 判断。**

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/locate-history.test.ts`
Expected: PASS（2 条）

- [ ] **Step 5: Commit**

```bash
git add src/core/codemirror/mirror.ts tests/locate-history.test.ts
git commit -m "feat(mirror): 一次取回全部合并记录（分支名 + 中文提交信息 + 文件）"
```

---

### Task 3: 历史表落库与增量

**Files:**
- Create: `src/core/locate/history-store.ts`
- Create: `scripts/index-history.ts`
- Modify: `src/db/schema.ts` 无需再动（Task 1 已完成）
- Test: `tests/locate-history.test.ts`（追加）

**Interfaces:**
- Consumes: `mergeHistory`（Task 2）
- Produces:
  ```ts
  export type HistoryRow = { repo: string; message: string; files: string[]; mergedAt: string; branch: string | null; commitSha: string };
  export function ensureHistory(db: Db, repo: string): Promise<MirrorResult<{ inserted: number; total: number; ms: number }>>;
  export function readHistory(db: Db, repo: string): Promise<HistoryRow[]>;
  ```

- [ ] **Step 1: 写失败的测试**

```ts
import { ensureHistory, readHistory } from '../src/core/locate/history-store.js';
import { db } from '../src/db/client.js';

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
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/locate-history.test.ts -t 增量补齐`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

```ts
import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { mergeHistory, type MirrorResult } from '../codemirror/mirror.js';

export type HistoryRow = {
  repo: string;
  commitSha: string;
  mergedAt: string;
  branch: string | null;
  message: string;
  files: string[];
};

/**
 * 把某个仓的合并历史补进库。
 *
 * 增量口径：只取 `merged_at` 比库里最新那条更新的合并。历史只增不改，所以不需要失效逻辑，
 * 也不会因为「改了一条旧提交」而错位（git 不会改历史——真改了就是另一个 sha）。
 */
export async function ensureHistory(
  db: Db,
  repo: string,
): Promise<MirrorResult<{ inserted: number; total: number; ms: number }>> {
  const started = Date.now();
  const sinceRes = await db.execute<{ latest: Date | string | null }>(sql`
    select max(merged_at) as latest from commit_history where repo = ${repo}`);
  const latest = sinceRes.rows[0]?.latest ?? null;
  const since = latest === null
    ? undefined
    : (latest instanceof Date ? latest : new Date(latest)).toISOString();

  const got = await mergeHistory(repo, since === undefined ? {} : { since });
  if (!got.ok) return got;

  let inserted = 0;
  for (const m of got.data) {
    const res = await db.execute(sql`
      insert into commit_history (repo, commit_sha, merged_at, branch, message, files)
      values (${repo}, ${m.sha}, ${m.mergedAt}::timestamptz, ${m.branch},
              ${m.message}, ${JSON.stringify(m.files)}::jsonb)
      on conflict (repo, commit_sha) do nothing`);
    inserted += res.rowCount ?? 0;
  }

  const totalRes = await db.execute<{ n: string }>(sql`
    select count(*)::text as n from commit_history where repo = ${repo}`);
  return {
    ok: true,
    data: { inserted, total: Number(totalRes.rows[0]?.n ?? '0'), ms: Date.now() - started },
  };
}

export async function readHistory(db: Db, repo: string): Promise<HistoryRow[]> {
  const res = await db.execute<{
    commit_sha: string; merged_at: Date | string; branch: string | null; message: string; files: string[];
  }>(sql`
    select commit_sha, merged_at, branch, message, files
      from commit_history where repo = ${repo} order by merged_at desc`);
  return res.rows.map((r) => ({
    repo,
    commitSha: r.commit_sha,
    mergedAt: r.merged_at instanceof Date ? r.merged_at.toISOString() : String(r.merged_at),
    branch: r.branch,
    message: r.message,
    files: r.files,
  }));
}
```

- [ ] **Step 4: CLI**

`scripts/index-history.ts`：`--repo <id>`（可多次）`--dry-run`。`--dry-run` 只读不写，打印每个仓的合并条数、最早/最晚日期、前 5 条消息与前 3 个文件。

- [ ] **Step 5: 跑测试与 CLI**

```bash
npx vitest run tests/locate-history.test.ts
npx tsx scripts/index-history.ts --repo 123pan-uni-app --repo 123pan-pc --dry-run
```

Expected: 测试 3 条 PASS；CLI 打出 uni-app 85 / pc 173 左右的条数。

- [ ] **Step 6: Commit**

```bash
git add src/core/locate/history-store.ts scripts/index-history.ts tests/locate-history.test.ts
git commit -m "feat(locate): 合并历史落库与增量补齐"
```

---

### Task 4: 共享的候选形状与三句话

**Files:**
- Create: `src/core/locate/types.ts`
- Create: `src/core/locate/copy.ts`
- Test: `tests/locate-copy.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Confidence = 'high' | 'low';
  export type Source = 'history' | 'structure' | 'grep';
  export type Candidate = { path: string; reason: string; source: Source; score: number };
  export type LocateResult =
    | { kind: 'absent'; why: string }            // 代码没读到
    | { kind: 'none' }                            // 读了，但没有
    | { kind: 'candidates'; confidence: Confidence; items: Candidate[] };
  ```
  `copy.ts` 导出 `ABSENT_HEADLINE`、`NOT_FOUND_HEADLINE`、`LOW_CONFIDENCE_HEADLINE`、`CONFIRM_WITH_DEV`、`ABSENT_LINE(why: string)`、`CANDIDATES_LINE(items: Candidate[])`。

- [ ] **Step 1: 写失败的测试**

```ts
import { ABSENT_LINE, CANDIDATES_LINE, CONFIRM_WITH_DEV, NOT_FOUND_HEADLINE } from '../src/core/locate/copy.js';

describe('那几句话', () => {
  it('「没读到」与「没找到」是两句不同的话', () => {
    expect(ABSENT_LINE('镜像连不上')).toContain('没读到');
    expect(ABSENT_LINE('镜像连不上')).toContain('镜像连不上');
    expect(NOT_FOUND_HEADLINE).toContain('没能');
    expect(ABSENT_LINE('x')).not.toBe(NOT_FOUND_HEADLINE);
  });

  it('候选一律标注「待研发确认」，且推动更新 PRD 而不是填六问', () => {
    const line = CANDIDATES_LINE([{ path: 'a/b.vue', reason: '出自 11-03 那次合并', source: 'history', score: 1 }]);
    expect(line).toContain('a/b.vue');
    expect(line).toContain('出自 11-03 那次合并');
    expect(line).toContain('待研发确认');
    expect(CONFIRM_WITH_DEV).toContain('PRD');
    expect(CONFIRM_WITH_DEV).not.toContain('六问');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/locate-copy.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `types.ts` 与 `copy.ts`**

> 实施结果与本节原稿的差异（以此为准）：
> 1. `CANDIDATES_LINE` 对空数组 **throw**，不是渲染悬空标题；
> 2. **终审起是四句，不是三句**：`absent` 拆成「代码没读到」（`ABSENT_HEADLINE` /
>    `ABSENT_LINE`）与「代码读到了、合并历史没读到」（`ABSENT_HISTORY_HEADLINE` /
>    `ABSENT_HISTORY_LINE`），另外两句不变。理由见 spec §7 与 `copy.ts` 的注释；
> 3. 这些句子除了进提示词，还必须进**产物顶部的横幅**（`src/core/locate/banner.ts`，
>    代码写、模型不参与）——只进提示词的那一版在终审被判不合格。

`copy.ts` 里三句话必须是常量或纯函数，且**全仓只有这一处**：

```ts
export const ABSENT_HEADLINE = '代码没读到，这一轮不含任何现状判断。';
export const NOT_FOUND_HEADLINE = '没能在代码里定位到这条需求的实现。';
export const LOW_CONFIDENCE_HEADLINE = '最可能的位置（待研发确认）：';
export const CONFIRM_WITH_DEV =
  '请与研发确认现在实际是怎么做的，确认后更新 PRD 文档，材料会标记为旧版并重新生成。';

export const ABSENT_LINE = (why: string): string => `${ABSENT_HEADLINE}（原因：${why}）${CONFIRM_WITH_DEV}`;

export function CANDIDATES_LINE(items: readonly Candidate[]): string {
  const lines = items.map((c, i) => `${i + 1}. \`${c.path}\` ← ${c.reason}`);
  return `${LOW_CONFIDENCE_HEADLINE}\n${lines.join('\n')}\n以上是线索，不是结论。${CONFIRM_WITH_DEV}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/locate-copy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/locate/types.ts src/core/locate/copy.ts tests/locate-copy.test.ts
git commit -m "feat(locate): 候选形状与「看不到 / 找不到 / 不确定」三句话"
```

---

### Task 5: 中文检索打分（走查）

**Files:**
- Create: `src/core/locate/history.ts`
- Test: `tests/locate-history.test.ts`（追加）

**Interfaces:**
- Consumes: `HistoryRow`（Task 3）、`Candidate`/`LocateResult`（Task 4）
- Produces:
  ```ts
  export function grams(text: string): Set<string>;
  export function rankMerges(rows: readonly HistoryRow[], query: string, top?: number): Array<{ row: HistoryRow; score: number }>;
  export function locateFromHistory(rows: readonly HistoryRow[], query: string, opts?: { top?: number; limit?: number }): LocateResult;
  ```

- [ ] **Step 1: 写失败的测试**

```ts
import { grams, locateFromHistory, rankMerges } from '../src/core/locate/history.js';

const rows = [
  { repo: 'r', commitSha: 'a', mergedAt: '2026-11-03T00:00:00Z', branch: 'feat-userEquity', message: '用户权益缩减 / 弹窗文案调整', files: ['src/pages/video/video.vue', 'src/utils/questions.ts'] },
  { repo: 'r', commitSha: 'b', mergedAt: '2026-10-20T00:00:00Z', branch: 'feat-download-limit', message: '下载限速风控开发', files: ['src/components/common-modal/common-modal.vue'] },
  { repo: 'r', commitSha: 'c', mergedAt: '2026-10-01T00:00:00Z', branch: 'feat-other', message: '视频播放页样式调整', files: ['src/pages/video/video.vue'] },
];

describe('中文检索打分', () => {
  it('切块：中文二字组 + 英文词', () => {
    const g = grams('用户权益缩减 userEquity');
    expect(g.has('权益')).toBe(true);
    expect(g.has('缩减')).toBe(true);
    expect(g.has('userequity')).toBe(true);
  });

  it('相近的那次合并排第一', () => {
    const ranked = rankMerges(rows, '用户部分权益缩减调整');
    expect(ranked[0]!.row.commitSha).toBe('a');
  });

  // 用例名曾写「文件按出现次数排序」——与同一任务 Step 3 第 5 条「不许按 count 排」
  // 自相矛盾（终审 Minor 5）。实际口径是「按合并权重降序、再按路径」，count 不参与排序。
  it('取前 5 条合并，文件按合并权重排序（count 不参与），并写出处', () => {
    const got = locateFromHistory(rows, '用户部分权益缩减调整');
    expect(got.kind).toBe('candidates');
    if (got.kind !== 'candidates') return;
    expect(got.confidence).toBe('low');
    expect(got.items[0]!.path).toBe('src/pages/video/video.vue');
    expect(got.items[0]!.reason).toContain('用户权益缩减');
    expect(got.items[0]!.source).toBe('history');
  });

  it('完全对不上 → none（不是空候选列表）', () => {
    const got = locateFromHistory(rows, '发票报销流程改造');
    expect(got.kind).toBe('none');
  });

  it('历史为空 → none', () => {
    expect(locateFromHistory([], '任何东西').kind).toBe('none');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/locate-history.test.ts -t 中文检索打分`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

要点（照 spec §5）：

1. `grams`：中文连续段切二字组；英文 `[a-z][a-z0-9_-]{2,}` 小写。
2. IDF：`log(1 + 总数 / 含该词的合并数)`，在**传入的 rows 内**计算。
3. 相似度 = 命中词的 IDF 之和 ÷ 查询词 IDF 之和（0..1）。
4. 取分数 > 0 的前 `top`（默认 5）条合并。
5. 文件聚合：`Map<path, {weight, bestMerge}>`，按**权重降序、再按路径字典序**（**稳定**）。
   **不许按 `count` 排**——实测按 count 会让公用件（`request.ts`）压过真答案（`download-risk-modal.ts`）；
   降成同权重兜底再测也无正收益（`questions.ts` 压过 `video.vue`）。权重 = `合并相似度 / log2(2 + 该合并改了多少文件)`，巨型合并因此不构成证据。
6. `reason` 写成 `出自 MM-DD「那次合并的第一句中文」`。
7. 相似度全部为 0（或查询无词）→ `{ kind: 'none' }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/locate-history.test.ts`
Expected: PASS

- [ ] **Step 5: 用真历史跑一次**

```bash
npx tsx -e "
import { readHistory } from './src/core/locate/history-store.js';
import { locateFromHistory } from './src/core/locate/history.js';
import { db, pool } from './src/db/client.js';
const rows = [...(await readHistory(db,'123pan-uni-app')), ...(await readHistory(db,'123pan-pc'))];
for (const q of ['用户部分权益缩减调整','上传下载按量限速风控']) {
  const r = locateFromHistory(rows, q);
  console.log(q, r.kind, r.kind === 'candidates' ? r.items.slice(0,3).map(i=>i.path) : '');
}
await pool.end();
"
```

Expected: 两条都出候选，第一条含 `src/pages/video/video.vue`。

- [ ] **Step 6: Commit**

```bash
git add src/core/locate/history.ts tests/locate-history.test.ts
git commit -m "feat(locate): 中文提交信息检索 → 前 5 次合并 → 文件聚合"
```

---

### Task 6: 结构检索 + 模型扩展词（评审）

**Files:**
- Create: `src/core/locate/structure.ts`
- Test: `tests/locate-structure.test.ts`

**Interfaces:**
- Consumes: `locateAcross`（`code-index.ts`）、`Candidate`/`LocateResult`
- Produces:
  ```ts
  export type ExpandFn = (title: string, description: string) => Promise<string[] | null>;
  export function locateFromStructure(
    entries: readonly { repo: string; index: CodeIndex }[],
    keywords: readonly string[],
    opts?: { limit?: number },
  ): LocateResult;
  export async function expandedKeywords(expand: ExpandFn, title: string, description: string, fallback: readonly string[]): Promise<string[]>;
  ```

- [ ] **Step 1: 写失败的测试**

```ts
describe('扩展词', () => {
  it('模型给出词就用模型的（去重、去空、限 12 个）', async () => {
    const got = await expandedKeywords(async () => ['权益', 'vip', '', '权益', 'member'], '权益套餐', '', ['原始']);
    expect(got).toEqual(['权益', 'vip', 'member']);
  });

  it('模型失败 → 用原始关键词，不重试也不抛', async () => {
    const got = await expandedKeywords(async () => null, '权益套餐', '', ['权益', '套餐']);
    expect(got).toEqual(['权益', '套餐']);
  });

  it('模型给空数组 → 也回落', async () => {
    const got = await expandedKeywords(async () => [], 'x', '', ['原始']);
    expect(got).toEqual(['原始']);
  });
});

describe('结构检索', () => {
  it('索引全空 → none', () => {
    expect(locateFromStructure([{ repo: 'r', index: { files: {}, imports: {}, routes: [] } as never }], ['搜索']).kind).toBe('none');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/locate-structure.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`expandedKeywords`：调用 `expand`，捕获异常返回 `null`；把结果 trim、去空、去重、截前 12；结果为空则回落 `fallback`。**不重试。**

`locateFromStructure`：调用 `locateAcross`，把 `Probe` 映射成 `Candidate`（`reason` 用 `probe.why`，`source` 为 `'structure'`），置信度固定 `'low'`；无候选返回 `{ kind: 'none' }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/locate-structure.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/locate/structure.ts tests/locate-structure.test.ts
git commit -m "feat(locate): 评审用的结构检索 + 模型扩展词（失败即回落）"
```

---

### Task 7: 记账

**Files:**
- Create: `src/core/locate/ledger.ts`
- Test: `tests/locate-ledger.test.ts`

**Interfaces:**
- Produces: `export async function recordLocate(db: Db, input: { requirementId: string | null; stage: 'inspect' | 'review'; result: LocateResult }): Promise<void>`

- [ ] **Step 1: 写失败的测试**

```ts
it('三种情况各记一条，outcome 三值不同', async () => {
  await recordLocate(db, { requirementId: null, stage: 'inspect', result: { kind: 'absent', why: '镜像连不上' } });
  await recordLocate(db, { requirementId: null, stage: 'inspect', result: { kind: 'none' } });
  await recordLocate(db, { requirementId: null, stage: 'review', result: { kind: 'candidates', confidence: 'low', items: [{ path: 'a', reason: 'r', source: 'structure', score: 1 }] } });
  const res = await db.execute<{ outcome: string; candidates: number }>(sql`select outcome, candidates from locate_runs order by created_at`);
  expect(res.rows.map((r) => r.outcome)).toEqual(['absent', 'none', 'low']);
  expect(res.rows.map((r) => r.candidates)).toEqual([0, 0, 1]);
});
```

- [ ] **Step 2: 跑确认失败 → Step 3 实现（插入一条 `locate_runs`）→ Step 4 跑通过**

- [ ] **Step 5: Commit**

```bash
git add src/core/locate/ledger.ts tests/locate-ledger.test.ts
git commit -m "feat(locate): 每次定位记一条账（absent / none / low）"
```

---

### Task 8: 走查接历史；读不到代码要明说

**Files:**
- Modify: `src/core/uemaster/inspect.ts`（定位段，约 400–445 行）
- Test: `tests/locate-wire.test.ts`

**Interfaces:**
- Consumes: `ensureHistory` / `readHistory` / `locateFromHistory` / `recordLocate` / `ABSENT_LINE` / `CANDIDATES_LINE`

- [ ] **Step 1: 写失败的测试**

两条用例，钉住「读不到 ≠ 没有」：

```ts
it('镜像读不到 → absent，且消息里不许出现「代码里没有」', async () => {
  const got = await locateForInspect({ repoId: '123pan-uni-app', deps: failingDeps, requirementId: null, query: 'x' });
  expect(got.kind).toBe('absent');
  if (got.kind === 'absent') expect(got.why).not.toContain('没有');
});

it('镜像读得到但没有相似历史 → none', async () => {
  const got = await locateForInspect({ repoId: 'r', deps: emptyHistoryDeps, requirementId: null, query: '发票报销' });
  expect(got.kind).toBe('none');
});
```

- [ ] **Step 2: 跑确认失败 → Step 3 实现**

把 `inspect.ts` 里「先问静态索引」的那一段换成：`ensureHistory` → `readHistory` → `locateFromHistory` → `recordLocate`；`ensureHistory` 失败时返回 `{ kind: 'absent', why }`，**不降级**。原来的 grep 与索引路径保留，但只在 `history` 返回 `none` 且索引非空时作为**线索补充**（同样标 `low`）。

- [ ] **Step 4: 跑测试 → Step 5: 全量 `npx vitest run` → Step 6: `bash /tmp/restore-demo.sh` → Step 7: Commit**

```bash
git commit -m "feat(inspect): 走查改走历史检索；读不到代码时不再假装「代码里没有」"
```

---

### Task 9: 评审接结构 + 扩展词

**Files:**
- Modify: `src/core/uemaster/review.ts`（`gatherBaseline`，约 380–420 行）
- Test: `tests/locate-wire.test.ts`（追加）

- [ ] **Step 1–4: TDD**

先写一条：`expand` 抛错时 `gatherBaseline` 仍然产出候选（用原始关键词），且 `confidence === 'low'`。

- [ ] **Step 5: 跑全量测试 → Step 6: `bash /tmp/restore-demo.sh` → Step 7: Commit**

```bash
git commit -m "feat(review): 评审改走结构检索 + 模型扩展词，结果一律低置信"
```

---

### Task 10: 评测输出三档分布

**Files:**
- Modify: `scripts/bench-locate.ts`
- Test: 无（脚本），但必须**跑**并把数字写进报告

- [ ] **Step 1: 加统计**

在每个 case 里对 A/B 分别归类：`none`（候选为空）/ `low`（有候选未命中）/ `hit`（命中），汇总打印三档计数；同时保留原来的命中率。

- [ ] **Step 2: 跑**

```bash
npx tsx scripts/bench-locate.ts
npx tsx scripts/bench-locate.ts --commits 10
```

- [ ] **Step 3: 把数字写进报告**

`docs/superpowers/plans/2026-11-07-locate-redesign.md`：两面的三档分布 + 与「重做前」的对比。

- [ ] **Step 4: Commit**

```bash
git add scripts/bench-locate.ts docs/superpowers/plans/2026-11-07-locate-redesign.md
git commit -m "chore(bench): 评测输出三档分布，记录重做前后的对照"
```

---

## Self-Review

**Spec coverage：**

| spec 章节 | 落在哪个 task |
|---|---|
| §4 `commit_history` | Task 1、2、3 |
| §5 走查路径 | Task 5、8 |
| §6 评审路径 | Task 6、9 |
| §7 输出契约（三句话） | Task 4、8、9 |
| §7 记账 | Task 1、7 |
| §8 失败与降级 | Task 8（fail-closed）、Task 6（扩展词回落） |
| §9 评测 | Task 10 |
| §10 实施顺序 | 任务顺序与之对应 |

**已知的、不属于缺口的两件事：**

1. **前端展示**（「低置信」在界面上怎么区分，spec §11 未定）不在本计划内——材料文本已经带了三句话，先把话说对，视觉之后再说。
2. **`branch` 字段暂未使用**：Task 2、3 存下来，为将来自动造词表留的。

**类型一致性（自查过）：** `Candidate.source` 三值 `history | structure | grep` 在 Task 4 定义，Task 5/6/8 使用一致；`LocateResult.kind` 三值 `absent | none | candidates` 在 Task 4 定义，Task 7 的 `outcome` 映射一一对应（`absent→absent`、`none→none`、`candidates→low`），Task 8 的用例按同一映射断言。
