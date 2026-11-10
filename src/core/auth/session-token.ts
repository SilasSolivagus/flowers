import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 会话 cookie 的**签名**部分：一个自包含的、HMAC 签过的字符串。
 *
 * 为什么不是一张 `sessions` 表：
 *
 * 1. **它要回答的问题只有一个**——「这个 cookie 是不是我们发的、发给了谁、过期没」。
 *    三件事都在 cookie 里，验一次签名就有答案，不需要一次数据库往返。会话表要多一次
 *    查询、一张要清理的表（过期行永远没人删），以及一个「查表失败时怎么办」的新问题。
 * 2. **撤销的粒度就是「所有人」**：换掉 `FLOWERS_SESSION_SECRET` 全部会话立刻失效。
 *    这一版没有「只踢掉某个人」的需求（停用成员是另一件事：`currentMember()` 每次
 *    都会确认这个人还在名册上、还没停用，见 member.ts）。等真有那个需求再加表，
 *    那时它会带来真正的好处（每会话撤销），而不是今天的净成本。
 * 3. 单进程 / 多进程 / 重启都不影响：签名只依赖一个密钥，不依赖进程内存。
 *
 * 格式（`.` 分隔，全部 ASCII，不进 cookie 里的引号）：
 *
 * ```
 * v1.<base64url(name)>.<expEpochMs>.<base64url(hmacSha256(secret, "v1.<name>.<exp>"))>
 * ```
 *
 * 名字放进签名覆盖的范围：**改一个字都验不过**。`exp` 也在里面：把过期时间往后改，
 * 签名同样不成立。这两条是「cookie 是明文但不可伪造」的全部内容。
 *
 * 为什么签名用 `node:crypto` 而不是 Web Crypto：签发发生在 Node 运行时（服务端组件 /
 * server action），验签发生在 `proxy.ts`（Next 16 的 proxy 固定跑在 Node 运行时），
 * 两边都是 `node:crypto`，一份实现就够，不需要第二套 Edge 版本来对齐。
 */

export const SESSION_COOKIE = 'flowers_session';

/** 12 小时。一个工作日之内不用重复登录；下班关掉浏览器也不会留一个永久的凭证。 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// v2：载荷里多了「会话纪元」（见下）。版本号变一次，旧 cookie 全部作废——
// 这正是我们要的：改版前签出去的凭证不该继续有效。
const VERSION = 'v2';

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function unb64url(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function mac(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(payload, 'utf8').digest();
}

/** 签发。返回 cookie 的值（不含 `name=`）。 */
/**
 * 签发。`epoch` 是**这个人的会话纪元**（`members.session_epoch` 的毫秒值）。
 *
 * 为什么载荷里要带它：cookie 是**无状态**的，签名一旦发出就管 12 小时。改角色、
 * 改条线、重置密码这些事在那 12 小时里发生了，旧 cookie 仍然能验过——实测就是
 * 房超被改成 PM 之后仍然是登录态。把纪元放进来，服务端每次都能拿它跟库里的比：
 * 对不上就是「这张凭证签的时候你还有权限，现在没有了」，直接当没登录。
 */
export function signSession(
  name: string,
  epoch: number,
  secret: string,
  now: number = Date.now(),
  ttl: number = SESSION_TTL_MS,
): string {
  const exp = now + ttl;
  const payload = `${VERSION}.${b64url(name)}.${epoch}.${exp}`;
  return `${payload}.${mac(secret, payload).toString('base64url')}`;
}

/** 验签出来的一张票：名字 + 签发时的会话纪元。 */
export type SessionTicket = { name: string; epoch: number };

/**
 * 验签。返回那个名字，任何一处不对都是 null（**不抛**）。
 *
 * 缺 / 空 / 分段不对 / 版本不对 / 过期 / 签名不符 —— 全部 null。调用方只看
 * 「有没有名字」，所以这些分支不需要不同的错误码：对未登录的人来说它们都是同一件事
 * （去登录页），对试探者来说它们也不该有区别。
 */
export function verifySession(
  token: string | null | undefined,
  secret: string,
  now: number = Date.now(),
): SessionTicket | null {
  if (typeof token !== 'string' || token === '') return null;
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) return null;
  const [, encodedName, epochText, expText, signature] = parts as [string, string, string, string, string];

  const exp = Number(expText);
  if (!Number.isFinite(exp) || exp <= now) return null;
  const epoch = Number(epochText);
  if (!Number.isFinite(epoch) || epoch <= 0) return null;

  const payload = `${VERSION}.${encodedName}.${epochText}.${expText}`;
  const expected = mac(secret, payload);
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length) return null;
  if (!timingSafeEqual(actual, expected)) return null;

  const name = unb64url(encodedName);
  if (name === null) return null;
  const trimmed = name.trim();
  // 空名字当成没有会话：签名对但名字是空串的行只可能来自手工构造。
  return trimmed === '' ? null : { name: trimmed, epoch };
}
