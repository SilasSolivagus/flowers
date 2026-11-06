/**
 * `/mcp` 的路径常量，只有一处。
 *
 * 为什么单独一个文件：路由文件（`app/mcp/route.ts`）与设置页都要说这条路径，而
 * 「端点在哪」如果各写一份，改名时一定漏一处——漏的那一处表现是「设置页让你贴
 * `/mcp/`，客户端连上去 404」。这个文件只导出一个字符串，谁 import 它都不会因此
 * 把 MCP SDK 或数据库拖进自己的 bundle（`app/settings/page.tsx` 是这么用的）。
 */
export const MCP_PATH = '/mcp';
