# 材料正文说产品话，代码坐标降级成脚注（2026-11-09）

**一句话**：材料切成两层——**正文用产品语言**（功能线/商业线负责人与 PM 读得下去），
**末尾一小节「研发参考」放坐标**（`仓:路径:行号 符号` + 受影响文件数）。分层**不是提示词请求，
是代码写的**：正文里出现 `x.go:382` 或反引号标识符，就由 `relocateHtmlBody` 删掉那一句、
把它搬进脚注。顺带修 Go 解析器两个噪音源：`vendor/` 等目录不进索引、`Code generated … DO NOT EDIT.`
的文件整类跳过并**记账**（`apisrv` 583 → 352 indexed + 231 skipped-generated，`UserVip` 消失）。

分支 `main`，起点 `dcb33c3`。`npx vitest run` 78 个文件 / 1625 条全绿（1 条 skip）；
`npx tsc --noEmit` 干净；`npm run build` 通过。`requirements` 814 行没动；
`config/repos.txt` 里另一个任务加的 31 行**原样留在工作区、没有进这次提交**。

---

## 0. owner 退回来的那一句

> 落点是 `service/cdn_link.go:382` 的 `(*cdnLink).getUserCustomDomainIsShortLink` 私有方法，
> 改动面在 `service/cdn_link.go` 及其调用方，不在 `component/`

他的原话：「这种好像也不对吧 得是产品语言吧」。这句话本身**没有错**——它甚至很准确。
错的是它出现的位置：读者是功能线/商业线负责人与 PM，他们在第一行就翻页了。
**坐标是证据，不是结论。**

同一句话的产品语言版本（现在写进提示词当正例）：

> 这条需求改的是「自定义域名备案失效」的判定规则：系统现在能判断某个自定义域名是否已备案，
> 缺的是失效后主动告警。不涉及界面，用户侧看不到变化。

---

## 1. 两层规矩（写在哪、为什么写在那）

| 层 | 位置 | 内容 | 谁写 |
| --- | --- | --- | --- |
| 正文 | 材料中段（页面片段、标注、问题清单、结论句） | 产品语言：产品的哪一部分变了、用户看到什么，用需求自己的词 | 模型（受提示词约束）+ 兜底剥离 |
| 脚注 | 材料**最末尾**一小节「研发参考」，小字号、虚线分隔 | `仓:路径:行号 符号` 一行一个 + `受影响文件：N 个` | **代码**（模型不参与） |

实现位置：

- `src/core/locate/copy.ts` —— 措辞唯一来源：`PRODUCT_BODY_RULE`（提示词片段）、
  `PRODUCT_BODY_EXAMPLE` / `PRODUCT_BODY_ANTI_EXAMPLE`（正例/反例）、
  `REFERENCE_TITLE`、`CodeRef`、`referenceLine`、`referenceLines`。
- `src/core/locate/reference.ts` —— `referenceHtml` / `injectReference`：插在 `</body>` 之前，
  空清单**整节不写**（返回原 HTML），有内容却没有 `</body>` **抛**（静默跳过 = 这一节悄悄消失）。
- `src/core/uemaster/body-language.ts` —— 机器检查与「删+搬」。
- 三份材料的提示词都带 `PRODUCT_BODY_RULE`：`fragmentsPrompt`（评估/评审页面片段）、
  `findingsPrompt`（评审问题清单）、`structurePrompt` + `verifyPrompt`（走查）；
  修一轮的 repair 提示词也各带一份（接口无状态，模型看不到上一轮的输入）。
  图的提示词（`flowPrompt`）只带一句禁令：节点文案 ≤12 汉字，塞不下正例。

三条不能动的旧纪律（这次一个字都没改）：

1. **三种结论的措辞**（读不到 / 没找到 / 最可能的位置（待确认））是**证据的陈述**，
   与坐标无关，`copy.ts` 那几句原样保留；
2. 没有可引的坐标就**整节不写**，绝不写「研发参考：无」（与「同类先例」「最近改动」同一条）；
3. 横幅（结论 + 代码快照 + 最近改动 + 候选清单）仍由代码插在**最前面**——候选清单里带路径
   是给 PM 拿去催研发的线索，不是正文（见 §6 的「还漏什么」）。

