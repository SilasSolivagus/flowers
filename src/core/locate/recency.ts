import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { shanghaiDayOf } from '../clock/tick.js';

/**
 * 「这个文件最近一次被改动」——**一次能被核实的日期查询**。
 *
 * 为什么它单独一层、而且刻意不做任何相似度判断：评审看到「这条路要改的代码三个月没人动过」，
 * 警惕度会不一样（可能是遗留区、边角逻辑）。这个判断的前提只有一条——**日期是真的**。
 * 上一版（Task 5 的先例行）之所以被否掉，就是它在猜（60 条里错了 44 条）；日期没有「猜」的
 * 余地：查得到就写，查不到就不写。
 *
 * 数据来自 `commit_history`（**合并历史**），不是文件系统的 mtime。理由不是口味：
 * 镜像每次 `fetch` 都会刷新工作区/裸仓的 mtime，mtime 只反映「上一次同步」；而
 * 「什么时候有人真的改过它」只有提交时间说得清。代价也写在这里——
 *
 * **只看合并，所以日常小提交看不见。** `commit_history` 只记 `git rev-list --merges`
 * 出来的那些提交（`mirror.ts` 的 `mergeHistory`）：一个文件可能被直接提交改了十次，
 * 这一行仍然只反映它被合进来的那一次（或者根本不出现，见报告里的命中率）。
 * 写「最近一次改动」而不加「合并」二字，是为了让 PM 读得懂；口径的这句话留给注释与报告。
 */

/** 一个文件的最近改动。`lastMergedAt` 是 UTC ISO，`days` 是北京时间的整数天差。 */
export type RecentFile = { repo: string; path: string; lastMergedAt: string; days: number };

/**
 * 材料里最多列几条：**5 条**。
 *
 * 候选本身最多 6 条（`CANDIDATE_LIMIT`），全列出来材料顶部就变成一份文件清单；而这一行要
 * 回答的只是「这些位置最近有人动过吗」。5 条足够覆盖一条需求真正会改的几个文件，
 * 而多出来的第 6 条只在「候选本来就是噪音」时才出现——那时更应该少写，不是多写。
 */
export const RECENCY_CAP = 5;

/**
 * 截到材料里该有的条数（`recencyOf` 已经排好序，这里是纯截断）。
 *
 * 抽成函数而不是在两个调用点各写 `.slice(0, RECENCY_CAP)`：上限是产品口径，散成两处
 * `slice` 之后，「走查列 5 条、评审列 6 条」这种漂移不会有任何测试红。
 */
export function topRecent(items: readonly RecentFile[], cap: number = RECENCY_CAP): RecentFile[] {
  const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : RECENCY_CAP;
  return items.slice(0, limit);
}

/**
 * 时间值 → UTC ISO。解析不了返回 `null`，**不抛**。
 *
 * 与 `history-store.ts` 的 `toIso` 同一个理由：这一层的失败是返回值，不是异常；
 * 而 `new Date(x).toISOString()` 对非法值会抛 `RangeError`。
 */
function toIso(value: Date | string): string | null {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * 一批 (repo, path) → 已知的最近改动；**查不到的条目不出现在结果里**。
 *
 * 四条口径（改之前先读）：
 *
 * 1. **一次查询解决，不做 N+1**。候选最多 6 条，但同一个调用点里两条路（走查、评审）都在
 *    材料拼装的关键路径上，逐个文件查一次就是 6 次往返；而这 6 次拿的是同一张表、
 *    同一个 `max()`。所以把 (repo, path) 整批塞进 `jsonb_to_recordset` 再 `join` 一次算完
 *    （`files @> jsonb_build_array(path)` 等价于 brief 里的 `to_jsonb(array[path])`）。
 * 2. **按仓分组**：同一个路径在两个仓里是两个文件。`join` 上必须带 `h.repo = wanted.repo`，
 *    否则 `src/services/request.ts` 这种两边都有的路径会拿到另一个仓的日期。
 * 3. **`days` 是北京时间的整数天差**：`shanghaiDayOf` 是仓库里唯一的「第几天」口径
 *    （`clock/tick.ts`），不自己写 `+08:00`。UTC 算天数会让北京时间 0–8 点的改动差一天，
 *    同一份材料上午一份、下午一份，比不写更糟。
 * 4. **查不到就是查不到**：没有合并记录 = 不出现在结果里，**不返回 `null` 日期、不返回 0 天**。
 *    0 天会被读成「今天刚改过」——那是把「我们没有这条记录」说成了一条相反的事实。
 *    日期解析不出来（脏行）同样跳过：宁可少一行，也不编一个日期。
 *
 * 结果排序：`days` 降序（先给最久没人动的，那是最该警惕的）→ `repo` → `path` 升序。
 * 全序是硬要求：材料里最多 5 条，截断发生在排序之后，没有第三把尺子时同一份历史
 * 两次运行会给出不同的 5 条。
 */
export async function recencyOf(
  db: Db,
  items: readonly { repo: string; path: string }[],
  today: Date,
): Promise<RecentFile[]> {
  if (items.length === 0) return [];

  // 传进来一个非法 Date 是调用方的 bug（不是数据问题）：静默返回空列表会变成
  // 「这些文件都没有改动记录」，那是假话。这里抛，让错误停在造它的那一层。
  // 判在 `toISOString()` 之前：那一步自己会抛 `Invalid time value`，一句读不出「谁坏了」的话。
  if (Number.isNaN(today.getTime())) throw new Error('recencyOf 的「今天」不是一个有效时刻');
  const todayDay = shanghaiDayOf(today.toISOString());
  if (todayDay === null) throw new Error('recencyOf 的「今天」读不出北京时间的第几天');

  const wanted = items.map((item) => ({ repo: item.repo, path: item.path }));
  const res = await db.execute<{ repo: string; path: string; last_merged_at: Date | string }>(sql`
    select wanted.repo as repo,
           wanted.path as path,
           max(h.merged_at) as last_merged_at
      from jsonb_to_recordset(${JSON.stringify(wanted)}::jsonb) as wanted(repo text, path text)
      join commit_history h
        on h.repo = wanted.repo
       and h.files @> jsonb_build_array(wanted.path)
     group by wanted.repo, wanted.path`);

  const out: RecentFile[] = [];
  for (const row of res.rows) {
    const lastMergedAt = toIso(row.last_merged_at);
    if (lastMergedAt === null) continue;
    const day = shanghaiDayOf(lastMergedAt);
    if (day === null) continue;
    // 负数只可能来自镜像机器的时钟比我们快：写「-3 天前」读者只会以为算错了，
    // 按 0（「今天之前动过」）处理，比编一个未来日期诚实。
    out.push({
      repo: row.repo,
      path: row.path,
      lastMergedAt,
      days: Math.max(0, todayDay - day),
    });
  }

  out.sort((a, b) => {
    if (a.days !== b.days) return b.days - a.days;
    if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1;
    if (a.path === b.path) return 0;
    return a.path < b.path ? -1 : 1;
  });
  return out;
}
