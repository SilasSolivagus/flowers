import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Db } from '../../db/client.js';
import { currentMemberRow, type Member } from './member.js';
import { leadLineOf } from '../auth/roles.js';
import { levelFilter, classOf, type EventClass } from '../notify/classes.js';
import { prefsOf, type Channel } from '../notify/prefs.js';

/**
 * 站内通知（「找过我的」）读模型。
 *
 * 没有通知表。这个文件把 `events` 投影成「谁该看到哪一条」，只额外读一张
 * `notification_reads`（每个人读到事件流的哪一格）。理由写在 schema.ts 那张表上，
 * 一句话：历史免费、没有第二份副本可以漂移。
 *
 * ── 派生规则（事件类型 → 观众 → 怎么判断）
 *
 * | 事件 type | 谁收到 | 判断依据 |
 * |---|---|---|
 * | requirement.created（进入收集） | 提出人 + 全部 PM | `r.requester` 按**姓名**匹配 members；`role='pm'` 直接是观众 |
 * | requirement.evaluated（进入待设计） | 负责人 | `r.owner_member_id` |
 * | requirement.review_requested（进入待评审） | 派单的评审人 | `review_assignments` 里**覆盖这条事件时刻**的那一行 |
 * | requirement.review_rejected（评审打回） | 负责人 | `r.owner_member_id` |
 * | requirement.auto_test（进入测试中） | 负责人 | `r.owner_member_id` |
 * | requirement.bounced（打回开发中） | 负责人 | `r.owner_member_id` |
 *
 * 其余事件类型（scheduled / review_passed / auto_dev / auto_live / updated / deleted /
 * restored / uemaster.attached / prd.fetched / release.*）**没有「按关系」的站内观众**，
 * 不产生通知——不为了「有东西看」往 feed 里塞行。
 *
 * ── P4-04：条线 / 超管的扇出（规则「超管收到每一条变更，条线负责人收本线全部变更」）
 *
 * | 观众 | 收什么 | 条件 |
 * |---|---|---|
 * | 超管（`product_owner`） | 全部需求事件 | 只排除他自己做的事（`e.actor <> 我`） |
 * | 条线负责人（`line` + `role` 都对得上） | 「本线」= **负责人在这条线上**的全部事件 | 同上 |
 * | 任何人 | 拒绝 / 搁置 | 与上一档同一条扇出规则；这一档由 `rejected` 这个开关单独控制 |
 *
 * P4-06：「本线」的判据从 `r.type`（需求类型）换成了**负责人那一行的 `line`**。
 * 一条商业类需求由功能线 PM 负责时，它属于功能线；功能线负责人收它的全部变更，
 * 商业线负责人收不到。这条规则与 `can()` 的锚点是同一句话，所以两处不可能给出
 * 两个答案——「能改它的人」与「收它通知的人」必须是同一批人。
 *
 * 三条细节：
 *
 * 1. **排除本人动作**。通知的用途是「别人动了你关心的东西」；自己点的按钮自己知道。
 *    不做这件事的后果是，超管每改一条需求都会收到一条「你可能该看看」——一个永远
 *    亮着的红点，等于没有红点。
 * 2. **PM 不在扇出里**。PM 的观众身份仍然是「提出人 / 负责人 / 被派单的评审人」
 *    （上面那张老表），条线不给他任何额外的可见性。条线是人的归属，它授予权限的
 *    方式只有一条：它让**那条线的负责人**成为「能改这条需求的人」，扇出跟着那句话走。
 * 3. **关掉就是关掉，但它现在是三档之一**（P4-07，`notify_prefs` = 两个频道 × 三档）。
 *    一个把站内设成 `off` 的超管**什么都收不到**（feed 空、铃铛隐藏），而不是
 *    「只收重要的」：`off` 的唯一用途是「我不看」，替人判断哪条重要是另一种不听话。
 *    而 `key` 才是「只收重要的」——它由**产品**定义（`action` + `outcome` 两类，
 *    见 `src/core/notify/classes.ts`），不是由读侧在每个 `if` 里临时判断。站内与企微
 *    两个频道各读各的档位：一个人可以只看铃铛、不被打扰。
 *
 * 两条容易走错的细节，写在这里免得下一个人再推一遍：
 *
 * 1. **待评审的观众不是当前 handed 派单**。一条需求可以被评审打回、再提交，于是同一
 *    条需求有多行派单；读「现在 handed 的那一行」会把**第一轮**的 review_requested
 *    安到第二轮的评审人头上。`review_assignments` 没有 created_at，只有 decided_at，
 *    所以「覆盖这个时刻的那一行」取的是：`decided_at is null or decided_at >= e.at`
 *    里 decided_at 最早的那一行（null = 还没收口，排最后）。没有这一行 → 没有观众：
 *    数据损坏时宁可不通知，也不猜一个收件人。
 *
 * 2. **提出人是自由文本，不是账号**（schema.ts 的 `requirements.requester` 注释）。
 *    唯一的解析方式是同名匹配 `members.name`。一个名字对应多个人时（名册里重名）
 *    **每个人都收到**——姓名是这里唯一可用的键，挑其中一个等于替现实做决定；一个
 *    都对不上时**只有 PM 收到**（spec §8 那一行是「提出人 + PM」，PM 那一半仍然成立）。
 *    重名 / 查无此人都不是错误，读侧不抛。
 *
 * 已删除的需求（`deleted_at is not null`）整条不出现：通知行的唯一动作是打开抽屉，
 * 而抽屉对一条已删除的需求什么也打不开。宁可少一行，不留一个死链接。
 */

