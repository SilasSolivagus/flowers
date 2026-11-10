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
