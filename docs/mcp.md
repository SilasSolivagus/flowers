# MCP server · 让你的 agent 出 UEmaster 材料

Flowers 自己**不调模型**：评估 / 评审 / 走查这三处要的材料，由你手上的 agent
（Claude Code / Codex）用 [UEmaster](https://github.com/SilasSolivagus/UEmaster) 生成。
这个仓库里 `mcp/server.ts` 就是那座桥——一个只讲 stdio 的 MCP server，把三件事交给 agent：
拿任务包、把产物交回来、看一条需求的现状。

```
你的 agent ──stdio──▶ mcp/server.ts ──▶ src/core/uemaster（任务包 / 落库 / 事件）
                                            └─▶ Postgres（uemaster_artifacts、events）
```

## 接上

前置：`npm install`、`npm run db:up && npm run db:migrate`、库里有数据（`npm run seed`）。

**server 从哪个目录启动都行**：交付链接是站内路径（`/uemaster/PAN-9/evaluate.html`），
`attach` 拿它去验文件时，基准是**本仓库的** `data/uemaster/`——这个基准从
`src/core/uemaster/store.ts` 自己的位置推出来（往上三层就是仓库根），不读 `process.cwd()`。
所以 agent 客户端把 server 起在自己的项目目录里也不会莫名其妙报「产物文件不存在」。
cwd 只影响一件事：用相对路径写 `mcp/server.ts` 时，得能从这个 cwd 找到这个脚本。

### Claude Code

```bash
# 在仓库根目录跑一次；作用域 project 会写进 .mcp.json
claude mcp add flowers \
  -e FLOWERS_MCP_ACTOR=claude-code \
  -- npx tsx mcp/server.ts
```

或者手写 `.mcp.json`（提交到仓库也不会带出密钥，这里没有密钥）：

```json
{
  "mcpServers": {
    "flowers": {
      "command": "npx",
      "args": ["tsx", "mcp/server.ts"],
      "env": { "FLOWERS_MCP_ACTOR": "claude-code" }
    }
  }
}
```

`claude mcp list` 里看到 `flowers` 就是接上了；在会话里用 `/mcp` 能看到三个工具。

客户端不在仓库根启动时，把脚本写成绝对路径就行——**校验不看 cwd，只有找脚本看路**：

```bash
claude mcp add flowers \
  -e FLOWERS_MCP_ACTOR=claude-code \
  -- npx tsx /Users/silas/flowers/mcp/server.ts
```

### Codex

```bash
codex mcp add flowers \
  --env FLOWERS_MCP_ACTOR=codex \
  -- npx tsx mcp/server.ts
```

等价于 `~/.codex/config.toml` 里这段（手写也行）：

```toml
[mcp_servers.flowers]
command = "npx"
args = ["tsx", "mcp/server.ts"]
env = { FLOWERS_MCP_ACTOR = "codex" }
```

确认：`codex mcp list` 里出现 `flowers`（带 `FLOWERS_MCP_ACTOR`，值会打码）。

### 手动起一次

```bash
npm run mcp          # = tsx mcp/server.ts，等 stdin 上的 JSON-RPC
npx tsx scripts/mcp-smoke.ts <需求 id>   # 用 SDK 的 client 连上去跑一遍三个工具
```

`npm run mcp` 只有在仓库根（或任何能找到这个 tsx 的目录）才起得来，但**它起来之后
cwd 就不再影响任何判断**：验产物看的是模块位置，不是它站在哪。

smoke 脚本另有一个作用：它**从任务包正文里抠出交付路径**再写文件，等于在验证
「包写清楚了 agent 该往哪写」。

## 三个工具

| 工具 | 参数 | 做什么 | 会不会写库 |
| --- | --- | --- | --- |
| `uemaster_plan` | `requirementId`, `stage` | 读需求 → 返回该阶段的任务包（中文、可直接执行：画什么、写到哪个文件、怎么交回）。附带需求身份（`PAN-n`、uuid、状态、类型） | **不写**。不改状态、不写事件 |
| `uemaster_attach` | `requirementId`, `stage`, `url` | 把产物链接交回来。站内路径必须真有文件（`data/uemaster/` 下），否则 `artifact_missing` | 写：一行 `uemaster_artifacts` + 一条 `uemaster.attached` 事件。`stage=evaluate` 且需求还在**收集**时，同一个事务里再把它推进到**待设计**（多一条 `requirement.evaluated`；没有类型则 `missing_type`，整条 attach 回滚） |
| `requirement_show` | `requirementId` | 现状：状态、类型、提出人、负责人、PRD、已有产物、还缺哪几个 stage、当前状态下合法的动作 | 不写 |

`stage` 只有三个值：`evaluate`（评估）/ `review`（评审）/ `inspect`（走查）。
`requirementId` 是 uuid（不是 `PAN-9`）。

`uemaster_plan` 的返回是两段文本：第一段是需求身份的 JSON，第二段是任务包正文——
正文原样交给你，不塞进 JSON 字符串里。三个工具的参数 schema 与客户端看到的
JSON Schema 是同一份（`mcp/tools.ts` 导出），不会出现「客户端说能调、服务端拒了」。

## actor：这条材料记在谁头上

`FLOWERS_MCP_ACTOR` 决定 `events.actor` 与 `uemaster_artifacts.created_by`。
缺省 `agent`（空串也算没配）。抽屉的「记录」段因此会显示：

```
claude-code  提交评估材料 · /uemaster/PAN-9/evaluate.html
```

想区分是谁的 agent 干的，就一个客户端一个值：`claude-code` / `codex` / `ci`。
不要填真人姓名——那会让时间线看起来是某个人点的。

## 五步闭环

1. `requirement_show` 看这条需求要什么、还缺哪个 stage。
2. `uemaster_plan` 拿任务包（里面写着需求、PRD、装哪两个 skill、产出形状、写到哪、怎么交回）。
3. agent 照包做：装 UEmaster 的 `flow-canvas` / `flow-walkthrough`，生成**单个自足的 HTML**。
4. 文件落到包指定的路径 `data/uemaster/PAN-<n>/<stage>.html`。
5. `uemaster_attach` 交回 `/uemaster/PAN-<n>/<stage>.html` —— 抽屉「参考」段立刻出现这一行，点得开。

   **评估材料就是那道门的通行证**：需求还在「收集」里时交回 `stage=evaluate`，它会在同一个
   事务里被推进到「待设计」——用户不再需要在动作条上点一个按钮（那个按钮已经去掉了）。
   已经在「待设计」或更后面的需求补一份新评估，只换材料，不会被打回。

文件本身不由 Next 的静态根服务：`data/uemaster/` 不在 `public/` 里，读它的是动态路由
`app/uemaster/[...path]/route.ts`，每个响应都带 `Content-Security-Policy: sandbox;
default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:` 与
`X-Content-Type-Options: nosniff`。原因是产物是**同源的第三方内容**：从静态根直接服务，
它里面的 `<script>` 会带着本站 cookie 跑，一份交回来的 HTML 就能改本站。`sandbox` 把它
关进不透明源（读不到 `document.cookie`、storage、带凭据的接口）；代价是脚本不执行，
所以 `flow-walkthrough` 那种「点左边节点切右边页面」的交互在站内是死的——双击本地文件
打开仍然是活的。

没有 PRD 的需求：评估照做（推断处标「PRD 未提供」），评审与走查的包会直接让你停下并把
「缺少 PRD 链接」回报给用户——这两份材料的输入就是 PRD，没有它做出来的东西是编的。

## 失败长什么样

所有失败都是 MCP 的**工具错误**（`isError: true` + 一句中文），不是进程崩溃，也不会被吞成成功：

| 情况 | 文案（`isError: true`） |
| --- | --- |
| 需求 id 打错 / 不存在 | `需求不存在` |
| `stage` 不是三个值之一 | `阶段只能是 evaluate、review、inspect 之一` |
| `requirementId` 不是 uuid / 没传 | `需求 ID 格式不正确` |
| 站内路径没文件 | `产物文件不存在：data/uemaster/PAN-9/evaluate.html —— 先把文件写到…` |
| 链接不是 http(s) 也不是站内路径 | `产物链接必须是以 http:// 或 https:// 开头的完整链接，或以 /uemaster/ 开头的站内路径` |

参数形状的错（上个表前三条里 schema 能判的部分）由 MCP 层在调用工具**之前**拦下，
文案里会多一层 SDK 自己的前缀（`MCP error -32602: Input validation error: …`），中文还在后面；
领域层的错（需求不存在、文件缺失、链接非法）是干净的一句中文。两者都不会中断连接——
报过错之后同一个会话可以继续调。

真正的意外（连不上库、磁盘故障、代码 bug）不在这里翻译：原始堆栈打到 **stderr**
（客户端会把它当服务端日志显示），工具侧同样以 `isError` 结束。这样「库挂了」与
「参数填错了」不会长得一模一样。

注意 **stdout 是协议通道**：这个 server 的任何诊断都走 stderr，不要在里面 `console.log`。
