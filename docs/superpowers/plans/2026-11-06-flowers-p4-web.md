# P4 前端三页 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 把 P1 的领域内核变成三个能给人用的页面——需求看板、版本、设置——用真实数据库里的数据，六个动作能从界面点下去。

**Architecture:** Next.js App Router。读走 server component 直连领域层（不经过 HTTP），写走 server action 调领域服务（不建 REST 层）。样式复用已定稿的 silas-UX tokens 与看板 CSS，不引 Tailwind、不引状态库。

**Tech Stack:** Next 16.3 · React 19.2 · TypeScript strict · 现有 `src/core`（不动）· 新增 `src/core/read`（只读模型）· Vitest

**Spec:** `docs/superpowers/specs/2026-11-05-flower-gate-product-design.md`（§9 定义了三个页面）

**线稿与样式来源:** `~/Flower/docs/ux/gate-console/`（`views.css` 是已评审的终稿样式，`tokens.css` 是 silas-UX v1.2.0，`wire.html` 是结构参考）

## Global Constraints

- TypeScript `strict`，不开 `any`
- **不改 `src/core` 下的任何既有文件**（P1 已冻结；只读模型放 `src/core/read`，是新增目录）
- 页面只有三个：需求看板 `/`、版本 `/releases`、设置 `/settings`
- 看板 10 列 = 10 个状态，列头只有状态名 + 数字；卡片三行：标题 / 等谁 / 编号 + 停留天数；需要你动的卡加主色框
- 所有文案中文；界面上不放解释性副标题与导语（线稿评审时的硬要求）
- 样式只用 `tokens.css` 的 CSS 变量，不写字面色值
- 每个动作都要有可观测的失败路径（服务抛 `AppError` → 页面显示中文消息，不吞）
- 数据库在 54330，`npm run db:migrate` 幂等；跑测试前 `npm run db:up`

## 三个技术决策（控制器裁决，写在这里供后续任务照办）

- **D1 不用 REST 层。** 读：server component 直接调 `src/core/read/*`；写：server action 直接调领域服务。理由：三个页面不需要对外 API，省掉鉴权中间件、DTO 与客户端状态库。
- **D2 身份先用 cookie，不做登录。** `flowers_actor` cookie 存成员名，顶栏可切换；所有服务调用的 `actor` 从这里来。理由：P1 的 `actor` 是自由文本，真正的 SSO 是后面的事；但没有 actor 就无法记账，所以必须有一个来源。缺失时默认「吕品」并在顶栏提示。
- **D3 不引 Tailwind / React Query。** 设计系统已经是一套 CSS 变量，Tailwind 会叠第二套；数据只有服务端渲染一档，交互只有六个 action。

---

## 文件结构

```
flowers/
├── app/
│   ├── layout.tsx             外壳：左轨 + 顶栏 + 成员切换
│   ├── globals.css            tokens.css + 组件样式（从 gate-console 移植）
│   ├── page.tsx               需求看板（10 列）
│   ├── releases/page.tsx      版本
│   ├── settings/page.tsx      设置
│   ├── actions.ts             'use server'：六个动作
│   └── components/
│       ├── Board.tsx          列与卡片
│       ├── Card.tsx
│       ├── Drawer.tsx         需求详情（含动作条）
│       └── MemberSwitch.tsx
├── src/core/read/
│   ├── board.ts               getBoard()
│   ├── detail.ts              getRequirementDetail(id)
│   ├── version.ts             getVersion(id) / listReleases()
│   └── member.ts              listMembers() / currentMember()
├── scripts/seed.ts            可演示的数据
└── tests/read.test.ts         读模型的 SQL 正确性
```

**为什么 `src/core/read` 而不是塞进页面**：读模型是 SQL，SQL 的对错只能用真实数据库验证；放进 server component 就没法写测试。页面只做「拿数据 → 映射成 JSX」。

---

## Task 1: Next 骨架、样式与外壳

**Files:**
- Create: `app/layout.tsx`, `app/globals.css`, `app/components/MemberSwitch.tsx`, `next.config.ts`
- Modify: `package.json`（加 next/react/scripts）、`tsconfig.json`（加 jsx、include `app`）
- Copy: `~/Flower/docs/ux/gate-console/tokens.css` → `app/tokens.css`（逐字复制，不重打）

**Interfaces:**
- Produces: 可运行的 `npm run dev`，左轨三个入口，顶栏有成员切换

