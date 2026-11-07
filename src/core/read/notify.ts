import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Db } from '../../db/client.js';
import { currentMemberRow, type Member } from './member.js';
import { leadLineOf } from '../auth/roles.js';

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
 * 3. **关掉就是关掉**（`notify_prefs`）。一个关了通知的超管**什么都收不到**，而不是
 *    「只收重要的」：这条规则的唯一用途是「我不看」，替人判断哪条重要是另一种不听话。
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
    case 'requirement.rejected': {
      const reason = text(payload, 'reason');
      return reason ? `${key}被拒绝：${clip(reason)}` : `${key}被拒绝`;
    }
    case 'requirement.shelved': {
      const reason = text(payload, 'reason');
      return reason ? `${key}被搁置：${clip(reason)}` : `${key}被搁置`;
    }
    case 'requirement.owner_assigned': {
      const to = text(payload, 'to');
      return to ? `${key}负责人改成 ${to}` : `${key}换了负责人`;
    }
    default:
      return `${key}有新的流转`;
  }
}

/**
 * 通知口味。null / 坏 JSON / 缺字段一律「按默认」（全开）——一个读不懂的设置不该
 * 让通知静默消失；反过来，显式写 `false` 才是真的关。
 *
 * 两个开关：
 * - `changed`：这一类里的「全部变动」（进入收集/待设计/待评审、打回、换负责人……）；
 * - `rejected`：拒绝 / 搁置。单独一个开关，因为规则 3 里它是一件**另外**的事
 *   （「被叫停」比「又动了一步」更值得看一眼）。
 */
export type NotifyPrefs = { inherit: boolean; changed: boolean; rejected: boolean };

export const DEFAULT_PREFS: NotifyPrefs = { inherit: true, changed: true, rejected: true };

export function prefsOf(raw: string | null | undefined): NotifyPrefs {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_PREFS;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_PREFS;
    const record = value as Record<string, unknown>;
    // `inherit: true` 就是「按角色默认」，显式写在里面也不该覆盖具体开关——
    // 它表达的是「别管我」，而不是「全开」。所以只有 inherit === false 时才读具体项。
    if (record.inherit !== false) return DEFAULT_PREFS;
    return {
      inherit: false,
      changed: record.changed !== false,
      rejected: record.rejected !== false,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** 拒绝 / 搁置这两类。扇出用它们把 `rejected` 开关单独拎出来。 */
const REJECTED_TYPES = sql`('requirement.rejected', 'requirement.shelved')`;

/**
 * 「这条事件点到这位成员」的谓词。通知列表与未读数**必须**共用它：两处各写一份，
 * 迟早出现「红点 3 条、点开只有 2 条」。
 *
 * 用成员 id 而不是姓名做键；提出人那一项才按姓名比（那是自由文本字段）。PM 判断也
 * 在这里做（`me.role = 'pm'`），所以调用方不需要另传角色。
 *
 * 扇出的两档（超管 / 条线负责人）按**角色与线**在 JS 里算好之后拼进 SQL：`member`
 * 已经是一个具体的行，管理员就是管理员，功能线负责人就是功能线——把它们写成
 * `... and me.role = 'product_owner'` 这样的谓词只会让同一条规则在库里再判一次，
 * 而库里的 role 与调用方手里的 role 是同一行。
 */
function addressed(member: Member): SQL {
  const prefs = prefsOf(member.notifyPrefs);
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

  const fanout: SQL[] = [];
  if (fancied && prefs.changed) {
    fanout.push(sql`(e.type not in ${REJECTED_TYPES} and e.actor <> ${member.name}${inMyLine})`);
  }
  if (fancied && prefs.rejected) {
    fanout.push(sql`(e.type in ${REJECTED_TYPES} and e.actor <> ${member.name}${inMyLine})`);
  }

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

  if (fanout.length === 0) return base;
  return sql`(${base} or ${sql.join(fanout, sql` or `)})`;
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
