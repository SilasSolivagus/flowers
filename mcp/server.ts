import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AppError } from '../src/core/errors.js';
import {
  attachInput, attachTool, mcpActor, planInput, planTool, showInput, showTool,
} from './tools.js';

/**
 * stdio MCP server：把三个工具挂给一个 agent 进程（Claude Code / Codex）。
 *
 * 这个文件只做三件事：注册工具、把异常翻成 `isError`、连上 stdin/stdout。
 * 参数校验、业务、落库都在 `tools.ts` 与 `src/core/uemaster/` 里——它们在测试里
 * 能直接跑，而这里不能。
 *
 * **stdout 是协议通道**，不是日志：任何 `console.log` 都会插进 JSON-RPC 流里，
 * 让客户端读到半行 JSON 然后断连。所以诊断一律 `console.error`（stderr 客户端会
 * 原样显示，正是想要的）。
 */

/**
 * 成功的结果。
 *
 * `blocks` 是**多段文本**而不是一段：`uemaster_plan` 的正文（任务包）必须原样交给
 * agent，塞进 JSON 会变成一行 `"pack": "任务：...\n输入：..."` 的转义串——agent 读得懂，
 * 但少了「这段文字就是给你的指令」这层意思。第一段放结构化的身份（PAN-n / uuid / 状态），
 * 第二段放包正文；其余工具只有一段 JSON。
 */
function succeeded(blocks: string[]): CallToolResult {
  return { content: blocks.map((text) => ({ type: 'text' as const, text })) };
}

/** 失败的结果：`isError: true` + 那句中文。内容与成功同形，客户端不需要第二种解析。 */
function failed(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * 把工具的异常翻成 MCP 的失败结果。
 *
 * 两条出口，刻意分开：
 * - `AppError`（需求不存在、stage 不认识、文件没写、ID 不是 uuid）是**预料之内**的用户
 *   错误，消息本身就是给人看的，直接原样交回，不加前缀、不打堆栈。
 * - 其它异常（连不上库、磁盘、代码 bug）不吞：打一条 stderr 留证据，然后**照样抛出去**，
 *   由 SDK 的请求处理器收成 `isError: true`（`mcp.js` 的 `createToolError`）。
 *   为什么不在这里也包成 `failed(String(error))`：那会让「库挂了」看起来与「参数填错了」
 *   一模一样，而这两种坏法该让人看见不同的东西——前者的原始堆栈必须留在服务端日志里。
 *
 * 两条都不返回成功。把异常吞成 success 是这套工具最坏的失败方式：agent 会以为材料
 * 交上去了，抽屉里却什么都没有。
 */
async function run(blocks: () => Promise<string[]>): Promise<CallToolResult> {
  try {
    return succeeded(await blocks());
  } catch (error) {
    if (error instanceof AppError) return failed(error.message);
    console.error('[flowers-mcp] 未预期错误：', error);
    throw error;
  }
}

const server = new McpServer({ name: 'flowers', version: '1.0.0' });

/**
 * 三个工具。描述的读者是 agent（它只读得到这些字），所以每条都说清
 * 「什么时候用、会不会改数据、下一步是什么」——它不会回来问人。
 *
 * `inputSchema` 用的是 `tools.ts` 导出的同一个 zod 对象（不是它的副本）：
 * 客户端看到的 JSON Schema 与服务端的校验因此不可能分叉。
 */
server.registerTool(
  'uemaster_plan',
  {
    title: '取 UEmaster 任务包',
    description:
      '为一条需求生成某个阶段的 UEmaster 任务包（可直接执行的中文指令：画什么、写到哪个文件、怎么交回来）。'
      + '阶段只有 evaluate（评估）/ review（评审）/ inspect（走查）。'
      + '纯读：不改需求状态、不写时间线。拿到包之后照它做，写完文件再调 uemaster_attach。',
    inputSchema: planInput,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  // 包正文单独一段：它就是给 agent 的指令，不该被 JSON 转义成一行。
  async ({ requirementId, stage }) => run(async () => {
    const got = await planTool({ requirementId, stage });
    return [JSON.stringify(got.requirement, null, 2), got.pack];
  }),
);

server.registerTool(
  'uemaster_attach',
  {
    title: '交回 UEmaster 产物',
    description:
      '把已经生成好的产物链接交出：站内路径（形如 /uemaster/PAN-7/evaluate.html，项目根目录 data/uemaster/ 下必须真有这个文件）'
      + '或 http(s) 完整链接。会写一条 uemaster.attached 事件，抽屉「参考」段随即出现链接。',
    inputSchema: attachInput,
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
  async ({ requirementId, stage, url }) => run(async () => {
    const got = await attachTool({ requirementId, stage, url });
    return [JSON.stringify(got, null, 2)];
  }),
);

server.registerTool(
  'requirement_show',
  {
    title: '看一条需求的现状',
    description:
      '读一条需求：当前状态、类型、负责人、提出人、PRD 链接、已有产物、还缺哪几个阶段，'
      + '以及当前状态下合法的动作。用它决定下一步，不必问人。纯读。',
    inputSchema: showInput,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ requirementId }) => run(async () => {
    const got = await showTool({ requirementId });
    return [JSON.stringify(got, null, 2)];
  }),
);

/**
 * 连上 stdio 就进入常驻：客户端关掉 stdin 时进程随之退出。
 *
 * `mcpActor()` 只在这里被读一次（为了在启动日志里说清「这次写入会记在谁头上」）；
 * 真正取 actor 的地方是 `attachTool`，每次调用时读，环境变量改了立刻生效。
 */
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr：客户端把它当服务端日志显示，不会污染 JSON-RPC 流。
  console.error(`[flowers-mcp] 已连接 stdio · actor=${mcpActor()}`);
}

main().catch((error: unknown) => {
  console.error('[flowers-mcp] 启动失败：', error);
  process.exitCode = 1;
});
