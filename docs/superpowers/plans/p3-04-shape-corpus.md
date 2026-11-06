# P3.04 — 形状漂移语料：一次调用把所有「写歪的方式」都逼出来

> 一句话：**把「一次真实生成四分钟、zod 只报第一条」换成「几分钱、一次看全全部漂移」**。
> 这个脚本不修解析器、不改 schema，只做一件事——把模型真实会写的每一种形状收集下来，
> 让「容错该长什么样」从猜变成读表。

- 代码：`scripts/shape-corpus.ts`（新，永久工具；每接一个新模型跑一次）
- 只读依赖：`src/core/uemaster/compose.ts` / `inspect.ts` / `shape.ts` / `provider.ts`
  （只 import，不修改任何行为；三个 schema 本来就是导出的）
- 分支：`main`；dev server 仍在 `:3000`（`next dev --webpack`），跑批不碰它
- 语料：`/tmp/shape-corpus/<timestamp>/{report.json,report.md,raw/*.json}`

---

## 1. 为什么要有这个跑批

三次真实跑批，三次倒在**不同**模型的形状上，一次一倒：

| 段 | 模型干了什么 | 我们要的形状 |
| --- | --- | --- |
| evidence | `["repo:path"]`（字符串数组） | `[{repo,path,note}]` |
| evidence | `{file:"repo:path", note}` | `{repo,path,note}` |
| anno | `["一致","说明"]`（扁平一对） | `[["一致","说明"]]` |
| frame | `"分享页浏览"`（中文散文） | `"phone" \| "wide"` |
| searched | `"关键词"`（字符串） | `["关键词"]` |
| verdict | `"missing/缺失"` | 四选一枚举 |
| root | 顶层数组 | `{flows,findings}` |

每一次都是**同一个循环**：跑一次 → 四分钟 → `readStructure` 只说一句
`JSON 结构不对 —— findings.0.evidence.0：Expected object, received string` → 改一处 →
再跑四分钟 → 撞下一条。七种形状，理论上要七轮；实际还不止——**修好一处会露出下一处**
（这一批就验证了：`evidence` 收了之后，那 5 条原本被别的错挡住的结论，立刻撞上
「路径不存在」，因为容错把「、」拼的多路径当成了一条路径）。

根因不是模型，是**报错口径**：`Schema.safeParse` 一次就给了**全部** issue，应用只取
`issues[0]` 报给用户（对用户是对的：一次改一处；对研发是灾难：一次只看见一处）。
`scripts/shape-corpus.ts` 就是把这个盲区补上：**一次调用，全量 issue**。

## 2. 跑批器怎么工作

```
计划(--requirements/--stages/--models/--repeat/--concurrency)
   │
   ├─ 第一段：flow（评估/评审）· structure（走查）
   │    ├─ 提示词 = flowPrompt() / structurePrompt()      ← 应用那一份，不抄
   │    ├─ 调用     = complete()                          ← 绕开 inspect()/composeEvaluation()
   │    ├─ 落盘     = raw/<model>-<stage>-<req>-<rep>-<phase>.json   ← 先落盘，再解析
   │    └─ 解析     = readStructure()/readFragments()  + 自己跑一遍 Schema.safeParse 收全量 issue
   │
   └─ 第二段：pages（评估/评审）· verify（走查）
        ├─ 参考产物 = 同需求下第一段**第一条通过**的结论/节点（同需求共用一份，漂移才可比）
        ├─ 提示词 = fragmentsPrompt(nodes) / verifyPrompt(flows,findings,excerpts)
        └─ 深读正文 = citationsOf() + show()（与 inspect.ts 的 deepRead 同口径、同 40k 预算）
```

五条设计约束，每条都对着「收集证据」而不是「修东西」：

1. **不走 `inspect()` / `composeEvaluation()`**。那两个是「一次生成」的事务：任何一段
   不过就抛，第一批调用废掉后面全部样本。这里一次调用一条记录，谁也不连累谁。
2. **提示词与解析都用应用的那一份**。抄一份提示词出来测，测的就是抄件的漂移了；
   `readStructure` / `readVerify` / `readFragments` 也一样——测的是**今天会上线的**那条路。
