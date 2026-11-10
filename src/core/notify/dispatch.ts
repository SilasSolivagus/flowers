import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { Member } from '../auth/roles.js';
import { tick } from '../clock/tick.js';
import type { Skipped } from '../clock/skips.js';
import { pendingDeliveries, type DeliveryCandidate } from '../read/notify.js';
import { prefsOf, type Level } from './prefs.js';
import { checkWecomBindings, type BindingAlert } from './self-heal.js';
import {
  lookupUserid, messageOf, resolveUserid, sendMarkdown, sendWebhook,
  type Runner, type WecomFail,
} from './wecom.js';

/**
 * 企微推送的那一圈（P4-07）：**读没发过的 → 解析 userid → 发 → 记一行**。
 *
 * ── 为什么不幂等，以及我们怎么补救
 *
 * 企微的 `message aibot send` 没有「这条已经发过」的概念：调两次就是两台手机响两次。
 * 所以「发过没有」这个记号必须在**我们这边**：`notify_deliveries` 上一个唯一索引
 * `(member_id, event_seq, channel)`。写这一行是发送的**后果**，也是下一次运行的
 * 排除条件——两处用的是同一格。
 *
 * 三种写的状态（与 `src/db/schema.ts` 那张表的注释一致）：
 * - `sent`：CLI 回了 `success: true`。**只有它能阻止下一次发送。**
 * - `failed`：试过了没成（CLI 报错 / 超时 / 没授权）。下一次运行**就地重试**——
 *   `on conflict do update` 更新那一行，不插第二行，所以重试不会破坏唯一性。
 * - `skipped`：没试。这一轮的原因是「企微账号还没对上」（`resolveUserid` 失败）。
 *   与 `failed` 分开是为了让报告里的两个数字各自可解释：「我们没试」不是「我们试了
 *   没成」。
 *
 * 还有一道兜底：`on conflict … where notify_deliveries.status <> 'sent'`。即使并发
 * 两次运行都走到发送，后写的那一次也**盖不掉**已经 `sent` 的那一行；`returning` 空行
 * 时这次尝试按「没发」计（不是「发了两次」）。
 *
 * ── 每人每轮最多 N 条（默认 5）
 *
 * 停机一天之后，一个人可能积压几十条。一轮全发出去等于用一次重启换一次骚扰，而且
 * 企微那边有频控。所以每人每轮封顶 `DEFAULT_PER_MEMBER_LIMIT` 条，剩下的下一轮补
 * （`pendingDeliveries` 按 seq **升序**取，所以补的是最旧的那几条，不会永远追最新）。
 * 这个数字会出现在每次运行的摘要里，也会出现在报告里。
 *
 * ── `--dry-run`
 *
 * 不发、不写 `notify_deliveries`、**连缓存都不写**（`resolveUserid` 只在真跑时才落库；
 * 预览时用只读的 `lookupUserid` 现查）。原因是「预览」这个动作本身不该改变系统状态：
 * 一次预览若能让人收到消息，或者让下一次真跑少发一条，它就不再是预览。
 */

/** 每人每轮封顶。整条链路里只有这一处定义（脚本、报告、用例都读它）。 */
export const DEFAULT_PER_MEMBER_LIMIT = 5;

/** 一轮里某一个人的账。 */
export type MemberRun = {
  memberId: string;
  name: string;
  level: Level;
  /** 真正发出去（`success: true`）的条数。dry-run 下恒为 0。 */
  sent: number;
  failed: number;
  skipped: number;
  /** dry-run 下「会发」的条数；真跑时等于 sent（方便两栏对账）。 */
  planned: number;
  /** userid 解析失败时的那句中文（成功为 null）。 */
  lookupError: string | null;
  /** 这一轮碰过的事件（dry-run 下是要发的正文），给报告与 stdout 用。 */
  messages: Array<{ eventSeq: number; headline: string; content: string; status: 'sent' | 'failed' | 'skipped' | 'planned' }>;
};

