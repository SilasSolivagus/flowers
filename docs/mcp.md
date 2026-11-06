# MCP · 把 Flowers 接给你的 agent

Flowers 有一个 **MCP 端点**：`/mcp`。任何人拿到**一条 URL + 一个 token**，就能让自己的
agent（Claude Code / Cursor / Codex / 任何 MCP 客户端）直接操作这个部署里的需求——
**不需要克隆仓库，不需要数据库密码**，客户端只认 HTTP。

```
你的 agent ──HTTPS──▶ https://<host>/mcp ──▶ src/core（状态机、事件、产物）
                              │
                              └─ token → members → actor（「谁承诺了哪一天」）
```

暴露的是**整套状态机**（P4.1 的选项 C）：agent 能提需求、提交评审、签字、排期、打回、
拒绝、搁置、恢复。这是 owner 明确选的——代价是每个动作都会在时间线上写下「谁干的」，
所以 **token 必须绑到一个人**，没有匿名的动作（见「token 模型」）。

> 旧版本是只讲 stdio 的（`mcp/server.ts`，本机拉起一个子进程）。那条路还在，见
> 「stdio（本机那条路）」。P4.1 起 HTTP 是主路。

## 接上：三步

**1. 生成 token。** 打开 `/settings?tab=me` → 「接你的 agent」→「生成 token」：起个名字
（`claude-code`）、选权限（只读 / 读写）。token 原文**只显示这一次**，关掉就再也看不到——
库里存的是 sha256。

**2. 把那一行粘进客户端。** 设置页上三行都带着真 token，复制即用：

```bash
# Claude Code（写在 ~/.claude.json / .mcp.json 里，作用域按 -s 定）
claude mcp add --transport http flowers https://<host>/mcp \
  --header "Authorization: Bearer <token>"
```

```json
// Cursor：~/.cursor/mcp.json
{"mcpServers":{"flowers":{"url":"https://<host>/mcp","headers":{"Authorization":"Bearer <token>"}}}}
```

```bash
# Codex：~/.codex/config.toml 里会多一段 mcp_servers.flowers
codex mcp add flowers --url https://<host>/mcp --bearer-token-env-var FLOWERS_MCP_TOKEN
```

`--bearer-token-env-var` 是**变量名**，不是 token 本身：把 token 放进环境变量
（`export FLOWERS_MCP_TOKEN=flw_…`），配置文件里就不留密文。Claude Code 与 Cursor 也各
允许用环境变量展开，具体看各自文档；这一页只负责给出「能直接跑」的那一行。

**3. 验证。**

