import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { activeMemberByName, memberById, memberByName, type Exec } from '../auth/members.js';
import { assertCan, requireActor } from '../auth/guard.js';
import {
  isLine, isRole, NO_REQUIREMENT, ROLE_LABEL, type Line, type Member, type Role,
} from '../auth/roles.js';
import {
  assertPassword, DEFAULT_MEMBER_PASSWORD, generatePassword, hashPassword, setPassword,
} from '../auth/password.js';
import { requirePlainObject, asText, parseId } from '../validate.js';
import {
  CHANNELS, CHANNEL_LABEL, isLevel, prefsJson, prefsOf,
  type Level, type NotifyPrefs,
} from '../notify/prefs.js';
import { resolveUserid } from '../notify/wecom.js';

/**
 * 成员管理（P4-04）：建人 / 改人 / 停用 / 重置密码。**只有超管**。
 *
 * 四条产品决定，写在这里而不是散在界面里：
 *
 * 1. **删人 = 停用**（`deactivated_at`）。`requirements.owner_member_id`、
 *    `review_assignments.reviewer_member_id`、`mcp_tokens.member_id` 三处外键都指着
 *    这一行。硬删要么被外键拦住，要么把「谁在哪天承诺了什么」一起删掉——而那条审计线
 *    正是这个系统存在的理由。停用之后：登录被拒（与密码错同一句话）、不再收通知、
 *    不出现在负责人下拉里、手里的 token 全部撤销；历史行照旧指向他。
 * 2. **还占着需求的负责人停不掉**。这不是一道形式上的检查：静默把需求变成无主，
 *    看板上就会出现一批谁都不认领的卡，而「这条需求现在归谁」是整套流程的骨架。
 *    报一句中文（「这个人还负责 N 条需求，先转交」），让人先转交再停用。
 * 3. **条线是人的属性**。PM 也有条线（`line`），条线负责人必须有与自己角色对应的
 *    条线。超管没有条线。这三条在 `normalize` 里逐条校验——它们不是权限（权限只看
 *    role，见 roles.ts），而是「这个人在组织里的位置」，界面按它筛人。
 * 4. **密码只出现一次**。`createMember` 不传密码时用团队统一的那条（2026-11-10 起，
 *    见 `DEFAULT_MEMBER_PASSWORD`）、随返回值给出一次；`resetPassword` 仍然随机生成
 *    一条并只回显一次——「重置」是给忘了密码的人换一条新的，不该把它换回一个人人都
 *    知道的值。库里只有 scrypt 串，之后再也拿不回明文。
 */

const BAD_NAME = '名字不能为空';
const DUPLICATE_NAME = '已经有同名成员了';
/**
 * 邮箱是**登录名**（P4-08）。三句话分开说：
 *
 * - 空的：告诉他该填什么形状（`<拼音>@123pan.com`），而不是「必填」；
 * - 形状不对：只判「有@、两边都不空、没有空白」，**不判域名**——域名是公司的规矩，
 *   不是这个系统的规矩，写死 `@123pan.com` 只会让「换域名」变成一次代码改动；
 * - 重复：唯一索引兜底（并发建人撞 23505），这里先查一次是为了给中文。
 */
const BAD_EMAIL = '邮箱不能为空（登录名是 <拼音>@123pan.com）';
const WRONG_EMAIL = '邮箱格式不对（登录名是 <拼音>@123pan.com）';
const DUPLICATE_EMAIL = '这个邮箱已经有账号了（登录名必须唯一）';

/** 邮箱归一：去空白、折小写。写入与比较都用这一个结果。 */
function normalizeEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function assertEmailShape(email: string): string {
  if (email === '') throw new AppError('invalid', BAD_EMAIL);
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new AppError('invalid', WRONG_EMAIL);
  return email;
}
const BAD_ROLE = '角色只能是超管、功能线负责人、商业线负责人、PM 之一';
const BAD_LINE = '条线只能是功能线或商业线';
const LINE_MISMATCH = '条线负责人的条线必须与角色对应：功能线 → 功能线负责人，商业线 → 商业线负责人';
const PM_NEEDS_LINE = 'PM 也必须属于一条线（功能线 / 商业线）';
const ADMIN_NO_LINE = '超管不挂在任何条线上';
const MEMBER_NOT_FOUND = '成员不存在';
const SELF_DEACTIVATE = '不能停用自己';
const LAST_ADMIN = '至少要留一个超管';

