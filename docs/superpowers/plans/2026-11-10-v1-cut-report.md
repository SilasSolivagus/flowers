# v1 范围裁剪 · 实施报告

> 依据：`docs/superpowers/plans/2026-11-10-v1-scope.md`（owner 裁决）。
> 分支 `main`，起点 `d1d4860`。这一版只改**承诺**与**入口**，既有代码一行没删。

## 一、改了什么

| 文件 | 做了什么事 | 为什么 |
|---|---|---|
| `src/core/uemaster/features.ts`（新） | 两个开关 + 一句标记 + `refsForV1`：`FEATURE_REVIEW_MATERIALS`（默认**关**）、`FEATURE_EVALUATE_READS_CODE`（默认**关**）、`V1_CLOSED_MARK = 'v1 暂未开放'` | 范围由一份判据决定，不由组件里散落的 `if` 决定。开关读 env 而不是 `app_settings`：这两个是**部署形态**（这版发出去有没有这个入口），不是某个人的偏好 |
| `src/core/uemaster/annotations.ts`（新） | 右栏两组：`OPEN_GROUPS`（待需求方确认 / 待研发确认）、`readOpen`（容错收组名）、`openRows`（**空组不铺标题**）、`sanitizeOpen`（两组问题过正文那道网） | 这是 v1 承诺里「右栏两栏标注」的实现。契约 `walkmap/1` 里右栏只有 `anno` 一种形状，所以分组发生在这一层：模型交两组 → 我们铺回 `anno`（组标题一条 + 该组条目），`build.py` 一行不改 |
| `src/core/uemaster/compose.ts` | ① 提示词要求两组并点名各组该问什么；② schema 收 `open`；③ `readFragments(…, { requireOpen })` 在**评估**这一路要求「整份至少一条」；④ `assembleWalkmap` 把两组铺进右栏；⑤ 评估不再读代码索引（`knownForEvaluate`）；⑥ 评估的正文规矩摘掉「研发参考 / 代码坐标 / 代码没读到」那几句 | ①③④ 是两栏标注；⑤⑥ 是「v1 不读代码，所以材料里不出现『代码里如何』的断言」。⑥ 用过滤而不是另抄一份：抄一份就有两份正文规矩，改一处忘一处时两边开始漂 |
| `src/core/uemaster/sequence.ts` | `SEQ_INFERENCE_LABEL = '逻辑时序（推演）'`、`SEQ_INFERENCE_NOTE = '参与者与步骤按需求描述推的；代码里怎么实现，需要研发确认'`；`renderSequencePage` 在每个没有页面的节点上印这两句 | 那张图是推的。v1 不读代码，不标就是拿假时序图去评审 |
| `src/core/read/board.ts` | `BoardCard.v1Closed`（= 状态不是 `inbox`） | 判据一条，读的人三处（卡片 / 抽屉 / 以后的 MCP）。写在组件里，第三处就得再抄一遍比较 |
| `app/components/Card.tsx` | 卡上多一行 `v1 暂未开放` | 非收集状态照常显示、照常能点开，只是标一句「这一版没开」——藏起来会让人以为数据丢了 |
| `app/components/Drawer.tsx` | ① 新增 `StateChips`（状态 chip + 非收集时的标记）；② 新增 `RefList`（参考段的行，按开关过滤）；③ 参考段改用它 | 整张抽屉带 `next/link` + server action，脱离 App Router 渲染不出来。把判据拆成两格，用例就能渲染它们、证明屏幕上真的没有那两行 |
| `app/globals.css` | `.card .v1` / `.chip.v1` 两条最轻一档的灰 | 这句话不是告警，也不是错误；它比「等谁」还要轻一档 |
| `tests/v1-scope.test.ts`（新，17 条） | 两栏标注 / 推演标签 / 开关 / 开关关着时读口不被调用 / 非收集标记（对着真库） | 四条 mutation 的落点见下 |
| `tests/v1-scope-ui.test.tsx`（新，5 条） | `RefList` 关着时的行、`StateChips` 与卡片上的标记 | 界面那一半 |
| `tests/{compose,walkmap,trace-attempts,evaluate-known-surfaces}.test.ts` | 评估夹具补上 `open`（这版新增的字段，评估材料必须给）；「评估带现有页面清单」那三条改成**按开关**测（关＝读口一次都不调；开＝两次调用都带清单） | 不是删用例，是把 owner 的新裁决钉进原来那三条 |
| `tests/product-language.test.ts` | 「图的提示词也提一句」那条：评估**不承诺**「研发参考」，评审/走查照旧 | 同上 |

## 二、开关

| 名字 | 默认 | 关掉之后 |
|---|---|---|
| `FEATURE_REVIEW_MATERIALS` | **关** | 抽屉「参考」段只剩「评估材料」一行；评审 / 走查两行**整行不渲染**（不是置灰）。代码、服务、接口、`uemaster_artifacts` 的 21 行、磁盘上的静态 HTML 一个都没删；直接访问 `/uemaster/PAN-N/review.html` 仍然打得开 |
| `FEATURE_EVALUATE_READS_CODE` | **关** | 评估连「现有页面清单」的读口都不碰（不是读了不用），提示词里因此一个字都没有「代码索引 / 现有页面 / 研发参考」 |

「开」只认 `1` / `true` / `on` / `yes`（不分大小写）：`=0` 与空串都是关。

## 三、参考段现在渲染什么

v1（开关关着）的抽屉「参考」段**只有一行**：

```
评估材料   [生成]  [交回材料]        ← 还没生成时
评估材料   /uemaster/PAN-729/evaluate.html  [11-10] [最新]   ← 生成之后
```

没有第二行、没有灰掉的按钮、没有 tooltip。**选「整行不渲染」而不是「置灰 + 提示」**：
置灰的按钮仍然在说「这里有个能做的事」，还得再配一句悬停说明；而「v1 暂未开放」这句话
已经给了非收集状态的需求，同一句话在两处各说一遍，读者会当成两件事。

实测（`getRequirementDetail` + `RefList` 真渲染，开关关）：
- PAN-729（待设计，已有产物）：只有 `评估材料` 那一行，带链接与 `最新` pill；
- PAN-721（收集，未生成）：只有 `评估材料` 那一行（`生成` / `交回材料` 由 `canEdit` 决定）。

## 四、评估入口

收集卡片 → 点开抽屉 → 「参考」段第一行（也是唯一一行）「生成」→ 出材料。
**没有新增点击**，而且比之前少了两行干扰。生成走的是原来那条服务端起作业的路
（`generateAction → startJob → runJob → composeEvaluation`），产物落在
`data/uemaster/PAN-N/evaluate.html` 并写进 `uemaster_artifacts`。

## 五、材料证据（真生成，PAN-729「APP适配无障碍」，收集状态的一条真需求）

产物：`/uemaster/PAN-729/evaluate.html`（35,104 字节；`uemaster_artifacts` 1 行；
`vocabHits = 0`、`vocabLeft = 0`；prompt 3468 / completion 16004）。

**节点表（6 个节点，3 页面 + 3 逻辑时序）**

| id | 中栏 | 节点 |
|---|---|---|
| A | 页面（`p-A`，phone） | 打开APP |
| B | **逻辑时序（推演）**（`backend-B`） | 是否开启无障碍？ |
| C | **逻辑时序（推演）**（`backend-C`） | 加载无障碍适配 |
| E | 页面（`p-E`，phone） | 使用核心功能 |
| F | 页面（`p-F`，phone） | 完成业务操作 |
| D | **逻辑时序（推演）**（`backend-D`） | 加载标准界面 |

**页面节点 A 的中栏**（`p-A` 的片段，原样）：

```html
<div class="wt-screen"><div class="wt-statusbar"><span>9:41</span><span class="wt-sb-icons"></span></div>
<div class="wt-nav"><span class="wt-nav-title">首页</span></div>
<div class="wt-body"><div class="wt-card"><div class="wt-section">欢迎使用</div>
<div class="wt-dimtext">点击下方按钮开始使用</div></div></div>
<div class="wt-bottombar"><button class="wt-btn" onclick="goNode('B')">开始使用</button></div></div>
```

**后端节点 B 的中栏开头**（原样，标签在图上）：

```html
<figure class="seq-figure" data-seq-steps="4" data-seq-inferred="1">
<div class="seq-cap seq-inferred">逻辑时序（推演）</div>
<figcaption class="seq-cap">是否开启无障碍？ · 后端流程 4 步：页面</figcaption>
<svg class="seq-svg" …>1. 读取手机的无障碍设置 / 2. 判断无障碍是否已开启 /
3. 已开启时进入无障碍适配 / 4. 未开启时进入标准界面</svg>
<div class="seq-cap seq-inferred-note">参与者与步骤按需求描述推的；代码里怎么实现，需要研发确认</div>
</figure>
```

