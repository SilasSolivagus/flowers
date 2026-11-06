# P2 UEmaster 接入 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让「评估 / 评审 / 走查」三处真的能产出材料——花里写成三份可执行的任务包，由**你自己的 agent** 用 UEmaster 生成，再把链接交回来。Flowers 不调 LLM。

**Architecture:** 三个新件：`uemaster_artifacts` 表、`src/core/uemaster`（任务包 + 落库）、一个独立进程的 MCP server（stdio）。读模型把三处槽位填成真链接，抽屉的「参考」段从「未生成」变成可点。

**Tech Stack:** 既有 P1+P4（Next 16 · drizzle · Postgres 17）· `@modelcontextprotocol/sdk`（唯一新依赖）

**Spec:** `docs/superpowers/specs/2026-11-05-flower-gate-product-design.md` §5、§6
**UEmaster:** https://github.com/SilasSolivagus/UEmaster —— 两个 agent skill（flow-canvas 画图、flow-walkthrough 出三栏评审页），**纯提示词 + 确定性 Python 排版脚本，不含模型**。这是本计划不调 LLM 的前提。

## Global Constraints

- `src/core` 的服务（create/evaluate/review/schedule/bounce/terminal）**一行不改**；新代码只在 `src/core/uemaster/`
- 新表只加不改：一次新迁移，不改已有迁移
- 产物**只存链接**，不存正文（spec §5）
- 三处 stage 固定为 `evaluate | review | inspect`
- 中文 UI 文案；按钮置灰必须说清原因与解法
- 无 LLM 时系统必须仍然可用：`inbox → 待评审` 那条路永远开着（spec §6）
- 不引入 UI 框架、不引入 ORM、不加 Tailwind

## 一条裁决（D1）

**P2 不实现「组织自备 key、Flowers 后端调模型」这条路径。** 理由：UEmaster 是两个 agent skill，把它搬运成后端可执行的东西＝把整份 skill 提示词与 Python 排版脚本打进服务端，再选一个模型供应商、管 key、计费、限流——这是另一个产品的工作量，而且产出的流程图会与 agent 里跑出来的不一致。**P2 只做「借调用方的模型」**（spec §6 的推荐路径）。按钮的三态里，「组织配了 key」这一态暂时永远为假，置灰理由就写这条。

代价：没有 agent 的人用不了评估按钮，只能走 `inbox → 待评审` 直提 PRD。这个代价 spec 已经接受过（「评估是加速器，不是关卡」）。

---

## 文件结构

```
flowers/
├── src/db/migrations/0002_*.sql        新建 uemaster_artifacts
├── src/db/schema.ts                    加表（只加）
├── src/core/uemaster/
│   ├── packs.ts                        三份任务包（纯函数，不碰库）
│   ├── attach.ts                       校验 + 落库 + 事件
│   └── list.ts                         按需求取三处产物
├── src/core/read/detail.ts             改：refs 从产物表读（唯一允许改的既有文件）
├── mcp/server.ts                       stdio MCP server
├── mcp/tools.ts                        工具实现的纯函数（可测，不依赖 stdio）
└── tests/uemaster.test.ts              任务包与 attach 的测试
```

**为什么 `mcp/tools.ts` 与 `mcp/server.ts` 分开**：stdio 那层没法测，工具逻辑要能直接用真库跑测试。

---

## Task 1: 表与领域层

**Files:**
- Create: `src/db/migrations/0002_uemaster.sql`（或 drizzle 生成）、`src/core/uemaster/packs.ts`、`src/core/uemaster/attach.ts`、`src/core/uemaster/list.ts`
- Modify: `src/db/schema.ts`（只加表）
- Test: `tests/uemaster.test.ts`

**Interfaces:**
- Produces:
  - `type Stage = 'evaluate' | 'review' | 'inspect'`
  - `packFor(stage: Stage, req: { number: number; title: string; type: string; prdUrl: string | null }): string`
  - `attachArtifact(db, actor, raw: unknown): Promise<{ id: string; stage: Stage; url: string }>`
  - `listArtifacts(db, requirementId: string): Promise<Array<{ stage: Stage; url: string; at: Date }>>`