- [ ] **Step 1: 装依赖并改 package.json**

```json
"scripts": {
  "dev": "next dev -p 3000",
  "build": "next build",
  "start": "next start -p 3000",
  "seed": "tsx scripts/seed.ts"
},
"dependencies": {
  "next": "^16.3.6",
  "react": "^19.2.8",
  "react-dom": "^19.2.8"
}
```

- [ ] **Step 2: next.config.ts 与 tsconfig**

`next.config.ts` 里 `experimental.serverComponentsExternalPackages: ['pg']`（pg 是原生依赖，必须外置）。`tsconfig.json` 加 `"jsx": "preserve"`、`"lib": ["ES2022","DOM"]`，`include` 加 `"app"`。

- [ ] **Step 3: globals.css —— 移植 tokens 与看板样式**

把 `~/Flower/docs/ux/gate-console/tokens.css` 全文复制成 `app/tokens.css`，`app/globals.css` 只做 `@import './tokens.css';` + 从 `views.css` 移植这几组类：`.shell/.rail/.topbar/.board/.col/.colhd/.card/.drawer/.sheet/.btn/.gantt`。**不写字面色值**，一律 `var(--c-*)`。

- [ ] **Step 4: layout.tsx —— 左轨 + 顶栏**

```tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN"><body>
      <div className="shell">
        <nav className="rail">
          <h1>Flower</h1><div className="sub">123云盘 · 产品研发</div>
          <a href="/">需求</a><a href="/releases">版本</a><a href="/settings">设置</a>
        </nav>
        <div className="main">
          <header className="topbar"><MemberSwitch /></header>
          {children}
        </div>
      </div>
    </body></html>
  );
}
```

- [ ] **Step 5: MemberSwitch —— 写 `flowers_actor` cookie**

client component：下拉列出成员（`listMembers()` 从 `src/core/read/member.ts` 取，Task 2 才有——这一步先写死 `['吕正豪','赵越','吕品','房超','王妍']`，Task 2 改成真数据），选完 `document.cookie = 'flowers_actor=' + name + '; path=/'` 并 `router.refresh()`。

- [ ] **Step 6: 跑起来验证**

Run: `npm run dev`，打开 `/`。
Expected: 左轨三个入口可点，顶栏有成员下拉，页面无报错。

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(web): next scaffold with silas-ux tokens and app shell"
```

---

## Task 2: 读模型与种子数据

**Files:**
- Create: `src/core/read/member.ts`, `src/core/read/board.ts`, `src/core/read/detail.ts`, `src/core/read/version.ts`
- Create: `scripts/seed.ts`
- Test: `tests/read.test.ts`

**Interfaces:**
- Produces:
  - `listMembers(): Promise<Array<{ id: string; name: string; role: string }>>`
  - `currentMember(): Promise<string>`（读 cookie，缺省 `吕品`）
  - `getBoard(): Promise<Array<{ state: State; label: string; cards: BoardCard[] }>>`，`BoardCard = { id, number, title, owner, waiting, days, mine }`
  - `getRequirementDetail(id): Promise<Detail | null>`
  - `listReleases(): Promise<Array<{ id; name; windowStart; releaseDate; inFlight; late }>>`

- [ ] **Step 1: 写失败的测试（读模型必须用真库验证）**

```ts
it('看板返回 10 列，列顺序与状态机一致', async () => {
  const board = await getBoard();
  expect(board.map((c) => c.state)).toEqual([
    'inbox','design','review','queue','ready','dev','test','live','rejected','shelved',
  ]);
});

it('卡片带出负责人、等谁、停留天数', async () => {
  const { id } = await seedOneTesting({ commitDueAt: '2026-12-04' });
  const board = await getBoard();
  const card = board.find((c) => c.state === 'test')!.cards.find((x) => x.id === id)!;
  expect(card.number).toBeGreaterThan(0);
  expect(card.owner).toBe('房超');
  expect(card.days).toBeGreaterThanOrEqual(0);
});
```

`seedOneTesting` 是 `tests/read.test.ts` 内的助手：用 `createRequirement` → `evaluate` → `submitReview` → `reviewPass` → `schedule` 把一条需求推到 `test`，再 `update ... set state='test'` 强制落位（读模型只关心数据形状，不重测状态机）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/read.test.ts` → FAIL，模块不存在。

- [ ] **Step 3: 实现 board.ts**