计数（机器可数）：`逻辑时序（推演）` 出现 **3** 次 = 3 个没有页面的节点，一个不少；
边界说明 3 次；`待需求方确认` 6 次、`待研发确认` 6 次 = 6 个节点各一组；
`代码里` 全文只出现 3 次，**全部**在那句边界说明里（正文里 0 处）。

**右栏（节点 A）逐字**：

```
内容        按距离…（略，见材料）
操作        …
待需求方确认  PRD / 六问没写清：失败怎么办、这次不做什么、验收口径、边界条件
首次进入      打开 APP 后先显示欢迎入口还是直接进首页，影响用户第一次看到的内容
待研发确认   实现层面要研发回答：这一页有哪些状态、跳去哪里、失败怎么提示
按钮状态      「开始使用」在内容未加载完时是否可点，影响用户会不会卡在欢迎页
```

**第二份材料（走的是界面那条路，`生成` 按钮一次点击）**：PAN-722「AI搜索功能」，收集状态，
浏览器里点抽屉「参考」段那一行的「生成」→ 作业 `evaluate` **done**，三段各一次就过
（flow 188 / pages 5266 / build 34579 字节），需求随即从「收集」推进到「待设计」：

- `/uemaster/PAN-722/evaluate.html`（34,579 字节）：7 个节点 = 5 页面 + 2 逻辑时序；
- `逻辑时序（推演）` 出现 **2** 次（= 2 个没有页面的节点 C / D），边界说明 2 次；
- `待需求方确认` 7 次、`待研发确认` 7 次；`代码里` 全文 2 次，全部在边界说明里。

**抽屉证据**：`docs/superpowers/plans/2026-11-10-v1-drawer.png`（PAN-722 的抽屉，生成之后）：
抬头「待设计 · v1 暂未开放」，参考段**只有**「评估材料 /uemaster/PAN-722/evaluate.html
[11-10] [最新] [重新生成·第 2 版] [交回材料]」一行，没有评审 / 走查两行。

**看板证据**：`docs/superpowers/plans/2026-11-10-v1-marker.png`（截于 `http://localhost:3000`）：
待设计 / 待评审 / 待排期 / 待开发 四列的卡上都多了「v1 暂未开放」，收集列一张都没有。

## 六、四条 mutation（把判据改坏，用例就红）

| 改法 | 哪条用例红 |
|---|---|
| `openRows` 无条件铺两个标题 | `某一组是空的：**不铺**那一组的标题` |
| `renderSequencePage` 去掉标签 / 只印一次 | `每一张时序图都带标签…` 与 `**每一个**没有页面的节点…` |
| `refsForV1` 忽略开关（照旧三行） | `关着（v1 默认）：那两行整行不渲染` |
| `BoardCard.v1Closed` 反过来（收集也标） | `收集里的卡不标；评估立项之后（待设计）标` |

## 七、v1 仍然做不到的事（照实写）

1. **评估只看需求描述**：六问写得空的需求，材料就只能推出一张很薄的流程（PAN-729 的六问写得较全，出来的 6 个节点里仍有 4 条待确认是「需求没说」）。这不是流程问题，是输入问题。
2. **两栏标注是模型提的，不是人确认过的**：它给出「该问什么」，答不了「答案是什么」。组标题下面那句范围说明是我们的固定文案（`OPEN_GROUPS`），不是每条问题的注解。
3. **`待研发确认` 的答案 v1 无处落**：材料是静态 HTML，问题清单不能回写进需求；下一版如果要「回答留档」，得先有存放处。
4. **评审 / 走查入口关着**（`FEATURE_REVIEW_MATERIALS`）：21 份历史材料还在磁盘上、库里也有行，但界面没有入口。
5. **非收集状态的需求不能再走 v1 那条链**：它们标着「v1 暂未开放」，要用新能力得新建一条（owner 裁决：不做状态迁移、不做批量重置）。
6. **一次生成 = 2 次模型调用（约 2–5 分钟）**：`readFragments` 现在会因「两组一条都没有」整份退回并重问一次，这是新加的一道失败面；提示词已把该补什么写清楚。

---

# 补记（2026-11-10 同日，第二轮）：空右栏不再判死 + 生成中的进度

> 起点 `b490c70`。上文第七节第 6 条（「`readFragments` 会因两组一条都没有整份退回」
> 是新加的失败面）是这一轮的输入：owner 的裁决是**重试照旧，但绝不因此把材料判死**。

## 八、软化的那道门（before / after）

**before**（`b490c70`，`src/core/uemaster/compose.ts`）：

```ts
// 两次尝试都传 true：第二轮还是一条都没有 → 整份材料作废
const read = readFragments(reply.text, ids, { requireOpen: stage === 'evaluate' });
if (opts.requireOpen === true && asked === 0) {
  return { ok: false, why: '右栏的两组待确认一条都没有 —— …' };
}
// → buildPages 用完 MAX_PAGES_ATTEMPTS(2) → throw AppError('pages_rejected')
//   → 作业 failed，用户拿到一句「页面片段 2 次都没通过校验」，而图、页面、标注其实都在
```

**after**：

```ts
// 这道门只在**第一轮**生效：退回一次、让模型补（那句 why 说清两组各问什么）
const read = readFragments(reply.text, ids, {
  requireOpen: stage === 'evaluate' && attempt === 1,
});
```

`readFragments` 的判据本身一个字没删——它现在表达的是「再问一次」，不是「这份作废」。
**结构性的坏**（少节点 / 多节点 / JSON 不对 / 判为后端却没有 steps / 页面没有 html）
**每一轮都照旧判退**，一条豁免都没有：

| 坏法 | 结果 |
|---|---|
| 两轮都没提待确认 | **出材料**（右栏铺下面那一行），作业 done |
| 少节点、页面没 html | 两轮都退，`pages_rejected`，不留产物（`tests/open-empty-notch.test.ts` 钉住） |
| 判为后端却没给 steps | 第二轮同样被拒（`readFragments` 的 steps 义务不受影响） |

## 九、空态的文案（逐字）

`src/core/uemaster/annotations.ts` 新增 `EMPTY_OPEN_HEAD` / `EMPTY_OPEN_NOTE` /
`emptyOpenRow()`；`assembleWalkmap` 在**整份**一条待确认都没有时，给**每个节点**的右栏
末尾铺这一行（右栏跟着节点走，只铺一个节点等于另外几屏仍是空的）：

```
本版没发现待确认项
模型在这一轮没有提出待确认项；如果这份材料看着太顺，很可能是因为 PRD 和六问都写得很完整——也可能是漏了。请对照六问自查一次。
```

单节点为空时仍然是「一行都不铺」（`openRows(NO_OPEN)` 恒为 `[]`）——那一行说的是
**整份**的属性，不属于节点这一层。这一行是我们的固定文案，与组标题同一条规矩：
不过 `sanitizeAnno` 那道网（里面不归模型写）。

## 十、生成中的那一行

| 格子 | 内容 | 来源 |
|---|---|---|
| 步 | `正在按六问拆流程` / `正在生成页面片段` / `正在装配三栏` / `正在找页面` / `正在自检` / `正在写问题清单`；一次都没问过模型时 `正在读 PRD` | `uemaster_job_attempts.phase` → `src/core/uemaster/phases.ts`（六档，**没有新增档位**） |
| 秒表 | `mm:ss`，本地每秒跳（服务端渲染的第一帧也用同一个 `startedAt` 算，`suppressHydrationWarning` 只压那一格） | `uemaster_jobs.created_at` → `elapsed.ts` 的 `elapsedLabel` |
| 第几次 | `第 2 次尝试`，**只在 > 1 时**出现 | `max(uemaster_job_attempts.attempt)` |

- **表只有一份**：`PHASE_LABEL` 从 `read/progress.ts`（进度卡 P4-02）搬进
  `uemaster/phases.ts`（纯模块），进度卡与抽屉读同一张表；抽屉的 phase 中文因此不会
  与角落里那张卡说两句不同的话。措辞按 owner 这一轮给的例子改（原「正在画流程图 /
  正在画线框页 / 正在装配材料 / 正在复核」）。
- **轮询 1500ms → 2000ms**（`app/components/GenerateButton.tsx` 的 `POLL_MS`）：秒数
  是本地跳的，「新到一步」2 秒的延迟看不出来；再快只是把一个 server action 当日志刷。
  **不要低于 2000。**
- **服务端第一帧就带这三格**：`JobView` 与 `DetailRef.generation` 各多 `phase` /
  `attempt` / `startedAt`（两处各一条子查询，不新增往返）。否则刷新之后第一帧又只剩
  「生成中」三个字——那正是这次要修的观感。
- 作业结束（done / failed / 作业不见了）→ `runningRowOf()` 返回 `null` → 那一行消失，
  材料那一行由 `router.refresh()` 照旧出现。

## 十一、证据

**1. 一份「模型两轮都没提待确认」的真材料**（真 `build.py`、真落盘、真 attach；只有
「谁回话」是脚本：`.tmpwork/make-empty-open-material.ts`，三次调用 = 1 次图 + 2 次页面）：