- [ ] **Step 1: 加表**

```sql
create table uemaster_artifacts (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references requirements(id),
  stage text not null check (stage in ('evaluate','review','inspect')),
  url text not null,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index uemaster_artifacts_req on uemaster_artifacts (requirement_id, stage, created_at desc);
```

同一需求同一 stage 允许多份（重做会产生新版本），读 `listArtifacts` 取最新。

- [ ] **Step 2: 写失败的测试**

```ts
it('三份任务包都点名要 UEmaster，且带 PRD 链接', () => {
  for (const stage of ['evaluate','review','inspect'] as const) {
    const p = packFor(stage, { number: 7, title: 'S3 协议支持', type: 'feature', prdUrl: 'https://x/prd' });
    expect(p).toContain('UEmaster');
    expect(p).toContain('S3 协议支持');
    expect(p).toContain('https://x/prd');
  }
});

it('评审包要求问题清单，走查包要求与 PRD 版对比', () => {
  expect(packFor('review', base)).toContain('问题清单');
  expect(packFor('inspect', base)).toContain('对比');
  expect(packFor('evaluate', base)).not.toContain('问题清单');
});

it('attach 只收 http(s) 链接', async () => {
  await expect(attachArtifact(db, '吕品', { requirementId: id, stage: 'evaluate', url: 'javascript:alert(1)' }))
    .rejects.toMatchObject({ code: 'invalid_url' });
});

it('attach 的 stage 只认三个值', async () => { /* ... code: 'invalid_stage' */ });

it('attach 写一条事件', async () => { /* events 里出现 uemaster.attached */ });
```

- [ ] **Step 3: 实现 packs.ts —— 内容要真的可执行**

每份包必须自足：agent 拿到它，不需要再问人就能干活。四段固定结构：

```
任务：为 PAN-7「S3 协议支持」生成<评估材料|评审材料|走查材料>
输入：PRD <url>
技能：UEmaster（https://github.com/SilasSolivagus/UEmaster）的 flow-canvas 与 flow-walkthrough
产出：<每 stage 不同>
交付：把生成的文件放到 public/uemaster/PAN-7/<stage>.html，然后调用 uemaster_attach 把 /uemaster/PAN-7/<stage>.html 交回来
约束：只画 PRD 里写到的内容；没有的不要编
```

三处「产出」不同：

| stage | 要求 agent 产出 |
|---|---|
| evaluate | 业务流程图 + 每步对应的线框页，用于讨论可行性 |
| review | 同上 + **问题清单**（死路 / 无页面步骤 / 缺状态 / 歧义词 / 未知角色），每条带位置 |
| inspect | 实际实现版 + **与 PRD 版的差异清单**（一致 / 缺失 / 溢出） |

- [ ] **Step 4: 实现 attach.ts**

顺序（照 P1 的惯例）：`requirePlainObject` → `parseRequirementId` → stage 白名单 → url 必须 `http(s)://` 或站内 `/` 开头 → 事务内确认需求存在 → insert → `recordEvent`。全部中文错误。

- [ ] **Step 5: 跑测试到绿，commit**

---

## Task 2: 读模型与抽屉

**Files:**
- Modify: `src/core/read/detail.ts`（唯一允许改的既有文件）、`app/components/Drawer.tsx`
- Test: `tests/read.test.ts`（追加）

- [ ] **Step 1: refs 改为读表**

`detail.ts:358-375` 那三个槽位改成：从 `uemaster_artifacts` 取每 stage 最新一条；没有就是 `present: false`。`review` 槽位的语义是「PRD 快照」，保持不变（它还兼任评审依据），但如果有 `stage='review'` 的产物，优先显示产物并额外带一条 PRD 链接。

- [ ] **Step 2: 抽屉里产物可点**

已经按 `present` 过滤渲染，接上真数据即可。产物行显示：阶段名 · 时间 · 链接。**不加**「点击查看」这类解释。

