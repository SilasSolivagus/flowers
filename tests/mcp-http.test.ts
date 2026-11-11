import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db, pool } from '../src/db/client.js';
import { POST } from '../app/mcp/route.js';
import { SERVICES } from '../mcp/services.js';
import { mintToken, revokeToken } from '../mcp/tokens.js';
import { resetDb, seedPeople } from './helpers/db.js';

/**
 * **端到端**：真的 HTTP、真的 MCP 客户端、真的库。
 *
 * 这一组与前面两组的分工：`mcp-token.test.ts` 测「头 → 身份」，`mcp-tools.test.ts` 测
 * 「工具 → 服务」，而这里测**把它们串起来的那一层**——`app/mcp/route.ts` 导出的 POST。
 * 它坏起来的样子是前两组一条都测不到的：
 * - Accept / Content-Type 的判定（客户端发的是 `application/json, text/event-stream`）；
 * - 无状态模式下「没有 initialize 那一层的会话」还能不能 `tools/call`；
 * - 401 是 HTTP 状态码而不是一个 JSON-RPC 错误（客户端据此决定「这个端点要不要重试」）。
 *
 * 做法：把一个 `node:http` 服务器挂在 `127.0.0.1:0`（随机端口）上，把收到的 Node 请求
 * 转成 Web `Request` 交给**路由导出的那个函数**，再把 `Response` 写回去。于是客户端
 * 走的是真 socket，而服务器侧没有 Next——**不监听公网、不连本地以外的任何地址**。
 *
 * 用官方 SDK 的 `Client` 而不是手搓 JSON-RPC：协议细节（initialize、notifications、
 * GET 探流）由它按规范发，我们测的是「我们的服务器接不接得住」。
 */

let http: Server;
let base = '';
let writeToken = '';
let readToken = '';
let revokedToken = '';

function bodyOf(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Node 的 headers → Web `Headers` 能吃的形状（多值头只取第一个；这里没有多值头）。 */
function headersOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') out[name] = value;
    else if (Array.isArray(value)) out[name] = value.join(', ');
  }
  return out;
}

beforeAll(async () => {
  http = createServer((req, res) => {
    void (async () => {
      const body = await bodyOf(req);
      const request = new Request(new URL(req.url ?? '/', base), {
        method: req.method,
        headers: headersOf(req),
        body: req.method === 'POST' ? new Uint8Array(body) : undefined,
      });
      const response = await POST(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer()));
    })();
  });
  await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve); });
  const address = http.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  await resetDb();
  const people = await seedPeople();
  const memberId = people.find((person) => person.name === '吕品')!.id;

  writeToken = (await mintToken(db, { memberId, label: 'test-write', scopes: 'write' })).raw;
  readToken = (await mintToken(db, { memberId, label: 'test-read', scopes: 'read' })).raw;
  const doomed = await mintToken(db, { memberId, label: 'test-revoked', scopes: 'write' });
  revokedToken = doomed.raw;
  await revokeToken(db, doomed.id);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await new Promise<void>((resolve) => { http.close(() => resolve()); });
  await pool.end();
});

/** 一套连上去的客户端。用完必须 `close()`——它持有一条可能存在的 SSE 连接。 */
async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'flowers-http-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

/**
 * 结果里的文本块拼起来。
 *
 * 参数写成 `unknown` 而不是 `CallToolResult`：`client.callTool` 的返回是一个联合类型
 * （普通结果 / `toolResult` 那种实验形态），而这里只关心「有没有 content」。
 */
function textOf(result: unknown): string {
  const blocks = ((result as { content?: Array<{ text?: string }> }).content ?? []);
  return blocks.map((block) => block.text ?? '').join('\n');
}

