# P2.10 · B 路线：一个 key 出一条**查过**的评估材料

P2.6–P2.9 之后，「生成」仍等于在本机跑一条 agent CLI（`FLOWERS_GEN_CMD` / `app_settings`
的 `generator.command`）。那条路的三个前提都在 owner 机器上塌过：CLI 要装、凭证会过期
（`claude` OAuth 过期、`codex` refresh token 已用、`dsh` 缺 key）、产物质量全看模型心情
（它自己写 HTML，还绕过排版检查）。

owner 的要求只有一句：**我有一个 LLM 的 key，这一件事就该够。** 所以这一版把「出一条评估
材料」拆成三件各自可验的事：

| 谁 | 做什么 | 凭什么算对 |
| --- | --- | --- |
| 模型 | 画一段**受限语法**的 mermaid | 只输出源码，不写 HTML |
| vendored 引擎 | 排版 + 质检 | `crossings/overlaps/textOverflow` 全 0，**且**形状够大 |
| 我们 | 渲染那份 HTML | 纯函数，同一份输入永远同一份字节 |

改动范围：

| 文件 | 性质 |
| --- | --- |
| `src/core/uemaster/compose.ts` | 新增。提示词、重试、校验、渲染、落盘、attach。 |
| `src/core/uemaster/start.ts` | 增量。加 `resolveStrategy()`；`startGeneration` / `runJob` 按策略分叉。 |
| `src/core/uemaster/flow.ts` | 增量。布局被拒时补跑 `--check`，把报告（含交叉/重叠的点）捞回来。 |
| `tests/compose.test.ts` | 新增。10 条用例，零外网（provider 是本地 `http.createServer`）。 |
| `docs/superpowers/plans/p2-10-compose.md` | 本文。 |

`src/core` 其余服务（create/evaluate/review/schedule/bounce/terminal）、`app/`、`mcp/`、
`generator.ts`（另一个 worker 的）一行没动；没有新依赖（zod 早就在）；没有迁移。

本次提交：`a2533df` —— `feat(uemaster): 一个 key 出一条评估材料——模型画图、引擎验收、HTML 自己渲染`

---

## 1. 引擎的那条坑（这一版的核心判据）

`flowlayout.py` **不把语法垃圾当错误**：

```
$ echo 'this is not mermaid at all ###' > x.mmd && python3 flowlayout.py x.mmd --check
{"nodes": 1, "edges": 0, "crossings": 0, "overlaps": 0, "textOverflow": 0, ...}   # 退出 0
```

所以「三个计数全 0」只证明**排版没问题**，不证明**图有用**。判据因此是两条，缺一不可：

```ts
const tooSmall = shape.nodes.length < MIN_NODES || shape.edges < MIN_EDGES;  // 3 / 2
if (check.ok && !tooSmall) return { ... };
```

形状是我们从 mermaid 原文里自己解析出来的（`parseFlow`）：引擎的报告只有 `nodes: 5`
这样的**数字**，没有 id 与文案，而提示词 2 和左侧节点列表要的正是这两样。同一份文本
解析一次，三处（提示词、图、列表）就不会漂。

## 2. 两个提示词（verbatim）

提示词由 `flowPrompt` / `pagesPrompt` 生成，`repairPrompt` / `pagesRepairPrompt` 只在
被拒之后接上。下面的样例是 `PAN-7「S3 协议支持」`、阶段 `evaluate` 的真实输出。

### 提示词 1：只要一段 mermaid