/** 角色的条线约束。三档，穷举，不写「其它随便」。 */
function lineFor(role: Role, line: Line | null): Line | null {
  if (role === 'product_owner') {
    if (line !== null) throw new AppError('invalid', ADMIN_NO_LINE);
    return null;
  }
  if (line === null) throw new AppError('invalid', PM_NEEDS_LINE);
  if (role === 'feature_reviewer' && line !== 'feature') throw new AppError('invalid', LINE_MISMATCH);
  if (role === 'commercial_reviewer' && line !== 'commercial') throw new AppError('invalid', LINE_MISMATCH);
  return line;
}

async function countOwned(exec: Exec, memberId: string): Promise<number> {
  const res = await exec.execute<{ n: number }>(sql`
    select count(*)::int as n from requirements
     where owner_member_id = ${memberId} and deleted_at is null`);
  return Number(res.rows[0]?.n ?? 0);
}

export type CreateMemberInput = {
  name: string;
  /** 登录名（P4-08）。必填：新的人没有邮箱就登不进来。 */
  email: string;
  role: Role;
  line: Line | null;
  /** 不给就用团队统一的初始密码（`DEFAULT_MEMBER_PASSWORD`，见 `password.ts`）。 */
  password?: string | null;
};

export type CreatedMember = { member: Member; password: string };

/**
 * 建一个人。
 *
 * 名字唯一由库上的唯一索引兜底（并发建同名时后一个撞 23505），这里先查一次是为了
 * 给一句中文——索引抛的是英文。
 */