3. **全量 zod issue**：`StructureSchema` / `VerifySchema` / `FragmentsSchema` 自己
   `safeParse` 一次，`issues` 全收（三个 schema 本来就是 `export` 的，没有为跑批改过）。
4. **回话先落盘**：`writeRaw()` 在解析**之前**跑。批次被杀、进程崩、网关断，语料都还在
   （这一批真被整库清空打断过一次，见 §8）。
5. **限流 + 超时 + 两处退让**：并发 `--concurrency`；单次 7 分钟（`AbortSignal.timeout`）；
   传输层抖动（`terminated` / 5xx / 超时）重试一次；**「思考吃光预算」**（`provider.ts`
   那句「思考 N 字、答案 0 字」）把预算抬到四倍再问一次——形状样本不能因为预算不够丢掉，
   但「4k 不够」这件事要记进格子（`budgetBump`）。

记录一格一条（`report.json.cells[]`）：

```
{ model, stage, phase, requirement, rep,
  ok,                 // 应用那条路收下了吗
  why,                // 应用会说的那一句（通过时为空）
  issues[],           // 原样 zod 的全部 issue（不是 issues[0]）
  problems[],         // 解析过了但语义不过（路径不存在、flows 数量…）
  walkmap[],          // 页面片段过了 readFragments、但 walkmap 契约不过（内容层，另算）
  drift[],            // 从原始回话里认出的形状漂移（key/label/expect/原文片段）
  sig,                // 形状指纹：同 sig = 歪的是同一处
  promptChars, replyChars, excerpt, ms, attempts, maxTokens, budgetBump, usage, error, skipped }
```

`drift` 是这份语料真正的产物：它不靠 `zod` 判，而是**按值**看原始回话
（`"repo:path"` 是字符串还是对象、`anno` 少没少一层、`frame` 是不是中文）——
`zod` 只会说 `Expected object`，说不出模型把 `{repo,path}` 写成了什么。

## 3. 怎么跑

```bash
# 全量：10 条需求里取 5 条 × 3 个阶段 × 2 个模型 × 3 次重复
npx tsx scripts/shape-corpus.ts \
  --requirements 1,2,6,7,10 --stages evaluate,review,inspect \
  --models deepseek-flash,deepseek-v4-pro --repeat 3 --concurrency 6

# 小样本试水（一次 6 个调用，四分钟）
npx tsx scripts/shape-corpus.ts \
  --requirements 6 --stages evaluate,review,inspect --models deepseek-flash --repeat 1

# 只重出报告（不再花一次调用；派生块从 cells 重算，不会出现半旧半新的表）
npx tsx scripts/shape-corpus.ts --report-only /tmp/shape-corpus/<timestamp>

# 用**当前的漂移扫描器**重算已有语料（扫描器会演进：这一批跑完才认出
# 「一条字符串拼多个路径」「截断」要单列，`--rescan` 不必再花一轮调用）
npx tsx scripts/shape-corpus.ts --rescan /tmp/shape-corpus/<timestamp>
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--requirements` | 必填 | 需求的 `number`（PAN-N 的 N） |
| `--stages` | 必填 | `evaluate` / `review` / `inspect` |
| `--models` | 必填 | 网关上的模型名，逐个覆盖 `provider.model` |
| `--repeat` | 3 | 每格重复次数（漂移不定，1-in-3 的形状要 3 个样本才看得见） |
| `--concurrency` | 4 | 同时在飞的调用数 |
| `--timeout` | 420000 | 单次超时（毫秒）；应用现在就是 7 分钟 |
| `--out` | `/tmp/shape-corpus` | 语料根目录 |

预算（`BUDGET`）：`flow 4_000` / `pages 14_000` / `structure 32_000` / `verify 64_000`，
与 `compose.ts` / `inspect.ts` 的常量同值；思考吃光时 ×4（上限 65_536）。

**为什么 `inspect` 只跑 PAN-6**：结构段的提示词里要 PRD 正文。库里只有 PAN-6 有快照和
真地址（企业微信文档），其余四条是 `https://docs.123pan.example/prd/PAN-N` 假地址、
没有快照——`readPrd` 必然失败。这四条在 `evaluate` / `review` 里照样能跑（那两段的
提示词只用需求标题，不用 PRD 正文），`inspect` 则整格记 `skipped`，不烧调用。