```
材料对象：PAN-1「PC 剪贴板读取 URL」
第 1 次调用 → 图
第 2 次调用 → 页面片段（无 open）   ← 被这道门退回
第 3 次调用 → 页面片段（无 open）   ← 照收
[body-language] PAN-1 evaluate hits=0 left=0 通过
产物：/uemaster/PAN-1/evaluate.html
```

`~/Library/Application Support/flowers/uemaster/PAN-1/evaluate.html` 里那一行，逐字
（出现在 **5** 个节点的 `anno` 末尾，= 节点数）：

```json
"anno": [["内容", "按距离列出可寄养门店"], ["操作", "点提交进入确认"],
         ["本版没发现待确认项", "模型在这一轮没有提出待确认项；如果这份材料看着太顺，很可能是因为 PRD 和六问都写得很完整——也可能是漏了。请对照六问自查一次。"]]
```

**2. 抽屉里「正在跑」那一行**：`docs/superpowers/plans/2026-11-10-v1-running-row.png`
截于 `http://localhost:3000`（房超登录，`/?open=<PAN-47>`），参考段那一行是：

```
评估材料    正在生成页面片段   04:48   第 2 次尝试   [交回材料]
```

**这是被强制出来的运行态，不是一次真跑**：这台机器的 provider 没配（点生成只会得到
「还没选生成器」），而真生成要 2–5 分钟、也没法控制模型「必须不提待确认」。
强制的方式是往 `uemaster_jobs` 插一行 `running`、往 `uemaster_job_attempts` 插两行
（`flow` 失败 + `pages` 通过，`attempt` 因此是 2），跑完用
`.tmpwork/force-running.ts --clean` 删掉。界面那一侧走的全是真路径：真读模型
（`detail.ts` 的两条子查询）、真组件（`GenerateButton` / `RunningRow`）、真秒表。
另外右下角那张进度卡在同一张截图之外也显示了 `评估中 · 03:05`（同一个 `phase` 表）。

**3. 计数**：`requirements = 814`（跑前跑后都是 814，没有 reseed）；`uemaster_artifacts`
24 行（其中 1 行是本轮那份 PAN-1 空态材料）。

## 十二、六条 mutation（把判据改坏，用例就红）

| 改法 | 哪条用例红 |
|---|---|
| `requireOpen: stage === 'evaluate'`（恢复死判，去掉 `attempt === 1`） | `两轮都没提待确认 → 材料出来…` → `pages_rejected` |
| `const stand: Anno[] = []`（不铺空态那一行） | `每个节点的右栏最后都是那一行…`（+ 材料 HTML 里那句消失） |
| `RunningRow` 去掉 `<b>{view.phaseLabel}</b>` | 3 条：两处渲染 + 抽屉那一格 |
| `runningRowOf` 去掉 `status !== 'running'` | `作业结束了那一行就消失…` |
| 去掉 `第 N 次尝试` 那一行 | `第二轮尝试 → 多一句「第 2 次尝试」` |
| `assembleWalkmap` 把空态行铺进单节点那一层（`openRows` 无条件铺） | `单个节点为空时仍然是「一行都不铺」` |

## 十三、这一轮留下的坑（照实写）

1. **空态那一行会重复在每一屏**：十个节点的右栏各有一份同一句。它不是噪音（每一屏
   单独看是诚实的），但如果 owner 觉得重复，改法是在材料页头加一句总述、右栏留白——
   那要动 `build.py`，不在这一版。
2. **`第 2 次尝试` 只说次数，不说上一次为什么被拒**：被拒的理由在失败之后才出现在
   「详情」里。跑到一半时要不要显示「上一次：页面片段被拒」是下一版的事（那需要把
   `error` 也带进轮询，而它在跑的时候是半句话）。
3. **秒表是客户端算的**：两端钟差十几秒时，第一帧的数字可能和进度卡（它也这么算）一致
   但和真耗时差一点。硬超时 10 分钟之后由 `GIVE_UP_MS` 收口，不受影响。

---

# 十四、孤儿作业、停止 / 重试、六问必填（2026-11-10 第二遍）

> 起因：owner 现场踩到 —— 抽屉里「评估材料 · 正在生成页面片段 **1:29:12** · 第 2 次尝试」
> 转了 90 分钟，**停不下来、也重试不了**。库里那条 `uemaster_jobs` 是 `running`，
> 而跑它的 detached worker 在 dev server 重启时被带走了：没有任何进程会再写那一行，
> 也没有任何地方会注意到。当时只能手工 `UPDATE 1` 收掉。产品不该需要人来做这件事。

## 一、机制：pid + 心跳 + 年龄上限，三档（不是三选一）

判据都在 `src/core/uemaster/liveness.ts`，**顺序就是优先级**：

| 档 | 判据 | 阈值 | 为什么是它 |
|---|---|---|---|
| 1 | `worker_pid` 不在（`process.kill(pid, 0)` → `ESRCH`） | 立刻 | 一条作业 = 一个一次性 worker，作业 id 不复用。pid 没了 = **确定没有下文**，不是「未知」。读成「未知、继续等」正是那次事故：一条永远不变的行被包装成一件还在进行的事。 |
| 2 | `heartbeat_at` 过期 | **90 秒**（6 × 15s 心跳） | pid 可能为空（0035 之前的老行、spawn 之后 pid 还没写回的一瞬），也可能被系统回收给了别的进程。心跳是唯一能说「它刚刚还在动」的证据。留 6 倍余量：一次慢模型调用不该被误杀。 |
| 3 | 绝对年龄 | **15 分钟**（`created_at`） | worker 自己 10 分钟硬超时；15 分钟还没收口的，要么挂在不可中断的调用里，要么心跳根本没写成。**没有任何一条作业值得让界面永远转下去。** |

- 写：`startGeneration` 在 spawn 之后记 `worker_pid`（`where status='running'`，防 worker
  已经自尽）；`runJob` 自己也写一次 pid，并每 15 秒打一次心跳（`setInterval` +
  `unref()`，`finally` 里清掉）。
- 读（**修事故的就是这一处**）：`jobStatus`（抽屉每 2 秒问一次）、`readDetail`（打开抽屉
  的第一帧）、`listRunningJobs`（右下角进度卡）三处先各收一次。写侧已经死了，能注意到
  这件事的只剩「有人来看」。
- 收掉时写的那句话（用户读的，逐字）：
  「生成进程已退出（服务已重启或被终止），本次没有产出；可以直接重试」
  （心跳那一档：「生成进程 90 秒没有回报（可能卡住了），本次没有产出；可以直接重试」；
  年龄上限：「生成超过 15 分钟没有结果，本次已作废；可以直接重试」。）
- 只作用于 `status = 'running'`：done / failed / canceled 是历史，一个字都不改
  （`where status = 'running'` 同时让回收幂等）。

## 二、两个新动作（授权沿用「谁能生成，谁就能停 / 重试」）

`app/actions.ts` 的 `generateAction` 只做一件事解身份：`currentMember()`；没有任何状态 /
角色的门（抽屉另有一道 `can('edit')` 把按钮藏在「别人的需求只读」后面）。所以：

- `stopGenerationAction(jobId)` → `cancelJob`（`src/core/uemaster/control.ts`）：
  **先改库、后杀进程**。`update ... set status='canceled', error='已手动停止' where id=?
  and status='running'`；改到了才 `kill(-pid, SIGTERM)` + `kill(pid, SIGTERM)`
  （杀**进程组**：只杀父进程会留下还在写产物的 tsx 子进程）。顺序反过来，worker 会抢
  先写 failed，于是用户按的是「停止」、看到的是一句「生成失败」。`canceled` 是**自己的
  状态**，不折成 failed：人停的和程序坏的不是一件事，「失败率」这种数字要说得清。
  按晚了一步（作业已结束）返回 `canceled: false`，不弹错误。
- `retryGenerationAction(jobId)` → `retryJob`：从**库里**取需求与阶段（界面只交一个作业
  id），然后走 `startGeneration` —— 与「按下生成」同一条服务，六问 / PRD / 生成器 / 防重
  一条不少。旧行一行不动（新 id，历史留着）。

## 三、六问没填，不许生成（owner 的裁定，可被推翻）

必填：`context` 谁在什么情况下用 / `problem` 现在怎么做哪不好 / `outcome` 做成什么样算成功。
不必填：`surfaces` / `edgeCases` / `outOfScope`（收集阶段本来常常没有，材料已经把「没写」
当待确认项列出来）。理由：**前三问缺任何一条，材料只能编**。

- 判据只有一处：`src/core/uemaster/gate.ts`（`evaluateLock` / `lockMessage`）。
- 服务端是唯一真相：`startGeneration`（`stage === 'evaluate'`）在防重之后、生成器探测
  之前抛 `description_incomplete`，作业一行不落、worker 一个不甩、模型一次不问。
- 界面只是提前告知：读模型把**同一个字符串**放进 `DetailRef.needsDescription`，抽屉那一行
  按钮禁用 + 那行理由 + 一个进「编辑」（`/?open=<id>&edit=1`）的「去补」。
