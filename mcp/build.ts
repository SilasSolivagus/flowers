import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOLS, runTool } from './tools.js';
import type { Identity } from './tokens.js';

/**
 * 把 `tools.ts` 里那份工具定义挂到一个 `McpServer` 上。
 *
 * **两个入口共用这一个函数**：`mcp/server.ts`（stdio，一个进程一个人）与
 * `app/mcp/route.ts`（Streamable HTTP，一个请求一份 token 换来的身份）。
 * 这样「工具长什么样」不可能分两个版本——之前只有 stdio，注册是写死在入口文件里的；
 * 现在再加一个 HTTP 入口，若各自抄一遍注册代码，两条路迟早在
 * 「这个工具要不要 readOnlyHint」「描述少一句合法状态」上分叉，而分叉的表现是
 * 「同一个 agent 换个客户端就调不动」。
 *
 * 每个工具绑定的是**那一刻的身份**（`identity` 被闭包住）：HTTP 上它是这个请求的
 * token 换来的成员，stdio 上它是 `FLOWERS_MCP_ACTOR`。工具本身拿不到「换个人」的口子，
 * 所以「这条记录记在谁头上」不取决于模型怎么填参数。
 */
export function createServer(identity: Identity): McpServer {
  const server = new McpServer({ name: 'flowers', version: '2.0.0' });

  for (const def of TOOLS) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        // 与 `runTool` 里解析用的是**同一个 zod 对象**（不是副本）：客户端看到的
        // JSON Schema 与服务端的校验因此不可能分叉。
        inputSchema: def.inputSchema,
        // 注解只是给客户端的提示（能不能缓存、要不要确认），不承担权限：
        // 权限在 `runTool` 的 scope 检查里，那一层是硬的。
        annotations: { readOnlyHint: def.scope === 'read', idempotentHint: def.scope === 'read' },
      },
      async (args) => runTool(def, identity, args),
    );
  }

  return server;
}