export async function createMember(
  db: Db, actor: string, raw: unknown,
): Promise<CreatedMember> {
  const input = requirePlainObject(raw);
  await assertCan(db, actor, NO_REQUIREMENT, 'manageMembers');

  const name = asText(input.name)?.trim() ?? '';
  if (name === '') throw new AppError('invalid', BAD_NAME);
  const email = assertEmailShape(normalizeEmail(input.email));
  if (!isRole(input.role)) throw new AppError('invalid', BAD_ROLE);
  const role = input.role;
  const rawLine = input.line;
  if (rawLine !== null && rawLine !== undefined && !isLine(rawLine)) {
    throw new AppError('invalid', BAD_LINE);
  }
  const line = lineFor(role, (rawLine ?? null) as Line | null);

  if ((await memberByName(db, name)) !== null) throw new AppError('conflict', DUPLICATE_NAME);
  // 邮箱唯一：同一个人可以有两条名字不同的行，但登录名只能有一个主人。
  {
    const taken = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from members where lower(email) = ${email}`);
    if (Number(taken.rows[0]?.n ?? 0) > 0) throw new AppError('conflict', DUPLICATE_EMAIL);
  }

  // 不传密码 = 用团队统一的那一条（2026-11-10）。仍然**走一遍** `assertPassword`，
  // 让「默认值」与「人手填的值」过同一道长度校验——否则默认值将来被改短时会静默绕过。
  const password = input.password === undefined || input.password === null
    ? assertPassword(DEFAULT_MEMBER_PASSWORD)
    : assertPassword(input.password);
  const hash = await hashPassword(password);

  const inserted = await db.execute<{
    id: string; name: string; email: string; role: string; line: string | null;
  }>(sql`
    insert into members (name, email, role, line, password_hash, password_updated_at)
    values (${name}, ${email}, ${role}, ${line}, ${hash}, now())
    returning id, name, email, role, line`);
  const row = inserted.rows[0];
  if (row === undefined) throw new Error('建人失败：insert 没有返回行');

  return {
    member: {
      id: row.id, name: row.name, email: row.email, role: row.role, line: row.line,
      deactivatedAt: null,
    },
    password,
  };
}

export type UpdateMemberInput = {
  memberId: string;
  role?: Role;
  line?: Line | null;
  /** false = 停用；true = 恢复。停用走的是 deactivateMember 的同一条规矩（见下）。 */
  active?: boolean;
  notifyPrefs?: string | null;
};

/**
 * 改一个人：角色 / 条线 / 启用状态 / 通知口味。
 *
 * 「停用」的两个入口（这里与 `deactivateMember`）共用 `deactivate` 那一段：
 * **还占着需求就不许停**、**不能停自己**、**不能把最后一个超管停掉**。三条规则写在
 * 一个函数里，两个入口不可能说出两种答案。
 */
export async function updateMember(db: Db, actor: string, raw: unknown): Promise<Member> {
  const input = requirePlainObject(raw);
  const me = await assertCan(db, actor, NO_REQUIREMENT, 'manageMembers');
  const memberId = parseId(String(input.memberId ?? ''), MEMBER_NOT_FOUND);

  const target = await loadMember(db, memberId);
  if (target === null) throw new AppError('not_found', MEMBER_NOT_FOUND);

  const role = input.role === undefined ? (target.role as Role) : input.role;
  if (!isRole(role)) throw new AppError('invalid', BAD_ROLE);
  const rawLine = input.line === undefined ? target.line : input.line;
  if (rawLine !== null && !isLine(rawLine)) throw new AppError('invalid', BAD_LINE);
  const line = lineFor(role, rawLine as Line | null);

  if (input.active === false && target.deactivatedAt === null) {
    await assertCanDeactivate(db, me, target);
  }

  const prefs = input.notifyPrefs === undefined ? undefined : input.notifyPrefs;
  if (prefs !== undefined && prefs !== null && typeof prefs !== 'string') {
    throw new AppError('invalid', '通知设置必须是 JSON 文本');
  }

  const deactivated = input.active === undefined
    ? undefined
    : (input.active ? null : new Date());

  const res = await db.execute<{
    id: string; name: string; role: string; line: string | null; deactivated_at: Date | null;
  }>(sql`
    update members set
      role = ${role},
      line = ${line},
      -- 改角色 / 条线就推进会话纪元：旧票立刻作废，等于把这个人踢下线再让他重登。
      -- 不推的话，降权要等他那张 12 小时的票自然过期才生效。
      session_epoch = now()
      ${prefs === undefined ? sql`` : sql`, notify_prefs = ${prefs}`}
      ${deactivated === undefined
    ? sql``
    : (deactivated === null ? sql`, deactivated_at = null` : sql`, deactivated_at = ${deactivated.toISOString()}::timestamptz`)}
     where id = ${memberId}
     returning id, name, role, line, deactivated_at`);
  const row = res.rows[0];
  if (row === undefined) throw new AppError('not_found', MEMBER_NOT_FOUND);

  // 停用顺手撤销他手里的 token：token 是「这个人的身份」，人走了它就不该还能写库。
  if (deactivated instanceof Date) await revokeTokensOf(db, memberId);

  return {
    id: row.id,
    name: row.name,
    role: row.role,
    line: row.line,
    deactivatedAt: row.deactivated_at,
  };
}

/** 停用（删除的软版本）。规矩与 `updateMember({active:false})` 完全一致。 */
export async function deactivateMember(db: Db, actor: string, raw: unknown): Promise<Member> {
  const input = requirePlainObject(raw);
  const me = await assertCan(db, actor, NO_REQUIREMENT, 'manageMembers');
  const memberId = parseId(String(input.memberId ?? ''), MEMBER_NOT_FOUND);
  const target = await loadMember(db, memberId);
  if (target === null) throw new AppError('not_found', MEMBER_NOT_FOUND);
  if (target.deactivatedAt !== null) return target;

  await assertCanDeactivate(db, me, target);
  await db.execute(sql`update members set deactivated_at = now(), session_epoch = now() where id = ${memberId}`);
  await revokeTokensOf(db, memberId);

  return { ...target, deactivatedAt: new Date() };
}

async function assertCanDeactivate(db: Db, me: Member, target: Member): Promise<void> {
  if (target.id === me.id) throw new AppError('invalid', SELF_DEACTIVATE);

  if (target.role === 'product_owner') {
    const res = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from members
       where role = 'product_owner' and deactivated_at is null`);
    if (Number(res.rows[0]?.n ?? 0) <= 1) throw new AppError('invalid', LAST_ADMIN);
  }

  const owned = await countOwned(db, target.id);
  if (owned > 0) {
    throw new AppError('member_busy', `这个人还负责 ${owned} 条需求，先转交`);
  }
}

async function revokeTokensOf(db: Db, memberId: string): Promise<void> {
  await db.execute(sql`
    update mcp_tokens set revoked_at = now()
     where member_id = ${memberId} and revoked_at is null`);
}

async function loadMember(exec: Exec, memberId: string): Promise<Member | null> {
  const res = await exec.execute<{
    id: string; name: string; email: string; role: string;
    line: string | null; deactivated_at: Date | null;
  }>(sql`select id, name, email, role, line, deactivated_at from members where id = ${memberId}`);
  const row = res.rows[0];
  return row === undefined
    ? null
    : {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      line: row.line,
      deactivatedAt: row.deactivated_at,
    };
}

/**
 * 重置某个人的密码：生成一个新的、落库、**明文只在返回值里出现一次**。
 *
 * 只有超管（`manageMembers`）。为什么不是「让用户自己改」：这一轮没有邮件、没有短信，
 * 忘了密码的人只能找一个还有权限的人帮他重置——而那个人就是超管。
 */
