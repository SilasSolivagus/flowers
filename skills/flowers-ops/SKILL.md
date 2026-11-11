---
name: flowers-ops
description: 用脚本直接调 flowers 的 CRUD API 干需求管理（查重 → 建需求 → 认领/分配 → 补六问 → 立项 → 评审 → 排期 → 交材料）。当 MCP 里的工具说明讲清了规则、你要真正执行时用它；MCP 只做规则说明，落地动作走这套脚本。
---

# flowers-ops

flowers 是一个需求流程系统（Next.js + Postgres）。它对外有两样东西：

1. **规则说明**（MCP 工具）：状态机、六问、权限、评审签字这些**约束**在 MCP 工具描述里。
2. **执行入口**（本 skill 的脚本）：所有读写都走 `/api/v1/*` 这套 CRUD HTTP 接口。

MCP 不需要被当成执行器——它告诉你「能不能做、为什么不能」；**真正动手用脚本**。

## 安装 / 更新

脚本与本文档由服务端直接提供，永远取最新版：

```bash
curl -fsS "$FLOWERS_API/api/v1/skills/flowers-ops" -o /tmp/flowers-ops.json
node -e 'const b=require("/tmp/flowers-ops.json");const fs=require("fs");for(const f of b.files){fs.mkdirSync(require("path").dirname(f.path),{recursive:true});fs.writeFileSync(f.path,f.content)}console.log(b.name,b.version,b.updatedAt)'
```

- `version` 是文件内容哈希的前 12 位：**与线上不一致就重新拉一次**。
- `GET /api/v1/skills` 列出全部 skill 与各自版本。

## 需要两个环境变量

| 变量 | 说明 |
|---|---|
| `FLOWERS_API` | 站点根地址，生产是 `https://flower.dirctable.com` |
| `FLOWERS_TOKEN` | `flw_` 开头的 API token（设置页可生成，read / write 两级） |

token 是**人**的身份：所有写操作都会记在这个人名下。不要把 token 写进仓库或聊天记录。

## 命令

```bash
node flowers.mjs board                       # 看板十列（含每人手上的活）
node flowers.mjs list --state=inbox --q=S3   # 按状态 / 关键词 / 编号 / 负责人查
node flowers.mjs get 380                     # 详情（含六问、缺哪几问、迁移来源）
node flowers.mjs create --json req.json      # 建需求
node flowers.mjs update 380 --json patch.json
node flowers.mjs claim 380                   # 认领无主需求
node flowers.mjs assign 380 --member <uuid>  # 转交（条线负责人只能转本线）
node flowers.mjs action 380 start-design     # 状态动作，见下表
node flowers.mjs action 380 submit-review --json '{"prdUrl":"https://…"}'
node flowers.mjs attach 380 evaluate --url /uemaster/PAN-380/evaluate-v001.html
node flowers.mjs upload 380 evaluate --file ./evaluate.html   # 本地生成好的 HTML 直接传
node flowers.mjs plan 380 evaluate           # 取 UEmaster 任务包（不含状态变更）
node flowers.mjs members                     # 成员与 UUID
node flowers.mjs releases                    # 版本与 UUID
```

状态动作名：`start-design`（收集→待设计）、`submit-review`、`review-pass`、`review-reject`、
`schedule`、`bounce`、`reject`、`shelve`、`restore`、`rollback`。

## 规则（MCP 里有完整版，这里只列会咬人的）

- **六问全必填**：`context / problem / outcome / surfaces / edgeCases / outOfScope` 缺任何一条
  → 不能立项、不能生成评估材料；认领 / 提交评审 / 拒绝 / 搁置不受影响。
  录入前用 `GET /api/v1/skills` 里同名工具说明的六问清单，**逐条问用户**，不要自己编。
- **状态只能按边走路**：拒绝时服务端会点名「从 X 不能到 Y」，别硬试。
- **编号会变**：迁移自老系统的需求，旧编号已重排；`legacyRef` 是老系统的 uuid。

## 出错怎么办

- `401`：token 缺失/失效 → 找管理员重新生成。
- `403`：这个人没有这个权限（比如 PM 转交）。
- `409`：规则冲突（状态不对 / 六问不全），响应体里的 `message` 是那句中文原话，照它做。
- 写操作**不要自动重试**：状态动作不是幂等的。