- 消息形状（逐字）：「还差三条没填：谁在什么情况下用、现在怎么做/哪不好、做成什么样算成功。
  先补完再生成——否则材料只能靠编。」（缺一条 → 「还差一条没填：…」）
- 已有的材料不受影响：产物链接、版本、新鲜度照旧；只有新的一次生成被拦下。

## 四、现场验证（对着演示库，不是截图）

`.tmpwork/live-verify.ts`（跑完把自己插的行删干净）。provider 指到一个「接了请求就永远
不回话」的本地口，所以作业真的在跑、且不烧 token、不写产物。

**① 孤儿自愈 —— 一次读就够了**（`PAN-813`，插了一条 pid 已死的 running，90 分钟前开的）：

```
读之前：status=running error=null worker_pid=39679 finished_at=null
jobStatus 返回：status=failed error="生成进程已退出（服务已重启或被终止），本次没有产出；可以直接重试"
读之后：status=failed error="生成进程已退出（服务已重启或被终止），本次没有产出；可以直接重试"
        worker_pid=39679 finished_at=set
```

**② 停止（真的入队一次）**：

```
停止之前：status=running error=null worker_pid=39680 finished_at=null
worker 起来了：pid=39680 活着=true
停止返回：{"canceled":true}
停止之后：status=canceled error="已手动停止" worker_pid=39680 finished_at=set  worker 活着=false
```

**③ 重试（旧行一字不动）**：

```
重试 → 新作业 85548e00（旧 95dc48a7）
旧行：status=canceled error="已手动停止" worker_pid=39680 finished_at=set
旧行确实没变：true
新行：status=running error=null worker_pid=39681 finished_at=null
```

收尾：三条验证作业行删掉；`requirements = 815`（跑前跑后一样，没有 reseed）。
注：任务书写的是 814，这一轮接手时库里已经是 815（不是我加的，跑前跑后都 815）。

## 五、十条 mutation（把判据改坏，用例就红）

| 改法 | 哪条用例红 |
|---|---|
| `stallReasonOf` 去掉死 pid 那一档 | `pid 不在 → 生成进程已退出` + `死 pid 的 running：一次 jobStatus 读取…` |
| 去掉心跳过期那一档 | `pid 活着、心跳过期 → 卡住` + `pid 为空、心跳过期 → 卡住` |
| 去掉 15 分钟年龄上限 | `pid 活着…但已经 15 分钟` + `15 分钟年龄上限 → failed` |
| `jobStatus` 不调 `healStaleJobs` | `死 pid 的 running：一次 jobStatus 读取…`（读侧自愈整条消失） |
| 停止写 `failed` 而不是 `canceled` | 3 条（停止 / 老行 / 停止后的 worker 收尾） |
| 停止只改库、不杀进程 | `行 → canceled + 「已手动停止」，worker 进程组真的被杀掉`（3.4 秒等到超时） |
| 重试返回**旧** id | `新作业是新 id；旧的失败行一行都不动` + `被停止的作业也能重试` |
| `evaluateLock` 恒返回 null | 服务层三条（全空 / 每条各一次 / 绕过界面） |
| `startGeneration` 不查六问 | 服务层三条（同上） |
| 读模型不给 `needsDescription` | `绕过界面…同一句话` + `按钮先禁用…` 两处 |

## 六、计数（跑前 → 跑后）

`npx vitest run`：**1754 → 1797**（新增 43：孤儿 17 + 停止/重试 9 + 六问 12 + 禁用态 UI 5）。
`3 skipped` 不变。`npx tsc --noEmit` 干净；`npm run build` 通过
（`✓ Compiled successfully`，6 条路由与之前一致）。`requirements = 815 → 815`。

## 七、这一轮留下的坑（照实写）

1. **重试会立刻再撞上同一件事**：如果 worker 每次都挂在同一个地方，重试只是再跑一遍。
   阈值（90 秒 / 15 分钟）是判「死了没有」，不是判「为什么死」——真正的病因在
   `uemaster_job_attempts` 的那几行里，界面上的「详情」读的就是它。
2. **pid 被回收给别的进程**时会误判「活着」：这一档由心跳与年龄上限兜住（最多多活 90 秒
   / 15 分钟），不会永久卡住。要更准就得用 pidfd / 进程启动时间比对，跨平台成本不值这一档。
3. **停止是 SIGTERM，不是 SIGKILL**：CLI 若不理会 SIGTERM，进程会多活一会儿（行已经是
   canceled，用户看到的状态是对的）。真要硬杀得等下一版；先给信号是「让它有机会写日志」。
4. **`STALE_RUNNING_MS`（11 分钟）现在只是历史常量**：判据搬到了 `liveness.ts` 的三档，
   这个常量还导出着（`start.ts` 的注释解释了它现在只对应「超时后一分钟」这一档）。
5. **六问必填只作用于「评估」**：评审的输入是 PRD 本身，走查是 PRD + 代码镜像，两条都不以
   六问为前提（v1 里这两条也还没开放）。若 owner 要把同一道门套到评审上，改的是
   `startGeneration` 里那个 `stage === 'evaluate'` 判断。

---

# 十五、六问不齐不能立项——门挪到状态变迁上（2026-11-10 第三遍）

> 起点 `28cea24`。上一轮把六问门装在生成器上（`startGeneration` 里那个
> `stage === 'evaluate'` 判断）：它挡住「不许出材料」，但**档不住立项**。owner 的
> 这一次裁决把这件事说清了。

## 一、裁决（owner，记录在案）

> **六问不齐不能立项。** 收集阶段必须填好核心三问才能点评估；点了评估就进待设计，
> 所以「六问不齐」既不能生成材料、也不能进待设计。存量数据同一规则；但**已到
> 待评审 / 待排期 / 待开发 / 开发中 / 测试中 / 已上线 / 已拒绝 / 已搁置 的一律不动**。

**被否决的选项：卡「六问全齐」。** 实测收集 244 条里只有 **1 条**六问全齐（后三格在
收集阶段本来就填不出来），卡它会等于上线即空转。**采用「核心三条」**：

```
必填（进待设计 / 生成评估材料）   context 谁在什么情况下用
                                problem 现在怎么做 / 哪不好
                                outcome 做成什么样算成功
不必填                          surfaces / edge_cases / out_of_scope
```

## 二、三个实测数（这条规则的依据，执行前从演示库现查）

```
收集 244 · 六问全齐 1 · 核心三条齐 108
待设计 111 · 六问全齐 5 · 核心三条齐 69
已过评估的状态（review/queue/ready/dev/test/live/rejected/shelved）一律不动
```

三条 SQL（`deleted_at is null`，空白串按没写算）：

```sql
select count(*) filter (where coalesce(btrim(context),'')<>'' and coalesce(btrim(problem),'')<>''
                          and coalesce(btrim(outcome),'')<>'') as core3,
       count(*) filter (where 六格全非空) as six_full
  from requirements where deleted_at is null and state = '<state>';
```

「核心三条齐 69」直接给出应退回数：`111 − 69 = 42`。第一行那个 `1 / 244` 就是
「卡六问全齐 = 上线即空转」的证据。

## 三、门在哪：`inbox → design` 的 `guard: 'brief'`

```ts
// src/core/state-machine.ts
export type Guard = 'prd' | 'brief';
export type TransitionContext = { hasPrd?: boolean; brief?: SixAnswers };

{ from: 'inbox',  to: 'design',  trigger: 'evaluate', guard: 'brief' },
```

```ts
// assertGuards（同一个函数，两道门各说各的）
if (t.guard === 'brief') {
  const refusal = evaluateLock(ctx.brief ?? {});
  if (refusal !== null) throw new AppError('missing_brief', refusal);
}
```

**为什么在变迁上、不在生成器上：立项是一个动作，材料是这个动作的产物。** 只把门装进
生成器，挡住的是「不许出材料」，而「没有六问的需求照样能立项」会从别的入口漏过去：
MCP 的 `requirement_start_design`、直接交回一份材料（`uemaster/attach.ts` 走的也是这条
迁移）、将来的批量导入。装在那条边上，全部入口一次覆盖。

- 判据与那句话只有一处：`src/core/requirements/brief.ts`（零依赖，只 import 标签表
  `requirements/fields.ts`，所以状态机可以安全 import 它）。三个消费者：状态机
  `assertGuards`、生成前 `startGeneration`、读模型 `read/detail.ts`——**同一个字符串**。
- `ctx.brief` 传的是刚 `for update` 锁回来的那一行（`Locked` 新增 `context` /
  `problem` / `outcome` 三列）：点名的是库里真实缺的那几格，不是调用方嘴上说的。
  忘记传 → 三格全空 → 拒绝（fail-closed，与 prd 门同一条规矩）。
- 生成前那道六问门**留着**（`startGeneration`）：不然一次点击会先烧 2–5 分钟模型调用，
  再由 attach 的迁移失败回滚——而这句话在点下去那一秒就已经成立。