## 4. 分类表：这一批真的撞到了什么

| 阶段 | 段 | 现象 | 模型原文片段 | 出现次数 | 我们的期望 |
| --- | --- | --- | --- | --- | --- |
| evaluate | flow | 一行里串了多段连线（`A --> B --> C`） | `A --> B --> C` | 1 | 一条连线一行；分叉从判断节点单独出发 |
| evaluate | pages | 根对象多出键 ["id","kind","frame","title","html","anno"] | `["id","kind","frame","title","html","anno"]` | 6 | 只有 nodes |
| evaluate | pages | 根对象没有 `nodes` | `["id","kind","frame","title","html","anno"]` | 6 | `nodes: [{id,kind,title,frame,html,anno}]` |
| evaluate | pages | 回话被输出预算截断（completion 顶到 max_tokens） | `completion=14000 / max_tokens=14000` | 6 | 回话完整闭合；或把这一段的 max_tokens 调大 |
| inspect | verify | `evidence` 不是数组（是 string） | `123pan-uni-app:src/components/search-entrance/search-entrance.vue、123pan-uni-app:src/pages/search/search.vue` | 72 | `evidence: [{repo,path,note}]` |
| inspect | verify | `evidence` 是一整条 `"repo:path"` 字符串（不是数组） | `123pan-uni-app:src/components/search-entrance/search-entrance.vue、123pan-uni-app:src/pages/search/search.vue` | 68 | `evidence: [{repo, path, note}]` |
| inspect | verify | `searched` 不是数组（是 boolean） | `true` | 48 | `searched: ["搜过的关键词"]` |
| inspect | verify | `evidence` 一条字符串里用「、」拼了 2 个 `repo:path` | `123pan-uni-app:src/components/search-entrance/search-entrance.vue、123pan-uni-app:src/pages/search/search.vue` | 30 | 一个文件一条 evidence（扶正时按「、」拆开） |
| inspect | verify | `verdict` 写了枚举之外的值："missing/缺失" | `{"verdict":"missing/缺失","prd":"PRD 要求 App/H5 有效分享页工具栏新增搜索入口。"}` | 30 | implemented / missing / extra / differs 之一 |
| inspect | verify | `verdict` 写了枚举之外的值："partial/部分实现" | `{"verdict":"partial/部分实现","prd":"PRD 要求 App/H5 分享页工具栏新增搜索入口。"}` | 11 | implemented / missing / extra / differs 之一 |
| inspect | verify | `verdict` 写了枚举之外的值："implemented/一致" | `{"verdict":"implemented/一致","prd":"PRD 要求点击入口进入独立搜索页面或独立搜索状态，光标置于搜索输入区域。"}` | 10 | implemented / missing / extra / differs 之一 |
| inspect | verify | `verdict` 写了枚举之外的值："[missing/缺失]" | `{"verdict":"[missing/缺失]","prd":"PRD 要求 App/H5 分享页工具栏新增搜索入口"}` | 7 | implemented / missing / extra / differs 之一 |
| inspect | verify | `verdict` 写了枚举之外的值："inconsistent/不一致" | `{"verdict":"inconsistent/不一致","prd":"PRD 要求首批 20 条，触底追加下一批 20 条，不展示分页器。"}` | 6 | implemented / missing / extra / differs 之一 |
| inspect | verify | `evidence` 是一整条裸路径字符串（不是数组） | `未发现；相关文件：123pan-uni-app:src/pages/search/search.vue` | 4 | `evidence: [{repo, path, note}]` |
| inspect | verify | `verdict` 写了枚举之外的值："[implemented/一致]" | `{"verdict":"[implemented/一致]","prd":"PRD 要求点击入口进入独立搜索页面或独立搜索状态"}` | 4 | implemented / missing / extra / differs 之一 |
| inspect | verify | `verdict` 写了枚举之外的值："extra/多余" | `{"verdict":"extra/多余","prd":"PRD #4 明确不提供类型筛选、表头排序或新增移动端排序；原结论“要求底部排序弹窗仅名称/大小/时间及升降序”与正文不符。"}` | 1 | implemented / missing / extra / differs 之一 |
| inspect | verify | `verdict` 写了枚举之外的值："多余/不在范围" | `{"verdict":"多余/不在范围","prd":"PRD 本期明确不新增移动端排序，未要求搜索页底部排序弹窗"}` | 1 | implemented / missing / extra / differs 之一 |
| inspect | verify | `verdict` 写了枚举之外的值："不一致" | `{"verdict":"不一致","prd":"PRD 要求首批 20 条、触底追加且不展示分页器"}` | 1 | implemented / missing / extra / differs 之一 |
| inspect | verify | `verdict` 写了枚举之外的值："[inconsistent/不一致]" | `{"verdict":"[inconsistent/不一致]","prd":"PRD 要求首批 20 条、触底追加且不展示分页器"}` | 1 | implemented / missing / extra / differs 之一 |
| review | flow | 回话被输出预算截断（completion 顶到 max_tokens） | `completion=4000 / max_tokens=4000` | 1 | 回话完整闭合；或把这一段的 max_tokens 调大 |
| review | flow | 一行里串了多段连线（`A --> B --> C`） | `A --> B --> C --> D` | 1 | 一条连线一行；分叉从判断节点单独出发 |
| review | pages | 根对象多出键 ["id","kind","frame","title","html","anno"] | `["id","kind","frame","title","html","anno"]` | 5 | 只有 nodes |
| review | pages | 根对象没有 `nodes` | `["id","kind","frame","title","html","anno"]` | 5 | `nodes: [{id,kind,title,frame,html,anno}]` |
| review | pages | 回话被输出预算截断（completion 顶到 max_tokens） | `completion=14000 / max_tokens=14000` | 5 | 回话完整闭合；或把这一段的 max_tokens 调大 |

