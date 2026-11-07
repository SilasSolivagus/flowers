# 产物一致性：库里那行还在、盘上那份没了

日期：2026-11-08
分支：`main`（起点 `5001a3b`）
关联：`docs/superpowers/plans/2026-11-07-finish-gaps.md`（预防那一段在这里也写了一份）

---

## 一、事故

`data/uemaster/` 被**子 agent 会话里跑的一次 `git clean -fdx`** 整个删掉，而 Postgres 里
`uemaster_artifacts` 的行还在：

```
DB:    evaluate | /uemaster/PAN-11/evaluate.html | 2026-11-07   ← 行还在
disk:  data/uemaster/  →  不存在                                  ← 文件没了
visit: → 404 「产物不存在」
```

三个并行症状，看起来像三件不相关的事：

1. **抽屉里一条死链**：参考段那一行照旧渲染 `<a href="/uemaster/PAN-11/evaluate.html">`，
   点开是路由的 404。读侧（`listArtifacts` 只读库）与写侧（文件在磁盘上）从来没有对过账。
2. **会话随机失效**：同一刀删掉了 `data/.flowers-session-secret`，下一次请求重新生成一把
   新密钥，所有人手里的 cookie 全部验不过——现象是「登录莫名其妙掉线」。
3. **`git status` 是干净的**：`data/` 被 `.gitignore` 忽略，`-x` 删的是「不在版本控制里的
   东西」，所以删完没有任何提示。

为什么这次特别讨厌：产物**不可重建**。它是某个模型在某一天、照着当时那版描述生成、
经过评审看过的材料；库里只存链接（spec §5），正文从头到尾没有副本。

## 二、读模型：让不一致看得见，而不是变成 404

### 改了什么

`src/core/read/detail.ts` 的 `DetailRef` 多一格 `filePresent: boolean | null`：

| 值 | 含义 | 界面 |
| --- | --- | --- |
| `true` | 站内路径，文件在 | 链接 + 日期（与之前一样） |
| `false` | 站内路径，**文件不在**（被删 / 从没落过盘） | 不画链接，画「文件已丢失，重新生成」 |
| `null` | 站外链接（`http(s)://…`，人能 attach 外链） | 照旧给链接——那不是我们的文件，不判它死活 |

- 判定在 `filePresentOf(url)`：`/uemaster/` 开头的走 `artifactFile()` 折成磁盘路径再 `stat`
  一次；其它一律 `null`。`artifactFile` 的越界/形状错误折成 `false`（那种名字本来就没有文件）。
- 每条需求最多三处材料，三行 `Promise.all` 并发 stat，一次抽屉请求多三个 `stat(2)`
  ——代价可接受，也符合「一次请求 stat 一次」的口径。
- `present` 的口径没动：它说的仍然是「库里有没有这一行」。两格分开，是因为它们回答的是
  两个不同的问题，而这次事故的全部教训就是**这两个问题以前只有一个答案位**。

界面（`app/components/Drawer.tsx` 的 `RefRow`）：`filePresent === false` 时
① 不渲染 `<a class="att">`；② 在同一个位置渲染一句 `class="miss"` 的
「文件已丢失，重新生成」。日期、版本数、指纹三枚 pill 照旧——它们说清的是「丢的是哪一份」，
这恰恰是重新生成时最需要的信息。`.miss` 用负向色（`app/globals.css`），因为它是数据丢失，
不是一条普通说明。

**路由的 404 原样保留**（`app/uemaster/[...path]/route.ts` 一个字没改）：直接访问旧 URL
仍然该是 404——那是「这个地址没有文件」的正确回答。这次改的是**界面不再主动提供一条
明知会 404 的链接**，两件事不冲突。

### 用例与变异

新增 `tests/artifact-missing.test.tsx`（6 条，渲染 `RefRow`），`tests/read.test.ts` 的
「参考段」那一组加了 4 条（真库 + 真磁盘）：

| 用例 | 钉住什么 |
| --- | --- |
| `行在、文件也在：filePresent 为真` | 正常那一半（别把好行也判死） |
| `行在、文件被删掉：present 仍为真，filePresent 为假` | 事故那一半：`writeArtifact` → `attachArtifact` → `removeArtifact`，读模型必须同时给出 `present: true` 与 `filePresent: false` |
| `站外链接不由本地磁盘判死活：filePresent 为 null` | 外链不误判 |
| `没有产物行时 filePresent 也是假` | 空槽位不冒出一句「丢失」 |
| 渲染：文件在 → 有 `href`、无「文件已丢失」 | 链接那一支 |
| 渲染：文件没了 → 无 `href="/uemaster/`、有「文件已丢失」+「重新生成」 | 死链那一支 |
| 渲染：`canEdit = false` 也看到同一句话 | 按钮不在的人也要知道「怎么办」 |
| 渲染：外链照旧是链接 / 空槽位两者都没有 | 两种边界 |

