import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { db } from '../db/client.js';
import { authenticate } from '../../mcp/tokens.js';
import { runTool, toolByName } from '../../mcp/tools.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * flowers 的 REST 面（2026-11-11，H2）。
 *
 * ── 为什么要有它
 *
 * MCP 那 24 个工具是给 agent「理解规则」的：状态机、六问、权限、签字人，全在描述里。
 * 但让 agent 靠 MCP 一个个 tool call 干活，有两个成本：协议本身（initialize /
 * tools/call 的往返）与 token（每条描述都要进上下文）。owner 定的口径是：
 *
 * - **MCP 讲规则**：能做/不能做、为什么不能；
 * - **脚本调 API**：真正落地用 `curl` / node 脚本打 `/api/v1/*`；
 * - 技能包（skill）从 `/api/v1/skills/flowers-ops` 取，版本号就是内容哈希。
 *
 * ── 这一层不许有业务规则
 *
 * 每条路由都只是「HTTP → 已有工具 → JSON」，规则仍然只有一份（服务层 + `mcp/tools.ts`
 * 的 schema）。所以这里不写第二套校验：参数错了由工具的 zod 报中文，权限错了由服务层
 * 报 `forbidden`，状态错了报 `illegal_transition`——与 MCP 客户端拿到的字一模一样。
 *
 * ── 鉴权
 *
 * 与 `/mcp` 同一套 token（`flw_` 开头，绑成员、read/write 两级）。它回答「谁在操作」，
 * 不回答「能做什么」——后者照旧由成员的权限决定。
 */

/** 路由表：HTTP → 工具名。`null` = 不需要 token 的公开只读端点。 */
type Route = {
  method: 'GET' | 'POST' | 'PATCH';
  /** 路径模式，`:id` 是占位符。 */
  pattern: string;
  tool?: string;
  /** 从请求拼工具入参。 */
  args?: (ctx: RouteContext) => Record<string, unknown>;
};

type RouteContext = {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
};

const ACTIONS: Record<string, string> = {
  'start-design': 'requirement_start_design',
  'submit-review': 'requirement_submit_review',
  'review-pass': 'requirement_review_pass',
  'review-reject': 'requirement_review_reject',
  schedule: 'requirement_schedule',
  reschedule: 'requirement_reschedule',
  bounce: 'requirement_bounce',
  reject: 'requirement_reject',
  shelve: 'requirement_shelve',
  restore: 'requirement_restore',
  rollback: 'requirement_rollback',
  // 这两个也有自己的短路径（`/claim`、`/assign`）；列在这里是为了让
  // `/actions/claim` 这种写法也能用，省得脚本记两套。
  claim: 'requirement_claim',
  assign: 'requirement_assign',
};

const ROUTES: Route[] = [
  { method: 'GET', pattern: '/board', tool: 'requirement_list', args: () => ({}) },
  {
    method: 'GET',
    pattern: '/requirements',
    tool: 'requirement_list',
    args: ({ query }) => {
      const args: Record<string, unknown> = {};
      for (const key of ['state', 'owner', 'q']) {
        const value = query.get(key);
        if (value !== null && value !== '') args[key] = value;
      }
      for (const key of ['number', 'offset', 'limit']) {
        const value = query.get(key);
        if (value !== null && value !== '') args[key] = Number(value);
      }
      const mine = query.get('mine');
      if (mine === 'true' || mine === 'false') args.mine = mine === 'true';
      return args;
    },
  },
  { method: 'POST', pattern: '/requirements', tool: 'requirement_create', args: ({ body }) => body },
  {
    method: 'GET',
    pattern: '/requirements/:id',
    tool: 'requirement_show',
    args: ({ params }) => ({ requirementId: params.id }),
  },
  {
    method: 'PATCH',
    pattern: '/requirements/:id',
    tool: 'requirement_update',
    args: ({ params, body }) => ({ ...body, requirementId: params.id }),
  },
  {
    method: 'GET',
    pattern: '/requirements/:id/prd',
    tool: 'requirement_prd',
    args: ({ params, query }) => ({
      requirementId: params.id,
      ...(query.get('refresh') === '1' ? { refresh: true } : {}),
    }),
  },
  {
    method: 'POST',
    pattern: '/requirements/:id/claim',
    tool: 'requirement_claim',
    args: ({ params }) => ({ requirementId: params.id }),
  },
  {
    method: 'POST',
    pattern: '/requirements/:id/assign',
    tool: 'requirement_assign',
    args: ({ params, body }) => ({ ...body, requirementId: params.id }),
  },
  {
    method: 'POST',
    pattern: '/requirements/:id/plan',
    tool: 'uemaster_plan',
    args: ({ params, body }) => ({ ...body, requirementId: params.id }),
  },
  {
    method: 'POST',
    pattern: '/requirements/:id/artifacts',
    tool: 'uemaster_attach',
    args: ({ params, body }) => ({ ...body, requirementId: params.id }),
  },
  {
    method: 'POST',
    pattern: '/requirements/:id/actions/:action',
    args: ({ params, body }) => ({ ...body, requirementId: params.id, action: params.action }),
  },
  { method: 'GET', pattern: '/members', tool: 'member_list', args: () => ({}) },
  { method: 'GET', pattern: '/releases', tool: 'release_list', args: () => ({}) },
];

