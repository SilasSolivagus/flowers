import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { db } from '../src/db/client.js';
import { createServer } from './build.js';
import { authenticate } from './tokens.js';

/**
 * `/mcp` 这个 HTTP 端点：MCP over **Streamable HTTP**。
 *
 * 为什么是 Streamable HTTP 而不是 stdio / SSE：
 * - stdio 要求客户端在本机起一个进程，而这条路要的是「粘一条 URL + 一个 token」——
 *   对方的机器上没有这个仓库、没有 `DATABASE_URL`，也不该有；
 * - 老的 HTTP+SSE（`SSEServerTransport`）每条连接要挂一个长连接、断线就断会话，
 *   而这里每个 `tools/call` 都是一次独立请求，中间还可能经过 nginx / 隧道；
 *   Streamable HTTP 是现在这一代的官方传输（`POST` 走 JSON-RPC，`GET` 才开流）。
 *
 * 这个文件做三件事，顺序不能换：**鉴权 → 建一个绑定身份的 server → 交给 transport**。
 *
 * ## 为什么是「无状态」：每个请求一份 transport
 *
 * `sessionIdGenerator: undefined` 就是 SDK 的无状态模式：没有 `Mcp-Session-Id`，
 * 也不校验它。这与「每个请求都重新解析一次 token」是同一件事的两面——
 *
 * - 身份只活在一个请求里。一个 token 被撤销之后，下一个请求立刻 401，不存在
 *   「这个会话是十分钟前建立的，所以它还记得那个人是谁」这种窗口；
 * - 服务进程里没有会话表。Next 的 dev / 多 worker / 重启都不会把谁的会话搞丢，
 *   也不需要「会话清理」这种容易写错的代码。
 *
 * 代价：服务端不能主动给客户端推消息（`notifications/*`、进度）。这套工具全是
 * 请求-响应，一个都不需要推，所以这个代价是零。
 *
 * ## 为什么 GET / DELETE 是 405
 *
 * 无状态模式下没有「会话」可以删（DELETE 无意义），也没有服务端主动推送要挂
 * （GET 的 SSE 流只会挂在那里永远不写东西）。按 MCP 规范，服务器对 GET 返回
 * 405 是合法答复，客户端会退回「只用 POST」。这比挂一条永远不结束的连接诚实。
 */

/** 端点路径的唯一来源在 `path.ts`；这里 re-export 一次，调用方不必记两个路径。 */
export { MCP_PATH } from './path.js';

const ONLY_POST = '这个端点只接受 POST（MCP Streamable HTTP 的无状态模式：GET 的 SSE 流没有东西可推）';

/** 错误的形状与 MCP 的错误结果不同：这是 HTTP 层的拒绝，客户端读的是那句话。 */
function errorResponse(status: number, message: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
  // RFC 6750：401 要带 WWW-Authenticate，客户端据此知道该用 Bearer。
  if (status === 401) headers['www-authenticate'] = 'Bearer';
  if (status === 405) headers.allow = 'POST';
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

/**
 * 处理一次 `/mcp` 请求。
 *
 * 顺序是刻意的，每一条都有用例钉着：
 *
 * 1. **先鉴权，再碰任何别的东西。** 缺 token / token 形状不对时，`authenticate`
 *    一次查询都不发；形状对了才查一次 `token_hash`（唯一索引）。401 之后**没有任何
 *    服务被调用**——一个没有身份的请求不该在时间线上留下半条记录，也不该让库替它
 *    算一次看板。
 * 2. 鉴权过了才看方法。GET 是被允许到达这一层的（客户端会先试探），所以它也需要
 *    身份：否则「这个端点存不存在」这件事能被人无凭据地探出来。
 * 3. 每个请求新建一个 server + transport（无状态模式的要求，见文件头）。身份被闭包
 *    在 server 里：工具拿不到「换个人」的口子。
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const auth = await authenticate(db, request.headers.get('authorization'));
  if (!auth.ok) return errorResponse(auth.status, auth.message);

  if (request.method !== 'POST') return errorResponse(405, ONLY_POST);

  const server = createServer(auth.identity);
  const transport = new WebStandardStreamableHTTPServerTransport({
    // undefined = 无状态：没有会话 id，也不校验它（见文件头）。
    sessionIdGenerator: undefined,
    // 直接回 `application/json` 而不是开 SSE 流：这套工具全是请求-响应，
    // 而一段 JSON 让 `curl`、用例、以及「客户端到底收到了什么」都变得可读。
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // JSON 响应在这里已经成形（handleRequest 只有在结果备好后才返回），
    // 关掉 transport 不会截断它；不关就会把每次请求的监听器留在进程里。
    await server.close();
  }
}