- 存量：只有 `state = 'design'` 会被迁移动；`review` 及之后一个字不碰（第四节）。

## 四、两句话（逐字，各说各的事）

**六问门**（`brief.ts` 的 `lockMessage`；状态机抛的错误原文、生成前的拒绝理由、抽屉
按钮旁边那行提示都是它）：

```
还差三条没填：谁在什么情况下用、现在怎么做/哪不好、做成什么样算成功。
补完才能评估——评估要拿这三问立项、按这三问出材料，缺了只能靠编。
```

缺一条 →「还差一条没填：做成什么样算成功。补完才能评估——…」（数词跟条数走）。
**只说能做到的事**：补这三问就在同一个页面的 `?edit=1` 后面。这句话解释的正是门为什么
在变迁上——「评估要拿这三问立项」。

**阶段门**（`gate.ts` 的 `evaluateStageLock`，只有非收集状态才有）：

```
v1 只在收集阶段生成评估材料。这条需求现在在「待设计」——想用这个能力，请在收集里新建一条。
```

删掉了原来的「或先把它退回收集」——**那是空头支票**：`TRANSITIONS` 里没有
「待设计 → 收集」这条边，照着做会撞一句「不能从「待设计」直接到「收集」」。也不提
「去补六问」：那是另一道门的事，补完仍然不能生成，写进一句话会让人以为是同一个门槛。

界面这一侧：抽屉「参考」段评估那一行按钮禁用 + 那句理由（`needsDescription`，与服务端
逐字相同）；**收集阶段**给「去补」链接（`/?open=<id>&edit=1`），非收集状态不给——
六问能原地补，阶段不能。

## 五、存量回退：实测 42 行，幂等

`scripts/migrate-brief-to-inbox.ts`（`npm run db:brief`，默认 dry-run，`--apply` 才写库）。
判据不是 SQL 里另抄一遍，而是把候选行读回来用 `brief.ts` 的 `missingRequired` 过滤。

**执行结果（演示库，真跑）**：

```
待设计（核心三条不齐）命中：42 条（已退回收集）
  PAN-1 · PAN-2 · PAN-56 · PAN-79 · PAN-98 · PAN-101 · PAN-131 · PAN-191 · PAN-216 ·
  PAN-264 · PAN-318 · PAN-350 · PAN-417 · PAN-483 · PAN-722 · PAN-726 · PAN-732 ·
  PAN-738 · PAN-739 · PAN-740 · PAN-743 · PAN-747 · PAN-748 · PAN-757 · PAN-761 ·
  PAN-770 · PAN-775 · PAN-776 · PAN-778 · PAN-779 · PAN-788 · PAN-791 · PAN-792 ·
  PAN-794 · PAN-797 · PAN-798 · PAN-801 · PAN-802 · PAN-806 · PAN-808 · PAN-814 · PAN-816
待设计 111 → 69 · 收集 244 → 286
```

| 状态 | 前 | 后 | 差 |
|---|---|---|---|
| 收集 inbox | 244 | 286 | **+42** |
| 待设计 design | 111 | 69 | **−42** |
| 待评审 review | 2 | 2 | 0 |
| 待排期 queue | 17 | 17 | 0 |
| 待开发 ready | 1 | 1 | 0 |
| 开发中 dev | 1 | 1 | 0 |
| 测试中 test | 3 | 3 | 0 |
| 已上线 live | 265 | 265 | 0 |
| 已拒绝 rejected | 72 | 72 | 0 |
| 已搁置 shelved | 98 | 98 | 0 |

**幂等证明**（同一条命令连跑第二次）：

```
待设计（核心三条不齐）命中：0 条（已退回收集）
待设计 69 → 69 · 收集 286 → 286     ← 十个状态的差全是 0
```

机制：候选只取 `state = 'design'`，而该动的行第一次就都成了 `inbox`；`update` 还带
`and state = 'design'`（并发 / 重复执行的第二只手拿 0 行，于是既不写事件也不退行）。
空库不报错：`before` / `after` 都是空表、`moved = 0`。

**事件**：每条被移动的行一条 `requirement.state_changed`，`actor = 'system'`，实际 42 条：

```json
{"from":"design","to":"inbox","reason":"六问核心三条不齐，v1 立项前必须先补",
 "batch":"2026-11-10-brief-to-inbox"}
```

`batch` 是 0028 那条口令（「批量操作不该刷屏」）：一次命令移动 42 行，逐条进通知会让
超管收到 42 条一样的东西；带上它，`read/notify.ts` 的 `notBatch` 把它们挡在 feed / 红点 /
企微之外，审计记录照旧在时间轴上（`detail.ts` 的 `describe` 认这个类型，中文是
「状态变更：待设计 → 收集」+ 原因）。`EVENT_CLASS` 归 `change`。

**可撤销**（一条 SQL，不留痕；事件行会留着当审计）：

```sql
update requirements r set state = 'design', state_entered_at = now()
 where r.id in (select requirement_id from events
                 where type = 'requirement.state_changed'
                   and payload::jsonb ->> 'batch' = '2026-11-10-brief-to-inbox');
```

## 六、五条 mutation（把判据改坏，用例就红；逐条真跑过）

| 改法 | 哪条用例红 |
|---|---|
| 摘掉表上的 `guard: 'brief'` | `表：门挂在变迁上 > inbox → design 那一条带 guard: brief` 等 **9** 条 |
| `assertGuards` 只在三条**全空**时才拒 | `缺 context / problem / outcome：各拒一次且点名`、`三条全空 → 三条都点名` 等 **6** 条 |
| 迁移把「非 inbox」全退回（`state <> 'inbox'`） | `dry-run 报出 2 条`、`--apply 那 2 条退回`、`第二次跑命中 0 行` **3** 条 |
| 迁移候选把 `inbox` 也算进来 | `幂等 > 第二次跑命中 0 行` **1** 条 |
| 阶段门把「或先把它退回收集」加回去 | `「退回收集」在任何一句话里都不再出现`、`一字不差…` **2** 条 |

## 七、计数

- `npx vitest run`：**1815 → 1838**（新增 23：`tests/brief-guard.test.ts` 15 条 +
  `tests/brief-backfill.test.ts` 8 条；`3 skipped` 不变）。
- 另有 **30 处旧夹具**补上了核心三问（`tests/helpers/brief.ts` 的 `BRIEF`）：
  它们测的是排期 / 时钟 / 通知 / 权限，而新的门会让它们停在立项那一步。
  **不是为了凑绿**：`type-optional` 里那条指纹用例把 problem/outcome 显式留空，
  因为它比的是「指纹认得哪十格」。
- `npx tsc --noEmit` 干净；`npm run build` 通过（6 条路由与之前一致）。
- `requirements` 总数 **815 → 815**（只改 `state`，没有增删行；软删 1 行没动）。

## 八、这一轮留下的坑（照实写）

1. **42 条退回之后，收集列从 244 涨到 286**：这些人现在要在收集里补三问才能立项。
   抽屉会明确写出缺哪几格并给「去补」，但**没有通知他们**——那批事件的 `batch` 让它们
   不进 feed（否则是 42 条一样的打扰）。要不要单独发一次「请补六问」的推送，是下一版
   的事（那需要一条新的事件类型与一次主动扇出）。
2. **`design` 里仍可能有六问齐但质量很差的行**：门只判「非空」，判不了「写得对不对」。
   材料里那两条待确认（`待需求方确认` / `待研发确认`）是这件事的兜底。
3. **六问只在立项 / 生成这两处被要求**：评审、走查两条链路（v1 里还关着）不以六问为前提；
   若要把同一道门套过去，改的是 `guard` 表，不是再抄一句判据。
4. **恢复路径是 SQL**：没有界面能把这 42 条放回待设计（`restore` 那条边只从 `shelved`
   出来）。这与 0021 那次回退同一形状：系统批量做的口径修订，反向操作是运维动作。

---

# 十六、材料按版本留 + 评估 ≠ 立项（2026-11-10 第四遍，owner 的两条产品模型纠正）

> 起点 `52e4267`。两条都不是打磨，是**产品模型**错了：
> ① 材料被覆盖——库里说「存过两版」，盘上只有一份；
> ② 「点评估」把材料生成与 `收集 → 待设计` 绑成一个点击——**把决定藏进了产物里**。

## 一、版本化 URL：`evaluate-v001.html`

