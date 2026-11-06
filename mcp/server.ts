import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './build.js';
import type { Identity, Scope } from './tokens.js';

/**
 * stdio 入口：把工具挂给一个 agent 进程（Claude Code / Codex 本机拉起的那条路）。
 *
 * 这个文件只做三件事：决定「这次写入记在谁头上」、建 server、连上 stdin/stdout。
 * 参数校验、业务、落库都在 `mcp/tools.ts` 与 `src/core/` 里。
 *
 * P4.1 起 HTTP 是主路（`/mcp`，一条 URL + 一个 token，客户端的机器上不需要仓库和库）：
 * stdio 这条留在仓库里，是因为它**没有 token**——本机跑、本机能连库，本来就是这台部署
 * 的管理者。两条入口挂的是同一份工具定义（`build.ts`），不存在「stdio 有、HTTP 没有」。
 *
 * **stdout 是协议通道**，不是日志：任何 `console.log` 都会插进 JSON-RPC 流里，
 * 让客户端读到半行 JSON 然后断连。所以诊断一律 `console.error`（stderr 客户端会
 * 原样显示，正是想要的）。
 */

/**
 * 写操作的那个人。
 *
 * `FLOWERS_MCP_ACTOR` 由使用者（`claude mcp add` 的那条命令、`.mcp.json` 的 env）
 * 指定，值直接进 `events.actor` 与 `uemaster_artifacts.created_by`。缺省是 `agent`：
 * 宁可时间线上写着「agent」，也不要让它看起来像是某个真人点的。
 * 空串与纯空白当没配——`actor=''` 在时间轴上是一行看不见来源的记录。
 */
export function mcpActor(): string {
  const name = process.env.FLOWERS_MCP_ACTOR?.trim();
  return name !== undefined && name.length > 0 ? name : 'agent';
}

/**
 * stdio 的身份：actor 从环境变量来，**权限给 write**。
 *
 * 为什么不是 admin：今天没有任何工具要求 admin（见 tokens.ts 的 RANK 注释），
 * 给一个没有消费者的级别只会让人以为这里有一道没开的管理门。
 * 为什么不需要 token：能起这个进程的人已经有仓库和 `DATABASE_URL`——他本来就能
 * 直接改库，再给他一把 token 是仪式，不是边界。**HTTP 那条才是需要鉴权的那条**：
 * 它面向的是「不在这台机器上」的客户端。
 */
export function stdioIdentity(): Identity {
  const scope: Scope = 'write';
  return { tokenId: 'stdio', memberId: '', member: mcpActor(), scope };
}

/**
 * 连上 stdio 就进入常驻：客户端关掉 stdin 时进程随之退出。
 *
 * `mcpActor()` 只在这里被读一次（为了在启动日志里说清「这次写入会记在谁头上」）；
 * 真正取 actor 的地方是工具调用时用的那份 `identity`，它由 `stdioIdentity()` 在启动时
 * 定下来——环境变量改了要重启进程，与以前每次调用读一次的行为不同，而这一次改是对的：
 * 一个进程只有一个身份，中途换人只会让时间线上前后两条记录看起来像两个人干的。
 */
async function main(): Promise<void> {
  const identity = stdioIdentity();
  const server = createServer(identity);
  await server.connect(new StdioServerTransport());
  // stderr：客户端把它当服务端日志显示，不会污染 JSON-RPC 流。
  console.error(`[flowers-mcp] 已连接 stdio · actor=${identity.member} · scope=${identity.scope}`);
}

main().catch((error: unknown) => {
  console.error('[flowers-mcp] 启动失败：', error);
  process.exitCode = 1;
});
