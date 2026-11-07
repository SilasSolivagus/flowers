import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_COOKIE, signSession, verifySession } from './session-token.js';

/**
 * 会话 cookie 的读写：`next/headers` 那一层胶水。签名/验签本身在 `session-token.ts`
 * （纯函数、不碰请求上下文，proxy 与用例都用它）。
 *
 * ── 密钥从哪来
 *
 * 1. `FLOWERS_SESSION_SECRET` 环境变量（部署时的正路）；
 * 2. 没有就用仓库里的 `data/.flowers-session-secret`，**没有就生成一个 32 字节的**
 *    并以 0600 落盘。
 *
 * 为什么要落盘而不是「每次启动随机生成一个」：那样每次重启 / 每次 dev 热重载都会把
 * 所有人踢下线，而 dev 下热重载一天能发生几十次——那不是安全，那是不好用。落盘的
 * 文件只在开发机上，权限 0600，不进 git（`.gitignore` 已经忽略 `data/`）。
 *
 * 为什么不把默认密钥写死在代码里：写死的就是公开的——任何人都能给任何名字签一个
 * 合法的 cookie。宁可每台机器不一样。
 *
 * 路径按**模块位置**算，不看 `process.cwd()`：有一条既有用例会把 cwd 换到 /tmp，
 * 而那时候密钥不该跟着换地方（换了就等于「换了一个人」）。
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET_FILE = path.join(REPO_ROOT, 'data', '.flowers-session-secret');

let cached: string | null = null;

/** 读（必要时生成）签名密钥。同步：调用点在每个请求的热路径上，异步没有收益。 */
export function sessionSecret(): string {
  if (cached !== null) return cached;
  const fromEnv = process.env.FLOWERS_SESSION_SECRET?.trim();
  if (fromEnv !== undefined && fromEnv !== '') {
    cached = fromEnv;
    return cached;
  }
  if (existsSync(SECRET_FILE)) {
    const stored = readFileSync(SECRET_FILE, 'utf8').trim();
    if (stored !== '') {
      cached = stored;
      return cached;
    }
  }
  const generated = randomBytes(32).toString('hex');
  mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
  writeFileSync(SECRET_FILE, `${generated}\n`, { mode: 0o600 });
  cached = generated;
  return cached;
}

/** 只用测：改了 `FLOWERS_SESSION_SECRET` 之后要让缓存忘掉旧值。 */
export function resetSessionSecretCache(): void {
  cached = null;
}

/** 签发一个值（不写 cookie）。给用例与需要自己 Set-Cookie 的地方用。 */
export function sessionValue(name: string, now: number = Date.now()): string {
  return signSession(name, sessionSecret(), now);
}

/**
 * 从 cookie 里解出名字。**没有请求上下文不抛**：脚本、用例、`npm run seed` 都会走到
 * 这里，而它们与「没带 cookie」是同一件事。坏值同理——一个手改过的 cookie 只该等于
 * 「没登录」，不该让整页 500。
 */
export async function readSessionName(): Promise<string | null> {
  try {
    const { cookies } = await import('next/headers');
    const jar = await cookies();
    return verifySession(jar.get(SESSION_COOKIE)?.value, sessionSecret());
  } catch {
    return null;
  }
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
export async function setSessionCookie(name: string): Promise<void> {
  const { cookies } = await import('next/headers');
  const jar = await cookies();
  jar.set(SESSION_COOKIE, sessionValue(name), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: Math.floor(12 * 60 * 60),
  });
}

export async function clearSessionCookie(): Promise<void> {
  const { cookies } = await import('next/headers');
  const jar = await cookies();
  jar.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
}
