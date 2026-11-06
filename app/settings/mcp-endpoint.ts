import { MCP_PATH } from '../../mcp/path';

/**
 * 设置页上那条「接你的 agent」的 URL —— 从**这次请求**推出来，不写死。
 *
 * 为什么不能写死 `https://flowers.example.com/mcp`：这个仓库跑在好几个地方——本机
 * `localhost:3000`、内网某台机器的 IP、隧道后面的域名。写死的那一条在另外两个场景里
 * 是错的，而错的 URL 比没有 URL 更坏：用户会把它粘进客户端，然后得到一个连接超时，
 * 以为是服务没起来。
 *
 * 两个头，各管一件事：
 * - **host**：`host` 是浏览器真正访问的那个名字（含端口）。反向代理后面取
 *   `x-forwarded-host`（代理会把 `host` 改写成上游的地址），取第一个值——代理链可以
 *   往头里塞一串逗号分隔的 host，模型要的是**最外面**那一个，也就是第一个。
 * - **scheme**：`x-forwarded-proto` 有就用它；没有时按 host 猜：本机环回用 `http`，
 *   其它一律 `https`。为什么默认 https 而不是 http：这条 URL 会被粘到一个**别的机器
 *   上的客户端**里，而那个客户端只会把 token 发到这条 URL 上——默认明文是在替用户
 *   决定「把 token 裸着发出去」。
 *
 * 猜错时的表现是「客户端连不上」，用户能自己改；写死的表现是「永远错」，改不了。
 */
export function endpointFromHeaders(headers: Headers): string {
  const host = first(headers.get('x-forwarded-host')) ?? first(headers.get('host')) ?? 'localhost:3000';
  const proto = first(headers.get('x-forwarded-proto')) ?? (isLoopback(host) ? 'http' : 'https');
  return `${proto}://${host}${MCP_PATH}`;
}

/** 逗号串取第一个；空串当没有（`x-forwarded-proto: ''` 是能出现的）。 */
function first(raw: string | null): string | null {
  const value = raw?.split(',')[0]?.trim() ?? '';
  return value === '' ? null : value;
}

/**
 * 是不是本机。只用来决定 `http` 还是 `https`，不参与任何安全判断。
 *
 * `[::1]` 与 `[::1]:3000` 都要认：`next dev` 在 IPv6 上监听时 `host` 就是这种写法。
 */
function isLoopback(host: string): boolean {
  // `[::1]` / `[::1]:3000`：方括号里是 IPv6 字面量，冒号不是端口分隔符。
  const bracketed = /^\[([^\]]+)\]/.exec(host);
  if (bracketed !== null) return bracketed[1] === '::1';
  const name = host.split(':')[0] ?? '';
  return name === 'localhost' || name === '127.0.0.1' || name === '0.0.0.0';
}
