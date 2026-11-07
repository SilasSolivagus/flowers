import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Db } from '../../db/client.js';
import { currentMember, type Member } from './member.js';

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
 * rejected / shelved / restored / uemaster.attached / prd.fetched / release.*）**没有
 * 站内观众**，不产生通知——不为了「有东西看」往 feed 里塞行。
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
  requirementId: string;
  number: number;
  title: string;
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
 * 事件 → 那一行中文。
 *
 * 形状固定为「编号『标题』做了什么，要你做什么」。`default` 只是兜底：观众谓词里
 * 列出的类型全都有分支，一个新事件类型不会自己溜进 feed——但万一有人只改了谓词，
 * 这里也不会让页面炸掉或漏出一句英文。
 */
function lineOf(type: string, payload: Payload, number: number, title: string): string {
  const key = `PAN-${number}「${title}」`;
  switch (type) {
    case 'requirement.created':
      return `${key}进入收集，等提出人补必填`;
    case 'requirement.evaluated':
      return `${key}进入待设计，等负责人出正式 PRD`;
    case 'requirement.review_requested':
      return `${key}进入待评审，等你签字`;
    case 'requirement.review_rejected': {
      const reason = text(payload, 'reason');
      return reason
        ? `${key}评审打回：${clip(reason)}，改完再提交`
        : `${key}评审打回，改完再提交`;
    }
    case 'requirement.auto_test':
      return `${key}进入测试中，跟测试进度`;
    case 'requirement.bounced': {
      const due = text(payload, 'newCommitDueAt');
      return due ? `${key}被打回开发中，新承诺 ${due}` : `${key}被打回开发中`;
    }
    default:
      return `${key}有新的流转`;
  }
}

/**
 * 「这条事件点到这位成员」的谓词。通知列表与未读数**必须**共用它：两处各写一份，
 * 迟早出现「红点 3 条、点开只有 2 条」。
 *
 * 用成员 id 而不是姓名做键；提出人那一项才按姓名比（那是自由文本字段）。PM 判断也
 * 在这里做（`me.role = 'pm'`），所以调用方不需要另传角色。
 */
function addressed(member: Member): SQL {
  return sql`(
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
}

type NoticeRow = {
  seq: number;
  at: string | Date;
  type: string;
  requirement_id: string;
  number: number;
  title: string;
  payload: string;
  last_seq: number;
};

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
      from events e
      join requirements r on r.id = e.requirement_id
      left join notification_reads nr on nr.member_id = ${member.id}
     where r.deleted_at is null
       and ${addressed(member)}
     order by e.seq desc
     limit ${limit}`);

  return res.rows.map((row) => ({
    eventSeq: Number(row.seq),
    at: asIso(row.at),
    type: row.type,
    requirementId: row.requirement_id,
    number: Number(row.number),
    title: row.title,
    line: lineOf(row.type, parsePayload(row.payload), Number(row.number), row.title),
    unread: Number(row.seq) > Number(row.last_seq),
  }));
}

/**
 * 未读数：点到这位成员、且 seq 在水位线之后的**全部**事件（不受 limit 截断）。
 *
 * 红点不能只数当前这一页：通知链接的最后一条与徽标上的数字必须是同一个问题的答案。
 */
export async function unreadCount(db: Db, member: Member): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
      from events e
      join requirements r on r.id = e.requirement_id
      left join notification_reads nr on nr.member_id = ${member.id}
     where r.deleted_at is null
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
      from events e
      join requirements r on r.id = e.requirement_id
     where r.deleted_at is null
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
 * 当前身份对应的成员行（cookie → 姓名 → members）。
 *
 * 读侧到处只有姓名（P1 的 actor 是自由文本），但通知要按 id 存水位线。重名时取
 * `memberIdByName` 的同一口径（order by id limit 1）——两条入口对「我是谁」必须
 * 给同一个答案。名册里查无此人（cookie 里是离职的人 / 空库）返回 null：通知是
 * 附加物，不该让整页 500。
 */
export async function currentMemberRow(): Promise<Member | null> {
  const name = await currentMember();
  const res = await db.execute<Member>(sql`
    select id, name, role from members where name = ${name} order by id limit 1`);
  return res.rows[0] ?? null;
}
