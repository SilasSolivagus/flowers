import { NextResponse } from 'next/server';

import { hasActiveSession } from '../../../../../src/core/read/member';

/**
 * 给 edge 的 `auth_request` 用的会话校验口（2026-11-11）。
 *
 * b123 经营看板（`b123.dirctable.com`）的 nginx 门是这么写的：
 *
 * ```nginx
 * auth_request /_b123_gate;   # 子请求转到这个接口
 * error_page 401 = @b123_login;   # 没登录 → 去 flowers 登录页
 * error_page 403 = @b123_forbidden;
 * error_page 500 = @b123_gate_down;  # 本接口不可用 → 503（fail closed）
 * ```
 *
 * 所以这里只回答三件事：200 放行、401 没登录、其他状态（500）由 nginx 翻成 503。
 *
 * 判据用 `hasActiveSession()`——它与页面用的是同一条：**签名 + 这个人还在名册上 +
 * 会话纪元对得上**。只用「签名验得过」是不够的：停用账号手里的旧 cookie 仍然能验签，
 * 那样一个已经离职的人还能打开经营看板。
 *
 * 权限口径（2026-11-11 owner）：**在册成员都能进**（账号密码与 flowers 一致）。
 * `perm` 参数保留成显式开关，是为了以后别的子域要不同口径时有地方分叉，而不是
 * 让任何一个 `perm` 值都放行：认不出的值直接 404，不留一个「什么都放行」的默认分支。
 */
export const dynamic = 'force-dynamic';

const KNOWN_PERMS = new Set(['b123']);

export async function GET(request: Request): Promise<Response> {
  const perm = new URL(request.url).searchParams.get('perm') ?? '';
  if (!KNOWN_PERMS.has(perm)) {
    return new NextResponse('unknown perm\n', {
      status: 404,
      headers: { 'cache-control': 'no-store' },
    });
  }

  const ok = await hasActiveSession();
  return new NextResponse(ok ? 'ok\n' : 'unauthorized\n', {
    status: ok ? 200 : 401,
    headers: { 'cache-control': 'no-store' },
  });
}