## 5. 每格成败

合计：**flow 57/60**、**pages 49/60**、**structure 6/6**、**verify 0/6**（132 次调用，
收下 112、被拒 19、接口层失败 1；24 格 `inspect` 按设计跳过）。

读法：`flow` 那 3 个失败是**引擎/接口层**（2 条一行串多段连线被排版器拒、1 条空回话），
不是形状；`pages` 那 11 个失败**全是 14k 预算截断**；`verify` 6 格全灭，四种原因各占若干。

| 阶段 | 段 | 模型 | 需求 | 通过/调用 | 跳过 |
| --- | --- | --- | --- | --- | --- |
| evaluate | flow | deepseek-flash | PAN-1 | 3/3 | 0 |
| evaluate | flow | deepseek-flash | PAN-2 | 3/3 | 0 |
| evaluate | flow | deepseek-flash | PAN-6 | 3/3 | 0 |
| evaluate | flow | deepseek-flash | PAN-7 | 3/3 | 0 |
| evaluate | flow | deepseek-flash | PAN-10 | 3/3 | 0 |
| evaluate | flow | deepseek-v4-pro | PAN-1 | 2/3 | 0 |
| evaluate | flow | deepseek-v4-pro | PAN-2 | 2/3 | 0 |
| evaluate | flow | deepseek-v4-pro | PAN-6 | 3/3 | 0 |
| evaluate | flow | deepseek-v4-pro | PAN-7 | 3/3 | 0 |
| evaluate | flow | deepseek-v4-pro | PAN-10 | 3/3 | 0 |
| evaluate | pages | deepseek-flash | PAN-1 | 3/3 | 0 |
| evaluate | pages | deepseek-flash | PAN-2 | 3/3 | 0 |
| evaluate | pages | deepseek-flash | PAN-6 | 3/3 | 0 |
| evaluate | pages | deepseek-flash | PAN-7 | 2/3 | 0 |
| evaluate | pages | deepseek-flash | PAN-10 | 2/3 | 0 |
| evaluate | pages | deepseek-v4-pro | PAN-1 | 2/3 | 0 |
| evaluate | pages | deepseek-v4-pro | PAN-2 | 2/3 | 0 |
| evaluate | pages | deepseek-v4-pro | PAN-6 | 2/3 | 0 |
| evaluate | pages | deepseek-v4-pro | PAN-7 | 2/3 | 0 |
| evaluate | pages | deepseek-v4-pro | PAN-10 | 3/3 | 0 |
| review | flow | deepseek-flash | PAN-1 | 3/3 | 0 |
| review | flow | deepseek-flash | PAN-2 | 3/3 | 0 |
| review | flow | deepseek-flash | PAN-6 | 3/3 | 0 |
| review | flow | deepseek-flash | PAN-7 | 3/3 | 0 |
| review | flow | deepseek-flash | PAN-10 | 3/3 | 0 |
| review | flow | deepseek-v4-pro | PAN-1 | 3/3 | 0 |
| review | flow | deepseek-v4-pro | PAN-2 | 3/3 | 0 |
| review | flow | deepseek-v4-pro | PAN-6 | 3/3 | 0 |
| review | flow | deepseek-v4-pro | PAN-7 | 3/3 | 0 |
| review | flow | deepseek-v4-pro | PAN-10 | 2/3 | 0 |
| review | pages | deepseek-flash | PAN-1 | 3/3 | 0 |
| review | pages | deepseek-flash | PAN-2 | 3/3 | 0 |
| review | pages | deepseek-flash | PAN-6 | 3/3 | 0 |
| review | pages | deepseek-flash | PAN-7 | 2/3 | 0 |
| review | pages | deepseek-flash | PAN-10 | 1/3 | 0 |
| review | pages | deepseek-v4-pro | PAN-1 | 2/3 | 0 |
| review | pages | deepseek-v4-pro | PAN-2 | 2/3 | 0 |
| review | pages | deepseek-v4-pro | PAN-6 | 3/3 | 0 |
| review | pages | deepseek-v4-pro | PAN-7 | 3/3 | 0 |
| review | pages | deepseek-v4-pro | PAN-10 | 3/3 | 0 |
| inspect | structure | deepseek-flash | PAN-1 | 0/0 | 3 |
| inspect | structure | deepseek-flash | PAN-2 | 0/0 | 3 |
| inspect | structure | deepseek-flash | PAN-6 | 3/3 | 0 |
| inspect | structure | deepseek-flash | PAN-7 | 0/0 | 3 |
| inspect | structure | deepseek-flash | PAN-10 | 0/0 | 3 |
| inspect | structure | deepseek-v4-pro | PAN-1 | 0/0 | 3 |
| inspect | structure | deepseek-v4-pro | PAN-2 | 0/0 | 3 |
| inspect | structure | deepseek-v4-pro | PAN-6 | 3/3 | 0 |
| inspect | structure | deepseek-v4-pro | PAN-7 | 0/0 | 3 |
| inspect | structure | deepseek-v4-pro | PAN-10 | 0/0 | 3 |
| inspect | verify | deepseek-flash | PAN-6 | 0/3 | 0 |
| inspect | verify | deepseek-v4-pro | PAN-6 | 0/3 | 0 |