```
你是需求流程建模助手。把下面这条需求画成一张业务流程图（mermaid），只输出 mermaid 源码。

需求：
  · 编号：PAN-7
  · 标题：S3 协议支持
  · 类型：feature
  · 提出人：孙建宏
  · PRD：未提供（照需求标题与类型推断；推断的地方不要假装有依据）
  · 这次要做的是评估材料：讨论可行性——「这一步到底有没有页面、这么走通不通」

输出格式（硬性要求，逐条都会被机器校验）：
 1. 第一行必须是 flowchart TD；整段不超过 14 行。
 2. 节点只有三种写法：
    · 普通步骤   A["进入寄养频道"]      （实线矩形）
    · 判断       B{"是否登录？"}        （菱形）
    · 后台环节   G[["门店接单后台"]]    （双边线灰底，非前端页面/系统动作都用这个）
 3. 连线写成 A --> B；从判断节点出发的连线**必须**带标签：B -->|是| C 与 B -->|否| D。
    标签只能语义化（是/否/通过/不通过/超时），不要写「分支一」「情况A」。
 4. 3–8 个节点、至少 2 条连线。必须是一条**单主干**：主干自上而下串起主要步骤，
    分支从判断节点出发沿右侧向下走，最后汇回主干。
    不要画两个互不相连的孤岛，不要画回到自己前面很远的兜圈子。
 5. 节点文案用中文，一行不超过 12 个汉字；要换行就用 <br>。
 6. 禁止：subgraph、style、classDef、click、%% 注释、emoji、括号里套引号、
    任何解释性文字（不要「以下是流程图」这类开场白）。
 7. 不要 ``` 代码围栏。第一行就是 flowchart TD，最后一行是最后一条连线。

只输出 mermaid 源码本身。
```

**子集规则为什么抄进提示词**：模型读不到 `vendor/uemaster/flow-canvas/contract/flowspec-v1.md`。
引擎只认「单主干 + 右分支 + 回线」，`subgraph` 与 `classDef` 不是被拒就是被画歪；
不说清这些，一半回复会死在语法上，每一次死都要花一次 90 秒的调用。

**为什么点名「不要开场白」**：`mermaidIn` 会剥围栏、会从 `flowchart TD` 那一行开始收，
但正文里夹的中文（「以上就是这张图」）如果漏进去，引擎会把它当成**一个节点**——
那正是第 1 节那条坑的入口。

### 提示词 2：页面说明（结构化 JSON）

```
下面是 PAN-7「S3 协议支持」这张流程图已经定稿的节点（id 与文案）：
  A  进入寄养频道
  B  是否登录？
  C  选择宠物
  D  跳转登录
  E  提交订单

请为每个节点写一份页面说明，输出**一个** JSON 对象（不要代码围栏、不要解释），形状如下：

{
  "nodes": [
    {
      "id": "A",
      "kind": "page",
      "title": "进入寄养频道",
      "field": ["宠物类型（下拉）", "寄养日期（日期选择）"],
      "button": ["下一步"],
      "note": ["未登录时先走登录，不在这里拦"],
      "states": [
        { "name": "默认", "desc": ["展示频道介绍与入口按钮"] },
        { "name": "加载中", "desc": ["骨架屏，不展示假数据"] }
      ]
    },
    { "id": "B", "kind": "decision", "title": "是否登录？", "field": [], "button": [],
      "note": ["判定依据：会话里有没有用户"], "states": [] },
    { "id": "G", "kind": "system", "title": "门店接单后台", "field": ["订单号"],
      "button": ["接单", "拒单"], "note": ["非前端环节：门店在后台看到这张单"], "states": [] }
  ]
}

规则：
 1. id 必须与上面给的节点 id 一一对应，一个不多一个不少。
 2. kind 只能是 "page" | "system" | "decision"：用户看得到页面/弹层/表单的写 page，
    后台或外部系统写 system，流程图里的判断节点写 decision。
 3. page 必须有 title、至少 1 条 field、至少 1 条 button、至少 1 条 states；
    field 是这一步的输入项（写清控件形态），button 是这一步能点的动作，
    note 是约束、风险与「PRD 未提供」的推断（推断的就在 note 里标「PRD 未提供」）。
 4. states 是这一步的页面状态：默认 / 加载中 / 空 / 失败 / 无权限 / 超时……
    正常流程至少要有「默认」；异常状态宁可多写，那是评审最常问的地方。
    states 为空数组仅限 decision 与 system。
 5. 全部中文，每一条不超过 20 个字，不要 emoji。
 6. 这份材料的用途：讨论可行性——「这一步到底有没有页面、这么走通不通」
 7. 只输出 JSON 本身：第一个字符是 {，最后一个字符是 }。
