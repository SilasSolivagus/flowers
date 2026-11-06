# Flower · 需求门禁

一个给 123 云盘产品线用的「需求门禁」系统：每条需求在 10 个状态之间按 13 条合法迁移前进，
谁能做哪一步、什么时候能做，全部由领域层判断。**状态机才是产品，界面只是它的一个窗口**
——页面不重算规则、不预校验表单、不替领域编造失败原因，它只做两件事：读模型给什么就画什么，
用户点了就把表单交给对应的服务。

## 环境要求

- Node 22（`node -v` 应为 v22.x）
- Docker（数据库是 `docker-compose.yml` 里的 `postgres:17-alpine`，宿主机端口 `54330`）

## 从零到跑起来

```bash
git clone <repo> flowers && cd flowers
npm install

npm run db:up        # 起 postgres（docker compose up -d db）
npm run db:migrate   # 建表，幂等，可反复跑
npm run seed         # 灌演示数据（12 条需求铺满 10 列、5 个成员、2 个版本）

npm run dev          # http://localhost:3000
```

要跑生产构建：

```bash
npm run build        # 必须走 webpack，见下面「两个坑」
npm start            # http://localhost:3000
```

自检命令：

```bash
npx vitest run       # 287 个用例（领域 + 读模型 + 时钟 + 并发 + 重置守卫 + UEmaster 任务包与 attach）
npx tsc --noEmit     # 类型检查
npm run demo         # 领域冒烟脚本：一条需求从收集走到上线，8 步逐项对齐，退出码 0 = 通过
```

`npm run demo` 会 `resetDb()` 清空数据，**跑完要补一次 `npm run seed -- --reset`**，否则界面是空的。

## 三个页面

| 路径 | 是什么 |
| --- | --- |
| `/` | 需求看板。10 列 = 10 个状态，每列固定 220px，比视口宽就横向滚（滚轮也能滚）。卡片三行：标题 / 等谁 / 编号 + 停留天数；「现在欠你一个动作」的卡有主色框。点卡片开抽屉，URL 是 `/?open=<需求 id>`，可刷新、可分享、可后退。 |
| `/releases` | 版本页。按版本看甘特（需求 × 日期）与时间维度的进度：开工日到发版日用了多少、在途几条、延期几条、已上线几条。 |
| `/settings` | 设置页。两个 tab：`我的` / `项目`，用 `?tab=project` 这类查询参数切换，不是客户端状态。 |

**八个动作都在看板卡的抽屉里**（抽屉第六段是动作条），不在导航上：提交评审 / 通过 /
打回（评审打回） / 排期 / 打回（测试打回） / 拒绝 / 搁置 / 恢复。每个动作能看到哪些、
点下去要填什么，由读模型按当前状态给出；失败就在抽屉里显示服务抛出的那句中文，
刷新也不会把它弄丢。

「评估」不在动作条里：Flowers 后端不调模型（D1），这个按钮点不出材料。评估、评审、
走查三处的材料由**你自己的 agent** 用 UEmaster 生成，接法见下一节。抽屉「参考」段
那三行是三处固定槽位：没有产物时是「评估材料 / 评审材料 / 走查材料 + 复制任务包」，
有了产物就是链接 + 日期。

身份暂时只是一个 cookie（`flowers_actor`，缺省「吕品」），没有登录；界面上**没有切换入口**——
左轨底部那块只是把当前身份读出来（姓名 + 角色），SSO 之前身份由配置决定。
左轨的折叠偏好也是 cookie（`flowers_rail`，`open` / `collapsed` / `auto`）。

## UEmaster 怎么接

### UEmaster 是什么