一条 SQL 取全部在途需求，按状态分组在 JS 里做。`等待` 的算法要照抄 spec 的语义：

```ts
// 等谁：按状态给出「下一步卡在谁身上」，同一状态里也要分人
function waitingFor(r: Row, now: Date): string {
  switch (r.state) {
    case 'inbox':      return `${r.requester} 补必填`;
    case 'design':     return `${r.owner ?? '负责人'} 出正式 PRD`;
    case 'review':     return `等 ${r.reviewer ?? '评审人'} 评审`;
    case 'queue':      return '等排期';
    case 'ready':      return `等开工日 ${fmt(r.window_start)}`;
    case 'dev':        return `${fmt(r.commit_test_at)} 提测`;
    case 'test':       return `${fmt(r.commit_due_at)} 自动上线`;
    case 'live':       return '可发起走查';
    default:           return '—';
  }
}
```

`days` = `floor((now - state_entered_at) / 86400000)`，用 `shanghaiDayOf` 同类算法（从 `src/core/clock/tick.ts` import，不要重写）。

- [ ] **Step 4: 实现 detail.ts 与 version.ts**

detail 返回六段：`info / commit / refs / review / events / actions`——动作列表由状态决定（`inbox → ['evaluate','submitReview','reject','shelve']`，`design → ['submitReview','shelve']`，`review → ['reviewPass','reviewReject','shelve']`，`queue → ['schedule','shelve']`，`test → ['bounce','shelve']`，`live → ['shelve']`，其余 `[]`）。

version：`listReleases()` 带 `inFlight`（window 内需求数）与 `late`（`commit_due_at < now` 且未上线）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/read.test.ts` → PASS（≥ 6 条）。

- [ ] **Step 6: 写 scripts/seed.ts**

造出线稿里那张看板：5 个成员、2 个版本（2026.11 / 2026.12）、12 条需求分布到 10 个状态（`collect 1 / design 1 / review 2 / queue 2 / ready 1 / dev 2 / test 2 / live 1`），其中 5 条属于当前成员（`mine` 为真）。用真实服务建，不要直接 INSERT。加 `--reset` 时才调 `resetDb()`。

- [ ] **Step 7: 跑 seed 并手工查库**

Run: `npm run seed` → 打印 12 条编号与状态；`npx tsx scripts/demo.ts` 仍 exit 0（seed 不能破坏它）。

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(read): board/detail/version read models with demo seed"
```

---

## Task 3: 看板页

**Files:**
- Create: `app/page.tsx`, `app/components/Board.tsx`, `app/components/Card.tsx`

**Interfaces:**
- Consumes: `getBoard()`, `currentMember()`
- Produces: `/` 渲染 10 列真实数据

- [ ] **Step 1: Board.tsx —— 10 列**

```tsx
export function Board({ columns, me }: { columns: BoardColumn[]; me: string }) {
  return (
    <div className="board">
      {columns.map((c) => (
        <div className="col" key={c.state}>
          <div className="colhd"><b>{c.label}</b><span className="pill2">{c.cards.length}</span></div>
          <div className="colbody">
            {c.cards.map((card) => (
              <Card key={card.id} card={card} mine={card.owner === me} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Card.tsx —— 三行**

标题 / 等谁 / `PAN-805 · 18 天`。`mine` 为真时加 `.mine` 类（主色框 + 左侧 2px 实条），这是线稿定稿的视觉。

- [ ] **Step 3: page.tsx**

```tsx
export default async function BoardPage() {
  const [columns, me] = await Promise.all([getBoard(), currentMember()]);
  return <Board columns={columns} me={me} />;
}
```

- [ ] **Step 4: 浏览器验证**

Run: `npm run dev`；打开 `/`。
Expected: 10 列，1300 宽下全部可见不需横向滚动（列宽自适应），需要你动的卡有主色框，卡片文字不溢出。

- [ ] **Step 5: Commit**

---

## Task 4: 抽屉与六个动作

**Files:**
- Create: `app/components/Drawer.tsx`, `app/actions.ts`
- Modify: `app/page.tsx`（`?open=<id>` 打开抽屉）

**Interfaces:**
- Produces: `evaluateAction / submitReviewAction / reviewPassAction / reviewRejectAction / scheduleAction / bounceAction / shelveAction / rejectAction / restoreAction`，每个 `(formData: FormData) => Promise<{ ok: true } | { ok: false; message: string }>`

- [ ] **Step 1: actions.ts —— 统一的 server action 形状**

```ts
'use server';
export type ActionResult = { ok: true } | { ok: false; message: string };