## 6. 哪些该收，哪些该拒

判据只有一条：**形状可以收，事实不能收**。但这一批给出了两条比判据更硬的证据：

- **收对了**：`verdict` 的 60 种写法里，只有 11 条是「模型造了第五类」，其余 60 条都是
  同一个判断的别名（`missing/缺失`、`[missing/缺失]`、`inconsistent/不一致`、
  `多余/不在范围`…），现有 `normalizeVerdict` 全收下，判断一条没错。
- **收错了**：`evidence` 是「一条字符串里用「、」拼了 2–3 个 `repo:path`」（30 条）。
  容错把它扶正成**一个** `{repo, path}`，于是 path 变成
  `src/pages/search/search.vue、123pan-uni-app:src/components/…`——一个不存在的路径。
  那一格因此在 `validateStructure` 报「证据路径在仓库里不存在」。**实测核过：模型引的
  6 个文件全都在 123pan-uni-app 的 HEAD 上**（`lsTree` 逐条确认）。是我们的容错把一句
  真话判成了假话——这比「漏收」更贵。

### 6.1 该收（收了不改任何事实判断）

| 观测到的写法 | 条数 | 我们的形状 | 为什么可以收 |
| --- | --- | --- | --- |
| `"missing/缺失"`、`"implemented/一致"`、`"extra/多余"`、`"不一致"`、`"[missing/缺失]"`、`"inconsistent/不一致"` | 60 | 四选一 | 同一个判断的别名（中文、斜杠、方括号、中英混写）；`validateStructure` 仍逐条核证据 |
| `evidence` 是一整条 `"repo:path"` 字符串 | 68 | `[{repo,path,note}]` | 仓库前缀在值里，信息一点没少 |
| `evidence` 是裸路径字符串（`未发现；相关文件：repo:path`） | 4 | 同上 | 同上；单仓时可补仓库 |
| `evidence` 用「、」拼了多个路径 | 30 | **一个文件一条** | 可以收，但必须**拆**：不拆就是把真话判成假话（见上） |
| `searched: "关键词"` | 6 | `["关键词"]` | 一个关键词就是一条 |
| `flow` 一行串 `A --> B --> C` | 2 | 一条边一行 | 拆行就过引擎，判断没变 |