- [ ] **Step 3: 测试**

```ts
it('有产物时 refs 里 present 为真且带 url', async () => { /* attach 一次 → getRequirementDetail → 断言 */ });
it('没有产物时 present 为假且 url 为 null', async () => { /* ... */ });
```

- [ ] **Step 4: 浏览器验证 + commit**

---

## Task 3: MCP server

**Files:**
- Create: `mcp/server.ts`、`mcp/tools.ts`、`docs/mcp.md`
- Modify: `package.json`（`"mcp": "tsx mcp/server.ts"`，加 `@modelcontextprotocol/sdk`）

**Interfaces:**
- Produces: 三个工具
  - `uemaster_plan({ requirementId, stage })` → `{ pack: string, stage, requirement: {...} }`（纯读，**不改状态**）
  - `uemaster_attach({ requirementId, stage, url })` → `{ ok: true, url }`
  - `requirement_show({ requirementId })` → 需求的当前状态、类型、负责人、PRD 链接、已有产物（让 agent 不必再问人）

- [ ] **Step 1: tools.ts 纯函数**

```ts
export async function planTool(input: unknown): Promise<{ pack: string }>   // 读需求 → packFor
export async function attachTool(input: unknown): Promise<{ ok: true; url: string }>
export async function showTool(input: unknown): Promise<{ ... }>
```

actor 从 `process.env.FLOWERS_MCP_ACTOR ?? 'agent'` 取；写进 `events.actor`，这样时间线上能看出「这是 agent 干的」。

- [ ] **Step 2: server.ts 接线 stdio**

用 `@modelcontextprotocol/sdk` 的 `McpServer` + `StdioServerTransport`；每个工具的 zod schema 与 tools.ts 共享同一份。任何 `AppError` 都转成 `{ content: [{ type:'text', text: e.message }], isError: true }`——**不要把异常吞成成功**。

- [ ] **Step 3: 真机验证**

在 `~/flowers` 下用 `claude mcp add flowers -- npx tsx mcp/server.ts`（或手写 `.mcp.json`）接上，然后让 agent 真的走一遍 `uemaster_plan` → 写文件 → `uemaster_attach`，确认：
- 产物落到 `public/uemaster/PAN-x/evaluate.html`
- 抽屉「参考」里出现链接
- 时间线出现 `uemaster.attached` 且 actor 是 agent

如果这个环境里接不上 MCP 客户端，就用官方 SDK 的 client 在测试里直连 stdio，跑通同样的三步——并在报告里写明是哪种验证。

- [ ] **Step 4: 写 docs/mcp.md + commit**

给使用者看的：怎么接、三个工具各干什么、actor 怎么配。

---

## Task 4: 按钮与置灰理由

**Files:**
- Modify: `app/components/ActionBar.tsx`、`app/actions.ts`（可能）、`app/globals.css`

- [ ] **Step 1: 评估按钮的可用性**

按 D1：Flowers 后端没有生成能力，所以「评估」不是一个能直接执行的动作。做法：**把「评估」从动作条拿掉，改成「参考」段里的一行**——`评估材料 · 未生成` + 一个复制任务包的按钮（复制的是 `uemaster_plan` 会返回的那段文本，由服务端渲染时预先生成）。点了复制，用户贴给 agent。

这样比一个永远灰着的按钮诚实：灰按钮在说「你不能用」，复制包在说「拿去，让你的 agent 干」。

- [ ] **Step 2: 浏览器验证 + commit**

---

## Task 5: 收口

- [ ] `npx vitest run`（现有 239 + 新增）、`npx tsc --noEmit`、`npm run build`
- [ ] README 加一段「UEmaster 怎么接」
- [ ] 截图：抽屉里有产物 / 没有产物 / 复制任务包
- [ ] 验收：从包里复制文本 → 交给一个真 agent → 产物出现在抽屉

## 不在 P2 范围

组织自备 key、后端调模型（D1）、走查的自动触发、产物版本对比视图、通知。
