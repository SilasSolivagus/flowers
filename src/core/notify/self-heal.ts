import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';
import { shanghaiDayOf } from '../clock/tick.js';
import { prefsOf } from './prefs.js';

/**
 * 企微绑定自检（P2「绑定自愈」）：**绑不上的人，别等到没人想起来的时候才发现。**
 *
 * ── 它修的是哪一种坏法
 *
 * `members.wecom_userid` 只在设置页点一次「查一下」时才会被解析。于是有两类人一直
 * 收不到推送，而系统里没有任何东西说过一句话：
 *
 * 1. **从来没有绑定过**（`wecom_userid is null`）——新入职、改名、通讯录里还没有他；
 * 2. **绑过一次，后来发不出去了**（最近几条投递全是 `failed` / `skipped`）——权限被收、
 *    账号停用、企微那边改了 userid。
 *
 * 两类共用一个症状：**「最近怎么没收到通知」**，而且是人过几周才自己发现的。更糟的是
 * 唯一能发现它的地方是推送摘要里的一个数字（`skipped` 累计），而那需要有人去看。
 *
 * ── 所以这里做什么
 *
 * 对每个**活着的人**：企微档位不是 `off`（关了就是他不要，不是他收不到——替人报警
 * 告等于不听话），并且
 *
 * - `wecom_userid` 是空的，或
 * - 最近 `FAILED_STREAK` 条投递里**一条都没发出去**（没有一条是 `sent`）
 *
 * → 给超管记**一条**站内提醒，**每人每天最多一条**。
 *
 * ── 三条刻意的取舍
 *
 * 1. **不发明第二个通知通道。** 站内通知在这套系统里是 `events` 的投影
 *    （见 `src/core/read/notify.ts`），没有通知表。所以这里写的是**一条事件**
 *    （`member.wecom_unlinked`，没有需求可挂 → `requirement_id = null`），由读模型
 *    扇出给超管。企微推送那时自然也会带上它（同一个 `addressed` 谓词），不需要另写。
 * 2. **「每天一条」按 `payload.day` 判，不按事件时刻判。** `day` 是与
 *    `clock/tick.ts` 的 `shanghaiDayOf` **同一个整数天数**（自 epoch 起的第几天）。
 *    这让去重跟着**被 tick 的那一天**走：一次补跑（backfill）拿的是一个注入的时刻，
 *    它的「今天」不该被数据库的 now() 改写成另一天。仓库里已经有过一次「两个今天」
 *    咬人的经历（见 `tick.ts` 的 `shanghaiDayOf` 注释）。
 * 3. **去重在 advisory lock 里做。** `check → insert` 两步在并发下会各插一条（两个
 *    tick 撞在一起不是天方夜谭：cron 重叠、手工补跑）。`pg_advisory_xact_lock` 按成员
 *    上锁，同一成员的两次检查因此排队；锁在事务结束自动释放，没有需要清理的状态。
 *
 * ── 已知的上限（写清楚，免得下一个人以为这是一个完善的自愈循环）
 *
 * - 它**只报告，不修**。修仍然要点「查一下」——因为解析 userid 要问企微通讯录，而
 *   「同名多命中」这件事必须有人看一眼（见 `wecom.ts` 的 `pickUser`）。
 * - 超管本人也会被检查。没人可报时（名册里没有超管）事件照样写进账本，只是没人看见。
 * - 一条提醒**不会**因为「人已经修好了」而被撤回：账本是只追加的。下一天如果仍然是坏的，
 *   会再有一条（这才是「提醒」该有的样子）。
 * - 事件的 `at` 是**发现的那一刻**（数据库的 now），`payload.day` 才是**被 tick 的那一天**。
 *   两者在正常运行时是同一天；只有补跑历史那一刻的数据时才会分叉，而那时「几点发现」
 *   与「哪一天的额度」本来就不该是同一个答案。
 * - 超管的绑定坏掉时，他会收到一条**关于自己**的提醒，而且这条提醒本身也会去推送、
 *   失败、然后在第二天再触发一次。这是有意的：一个收不到通知的超管更需要知道这件事。
 */

/** 这种事件的类型名（`classes.ts` 里按名字登记它的类；通知的扇出按同一个名字认它）。 */
export const EVENT_MEMBER_WECOM_UNLINKED = 'member.wecom_unlinked';

/** 「最近几条都没发出去」的条数。3 是「一次网络抖动不算，连续三轮才算」的最小值。 */
export const FAILED_STREAK = 3;

/** 任意执行器（`db` 或一个事务）：这两个查询在事务里也要能用。 */
type Exec = Pick<Db, 'execute'>;

/** 一条提醒的内容（返回值给调用方打日志；落库的形状见 `payloadOf`）。 */
export type BindingAlert = {
  memberId: string;
  memberName: string;
  /** `missing`：从没绑上；`failing`：绑过，最近几条都发不出去。 */
  reason: 'missing' | 'failing';
  /** 最近连续没发出去的条数（`missing` 时为 0）。 */
  streak: number;
};

type MemberRow = {
  id: string;
  name: string;
  notify_prefs: string | null;
  wecom_userid: string | null;
  /** 自己的机器人（2026-11-10）：有它就与通讯录无关，不该被报「没绑账号」。 */
  wecom_webhook: string | null;
};

/**
 * 这个人最近几条投递里有几条没发出去。
 *
 * 只看 `channel = 'wecom'` 的最近 `FAILED_STREAK` 行，按 `event_seq` 倒序取：
 * 三段状态里只有 `sent` 代表「发出去了」，`failed`（试了没成）与 `skipped`
 * （账号没对上，压根没试）都算没出去——从「他收到没有」这个角度看，它们是同一件事。
 *
 * 取**恰好 N 行并要求全都不是 `sent`**，而不是「数一数最近有几次失败」：中间夹着一条
 * `sent` 时（`failed, sent, failed`）说明通道是通的，那是一个人偶尔一次网络抖动，
 * 不该打扰超管。行数不足 N 也返回 0：新入职的人还没攒够证据。
 */