| 决定 | 内容 | 为什么 |
|---|---|---|
| 名字 | `<stage>-v<NNN>.html`，零填充三位：`evaluate-v001.html`、`evaluate-v002.html`… | 选版本号而不是时间戳：版本号就是界面上那个数字（「第 3 版」/「v2」），文件名与抽屉对得上。零填充是为了**自然排序**——不填充时 `ls` 把 `-v10` 排在 `-v2` 前面，而版本化的一半价值就是「按名字排出来就是时间顺序」。999 版之内成立；第 1000 版会变成 `v1000` 重新破序（那是同一需求重做过一千次的极端情形） |
| 版本号 | `max(库里的行数, 盘上最大版号) + 1`（`src/core/uemaster/versions.ts` 的 `nextArtifactVersion`） | 只看库会漏掉「attach 失败但文件已写下」的孤儿；只看盘会漏掉「行删了但版本号不该复用」。取大者 + 1，两头都不覆盖。并发安全来自 `uemaster_jobs_running_unique`（同一需求同一阶段同时只有一条 running 作业） |
| 谁写这个名字 | `packs.ts` 的 `versionedName`（纯函数），三处消费者：CLI 包的「交付」行、`compose/review/inspect` 三个落盘点（经 `versions.ts` 的 `versionedFileOf`）、`generator.ts` 的 `artifactUrlIn` 反向解析 | 包怎么写、文件就该在哪：这是 P2.6 的老契约，版本号必须跟着包一起走。放 `store.ts` 会成环（它反向 import 了 `packs.ts` 的 `isStage`） |
| 存量 | 一个字节都不动 | 那些 `evaluate.html` 是某次评审依据过的材料，磁盘上剩的哪份就是哪份 |

`attachArtifact` 的入参形状没变（仍是站内路径或 http(s)）：版本号是**写侧**的事，
`parseUrl` / `artifactFile` 那条围栏不需要认识 `-vNNN`。

## 二、存量同 URL 的多行：如实标注（迁移 0036）

- 新列 `uemaster_artifacts.content_lost boolean not null default false`。
- 判据（`0036_artifact_content_lost.sql`）：同一 `(requirement_id, stage)` 内**同一个 url
  有多行**时，除最新那一行（`created_at` 最大，同时刻用 `id` 定序，与读侧
  `created_at desc, id desc` 同一套）之外都置 `true`。
- 实测：**7 组共享同一链接、13 行被标注**（`artifacts` 共 26 行）。PAN-47 就是那两条：
  `03:34` 那行 `content_lost = true`，`04:40` 那行 `false`。
- **不编数据**：不删行（行是「当时确实生成过一次」的证据）、不生成占位文件、不把最新那份
  拷成旧版的副本。被标注的行在界面上写「内容已被覆盖」，整段上面写一句为什么救不回来。
- 抽屉里那句话逐字：`更早的版本内容已被覆盖，无法恢复（当时按固定文件名保存）`
  （常量 `LOST_HISTORY_NOTE`，`app/components/Drawer.tsx`）。

## 三、拆开两个动作：哪几个名字变了

| 位置 | 之前 | 现在 | 为什么 |
|---|---|---|---|
| 状态机 trigger（`inbox → design`） | `evaluate` | **`approve`** | 这条边现在只剩「立项」一个含义。留着 `evaluate` 会让下一个人以为「评估 = 立项」，而生成材料已经完全不碰这条边了 |
| 界面动作（`DetailAction`） | `evaluate` | **`approve`**（按钮文案仍是「立项」） | 动作名要能对上它做的事；`evaluate` 这个名字属于「生成评估材料」，而那个动作不在动作条上 |
| `app/actions.ts` | `evaluateAction` | `approveAction`（底下仍调 `requirements/evaluate.ts` 的 `evaluate()`） | 领域服务名的改名会动 19 个用例文件与三处脚本，收益只有名字；真正的口径在 trigger、动作名与两个调用点 |
| `uemaster/attach.ts` | 落地评估材料时同事务调 `evaluateInTx` 推进到待设计 | **删掉整段** | 见下 |
| 时间线事件 `requirement.evaluated` 的标签 | 「评估完成，进入待设计」 | 「立项，进入待设计」 | 事件类型是库里的历史字符串（改名会把一条时间线劈成两个名字），但它记的事实只有一件：这一行进了待设计 |
| MCP 工具 | `requirement_start_design`（action `evaluate`） | 同名工具、action `approve`，描述里加一句「与 uemaster_plan / uemaster_attach 是两件事」 | 工具名本来就叫「立项」，没有误导；误导的是 description 里那句「评估材料推进到待设计是 attachArtifact 内部的事」——已删 |
| 六问门的文案（`brief.ts` 的 `lockMessage`） | 「补完才能评估——评估要拿这三问立项、按这三问出材料」 | 「补完才能立项，也才能出评估材料——立项要拿这三问站住，材料要按这三问画」 | 旧句子把两个动作写成一句话（「评估…立项」），拆开之后它就成了错的。判据、code（`missing_brief`）、「还差N条没填：…」的前缀一个字没动 |

**为什么必须分开**（写进 `attach.ts` / `state-machine.ts` / `brief.ts` 的注释里）：
**材料是产物，立项是决定**。把决定藏在产物里，「我生成一份材料看看」与「这条需求我接了」
就成了同一个点击——用户没有改主意的机会，而「材料出过几版」与「立没立项」在时间线上也
分不开。删掉那条自动推进、而不是「留着但默认关掉」：一条「材料落地会改状态」的路径只要
还在，就还有一个入口把决定藏在产物里（人 / agent / 批量导入都踩得到）。

## 四、阶段门现在说的是什么

判据与文案不变（`gate.ts` 的 `evaluateStageLock`：`v1 只在收集阶段生成评估材料。这条需求
现在在「X」——想用这个能力，请在收集里新建一条。`），**行为上唯一的变化是它读起来更简单
了**：生成不再改状态，所以**收集里的需求可以随便重做多少次评估材料**，每次都只是一份新
产物（v001 / v002 / v003…）。「待设计之后不再生成新评估材料」这条仍然成立，理由改写成
如实的那一版：那条需求在收集里出过材料、然后有人点了立项，再生成一次等于用今天的描述
重画一张当初没人看过的图。

## 五、权限：两个动作同一套规则，拦在不同的层（照实报告差异）

| 动作 | 读模型（看不看得见） | 服务层（做不做得到） |
|---|---|---|
| 生成材料 `startGeneration` | `permissions.edit`（`can('edit')`），`Drawer` 里 `canEdit` 才渲染 `GenerateButton` | **没有** `can()` 检查：`generateAction` 只解身份（`currentMember()`） |
| 立项 `evaluate` | `visibleActions` 用 `ACTION_ABILITY.approve = 'edit'` 过滤动作条 | `assertCan(tx, actor, …, 'edit')`（先锁行、先判权限、再判状态门） |

**规则相同（都是 `can('edit')`）、执行位置不同**。这一版**没有**给生成补一道服务层检查：
那会把「按钮能不能点」变成一条新的线上行为（无主需求的生成会被拒），超出这两条纠正的
范围；而 `tests/artifact-versions.test.ts` 里那条表驱动用例钉住的是**规则相同**（六种演员：
`approve` 在动作条里 ⇔ `can('edit')` ⇔ 生成按钮会渲染），差异本身写在这里备查。

## 六、五条 mutation（把判据改坏，用例就红；逐条真跑过）

| 改法 | 哪条用例红 |
|---|---|
| `nextArtifactVersion` 恒返回 `1`（= 回到固定文件名） | `连续生成两次：v001 与 v002 是两份文件`、`版本号 = max(库里行数, 盘上最大版号) + 1`、`上一版还在而这一版什么都没写` **3** 条 |
| 把 `attach` 的自动推进加回去（`if (stage === 'evaluate' && state === 'inbox') evaluateInTx(...)`） | `生成 / 交回材料不改状态` 整组 4 条、`uemaster_attach`、`runJob 成功…`、`交回一份评估材料：状态还在收集` 等 **8** 条 |
| 摘掉表上的 `guard: 'brief'` | `六问缺一条 → 立项被拒`、`表：门挂在变迁上` 2 条、`判据：核心三条` 5 条、`缺成功口径` **10** 条 |
| 读模型把 `contentLost` 恒置 `false` | `读模型：最新一份 + 历史（1 版）…` **1** 条 |
| 抽屉不画那句「无法恢复」、不标「内容已被覆盖」 | `那一行标「内容已被覆盖」…`、`被覆盖的行仍然给出链接…` **2** 条 |

## 七、计数

- `npx vitest run`：**1839 → 1858**（新增 19：`tests/artifact-versions.test.ts` 14 条 +
  `tests/artifact-versions-ui.test.tsx` 5 条；`3 skipped` 不变）。94 个文件全绿。
- `npx tsc --noEmit` 干净；`npm run build` 通过（7 条路由，与上一轮一致）。
- `requirements` 活行 **814 → 814**：`inbox 286` / `design 69` **before = after**
  （这一轮没有迁移任何需求状态，只加了产物那一列）。
- `uemaster_artifacts` 26 行不变，其中 **13 行** `content_lost = true`。

## 八、这一轮留下的坑（照实写）

1. **`evaluate` 这个名字还留在领域服务上**（`src/core/requirements/evaluate.ts` 的
   `evaluate()` / `evaluateInTx()`）。它做的是立项；改名要动 19 个用例文件与三处脚本。
   读这一行的人该记住的是「它做立项」，不是「它叫 evaluate」。