### 6.2 不能收 / 不能只靠容错

| 现象 | 条数 | 为什么 |
| --- | --- | --- |
| `verdict: "partial/部分实现"` | 11 | **不是别名**：四选一里没有「部分」。它最接近 `differs`，但那是产品口径，不该由容错层擅自定——要么加第五类，要么**显式**映射到 `differs` 并写进提示词 |
| `searched: true`（布尔） | 48 | 布尔没有关键词。收成 `[]` 不挡流程，但等于承认「这次没有覆盖面信息」，不能假装有 |
| 证据路径在 HEAD 上不存在 | 1 格 / 9 条 | 必须拒。但这一批那 9 条**是被我们的容错造出来的**（见 6.1 最后一条），修法在容错层，不在校验层 |
| 回话被输出预算截断（`completion == max_tokens`） | 12 格 | 不是形状。截断的外层 JSON 废了，`extractJson` 退到**内层第一个能解析的 `{`**（一个节点对象），报出来是 `nodes：Required`——诊断完全错位。修法是调大 `pages` 的预算 + 让「截断」单独报 |
| `nodes[3].title` 缺失 | 1 格 | 可从提示词里的 flows 清单补（id→title 本来就在提示词里）；补之前它不合格 |
| 接口层空回话（思考 214 字、答案 0 字） | 1 格 | 没有样本可判 |
| `missing` 既无 `searched` 也无「本该在哪」的文件 | 0（未触发） | 读者无法判断搜索覆盖面——「我不知道」伪装成「代码里没有」 |
| 页面节点缺 / 多 | 0（未触发） | 会出现「图上有、结论里没有」的页 |

## 7. 触发不到、因此不能承诺

这一批 132 次调用里**没有复现**的已知形状（`report.md` 的同一节就是这张表）：

- `node.frame-alias`：`frame` 写成中文（上一轮真实跑批的 `"分享页浏览"`）。66 格、两个模型
  都没再写出来——**这条不能在文档里写「已处理」，只能说「容错在，但没有新证据」**。
- `node.anno-flat`：`anno: ["一致","说明"]` 少一层数组。同样没复现。
- `node.anno-object-rows`：`anno` 每项写成对象。
- `node.kind-alias`：`kind` 写中文（`"判断"`）。
- `node.page-no-html`：`kind=page` 却没给 `html`。
- `evidence.object-other-keys`：`{file:"repo:path", note}`。上一轮真实跑批的写法，本批 0 次。
- `finding.missing-no-scope`：`missing` 既没 `searched` 也没指文件。
- `root.array`：顶层是数组。
- `flow.subgraph`：用了 `subgraph` / `classDef`（引擎会拒，本批没出现）。

为什么不能承诺：这些形状都是**非确定性**的（同一提示词三次里有零到一次），
`samples = 66` 只说明「这一批没见到」，不说明「模型不会这么写」。要收紧只能把
`--repeat` 提到 5–8 或换更多模型，代价是线性增长的费用与时长。

另外两处**样本量本身就不够**：`inspect` 只有 PAN-6 能跑（6 格），`verify` 6 格全灭，
所以 `verify` 段的失败分布（3 格 `searched` 布尔、1 格 `partial`、1 格缺 title、1 格多路径）
每一条都只有 1 个样本——够定性，不够定频率。

## 8. 成本与耗时