export async function resetPassword(
  db: Db, actor: string, raw: unknown,
): Promise<{ member: string; password: string }> {
  const input = requirePlainObject(raw);
  await assertCan(db, actor, NO_REQUIREMENT, 'manageMembers');
  const memberId = parseId(String(input.memberId ?? ''), MEMBER_NOT_FOUND);

  const target = await loadMember(db, memberId);
  if (target === null) throw new AppError('not_found', MEMBER_NOT_FOUND);
  if (target.deactivatedAt !== null) throw new AppError('invalid', '这个人已停用');

  const password = generatePassword();
  await setPassword(db, memberId, password);
  return { member: target.name, password };
}

/**
 * 一个成员改自己的通知频道档位（设置页用；超管也可以替别人改）。
 *
 * 为什么这条不走 `manageMembers`：通知口味是**个人偏好**，不是组织权限——任何人都
 * 该能关掉自己的铃铛和推送。传了别人的 id 才要求 `manageMembers`。
 *
 * 这一层是**唯一**校验档位的地方（读侧对认不出的值一律回落 `key`，见
 * `src/core/notify/prefs.ts`）：用户点出来的值只可能是三档之一，手改的请求在这里
 * 被拒，而不是存进去以后让读侧猜。
 *
 * 一次只改传进来的那几格：设置页的两个分段控件各自提交一格，互不覆盖。
 */
export async function saveNotifyChannels(
  db: Db, actor: string, raw: unknown,
): Promise<{ memberId: string; prefs: NotifyPrefs }> {
  const input = requirePlainObject(raw);
  const me = await requireActor(db, actor);
  const wantedId = input.memberId === undefined || input.memberId === null
    ? me.id
    : parseId(String(input.memberId), MEMBER_NOT_FOUND);
  if (wantedId !== me.id) {
    await assertCan(db, actor, NO_REQUIREMENT, 'manageMembers');
  }

  const target = await memberById(db, wantedId);
  if (target === null) throw new AppError('not_found', MEMBER_NOT_FOUND);

  const current = prefsOf(target.notifyPrefs);
  const next: NotifyPrefs = { ...current };
  let touched = false;
  for (const channel of CHANNELS) {
    const value = input[channel];
    if (value === undefined) continue;
    if (!isLevel(value)) {
      // 不是三档之一：说清是哪一格、合法值是什么，别让人对着「保存失败」重试。
      throw new AppError(
        'invalid',
        `「${CHANNEL_LABEL[channel]}」的档位只能是 全部 / 只关键 / 关 之一（收到的是「${String(value)}」）`,
      );
    }
    next[channel] = value;
    touched = true;
  }
  if (!touched) throw new AppError('invalid', '没有要改的通知频道');

  await db.execute(sql`
    update members set notify_prefs = ${prefsJson(next)} where id = ${wantedId}`);
  return { memberId: wantedId, prefs: next };
}

/**
 * 「查一下」：把这个成员的名字对到企微通讯录里的 userid（设置页那一行按钮）。
 *
 * 语义与推送里的那一步是**同一个函数**（`resolveUserid`）：缓存优先、成功落
 * `wecom_userid` + `wecom_lookup_at`、失败也落时刻。区别只在这里把结果翻成一句
 * 人话给按钮用——匹配到谁、为什么没对上，用户要能当场读到。
 *
 * 不抛（除了权限那两格）：查不到不是错误，是「还没有」。
 */
export async function lookupWecomAccount(
  db: Db, actor: string, raw: unknown = {},
): Promise<{ ok: true; name: string; userid: string; cached: boolean }
  | { ok: false; code: string; message: string }> {
  const input = requirePlainObject(raw);
  const me = await requireActor(db, actor);
  const wantedId = input.memberId === undefined || input.memberId === null
    ? me.id
    : parseId(String(input.memberId), MEMBER_NOT_FOUND);
  if (wantedId !== me.id) {
    await assertCan(db, actor, NO_REQUIREMENT, 'manageMembers');
  }

  const target = await memberById(db, wantedId);
  if (target === null) throw new AppError('not_found', MEMBER_NOT_FOUND);

  const resolved = await resolveUserid(db, target);
  return resolved.ok
    ? { ok: true, name: resolved.name, userid: resolved.userid, cached: resolved.cached }
    : { ok: false, code: resolved.code, message: resolved.message };
}

/** 设置页给「成员」那一栏用：角色中文名 + 条线中文名。 */
export function memberLabel(member: Member): string {
  const role = Object.hasOwn(ROLE_LABEL, member.role)
    ? ROLE_LABEL[member.role as Role]
    : member.role;
  return member.line === null ? role : `${role} · ${member.line === 'feature' ? '功能线' : '商业线'}`;
}

/** 只给 `activeMemberByName` 一个稳定的再导出：服务层常常要「活着的那个人」。 */
export { activeMemberByName };