---

## 2. 机器检查，以及它在违规时到底做什么

**触发形状**（`findProseLeaks`，纯函数）：`路径:行号`（`service/cdn_link.go:382`）、
带目录的路径（`src/pages/Share/Share.tsx`，要求至少一个 `/`）、反引号包起来的标识符
（`` `getUserCustomDomainIsShortLink` ``）。

**失败模式：删 + 搬（不是「退回重试一次」）。** 判成违规的**子句**从正文删掉，原句进末尾
「研发参考」。选它的三条理由：

1. **重试是另一种提示词**。泄漏是表达问题、不是内容问题；再问一次模型，换来往往还是同一句
   （它不觉得自己写错了），却要多花一次 90 秒的调用——而这次要修的正是「提示词靠不住」；
2. **不能因为一句坐标把材料扣下**。本仓已经吃够「整份不出」的苦；坐标泄漏比「没读到代码」
   轻得多：读者少一句话，不是少一份材料；
3. **信息零损失**。owner 给的出口就是「降级成脚注」——搬正好是这个动作：正文少一句研发黑话，
   脚注多一行证据。

代价（写在这里，不装作没有）：删的是**整个子句**，偶尔会多删一点；剩下的格子若不足
`MIN_REMAIN = 4` 个汉字（整格都是坐标），返回空串，调用方丢整格，而不是塞一句残句。
子句分界只认**全角** `（`：反引号里的标识符可能带半角括号
（`(*cdnLink).getUserCustomDomainIsShortLink`），在半角括号前断开会把它劈成两半，
后半截没有路径特征、于是**留在正文里**——比不删更糟（变异 M8 钉的就是这个）。

**入口在哪**（三份材料各一处，都在 `build.py` 产物写盘之前）：

```
relocateHtmlBody(built.html, moved)   // 只动 >…< 之间的文本节点，属性一个字节都不改
  → injectBanner(...)                 // 顶部：结论 + 快照 + 最近改动 + 候选
  → injectReference(..., referenceLines(refs, moved))
```

评估（`compose.ts`）**只剥不搬**：那条路不读代码，被剥掉的路径全是模型的想象，
把想象写成「研发参考」比正文留一句黑话坏得多；因此评估材料通常没有这一节。

**我们自己那一处**：`review.ts` 的 `findingsAnno` 原来往右栏写
`（现在：${finding.code.path}）` —— 唯一一处由**代码**（不是模型）往正文塞路径的地方，
已在代码里删掉（变异 M10 把这个写法加回去，用例立刻红）。

---

## 3. 提示词现在带的那个例子（逐字）

```
【正文必须是产品语言】这份材料的读者是功能线/商业线负责人与 PM，他们会跳过任何一句
「文件路径 + 函数名」。所以分两层写：
  · **正文**（结论、差异说明、标注、页面文案）用产品语言：说清「产品的哪一部分变了、
    用户会看到什么」，用这条需求自己的词（功能名、页面名、状态名）。
  · 正文里**不许**出现：文件路径（`service/x.go`、`src/pages/a.tsx`）、函数或方法名、
    行号（`xxx.go:382`），也不许用反引号把这类标识符包起来。
  · 代码坐标是**证据**，不是结论：它们由系统自动放进材料末尾的「研发参考」小节，
    你不要在正文里写，写了会被机器删掉。
  · 这条规则**不改变结论本身**：「代码没读到 / 没找到 / 最可能的位置（待确认）」这三种
    说法照旧（它们说的是证据够不够，与坐标无关）。
正例（照这个语气写）：
  这条需求改的是「自定义域名备案失效」的判定规则：系统现在能判断某个自定义域名是否已备案，
  缺的是失效后主动告警。不涉及界面，用户侧看不到变化。
反例（这句话会被机器拦掉，别写）：
  落点是 `service/cdn_link.go:382` 的 `(*cdnLink).getUserCustomDomainIsShortLink` 私有方法，
  改动面在 `service/cdn_link.go` 及其调用方，不在 `component/`
```

---

## 4. 两份真实材料（真跑，不是构造的）

### 4.1 走查：PAN-820「分享页未登录下载——实验 C『仅会员』PRD」

