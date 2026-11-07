import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { Member } from './roles.js';

/**
 * 名字 → 名册上那一行。签名层到处只有名字（`actor` 是自由文本字段，P1 的 spec §2），
 * 而权限判断要的是 id / role / line / 停用状态 —— 这一处是那座桥。
 *
 * 为什么所有查询都带 `deactivated_at is null` 由调用方决定：
 * - `memberByName` 给出**整行**（含停用的人），登录要拿它来判断「这个账号停了」；
 * - `activeMemberByName` 只给活着的人，权限与身份解析用它——一个停用的人不该因为
 *   手里还留着一个签名没过期的 cookie 就继续能动东西。
 */

type Row = {
  id: string;
  name: string;
  role: string;
  line: string | null;
  deactivated_at: Date | string | null;
  notify_prefs: string | null;
  wecom_userid: string | null;
};

function toMember(row: Row): Member {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    line: row.line,
    deactivatedAt: row.deactivated_at === null
      ? null
      : (row.deactivated_at instanceof Date ? row.deactivated_at : new Date(row.deactivated_at)),
    notifyPrefs: row.notify_prefs,
    wecomUserId: row.wecom_userid,
  };
}

/** 任意执行器（`db` 或一个事务）。权限查询常常发生在已经开好的事务里。 */
export type Exec = Pick<Db, 'execute'>;

/** 按名字取一行（含已停用的）。重名取 id 最小的那一行——与 `memberIdByName` 同口径。 */
export async function memberByName(exec: Exec, name: string): Promise<Member | null> {
  const trimmed = name.trim();
  if (trimmed === '') return null;
  const res = await exec.execute<Row>(sql`
    select id, name, role, line, deactivated_at, notify_prefs, wecom_userid
      from members
     where name = ${trimmed}
     order by id
     limit 1`);
  const row = res.rows[0];
  return row === undefined ? null : toMember(row);
}

/** 按 id 取一行（含已停用的）。转交、成员管理都用它。 */
export async function memberById(exec: Exec, memberId: string): Promise<Member | null> {
  const res = await exec.execute<Row>(sql`
    select id, name, role, line, deactivated_at, notify_prefs, wecom_userid
      from members where id = ${memberId} limit 1`);
  const row = res.rows[0];
  return row === undefined ? null : toMember(row);
}

/** 同上，但停用的人当作不存在。权限判断一律用这个。 */
export async function activeMemberByName(exec: Exec, name: string): Promise<Member | null> {
  const member = await memberByName(exec, name);
  return member !== null && member.deactivatedAt === null ? member : null;
}

/**
 * 第一个超管（按 `created_at, id`）。
 *
 * `currentMember()` 的最后一级兜底用它，**不再是写死的「吕品」**：owner 本人是房超，
 * 而那个常量让他在自己机器上每次都被显示成吕品——一个把「我是谁」答错的身份层，
 * 后面所有权限判断都跟着错。
 *
 * 只认活着的超管：一个停用的超管不该继续当「默认身份」。
 */
export async function firstProductOwner(exec: Exec): Promise<Member | null> {
  const res = await exec.execute<Row>(sql`
    select id, name, role, line, deactivated_at, notify_prefs, wecom_userid
      from members
     where role = 'product_owner' and deactivated_at is null
     order by created_at, id
     limit 1`);
  const row = res.rows[0];
  return row === undefined ? null : toMember(row);
}

/** 名册（默认只给活人；设置页要看已停用的才传 `includeDeactivated`）。 */
export async function loadMembers(
  exec: Exec,
  opts: { includeDeactivated?: boolean } = {},
): Promise<Member[]> {
  const where = opts.includeDeactivated === true ? sql`` : sql`where deactivated_at is null`;
  const res = await exec.execute<Row>(sql`
    select id, name, role, line, deactivated_at, notify_prefs, wecom_userid
      from members ${where}
     order by name, id`);
  return res.rows.map(toMember);
}