2. **被覆盖的那 13 行没有内容可显示**：界面上它们只是「内容已被覆盖」的一条链接。要真正
   看到那一版，只能回到当时评审过它的人手里。历史数据救不回来，这一版只保证**不再发生**。
3. **生成没有服务层权限检查**（见第五节）。界面挡住了，MCP 的 `uemaster_plan` 也不检查
   （它只是取包）；会不会有人绕过界面对别人的需求跑一次生成，这一版不回答。
4. **版本号不是事务里算的**：它读库 + 读盘，然后写文件。唯一挡住并发的是「同一需求同一
   阶段只有一条 running 作业」这条库约束；若将来支持并行生成，这一处要挪进事务。

---

# 十七、owner 点出来的五件事（2026-11-10 第五遍：一个 bug、一条统一、一处文案、两处缺失）

> 起点 `0b8bd25`（`v1.0.0`）。五条都是 owner 自己点出来的：一条是**同一个部署里同一把
> key 两条路两个答案**，一条是他要的统一口径，一条是叫法不一致，另外两条是**普通人根本
> 没有入口**。五次提交按风险排序，先修坏掉的那个。
>
> 五条都在 `main` 上，五个 commit：
> `3fdecf1`（凭据）· `8b0d774`（初始密码）· `9a6547a`（口令→密码）· `1ec9a60`（企微绑定）
> · `6b8eb76`（深色流程图）。

## 一、生成器报「凭证缺失」：harness 改用库里那把 key

**坏在哪。** 设置 · 成员 顶部「生成器」一行按「测试」回来的是

```
失败：dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official";
store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it),
or export DEEPSEEK_API_KEY in the launching environment
```

而同一个部署的 `app_settings` 里存着 `provider.apiKey` / `provider.baseUrl` /
`provider.model`（`https://api.deepseek.com/v1` · `deepseek-flash`），评估流水线一直在用它。
**同一台机器、同一把 key，一条路说可用、另一条路说缺凭据**——那是我们的接线漏了，不是
owner 的配置漏了。`candidates.ts` 里那句「失败照登原文」是对的（那句话本身有价值），错的是
我们从来没把 key 交给 CLI。

**走的是哪条凭据路（这一节要回答的那个问题）。** 选的是 **`DEEPSEEK_API_KEY` 环境变量**
——dsh 文档写明的两个合法来源之一（「export `DEEPSEEK_API_KEY` in the launching
environment」），而我们 `spawn` 它的那个进程**就是**它的 launching environment：`runRaw` 的
`spawn(..., { env: childEnv(credential) })`。所以从 `app_settings` 读出的 key 按候选表
约定的变量名（`CREDENTIAL_ENV`，目前只有 `dsh → DEEPSEEK_API_KEY` 这一条是查过文档 + 实测的）
塞进子进程环境，用户不必在 shell 里 `export` 任何东西。

两条**没选**的路，各自有理由：

| 没选的方案 | 为什么不行 |
|---|---|
| 写 dsh 的凭据存储（`~/.dsh/llm-deepseek/*.json`、`dsh` 的 credentials service） | 那是另一个应用的私有状态（文件格式未公开、由它自己的 HMR/写入路径管）。我们去写它 = 把一个 bug 修成两个应用共享一个不归我们管的格式 |
| 干脆走直连模型路（= 忽略 CLI 那条路） | ① `resolveStrategy` 在有 provider 三格时**已经**走直连，所以「生成」本来就不缺凭据，缺的只是设置页那一格「这条 CLI 能不能用」；② 换掉它等于让「生成器」这个下拉变成摆设（owner 明说了要 harness 这条路能用） |

**边界三条**（不补的地方比补的地方更重要）：

1. 不认的命令不补（`claude` / `codex` / `ollama` / 自建）：它们不吃这个变量（本机实测 claude
   与 codex 都是「装了、登录了、仍然 401」），塞进去只会让人以为配好了。
2. 没有 key 时不补、也**不覆盖**父进程环境：shell 里本来有 `DEEPSEEK_API_KEY` 就照旧用它。
3. **不转发 `provider.baseUrl`**：dsh 的 `DEEPSEEK_BASE_URL` 要 Messages 兼容根
   （`https://api.deepseek.com/anthropic`），而我们那三格是 OpenAI 兼容根（`/v1`）——
   转发等于把能用的默认地址改成一个不兼容的地址。

`app/actions.ts` 的「测试 / 测试并使用」用 `credentialForTest()`（`resolveProviderConfig(actor)`，
与真生成同一个解析函数）；worker 的 CLI 那条路也接上同一条凭据——这样「撤掉三格之后生成
突然开始要 shell 环境」这种同一把 key 两种答案的坑不会再出现。

**现场证据（真 dsh + 真库里那把 key，各跑一次）：**

```
不补凭据 -> {"ok":false,"error":"dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route \"deepseek-official\"; ..."}
补凭据   -> 通过 202B 9206ms file
```

**用例**：`tests/generator-credential.test.ts` 7 条。核心那条用一个**只认
`DEEPSEEK_API_KEY`** 的假 `dsh`（真 `spawn` + `shell` + `env`）：带凭据它交 HTML、不带它说
`MISSING_CREDENTIAL`。把 `spawn` 的 `env:` 摘掉，「通过」那条立刻红（mutation 真跑过）。

## 二、初始密码统一为团队约定的那一条（迁移 0037）

**坏在哪。** 初始密码是**每人一条随机串**、由种子在终端打印一次：超管要把 `kXm3fQ…` 念给
新人，念错一个字符就进不去，而谁都拿不回明文（库里只有 scrypt 串）。

**改了什么。** 三处口径**同一个常量**（`src/core/auth/password.ts` 的
`DEFAULT_MEMBER_PASSWORD`），没有第二份字面量：

| 位置 | 做什么 |
|---|---|
| `createMember` | 不传密码时的默认值；仍然走 `assertPassword` 同一道长度校验（默认值不是绕过校验的后门） |
| 迁移 `0037_member_initial_password.sql` | 存量成员一次性落到这条上。scrypt 不在 SQL 里，所以哈希是写迁移时**预先算好**写进去的（参数+盐+派生键都在串里）。`session_epoch` 一起往前推——改密码 = 旧票作废 |
| `scripts/seed.ts` | 重灌之后的七个人也用同一条；**明文不再打印**（它已经是团队共识的那条，再往终端写一遍只是多留一份在 shell 历史里） |

**多少人被改**：`members` 7 行全部落到同一个哈希（`password_updated_at` 全部落章），
跑前跑后 `requirements` 活行 **814 → 814**（没有 reseed）。

**为什么所有行共用一个盐是可接受的**：盐防的是「一次预计算打穿所有人」，而这批账号共用的
是一条**已知的**初始密码——预计算对它毫无意义；真正的防线是「登录之后自己改」，所以界面
在**建之前**就写清「新成员会拿到哪一条」，建完之后再回显一次，两处都带「我的 → 密码」这个
改法。**重置密码仍然随机**：重置是给忘了密码的人换一条新的，不该换回人人皆知的那条。

**明文不进日志**：迁移文件里只有派生键，种子不再打印，这份报告里也只有「团队约定的那一条」
这个说法。

**用例**：`tests/member-password-default.test.ts` 9 条（默认值能登进去、显式值覆盖默认值、
太短的仍被拒、重置仍然随机、迁移文件里的哈希验得过明文且**不含明文**、七个人都能用那一条
登进来、种子读同一个常量）。两条 mutation 真跑过：把迁移里的哈希改坏一个字符 → 红；把默认
值改回 `generatePassword()` → 红。

## 三、「口令」→「密码」

**坏在哪。** 设置页写着「改密码」，成员行却写着「重置口令」——读的人会以为那是两件事
（界面上曾经真的是两套动作）。

**改了什么。** `app/` 与 `src/` **整目录**，一处都不剩：**69 处 / 15 个文件**（`口令` →
`密码`，`重置口令` → `重置密码`），测试里镜像 UI 的 **22 处**一起改。守卫是
`tests/password-copy.test.ts`：遍历这两个目录，抓到这两个字就红——文案是「漏一个就够刺眼」
的东西，判据就该是「一个都不剩」，而不是几条断言。

两处**刻意不动**：

- `src/db/seeds/prd-url-backfill.json`：那是**需求内容**（一条 PRD 标题里就写着「走生成口令
  的逻辑」），不是界面文案；改它等于改材料内容。
- 标识符与列名（`oldPassword` / `newPassword` / `passwordHash` / `PasswordRow` /
  `resetPassword` / `password_hash`）：改名要动数据库列、会话票据与所有调用方。用例里专门有
  一条钉住「它们没跟着改」。

`tests/brief-backfill.test.ts` 里那句「0028 那条裁定的口令」是**比喻**（不是 password），
保持原样。

## 四、成员怎么绑自己的企微 ID / 机器人：补一条带引导的路

**原来有什么（照实写）。**