```

（样例里的 `G` 只是形状示范，真正发生时会换成这张图里实际的节点 id。）

### 修图提示词（被拒之后接上，`PAN-7` + 一份**重叠**的图）

```
上一版 mermaid 没有通过检查（评估材料，PAN-7「S3 协议支持」）。请修好它。

上一版原文：
flowchart TD
  A["进入寄养频道"] --> B{"是否登录？"}
  B -->|是| C["选择宠物"]
  B -->|否| D["跳转登录"]
  D --> C
  C --> E{"宠物是否已建档？"}
  E -->|是| F["提交订单"]
  E -->|否| G["新建宠物档案"]
  G --> F
  B -->|游客| H["浏览列表"]
  H --> F

引擎原文：
错误：布局检查未通过（交叉 0 / 重叠 1 / 文字溢出 0），形态超限已拒绝产出——建议拆图、折叠细节或改用 mermaid 原生渲染。
{
 "nodes": 8,
 "edges": 10,
 "crossings": 0,
 "crossing_points": [],
 "overlaps": 1,
 "overlap_points": [
  {
   "ids": [
    "D",
    "H"
   ]
  }
 ],
 "textOverflow": 0,
 "textOverflow_points": [],
 "warnings": [
  "检测到 1 处节点重叠"
 ],
 "canvas": [
  678,
  468
 ],
 "spine": [
  "A",
  "B",
  "C",
  "E",
  "F"
 ]
}

要改的地方：
· 布局不合格：交叉 0、重叠 1、文字溢出 0。合格标准是三项全为 0。
  引擎给的位置：重叠点 {"ids":["D","H"]}
  常见成因：同一个判断节点挂了三条以上出边；分支链之间互相汇入；主干上出现跨级连线。
  改法：把图变简单——一条主干串 3–5 个节点，判断节点只留「是」「否」两条出边，其余情况挪进节点文案。