describe('/mcp 端到端（Streamable HTTP，无状态）', () => {
  it('initialize → tools/list：二十七个工具，描述里带权限与合法状态', async () => {
    const client = await connect(writeToken);
    try {
      const list = await client.listTools();
      expect(list.tools).toHaveLength(27);
      expect(list.tools.map((tool) => tool.name)).toContain('requirement_restore');

      const scheduleTool = list.tools.find((tool) => tool.name === 'requirement_schedule')!;
      expect(scheduleTool.description).toContain('权限：写');
      expect(scheduleTool.description).toContain('合法状态：「待排期」');
      // 客户端看到的 JSON Schema 就是 zod 那一份（必填三项 + requirementId 在列）。
      expect(scheduleTool.inputSchema.required).toEqual(
        ['requirementId', 'releaseId', 'commitTestAt', 'commitDueAt'],
      );
    } finally {
      await client.close();
    }
  });

  it('tools/call：建需求 → 读详情，actor 落进 events', async () => {
    const client = await connect(writeToken);
    try {
      const created = await client.callTool({
        name: 'requirement_create',
        arguments: { title: 'S3 协议支持', type: 'feature', requester: '孙建宏' },
      });
      expect(created.isError).toBeFalsy();
      const row = JSON.parse(textOf(created)) as { id: string; number: number; state: string };
      expect(row).toMatchObject({ number: 1, state: 'inbox' });

      const shown = await client.callTool({
        name: 'requirement_show',
        arguments: { requirementId: row.id },
      });
      expect(shown.isError).toBeFalsy();
      expect(JSON.parse(textOf(shown))).toMatchObject({ id: row.id, state: 'inbox' });

      // 无状态模式下的第二次请求是一个**全新的** McpServer —— 它照样认得这个人，
      // 因为身份是每个请求的 token 换来的，不是会话里记着的。
      const events = await db.execute<{ actor: string; type: string }>(
        `select actor, type from events order by seq`,
      );
      expect(events.rows).toEqual([{ actor: '吕品', type: 'requirement.created' }]);
    } finally {
      await client.close();
    }
  });

  it('缺 token → 401 + 中文，且一个服务都没被调用', async () => {
    const create = vi.spyOn(SERVICES, 'createRequirement');
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'requirement_create', arguments: { title: 'x', type: 'feature', requester: 'y' } },
      }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect((await response.json()) as { error: string }).toEqual({
      error: '缺少 token：请求头要带 Authorization: Bearer <token>',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('坏 token / 已撤销 token → 401（并且撤销真的生效）', async () => {
    for (const token of [`flw_${'Z'.repeat(43)}`, revokedToken]) {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(response.status).toBe(401);
      expect((await response.json()) as { error: string }).toEqual({ error: 'token 无效或已撤销' });
    }
  });

  it('形状不对的 token 一次库都不查（鉴权先于一切）', async () => {
    const execute = vi.spyOn(db, 'execute');
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer not-our-token',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it('GET（想挂钩 SSE 流）带好 token 也是 405，不带 token 是 401', async () => {
    const withoutToken = await fetch(`${base}/mcp`, { method: 'GET' });
    expect(withoutToken.status).toBe(401);

    const withToken = await fetch(`${base}/mcp`, {
      method: 'GET',
      headers: { authorization: `Bearer ${writeToken}`, accept: 'text/event-stream' },
    });
    expect(withToken.status).toBe(405);
    expect(withToken.headers.get('allow')).toBe('POST');
    expect((await withToken.json()) as { error: string }).toEqual({
      error: '这个端点只接受 POST（MCP Streamable HTTP 的无状态模式：GET 的 SSE 流没有东西可推）',
    });
  });

  it('read token 调写工具 → isError + 中文（服务没被调用）', async () => {
    const client = await connect(readToken);
    try {
      const schedule = vi.spyOn(SERVICES, 'schedule');
      const result = await client.callTool({
        name: 'requirement_schedule',
        arguments: {
          requirementId: '00000000-0000-4000-8000-000000000000',
          releaseId: '00000000-0000-4000-8000-000000000000',
          commitTestAt: '2027-01-10',
          commitDueAt: '2027-01-15',
        },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('这个 token 的权限是「读」，调用 requirement_schedule 需要「写」权限');
      expect(schedule).not.toHaveBeenCalled();

      // 同一个 read token 调读工具是通的 —— 权限不是「整条链路能不能用」的开关。
      const list = await client.callTool({ name: 'requirement_list', arguments: {} });
      expect(list.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it('响应是 application/json（enableJsonResponse），不是一条 SSE 流', async () => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${writeToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 7, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '0' } },
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    // 无状态：不发明会话 id（客户端也就不会去挂 GET 流）。
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const payload = (await response.json()) as { result: { serverInfo: { name: string } } };
    expect(payload.result.serverInfo.name).toBe('flowers');
  });
});