变异（改坏 → 变红，改回 → 变绿，两次都实跑）：

| 变异 | 结果 |
| --- | --- |
| M1 `detail.ts`：`filePresent: await filePresentOf(...)` → `filePresent: true`（不 stat） | `tests/read.test.ts` **2 红**（行在文件被删 / 站外链接为 null） |
| M2 `Drawer.tsx`：`item.url !== null && item.filePresent !== false` → 去掉后半个条件 | `tests/artifact-missing.test.tsx` **2 红**（文件没了仍画链接 / 无 edit 那一支） |

## 三、防止再发生：文档级，且只是文档级

三处写上了同一句话：

1. `README.md`「三个坑」第三条（原来只有两个坑）：`-x` 会连被忽略的文件一起删，
   `data/` 里是会话密钥与全部产物；要清就 `git clean -fd`，先 `git status --ignored`。
2. `docs/superpowers/plans/2026-11-07-finish-gaps.md`：事故当天补的一段，纪律 + 为什么这条
   只能是文档级。
3. `.gitignore`：`data/` 那两行的**上方**加了警告块——错误就是在这里发生的（「我要清干净
   未跟踪文件」），所以提示必须挂在会被读到的那一行旁边。
4. 连带修正 `README.md`「还糙的地方」第 2、3 条：它们原本写着「抽屉里会出现一个 404 链接」，
   现在那一行会变成「文件已丢失」。

### 残余风险（必须点名）

- **这不能拦住任何人**。`git clean -fdx` 是 git 自己的命令，仓库里没有任何代码在它的路径上；
  要拦就得 hook git（`clean.<pattern>.ignore` 是 per-clone 的本地配置，wrapper 脚本一绕就没了）。
  所以这一条是**约定**，不是**机制**：照做的开发者不受影响，不照做的（尤其是没读过 README
  的 agent 会话）一模一样再删一次。
- **同一条命令的其它受害者**：`data/` 里任何将来新增的运行期文件都自动处在风险里。文档只
  点名了今天的两块。
- **另一条真实存在的删除路径**：`tests/helpers/files.ts` 的 `cleanArtifacts()` 在测试收尾时
  删**整个产物根**。它是给测试用的，但它删的是**这台机器上真实的产物目录**——本次事故复现时
  就撞上过：生成刚成功、跑一次全量测试，`data/uemaster/` 又没了。这一条不在本次改动范围内
  （那属于数据守卫），但它是同一类「静默删掉真产物」，值得单独处理。
- **并行会话正在做结构级修复**：另一条工作线把产物根搬到仓库外
  （`src/core/runtime-dir.ts`，`data/uemaster` 变成一条软链）。那才是根治；
  本次交付的文档与读模型改动与它不冲突（`artifactFile()` 的语义没变，`filePresent` 照样成立），
  但「`-x` 会删掉什么」的清单会随之变化，合并时那句话要跟着改。

## 四、重新生成一份产物，然后看它

### 选哪条需求

```
$ select number, title, prd_url from requirements where prd_url is not null order by number limit 5;
 3 | 导出任务队列改造         | https://docs.123pan.example/prd/PAN-3
 4 | 直链分享限速（二期）     | https://docs.123pan.example/prd/PAN-4
 5 | 权益套餐产品结构改造     | https://docs.123pan.example/prd/PAN-5
 6 | 分享页搜索补齐 H5/移动端 | https://doc.weixin.qq.com/doc/w3_AW4A…
 7 | PC 端支持打开分享页      | https://docs.123pan.example/prd/PAN-7
```

选了 **PAN-11「连续包月续费提醒」**（`https://docs.123pan.example/prd/PAN-11`）：它有 PRD
链接，而且**库里那条死链就是它**（`/uemaster/PAN-11/evaluate.html`）——重新生成一次，
事故现场本身就被修好了。

### 走的哪条路

与「生成」按钮**同一条**（`app/actions.ts` 的 `generateAction`）：

```
generateAction → startGeneration(db, actor, { requirementId, stage: 'evaluate' })
              → spawn(tsx scripts/gen-worker.ts <jobId> <actor>)   （detached）
              → runJob → resolveStrategy = provider（app_settings 里三格都配了）
              → composeEvaluation：图 3 次上限 / 页面片段 2 次上限
              → build.py（vendored）出 HTML → 写文件 → attachArtifact
```

没有用假 provider、没有手工写 HTML、没有直接调 `composeEvaluation` 抄近路：起作业、等
`uemaster_jobs` 收口，与点按钮一模一样。

`app_settings` 里的配置（动手前先看了一眼）：

