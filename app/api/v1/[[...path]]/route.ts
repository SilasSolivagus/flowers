import { handleApiRequest } from '../../../../src/api/router';

/**
 * `/api/v1/*`：给脚本与 agent 的 REST 面（2026-11-11）。
 *
 * 逻辑在 `src/api/router.ts`（普通 `(Request) => Promise<Response>`），路由文件只留三行
 * Next 专有的声明——与 `/mcp` 同一个形状：能测的那部分不放进只能在 Next 里加载的模块。
 *
 * 为什么要 catch-all：CRUD 的路径带 id、带子资源（`/requirements/:id/claim` 这种），
 * 一个文件里按段分发比建十几个薄路由文件更不容易漏。规则一条都不在这里。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = (request: Request): Promise<Response> => handleApiRequest(request);
export const POST = (request: Request): Promise<Response> => handleApiRequest(request);
export const PATCH = (request: Request): Promise<Response> => handleApiRequest(request);