```bash
curl -s https://<host>/mcp \
  -H "Authorization: Bearer $FLOWERS_MCP_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

返回 14 个工具就是通了。没有 token 会拿到 **401 + 一句中文**：

```json
{"error":"缺少 token：请求头要带 Authorization: Bearer <token>"}
```

## 传输：为什么是 Streamable HTTP

| 方案 | 为什么不选 |
| --- | --- |
| **stdio** | 客户端得在本机起一个进程，还要这个仓库、Node、`DATABASE_URL`。这条路要的是「粘一条 URL」。 |
| **HTTP+SSE（旧）** | 每条连接挂一个长会话，断线就断会话；客户端在网络里一抖（隧道、休眠、换网）就重来。 |
| **Streamable HTTP（选了它）** | 现在这一代的官方传输：`POST` 走 JSON-RPC，`GET` 才开流。`tools/call` 是一次独立请求，中间过 nginx / 隧道都不影响。 |

实现是 `@modelcontextprotocol/sdk` 的 `WebStandardStreamableHTTPServerTransport`
（Next 16 的 route handler 就是 Web `Request`/`Response`，不需要 Node 适配层），
入口在 `app/mcp/route.ts`，逻辑在 `mcp/http.ts`。

**无状态**（`sessionIdGenerator: undefined`）：没有 `Mcp-Session-Id`，每个请求都重新解析
一次 token。于是

- token 撤销之后**下一个请求立刻 401**，不存在「这个会话是十分钟前建立的」那种窗口；
- 进程里没有会话表，dev / 多 worker / 重启都不会把谁的会话搞丢；
- 代价是服务端不能主动推送（`notifications/*`、进度）。这套工具全是请求-响应，用不到。

`GET`（想挂钩 SSE 流）与 `DELETE`（想删会话）回 **405**：无状态模式下没有会话可删，
也没有东西可推。这是规范允许的答复，SDK 的客户端看到 405 就退回「只用 POST」。

## token 模型

表 `mcp_tokens`（迁移 `0009_mcp_tokens.sql`）：

| 列 | 说明 |
| --- | --- |
| `id` | uuid |
| `token_hash` | **sha256 十六进制，只存这个**。原文（`flw_` + 32 字节随机）只在生成时出现一次 |
| `member_id` | FK → `members`。**这就是身份**：请求 → token → 成员 → `actor` |
| `label` | 生成时必填的名字（`claude-code` / `cursor` / `ci`） |
| `scopes` | `read` \| `write` \| `admin`（包含关系：read ⊂ write ⊂ admin） |
| `created_at` / `revoked_at` | 撤销是**软删除**：写 `revoked_at`，不删行 |

为什么 sha256 而不是 bcrypt/argon2：token 是 32 字节的随机值，没有字典可查，也没有
彩虹表；而每次 `tools/call` 都要验一次，慢哈希买不到安全，只买到延迟。

为什么绑成员而不是「一个共享密钥」：整套状态机交给 agent 之后，**每次动作都会写一句
承诺**（`requirement.scheduled` 的 payload 里有提测日与承诺完成日，`events.actor` 是那个
人的名字）。共享密钥会让这一行失去意义。所以：

```ts
// mcp/tools.ts —— actor 永远来自 token，不是工具参数
SERVICES.schedule(db, identity.member, { requirementId, releaseId, commitTestAt, commitDueAt });
```

评审签字这条尤其明显：`reviewPass` 会校验「签字人是不是这条需求派单上的评审人」
（`src/core/requirements/review.ts` 的 `assertReviewer`）。用吕品的 token 去签赵越的单，
拿到的是 `签字人不是这条需求派单到的评审人`——**这跟界面上点同一个按钮的结果一模一样**，
因为两边调的是同一个服务。

`admin` 今天**没有任何工具要求**：权限这一级留着是为了「以后有管理类工具时不必改词表」，
现在给 token admin 只是「这个人可以写」。没有管理工具就不要编一个出来。

### 撤销

设置页那一行的「撤销」写 `revoked_at`。之后这个 token 的所有请求 401，但**那一行不删**：
它写过的事件还指着它，owner 要能回答「上个月那个自动排期是谁干的」。

## 工具表

十四个。`read` 是只读，`write` 会推进状态并写 `events.actor`。

| 工具 | 权限 | 从哪些状态合法 | 做什么 / 要什么 |
| --- | --- | --- | --- |
| `requirement_list` | read | 任何状态 | 看板一行摘要（编号、标题、状态、负责人、等谁、停几天）。可过滤 `state` / `owner` / `mine` |
| `requirement_show` | read | 任何状态 | 现状 + 已有产物 + 还缺哪个 stage + **当前状态下合法的动作** |
| `requirement_prd` | read | 任何状态 | PRD markdown。默认用最近一次快照；`refresh=true` 现读源文档（那一步会落一版快照 + 一条事件） |
| `uemaster_plan` | read | 任何状态 | 该阶段的 UEmaster 任务包（中文、可直接执行）。纯读 |
| `requirement_create` | write | —（新建） | 提需求，落在「收集」。要 `title` / `type`（commercial\|feature）/ `requester`，可选 `ownerMemberId` |
| `uemaster_attach` | write | 任何状态 | 交回产物链接。站内路径 `data/uemaster/` 下必须真有文件 |
| `requirement_submit_review` | write | 收集、待设计 | 进「待评审」并按类型派单。**必须给正式 PRD 链接** |
| `requirement_review_pass` | write | 待评审 | 签字通过 → 待排期。**token 那个人必须是派单上的评审人** |
| `requirement_review_reject` | write | 待评审 | 打回 → 待设计。原因必填 |
| `requirement_schedule` | write | 待排期 | 排进版本 → 待开发。要 `releaseId` + 提测日 + 承诺完成日（YYYY-MM-DD），后者不能早于提测日、不能晚于版本发版日 |
| `requirement_bounce` | write | 测试中 | 打回开发中。原因必填 + 重填承诺完成日（不能早于今天） |
| `requirement_reject` | write | 收集 | 拒绝（终态）。原因必填。只有「收集」能拒绝——评估过的需求要毙就写评审意见 |
| `requirement_shelve` | write | 除终态外全部 | 搁置。原因必填。还挂着的评审派单会一起作废 |
| `requirement_restore` | write | 已搁置 | 放回「收集」，重新走一遍流程 |

「从哪些状态合法」这一列**不是手写的散文**：

- 每个工具在 `mcp/tools.ts` 声明它对应 `detail.ts` 的哪个 `DetailAction`；
- 状态清单从 `LEGAL_FROM` 取，描述里的中文由 `STATE_LABEL` 拼出来，所以工具描述与
  这张表不可能各说各的；
- `tests/mcp-legal-from.test.ts` 把十个状态**都造一遍真需求**，逐状态比对
  `getRequirementDetail().actions`（就是 `actionsFor`）与 MCP 声明的集合，**双向相等**。
  页面动作条改了而 MCP 没跟，这条测试立刻红——那正是「agent 看到一个点了必然被拒的
  按钮」的开始。

`evaluate` **没有工具**：它不是「点一下就能完成」的动作（材料要生成，入口在抽屉「参考」
段的「生成」），`actionsFor` 从不返回它，API 上也就不该有。

### 失败长什么样

两种形状，客户端两种都能处理：

**HTTP 层（没有身份 / 方法不对）** —— 状态码 + 一句中文：

| 情况 | 状态码 | 正文 |
| --- | --- | --- |
| 没带 `Authorization` | 401 | `缺少 token：请求头要带 Authorization: Bearer <token>` |
| token 不存在 / 已撤销 / 形状不对 | 401 | `token 无效或已撤销` |
| `GET` / `DELETE`（无状态模式下没有流 / 会话） | 405 | `这个端点只接受 POST…` |

401 之前**一次数据库查询都没有**（形状不对的 token 在查库前就被拒），也就没有任何领域
服务被调用——没身份的请求不会在时间线上留下半条记录。

**MCP 层（身份是真的，但这件事不行）** —— `isError: true` + 服务层那句中文原文：

| 情况 | 文案 |
| --- | --- |
| 当前状态不允许这一步 | `不能从「收集」直接到「待开发」` / `这条需求当前在「待评审」，不能执行这一步` |
| 需求 id 不存在 | `需求不存在` / `找不到这条需求` |
| 签字人不对 | `签字人不是这条需求派单到的评审人` |
| 缺 PRD | `提交评审必须填正式 PRD 链接` |
| 日期越界 | `承诺完成日不能早于提测日` / `承诺完成日不能晚于版本发版日` / `承诺完成日不能早于今天` |
| 权限不够 | `这个 token 的权限是「读」，调用 requirement_schedule 需要「写」权限` |

工具**不预判**状态：`requirement_schedule` 对一条「收集」的需求照样会调到 `schedule`，
由它自己抛 `AppError`。这样 API 与界面只有一份规则，不可能是两份。

真正的意外（连不上库、代码 bug）不翻译成上面这些：原始堆栈打到 **stderr**，工具侧同样
以 `isError` 结束。「库挂了」与「参数填错了」不该长得一模一样。

## stdio（本机那条路）

`npm run mcp` 起 `dist/mcp/server.js`，讲 stdio，工具定义与 HTTP **完全同一份**
（`mcp/build.ts` 挂的是 `mcp/tools.ts` 的 `TOOLS`）。区别只有身份：

- stdio **没有 token**：`actor` 来自 `FLOWERS_MCP_ACTOR`（缺省 `agent`），权限视为 `write`。
  能起这个进程的人本来就有仓库和 `DATABASE_URL`，再给他一把 token 是仪式不是边界。
- HTTP 是**每个请求一份 token**：那条路面向「不在这台机器上」的客户端。

```bash
npm run mcp:build     # tsc -p tsconfig.mcp.json → dist/
npm run mcp           # node dist/mcp/server.js，等 stdin 上的 JSON-RPC
npx tsx scripts/mcp-smoke.ts            # 用 SDK 的 client 连上去把工具跑一遍
```

```bash
claude mcp add flowers -e FLOWERS_MCP_ACTOR=claude-code -- npx tsx mcp/server.ts
```

`npm run mcp` 不经过 `tsx`（那是 devDependency）：生产里先 `npm run mcp:build`，再用
`node /绝对路径/dist/mcp/server.js`。

## dsh 今天接不上

**DeepSeek Harness（dsh）现在不能作为 MCP 客户端连这个端点。** 原因不是这个端点缺什么，
而是 dsh 没有 MCP 客户端：

- dsh 的扩展模型是 `dsh plugin add <npm pkg>`——插件是跑在 dsh 进程里的 JS 包；
- 它没有「连接外部 MCP server」这一层（没有 MCP-client 插件，也没有配置项能填一条
  `url` + `Authorization` 头）；
- 所以 `/mcp` 对 dsh 来说只是一个它不会去敲的 HTTP 地址。

在 dsh 长出 MCP client 之前，dsh 里能做的只有「把这条 URL 和 token 交给一个
**能连 MCP 的**客户端」。不要为了让它「看起来支持」而在 dsh 里塞一个手写的 HTTP 调用
——那是第二套协议实现，会与这里的工具表分叉。

## 部署

- **走 HTTPS**：token 是 bearer，明文发出去等于公开。`/settings` 里显示的 URL 按
  `x-forwarded-proto` / `host` 推出来（本机是 `http://localhost:3000/mcp`），反向代理
  记得传这两个头。
- **token 不进仓库、不进截图、不进日志**：一份 token 一个人，用完撤销。
- `npm run db:migrate` 会建 `mcp_tokens`；没有它，`/mcp` 在鉴权这一步就会报「relation
  does not exist」。