async function run(fn: (actor: string) => Promise<unknown>): Promise<ActionResult> {
  const actor = await currentMember();
  try { await fn(actor); revalidatePath('/'); return { ok: true }; }
  catch (e) { return { ok: false, message: e instanceof AppError ? e.message : '操作失败' }; }
}

export async function evaluateAction(fd: FormData) {
  const id = String(fd.get('id') ?? '');
  return run((actor) => evaluate(db, actor, { requirementId: id }));
}
```

六个动作照此写。`AppError.message` 是中文，直接显示。

- [ ] **Step 2: Drawer.tsx —— 六段 + 动作条**

服务端渲染抽屉内容，表单 `action={scheduleAction}` 之类。动作条只显示当前状态允许的动作（`detail.actions`）。表单提交失败时把 `message` 显示在动作条上方——不吞错。

- [ ] **Step 3: 浏览器验证六个动作**

用 seed 的数据逐条点：
- `inbox` 的卡 → 评估 → 变 `待设计`
- `design` 的卡 → 填 PRD URL 提交评审 → 变 `待评审`，评审人是该类型的条线负责人
- `review` 的卡 → 通过 → `待排期`；用非评审人身份点 → 显示「不是这条需求的评审人」
- `queue` 的卡 → 排期（选版本 + 两个日期）→ `待开发`
- `test` 的卡 → 打回（填原因 + 新完成日）→ `开发中`
- 任意卡 → 搁置 → `已搁置`

Expected: 每步页面刷新后状态正确，错误路径显示中文。

- [ ] **Step 4: Commit**

---

## Task 5: 版本页

**Files:**
- Create: `app/releases/page.tsx`, `app/components/Gantt.tsx`

- [ ] **Step 1: 甘特**

每个版本一块：横轴是版本时间窗内的日子，每条需求一行，条从 `window_start`（或 `commit_test_at`）到 `commit_due_at`；发版日一条竖虚线；超期条变虚线灰。

- [ ] **Step 2: 时间窗与进度板**

右侧两块：时间窗（开始 / 发版 / 在途条数）与进度（已用时间 %，按 spec 的时间口径，不是任务完成率）。

- [ ] **Step 3: 浏览器验证**

Expected: 两个版本切换，条的位置与 `commit_*` 日期吻合，发版日线穿过所有行。

- [ ] **Step 4: Commit**

---

## Task 6: 设置页

**Files:**
- Create: `app/settings/page.tsx`

- [ ] **Step 1: 我的 / 项目 两个 tab（用 `?tab=` 查询参数，不用 client state）**

我的：当前成员、通知偏好（先只读展示，P3 才可写）。
项目：成员与类型对照表（谁评商业线、谁评功能线）、工作流只读列表（10 个状态 + 颜色）。

- [ ] **Step 2: 浏览器验证**

Expected: `/settings` 与 `/settings?tab=project` 都渲染，无报错。

- [ ] **Step 3: Commit**

---

## Task 7: 收口

- [ ] **Step 1: 全量验证**

```bash
npm run db:up && npm run db:migrate
npx vitest run          # 领域 220 条 + 读模型 ≥6 条，全绿
npx tsc --noEmit
npm run build           # next build 必须过
npm run demo            # 领域冒烟仍 PASS
```

- [ ] **Step 2: 截图存档**

三个页面 + 一个抽屉，存到 `docs/superpowers/p4-shots/`，用 `agent-browser` 或 Playwright 截图。

- [ ] **Step 3: 写 README**

`README.md`：怎么起库、怎么 seed、怎么 dev、三个页面各是什么、六个动作在哪。这是这个仓库的第一份 README。

- [ ] **Step 4: Commit**

---

## 验收标准

- `/` 打开就是 10 列真实数据，需要你动的卡一眼可辨
- 六个动作全部能从界面点完，错误路径显示中文
- 版本页的条与库里日期一致，进度是时间口径
- `npm run build` 通过（不是只有 dev 能跑）
- 领域层 220 条测试一条没改、全绿

## 不在 P4 范围

UEmaster（P2）、通知（P3）、走查、登录与权限、拖拽换状态（状态只能由动作或时钟改变）。
