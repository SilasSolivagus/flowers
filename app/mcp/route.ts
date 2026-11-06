import { handleMcpRequest } from '../../mcp/http';

/**
 * `/mcp`：MCP 客户端直连的那个端点。
 *
 * 这个文件只有一行实质内容——把请求交给 `mcp/http.ts` 的处理器。为什么不在路由文件里
 * 写逻辑：Next 的 route 模块只能在 Next 运行时里被加载，而 `handleMcpRequest` 是
 * 普通的 `(Request) => Promise<Response>`，用例可以**直接**把它接到一个本机
 * `http.createServer` 上跑完整协议（`tests/mcp-http.test.ts` 就是这么做的）。
 * 逻辑留在能测的那一侧，入口只留 Next 专有的三行声明。
 */

/** 无状态、无缓存：每次请求都要过鉴权，结果取决于请求头，不可能被缓存。 */
export const dynamic = 'force-dynamic';

/** Node 运行时：`pg` 与 `node:crypto` 都在这一侧（Edge 里没有）。 */
export const runtime = 'nodejs';

export const POST = (request: Request): Promise<Response> => handleMcpRequest(request);

/**
 * GET / PUT / PATCH / DELETE：同一个处理器，它会先鉴权、再回 405。
 *
 * 为什么不在这一层就回 405：那样「这个端点有没有人守」就变成了一个不需要凭据的探测点
 * ——未鉴权的行为与已鉴权的行为长得一样，等于把端点指纹送出去。
 */
export const GET = (request: Request): Promise<Response> => handleMcpRequest(request);
export const DELETE = (request: Request): Promise<Response> => handleMcpRequest(request);
export const PUT = (request: Request): Promise<Response> => handleMcpRequest(request);
export const PATCH = (request: Request): Promise<Response> => handleMcpRequest(request);
