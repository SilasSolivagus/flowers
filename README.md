# flowers · 需求门禁

123 云盘产品线的需求流程系统：需求在 10 个状态之间按 15 条合法迁移前进，谁能做哪一步、
什么时候能做，全部由领域层判断。**状态机才是产品，界面只是它的一个窗口**——页面不重算规则、
不预校验表单、不替领域编造失败原因。

除了看板本身，它还负责三件事：

1. **通知**：状态变动播报到团队群；需要谁动手的私聊推给他（可换成自己的机器人）。
2. **对外接口**：MCP（27 个工具，讲规则）+ REST `/api/v1/*`（真执行）+ 技能包 `flowers-ops`。
3. **告警**：失败堆积、任务停摆、流程卡点、版本风险、数据质量，按冷却周期推给相关人。

---

## 环境要求

- Node 22（`node -v` 应为 v22.x）
- Docker（数据库是 `docker-compose.yml` 里的 `postgres:17-alpine`，宿主机端口 `54330`）

## 从零到跑起来

```bash
git clone <repo> flowers && cd flowers
npm install

npm run db:up           # 起 postgres
npm run db:migrate      # 建表，幂等
npm run db:test:setup   # 建测试库 flowers_test + 同一批迁移，幂等
npm run seed            # 演示数据（12 条需求铺满十列、5 个成员、2 个版本）

npm run dev             # http://localhost:3000
```

生产构建：

```bash
npm run build   # 必须带 --webpack（extensionAlias 只在这个打包器下生效）
npm start
```

自检：

```bash
npx vitest run     # 114 个文件 / 2016 条用例，跑独立库 flowers_test，不碰演示库
npx tsc --noEmit   # 类型检查
npm run demo       # 领域冒烟：一条需求从收集走到上线；跑完要 npm run seed -- --reset
```

---

## 状态机（10 个状态 · 15 条迁移）

```
inbox 收集 → design 待设计 → review 待评审 → queue 待排期 → ready 待开发 → dev 开发中 → test 测试中 → live 已上线
                                    ↘ rejected 已拒绝        ↗（任意非终态 → shelved 已搁置 → inbox）
```

| 迁移 | 触发 | 备注 |
|---|---|---|
| inbox → design | approve（立项） | **六问门**：`context/problem/outcome/surfaces/edgeCases/outOfScope` 缺一条就拒 |
| inbox → review | submit_review | 必须有正式 PRD |
| design → review | submit_review | 同上 |
| review → queue | review_pass | 只有派单的评审人 / 超管能签 |
| review → design | review_reject | 要写原因 |
| queue → ready | schedule | 版本 + 提测日 + 承诺完成日，三缺一不可；要有 PRD |
| ready → dev / dev → test / test → live | clock | 时钟按日期推进，cron 每 5 分钟一轮 |
| dev → ready | reopen | **退回待开发**（2026-11-11）：接错了/方案变了，必须写原因 |
| test → dev | bounce | 测试没过，重填承诺完成日 |
| shelved → inbox | restore | 恢复（不做「回原阶段」，见已知限制） |
| live → queue | rollback | 发出去有问题，退回待排期重排；清空版本与两个日期 |

另有**状态校准**（超管专用，`requirement_calibrate`）：把存量卡片直接摆到它真实所在的阶段，
必须写原因，只改状态、不动版本与产物。它不是捷径，是纠错。

## 权限（六种能力，按"负责人所在条线"锚定）

| 能力 | 谁 |
|---|---|
| `edit` | 负责人本人 / 负责人所在条线的负责人 / 超管 |
| `review` | 负责人所在条线的负责人 / 超管（且状态在评审、派单是自己） |
| `reassignOwner` | 条线负责人（只能转本线）/ 超管 |
| `claim` | 任何 PM / 条线负责人 / 超管（只能认领无主需求） |
| `admin` / `manageMembers` | 超管（`product_owner`） |

七个人在册：房超（超管）、赵越（商业线负责人）、吕正豪（功能线负责人）、吕品/李嘉/王妍/罗丹（PM）。

---

## 页面

| 路径 | 是什么 |
|---|---|
| `/` | 看板：10 列 = 10 个状态，卡片点开抽屉（`?open=<id>`）。默认隐藏「已上线超 90 天」，`?scope=all` 放回来 |
| `/releases` | 版本页：甘特 + 时间进度 + **本版本需求与进度**（加需求、改提测日/承诺日/版本） |
| `/settings` | 设置：我的（模型、企微绑定、个人机器人、MCP token）/ 项目 |
| `/settings/sheet-import` | 企微表 → 待排期核对（超管）：匹配候选、逐条勾选、应用 |