- 语料目录：`/tmp/shape-corpus/20261107-002144`（`report.md` / `report.json` / `raw/` 132 份原始回话）
- 用时：**47.1 分钟**（并发 6，单次超时 7 分钟）；同样的调用量在应用里串行走是
  「132 × 中位数 44 秒 ≈ 1.6 小时」，而且每条都只报第一个错
- 调用：**132 次**（收下 112 / 被拒 19 / 接口层失败 1），另有 24 格 `inspect` 按设计跳过
- token：prompt **230,162** / completion **1,171,181**（合计 **1.40M**）
- 提速的两个来源：一次调用收**全部** issue（而不是跑七轮各看一条）；原始回话先落盘
  （批次被打断也不丢样本——这一批真被打断过一次）
- 思考吃光预算：**47 格**（36%），全部靠「抬到四倍」救回样本；其中 1 格抬完仍是空回话

## 9. 还粗糙的地方（这一批自己捡到的坑）

1. **`pages` 的 14k 预算不够**：60 格里有 **11 格**（18%）`completion` 顶到 14 000 被截断，
   两个模型都有（v4-pro 7 格、flash 4 格）。加上 `flow` 的 4k 预算被思考吃光
   （47 格：36%），"推理模型 + 旧预算"是这条链路现在最大的**非形状**损耗。
2. **截断被误诊成「结构不对」**：`extractJson` 在外层 JSON 坏掉时会退到**内层第一个能
   解析的 `{`**——对 `{"nodes":[{…}]}` 就是那个节点对象。于是 11 格截断全部报
   `nodes：Required`，`drift` 里也长成 `root.extra-keys` 的样子。看「结构不对」去改提示词
   是白改；真正的动作是**调预算**，或者让解析层先判一次括号配平（`shape.ts` 的
   `looksTruncated` 已经有这个判据，只是还没用在「找到了 JSON 但不是根对象」这一步）。
3. **「一条字符串拼多个路径」的容错是错的**（30 条）：现在会原样当一个路径。要么按
   「、」拆（推荐），要么退回重答——但不能留着一个把真话判成假话的容错。
4. **`searched: true` 没有对应处理**（48 条，全部落在 verify 段）：`coerceFindings`
   只认字符串，布尔原样进 zod。
5. **`verdict` 的第五类**（`partial/部分实现`，11 条）：四选一装不下它。这是产品口径，
   不是容错问题；容错层现在会把它拒掉（正确），但**材料会因此退回重答**——要么加第五类，
   要么在提示词里说清「部分实现也写 differs」。
6. **`inspect` 只覆盖 PAN-6**（其余 4 条没有真 PRD），`verify` 只有 6 格样本。
7. **第二段提示词依赖第一段的参考产物**（同需求取第一条通过的结论/节点）：某模型第一段
   全灭时，它在第二段拿到的是别人的清单——那一格测的是「第二段的形状」，不是它的流程。
8. **`drift` 是结构扫描，不是语义判断**：认得出「少一层数组」「写成中文」，认不出
   「形状对、内容在胡说」。后者只能靠 `validateStructure` 的路径核对 + 人读。
9. **没有跨批次对比**：想看「新模型比上一版好了吗」得自己 diff 两份 `report.json`。
   `--rescan` / `--report-only` 已经保证这两件事都不用再花调用。

## 10. 运维备注（这一批实际发生的事）

- 库被别的进程**整库清空**过两次（`app_settings` 0 行、`requirements` 0 行、
  `prd_snapshots` 0 行）：一次在跑批开始前（第一次启动直接因「未配置模型接口」退出），
  一次在跑批之后。两次都用 `/private/tmp/restore-demo.sh`（`seed --reset` + `provider.*`
  三格 + `code.mirror.*` + PAN-6 的 `prd_url`）恢复，再用 `readPrd()` 重新读一次企业微信
  文档生成快照（19723 字符，两次都与清空前一致）。
- 收尾时又核了一遍：`requirements` 12 条、PAN-6 快照 19723 字符、`provider.baseUrl` /
  `provider.model` / `code.mirror.*` 在位。**跑批结束时库是 seed 过的、接口是配好的。**
- 跑批只**读**库（`requirements` / `prd_snapshots` / `app_settings`），不写、不动 jobs 表、
  不 attach 任何产物。所以它可以在 owner 看着 app 的时候跑。