其余规则不变：第一行 flowchart TD；3–8 个节点；单主干 + 右分支；判断出边带「是」「否」；
不要代码围栏、不要解释文字，只输出修好后的 mermaid 源码。
```

三段各自不可省：**原文**（否则模型换一张全新的图，浪费一次调用还可能踩另一条坑）、
**引擎原文**（否则它只能猜「哪里不好」）、**要改什么**（否则它会把图改得更复杂——
交叉几乎总是「分支太多」造成的，正确方向是变简单）。

那份报告是**补跑 `--check` 捞回来的**：`-o` 模式布局不合格时引擎只留一句中文、不打印
报告，而 `*_points` 才说得清「哪两个节点在第几像素重叠」。见 `flow.ts` 的 `diagnose`。

## 3. 重试策略：什么算失败、花几次

| 关卡 | 上限 | 判失败 | 失败后 |
| --- | --- | --- | --- |
| 图 | **3 次**（首版 + 两次修图） | ① 引擎 `ok:false`（语法/形态/交叉/重叠/溢出）② 形状太小（<3 节点或 <2 连线） | 拼修图提示词重问；第 3 次还不行 → `flow_rejected`，消息 = `流程图 3 次都没通过检查：<最后一句引擎错误或形状描述>` |
| 页面说明 | **2 次**（首版 + 一次改） | ① 回话里没有 JSON ② zod 不过 ③ 节点没全覆盖 / 多出节点 / id 重复 | 拼「上一版 + 问题 + 节点清单」重问；第 2 次还不行 → `pages_rejected` |
| 配置 | — | `resolveProviderConfig()` 为 null | **一次都不问**，直接 `provider_unconfigured`，消息点名缺哪几个环境变量 |
| 接口 | — | `complete` 返回 `ok:false` | **不消耗**修图次数、不改写：`provider_error` + 服务端原文（`分组 auto 下模型 x 的可用渠道不存在` 原样到 owner 眼前） |

两条刻意的取舍：

- **上限是硬的**：三次之后不再问。用户等的是「为什么不行」，不是第四次尝试。
- **失败不落产物**：写文件、`attachArtifact` 都在全部校验之后；失败时库里没有产物行、
  磁盘上没有文件（用例钉着这两条），`data/uemaster/PAN-n/<stage>.html` 不会被半成品覆盖。

单次调用 90 秒（`CALL_TIMEOUT_MS`），最坏 5 次调用 ≈ 7.5 分钟 < `start.ts` 里 11 分钟的
陈旧作业阈值——用户不会看到「明明失败了却显示正在生成中」。

## 4. 产物的 DOM 形状

写到 `data/uemaster/<PAN-n>/<stage>.html`，站内路径 `/uemaster/<PAN-n>/<stage>.html`
（经 `app/uemaster/[...path]/route.ts` 出去，带 `sandbox allow-scripts` 的 CSP）。
单文件、样式与脚本内联、无 CDN、无相对资源。三栏是**同一份数据**的三个视图：

```html
<body>
<header class="head"> <span class="pan">PAN-7</span> <h1>标题</h1> <p class="meta">类型 · 提出人 · 阶段 · N 个流程节点</p> </header>
<main class="wrap">                        <!-- grid: 流程 | 页面 | 状态 -->
  <aside class="col">
    <h2 class="h2">业务流程</h2>
    <div class="svg-box">
      <svg id="flowsvg" data-flowspec="1" viewBox="…">…引擎产物，原样内联…
        <g class="node" id="flowchart-A-0" data-node="A">…</g>   <!-- 点这里也能切页 -->
      </svg>
    </div>
    <h2 class="h2">流程节点 …</h2>
    <ol class="node-list">
      <li><button type="button" class="node-btn" data-node="A">
        <span class="nid">A</span><span class="ntitle">进入寄养频道</span><span class="nkind page">页面</span>
      </button></li>                        <!-- 每个 mermaid 节点一行；nkind ∈ page|system|decision -->
    </ol>
  </aside>
  <section class="col">
    <div class="pane" data-pane="A">        <!-- 首屏不加 hidden；其余 hidden -->
      <div class="frame">
        <div class="frame-bar"><span class="nid">A</span><strong>进入寄养频道</strong><span class="nkind page">页面</span></div>
        <div class="frame-body">
          <section class="blk"><h3>字段</h3><ul class="items">…</ul></section>
          <section class="blk"><h3>按钮</h3><div class="btns"><span class="btn">下一步</span></div></section>
          <section class="blk"><h3>说明</h3><ul class="items">…</ul></section>
        </div>
      </div>
    </div>
    …
  </section>
  <aside class="col">
    <div class="states" data-states="A">
      <p class="who">进入寄养频道</p>
      <ol class="state-list"><li><strong>默认</strong><ul class="items">…</ul></li></ol>
    </div>
    …
  </aside>
</main>
<script>(function(){ … })()</script>
</body>
```

切换逻辑（约 30 行 ES5，无依赖）：

1. `document.addEventListener('click', …)`，`event.target.closest('[data-node]')` ——
   同一个处理器同时覆盖「左列表的按钮」与「SVG 里的 `<g data-node>`」；
2. `show(id)`：按 `data-pane` / `data-states` 两个属性切 `hidden`，
   给按钮加 `.on`；
3. 顺手把引擎契约里的 `#sel-ring` 挪到被选中的 `<g>` 上（`getBBox()` 外扩 7px）——
   图上有一圈跟着点的框，评审才看得出「我现在看的是哪一步」；
4. 初次加载 `show(第一个节点)`，所以禁用 JS 时首屏仍然是一个完整页面。

`kind` 决定中栏的形状：`page` 是实线框（用户看得到的页面），`system` / `decision` 用虚线框
（后台环节与判断，本来就没有页面）。上表中的 `nodes` 顺序 = mermaid 里节点首次出现的顺序。

## 5. 策略解析规则（`resolveStrategy`）

```ts
export type Strategy =
  | { kind: 'provider'; config: ProviderConfig }
  | { kind: 'cli' };

export async function resolveStrategy(): Promise<Strategy> {
  const config = await resolveProviderConfig();          // env → app_settings → null
  return config === null ? { kind: 'cli' } : { kind: 'provider', config };
}
```

一句话：**只看「配没配」，不看「通不通」。**

- 三格齐（接口地址 + Key + 模型名，`env` 优先、其次 `app_settings`）→ provider 路
  （`composeEvaluation`：问模型、验图、自己渲染）；