```
provider.baseUrl  https://api.deepseek.com/v1
provider.model    deepseek-flash
provider.apiKey   sk-***（不落进本文档）
```

### 三次跑的结果

| # | 作业 | 用时 | 产物 | 逐段留痕 |
| --- | --- | --- | --- | --- |
| 1 | `4b051e6b-e5e2-4259-8db0-c7c4d246012e` | 75 s | 32 661 B | `flow#1 ok` / `pages#1 ok` / `build#1 ok` |
| 2 | `861a08e1-6161-4c3f-a0dd-93f526521dba` | 87 s | 31 842 B | `flow#1 ok` / `pages#1 ok` / `build#1 ok` |
| 3 | `911a712b-2ca8-410a-a308-683f66fc57b7` | 93 s | 31 906 B | `flow#1 ok` / `pages#1 ok` / `build#1 ok` |

第 1 次跑通链路；第 2 次在改完模板 CSS **之后**重跑（证明补丁没破坏构建）；第 3 次是收尾时
再跑一遍，因为**前两份产物被别的东西删掉了**——第 1 份死在一次全量测试收尾
（`cleanArtifacts()` 删整个产物根），第 2 份死在另一条会话正在做的产物根外迁上。
三次都是一次过（没有触发修图 / 修片段），`uemaster_job_attempts` 各 3 行——这条链路
一次都没失败过，失败的一直是「文件放在哪」。

第 3 次跑之前有一处妥协，写在明处：并行会话正在改 `src/core/runtime-dir.ts`，那一刻
`data/uemaster` 是一条**指向已被删掉的目录**的软链，`import store.ts` 会在迁移那一步抛
`ENOENT: lstat data/uemaster`。所以这次把 `FLOWERS_DATA_DIR` **显式设成同一个默认根**
（`~/Library/Application Support/flowers`）——落点与默认完全一致，只是跳过当时正在改的
迁移分支。产物落在：

```
~/Library/Application Support/flowers/uemaster/PAN-11/evaluate.html   31 906 B   06:27
```

库里的结果（`uemaster_artifacts`，`created_by = 吕品`）：

```
number | stage    | url                              | created_at (UTC)        | input_hash
11     | evaluate | /uemaster/PAN-11/evaluate.html   | 2026-11-07 22:13:58.062 | 有
11     | evaluate | /uemaster/PAN-11/evaluate.html   | 2026-11-07 22:17:45.683 | 有
11     | evaluate | /uemaster/PAN-11/evaluate.html   | 2026-11-07 22:26:33.xxx | 有
```

（另有一条事故前 `created_by = 房超` 的行，是这次事故里那条死链的来处。同一
(需求, stage) 多行 → 抽屉那一行显示「第 N 版」，这是 `listArtifacts` 的既有口径。）

> 注意路径形态已经变了：并行会话把产物根搬到仓库外之后，`data/uemaster` 只是它的一条软链
> （或镜像）。下面的 grep 是在产物文件本体上做的，与它怎么被链接进仓库无关。

### 产物长什么样（证据）

在 PAN-11 那份 HTML 上 grep（第 2 次生成的产物）：

```
$ grep -n 'class="layout"\|class="flow-panel"\|class="stage"\|class="anno-panel"' evaluate.html
219:<div class="layout">
221:<aside class="flow-panel">
282:<div class="stage">
302:<aside class="anno-panel">
```

三栏结构**在**：`.layout` 里依次是左（流程图）`aside.flow-panel`、中 `div.stage`、
右（标注）`aside.anno-panel`，与 `vendor/uemaster/flow-walkthrough/templates/walkthrough.html`
的骨架逐字对应。

```
$ grep -c 'locate-banner\|data-locate-banner' evaluate.html
0
```

**定位横幅不在。** 这不是这次改坏的东西，是**评估材料这条链路本来就没有它**：
`injectBanner` 只有两个调用点，`src/core/uemaster/inspect.ts:1745`（走查材料，
`locateBannerText(repos)`）与 `src/core/uemaster/review.ts:1257`（评审材料，
`renderLocate(baseline.locate)`）。`composeEvaluation` 从头到尾没有调用它——评估阶段不读
代码现状，也就没有「代码里找没找到」这段结论可写。所以：**评估材料 = 三栏走查结构、无横幅**；
**评审 / 走查材料 = 三栏走查结构 + 顶部定位横幅**。这条差别在本次任务里只做记录，不改。

## 五、CSS 缺陷：全屏时中栏/右栏还在下面

文件：`vendor/uemaster/flow-walkthrough/templates/walkthrough.html`，紧跟 `.flow-panel.fs`
那条规则之后，**一条规则**：

```css
/* 本地补丁（2026-11-08，非上游）：全屏时中栏与右栏仍然排在下面。… */
.flow-panel.fs ~ .stage, .flow-panel.fs ~ .anno-panel { display: none; }
```

