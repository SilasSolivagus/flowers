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