[UEmaster](https://github.com/SilasSolivagus/UEmaster) 是一个 **agent skill**（不是服务、不是 SDK）：
两个 sub-skill —— `flow-canvas`（把流程画成横平竖直的 SVG：流程图 / 架构图 / ER / 甘特 / 时序）
和 `flow-walkthrough`（出三栏联动的评审页：左边点流程节点，右边切原型页面）。
**它自己没有模型**：纯提示词 + 确定性 Python 排版脚本，跑在**你的** agent 里。这就是
Flowers 敢说「我们不调 LLM」的前提，也是下面那条限制的来源。

### 三段循环

一条需求、一个阶段，转三圈：

```bash
uemaster_plan   { requirementId, stage }         # ① 拿任务包（纯读，不改状态）
# ② agent 照包干：装 flow-canvas / flow-walkthrough，跑 UEmaster，写单个自足 HTML 到
#    data/uemaster/PAN-<n>/<stage>.html
uemaster_attach { requirementId, stage, url }    # ③ 把 /uemaster/PAN-<n>/<stage>.html 交回来
```

`stage` 只有三个值：`evaluate` / `review` / `inspect`（评估 / 评审 / 走查）。交回之后抽屉
「参考」段对应那一行立刻从「复制任务包」变成链接 + 日期，记录段多一条
`uemaster.attached`。站内路径必须真有文件（`data/uemaster/` 下），否则 `artifact_missing`——
包自己写着该往哪写，写不对就是没干活。文件不在 `public/` 里：`/uemaster/...` 由动态路由
`app/uemaster/[...path]/route.ts` 服务，每个响应带
`Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:`
——产物是同源的第三方 HTML，它的脚本能跑（走查页的点击切换因此在站内是活的），但没有
`allow-same-origin`，所以它读不到本站 cookie、用不了 storage、同源请求也发不出去
（R-P2-9）。

### 入口是 MCP server

Flowers 里那个「桥」是 `mcp/server.ts`，**只讲 stdio**，不是 HTTP 端口：

```bash
npm run mcp:build                # = tsc -p tsconfig.mcp.json，编译到 dist/
npm run mcp                      # = node dist/mcp/server.js，等 stdin 上的 JSON-RPC

# 或者直接接进客户端（在仓库根跑一次，开发态用 tsx 省掉编译）
claude mcp add flowers -e FLOWERS_MCP_ACTOR=claude-code -- npx tsx mcp/server.ts
codex mcp add flowers --env FLOWERS_MCP_ACTOR=codex -- npx tsx mcp/server.ts
```

**生产（`npm ci --omit=dev`）先 `mcp:build` 再 `mcp`。** `tsx` 是 devDependency，
装生产依赖时根本不存在，所以 `npm run mcp` 不经过它：`tsc -p tsconfig.mcp.json` 把
`mcp/` 与 `src/` 编成 `dist/`（`rootDir` 是仓库根，所以 `dist/mcp/server.js` 引用的
`../src/core/...` 落地就是 `dist/src/core/...`），再让 Node 直接跑那些文件。领域层用的是
`./x.js` 这种**带扩展名**的相对导入——编译后它们就是真实存在的文件，这正是这条路能成立、
而 Node 的「原生 type stripping」做不到的原因（它不做扩展名与目录解析）。客户端也可以
直接写 `node /绝对路径/dist/mcp/server.js`。

三个工具（`uemaster_plan` / `uemaster_attach` / `requirement_show`）的参数、失败文案、
cwd 与产物根的关系、`claude` / `codex` 两份完整配置：见 [`docs/mcp.md`](docs/mcp.md)。
想不接客户端先验一遍：

```bash
npx tsx scripts/mcp-smoke.ts     # 用官方 SDK 的 client 起子进程，按 agent 的顺序跑完三个工具
```

**MCP 写库记在谁头上**由环境变量 `FLOWERS_MCP_ACTOR` 决定（写进 `events.actor` 与
`uemaster_artifacts.created_by`），缺省 `agent`，空串也算没配。一个客户端一个值
（`claude-code` / `codex` / `ci`）——别填真人姓名，那会让时间线看起来是某个人点的。

### 「收集 → 待设计」这道门，现在由评估材料推

需求还在**收集**里时交回 `stage='evaluate'`，`uemaster_attach` 会在**同一个事务**里把它
推进**待设计**（与领域层 `evaluate` 走同一道门：没有类型就 `missing_type`，整条 attach
回滚）。动作条上已经没有「评估」这个按钮了——材料的到达本身就是那次点击。已经在
待设计或更后面的需求补一份新评估，只换材料，不会被打回。

评审与走查照旧：`提交评审` 要 PRD 链接，这条约束没变。

### 没有 agent 怎么办（D1 的实话）

**Flowers 自己不调 LLM，也不会替你调。** P2 没做「组织自备 key、后端调模型」这条路：
那等于把整份 skill 提示词与排版脚本搬进服务端、再选模型供应商管 key 计费限流，
产出的图还会和 agent 里跑出来的不一致。所以：

1. 抽屉「参考」段每一行右边有**复制任务包**：复制出来是一段完整的中文任务包（画什么、
   装哪两个 skill、写到哪个文件、怎么交回），贴给任何能跑 skill 的 agent 就行，不必先
   接 MCP。同一行右边还有**交回材料**：把材料贴成链接或直接传那个 `.html`（≤5 MB），
   服务端会把它落到 `data/uemaster/` 并验证文件真在——所以完全绕开 MCP 也走得完整圈。
2. 干脆不评估：`提交评审` 直接 `收集 → 待评审`。这条路**永远开着**，评估是加速器，不是关卡。

## 领域怎么组织的

```
src/core
├── state-machine.ts     10 个状态、13 条合法单步迁移、状态机亲自执行的两道门（必须带 PRD 链接、必须有类型）
├── errors.ts            AppError：带 code 的中文错误，消息原样显示到界面上
├── events.ts            事件流写入：每一次迁移都留一条「谁、什么时候、做了什么」
├── validate.ts          服务入参的形状校验（zod）
├── requirements/        七个服务，一个动作一个文件
│   ├── create.ts          createRequirement          建需求（进收集）
│   ├── evaluate.ts        evaluate                    评估（收集 → 待设计）
│   ├── submit-review.ts   submitReview                提交评审（→ 待评审，要 PRD 链接）
│   ├── review.ts          reviewPass / reviewReject   评审通过（→ 待排期）/ 打回（→ 待设计）
│   ├── schedule.ts        schedule                    排期（→ 待开发，校验版本与三个日期）
│   ├── bounce.ts          bounce                      测试打回（待测试 → 开发中）
│   └── terminal.ts        reject / shelve / restore   终态与恢复
├── clock/tick.ts        时钟：按上海日历日把 待开发 → 开发中 → 测试中 → 已上线 自动推进
├── uemaster/            UEmaster 材料（P2）：只发任务包、收链接，不调模型
│   ├── packs.ts           packFor(stage, req)：三份任务包正文（纯函数，不碰库）
│   ├── attach.ts          attachArtifact()：校验链接与文件 → 落库 → 写事件；evaluate 时同事务推进状态
│   └── list.ts            listArtifacts()：每个 stage 取最新一条
└── read/                只读模型（SQL），页面的唯一数据来源
    ├── board.ts           getBoard()：10 列 + 卡片摘要（等谁、停留几天、是否要你动手）
    ├── detail.ts          getRequirementDetail(id)：抽屉六段 + 当前合法动作集合
    ├── version.ts         listReleases() / getVersion(id)：版本页与排期下拉
    └── member.ts          listMembers() / currentMember()：名册与 cookie 里的当前成员

src/db
├── schema.ts            表结构（requirements / review_assignments / events / releases / members / uemaster_artifacts）
├── migrations/          drizzle 生成的 SQL 迁移，`npm run db:migrate` 逐个应用
├── client.ts            pg 连接池 + drizzle 实例
├── migrate.ts           迁移执行器
└── reset.ts             resetDb()：truncate 五张表并复位序列（含「这库能不能清」的守卫）

mcp/
├── server.ts             stdio MCP server（`npm run mcp`）：只做接线，不起端口
└── tools.ts              三个工具的纯函数实现与 zod schema（客户端看到的 schema 就是这份）
```

界面层在 `app/`：`page.tsx` 是看板，`releases/`、`settings/` 是另外两页，`actions.ts` 是
`'use server'` 的九个入口（只做「取字段 → 解身份 → 调服务 → 翻译 AppError」），
`components/` 是外壳、左轨、看板、甘特、抽屉与动作条（`CopyPack` 是参考段那个复制按钮）。

## 两个坑（新人一定会踩）

**一、Next 必须用 `--webpack`，永远不要 `--turbopack`。**
`src/core` 用的是 NodeNext 风格的相对导入（`import ... from './errors.js'`），这是 `tsx` / `vitest`
直接跑 `.ts` 时唯一正确的写法。Turbopack 不做扩展名别名，server component 一 import 领域层就
500：`Can't resolve './errors.js'`。`next.config.ts` 里用 `experimental.extensionAlias` 补上
`.js → .ts`，而这条只有 webpack 认。所以 `package.json` 里两个脚本都写死了
`next dev -p 3000 --webpack` / `next build --webpack`。

**二、`resetDb()` 清空的是 `DATABASE_URL` 指向的那个库；`npm run seed` 不带 `--reset` 会拒绝。**
`resetDb()` 直接 truncate 五张表（脚本里另有 `current_database()` 守卫，只放行名为 `flowers` 的库）。
测试用例跑的就是这张 `flowers`，所以 **`npx vitest run` 会把演示数据清掉**——跑完测试或 `npm run demo`
之后，界面会是空的，要补一次：

```bash
npm run seed -- --reset
```

`npm run seed` 不加 `--reset` 只在空库上灌，这是刻意的：一个已经有人用的库不该被演示数据覆盖。

## 设计是哪来的

- 产品口径：`docs/superpowers/specs/2026-11-05-flower-gate-product-design.md`
- 实施计划：`docs/superpowers/plans/`
  - `2026-11-05-flowers-gate-p1-core.md` + `…-p1-core-ledger.md`（P1 领域内核与执行台账，含控制器裁决 R1–R44）
  - `2026-11-06-flowers-p4-web.md`（P4 三个页面）
  - `2026-11-06-flowers-p2-uemaster.md`（P2 UEmaster 接入，含裁决 D1 与 R-P2-1…R-P2-8）
- UEmaster 本体：<https://github.com/SilasSolivagus/UEmaster>
- 界面截图：`docs/superpowers/shots/`（`18`–`19` 是 UEmaster 两行，`20`–`22` 是复制任务包 / 附着产物 / 状态被推进）

## 还糙的地方

以下是 P2 收口时**已知且故意没修**的（都能在代码里指到具体位置）：

1. **交回材料的两条路还不等价。** MCP 那条能指定任意站内路径或外链；抽屉那条只收
   `/uemaster/` 下的站内路径（传文件时自己拼名字）。「传文件」在浏览器里没有被真的按过
   一次（本机浏览器没有配置上传目录），multipart 那一段只在用例里验过。
2. **`scripts/mcp-smoke.ts` 会留痕。** 它 attach 一条真产物（actor=`claude-code`，把需求
   推进待设计），但收尾只删占位文件、不删 `uemaster_artifacts` 那一行——抽屉里因此会出现
   一个 404 链接。跑完要 `npm run seed -- --reset` 复位。
3. **死链不追溯**（R-P2-5）：`listArtifacts` 不 stat 文件。手工删掉 `data/uemaster/` 下的
   文件之后，抽屉照样给出链接，点开是 404——读模型不依赖文件系统，这是当时的取舍。
4. **「最新一份」同毫秒会飘**（R-P2-4）：重做产生的多行按 `created_at desc` 取第一行，
   时间戳相同时用 uuid 兜底。要真修得给表加 `seq` 列。
5. **没有产物历史视图**：旧行留在库里，读侧只给最新一条，界面上没有任何入口能翻到上一版。
6. **`evaluateAction` 是个无入口的 action**：动作条已经不渲染「评估」，但
   `app/actions.ts` 的 dispatcher 里还挂着 `evaluate`（状态机本身仍允许 收集 → 待设计）。
7. **走查仍然是手动的**：`inspect` 的包得有人自己拿，系统不会催。看板那句现在至少
   说的是事实（`待走查` / `已走查 · MM-DD`），但它不替你发起什么。
8. **截图里的产物是手写的占位 HTML**（1351 字节）：P2 的验证只证明「包 → 文件 → attach →
   抽屉 → 状态」这条链路，不证明 UEmaster 出的图好看。
