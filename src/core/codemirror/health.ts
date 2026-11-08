import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';
import { shanghaiDayOf } from '../clock/tick.js';
import { ageInDays, todayInShanghai } from '../locate/copy.js';

/**
 * 镜像新鲜度：把「索引器本来就知道的事」变成一条**主动**通知。
 *
 * ── 它修的是哪一种坏法
 *
 * 新鲜度是一条三环链：服务器 cron 05:05 从 codeup 抓镜像 → Mac launchd 05:10 索引新
 * blob → 材料写「代码快照：<仓> @ <日期>」。2026-11-08 那天**第一环坏了**：从服务器
 * `codeup.aliyun.com` 解析得出来（118.31.165.50）但 HTTPS 连不上（`000`），三个仓全部
 * `rc=128`，唯一的痕迹是 `/var/log/sync-flowers-mirror.log`——没有人读它。与此同时
 * `123pan-cross-frontend` 还停在 2026-10-21。
 *
 * 材料上那句「代码快照较旧（N 天前）」是**被动**兜底：只有**下一次生成材料**时才看得见。
 * 于是「代码旧了」这件事的发现时机取决于「有没有人刚好要生成点什么」，而不是它自己。
 * 这一层把它翻过来：每晚索引跑完就地判一次，旧了就报。
 *
 * ── 三层，各管一件事
 *
 * 1. **记**（`recordMirrorHealth`）：一仓一行，写进 `mirror_health`（迁移 0031）。
 * 2. **判**（`judgeMirror`）：`ok = false`，或 HEAD 的提交日期距今 **> 7 天**。
 * 3. **报**（`checkMirrorFreshness`）：写一条 `mirror.stale` 事件，每仓每天最多一条。
 *
 * ── 四条刻意的取舍
 *
 * 1. **不发明第二个通知通道。** 站内通知是 `events` 的投影（`read/notify.ts`），没有
 *    通知表。这里写的是**一条没有需求可挂的事件**（`requirement_id = null`），由读模型
 *    扇出给超管（与 `member.wecom_unlinked`、`clock.tick_skipped` 同一格）；企微推送那
 *    时自然也会带上它（同一个 `addressed` 谓词）。
 * 2. **「健康但旧」也要报。** 这是这一项最容易被写歪的地方：只报失败会漏掉最常见的那种
 *    旧——cron 好好跑着，上游这几天就是没有提交，于是镜像**正确地**停在 10-21。owner
 *    关心的是「我看的代码是旧的」，不是「同步过程有没有报错」。所以判据是 `head_date`，
 *    不是 `ok`；而正文里两者的措辞不同（见 `read/notify.ts` 的 `memberLineOf`）：
 *    没错误时**不写**「上次同步失败：」那一截，改成「上游这段时间没有新提交」——把成功
 *    的同步说成失败，会让人去修一个没坏的东西。
 * 3. **每天每仓最多一条，按 `payload.day` 判。** `day` 与 `clock/tick.ts` 的
 *    `shanghaiDayOf` 是同一个整数天数：补跑（拿注入时刻）的「今天」不该被库里的
 *    `now()` 改写成另一天。**锁与去重都按仓**（不是全局一把锁）：三个仓一起旧的时候
 *    应该是三条提醒（各指一件事），而同一个仓一次重跑不该变成两条。
 * 4. **判的对象是「配置里的仓」，不是「表里的行」。** 调用方传进当前配置的仓名列表：
 *    一个已经从配置里删掉的仓会留下一条陈旧行，按行遍历会让它永远报警；反过来，
 *    一个**配了却一次都没写进表**的仓（索引器从没成功跑过、或这一轮在写它之前就崩了）
 *    恰恰是最该报的那一类静默失败——所以它按「未知」报一条，而不是跳过。
 *
 * ── 已知的上限（写清楚，免得下一个人以为这是一个完整的自愈循环）
 *
 * - 它**只报告，不修**。修仍然是去服务器看 `sync-flowers-mirror.log` / 看 ssh / 看
 *   上游权限（`docs/superpowers/plans/2026-11-08-mirror-health.md` §6 列了它抓不到的
 *   那一类：抓取「成功」但抓到的是旧 ref，或凭据悄悄失效却退出 0）。
 * - 判据只看 `head_date`，不看 `checked_at`：索引器**自己**停摆时，`head_date` 会一天天
 *   变旧，7 天后仍会被抓到（慢，但抓得到）；而「head_date 很新、索引器已经三天没跑」
 *   这一格现在没人报（要报得再加一条「`checked_at` 超过 N 小时」的判据）。
 * - 一条提醒不会因为「第二天修好了」而被撤回：账本是只追加的。
 */

/** 这种事件的类型名（`classes.ts` 登记它的类；读模型按同一个名字认它）。 */
export const EVENT_MIRROR_STALE = 'mirror.stale';