- 否则 → cli 路（P2.6 的 `packs.ts` 任务包 + 一条命令），一行没改。

两处接线：

- `startGeneration`：`kind === 'cli'` 才做「有没有生成器」那三句拒绝。否则一个只有 key
  的部署永远点不动按钮。落库、防重、陈旧回收一概不变。
- `runJob`：`kind === 'provider'` → `composeEvaluation(...)` → `doneJob(jobId, artifactId)`
  然后 return；CLI 那段（任务包 → 跑命令 → 验 mtime → attach）原样保留。
  **作业行的形状完全不变**：`running → done + artifact_id`，或 `failed + 那句中文`。

为什么不做「先试 provider，失败再退 CLI」：两条路的产物质量不同（provider 的图必须过引擎），
静默降级会让同一条需求两次出两种材料而用户看不出是哪一种。走哪条路由配置决定，
报错时也就能说清「你配了什么、我用了什么」。

为什么不在这里探测「通不通」：探测要发一次真实请求、烧一次 token，还会在按钮上卡几十秒。
配置写错的代价交给第一次生成暴露——那时接口原文会原样进 `uemaster_jobs.error`。

## 6. 用例与真实输出（`tests/compose.test.ts`，10 条）

没有 mock：provider 是本地 `http.createServer`（`127.0.0.1:0`，走真 `fetch`、真
`provider.complete`），图由**真的** `flowlayout.py` 排（~130ms/次），库与文件系统也是真的。

```
 ✓ composeEvaluation > 快乐路径：一次图 + 一次页面说明 → 产物落盘、attach、attempts=1
 ✓ composeEvaluation > 形状太小 → 修一次；修图提示词里写着节点数与连线数
 ✓ composeEvaluation > 引擎拒绝（重叠）→ 修一次；提示词里带着引擎原文与重叠点
 ✓ composeEvaluation > 三次都不对 → 失败；消息里是最后一句引擎错误，且不留产物         384ms
 ✓ composeEvaluation > 没配模型接口 → 失败，消息点名缺哪几个设置
 ✓ composeEvaluation > 接口报错 → 原文带回（不改写成「请求失败」）
 ✓ composeEvaluation > 页面说明两次都不合法 → 失败，不留文件
 ✓ 策略与作业管线 > resolveStrategy：配了 provider 就 provider，没配就 cli（只看配没配）
 ✓ 策略与作业管线 > runJob 走 provider：不需要任何 CLI，作业形状不变（done + artifact_id + 待设计）
 ✓ 策略与作业管线 > runJob 失败：作业收成 failed，错误就是那句中文原因                 415ms

 Test Files  1 passed (1)
      Tests  10 passed (10)
```

每条用例钉的判据（不是「跑通就算」）：

| # | 用例 | 真实素材 | 钉住什么 |
| --- | --- | --- | --- |
| 1 | 快乐路径 | 5 节点 4 连线（引擎实测三计数全 0） | `attempts===1`；`usage` 是两次调用相加（240/90）；SVG 内联（`id="flowsvg"`）；节点文案在页面上；`data-node` / `data-pane` / `data-states` 三件套齐；**无** `<script src>` / `<link href>`；inbox → 待设计 |
| 2 | 形状太小 | `A["开始"] --> B["结束"]`（2 节点 1 连线，引擎判**合格**） | `attempts===2`，且第 2 个 prompt 里真的有「2 个节点」「1 条连线」「要求是 3–8 个节点」+ 上一版原文 |
| 3 | 引擎拒绝 | 同一判断挂三条出边（实测 `overlaps: 1`，点是 D/H） | `attempts===2`，第 2 个 prompt 里有「重叠 1」「引擎给的位置」「重叠点」「把图变简单」 |
| 4 | 三次都不对 | 孤岛（引擎非零退出：「单主干」） | `flow_rejected`；消息含「3 次」与「单主干」；provider 恰好被调 3 次；库里 0 行产物、磁盘无文件；需求仍在 inbox |
| 5 | 没配接口 | 清空 env + `resetDb` 清空 `app_settings` | `expect(await resolveProviderConfig()).toBeNull()` 先成立，再断言消息点名三个 `FLOWERS_PROVIDER_*` |
| 6 | 接口报错 | 400 + `{"error":{"message":"分组 auto 下模型 x 的可用渠道不存在"}}` | `provider_error` 且消息**逐字**含那句原文 |
| 7 | 页面说明两次不合法 | 无 JSON；结构合法但只写 1 个节点 | `pages_rejected`，消息含「没有说明」；无文件、无产物行；provider 恰好 3 次调用（图 1 + 页 2） |
| 8 | 策略 | env 有 / 无 | `cli` ↔ `provider`，并读出 model 名 |
| 9 | 管线走 provider | 同上 | 作业 `done` + `artifact_id`；产物在；inbox → 待设计；**零 CLI** |
| 10 | 管线失败 | 三次孤岛 | 作业 `failed` + 那句中文；需求留在 inbox |