- `members.wecom_userid` 与 `wecom_lookup_at` 两列，`resolveUserid` 的「名字 → userid」解析
  （缓存优先、成功与失败都落时刻）；
- 设置 · 我的 里一行「还没对上企微账号」+ 一个「查一下」按钮（`lookupWecomAccount`）；
- 企微推送的一整条链（`wecom-cli message aibot send`、`notify_deliveries` 的三态与唯一索引、
  每人每轮 5 条上限、绑定自检）；
- **没有**的：本人自己绑的入口（「企微账号」是一个**算出来的值**，只有超管能推动它）、
  「用自己的机器人」这件事本身（连列都没有）。

**加了什么。**

1. **绑定企微**（状态 pill：已绑定 / 未绑定 / 验证失败）
   - 两句**用途**说明（私聊通知；没绑定也能用，只是收不到推送）+ 怎么拿到自己的 userid
     （企业微信 → 我 → 资料页，工号那一栏；或让管理员在企微后台「通讯录」里查）；
   - 输入框 +「验证」：验证是**真去通讯录查一次**（`lookupUseridExact`，同一个 `wecom-cli`、
     同一套 `searchArgv` / `parseResponse` / 失败码，**逐字相等**才算命中——不猜）；
   - 失败文案是服务层原文：「企微通讯录里没有 userid 为「x」的人。核对工号/英文名（企业微信
     → 我 → 资料页），或让管理员在企微后台「通讯录」里确认这个账号」；
   - 「按名字查」= 复用**已有的那条路**（`lookupWecomAccount` / 那个「查一下」），只是把结果
     填进输入框等人确认——不是第二套匹配逻辑；
   - 失败**不落 userid，只落 `wecom_lookup_at`**：界面因此显示「验证失败」而不是「未绑定」，
     两者的下一步不一样（一个去改账号，一个去绑）。空串 = 解绑，两列一起清。
2. **用自己的机器人**（可选）：webhook 输入框 +「测试」（真的发一条、**不带任何需求内容**）
   +「保存」/「清除」；判据窄（https + 主机 `qyapi.weixin.qq.com` + 路径
   `/cgi-bin/webhook/send` + key 非空——这一列会被服务器 `POST` 出去，允许任意 URL 等于给成员
   开一个内网探测的口子）；**只回显末 4 位**（`maskWebhook`，与模型 key 的 `keyTail` 同一条
   规矩）；设了之后 `dispatch` 直接 POST 到他这条、**不再解析 userid**（两路都发 = 同一件事
   响两次），自检也不再把他报成「没绑账号」（没有 userid 不影响他收到东西），但仍查「最近几条
   发不出去」。
3. **数据**：迁移 `0038` 加 `members.wecom_webhook`（幂等）。绑定状态**不存**，由
   `bindingStateOf(wecom_userid, wecom_lookup_at)` 算出来——同一件事不要两个来源。

**用例**：30 条（`tests/wecom-binding.test.ts` 21 条服务层 + `tests/wecom-binding-ui.test.tsx`
9 条界面渲染）。三条 mutation 逐条真跑过：跳过真实验证 → 失败那条红；掩码改成回整串 → 两条红；
dispatch 不看 webhook → POST 那条红。

## 五、深色模式下流程图看不见

**坏在哪。** 两个原因叠在一起：

1. SVG 的 `stroke` / `fill` 是**写死的浅色 hex**（`_theme/default.style.json` 在排版时插进去
   的：`#CCD3DB`、`#F8F9FA`…），而画布底色跟着主题翻成 `#141416`；
2. 模板切主题的 JS **无条件**把 `#flow-svg-light` 藏起来、显示 `#flow-svg-dark`——而这一版
   walkmap 没有深色 SVG（没有 `svg_dark`）：浅色那份被藏起来、深色那份不存在 = **一片空白**。

**现在颜色怎么接。** 一份 SVG，颜色全部写成 `var(--fw-<键>)`：

- 生成时（`src/core/uemaster/flow.ts`）：读 `_theme/default.style.json`，把每个**颜色值**换成
  `var(--fw-<键>)`（`stroke_process` → `--fw-stroke-process`，下划线换连字符，与 `render_svg`
  里的 `st[...]` 一眼对得上），再作为 `--style` 传给排版器；非颜色键（`font_family` / `fs_*`）
  原样保留（`--style` 会整个替换默认主题，只传颜色会让字体悄悄退回引擎内置那个）。读不到主题
  文件就不传 `--style`，并在 `warnings` 里留一句——降级不静默。
- 模板（`vendor/uemaster/flow-walkthrough/templates/walkthrough.html`）：`--fw-*` 两套值。
  浅色逐条等于 `default.style.json`（**修 bug 不顺手改浅色样子**），深色逐条来自
  `_theme/dark.style.json`。覆盖：节点框（process）、判断菱形、后端节点、边（含箭头 marker）、
  边标签、选中环、缺口/评审标记。
- 切主题 JS：本地改动一律**只加不改**（这个模板要与上游逐字节一致，`tests/walkmap.test.ts`
  会剥掉本地补丁再比一次），所以用一段**追加的覆盖**包一层：只有真存在深色那份时才切显隐，
  否则永远显示那一张（它自己会跟着变量换色）。
- `build.py` 的图例：原来按 hex 认标记色（`#c0392b` 那几个），而成品 SVG 从来不是那几个 hex
  （是主题里的 `#B4232B`）——**图例其实一直没出来过**。现在按**变量名**认
  （`--fw-stroke-p0` …），小方块也用 `var(...)` 画、跟着主题换色；hex 留作老产物的兜底。

**验证方式**（不开浏览器，owner 自己点）：`tests/dark-flow-svg.test.ts` 7 条。真排一张带菱形 /
后端节点 / 边标签 / 缺口标记的图，断言 `fill`、`stroke` 里**一个 hex 都没有**；断言每个被用到的
`--fw-*` 在 `:root` 与 `[data-theme="dark"]` 里**都有值且两值不同**（这条直接对应「切过去看不见」
这个症状）；再真跑一份 walkmap → `build.py` → 单文件 HTML，断言产物内联了两套变量、图例出现且
方块走变量。三条 mutation 真跑过（颜色不转变量 → 5 条红；两套主题写成同色 → 2 条红；覆盖块里
删掉「只有一份时保持可见」→ 1 条红）。

**存量产物不动**：它们是当时评审依据过的字节。重新生成一次即得到走变量的那张。

## 六、计数与状态

- `npx vitest run`：**101 个文件全绿，1925 条（1922 passed + 3 skipped）**。本轮新增
  **56 条 / 6 个文件**：凭据 7、初始密码 9、文案守卫 3、企微绑定 21、企微绑定界面 9、
  深色流程图 7。
- `npx tsc --noEmit` 干净；`npm run build` 通过（7 条路由，与前几轮一致）。
- `requirements` 活行 **814 → 814**（没有 reseed；只跑了迁移 0037 / 0038）。
- `members` **7 行**全部落到统一初始密码；`wecom_webhook` 列空（没有人设过）。
- 五条都**没有**动 v1 的范围、状态门、三栏结构与材料内容规则：改的是凭据接线、数据默认值、
  用户可见的叫法、两处缺失的入口、以及 SVG 的取色方式。

## 七、这一轮留下的坑（照实写）

1. **只有 dsh 这一条 CLI 认我们的 key**。`claude` / `codex` 走的是它们自己的登录态，provider
   的 key 帮不上——所以「配了 key 就能让任何 CLI 通过测试」这件事仍然不成立。`CREDENTIAL_ENV`
   是那张表唯一的位置，将来要加一条就在那里加（别在调用处再写一遍变量名）。
2. **不转发 `baseUrl` 是有代价的**：如果哪天 owner 把 `provider.baseUrl` 换成一个
   Messages 兼容的网关，dsh 那条路仍然会打官方地址。那时要补的是「按协议判一次再决定转发」，
   而不是无条件转发。
3. **统一初始密码降低了单人强度**：它是内网 + 小团队的取舍，靠「登录后可自己改」兜底。界面上
   写了改的入口，但**没有任何东西强制改**（第一次登录不弹「请改密码」）。这是刻意的：加那道
   门会挡住在演示里点来点去的人，而 owner 要的正是「进去看」。
4. **webhook 的 key 是明文存的**（`members.wecom_webhook`）。它是「能往群里发消息」的凭证，
   与 `provider.apiKey` 一样只有服务端读、只回显末 4 位；但库被拿走就等于群被打开——这一版
   没有做加密存储（那要引入密钥管理，超出这一轮）。
5. **存量材料仍然是 hex 取色的那张图**：深色下的修复只对**新生成**的产物成立。已生成的那 26
   行要做一次重新生成才会变好看，而「重新生成」会新增一版产物——所以没替 owner 做。
6. **企微绑定的验证依赖 `wecom-cli`**：没装 / 没授权的机器上，「验证」给出的是一句
   `wecom-cli` 的话（原样），而不是「你先把 CLI 装上」的引导。那条引导现在只在推送自检的事件里。