为什么需要：`.flow-panel.fs` 是 `position: fixed; inset: 0`（只盖住视口内那一片），
而 `.stage` 与 `.anno-panel` 照旧参与布局——窄视口那条 media query 还把它们的
`position` 改回 `static`，于是点「全屏」之后画布左下角露出手机框的一条边。
`:has()` 没用：这份模板会被原样塞进产物 HTML，老 WebView 没有 `:has()`；三栏是 `.layout`
的直接子元素，同级选择器 `~` 就够。退出全屏时 `fs` 类名一摘，规则即失效，不需要第二段。

**验证方式：读 CSS，没有截图**（本任务不截图）：

- 模板里那一行在（`sed -n 44,58p` 可见，`display: none` 覆盖的正是两个兄弟元素）；
- 用它构建出来的**产物**里那一行也在：
  `grep -n 'flow-panel.fs ~ .stage' evaluate.html` → `55:.flow-panel.fs ~ .stage, .flow-panel.fs ~ .anno-panel { display: none; }`
  ——这同时证明 `build.py → templates/walkthrough.html` 这条链读的是打过补丁的那份；
- 其余行为没动：`toggleFs()` 仍然只 toggle 类名，JS 一个字没改。

### 连带：那条「与上游逐字节一致」的用例必须跟着改

`tests/walkmap.test.ts` 里有一条用例，把 vendored 与上游 `/tmp/uem` 的原件各跑一遍、
产物必须 **byte-identical**——这是 vendoring 的唯一保险。打了补丁，它当然会红（实测：
`1 failed`）。

改法是**留一个可以数的口子，而不是放宽成「包含」**：把补丁那一块（以
`本地补丁（2026-11-08，非上游）` 开头、到那条规则为止）从我们的产物里剥掉，剩下的必须与
上游**逐字节相同**；同时补丁本身必须真的出现在产物里（否则就是「两边都没这块」的假绿灯）。
补丁变多、变样、被上游覆盖掉，这条用例都会红。

`vendor/uemaster/README.md` 的「我们改了什么：**没有改**」也跟着改了：现在写清「一处，只有
一处」，附 diff、附升级后怎么把这一条贴回去。这句话原来是 vendoring 的承诺，改它比改模板
本身更需要留痕。

## 六、数字

| 项 | 数 |
| --- | --- |
| `tests/read.test.ts` | 42 条（本次 +4） |
| `tests/artifact-missing.test.tsx` | 6 条（新增） |
| `tests/walkmap.test.ts` | 12 条（字节比对那条改成「剥掉补丁后比对」） |
| 目标文件夹跑（`read` + `artifact-missing`） | 48 passed |
| 全量（本次改动在其内时跑到的最后一次干净结果） | 56 files / 1319 passed + 1 skipped |
| `npx tsc --noEmit` | 干净 |

**关于全量的一次坦白**：交接前再跑全量时，工作区里有**另一条会话正在改的未完成改动**
（`src/core/auth/session.ts` 一度重复导出 `resetSessionSecretCache`，另有 per-run 测试库、
产物根外迁的进行中改动），36 个 suite 因此起不来、随后 560 条红。那不是这三次提交的内容，
也不在本任务范围内；本任务自己的文件在同一时段单独跑是绿的。上面那个 1319 是改动进入工作区
之后、那些外部改动还没落地时跑出来的。

另外两件在收尾时观察到的、属于**别人那条线**的现象，记在这里免得下次重新查：

- `tests/helpers/files.ts` 的 `cleanArtifacts()` 删的是**真实产物根**：即使测试连的是
  `flowers_test`，它删的仍是这台机器上那份产物目录。产物根外迁之后这条已经收窄（测试用
  `FLOWERS_DATA_DIR` 指到临时目录），但「测试收尾会删产物」这件事本身值得再确认一遍。
- 收尾那一刻，`data/uemaster` 一度是**指向已删除目录的软链**，`ensureDataRoot()` 的迁移
  会 `cpSync` 这条悬空软链并抛 `ENOENT: lstat`。那不是本文档改的东西，但它说明：
  仓库内那条镜像本身就是一条新的、会被误删的路径——「哪一份是真身」这件事要写死在 README 里。

## 七、这次没做的事（有意的）

- **不给看板 / MCP 加这一格**：它们各自要一次 stat，看板一次刷新是几百行。抽屉是唯一会
  把死链变成「可点的东西」的地方。
- **不追溯历史死链、不做产物备份**：那是另一件事（要不要存正文、存在哪），需要 owner 裁决。
- **不写代码守卫**：见第三节的残余风险。
- 竖排的 `.miss` 样式没有单测——它是一条颜色；这条链路由渲染用例覆盖到「那句话出现了」。
