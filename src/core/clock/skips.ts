import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { recordEvent } from '../events.js';
import type { State } from '../state-machine.js';
import type { DeadlineField } from './tick.js';

/**
 * tick 跳过坏行之后的那一条提醒（裁定 2026-11-08：**一条坏数据不许停掉全场**）。
 *
 * ── 它修的是哪一种坏法
 *
 * `tick.ts` 以前对「处于 ready/dev/test 但没有 release_id / 没有那一天」的行直接抛
 * `AppError`。抛在事务里 = **整轮回滚**：一条坏行停掉全场。这不是理论风险，它已经发生
 * 过一次——迁移 `0024` 之前的 803 条迁入行没有 `release_id`，于是 tick 从迁移那天起
 * 一轮都没跑完过：没有状态推进、没有超时提醒、没有企微推送，自愈检查也永远轮不到。
 * 看板看起来像「今天没活」，实际是钟停了，而且没有任何东西说过一句话。
 *
 * 迁移把 34 条缺日期的行退回 queue，顺手清掉了当时的现场，**但机制没有动**：下一次
 * 导入、手改、某个 bug 造出同样一行，整轮又停。所以这一条提醒存在的理由是
 * **让跳过可见**——修数据的人（超管）必须在铃铛里看到「有 N 条钟推不动，分别是哪几条」，
 * 而不是靠有人某天想起来去翻日志。
 *
 * ── 三条刻意的取舍（与 `notify/self-heal.ts` 一一对应）
 *
 * 1. **不发明第二个通知通道。** 站内通知是 `events` 的投影（`read/notify.ts`），没有
 *    通知表。所以这里写的是一条**没有需求可挂**的事件（`requirement_id = null`），
 *    由读模型扇出给超管；企微推送那时自然也会带上它（同一个 `addressed` 谓词）。
 * 2. **每天最多一条，按 `payload.day` 判**，不按事件时刻判。`day` 与 `tick` 的
 *    `shanghaiDayOf` 是同一个整数天数：补跑（拿注入时刻）的「今天」不该被库里的
 *    `now()` 改写成另一天。一轮 tick 里跳过多少行都只报一条——803 条坏行不是 803 条
 *    提醒，那会把铃铛变成一片红。
 * 3. **去重在 advisory lock 里做。** `check → insert` 在并发下会各插一条（cron 重叠、
 *    手工补跑）。锁在事务结束自动释放，没有需要清理的状态。
 *
 * ── 为什么单独一个事务、排在推进之后
 *
 * `tick` 先把状态推进提交，再来写这条提醒。写在同一个事务里的话，提醒本身出错（payload
 * 拼错、events 写失败）会把这一轮已经推进的行一起回滚——那等于让「报告跳过」变成
 * 新的全场停机点，正是这次要拆掉的那类耦合。
 *
 * ── 已知的上限
 *
 * - 它**只报告，不修**。补日期、补排期版本仍要人来做（`schedule` 是唯一的入口，
 *   而一条迁入行该进哪个窗口必须有人看一眼）。
 * - payload 里的 `items` / `numbers` 只留前 `NAMED_NUMBERS` 条：803 条坏行的通知不该
 *   变成一份 803 行的清单。**完整列表在 `tick()` 的返回值里**（`skipped`），测试与
 *   调用方读那一份。
 * - 一条提醒不会因为「第二天数据修好了」而被撤回：账本是只追加的。
 */

/** 这种事件的类型名（`classes.ts` 登记它的类；读模型按同一个名字认它）。 */
export const EVENT_CLOCK_SKIPPED = 'clock.tick_skipped';

/**
 * 去重用的 advisory lock 键。
 *
 * 与自检不同，这一条提醒是**全局一条**（不是每人每天一条），所以锁一把固定的键就够：
 * 两个 tick 撞在一起时，后进事务的那个会等前一个提交，再读到的就是「今天已经报过」。
 */
const ALERT_LOCK_KEY = 'clock.tick_skipped';

/**
 * 通知里点名多少条需求编号。
 *
 * 20 是「一眼能看完」的上限：铃铛里那一行会被 `clip` 截断，多写的编号没人读得到；
 * 而完整清单本来就该去 tick 的返回值 / 报告里看。
 */
export const NAMED_NUMBERS = 20;

/** 坏行落在哪一格：`release_id`，或三个日期列之一。 */
export type SkipField = DeadlineField | 'release_id';

/**
 * 一行被跳过的账。
 *
 * `reason` 是一句中文（「缺少提测日」「没有排期版本」），不是错误码：这条记录的唯一
 * 读者是人和通知正文，`field` 才是给程序看的机器可读那一半。
 */
export type Skipped = {
  id: string;
  /** 需求编号（PAN-N）；`number` 列是 not null，`null` 只留给防御性的空行。 */
  number: number | null;
  state: State;
  field: SkipField;
  reason: string;
};

/** 任意执行器（`db` 或一个事务）：这两个查询在事务里也要能用。 */
type Exec = Pick<Db, 'execute'>;

/** 原因聚合：`{ 缺少提测日: 21, 没有排期版本: 17 }`。一屏说清「坏在哪一类」。 */
function reasonCounts(skipped: readonly Skipped[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of skipped) counts[row.reason] = (counts[row.reason] ?? 0) + 1;
  return counts;
}

function payloadOf(day: number, skipped: readonly Skipped[]): Record<string, unknown> {
  const numbers = skipped
    .map((row) => row.number)
    .filter((value): value is number => typeof value === 'number');
  return {
    day,
    count: skipped.length,
    /** 点名用的编号（前 N 个）。 */
    numbers: numbers.slice(0, NAMED_NUMBERS),
    /** 还有多少个编号没被点名：`count - numbers.length`（不是「总数」）。 */
    more: Math.max(0, skipped.length - Math.min(numbers.length, NAMED_NUMBERS)),
    /** 按原因聚合，报告与铃铛那一行都用它。 */
    reasons: reasonCounts(skipped),
    /** 逐行明细（前 N 条）：给报告与排查用，不是通知正文。 */
    items: skipped.slice(0, NAMED_NUMBERS).map((row) => ({
      number: row.number, state: row.state, field: row.field, reason: row.reason,
    })),
  };
}

/** 今天是不是已经报过一次了（`payload.day` 是整数天数，等值比较就够）。 */
async function alertedOn(db: Exec, day: number): Promise<boolean> {
  const res = await db.execute<{ seq: number }>(sql`
    select seq
      from events
     where type = ${EVENT_CLOCK_SKIPPED}
       and (payload::jsonb ->> 'day')::int = ${day}
     limit 1`);
  return res.rows.length > 0;
}

/**
 * 写这一轮的跳过提醒。**只写事件，不发任何网络请求**——所以可以在一次 tick 之后
 * 安全地调用（推送会在同一轮里自然带上它）。
 *
 * 返回是否真的写了一条（`false` = 没有坏行，或今天已经报过）。
 */
export async function notifySkipped(
  db: Db, input: { day: number; skipped: readonly Skipped[] },
): Promise<boolean> {
  if (input.skipped.length === 0) return false;
  let written = false;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ALERT_LOCK_KEY}))`);
    if (await alertedOn(tx, input.day)) return;
    await recordEvent(tx, {
      // 没有需求可挂：这一条说的是「这一轮有 N 条钟推不动」，不是某一条需求的变更。
      // 挂到其中一条上会让读者点开一个抽屉，而真正要看的是那一批行。
      requirementId: null,
      actor: 'system',
      type: EVENT_CLOCK_SKIPPED,
      payload: payloadOf(input.day, input.skipped),
    });
    written = true;
  });
  return written;
}