export type DispatchSummary = {
  dryRun: boolean;
  perMemberLimit: number;
  sent: number;
  failed: number;
  skipped: number;
  planned: number;
  /** 站内口味关着、企微也关着的人：一条都不碰（计入这个数，不出现在 `members` 里）。 */
  disabled: number;
  members: MemberRun[];
};

export type DispatchOptions = {
  dryRun?: boolean;
  /** 覆盖默认的每人每轮上限（用例用它把 N 调小，脚本用 `--limit` 暴露）。 */
  perMemberLimit?: number;

  // ── 下面几个只给用例注入用（默认走真实 CLI / 真实 fetch + 真实时钟）──
  run?: Runner;
  bin?: string | null;
  timeoutMs?: number;
  /** 测「自己的机器人」那条路时替换 `fetch`（不打真企微）。 */
  webhookFetch?: typeof fetch;
};

const CHANNEL = 'wecom' as const;

/** 成员行的读取形状（这一层只关心推送要的那几列）。 */
type MemberRow = {
  id: string;
  name: string;
  role: string;
  line: string | null;
  notify_prefs: string | null;
  wecom_userid: string | null;
  /** 这个人自己的机器人（2026-11-10）。非空 = 他的通知走这里，不走共用机器人。 */
  wecom_webhook: string | null;
};

function toMember(row: MemberRow): Member {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    line: row.line,
    deactivatedAt: null,
    notifyPrefs: row.notify_prefs,
    wecomUserId: row.wecom_userid,
    wecomWebhook: row.wecom_webhook,
  };
}

/** 错误列只留一句能读的话；超长的 stderr 尾巴已经由 wecom 层截过一次。 */
function brief(error: string): string {
  const flat = error.replace(/\s+/g, ' ').trim();
  return flat.length <= 400 ? flat : `${flat.slice(0, 400)}…`;
}

/**
 * 写一格投递。**这是唯一写 `notify_deliveries` 的地方**——发送路径上没有第二个
 * insert 语句，所以唯一索引的语义不会被某条旁路绕过。
 *
 * 返回值：这一行是否真的被写成 `status`（已 `sent` 的格子上再写会返回 false）。
 */
async function record(
  database: Db,
  memberId: string,
  eventSeq: number,
  status: 'sent' | 'failed' | 'skipped',
  error: string | null,
): Promise<boolean> {
  const sentAt = status === 'sent' ? new Date().toISOString() : null;
  const res = await database.execute<{ id: string }>(sql`
    insert into notify_deliveries (member_id, event_seq, channel, status, error, sent_at)
    values (
      ${memberId}, ${eventSeq}, ${CHANNEL}, ${status},
      ${error === null ? null : brief(error)},
      ${sentAt === null ? sql`null` : sql`${sentAt}::timestamptz`}
    )
    on conflict (member_id, event_seq, channel) do update
       set status = excluded.status,
           error = excluded.error,
           sent_at = excluded.sent_at
     where notify_deliveries.status <> 'sent'
    returning id`);
  return res.rows.length > 0;
}

/** 一个人这一轮的账，从零开始（数字都是数的，不是推的）。 */
function emptyRun(member: Member, level: Level): MemberRun {
  return {
    memberId: member.id,
    name: member.name,
    level,
    sent: 0,
    failed: 0,
    skipped: 0,
    planned: 0,
    lookupError: null,
    messages: [],
  };
}

/**
 * 跑一轮推送。
 *
 * 顺序：活着的成员 → 看企微档位（`off` 直接跳过）→ 取没发过的事件（受每轮上限约束）
 * → 解析 userid（缓存优先）→ 逐条发 → 每条落一行。
 *
 * 「解析失败」这一格刻意**不是**「整轮失败」：一个人的企微账号对不上，不该让别人的
 * 推送也发不出去。它的后果只有一条——这个人这一轮的候选全部记成 `skipped`，
 * 下一轮再试（每轮最多试一次，这就是「不在循环里重试」的含义）。
 */
