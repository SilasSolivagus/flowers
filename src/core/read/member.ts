import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { firstProductOwner, loadMembers, memberByName, type Exec } from '../auth/members.js';
import { readSessionTicket } from '../auth/session.js';
import { isAdmin, type Member } from '../auth/roles.js';
import { readSessionName } from '../auth/session.js';

/**
 * 花名册 + 「我是谁」。
 *
 * 身份**不再是**一个可以随便写的 cookie：P4-04 起它是登录之后由服务端签发的会话
 * （`flowers_session`，见 `src/core/auth/session-token.ts`）。这个文件只回答
 * 「这个请求现在是谁」，权限判断在 `src/core/auth/roles.ts`，登录在 `login.ts`。
 *
 * ── `currentMember()` 的解析顺序（每一级都有它的理由）
 *
 * 1. **会话 cookie**（验得过签名才算）。正常路径。cookie 里只有名字，签名保证的是
 *    「这个名字是我们发的」，改名/过期/伪造都验不过。
 * 2. **`FLOWERS_ACTOR` 环境变量**。给脚本与部署用：`npm run seed`、`tsx scripts/demo.ts`、
 *    以及「用 MCP / curl 直接验证一条链路」时不必先登录。它只在**没有会话**时才生效，
 *    而且是部署者自己的进程环境——不是用户能改的东西。
 * 3. **名册里第一个超管**（`role='product_owner'`，按 created_at, id）。
 *
 *    这一级替换掉了原来写死的 `DEFAULT_MEMBER = '吕品'`。那个常量是 owner 亲自撞到的
 *    那个 bug：他是房超，但应用每次都说他是吕品——于是所有「只有负责人能改」的判断
 *    都在拿一个错误的身份做，而屏幕上没有任何东西提示这一点。默认身份必须从**库里**
 *    来：这个部署里谁是超管，谁就是没登录时的那个「本机主人」。
 * 4. **一条成员都没有** → 显式报错（`no_member`），登录页把它显示出来。绝不编一个
 *    假身份：一个不存在的 actor 会一路写进 `events.actor`，而那条审计线正是这个系统
 *    存在的意义。
 */

export type { Member } from '../auth/roles.js';

/**
 * 顶栏身份 cookie 的**旧名字**（`flowers_actor`）。
 *
 * P4-04 之后**界面不再写它、身份也不再读它**：它是一段客户端可以随便写的明文，
 * 拿它当身份等于没有身份（任何人都能自称评审人）。这个名字留在这里只有一个用途——
 * `actorFromCookie` 还能把历史 cookie 解回一个名字，方便「把旧值迁进会话」这类
 * 一次性脚本读它；解析器本身也还留着，因为它对坏值的处理（不抛）是被测过的。
 */
export const ACTOR_COOKIE = 'flowers_actor';

export const NO_MEMBER = '系统里还没有任何成员：请先跑 npm run seed 建人';
export const SESSION_STALE = '这个账号已停用，请重新登录';

export async function listMembers(): Promise<Member[]> {
  return loadMembers(db);
}

export async function listAllMembers(): Promise<Member[]> {
  return loadMembers(db, { includeDeactivated: true });
}

/**
 * 名字 → id。找不到（cookie 里是个不在名册上的人）就是 null。
 *
 * 给成员存东西的键不能用名字（名字里可以有 `.`、空格、任意标点，而键的形状是
 * `member.<id>.provider.baseUrl`），所以落库一律用 id，名字只在入口处查一次。
 */
export async function memberIdByName(name: string): Promise<string | null> {
  const member = await memberByName(db, name);
  return member?.id ?? null;
}

/** 当前请求的身份；没有任何成员时抛 `no_member`（登录页展示这一句）。 */
export async function currentMember(): Promise<string> {
  const member = await currentMemberRow();
  return member.name;
}

/**
 * 「真的登录着」：会话签名有效，**而且**那个人还在名册上、没被停用。
 *
 * 这是页面那道门（`Shell`）与登录页的判据。为什么不直接用 `hasSignedSession()`：
 * 一个被停用的账号手里的旧 cookie 仍然验得过签名，拿它当门会让那个人继续看到每一页
 * （然后每个动作都撞一句「这个名字不在名册上」——一个能进每一扇门但什么都做不了的
 * 状态，是最难解释的 bug）。
 */
