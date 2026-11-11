import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from './src/core/auth/session-token.js';
import { sessionSecret } from './src/core/auth/session.js';

/**
 * 门（P4-04）：除了 `/login` 与 `/mcp`，任何路由都要一个**验得过签名**的会话。
 *
 * 为什么用 `proxy.ts` 而不是每个页面自己判：漏一处的代价是一条没有门的路。写在这里
 * 是**默认拒绝**——新增一个页面不需要记得加检查，它就自动在门里面了。
 *
 * ── 它验什么，不验什么
 *
 * 验：这个 cookie 是不是我们发的（HMAC-SHA256）、过期没有。
 * 不验：这个人现在还在不在名册上、有没有被停用。那要一次数据库往返，而代理这一层
 * 不该连库（每次静态资源请求都要过一次的东西，越薄越好）。
 *
 * 第二段在 `app/components/Shell.tsx`（`currentMember()` 会确认那个人还活着）。
 * 两层合起来才是完整的一句话：**签名有效 ≠ 这个人还能用**。
 *
 * 为什么 `/mcp` 不在门里：它用 `Authorization: Bearer <token>`，token 本身就是身份
 * （见 `mcp/tokens.ts`）。让它依赖 cookie 等于要求 MCP 客户端先开一个浏览器。
 *
 * Next 16 把 `middleware.ts` 换成了 `proxy.ts`，而且 proxy **固定跑在 Node 运行时**
 * ——这正是能有 `node:crypto` 的那一半原因（另一半是 `session-token.ts` 只依赖它）。
 */
export default function proxy(request: NextRequest): NextResponse {
  const name = verifySession(request.cookies.get(SESSION_COOKIE)?.value, sessionSecret());
  if (name !== null) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

/**
 * 哪些请求要过门。**负面清单**（说清楚谁不进），而不是正面清单：
 * 正面清单每加一个路由就要记得回来加一行，而漏掉的那一行不会有任何提示。
 *
 * - `_next/*`：框架自己的静态资源与 HMR；
 * - `favicon.ico`、`robots.txt`：浏览器/爬虫的无身份请求；
 * - `login`：门外那一页本身（否则会无限重定向）；
 * - `mcp`：Bearer token 的那条路（见文件头）。
 * - `api/v1`：整个 REST 面（2026-11-11）自己用 Bearer token 鉴权，不走 cookie 门；
 *   其中 `api/v1/auth/check` 还是 b123 看板的 `auth_request` 子请求（返回 200/401）。
 */
export const config = {
  matcher: ['/((?!_next/|favicon\\.ico|robots\\.txt|login|mcp|api/v1).*)'],
};