export type Notice = {
  /** events.seq：这一行的身份，也是已读水位线的单位。 */
  eventSeq: number;
  /** 事件时刻（ISO 串，页面自己按上海时区折成 MM-DD HH:mm）。 */
  at: string;
  /** 事件类型原文（`requirement.auto_test` 这种）。 */
  type: string;
  /**
   * 这条通知指向的需求；`null` = **成员级 / 全局级**提醒（P2 的企微绑定自愈，
   * 2026-11-08 起再加 `clock.tick_skipped`）。
   *
   * 三列一起可空，因为它们回答的是同一件事（「打开哪一条」）。一条
   * `member.wecom_unlinked` 没有需求可挂——它的动作是「去设置里点查一下」，给它编一个
   * PAN 编号或者挂到某条需求上都会点开一个无关的抽屉。一条 `clock.tick_skipped` 说的是
   * 「这一轮有 N 条钟推不动」，挂到其中一条上只会点开那一行，而要看的是那一批。
   */
  requirementId: string | null;
  number: number | null;
  title: string | null;
  /** 一句话：发生了什么 + 要读者做什么（含需求编号，见文件头的示例）。 */
  line: string;
  unread: boolean;
};

/** 默认条数与上限。面板一屏放不下 30 条，但轮询要的是一个确定的数。 */
export const DEFAULT_NOTICE_LIMIT = 30;
export const MAX_NOTICE_LIMIT = 200;

type Payload = Record<string, unknown>;

function parsePayload(raw: string): Payload {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Payload)
      : {};
  } catch {
    return {};
  }
}