/**
 * 多少天算「旧」：**7 天**，而且是**严格大于**（第 7 天不报，第 8 天报）。
 *
 * 比材料上那个 `SNAPSHOT_STALE_DAYS`（14）更严：材料是**被人读到时**的诚实声明，7 天
 * 就在每份材料上写「较旧」会变成噪音；而通知是**主动打断**，它的用途是让人在周末
 * 之前发现「这个仓一周没动了」，所以门槛更低。
 *
 * 取「严格大于」而不是「大于等于」：与 `locate/copy.ts` 的 `age > SNAPSHOT_STALE_DAYS`
 * 同一个习惯——「N 天门槛」的意思是「超过 N 天才算」，读代码的人不用猜边界属于哪边。
 * 用例 `tests/mirror-health.test.ts` 把 7/8 两个数都钉住了。
 */
export const MIRROR_STALE_DAYS = 7;

/** advisory lock 的键前缀：锁按**仓**上，三个仓同时旧应该是三条提醒。 */
const ALERT_LOCK_PREFIX = 'mirror.stale:';

/** 任意执行器（`db` 或一个事务）：这两个查询在事务里也要能用。 */
type Exec = Pick<Db, 'execute'>;

/**
 * 写一行检查结果（索引器每处理完一个仓就调一次）。
 *
 * `headSha` / `headDate` 传 `null` 表示**这一轮没读到**（`head()` 失败、或仓还是空的）。
 * 那时**保留上一次已知值**（`coalesce`）：`ok` / `error` / `checked_at` 刷成本轮的，
 * 但「它停在哪一天」不能因为一个连不上的夜里就被抹掉——那正是通知正文里最有用的一半。
 *
 * `checked_at` 用 `now()` 而不是注入的时刻：它是**这条记录什么时候被写下**，与
 * 「判哪一天」是两件事（后者在 `checkMirrorFreshness` 里由 `now` 决定）。
 */
export async function recordMirrorHealth(
  db: Exec,
  input: {
    repo: string;
    headSha: string | null;
    /** `%cI` 那种 ISO 串（带 `+08:00`）；不合法时由 PG 抛错，不在这里猜。 */
    headDate: string | null;
    ok: boolean;
    /** `ok = false` 时的中文原因；`true` 时应当是 null。 */
    error: string | null;
  },
): Promise<void> {
  await db.execute(sql`
    insert into mirror_health (repo, head_sha, head_date, checked_at, ok, error)
    values (
      ${input.repo},
      ${input.headSha}::text,
      ${input.headDate}::timestamptz,
      now(),
      ${input.ok},
      ${input.error}
    )
    on conflict (repo) do update
       set head_sha = coalesce(excluded.head_sha, mirror_health.head_sha),
           head_date = coalesce(excluded.head_date, mirror_health.head_date),
           checked_at = now(),
           ok = excluded.ok,
           error = excluded.error`);
}

/** 一条待报的提醒（返回值给调用方打日志；落库的形状见 `payloadOf`）。 */
export type MirrorAlert = {
  repo: string;
  /** HEAD 提交日期（上海日历日 `YYYY-MM-DD`）；从没读到过 HEAD 时是 null。 */
  headDate: string | null;
  /** 距今天几天；`headDate` 为 null 时也是 null。 */
  days: number | null;
  /** 句子里那一截原因；`null` = 同步是成功的（只是旧）。 */
  error: string | null;
  /** 为什么报：`failed` 同步失败 / `old` 健康但太旧 / `unknown` 表里没有这个仓。 */
  reason: 'failed' | 'old' | 'unknown';
};

type HealthRow = {
  repo: string;
  head_sha: string | null;
  head_date: string | Date | null;
  ok: boolean;
  error: string | null;
};

