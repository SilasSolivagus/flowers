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
import {
  checkWebhook, lookupUseridExact, maskWebhook, messageOf, resolveUserid, sendWebhook,
} from '../notify/wecom.js';

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

// ─── 2026-11-10：成员自己绑 userid / 自己的机器人 ──────────────────────────

/** 谁的绑定：自己，或者（超管）某个成员。与 `saveNotifyChannels` 同一条权限口径。 */
async function targetOf(
  db: Db, actor: string, raw: Record<string, unknown>,
): Promise<Member> {
  const me = await requireActor(db, actor);
  const wantedId = raw.memberId === undefined || raw.memberId === null
    ? me.id
    : parseId(String(raw.memberId), MEMBER_NOT_FOUND);
  if (wantedId !== me.id) await assertCan(db, actor, NO_REQUIREMENT, 'manageMembers');
  const target = await memberById(db, wantedId);
  if (target === null) throw new AppError('not_found', MEMBER_NOT_FOUND);
  if (target.deactivatedAt !== null) throw new AppError('invalid', '这个人已停用');
  return target;
}

export type BindResult =
  | { ok: true; userid: string; name: string; cleared: boolean }
  | { ok: false; message: string };

/**
 * 把一个成员自己贴进来的 userid **验一次**、验过了才落库（设置 · 我的 →「绑定企微」）。
 *
 * 与老的「查一下」（`lookupWecomAccount`，按**名字**去通讯录里猜一个人）分工不同：
 * - 「查一下」回答「我叫这个名字，通讯录里对应谁」——它属于**管理员**替人绑定那条路；
 * - 这里回答「我贴的这个 userid 是不是真有一个人」——它属于**本人**绑定这条路。
 *
 * 为什么本人这条路必须存在：名字匹配的边界是「同名多命中就报错」（`pickUser`），
 * 而新人入职、改名、同名这几件事都常常同时发生；把一个**确定的账号名**贴进来是
 * 唯一不需要猜的绑定方式。
 *
 * 三种结果都要落库（与 `resolveUserid` 同一条口径）：成功写 `wecom_userid` +
 * `wecom_lookup_at`；失败**只写** `wecom_lookup_at`——那一列是「试过」的唯一记号，
 * 界面据此显示「验证失败」而不是「未绑定」（两者的下一步不一样：一个去改 userid，
 * 一个去绑）。
 *
 * 空串 = 解绑（`cleared: true`）：把 userid 清掉，但**保留** `wecom_lookup_at`？
 * 不保留——解绑是「我不要绑了」，不是「我试过但失败了」。所以两列一起清空，
 * 界面回到「未绑定」。
 */
export async function bindWecomUserid(
  db: Db, actor: string, raw: unknown,
): Promise<BindResult> {
  const input = requirePlainObject(raw);
  const target = await targetOf(db, actor, input);
  const typed = asText(input.userid)?.trim() ?? '';

  if (typed === '') {
    await db.execute(sql`
      update members set wecom_userid = null, wecom_lookup_at = null where id = ${target.id}`);
    return { ok: true, userid: '', name: target.name, cleared: true };
  }

  const found = await lookupUseridExact(typed);
  if (!found.ok) {
    await db.execute(sql`
      update members set wecom_lookup_at = now() where id = ${target.id}`);
    return { ok: false, message: found.message };
  }

  await db.execute(sql`
    update members
       set wecom_userid = ${found.user.userid}, wecom_lookup_at = now()
     where id = ${target.id}`);
  return { ok: true, userid: found.user.userid, name: found.user.name, cleared: false };
}

export type WebhookSaveResult =
  | { ok: true; masked: string | null; cleared: boolean }
  | { ok: false; message: string };

/**
 * 存/清「我自己的机器人」（设置 · 我的 →「用自己的机器人」）。
 *
 * 校验在 `checkWebhook`（https、主机、路径、key 非空——收窄到企微那一个主机，是因为
 * 这一列会被服务器 `POST` 出去；允许任意 URL 等于给成员开一个内网探测的口子）。
 *
 * 返回值里只给**掩码**：这个函数的结果会原样进响应体，而整串 webhook 等于一个能往
 * 群里发消息的凭证。空串 = 清掉（回到共用机器人）。
 */
export async function saveMemberWebhook(
  db: Db, actor: string, raw: unknown,
): Promise<WebhookSaveResult> {
  const input = requirePlainObject(raw);
  const target = await targetOf(db, actor, input);
  const typed = asText(input.webhook)?.trim() ?? '';

  if (typed === '') {
    await db.execute(sql`update members set wecom_webhook = null where id = ${target.id}`);
    return { ok: true, masked: null, cleared: true };
  }

  const checked = checkWebhook(typed);
  if (!checked.ok) return { ok: false, message: checked.message };

  await db.execute(sql`
    update members set wecom_webhook = ${checked.url} where id = ${target.id}`);
  return { ok: true, masked: maskWebhook(checked.url), cleared: false };
}

export type WebhookTestResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

/**
 * 「测试」那个按钮：**真的往这条 webhook 发一条**，不发不知道通不通。
 *
 * 发的是固定的一句、不带任何需求内容：这一条测试不该把任何一条需求标题送到一个
 * 还没被信任的地址上。
 *
 * 测的是**框里那一条**（传 `webhook` 就用它），没传才用库里存着的。为什么这么定：
 * 用户粘进来一条地址、还没点保存就点「测试」，测的必须是他眼前那条；测库里那条
 * 等于替他确认了一个他没在看的地址。
 *
 * 失败时那一句话原样返回（`invalid webhook url` / `rate limited` 这类是唯一能搜到
 * 答案的线索），但**已经抹掉 key**（`sendWebhook` 里做的）。
 */
export async function testMemberWebhook(
  db: Db, actor: string, raw: unknown,
): Promise<WebhookTestResult> {
  const input = requirePlainObject(raw);
  const target = await targetOf(db, actor, input);
  const typed = asText(input.webhook)?.trim() ?? '';

  const stored = typeof target.wecomWebhook === 'string' ? target.wecomWebhook.trim() : '';
  const candidate = typed === '' ? stored : typed;
  if (candidate === '') return { ok: false, message: '还没有 webhook：先把地址贴进来' };

  const sent = await sendWebhook(candidate, messageOf('机器人测试', '这条是 flowers 的测试消息'));
  if (!sent.ok) return { ok: false, message: sent.message };
  return {
    ok: true,
    message: `已发出（发到 ${maskWebhook(candidate) ?? '这条地址'}）——群里有这条消息就算通了`,
  };
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
