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
npx vitest run       # 239 个用例（领域 + 读模型 + 时钟 + 并发 + 重置守卫）
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

**九个动作都在看板卡的抽屉里**（抽屉第六段是动作条），不在导航上：评估 / 提交评审 /
通过 / 打回（评审打回） / 排期 / 打回（测试打回） / 拒绝 / 搁置 / 恢复。每个动作能看到
哪些、点下去要填什么，由读模型按当前状态给出；失败就在抽屉里显示服务抛出的那句中文，
刷新也不会把它弄丢。

身份暂时只是一个 cookie（`flowers_actor`，顶栏右上角可切换，缺省「吕品」），没有登录。
左轨的折叠偏好也是 cookie（`flowers_rail`，`open` / `collapsed` / `auto`）。

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
└── read/                只读模型（SQL），页面的唯一数据来源
    ├── board.ts           getBoard()：10 列 + 卡片摘要（等谁、停留几天、是否要你动手）
    ├── detail.ts          getRequirementDetail(id)：抽屉六段 + 当前合法动作集合
    ├── version.ts         listReleases() / getVersion(id)：版本页与排期下拉
    └── member.ts          listMembers() / currentMember()：名册与 cookie 里的当前成员

src/db
├── schema.ts            表结构（requirements / review_assignments / events / releases / members）
├── migrations/          drizzle 生成的 SQL 迁移，`npm run db:migrate` 逐个应用
├── client.ts            pg 连接池 + drizzle 实例
├── migrate.ts           迁移执行器
└── reset.ts             resetDb()：truncate 五张表并复位序列（含「这库能不能清」的守卫）
```

界面层在 `app/`：`page.tsx` 是看板，`releases/`、`settings/` 是另外两页，`actions.ts` 是
`'use server'` 的九个入口（只做「取字段 → 解身份 → 调服务 → 翻译 AppError」），
`components/` 是外壳、左轨、看板、甘特、抽屉与动作条。

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
- 界面截图：`docs/superpowers/shots/`
