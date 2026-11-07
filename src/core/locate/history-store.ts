import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { fail, mergeHistory, type MergeRecord, type MirrorResult } from '../codemirror/mirror.js';

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

/** 一条通过校验、可以直接写库的合并记录：`mergedAt` 已经折成确定的 UTC ISO。 */
export type ValidMerge = {
  sha: string;
  mergedAtIso: string;
  branch: string | null;
  message: string;
  files: string[];
};

/**
 * 时间值 → UTC ISO（`2025-06-02T02:00:00.000Z`）。解析不了返回 `null`，**不抛**。
 *
 * 为什么不直接用 `new Date(x).toISOString()`：它对非法值抛 `RangeError`。在
 * `ensureHistory` 里抛出去就是一次「未处理的异常」，而这一层的规矩是失败必须是
 * 返回值（见文件头），所以把「解析不了」变成一个可返回的 `null`。
 */
function toIso(value: Date | string): string | null {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * 整批校验：**先全部过一遍，再写**。
 *
 * 为什么必须两段式：边校验边写的话，一条坏记录会让在它之前的那半批已经落库；下一轮的
 * `since` 从**新的** `max(merged_at)` 开始，于是坏记录之后那些更旧的合并再也补不回来。
 * 结果就是「报了一次错」，但库里静默少了半段历史——比一次干净的失败糟得多。
 * 所以：坏一行 = 一行都不写。
 */
export function validateMerges(
  repo: string,
  records: readonly MergeRecord[],
): MirrorResult<ValidMerge[]> {
  const out: ValidMerge[] = [];
  for (const merge of records) {
    const mergedAtIso = toIso(merge.mergedAt.trim());
    // `%cI` 正常一定是合法 ISO；空串/怪值只可能来自被截断或串了行的输出。点名 sha：
    // 这条信息是 owner 去镜像里复查的唯一线索，通用的「历史读不出来」帮不上忙。
    if (mergedAtIso === null) {
      return fail(
        'git_failed',
        `合并历史里 ${merge.sha} 的提交时间读不出来（「${merge.mergedAt}」），整批已拒收：${repo}`,
      );
    }
    out.push({
      sha: merge.sha,
      mergedAtIso,
      branch: merge.branch,
      message: merge.message,
      files: merge.files,
    });
  }
  return { ok: true, data: out };
}

/**
 * 增量边界往回让 1 秒。
 *
 * `git rev-list --since` 目前是**含等**的（`commit->date < max_age` 才丢），拿
 * `max(merged_at)` 直接当边界在今天不会漏——但那是 git 的实现细节，不是我们买下的
 * 承诺。真被收紧成「严格大于」，同一瞬间（同一秒）合进来的另一条会**永久**丢失：
 * 下一轮的 `since` 已经越过它，而增量根本不会回头看。让 1 秒的代价只是重取一条
 * 已经存在的行（`on conflict do nothing` 兜住），换来的是与 git 版本无关的正确性。
 */
const SINCE_MARGIN_MS = 1000;

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
  const latestIso = latest === null ? null : toIso(latest);
  // 库里读得出 max 却解析不了：那是库里的一行脏数据。这时**不能**当成「没有历史」
  // 去全量重取——那会把一次本该被看见的问题，变成 657 条重复 insert 的正常输出。
  if (latest !== null && latestIso === null) {
    return fail(
      'bad_config',
      `commit_history 里 ${repo} 的 merged_at 读不出来（「${String(latest)}」），`
      + '先修那一行再补齐；这次一条都没写',
    );
  }

  // `since` 必须过 `mergeHistory` 的严格白名单（`YYYY-MM-DD[THH:MM[:SS][.frac][Z|±HH:MM]]`），
  // 所以从**真实的** merged_at 派生，而不是自己拼日期字符串：`toISOString()` 给的是
  // `2025-06-02T02:00:00.000Z` 这种形式，白名单收，git 也认。往回让 1 秒的理由见
  // `SINCE_MARGIN_MS`（不让就依赖 git 的边界含等）。
  const since = latestIso === null
    ? null
    : new Date(Math.max(0, Date.parse(latestIso) - SINCE_MARGIN_MS)).toISOString();

  const got = await mergeHistory(repo, since === null ? {} : { since });
  if (!got.ok) return got;

  // 两段式：整批校验在**任何写之前**（理由见 `validateMerges`）。
  const valid = validateMerges(repo, got.data);
  if (!valid.ok) return valid;

  let inserted = 0;
  for (const merge of valid.data) {
    const res = await db.execute(sql`
      insert into commit_history (repo, commit_sha, merged_at, branch, message, files)
      values (${repo}, ${merge.sha}, ${merge.mergedAtIso}::timestamptz, ${merge.branch},
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
 * 排序带 `commit_sha` 兜底：同一秒里可以有两次合并（`%cI` 只到秒），没有第二把尺子
 * 时 `order by merged_at desc` 是**不定的**——同一个库两次查询可能给出不同的「最新一条」，
 * 而 CLI 正是把第一行当最新、最后一行当最早来打印的。
 *
 * 时间统一成 UTC ISO 字符串：库里是 `timestamptz`，pg 会把它解析成 `Date`，而调用方
 * 要的是一个确定的字符串。**但不要拿它和镜像的 `%cI` 直接比大小**：镜像是
 * `2025-06-02T10:00:00+08:00`，这里是 `2025-06-02T02:00:00.000Z`，两者字典序比是错的
 * （`+08:00` 与 `Z` 的字符差会盖过时间差）。跨源比较一律先 `Date.parse` 折成毫秒。
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
     order by merged_at desc, commit_sha`);
  return res.rows.map((row) => ({
    repo,
    commitSha: row.commit_sha,
    mergedAt: toIso(row.merged_at) ?? String(row.merged_at),
    branch: row.branch,
    message: row.message,
    files: row.files,
  }));
}