export async function dispatchWecom(
  database: Db, opts: DispatchOptions = {},
): Promise<DispatchSummary> {
  const dryRun = opts.dryRun === true;
  const perMemberLimit = clampLimit(opts.perMemberLimit);

  const rows = await database.execute<MemberRow>(sql`
    select id, name, role, line, notify_prefs, wecom_userid, wecom_webhook
      from members
     where deactivated_at is null
     order by name, id`);

  const summary: DispatchSummary = {
    dryRun, perMemberLimit, sent: 0, failed: 0, skipped: 0, planned: 0, disabled: 0, members: [],
  };

  for (const row of rows.rows) {
    const member = toMember(row);
    const level = prefsOf(member.notifyPrefs).wecom;
    if (level === 'off') {
      summary.disabled += 1;
      continue;
    }

    const run = emptyRun(member, level);
    const candidates = await pendingDeliveries(database, member, {
      channel: CHANNEL, limit: perMemberLimit,
    });
    if (candidates.length === 0) {
      summary.members.push(run);
      continue;
    }

    /**
     * 这个人有自己的机器人（2026-11-10）→ 他的通知直接 POST 到那条 webhook，
     * **不再解析 userid**、也不经过共用机器人的授权。
     *
     * 为什么是「替代」而不是「两路都发」：一个人同时收到两条一模一样的消息是噪音，
     * 而「哪条算数」没有答案。他自己的机器人一旦设置，就是他选的收件人；共用那条路
     * 留着给他撤掉之后用（库里那一列清掉即回退）。
     *
     * 失败与共用那条同命：记 `failed`，下一轮就地重试（`record` 的 upsert）。区别只在
     * 一句话——`sendWebhook` 的错误里已经抹掉了 key。
     */
    const ownWebhook = typeof member.wecomWebhook === 'string' ? member.wecomWebhook.trim() : '';
    if (ownWebhook !== '') {
      for (const candidate of candidates) {
        const content = messageOf(candidate.headline, candidate.sentence);
        if (dryRun) {
          run.planned += 1;
          summary.planned += 1;
          run.messages.push({ ...preview(candidate, content), status: 'planned' });
          continue;
        }
        const sent = await sendWebhook(ownWebhook, content, { fetchImpl: opts.webhookFetch });
        if (sent.ok) {
          const written = await record(database, member.id, candidate.eventSeq, 'sent', null);
          if (written) {
            run.sent += 1;
            summary.sent += 1;
            run.messages.push({ ...preview(candidate, content), status: 'sent' });
          } else {
            run.messages.push({ ...preview(candidate, content), status: 'skipped' });
          }
          continue;
        }
        await record(database, member.id, candidate.eventSeq, 'failed', sent.message);
        run.failed += 1;
        summary.failed += 1;
        run.messages.push({ ...preview(candidate, content), status: 'failed' });
      }
      summary.members.push(run);
      continue;
    }

    const resolved = await thisRunUserid(database, member, opts, dryRun);
    if (!resolved.ok) {
      run.lookupError = resolved.message;
      run.skipped += candidates.length;
      summary.skipped += candidates.length;
      for (const candidate of candidates) {
        run.messages.push({ ...preview(candidate), status: 'skipped' });
        if (!dryRun) await record(database, member.id, candidate.eventSeq, 'skipped', resolved.message);
      }
      summary.members.push(run);
      continue;
    }

    for (const candidate of candidates) {
      const content = messageOf(candidate.headline, candidate.sentence);
      if (dryRun) {
        run.planned += 1;
        summary.planned += 1;
        run.messages.push({ ...preview(candidate, content), status: 'planned' });
        continue;
      }

      const sent = await sendMarkdown(resolved.userid, content, {
        run: opts.run, bin: opts.bin, timeoutMs: opts.timeoutMs,
      });
      if (sent.ok) {
        const written = await record(database, member.id, candidate.eventSeq, 'sent', null);
        // 已经 `sent` 的格子写不进去（并发两次运行的兜底）：按「没发」计，
        // 不重复把数字算一遍。
        if (written) {
          run.sent += 1;
          summary.sent += 1;
          run.messages.push({ ...preview(candidate, content), status: 'sent' });
        } else {
          run.messages.push({ ...preview(candidate, content), status: 'skipped' });
        }
        continue;
      }
      await record(database, member.id, candidate.eventSeq, 'failed', sent.message);
      run.failed += 1;
      summary.failed += 1;
      run.messages.push({ ...preview(candidate, content), status: 'failed' });
    }

    summary.members.push(run);
  }

  return summary;
}