`npx tsx` 起 `startGeneration(stage='inspect')` → 114 秒、3 次调用（locate 31s / verify 75s /
build 0.2s），一次过。产物 `PAN-820/inspect.html`（35 KB）。

正文（右栏标注，逐字，两节点节选）：

> **一致**：分享页已承载未登录下载发起入口，页面展示分享文件和下载操作。
> **缺失**：PRD 要求展示仅会员收银台，但代码中未登录下载先进入登录页，没有出现仅会员收银台。

末尾「研发参考」（逐字）：

```
研发参考
123pan-uni-app:src/pages/share/share.vue
123pan-pc:src/services/login/index.ts
123pan-uni-app:src/services/download-risk-modal.ts
123pan-uni-app:src/pages/doc/vip.vue
123pan-uni-app:src/pages/doc/renew.vue
123pan-uni-app:src/services/login/index.ts
受影响文件：6 个
```

### 4.2 评审：PAN-800「【发票】换开次数限制」

166 秒、5 次调用（flow 47s / locate 3s **失败**→回落 / findings 69s / pages 37s / build 0.1s）。
locate 那一次是关键词扩展模型把预算用在思考上（`max_tokens=400`，答案 0 字），走的是既有的
回落路径——不是这次改的东西，但它出现在这条链上，记在这里。
产物 `PAN-800/review.html`（39 KB）。

正文（右栏标注，逐字，两节点节选）：

> **歧义**：「输入的内容必须大于5个字符（新增需求：改成4字符），不满足时提示"请输入完整的公司名称"」
> ——同一条规则里同时出现「大于5个字符」和「改成4字符」，且「大于4」是否含4没定，开发和测试会得到两种结果。
> **缺验收口径**：「此时需提醒用户仅可换开1次。」——只说要提醒，没写提醒出现在哪一屏、是弹窗还是按钮置灰、
> 文案是什么，做到什么程度算通过无法判断。

末尾「研发参考」（逐字；这一份**带行号与符号**）：

```
研发参考
123pan-uni-app:src/services/vip/index.ts:40 fetchVipGoods
123pan-pc:src/services/video/index.ts:14 getVideoUrlV2
受影响文件：2 个
```

### 4.3 有没有路径/函数名漏进正文

**没有**：两份材料的正文（`build.py` 产物里的文本节点）逐条扫过
`x.go:382` / `带目录路径` / `反引号标识符` 三种形状，命中 0 条。
两份材料里 `relocateHtmlBody` **没有触发过**（脚注里没有任何「无仓名的裸坐标」，而那种行只会
由 `moved` 产生）。也就是说这一轮的模型自己就照做了——这**不能**证明检查有用，
检查的用处由 §5 的变异 M10 / M12 钉住（把旧写法改回去，用例立刻红）。

---

## 5. 变异验证（每一行都是一次真跑：改一行 → 看哪条用例红 → 还原）

| # | 改坏的代码 | 变红的用例（文件 › 用例） |
| --- | --- | --- |
| M1 | `mirror.ts` 的 `NOISE_DIRS` 删掉 `'vendor'` | `codemirror.test.ts` › `vendor / third_party / testdata 算噪音` |
| M2 | `code-index.ts` 的 `GENERATED_HEADER` 改成永不匹配 | `index-generated.test.ts` › `第一行就是标准头`、`build tag 之后也认` |
| M3 | `index-store.ts` 的 `buildIndex` 删掉跳过分支 | `index-generated.test.ts` › `` `UserVip` 这个生成结构体不在 outline 里 `` |
| M4 | `index-store.ts` 的 `assembleFor` 删掉跳过分支 | `index-generated.test.ts` › `生产读路径也跳过生成文件` |
| M5 | `repo-coverage.ts` 的 `filesSkippedGenerated` 写成常量 0 | `repo-coverage.test.ts` › `生成代码的跳过数原样带出来` |
| M6 | `copy.ts` 的 `PRODUCT_BODY_RULE` 删掉正例行 | `product-language.test.ts` › `规矩里同时有正例与反例`、`页面片段提示词带正例` |
| M7 | `body-language.ts` 的 `BACKTICK` 改成永不匹配 | `product-language.test.ts` › `三种写法都算违规` |
| M8 | `CLAUSE_SPLIT` 退回「半角 `(` 也断开」 | `product-language.test.ts` › `owner 那一句整段被删掉` |
| M9 | `referenceLines` 的 `paths.size` 改成 `lines.length` | `product-language.test.ts` › `末尾给受影响文件数（按路径数）` |
| M10 | `findingsAnno` 把 `（现在：路径）` 加回正文 | `product-language.test.ts` › `带 code 的那三类条目，右栏只有「引文 + 为什么」` |
| M11 | `injectReference` 删掉「空清单原样返回」 | `product-language.test.ts` › `空清单 → 原样返回` |
| M12 | `relocateHtmlBody` 改成空操作 | `product-language.test.ts` › `正文里的坐标被删掉、属性里的路径保留` |
| M13 | `verifyPrompt` 去掉 `PRODUCT_BODY_RULE` | `product-language.test.ts` › `走查的两个提示词都带正例` |

