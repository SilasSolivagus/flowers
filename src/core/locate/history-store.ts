import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { fail, mergeHistory, type MirrorResult } from '../codemirror/mirror.js';

/**
 * 合并历史落库（读口 6 → `commit_history`）。
 *
 * 为什么要有这一层：`mergeHistory` 一次要 1.7 秒（uni-app 124 条）/ 16 秒（pc 533 条），
 * 而定位一次要查的是「这个功能大概什么时候合进来的、当时动了哪些文件」——同一份
 * 历史会被反复问。落库一次，之后按仓直接读。
 *
 * 增量的口径只有一条：**按 `merged_at` 往后补**。
 * - 历史只增不改（git 改了内容就是另一个 sha），所以「缺就补」永远安全，不需要任何
 *   失效逻辑；
 * - 反过来也意味着**库里已有的行是权威**：镜像若把某次合并弄丢了（重新 clone、
 *   镜像被人动过），增量只会在 `merged_at` 之后找，不回填、也不删——这是刻意的取舍：
 *   每次全量重取 533 条要 16 秒，为了一个不会发生的场景把每次定位都拖慢不值得。
 *   真要重建，把那个仓的行删掉再跑一次（`since` 就变成「全量」）。
 */

export type HistoryRow = {
  repo: string;
  commitSha: string;
  mergedAt: string;
  branch: string | null;
  message: string;
  files: string[];
};

export type HistorySyncStats = {
  /** 本次真正写进去的行数（重复的合并被 `on conflict do nothing` 挡掉，不计）。 */
  inserted: number;
  /** 写完这个仓一共有几行。 */
  total: number;
  /** 本次耗时，含 git 读取与写库。 */
  ms: number;
};

/** 库里的 `merged_at` 可能是 Date（pg 解析过）也可能是字符串（驱动参数化时）。 */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * 把某个仓的合并历史补进库。
 *
 * 幂等：同一份历史调两次，第二次 `inserted` 是 0、`total` 不变——靠的是主键
 * `(repo, commit_sha)` 上的 `on conflict do nothing`，不是先查后插（两次查询之间
 * 的窗口里另一个进程会插进去）。
 *
 * 失败一定**返回**，绝不吞成「0 条、一切正常」：镜像路径配错、ssh 连不上、`--since`
 * 被 git 拒，都是 `ok: false` 加一句中文。这一层如果把它变成空历史，上层看到的
 * 就是「这个仓从来没有过合并」——比一次明确的失败难发现得多。
 */
export async function ensureHistory(db: Db, repo: string): Promise<MirrorResult<HistorySyncStats>> {
  const started = Date.now();

  const latestRes = await db.execute<{ latest: Date | string | null }>(sql`
    select max(merged_at) as latest from commit_history where repo = ${repo}`);
  const latest = latestRes.rows[0]?.latest ?? null;

  // `since` 必须过 `mergeHistory` 的严格白名单（`YYYY-MM-DD[THH:MM[:SS][.frac][Z|±HH:MM]]`），
  // 所以从**真实的** merged_at 派生，而不是自己拼日期字符串：`toISOString()` 给的是
  // `2025-06-02T02:00:00.000Z` 这种形式，白名单收，git 也认。
  // 边界是含等的（实测 `git rev-list --since=<某次合并的 %cI>` 会**包含**那次合并本身），
  // 所以同一秒里的另一条合并不会因为「恰好等于 since」被漏掉；重取到的那一条由
  // on conflict 挡掉，不会重复。
  const since = latest === null ? null : toIso(latest);

  const got = await mergeHistory(repo, since === null ? {} : { since });
  if (!got.ok) return got;

  let inserted = 0;
  for (const merge of got.data) {
    // `%cI` 一定是合法 ISO；空串/怪值只可能来自被截断或串了行的输出。这时不能塞给
    // `::timestamptz`——那会抛异常，把一次「某一行有问题」变成整次补齐失败；也不能
    // 悄悄跳过（那样历史里静默少一条）。点名 sha 返回失败，让人能去镜像里看。
    const mergedAt = merge.mergedAt.trim();
    if (mergedAt === '' || Number.isNaN(new Date(mergedAt).getTime())) {
      return fail(
        'git_failed',
        `合并历史里 ${merge.sha} 的提交时间读不出来（「${merge.mergedAt}」），已中止：${repo}`,
      );
    }
    const res = await db.execute(sql`
      insert into commit_history (repo, commit_sha, merged_at, branch, message, files)
      values (${repo}, ${merge.sha}, ${mergedAt}::timestamptz, ${merge.branch},
              ${merge.message}, ${JSON.stringify(merge.files)}::jsonb)
      on conflict (repo, commit_sha) do nothing`);
    inserted += res.rowCount ?? 0;
  }

  const totalRes = await db.execute<{ n: string }>(sql`
    select count(*)::text as n from commit_history where repo = ${repo}`);
  return {
    ok: true,
    data: {
      inserted,
      total: Number(totalRes.rows[0]?.n ?? '0'),
      ms: Date.now() - started,
    },
  };
}

/**
 * 一个仓的全部合并，**最新在前**（与 `mergeHistory` 同一个方向：Task 5 的检索要先看
 * 最近的那几次）。
 *
 * 时间统一成 ISO 字符串：库里是 `timestamptz`，pg 会把它解析成 `Date`，而调用方要的
 * 是能与镜像里的 `%cI` 直接比大小的字符串——两处都折成 `toISOString()`，比较才是
 * 同一把尺子。
 */
export async function readHistory(db: Db, repo: string): Promise<HistoryRow[]> {
  const res = await db.execute<{
    commit_sha: string;
    merged_at: Date | string;
    branch: string | null;
    message: string;
    files: string[];
  }>(sql`
    select commit_sha, merged_at, branch, message, files
      from commit_history
     where repo = ${repo}
     order by merged_at desc`);
  return res.rows.map((row) => ({
    repo,
    commitSha: row.commit_sha,
    mergedAt: row.merged_at instanceof Date ? row.merged_at.toISOString() : String(row.merged_at),
    branch: row.branch,
    message: row.message,
    files: row.files,
  }));
}