function text(payload: Payload, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 原因可能是一段话；通知行只有一行，超过长度就截断（省略号是标点，不是说明文字）。 */
function clip(text: string, max = 30): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * 事件 → 那一行中文的「句子部分」（不含编号与标题）。
 *
 * 拆成两半是因为企微推送要的是另一种排版：
 *
 * ```
 * **PAN-12「导出任务队列」**
 * 进入待评审，等你签字。
 * ```
 *
 * 而铃铛要的是一行 `PAN-12「导出任务队列」进入待评审，等你签字`。两处**必须**说
 * 同一句话——否则「铃铛里写的是 A、企微推送写的是 B」会让同一条事件变成两条新闻。
 * 所以句子只有这一份，两个调用点各自加自己的排版。
 *
 * `default` 只是兜底：观众谓词里列出的类型全都有分支，一个新事件类型不会自己溜进
 * feed——但万一有人只改了谓词，这里也不会让页面炸掉或漏出一句英文。
 */
export function sentenceOf(type: string, payload: Payload): string {
  switch (type) {
    case 'requirement.created':
      return '进入收集，等提出人补必填';
    case 'requirement.evaluated':
      return '进入待设计，等负责人出正式 PRD';
    case 'requirement.review_requested':
      return '进入待评审，等你签字';
    case 'requirement.review_rejected': {
      const reason = text(payload, 'reason');
      return reason ? `评审打回：${clip(reason)}，改完再提交` : '评审打回，改完再提交';
    }
    case 'requirement.auto_test':
      return '进入测试中，跟测试进度';
    case 'requirement.bounced': {
      const due = text(payload, 'newCommitDueAt');
      return due ? `被打回开发中，新承诺 ${due}` : '被打回开发中';
    }
    case 'requirement.rejected': {
      const reason = text(payload, 'reason');
      return reason ? `被拒绝：${clip(reason)}` : '被拒绝';
    }
    case 'requirement.shelved': {
      const reason = text(payload, 'reason');
      return reason ? `被搁置：${clip(reason)}` : '被搁置';
    }
    case 'requirement.owner_assigned': {
      const to = text(payload, 'to');
      return to ? `负责人改成 ${to}` : '换了负责人';
    }
    default:
      return '有新的流转';
  }
}

/** 那一行开头的身份：`PAN-12「导出任务队列」`。企微消息的第一行加粗就是它。 */
export function keyOf(number: number, title: string): string {
  return `PAN-${number}「${title}」`;
}

/**
 * 成员级提醒的一整行（没有需求可挂的那些）。
 *
 * 与需求事件一样要回答两件事：**是谁**、**要读者做什么**。这里必须点到「去设置里点
 * 一次查一下」——只说「吕品的企微绑定有问题」等于把一个诊断结果丢给人，而他要的是
 * 下一步动作。
 */
export function memberLineOf(type: string, payload: Payload): string {
  if (type === 'member.wecom_unlinked') {
    const name = text(payload, 'memberName') ?? '有人';
    const reason = text(payload, 'reason');
    const streak = typeof payload.streak === 'number' ? payload.streak : 0;
    if (reason === 'failing') {
      return `「${name}」的企微账号最近 ${streak} 条通知都没发出去——去设置里点一次「查一下」确认企微账号`;
    }
    return `「${name}」还没对上企微账号，通知发不出去——去设置里点一次「查一下」`;
  }
  if (type === 'clock.tick_skipped') {
    // 一行说清三件事：有多少条钟推不动、分别是哪几条（点名，超管才找得到）、
    // 以及「它不会自己好」。只报一个数字等于把诊断丢给人，他要的是下一步动作。
    const count = typeof payload.count === 'number' ? payload.count : 0;
    const numbers = Array.isArray(payload.numbers)
      ? payload.numbers.filter((value): value is number => typeof value === 'number')
      : [];
    const more = typeof payload.more === 'number' ? payload.more : 0;
    const named = numbers.map((number) => `PAN-${number}`).join('、');
    const range = more > 0 ? `${named}…（另有 ${more} 条）` : named;
    const reasons = reasonSummary(payload.reasons);
    const tail = reasons === null ? '' : `：${reasons}`;
    return `时钟跳过 ${count} 条需求${range === '' ? '' : `（${range}）`}${tail}——这几行的日期或排期版本坏了，不补就永远不会自己往前走`;
  }
  return '有一条成员提醒';
}

/**
 * `{ 缺少提测日: 21, 没有排期版本: 17 }` → `缺少提测日 21 · 没有排期版本 17`。
 *
 * 读不懂（老形状、手改的坏值）就返回 null 而不是猜：一句错的原因比没有原因更坏。
 * 顺序按条数降序，让「主要是哪一类坏」先出来。
 */
function reasonSummary(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const pairs = Object.entries(raw as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
    .sort((a, b) => b[1] - a[1]);
  if (pairs.length === 0) return null;
  return pairs.map(([reason, count]) => `${reason} ${count}`).join(' · ');
}

/**
 * 成员级 / 全局级提醒在企微消息里的抬头。
 *
 * 与 `memberLineOf` 同一个理由：两类提醒共用一个「第一行」，写死一句「企微绑定提醒」
 * 会让时钟跳过的那条推送顶着错误的标题——而这两件事要读者做的事完全不同。
 */
export function memberHeadlineOf(type: string): string {
  if (type === 'clock.tick_skipped') return '时钟推进提醒';
  return '企微绑定提醒';
}

/** 铃铛里的一整行：编号 + 标题 + 句子；没有需求的那一类只给句子。 */
function lineOf(
  type: string, payload: Payload, number: number | null, title: string | null,
): string {
  if (number === null || title === null) return memberLineOf(type, payload);
  return `${keyOf(number, title)}${sentenceOf(type, payload)}`;
}

/**
 * 口味：**两个频道 × 三档**，解释权在 `src/core/notify/prefs.ts`（P4-07 起）。
 *
 * 这个文件从 P4-03 起自己实现过一版（`inherit` / `changed` / `rejected` 三个布尔），
 * 现在整块搬走了——站内与企微**必须**读同一份解析，否则「铃铛收、推送不发」这类
 * 分叉会在两个文件的默认值上悄悄发生。这里只 re-export，保持既有 import 路径可用
 * （设置页、用例、`src/core/members/manage.ts` 都在用它）。
 */
export {
  DEFAULT_LEVEL, DEFAULT_PREFS, LEVELS, LEVEL_LABEL, CHANNEL_LABEL, prefsOf, prefsJson,
  levelOf, isLevel, withLevel, type Channel, type Level, type NotifyPrefs,
} from '../notify/prefs.js';

/** 「这条事件点到这位成员」的谓词。
 *
 * 通知列表与未读数**必须**共用它：两处各写一份，迟早出现「红点 3 条、点开只有 2 条」。
 *
 * 用成员 id 而不是姓名做键；提出人那一项才按姓名比（那是自由文本字段）。PM 判断也
 * 在这里做（`me.role = 'pm'`），所以调用方不需要另传角色。
 *
 * 扇出的两档（超管 / 条线负责人）按**角色与线**在 JS 里算好之后拼进 SQL：`member`
 * 已经是一个具体的行，管理员就是管理员，功能线负责人就是功能线——把它们写成
 * `... and me.role = 'product_owner'` 这样的谓词只会让同一条规则在库里再判一次，
 * 而库里的 role 与调用方手里的 role 是同一行。
 *
 * P4-07 起多一个 `channel` 参数：同一个人在两个频道上可能有**不同**的档位。档位那一层
 * 只做一件事——把事件类型按类筛掉（`levelFilter`），它包在整条谓词外面，所以
 * 「谁该收到」与「他要不要这一类」是两个独立的、各写一次的问题。
 */
function addressed(member: Member, channel: Channel = 'site'): SQL {
  const level = prefsOf(member.notifyPrefs)[channel];
  // `off` 的过滤条件是 `false`：feed 真的空、铃铛隐藏。写成「不加过滤」会把
  // 「关」读成「全开」——这一轮最不能犯的错。
  if (level === 'off') return sql`false`;

  const admin = member.role === 'product_owner';
  // 「我是哪条线的负责人」用 roles.ts 的那一个定义（role 与 line 同时成立），
  // 不在这里再写一遍角色名——那份映射长过腿，正是这一轮要拆掉的东西。
  const leadLine = leadLineOf(member);
  const fancied = admin || leadLine !== null;

  // 「这条需求的负责人是不是我这条件线上的人」。用 exists 而不是 join：`addressed`
  // 已经拼在 events × requirements 的查询里，再 join 一张 members 会让别名与行数都
  // 变得不可预期（一条需求没有负责人时不该因为 join 放大任何一行）。
  const inMyLine = leadLine === null
    ? sql``
    : sql` and exists (select 1
                         from members owner
                        where owner.id = r.owner_member_id
                          and owner.line = ${leadLine})`;

  const base = sql`(
      (e.type = 'requirement.review_requested'
        and (select ra.reviewer_member_id
               from review_assignments ra
              where ra.requirement_id = e.requirement_id
                and (ra.decided_at is null or ra.decided_at >= e.at)
              order by (ra.decided_at is null) asc, ra.decided_at asc
              limit 1) = ${member.id})
      or (e.type in ('requirement.evaluated', 'requirement.review_rejected',
                     'requirement.bounced', 'requirement.auto_test')
          and r.owner_member_id = ${member.id})
      or (e.type = 'requirement.created'
          and exists (select 1
                        from members me
                       where me.id = ${member.id}
                         and (me.name = r.requester or me.role = 'pm')))
    )`;

  // 扇出：超管收每一条变更，条线负责人收本线每一条变更，都排除自己做的事。
  // P4-03 那版在这里按 `changed` / `rejected` 拆成两档；现在拆档由上面的
  // `levelFilter` 统一做（类的划分是产品口径，不该在三个地方各写一遍）。
  //
  // `e.requirement_id is not null` 是 P2 加的一道：成员级事件（`member.wecom_unlinked`、
  // `release.*`）没有需求可挂，而这条扇出说的是「**需求**变更」——不加这一条，超管会
  // 连同发版窗口的新建/删除一起收进来，那是这次改动之外的一整类新噪音。
  const fanout = fancied
    ? sql`(e.requirement_id is not null and e.actor <> ${member.name}${inMyLine})`
    : sql`false`;

  // 成员级 / 全局级提醒（P2「企微绑定自愈」，2026-11-08 起再加时钟跳过）：**只有超管收**。
  // 它们没有「谁的线」可锚——绑不上的人属于名册、推不动的行属于数据，都不属于某条需求；
  // 而能修它们的人都是超管（设置页的「查一下」/ 排期里的日期与版本）。
  // 并且刻意**不**排除自己做的动作：这一条是 `actor = 'system'` 写下的，不属于任何人。
  const memberAlert = admin
    ? sql`(e.requirement_id is null
           and e.type in ('member.wecom_unlinked', 'clock.tick_skipped'))`
    : sql`false`;

  return sql`((${base} or ${fanout} or ${memberAlert}) and ${levelFilter(level)})`;
}

type NoticeRow = {
  seq: number;
  at: string | Date;
  type: string;
  /** 成员级提醒（`member.*`）没有需求可挂；`release.*` 也是这一类。 */
  requirement_id: string | null;
  number: number | null;
  title: string | null;
  payload: string;
  last_seq: number;
};

/**
 * 「事件 × 需求」的公共形状：**left join**，外加软删除那一格。
 *
 * 四处查询（铃铛、红点、水位线、企微候选）都用它——它们必须看见同一批事件，否则
 * 「铃铛有 3 条、红点 2 条」这种分歧会随下一次改动悄悄长出来。写成两个片段而不是
 * 抄四遍 `from`：P2 加成员级事件时这正是唯一需要改的地方。
 *
 * `r.deleted_at is null or e.requirement_id is null` 里的后半句是 P2 加的：inner join
 * 会把没有需求的事件整类扔掉（`member.wecom_unlinked` 就是这一类），而
 * `r.deleted_at is null` 对 left join 出来的 NULL 行恒为 NULL（= 被过滤掉）——
 * 少了后半句，加了 left join 也一条都读不到。
 */
const EVENTS_FROM = sql`from events e left join requirements r on r.id = e.requirement_id`;
const ALIVE = sql`(r.deleted_at is null or e.requirement_id is null)`;

/** pg 对 timestamptz 给的是 Date（连接级 parser），测试里也可能是字符串。统一成 ISO。 */
function asIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function limitOf(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_NOTICE_LIMIT;
  return Math.min(MAX_NOTICE_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * 「找过我的」：按 seq 倒序（新的在上面），最多 `limit` 条（默认 30）。
 *
 * 一条 SQL 取完，包括这一页每条的 `unread`：`notification_reads` 是每人一行的
 * 水位线，left join 一次就够，不需要第二条查询去拼。
 */
export async function notificationsFor(
  db: Db,
  member: Member,
  opts: { limit?: number } = {},
): Promise<Notice[]> {
  const limit = limitOf(opts.limit);
  const res = await db.execute<NoticeRow>(sql`
    select e.seq, e.at, e.type, e.requirement_id, e.payload,
           r.number, r.title,
           coalesce(nr.last_seq, 0) as last_seq
      ${EVENTS_FROM}
      left join notification_reads nr on nr.member_id = ${member.id}
     where ${ALIVE}
       and ${addressed(member)}
     order by e.seq desc
     limit ${limit}`);

  return res.rows.map((row) => {
    const number = row.number === null ? null : Number(row.number);
    return {
      eventSeq: Number(row.seq),
      at: asIso(row.at),
      type: row.type,
      requirementId: row.requirement_id,
      number,
      title: row.title,
      line: lineOf(row.type, parsePayload(row.payload), number, row.title),
      unread: Number(row.seq) > Number(row.last_seq),
    };
  });
}

/**
 * 点到这位成员、在某个频道上**还没有发送成功**的事件（P4-07 的推送用）。
 *
 * 与 `notificationsFor` 共用同一个 `addressed` 谓词——这一点是刻意的：企微推什么，
 * 必须**恰好**是铃铛里会出现的那一批（同一档位、同一批观众），否则会出现「铃铛有、
 * 手机没响」这种只能靠人对时间线才发现的 bug。
 *
 * 三条与 feed 不同的地方：
 *
 * 1. **升序**（`order by e.seq asc`）。feed 看最新的，推送补最旧的：停机一天之后
 *    先补的是最早那几条，否则每人每轮只发 N 条、永远追不上。
 * 2. **带投递状态**。`sent` 那一行排除掉（那是唯一索引的同一条规则在查询侧的另一半），
 *    `failed` / `skipped` 仍然算候选——一次网络抖动不该让一条通知永久消失。
 * 3. **不读已读水位线**。铃铛里的「读过」是站内的事；企微那边有没有发过，只看
 *    `notify_deliveries`。混用两个记号会让「我点掉了铃铛」变成「手机也不会响」。
 */
export type DeliveryCandidate = {
  eventSeq: number;
  at: string;
  type: string;
  /** 事件类（action / outcome / change）。报告与消息里都用它）。 */
  cls: EventClass;
  requirementId: string | null;
  number: number | null;
  title: string | null;
  /** 企微消息的第一行（加粗）：`PAN-12「导出任务队列」`；成员级提醒是一句抬头。 */
  headline: string;
  /** 第二行：一句话说清发生了什么、要他做什么。 */
  sentence: string;
};

export async function pendingDeliveries(
  db: Db,
  member: Member,
  opts: { channel: Channel; limit?: number },
): Promise<DeliveryCandidate[]> {
  const limit = limitOf(opts.limit);
  const res = await db.execute<NoticeRow>(sql`
    select e.seq, e.at, e.type, e.requirement_id, e.payload,
           r.number, r.title,
           0 as last_seq
      ${EVENTS_FROM}
      left join notify_deliveries d
        on d.member_id = ${member.id}
       and d.event_seq = e.seq
       and d.channel = ${opts.channel}
     where ${ALIVE}
       and ${addressed(member, opts.channel)}
       and (d.id is null or d.status <> 'sent')
     order by e.seq asc
     limit ${limit}`);

  return res.rows.map((row) => {
    const payload = parsePayload(row.payload);
    const number = row.number === null ? null : Number(row.number);
    // 成员级 / 全局级提醒：没有需求编号可加粗，第一行给一个「这是什么」的抬头，
    // 第二行仍是同一句话（铃铛里那一行的 `memberLineOf`）——两个频道说同一句话那条
    // 规矩不变。抬头按事件类型分（绑定自愈 vs 时钟跳过），否则推送会顶错标题。
    const headline = number === null || row.title === null
      ? memberHeadlineOf(row.type)
      : keyOf(number, row.title);
    const sentence = number === null
      ? memberLineOf(row.type, payload)
      : sentenceOf(row.type, payload);
    return {
      eventSeq: Number(row.seq),
      at: asIso(row.at),
      type: row.type,
      cls: classOf(row.type),
      requirementId: row.requirement_id,
      number,
      title: row.title,
      headline,
      sentence,
    };
  });
}

/**
 * 未读数：点到这位成员、且 seq 在水位线之后的**全部**事件（不受 limit 截断）。
 *
 * 红点不能只数当前这一页：通知链接的最后一条与徽标上的数字必须是同一个问题的答案。
 */
export async function unreadCount(db: Db, member: Member): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
      ${EVENTS_FROM}
      left join notification_reads nr on nr.member_id = ${member.id}
     where ${ALIVE}
       and ${addressed(member)}
       and e.seq > coalesce(nr.last_seq, 0)`);
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * 点到这位成员的最新一条事件的 seq（没有就是 null）。
 *
 * 「全部已读」用它，而不是用**当前这一页**的最后一条：feed 有上限（30），
 * 拿页尾当水位线会让「全部已读」之后红点仍然亮着——因为第 31 条还看不见。
 */
export async function latestNoticeSeq(db: Db, member: Member): Promise<number | null> {
  const res = await db.execute<{ seq: number | null }>(sql`
    select max(e.seq) as seq
      ${EVENTS_FROM}
     where ${ALIVE}
       and ${addressed(member)}`);
  const value = res.rows[0]?.seq;
  return value === null || value === undefined ? null : Number(value);
}

export type NotifyView = { notices: Notice[]; unread: number };

/** 页面首帧与轮询共用的那一个返回形状：列表 + 未读数，永远同一次快照。 */
export async function notifyView(
  db: Db, member: Member, opts: { limit?: number } = {},
): Promise<NotifyView> {
  const [notices, unread] = await Promise.all([
    notificationsFor(db, member, opts),
    unreadCount(db, member),
  ]);
  return { notices, unread };
}

/**
 * 已经读到的位置：把水位线推到 `upToSeq`，**只前进不后退**（greatest）。
 *
 * 两处夹取，各有各的道理：
 * - 下界 0：负数没有意义，`seq > -3` 会让所有事件都变成未读。
 * - 上界 = `max(events.seq)`：一个比事件流还大的值（手改的请求、时钟错乱、将来
 *   换了 seq 的起点）如果被原样存下，之后**所有**新事件都落在水位线后面，红点永远
 *   不再亮——一个不会响的通知比没有通知更坏。既有的更大值也算在这一条里：
 *   greatest 之后再 least，等价于「新的水位线 = clamp(max(旧值, 请求值))」。
 *
 * 返回真正落库的那个值（页面拿它更新本地状态，不必再读一次）。
 */
export async function markRead(db: Db, member: Member, upToSeq: number): Promise<number> {
  const wanted = Number.isFinite(upToSeq) ? Math.max(0, Math.trunc(upToSeq)) : 0;
  const res = await db.execute<{ last_seq: number }>(sql`
    insert into notification_reads (member_id, last_seq, updated_at)
    values (
      ${member.id},
      least(${wanted}, (select coalesce(max(seq), 0) from events)),
      now()
    )
    on conflict (member_id) do update
       set last_seq = greatest(notification_reads.last_seq, excluded.last_seq),
           updated_at = now()
    returning last_seq`);
  return Number(res.rows[0]?.last_seq ?? 0);
}

/**
 * 当前身份对应的成员行。P4-04 起这件事只有一处实现（`src/core/read/member.ts`），
 * 这里 re-export 一次：通知要按 id 存水位线，而「我是谁」的解析顺序（会话 → 环境变量
 * → 第一个超管）必须与页面、服务层用同一条，否则铃铛会替另一个人亮红点。
 *
 * 没有任何成员时 `currentMemberRow` 会抛 `no_member`；通知是附加物，所以这里吞掉它
 * 返回 null——一个空名册不该让整页 500（登录页会显示同一句中文）。
 */
export async function currentMemberRowOrNull(): Promise<Member | null> {
  try {
    return await currentMemberRow();
  } catch {
    return null;
  }
}

export { currentMemberRow };