13 条全红。第一轮有两条是绿的（M4、M5）——那是**用例太弱**，不是代码没问题：

- M4：`assembleFor` 那条用例当时**没被文件收录**（一次编辑把 describe 块截掉了，只跑了 5 条），
  补回来后 M4 立刻变红；
- M5：那条用例断言的正是 `0`（fakeIndex 的 `skippedGenerated: 0`），改坏成常量 0 当然还是绿的。
  补了一条 `skippedGenerated: 231` 的用例（`apisrv` 的真实数），M5 才变红。

---

## 6. Part B：Go 解析器两个噪音源

### 6.1 `vendor/` 等目录（`src/core/codemirror/mirror.ts` 的 `NOISE_DIRS`）

加三条，判据与 `_test.go` 一致——**这个文件是不是产品的一部分**：

| 目录 | 为什么是噪音 |
| --- | --- |
| `vendor/` | `go mod vendor` 的产物，**别人的代码**。一仓能到几万条；混进 outline 之后材料会把 gin/gorm/grpc 的实现说成「产品已有这个能力」。Go 的 vendoring 按**模块**，多模块仓里 `cmd/x/vendor/` 也存在，所以按「任意一段目录名」判 |
| `third_party/` | Bazel 风格的第三方源码目录（不叫 vendor，装的东西一模一样） |
| `testdata/` | Go 工具链**约定**的测试数据目录，`go build` 与 `go vet` 都跳过它；里面是夹具（很多还是故意写坏的用例输入） |

判定只看**非最后一段**，所以 `service/vendored.go`、`service/testdata.go`、
`library/vendorinfo/vendor.go` 都不受影响（两条反向用例钉住）。

### 6.2 生成代码（`code-index.ts` 的 `isGeneratedSource`）

只认**文件自己那一句话**：前 5 行里出现 `//`（或 `/*`）+ `Code generated … DO NOT EDIT.`
（Go 官方口径 `^// Code generated .* DO NOT EDIT\.$`，实测都在 `package` 上一行；
build tag 之后也认）。**不按路径判**：`model/` `dao/` 里也有手写文件，按目录剔会把真产品代码丢掉。

两个建索引的入口都跳过它：`buildIndex`（纯函数、`--dry-run`）与 `assembleFor`（生产读路径）。
跳过的**数量按路径数**记在 `CodeIndex.skippedGenerated` 上，一路带到覆盖率表：

- `src/db/migrations/0034_repo_coverage_generated.sql`：`repo_coverage.files_skipped_generated`
  （`not null default 0`；0 在这个仓是真值，与 `files_indexed` 同语义）；
- `coverageCounts()` 原样带出它；`scripts/onboard-repos.ts` 的表现在多一列
  「跳过生成 N」（只在非 0 时出现）。

于是覆盖率表的算式变成 `indexed 352 + skipped-generated 231 = 583`，
不再是「583 里只进了 352，谁去查解析器」。

### 6.3 `apisrv` before / after（实测，`HEAD 199cd433`）

| | indexed | outline 文件 | import 边 | `skipped-generated` | `UserVip` 在 outline | `*user_vip*` 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| before（旧解析结果） | **583** | 561 | 0 | 0 | **在**（`go-struct`，第 12 行） | 3 |
| after（跳过生成代码） | **352** | 330 | 0 | **231** | **不在** | 1 |