/**
 * userid：真跑走缓存+落库（`resolveUserid`），预览走**只读**查（不写缓存）。
 *
 * 两边的匹配规则与失败话术是同一份（`lookupUserid` / `pickUser`），差别只有落库。
 */
async function thisRunUserid(
  database: Db, member: Member, opts: DispatchOptions, dryRun: boolean,
): Promise<{ ok: true; userid: string } | WecomFail> {
  const cached = typeof member.wecomUserId === 'string' ? member.wecomUserId.trim() : '';
  if (cached !== '') return { ok: true, userid: cached };

  if (dryRun) {
    const found = await lookupUserid(member.name, {
      run: opts.run, bin: opts.bin, timeoutMs: opts.timeoutMs,
    });
    return found.ok ? { ok: true, userid: found.user.userid } : found;
  }

  const resolved = await resolveUserid(database, member, {
    run: opts.run, bin: opts.bin, timeoutMs: opts.timeoutMs,
  });
  return resolved.ok ? { ok: true, userid: resolved.userid } : resolved;
}

function preview(
  candidate: DeliveryCandidate, content?: string,
): { eventSeq: number; headline: string; content: string } {
  return {
    eventSeq: candidate.eventSeq,
    headline: candidate.headline,
    content: content ?? messageOf(candidate.headline, candidate.sentence),
  };
}

/** 上限：非法值回落默认，下界 1、上界 50（一次运行发 50 条给一个人已经是事故）。 */
function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PER_MEMBER_LIMIT;
  return Math.min(50, Math.max(1, Math.trunc(value)));
}

/**
 * **tick 那条路**：先推进时钟，再补推送，最后做一次企微绑定自检。
 *
 * 拆成三个函数而不是把推送塞进 `tick` 的事务里：`tick` 是「状态机在时钟上的一次
 * 推进」，它必须在一个事务里要么全成要么全不动；而推送要跑 0..N 次网络调用、每次
 * 几十秒——放进去会让一次 tick 持锁几分钟。所以顺序是：**先提交状态，再发消息**。
 * 代价是「状态推了、消息没发」这一格存在（下一轮会补，因为推送只认
 * `notify_deliveries`，与状态无关）。
 *
 * ── 自检为什么排在推送**之后**（P2「企微绑定自愈」）
 *
 * 它要看的是「最近几条投递发出去没有」，而这一轮的投递正是刚刚写下的。排在前面，
 * 判断依据就永远是上一轮的状态：一条今天刚坏掉的绑定要等到下一轮才被发现，而
 * 「晚一轮」在一天只跑几次的 cron 上就是几个小时。代价是这一轮多一次事务、几次
 * 只读查询——比「坏了没人知道」便宜太多。
 *
 * `--dry-run` 下不跑：自检要写事件（提醒本身），而预览的语义是「什么都不改」
 * （见 `DispatchOptions` 上面那段）。所以 dry-run 返回空数组，而不是「会提醒谁」的
 * 预测——预测要么是第二份实现、要么就是一个会撒谎的数字。
 */
export async function tickThenDispatch(
  database: Db, now: Date, opts: DispatchOptions = {},
): Promise<{
  moved: number;
  /** 这一轮被跳过的坏行（原因在每一行上）。空数组 = 全场都推进了或还没到点。 */
  skipped: Skipped[];
  summary: DispatchSummary;
  alerts: BindingAlert[];
}> {
  const { moved, skipped } = await tick(database, now);
  const summary = await dispatchWecom(database, opts);
  const alerts = opts.dryRun === true ? [] : await checkWecomBindings(database, now);
  return { moved: moved.length, skipped, summary, alerts };
}
