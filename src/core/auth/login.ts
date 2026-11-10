import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { burnDecoy, verifyHash } from './password.js';
import { memberByEmail } from './members.js';
import { clearSessionCookie, setSessionCookie } from './session.js';

/**
 * 登录 / 登出。
 *
 * 三条硬口径：
 *
 * 1. **「查无此人」与「密码错」是同一句中文**（`BAD_CREDENTIALS`）。分开说的后果不是
 *    「更友好」，而是把登录页变成一台花名册探测器：拿名字试一遍，凭返回的那句话就能
 *    列出「谁是成员」。停用账号也走这一句——「这个账号已停用」同样泄露了名册。
 * 2. **时间也要一样**。查无此人时**照样跑一次 scrypt**（`burnDecoy`），否则快 60 毫秒
 *    的那条路自己就把答案说了。文案分开与时间分开是同一件事的两面，只堵一边等于没堵。
 * 3. **失败要计次**。不限速的登录页等于把 scrypt 变成一台免费的离线爆破服务器——
 *    而且它还会替攻击者把「密码对不对」这个判断做了。
 *
 * ── 限速的口径（写在这里，因为数字是产品决定）
 *
 * - 同一个**邮箱**连续失败 **5** 次 → 这个邮箱被拒 **5 分钟**；
 * - 成功一次立即清零；
 * - 窗口从**第 5 次失败**那一刻算，不滑动（失败越多不会越久，封顶 5 分钟）。
 *
 * 为什么按邮箱而不是按 IP：IP 在办公室/公司出口后面是一整栋楼，按 IP 限速会误伤同事；
 * 而这里的威胁是「猜某个人的密码」，被猜的是那一个账号（P4-08 起登录名是邮箱）。反过来的代价是「攻击者可以锁住
 * 任何一个人 5 分钟」——一个 DoS 面，接受它：5 分钟、可在服务重启时清空、
 * 而且被锁的人自己也进不来（不是「别人把你锁在外面还让你进」这种更难解释的状态）。
 *
 * 计数只活在进程内存里。单进程 / dev / 测试都够用；多实例部署时每个实例各记各的，
 * 实际阈值会变成「5 × 实例数」。这一条写进报告，不在这一轮修（要修就得有一张表，
 * 而登录路径上多一次写库是一笔真成本）。
 *
 * ── P4-08：凭证是**邮箱**，身份仍然是**名字**
 *
 * 登录字段从姓名换成了 `<拼音>@123pan.com`（公司统一口径，邮箱来自企微通讯录）。
 * 换的只是**凭证**：`attemptLogin` 返回的仍然是 `members.name`，会话票据里装的、
 * `events.actor` 写的、`can()` 判的、通知扇出认的，全部还是名字。所以这一列换了之后，
 * 下游一个字都不用改——那是这次改动唯一安全的地方。
 *
 * **没有保留按名字登录的兜底，也没有给 MCP token 留按名字的入口**：
 * - 名字登录 = 一条绕过「邮箱唯一」的旁路，而这条旁路的代价是重名的人分不清；
 *   公司口径是邮箱登录，留着它就等于把「登录名」这件事又变回两个来源。
 * - MCP token 本来就**不按名字解析人**：请求 → `mcp_tokens.token_hash` → `member_id`
 *   → `members.name`（见 `mcp/tokens.ts` 的 `identityFromToken`）。凭证是 token，
 *   名字只是它反查出来的 `actor`，与登录字段是邮箱还是姓名无关。
 */

export const BAD_CREDENTIALS = '账号或密码不对';
export const RATE_LIMITED = '密码错误次数过多，请 5 分钟后再试';

export const MAX_FAILURES = 5;
export const LOCK_MS = 5 * 60 * 1000;

type Bucket = { failures: number; lockedUntil: number };

/** 邮箱 → 失败计数。模块级 Map：进程内唯一，不落库（见文件头）。 */
const buckets = new Map<string, Bucket>();

/** 只用测：清空限速状态。 */
export function resetLoginRateLimit(): void {
  buckets.clear();
}

/** 限速的键：邮箱（小写、去空白）——与 `memberByEmail` 的同一条归一。 */
function keyOf(email: string): string {
  return email.trim().toLowerCase();
}

/** 这个邮箱现在是否被锁。纯读，不改状态。 */
export function lockedFor(email: string, now: number = Date.now()): number {
  const bucket = buckets.get(keyOf(email));
  if (bucket === undefined) return 0;
  return bucket.lockedUntil > now ? bucket.lockedUntil - now : 0;
}

function recordFailure(name: string, now: number): void {
  const key = keyOf(name);
  const bucket = buckets.get(key) ?? { failures: 0, lockedUntil: 0 };
  bucket.failures += 1;
  if (bucket.failures >= MAX_FAILURES) {
    bucket.lockedUntil = now + LOCK_MS;
    // 锁上之后计数归零：解锁后重新从 5 次开始，不会「解锁即再锁 5 分钟」。
    bucket.failures = 0;
  }
  buckets.set(key, bucket);
}

/**
 * 校验一次密码，**不碰 cookie**。成功返回那个成员的**名字**（不是邮箱）。
 *
 * 与 `login()` 分开是为了可测：登录这条路的三个变量（密码对不对、限没限速、cookie
 * 写没写）不该只能在请求上下文里验证。
 */
export async function attemptLogin(
  db: Db,
  email: string,
  password: string,
  now: number = Date.now(),
): Promise<{ name: string; epoch: number }> {
  const trimmed = keyOf(email);
  if (lockedFor(trimmed, now) > 0) throw new AppError('rate_limited', RATE_LIMITED);

  /**
   * 三种「进不去」在这里合成**一条**出口：没有这个人、这个人已停用、这个人还没设密码。
   * 三种都跑一次 scrypt（decoy），所以返回的是同一个延迟、同一句中文。
   */
  const fail = async (): Promise<never> => {
    await burnDecoy(password);
    recordFailure(trimmed, now);
    throw new AppError('bad_credentials', BAD_CREDENTIALS);
  };

  const member = await memberByEmail(db, trimmed);
  if (member === null || member.deactivatedAt !== null) return fail();

  const hash = await storedHash(db, member.id);
  if (hash === null) return fail();

  const ok = await verifyHash(password, hash);
  if (!ok) return fail();

  buckets.delete(trimmed);
  return { name: member.name, epoch: (member.sessionEpoch ?? new Date(0)).getTime() };
}

async function storedHash(db: Db, memberId: string): Promise<string | null> {
  const { sql } = await import('drizzle-orm');
  const res = await db.execute<{ password_hash: string | null }>(sql`
    select password_hash from members where id = ${memberId}`);
  return res.rows[0]?.password_hash ?? null;
}

/**
 * 登录并**写下会话 cookie**。页面 / server action 只调这一个。
 *
 * 失败时 cookie 不会被写：`attemptLogin` 抛了就到此为止。登录成功时也顺便清掉旧值
 * （`setSessionCookie` 是覆盖写，不需要先删）。
 */
export async function login(
  db: Db,
  email: string,
  password: string,
  now: number = Date.now(),
): Promise<{ name: string }> {
  const result = await attemptLogin(db, email, password, now);
  await setSessionCookie(result.name, result.epoch);
  return result;
}

export async function logout(): Promise<void> {
  await clearSessionCookie();
}
