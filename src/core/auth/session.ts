import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ensureDataRoot, resetRuntimeDirCache } from '../runtime-dir.js';
import { SESSION_COOKIE, signSession, verifySession, type SessionTicket } from './session-token.js';

/**
 * 会话 cookie 的读写：`next/headers` 那一层胶水。签名/验签本身在 `session-token.ts`
 * （纯函数、不碰请求上下文，proxy 与用例都用它）。
 *
 * ── 密钥从哪来
 *
 * 1. `FLOWERS_SESSION_SECRET` 环境变量（部署时的正路）；
 * 2. 没有就用**仓库外**数据目录里的 `flowers/.flowers-session-secret`，**没有就生成一个
 *    32 字节的**并以 0600 落盘（位置由 `src/core/runtime-dir.ts` 统一决定：macOS 是
 *    `~/Library/Application Support/flowers`，Linux 是 `$XDG_DATA_HOME/flowers`，
 *    `FLOWERS_DATA_DIR` 可覆盖）。
 *
 * 为什么不落盘而用「每次启动随机生成一个」：那样每次重启 / 每次 dev 热重载都会把
 * 所有人踢下线，而 dev 下热重载一天能发生几十次——那不是安全，那是不好用。
 *
 * 为什么不把默认密钥写死在代码里：写死的就是公开的——任何人都能给任何名字签一个
 * 合法的 cookie。宁可每台机器不一样。
 *
 * ── 为什么不在仓库里（2026-11-08）
 *
 * 以前它住在 `<仓库>/data/.flowers-session-secret`，而 `data/` 是 git 忽略目录：一次
 * `git clean -fdx` 连它一起删掉，下一个请求就地生成一把新密钥，**所有人手里的 cookie
 * 同时失效**，表现得像「登录随机掉线」，而 `git status` 是干净的、当场没人发现。
 * 密钥是不可重建数据，不该住在任何「清理未跟踪文件」会走到的路径上。
 *
 * 路径按**模块位置**算，不看 `process.cwd()`（这条口径没变，只是现在由 `runtime-dir`
 * 统一算）：有一条既有用例会把 cwd 换到 /tmp，而那时候密钥不该跟着换地方。
 */

let cached: string | null = null;

/** 读（必要时生成）签名密钥。同步：调用点在每个请求的热路径上，异步没有收益。 */
export function sessionSecret(): string {
  if (cached !== null) return cached;
  const fromEnv = process.env.FLOWERS_SESSION_SECRET?.trim();
  if (fromEnv !== undefined && fromEnv !== '') {
    cached = fromEnv;
    return cached;
  }
  // 路径**每次**从 ensureDataRoot 取（它自己缓存）：密钥文件可能在第一次调用之后才
  // 迁到新位置，模块加载时算死的常量会指着一个已经不存在的旧路径。
  const { secretFile } = ensureDataRoot();
  if (existsSync(secretFile)) {
    const stored = readFileSync(secretFile, 'utf8').trim();
    if (stored !== '') {
      cached = stored;
      return cached;
    }
  }
  const generated = randomBytes(32).toString('hex');
  writeFileSync(secretFile, `${generated}\n`, { mode: 0o600 });
  cached = generated;
  return cached;
}

/** 只用测：改了 `FLOWERS_SESSION_SECRET` 之后要让缓存忘掉旧值。 */
export function resetSessionSecretCache(): void {
  cached = null;
  resetRuntimeDirCache();
}


/** 签发一个值（不写 cookie）。给用例与需要自己 Set-Cookie 的地方用。 */
export function sessionValue(name: string, epoch: number, now: number = Date.now()): string {
  return signSession(name, epoch, sessionSecret(), now);
}

/**
 * 从 cookie 里解出名字。**没有请求上下文不抛**：脚本、用例、`npm run seed` 都会走到
 * 这里，而它们与「没带 cookie」是同一件事。坏值同理——一个手改过的 cookie 只该等于
 * 「没登录」，不该让整页 500。
 */
/** 解出整张票（名字 + 签发时的会话纪元）。校验纪元在 `read/member.ts`。 */
export async function readSessionTicket(): Promise<SessionTicket | null> {
  try {
    const { cookies } = await import('next/headers');
    const jar = await cookies();
    return verifySession(jar.get(SESSION_COOKIE)?.value, sessionSecret());
  } catch {
    return null;
  }
}

/** 只要名字。 */
export async function readSessionName(): Promise<string | null> {
  return (await readSessionTicket())?.name ?? null;
}

/**
 * 有没有一个**验得过签名**的会话（不管这个人现在还在不在名册上）。
 *
 * 它只回答「这个 cookie 是我们发的吗」。**不要**拿它当「已登录」用：签名没过期的
 * 旧 cookie 在一个已被停用的账号手里仍然能验过。真正的门是
 * `read/member.ts` 的 `hasActiveSession()`（签名 + 这个人还活着）。
 */
export async function hasSignedSession(): Promise<boolean> {
  return (await readSessionName()) !== null;
}

/**
 * 写会话 cookie。
 *
 * `httpOnly`：JS 读不到它——XSS 拿到的是「能发请求」，而会话凭证本身不该出现在
 * `document.cookie` 里。`sameSite: 'lax'`：跨站 POST 不带 cookie（server action 的
 * 表单是站内 POST，不受影响），而点一个外链过来仍然是已登录的。`secure` 跟着协议走：
 * 本地 http 若写死 secure，浏览器会直接丢掉它，开发时永远登不进去。
 */
/**
 * cookie 的 Domain（2026-11-11）：b123 这类兄弟子域要在自己的 nginx 里做 `auth_request`，
 * 浏览器必须把这张 cookie 一并送到 `b123.dirctable.com`，否则门永远看到「没登录」。
 *
 * 由 `FLOWERS_COOKIE_DOMAIN` 给（生产 `.dirctable.com`）；不设就是 host-only——
 * 本机 localhost 与测试都不受影响。
 */
const COOKIE_DOMAIN = (): string | undefined => {
  const value = process.env.FLOWERS_COOKIE_DOMAIN?.trim();
  return value === undefined || value === '' ? undefined : value;
};

export async function setSessionCookie(name: string, epoch: number): Promise<void> {
  const { cookies } = await import('next/headers');
  const jar = await cookies();
  jar.set(SESSION_COOKIE, sessionValue(name, epoch), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    // 设了域就带上：兄弟子域（b123）的 auth_request 才能读到会话。
    ...(COOKIE_DOMAIN() === undefined ? {} : { domain: COOKIE_DOMAIN() }),
    maxAge: Math.floor(12 * 60 * 60),
  });
}

export async function clearSessionCookie(): Promise<void> {
  const { cookies } = await import('next/headers');
  const jar = await cookies();
  jar.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
}