身份是登录会话（`flowers_session`，生产带 `Domain=.dirctable.com`，便于 b123 等兄弟子域共用）。
`b123.dirctable.com` 的 nginx `auth_request` 打到 `/api/v1/auth/check?perm=b123`：200 放行 / 401 去登录。

---

## 通知

### 群播报（团队群，`group_posts` 台账）

进群的八种动静：认领、立项、提交评审、评审通过、被拒绝、被搁置、**已上线（附「请提出人验收」）**、回滚。
每条带 `PAN-号 + 标题` 的抽屉链接与「谁 · 什么时候」。

- **批量事件不播报**：payload 里带 `batch` 的事件（导入、批量改）只写账、不进群。
- 版本日报（每天 10:00）：剩余天数、需求数、已上线/在途、今日到点、已延期（点名三条）。

```bash
npx tsx scripts/group-dispatch.ts --init      # 记起始水位，不补历史
npx tsx scripts/group-dispatch.ts             # 播状态变动
npx tsx scripts/group-dispatch.ts --daily     # 版本日报
npx tsx scripts/group-dispatch.ts --dry-run   # 只打印
```

### 私聊（`notify_deliveries` 台账）

只推「与你有关」的事件：派给你的评审、你名下需求的关键变动（评估/打回/搁置/恢复/排期/状态变更）、
你提的需求进入收集。**两种送达方式**：

| 方式 | 说明 |
|---|---|
| 共用的机器人（`wecom-cli message aibot send`） | **个人机器人**，只有它的主人能收到；别人无法与它对话 |
| 用自己的机器人（群机器人 webhook） | 任何人可用：企微群 → 添加机器人 → 把 webhook 填进设置页 |

发生 `853008`（"当前会话不是机器人的最近会话"）时，实际含义是「这台机器人只能给本人发」，
设置页会把该成员标成 **已绑定 · 未激活** 并给出改用 webhook 的指引。

---

## 待排期 → 企微汇总表

需求进待排期时往表尾追加一行（表：`迭代需求汇总-版本日志` / tab `kvf2dh`）。

```bash
npx tsx scripts/sheet-sync.ts --limit 20    # 扫一轮 pending/failed
```

- **不绑在请求上**：迁移事务里只登记 `sheet_sync(pending)`，由 cron 扫。
- **两层幂等**：`unique(requirement_id, target)`；写入前读 A 列，`PAN-n` 已在就跳过。
- 列映射：# 写 `PAN-n`；名称/负责人/优先级/涉及端/描述/PRD/备注有值；迭代情况、涉及研发人员、预评审留空。

**导入核对页**（`/settings/sheet-import`，超管）：把表里每一行与池子里匹配，给出「挪进待排期 /
新建 / 不动」的建议与理由，逐条勾选后才写库（写 `state_changed` + `review_passed`，带 `batch`，不播报）。

```bash
npx tsx scripts/import-sheet-queue.ts --rows rows.json          # 只出计划
npx tsx scripts/import-sheet-queue.ts --rows rows.json --apply  # 落库
```

---

## 告警（`src/core/alerts`）

| 级别 | 规则 | 阈值 | 冷却 |
|---|---|---|---|
| P0 | 群播报失败 | 30 分钟内 >0 | 6 小时 |
| P0 | 汇总表同步失败 | ≥3 行 | 6 小时 |
| P0 | 定时任务停摆 | 超过 2 倍周期没更新 | 6 小时 |
| P0 | 企微授权失效 | `wecom-cli` 非 authorized | 6 小时 |
| P0 | 看板门不可用 | b123 探活 5xx / 连不上 | 6 小时 |
| P1 | 个人推送失败 | ≥3 条/2 小时 | 3 天 |
| P1 | 待排期积压 | >15 条 | 3 天 |
| P1 | 需求卡住 | 待评审/待排期 >5 天、开发中 >10 天 | 3 天 |
| P1 | 收集久放 | >14 天未立项 | 3 天 |
| P2 | 版本有延期需求 | 承诺日已过未上线 | 3 天 |
| P2 | 发版前仍有未提测 | 距发版 ≤3 天 | 3 天 |
| P3 | 成员收不到私聊 | 无 userid 也无 webhook | 3 天 |
| P3 | 同名需求重复 | 归一标题重复 | 3 天 |

每条消息四段：**级别 → 现在多少 → 具体哪 3 条（PAN + 负责人 + 多久）→ 下一步 + 链接**，
并 @ 相关人；@ 到条线负责人时写明「请安排人处理」。

```bash
npx tsx scripts/alerts.ts            # 只出报告
npx tsx scripts/alerts.ts --apply    # 真发（cron 每 15 分钟跑这个）
```

---

## MCP 与 REST

### MCP（27 个工具）：讲规则

`/mcp`（Streamable HTTP，Bearer `flw_…`）。工具描述里写清：能不能做、合法状态、要填什么、
六问不齐会怎样。执行建议走 REST（每条描述末尾给技能包地址）。