export async function hasActiveSession(): Promise<boolean> {
  const ticket = await readSessionTicket();
  if (ticket === null) return false;
  const member = await memberByName(db, ticket.name);
  if (member === null || member.deactivatedAt !== null) return false;
  // 纪元对不上 = 这张票签的时候他还有那个权限，之后被改过角色 / 条线 / 口令。
  // 实测过：房超被改成 PM 之后仍然是登录态，直到他自己退出。降权不及时等于没降权。
  return epochMatches(ticket.epoch, member);
}

/** 票里的纪元与库里那一列是不是同一时刻（容忍 1 秒：PG 的微秒在 ms 上会舍入）。 */
function epochMatches(ticketEpoch: number, member: Member): boolean {
  const stored = member.sessionEpoch?.getTime();
  if (stored === undefined) return true; // 老行没这一列：不因此把人踢下线
  return Math.abs(stored - ticketEpoch) < 1_000;
}

/**
 * 同上的成员行版本。会话里的名字必须**还在名册上、还没停用**——否则按「没有会话」
 * 处理，继续往下一级找。
 *
 * 这一条是「停用一个成员」真正生效的地方：签名没过期的旧 cookie 不会让他继续动东西，
 * 因为解析到那个人时会发现他已停用（`loadMembers` 只给活人）。他在页面上看到的会是
 * 「又变回了默认身份」，而不是「一个已停用的人还在改需求」。
 */
export async function currentMemberRow(exec: Exec = db): Promise<Member> {
  const ticket = await readSessionTicket();
  if (ticket !== null) {
    const member = await memberByName(exec, ticket.name);
    if (member !== null && member.deactivatedAt === null && epochMatches(ticket.epoch, member)) {
      return member;
    }

    /**
     * 有一个**验得过签名**的会话，但那个人已经不在名册上 / 已被停用：这是「会话过期」，
     * 不是「没有会话」。
     *
     * 不能往下落到 `FLOWERS_ACTOR` / 第一个超管——那会让一个刚被停用的人，在他自己
     * 那个还没过期的 cookie 上**变成超管**。这是这一轮最容易写错的一格：签名有效
     * 只说明「cookie 是我们发的」，不说明「这个人现在还有任何权限」。
     */
    throw new AppError('session_invalid', SESSION_STALE);
  }

  const fromEnv = process.env.FLOWERS_ACTOR?.trim();
  if (fromEnv !== undefined && fromEnv !== '') {
    const member = await memberByName(exec, fromEnv);
    if (member !== null) return member;
    throw new AppError('no_member', `FLOWERS_ACTOR 指的「${fromEnv}」不在名册上`);
  }

  const owner = await firstProductOwner(exec);
  if (owner !== null) return owner;

  throw new AppError('no_member', NO_MEMBER);
}

/**
 * 旧 cookie 的值（`flowers_actor`）。解码一次、去掉空白；解不出来就返回 null。
 *
 * 保留了「解码」这一步：客户端当年写的是 `encodeURIComponent(名字)`。
 */
export function actorFromCookie(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const decoded = decodeURIComponent(raw).trim();
    return decoded === '' ? null : decoded;
  } catch {
    return raw.trim() === '' ? null : raw.trim();
  }
}

/**
 * 抽屉「改负责人」那份下拉的候选（P4-05，P4-06 换锚点）。
 *
 * 两档，与 `reassignOwner` 服务里的那条约束**同口径**，但这里只决定「摆给谁选」：
 * - 超管：名册上所有活着的人；
 * - 条线负责人：**自己这条线**的人。
 *
 * P4-06 之前这一档按「需求类型 → 条线」筛，于是会出现一个荒唐的组合：功能线负责人
 * 对一条商业类需求有转交权（负责人是功能线 PM），下拉里却只摆商业线的人——选谁都会被
 * 服务拒。锚点换成人的归属之后，两处说的是同一句话：**转交人的线**。
 * 服务层仍然会再判一次（`target.line !== locked.owner_line`），这里只是不摆出必然
 * 被拒的选项；PM 或别的线的人根本看不到这个控件（`detail.permissions.reassignOwner`）。
 */
export async function ownerCandidates(actor: Member): Promise<Member[]> {
  const all = await loadMembers(db);
  if (isAdmin(actor)) return all;
  if (actor.line === undefined || actor.line === null) return [];
  return all.filter((member) => member.line === actor.line);
}