/** AppError 的 code → HTTP 状态。没列出来的一律 400（客户端可以按 code 细分）。 */
const STATUS_BY_CODE: Record<string, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_reviewer: 403,
  not_found: 404,
  illegal_transition: 409,
  missing_brief: 409,
  missing_prd: 409,
  missing_dates: 400,
  bad_dates: 400,
  invalid: 400,
  not_editable: 400,
  member_unknown: 400,
  conflict: 409,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 工具返回的是 `CallToolResult`：成功时第一段文本就是 JSON，失败时是一句中文。 */
function resultToResponse(result: CallToolResult): Response {
  const text = (result.content ?? [])
    .map((block) => (block as { text?: string }).text ?? '')
    .join('\n');
  if (result.isError === true) {
    // 工具错误 = 一句中文（+ 可选的一段机器码，见 `mcp/tools.ts` 的 `failed`）。
    // 按 code 决定状态码：403 / 404 / 409 客户端才好分支；取不到 code 就 400。
    const code = String((result as { _meta?: { code?: string } })._meta?.code ?? '');
    return json({ error: code === '' ? text : code, message: text }, STATUS_BY_CODE[code] ?? 400);
  }
  try {
    return json(JSON.parse(text));
  } catch {
    return json({ text });
  }
}

function matchRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  const parts = pathname.replace(/^\/api\/v1/, '').split('/').filter(Boolean);
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const patternParts = route.pattern.split('/').filter(Boolean);
    if (patternParts.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length; i += 1) {
      const pattern = patternParts[i]!;
      if (pattern.startsWith(':')) params[pattern.slice(1)] = decodeURIComponent(parts[i]!);
      else if (pattern !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route, params };
  }
  return null;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === 'GET') return {};
  const text = await request.text();
  if (text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 技能包：目录里每个文件算一份，版本号取内容哈希的前 12 位。 */
export function skillBundle(dir: string, name: string): {
  name: string; version: string; updatedAt: string; files: Array<{ path: string; content: string }>;
} {
  const files: Array<{ path: string; content: string }> = [];
  let updatedAt = 0;
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (!statSync(full).isFile()) continue;
    files.push({ path: `${name}/${entry}`, content: readFileSync(full, 'utf8') });
    updatedAt = Math.max(updatedAt, statSync(full).mtimeMs);
  }
  const hash = createHash('sha256')
    .update(files.map((f) => `${f.path}\n${f.content}`).join('\n'))
    .digest('hex')
    .slice(0, 12);
  return { name, version: hash, updatedAt: new Date(updatedAt).toISOString(), files };
}

const SKILLS = path.join(process.cwd(), 'skills');

export async function handleApiRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '');

  // 技能包与元信息：**公开只读**。它们没有密钥、没有业务数据，agent 拿到 token 之前
  // 往往要先看一眼「这套东西怎么用」；把它们关在门里，第一步就卡住了。
  if (pathname === '/api/v1/skills') {
    const names = readdirSync(SKILLS, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
    return json({
      skills: names.map((name) => {
        const bundle = skillBundle(path.join(SKILLS, name), name);
        return { name, version: bundle.version, updatedAt: bundle.updatedAt };
      }),
    });
  }
  if (pathname.startsWith('/api/v1/skills/')) {
    const name = pathname.slice('/api/v1/skills/'.length);
    try {
      return json(skillBundle(path.join(SKILLS, name), name));
    } catch {
      return json({ error: `没有这个技能包：${name}` }, 404);
    }
  }
  if (pathname === '/api/v1/meta') {
    const base = (process.env.FLOWERS_PUBLIC_URL ?? url.origin).replace(/\/+$/, '');
    return json({
      api: 'v1',
      skillUrl: `${base}/api/v1/skills/flowers-ops`,
      auth: 'Authorization: Bearer flw_…（设置页生成，read / write 两级）',
      note: '规则看 MCP 工具描述；执行用技能包里的脚本。写操作不要自动重试。',
    });
  }

  const auth = await authenticate(db, request.headers.get('authorization'));
  if (!auth.ok) return json({ error: 'unauthorized', message: auth.message }, auth.status);

  const matched = matchRoute(request.method, pathname);
  if (matched === null) {
    // 动作别名先翻译成工具名，再当成普通路由跑。
    const actionMatch = pathname.match(/^\/api\/v1\/requirements\/([^/]+)\/actions\/([^/]+)$/);
    if (actionMatch !== null && request.method === 'POST') {
      const tool = ACTIONS[actionMatch[2]!];
      if (tool === undefined) return json({ error: `不认识的动作：${actionMatch[2]}` }, 404);
      const body = await readJsonBody(request);
      const def = toolByName(tool)!;
      return resultToResponse(await runTool(def, auth.identity, { ...body, requirementId: actionMatch[1] }));
    }
    return json({ error: 'not_found' }, 404);
  }

  const { route, params } = matched;
  const body = await readJsonBody(request);
  const args = route.args?.({ params, query: url.searchParams, body }) ?? {};
  // 动作别名：/actions/* 那条路由把工具名藏在参数里。
  const toolName = route.tool ?? (typeof args.action === 'string' ? ACTIONS[args.action] : undefined);
  if (toolName === undefined) return json({ error: `不认识的动作：${String(args.action)}` }, 404);
  const def = toolByName(toolName);
  if (def === null) return json({ error: `没有这个工具：${toolName}` }, 500);

  const { action: _action, ...rest } = args;
  return resultToResponse(await runTool(def, auth.identity, rest));
}