```bash
npx tsx scripts/mcp-smoke.ts     # 冒烟
```

### REST（`/api/v1/*`）：真执行

```bash
GET  /api/v1/meta                      # API 版本、技能包地址、鉴权说明（公开）
GET  /api/v1/skills[/flowers-ops]      # 技能包清单 / 整包内容（公开）
GET  /api/v1/board
GET  /api/v1/requirements?state=&owner=&q=&number=&offset=&limit=
POST /api/v1/requirements
GET|PATCH /api/v1/requirements/:id
GET  /api/v1/requirements/:id/prd
POST /api/v1/requirements/:id/{claim|assign|plan|artifacts}
POST /api/v1/requirements/:id/actions/:action
       start-design|submit-review|review-pass|review-reject|schedule|reschedule|
       bounce|reopen|reject|shelve|restore|rollback|calibrate
POST /api/v1/requirements/batch        # 批量改（默认 dryRun）
GET  /api/v1/members | /api/v1/releases
```

错误按 `AppError.code` 映射：403 / 404 / 409，正文是那句中文。写操作**不要自动重试**。

### 技能包 `flowers-ops`

`skills/flowers-ops/`（SKILL.md + 零依赖 `flowers.mjs`）。版本号是内容哈希，取最新：

```bash
curl -s $FLOWERS_API/api/v1/skills/flowers-ops   # {version, updatedAt, files:[{path,content}]}
FLOWERS_API=https://flower.dirctable.com FLOWERS_TOKEN=flw_… \
  node flowers.mjs list --state=queue --limit=10
```

---

## 脚本一览

| 脚本 | 用途 |
|---|---|
| `wecom-dispatch.ts` | 时钟推进 + 私聊推送（`--tick`） |
| `group-dispatch.ts` | 群播报（状态变动 / `--daily` 日报 / `--dry-run`） |
| `sheet-sync.ts` | 待排期写企微表 |
| `import-sheet-queue.ts` | 汇总表 22 行批量进待排期 |
| `shelve-stale.ts` | 批量搁置（默认收集 / 180 天 / dry-run） |
| `alerts.ts` | 告警一轮（默认 dry-run） |
| `healthcheck.sh` | 自检：服务/端口/域名/库/企微/台账/磁盘 |
| `migrate-flower.ts` | 从旧 Flower 迁移（`--refresh` 只补差异） |
| `import-members.ts` / `reset-passwords.ts` | 名册 / 初始密码 |
| `sheet` / `sheet-import` 相关见上文 | |

---

## 部署（当前生产）

- 主机：`dogyun`（47.115.229.192），systemd `flowers.service`，端口 3010，Next 生产构建
- 数据库：Docker `flowers-postgres`，`127.0.0.1:5434`
- 入口：`edge-nginx`（容器）→ `172.19.0.1:3010`；`flower.dirctable.com` 与 b123 的门都走它
- cron（`/etc/cron.d/flowers`）：推送/播报 5 分钟、汇总表 10 分钟、日报 10:00、自检 30 分钟、**告警 15 分钟**

关键环境变量：

```bash
DATABASE_URL=postgres://…            # 应用连库
FLOWERS_SESSION_SECRET=…             # 会话签名密钥（不设会落盘生成一把）
FLOWERS_COOKIE_DOMAIN=.dirctable.com # 跨子域共用会话（b123）
FLOWERS_PUBLIC_URL=https://flower.dirctable.com
FLOWERS_QUEUE_SHEET_DOC / _TAB       # 汇总表
FLOWERS_GEN_CMD                      # 生成器命令（覆盖设置页那条）
FLOWERS_GATE_URL                     # 告警探活的外部门
```

---

## 数据与迁移

- 从旧 Flower 迁入 804 条需求，只保留 `legacy_ref`（老库 uuid）；**编号在迁移后重排**，
  老编号不可反查。
- 迁移只把旧描述写进 `context`，其余五问为空，所以**六问门会让存量需求过不了立项**——
  这是刻意的：它们本来就该补完再立项。
- 已存在 7 组同名重复（同一个规划在旧系统拆成多张卡），处理方式见告警 P3。

## 已知限制

1. **搁置恢复回「收集」**，不回原阶段（没有存「搁置前状态」这一列）。
2. **批量操作**只覆盖描述类字段（优先级/类型/备注/平台/PRD）；负责人与排期各自有更严的规则。
3. **迁移数据的「停留天数」**只能显示「自迁移起 N 天」——没有历史事件可回溯。
4. **个人机器人**只服务它的主人；其他成员要私聊必须配自己的群机器人 webhook。
5. 看板的「含历史」开关默认关闭，已上线超 90 天的需求不会出现在默认视图。