/** pg 对 timestamptz 给 Date 或字符串（本仓的 parser 给字符串），两种都要能读。 */
function isoOf(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * HEAD 的提交日期 → 距今几天（上海日历日之差）。
 *
 * 走 `locate/copy.ts` 的 `todayInShanghai` / `ageInDays` 而不是自己写一份：材料上那句
 * 「代码快照较旧（N 天前）」用的就是这两个函数，而一条通知说「19 天前」、同一天的
 * 材料说「18 天前」这种分歧，会让人开始怀疑两个数都不对。
 */
function ageOf(headDate: Date | string, today: string): { headDay: string; days: number | null } {
  const headDay = todayInShanghai(new Date(isoOf(headDate)));
  return { headDay, days: ageInDays(headDay, today) };
}

/**
 * 判一个仓（不写库）：`ok = false` / 太旧 / 表里没有 → 返回一条提醒，否则 null。
 *
 * 单独抽出来是因为「触发规则」是本功能的全部口径：它必须能被逐格钉住（7 天 / 8 天 /
 * 失败 / 未知），而不是埋在一个带事务与锁的循环里。
 */
export function judgeMirror(
  input: {
    repo: string;
    /** `mirror_health` 里那一行；`null` = 这个仓一次都没被记录过。 */
    row: HealthRow | null;
    /** 上海日历日 `YYYY-MM-DD`。 */
    today: string;
  },
): MirrorAlert | null {
  const { repo, row, today } = input;
  if (row === null) {
    // 配了却从来没有一行记录：索引器一次都没成功跑到它（或这轮在写它之前就崩了）。
    // 这正是「静默失败」的形状，所以按未知报一条——跳过等于把「从没跑过」当成「没问题」。
    return { repo, headDate: null, days: null, error: null, reason: 'unknown' };
  }
  if (!row.ok) {
    const error = typeof row.error === 'string' && row.error.trim() !== ''
      ? row.error.trim()
      : '上次同步失败（没有记录原因）';
    const age = row.head_date === null ? null : ageOf(row.head_date, today);
    return { repo, headDate: age?.headDay ?? null, days: age?.days ?? null, error, reason: 'failed' };
  }
  if (row.head_date === null) {
    // `ok = true` 却没有提交日期：库里的坏行。不猜一个日期，照样报。
    return { repo, headDate: null, days: null, error: null, reason: 'unknown' };
  }
  const age = ageOf(row.head_date, today);
  if (age.days === null || age.days <= MIRROR_STALE_DAYS) return null;
  // 同步是成功的，只是上游这段时间没有新提交——`error` 留 null，正文会换一种说法。
  return { repo, headDate: age.headDay, days: age.days, error: null, reason: 'old' };
}

/** 提醒的正文素材（`read/notify.ts` 的 `memberLineOf` 把这几格拼成一句话）。 */
function payloadOf(alert: MirrorAlert, day: number): Record<string, unknown> {
  return {
    repo: alert.repo,
    head_date: alert.headDate,
    days: alert.days,
    error: alert.error,
    reason: alert.reason,
    day,
  };
}

/** 这个仓今天是不是已经报过了（按仓 + `payload.day`）。 */
async function alertedOn(db: Exec, repo: string, day: number): Promise<boolean> {
  const res = await db.execute<{ seq: number }>(sql`
    select seq
      from events
     where type = ${EVENT_MIRROR_STALE}
       and (payload::jsonb ->> 'repo') = ${repo}
       and (payload::jsonb ->> 'day')::int = ${day}
     limit 1`);
  return res.rows.length > 0;
}

/**
 * 判一遍**当前配置里的**仓，并给超管写提醒。**只写事件，不发任何网络请求**——它可以
 * 在夜间索引跑完之后安全地调用（推送会在同一轮里自然带上它）。
 *
 * `repos` 由调用方传（`scripts/index-nightly.ts` 传的是 `resolveMirrorConfig()` 的结果）：
 * 判的对象是「现在配了什么」，不是「表里有什么」——理由见文件头第 4 条。
 *
 * `now` 是注入的：`today` 与 `day` 都从它来（与 `tick(db, now)` 同一个时钟）。
 * 返回真正写下的那些提醒（空 = 都新鲜，或今天都报过了）。
 */
export async function checkMirrorFreshness(
  db: Db,
  input: { repos: readonly string[]; now: Date },
): Promise<MirrorAlert[]> {
  if (Number.isNaN(input.now.getTime())) throw new AppError('invalid', '时钟时间不合法');
  const day = shanghaiDayOf(input.now.toISOString());
  if (day === null) throw new AppError('invalid', '时钟时间不合法');
  const today = todayInShanghai(input.now);
  if (input.repos.length === 0) return [];

  const res = await db.execute<HealthRow>(sql`
    select repo, head_sha, head_date, ok, error
      from mirror_health
     where repo in (${sql.join(input.repos.map((repo) => sql`${repo}`), sql`, `)})`);
  const byRepo = new Map(res.rows.map((row) => [row.repo, row]));

  const alerts: MirrorAlert[] = [];
  for (const repo of input.repos) {
    const alert = judgeMirror({ repo, row: byRepo.get(repo) ?? null, today });
    if (alert !== null) alerts.push(alert);
  }
  if (alerts.length === 0) return [];

  const written: MirrorAlert[] = [];
  await db.transaction(async (tx) => {
    for (const alert of alerts) {
      // 按**仓**上锁：两个索引进程撞在一起时，第二个会等第一个提交，再读到的就是
      // 「今天这个仓已经有一条」。前缀把它的键空间与成员 id / 时钟那条分开。
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${ALERT_LOCK_PREFIX + alert.repo}))`,
      );
      if (await alertedOn(tx, alert.repo, day)) continue;

      await recordEvent(tx, {
        // 没有需求可挂：这是一条**全局级**提醒（说的是镜像，不是某条需求）。
        // 读模型对 `requirement_id is null` 的那一类事件单独扇出给超管。
        requirementId: null,
        actor: 'system',
        type: EVENT_MIRROR_STALE,
        payload: payloadOf(alert, day),
      });
      written.push(alert);
    }
  });

  return written;
}