async function failedStreak(db: Exec, memberId: string): Promise<number> {
  const res = await db.execute<{ status: string }>(sql`
    select status
      from notify_deliveries
     where member_id = ${memberId} and channel = 'wecom'
     order by event_seq desc
     limit ${FAILED_STREAK}`);
  const rows = res.rows;
  if (rows.length < FAILED_STREAK) return 0;
  return rows.every((row) => row.status !== 'sent') ? rows.length : 0;
}

/**
 * 这一个人今天是不是已经报过了。
 *
 * `payload.day` 是整数天数（与 `shanghaiDayOf` 同一个数），所以这里是一次等值比较，
 * 不做日期区间、也不解析时刻——「今天」只有一个定义。
 */
async function alertedOn(db: Exec, memberId: string, day: number): Promise<boolean> {
  const res = await db.execute<{ seq: number }>(sql`
    select seq
      from events
     where type = ${EVENT_MEMBER_WECOM_UNLINKED}
       and (payload::jsonb ->> 'memberId') = ${memberId}
       and (payload::jsonb ->> 'day')::int = ${day}
     limit 1`);
  return res.rows.length > 0;
}

/**
 * 提醒的正文素材。
 *
 * `memberName` 单独存一份（而不是读的时候去 join `members`）：这条事件要回答的是
 * 「当时提醒的是谁」，而人被改名 / 停用之后那一行仍然要读得懂。与 `events.actor`
 * 存名字是同一条理由。
 */
function payloadOf(alert: BindingAlert, day: number): Record<string, unknown> {
  return {
    memberId: alert.memberId,
    memberName: alert.memberName,
    reason: alert.reason,
    streak: alert.streak,
    day,
  };
}

/**
 * 跑一遍自检。**只写事件，不发任何网络请求**——它可以在一次 tick 里安全地调用，
 * 也可以单独跑（`checkWecomBindings(db, new Date())`）。
 *
 * `now` 是注入的：日界与「今天」都从它来（与 `tick(db, now)` 同一个时钟）。
 * Invalid Date 在入口就拦掉：`shanghaiDayOf` 对它会返回 null，而「静默不检查」
 * 正是这一项要修的那类失败。
 */
export async function checkWecomBindings(db: Db, now: Date): Promise<BindingAlert[]> {
  if (Number.isNaN(now.getTime())) throw new AppError('invalid', '时钟时间不合法');
  const day = shanghaiDayOf(now.toISOString());
  if (day === null) throw new AppError('invalid', '时钟时间不合法');
  const rows = await db.execute<MemberRow>(sql`
    select id, name, notify_prefs, wecom_userid, wecom_webhook
      from members
     where deactivated_at is null
     order by name, id`);

  const candidates: BindingAlert[] = [];
  for (const row of rows.rows) {
    // 档位走 `prefsOf`，不在 SQL 里比字符串：通知口味的解释权只在一个文件里
    // （老形状、缺字段、手改的坏值都靠它回落），SQL 里 `notify_prefs <> ...` 会把
    // 「读不懂」变成「不检查」。
    if (prefsOf(row.notify_prefs).wecom === 'off') continue;

    /**
     * 有自己的机器人的人**不看 userid**（2026-11-10）：他的通知不走通讯录那条路，
     * 没有 userid 也不影响他收到东西。把这类人报成「没绑账号」会让超管去修一个
     * 不存在的问题——而一条错误的提醒比没有提醒更坏（下一次真的坏了就没人信了）。
     *
     * 仍然检查 `failedStreak`：自己的机器人也可能坏（地址过期、群解散、key 被重置），
     * 而那正是这一项要发现的东西。
     */
    const ownWebhook = typeof row.wecom_webhook === 'string' ? row.wecom_webhook.trim() : '';
    const userid = typeof row.wecom_userid === 'string' ? row.wecom_userid.trim() : '';
    if (ownWebhook !== '') {
      const streak = await failedStreak(db, row.id);
      if (streak >= FAILED_STREAK) {
        candidates.push({ memberId: row.id, memberName: row.name, reason: 'failing', streak });
      }
      continue;
    }

    if (userid === '') {
      candidates.push({ memberId: row.id, memberName: row.name, reason: 'missing', streak: 0 });
      continue;
    }
    const streak = await failedStreak(db, row.id);
    if (streak >= FAILED_STREAK) {
      candidates.push({ memberId: row.id, memberName: row.name, reason: 'failing', streak });
    }
  }

  if (candidates.length === 0) return [];

  const written: BindingAlert[] = [];
  await db.transaction(async (tx) => {
    for (const alert of candidates) {
      // 按成员上锁：两个 tick 撞在一起时，第二个会等第一个提交，再读到的就是
      // 「今天已经有一条」。锁跟着事务走，不需要清理。
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${alert.memberId}))`);
      if (await alertedOn(tx, alert.memberId, day)) continue;

      await recordEvent(tx, {
        // 没有需求可挂：这是一条**成员级**提醒。读模型对 `requirement_id is null`
        // 的那一类事件单独扇出给超管（见 read/notify.ts 的 `addressed`）。
        requirementId: null,
        actor: 'system',
        type: EVENT_MEMBER_WECOM_UNLINKED,
        payload: payloadOf(alert, day),
      });
      written.push(alert);
    }
  });

  return written;
}