全仓合计：**419 passed（409 + 10）**，`npx tsc --noEmit` 干净。

## 7. 手工验证（一次）

**没有跑真接口。** 这条线要 owner 的 router key，而 key 不该由我读他的凭证文件；按约定
先把管线用本地假 provider 打通（生成、落盘、attach、页面三栏、点击切换全部实测），
真接口的延迟与 token 消耗留给下一任务，建议用最便宜的模型跑一次 `PAN-7 / evaluate`。

本地假 provider 跑出来的那份产物（`data/uemaster/PAN-1/evaluate.html`，随后删掉）：

- 三栏都对：左 SVG + 5 个节点行、中「进入寄养频道」的字段/按钮/说明、右两条状态；
- 点左侧 `C 选择宠物`，中栏与右栏同时切到 C，SVG 里的选中框跟着挪到 C；
- 图的 `viewBox 0 0 630 353` 在 470px 宽的列里等比缩放，正好铺满；
- 页面里没有一条外部请求（CSP 是 `default-src 'none'`，有外链会静默失效）。

随后 `npm run seed -- --reset` 把库恢复到 12 条需求的演示数据，自检 PASS。

## 8. 仍然粗糙的地方

1. **只有 `evaluate` 真的被设计过。** `stage` 参数是通的（三个阶段都能跑，材料名与
   「这份材料要回答什么」按阶段换），但 `review` 要的「问题清单」与 `inspect` 要的
   「与 PRD 的差异档位」都还没有对应的结构化字段——现在这两个阶段产出的仍是「流程图 +
   页面 + 状态」，比 `packs.ts` 写给 agent 的那份要求薄。`inspect` 还需要先读上一版产物
   做基线，这条完全没有接。
2. **提示词 2 的规则比 zod 严。** 提示词要求 `page` 至少 1 条 `field`/`button`/`states`，
   schema 只要求字段存在（`.default([])`）。模型偷懒时会出现「有页面、没状态」的空壳，
   现在会被**收下**。要不要收紧成一个可复原的错误，取决于评审时这类空壳有多烦人。
3. **`parseFlow` 是正则级的解析器。** 它认 `A["x"]` / `A{"x"}` / `A[["x"]]` 与 `-->`，
   不认 `-.->`、不认一行多条连线、不认标签里的转义引号。这些形状都不在提示词允许的子集里，
   所以它们会**先**被引擎或形状判据拒掉——但拒的理由会绕一道（「0 个节点」而不是「你用错了箭头」）。
4. **`resolveStrategy` 每次调用都读一次配置**（`runJob` 里还会在 `composeEvaluation` 内部
   再读一次）。主键读，代价可以忽略；真要省，把 `config` 传进 `composeEvaluation` 即可。
5. **没有并发闸门。** 一次生成最多 5 次模型调用、最坏 7.5 分钟；两个人同时点不同需求
   就是 10 次调用并发打同一个 key。限流/队列不在这一版。
6. **失败信息里没有「试了几次」之外的诊断。** 引擎报告已经带回来了，但只有最后一次；
   三次尝试的全过程（每版 mermaid + 每份报告）没有留下来，事后想问「它到底歪在哪」
   只能靠用户截图。