- 树的数字没变：`tree_files 624`、`tree_indexable 583`（`files_total` 与 before/after 无关）。
- **`UserVip` 从 outline 里消失（yes）**：那 231 个生成文件里含 `model/entity`、
  `model/internal` 那些表的镜像。
- 唯一剩下的 `*user_vip*` 是 `app/dao/user_vip.go` ——**手写的 dao**，outline 里是
  `userVipDao` / `userVipDao.IsVIP`。这正是想要的边界：生成的 `UserVip` 结构体走，
  真正的产品逻辑留。
- 同时写入了 `repo_coverage` 一行：
  `files_total 624 / files_indexed 352 / files_skipped_generated 231 / outline_files 330 / imports 0`。

**过渡代价（必须说清）**：`blob_index` 是内容地址，`on conflict do nothing` 意味着
**这次之前解析过的块不会重新判定**。所以我先 `forgetBlobs(apisrv 的 583 块)` 再装配一次
（那 583 行是跨仓共享的，其它仓下次装配会自己重解析，只是多花一次读）。**已经同步过的仓
要拿准这个数，都得整表重算一次**（`--rebuild` / `forgetBlobs`）——79 个仓批量接入时是首次同步，
不受影响。

---

## 7. 还漏什么（具体，不含「未来可优化」）

1. **走查的「研发参考」只有 `仓:路径`，没有行号与符号**。走查这条路不建结构索引（`structureOf`
   只取 HEAD / 树 / 形状，那里的注释解释了为什么删掉 `repoIndex`），拿不到 `outline.line`。
   评审那条路有索引，所以它有行号与符号（见 §4.2）。要补：把 `repoIndex` 接回 `InspectDeps`
   ——代价 0.5–1 秒 × 仓/次（走查一次 114 秒，这点钱不多），但那是接口与用例的改动，
   这次没做。
2. **裸文件名不拦**：`Share.tsx`（没有目录）不算违规。收益小（可能与「功能名恰好等于文件名」
   的短语打架），代价是「材料里写 `cdn_link.go` 这种只在本仓唯一的文件名」会漏。
3. **反引号一律算违规**：正文里写 `` `wt-btn` `` 这种**页面组件类名**也会被删——它严格来说
   不是文件路径，但对 PM 同样是黑话，所以判成违规、搬到脚注。若以后要放行，得给一类白名单。
4. **`moved` 里的坐标不进「受影响文件」计数**：它们可能缺仓名（模型写 `service/x.go:382`），
   拿半个坐标去数文件会数出一个偏小的数，而那个数会被当结论。所以只列、不数。
5. **横幅仍然带路径**：材料顶部「最可能的位置（待研发确认）：1. `app/index.ts` ← …」是
   `CANDIDATES_LINE` 的既有措辞（owner 定的三种结论之一），这次**没动**。它不是正文，
   但读者第一眼会看到它——要不要也改成产品语言，是一个产品决定，不是这次的范围。
6. **生成代码的识别只认标准头**：`*.pb.go` / mockgen 都带头（覆盖）；**没头的**（老 protoc、
   手工粘贴的生成物、GoFrame 早期版本）仍然会进索引。这批文件在 `apisrv` 上一次都没撞到，
   但 79 个仓里不保证。
7. **`vendor/` 的排除是「目录名」级**：仓里若真有一等公民目录叫 `vendor`（不装依赖、装产品代码），
   它会被一起丢掉。三个前端仓 + `apisrv` 都没有这种形状。

---

## 8. 会话约束的执行记录

- **没跑 `git clean` / `git checkout -- .`**；`next-env.d.ts` 被 `npm run build` 改过，
  用 `git show HEAD:next-env.d.ts >` 还原（不是 checkout）。
- `config/repos.txt` 的 31 行（另一个任务的第二批前端仓）**原样留在工作区**，没进这次提交。
- `requirements` 814 行没动、没 reseed；没碰 `locate` 评分、通知逻辑、既有迁移文件。
- 新依赖：0。
- 临时脚本在 `.tmpwork/`（未跟踪，不在提交里）。
