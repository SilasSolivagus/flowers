# 运行期数据出仓库 / 每轮一张测试库 / 全屏只留流程图画布

日期：2026-11-08
分支：`main`（起点 `92a22b5`）
关联：`2026-11-07-finish-gaps.md`（事故记录）、`2026-11-07-p0-test-db.md`（共用的 `flowers_test`）

这三件事都来自同一天的两次事故：

1. 一次 `git clean -fdx` 把 `data/`（会话密钥 + 产物 HTML）删掉，库里 `uemaster_artifacts`
   的行全在，抽屉里那条链接点开 404「产物不存在」，所有人手里的会话同时失效。
2. 两个 `npx vitest run` 同时在跑，共用一张 `flowers_test`，互相 truncate，一次 60 个用例
   集体变红，看上去像一次真回归。

第 3 件是走查页的小毛病：全屏之后左下角露出一条手机框的边。

**根因不是「谁手滑」，是两处「不可重建的东西住在会被清理的地方」**：运行期数据住在
git 忽略目录里（清理未跟踪文件是日常操作），测试与生产共用同一张库、同一棵产物树
（测试本来是破坏性的）。所以修法都不是「小心一点」，而是把边界画出来。

---

## 1 · 运行期数据住在仓库外

### 新默认路径

| 东西 | 位置 |
| --- | --- |
| 根（macOS） | `~/Library/Application Support/flowers/` |
| 根（Linux） | `$XDG_DATA_HOME/flowers`，没有 XDG 就是 `~/.local/share/flowers` |
| 覆盖 | `FLOWERS_DATA_DIR`（相对路径按 cwd 解析一次） |
| 会话密钥 | `<根>/.flowers-session-secret`（0600） |
| 产物根 | `<根>/uemaster/<PAN-n>/<stage>.html` |

路径逻辑只有一份：`src/core/runtime-dir.ts`。两个调用点（`sessionSecret()` 与
`store.ts` 的 `ARTIFACT_ROOT`）都从 `ensureDataRoot()` 取，模块里不再各自 `path.join`。
拆成两份的下场是「迁一半」：密钥搬走了、产物还在仓库里，同一次 `git clean -fdx`
照样删得掉。

### 迁移行为（首次使用时，只搬一次）

- 触发点：`ensureDataRoot()`，任何进程第一次碰到运行期数据时（dev server 启动、
  一次 `npm run seed`、MCP server 起来）。**只在没设 `FLOWERS_DATA_DIR` 时做**——
  设了那个变量就是「这个目录我自己管」，测试把根指到临时目录时绝不去搬开发机真的密钥。
- 逐条目搬（`.flowers-session-secret`、`uemaster/`）：先 `cp` 到**目标目录内**的临时名
  （`<dst>.migrating-<pid>`）→ `fsync` 文件与父目录 → `rename` 到最终名 → 才删旧的。
  临时名与最终名同一个文件系统，`rename` 是原子的；`fsync` 保证「rename 生效」之前
  数据已经落盘。**任何时刻崩溃都只有两种结果：旧的还在（下次再搬一次），或者新的完整
  存在**——不会出现「长度对、内容空」的密钥文件（那比没搬更坏：它看起来成功，实际把
  所有人的会话作废）。
- 目标已存在 → 目标赢，源留着不动（`uemaster/` 是空壳目录时例外：让位给真正的内容）。
- 旧位置里断掉的软链（`data/uemaster` 曾经是指向仓库外的链）：删掉、记一行，继续。
  这条路径在进程启动第一刻，抛 ELOOP/ENOENT 等于整个服务起不来。
- 搬完打印一行：`运行期数据已从仓库内 <仓库>/data/ 迁到仓库外 <根>/（…）；此后 git clean 不再影响它们。`

**本次真实迁移**（dev server 下一次请求就触发了）：

```
$HOME/Library/Application Support/flowers/.flowers-session-secret   0600, 65 字节
md5 迁移前 = 迁移后 = 58e0bc47a24c8474054ba6e2b76c912a
```

字节没变 ⇒ **已登录的人没有被踢下线**。真请求验证（见第 5 节）。

### 生成链路为什么还能跑

任务包对外部 CLI 说的仍是「写到本项目根目录下的 `data/uemaster/<PAN-n>/<stage>.html`」。
这句话**不能**改成仓库外的绝对路径：agent CLI 的写权限通常被限制在 cwd 之内，指一个
家目录外的路径只会换来「拒绝写入」。所以由我们负责最后一段搬运：

- `store.ts` 的 `adoptLegacyArtifact(url)`：仓库里那份收进仓库外根。两边都有时
  **谁新听谁的**（重做一次会覆盖；上一次搬一半的残留会被清掉），搬完把仓库里空下来的
  `data/uemaster/PAN-n/` 目录收掉。
- 三个调用点：`generator.ts`（跑完命令、比 mtime 之前）、`start.ts`（跑前快照 / 跑后
  再收一次）、`attach.ts`（agent / 脚本交回链接时）。少任何一处，链条上就会出现
  「文件明明在，但系统说它不存在」。

### 测试的盘与生产的盘

`tests/helpers/files.ts` 的 `cleanArtifacts()` 是一句 `rm -rf`，路径来自**生产代码**的
`ARTIFACT_ROOT`。它是本轮事故的第二个凶手：库与库之间隔开了，盘没有——一次全量测试
就把开发机上所有真产物删掉。

三层修：

1. `vitest.config.ts` 把 `FLOWERS_DATA_DIR` 指到 `$TMPDIR/flowers-test-<runId>`
   （runId 与库名后缀同一个值：一次跑 = 一张库 + 一个产物目录）。
2. `runtime-dir.ts` 兜底：`VITEST=true` / `NODE_ENV=test` 时**即使没人设**
   `FLOWERS_DATA_DIR`，默认也落 `$TMPDIR/flowers-test-<runId>`。靠人记得设变量不算保证。
3. `cleanArtifacts()` / `writeArtifact()` 之前先过 `assertTestDataRoot()`：
   根必须是「系统临时目录 + `flowers-test-` 前缀」两条同时成立，否则抛中文错误并
   指出这个根看着像生产的、`rm -rf` 会删掉几百份别人的评审材料。判据
   （`isTestDataRoot`）与生产侧解析器同一份。

**验收（父任务要求的那条）**：真产物的存证。

```
BEFORE 06:34:14  exists=yes  md5=794d2c6f84bddb3d382d444d2af1e2c5  size=31906
       （~/Library/Application Support/flowers/uemaster/PAN-11/evaluate.html）
跑一次全量 npx vitest run（57 files / 1345 passed, 2m33s）
AFTER            exists=yes  md5=794d2c6f84bddb3d382d444d2af1e2c5  size=31906
CANARY INTACT
```

反方向也查了：用例里写产物的只有 `writeArtifact` / `uploadArtifact`（都过守卫）和
外部 stub（写的是仓库内 `data/uemaster`，随后被 `adoptLegacyArtifact` 收走）。没有第二条
写生产根的路。

---

## 2 · 每次测试跑一张库

### 库名

- 默认（`VITEST=true` / `NODE_ENV=test`）：`flowers_test_<runId>`。
- `runId`：`FLOWERS_TEST_RUN_ID`（`vitest.config.ts` 在主进程生成一次，经 `test.env`
  发给所有 worker）→ `VITEST_POOL_ID`（`w<poolId>`）→ `process.pid`（`p<pid>`）。
  **主路之所以是环境变量而不是 `VITEST_POOL_ID`**：后者是 **worker** 编号，一轮测试的文件
  会被分给不同 worker，用它当库名会让同一轮里每个文件各拿一张库，而 `globalSetup` 只建了
  一张——那会是「表不存在」的另一种形状。非法字符统一换成 `_`（库名要进
  `create database "…"`）。
- `TEST_DATABASE_URL` 仍然整条覆盖（调试逃生口）：设了就**不建库、不迁移、跑完不删**。
- `npm run db:test:setup` 建的是**基名**那张 `flowers_test`（`perRun:false`）：它不再是用例的
  前置条件，现在是「`TEST_DATABASE_URL` 可以指过去的现成空库」+ 迁移模板。

### 一轮的生命周期

`tests/global-setup.ts`：建库（维护库 `postgres` 上 `create database`）→ 跑迁移 →
打印 `测试库：flowers_test_<runId>（本轮专用，跑完删）` → 收尾时掐断残留连接、
`drop database`，并删掉本轮的临时数据目录（只删 `$TMPDIR` 下的）。收尾的失败只记一行，
绝不让一轮测试因此变红。

### 两个并发跑的证据（Fix 2 的验收）

```
$ npx vitest run &   npx vitest run &   wait
A: 测试库 flowers_test_97251tmw6zgsgs   Test Files 57 passed (57)   Tests 1345 passed | 1 skipped
B: 测试库 flowers_test_97253tmw6zgsgs   Test Files 57 passed (57)   Tests 1345 passed | 1 skipped
exit A=0  B=0        06:36:51 → 06:40:58
canary before = canary after = 794d2c6f84bddb3d382d444d2af1e2c5
```

两张库、两份临时目录、两个都绿。跑完 `select datname from pg_database where datname like
'flowers_test%'` 只剩基名那张——收尾真的删了。

### 老的共用 `flowers_test` 怎么办

**留着，可以安全删掉。** 现在没有任何路径会连它：用例连 `<基名>_<runId>`，
`TEST_DATABASE_URL` 调试时才会指过去。留着它的唯一好处是 `db:test:setup` 之后
手里有一张能 `\dt` 比对的空库。要删：`drop database "flowers_test"`（或
`npm run db:test:setup` 之后再建一张）。

---

## 3 · 全屏时只留流程图

`vendor/uemaster/flow-walkthrough/templates/walkthrough.html`，紧跟 `.flow-panel.fs`
那条规则后面：

```css
.flow-panel.fs ~ .stage, .flow-panel.fs ~ .anno-panel { display: none; }
```

为什么用同级选择器 `~` 而不是 `:has()`：三栏是 `.layout` 的直接子元素，`~` 就够；
`:has()` 在老 WebView 里没有，而这份模板会被原样塞进产物 HTML。

**这是对 vendored 模板的唯一一处本地补丁**，以 `本地补丁（2026-11-08，非上游）` 开头、
整块带中文注释。`vendor/uemaster/README.md` 的「我们改了什么」写明了这一条与升级步骤；
`tests/walkmap.test.ts` 的字节比对靠那两个锚点把补丁剥掉再与上游比对——**补丁变多或
变样，那条用例就会红**。下次 `vendor/uemaster` 整目录覆盖之后，把这一条规则（连注释）
贴回同一位置即可。

---

## 4 · 变异表（压缩）

| 改动（把下面这一处改坏） | 哪条用例红 | 真实后果 |
| --- | --- | --- |
| `defaultDataDir` 去掉 `FLOWERS_DATA_DIR` 分支 | 「FLOWERS_DATA_DIR 优先」 | 覆盖不了位置，测试与生产又共用一棵树 |
| 让它返回 `REPO_ROOT/data` | 「默认位置不在仓库里」 | `git clean -fdx` 又删得掉密钥与产物 |
| 去掉 `defaultDataDir` 的 `isTestProcess` 兜底 | 「VITEST 下默认落临时目录」 | 漏设一个环境变量，测试就开始删生产产物 |
| `isTestDataRoot` 去掉前缀判断 | 「`/opt/flowers-test-x` 不算测试盘」 | 一个叫得像测试目录的真目录会被 `rm -rf` |
| `isTestDataRoot` 去掉 tmpdir 判断 | 「`/data/flowers-test-x` 不算测试盘」 | 同上，仓库旁的目录被误判 |
| 去掉 `moveInto` 里的 `chmodSync(0o600)` | 「密钥搬完还是 0600」 | 密钥权限被放宽 |
| 去掉 `migrateLegacyData` 的「目标已存在则跳过」 | 「目标已存在时不覆盖」 | 迁一半崩了再跑，新文件被旧文件盖掉 |
| 去掉 `fsync` + 「先临时名再 rename」 | 无（靠 review 与注释） | 崩溃后可能留下 0 字节密钥 ⇒ 所有人掉线 |
| `ensureDataRoot` 先建 `uemaster/` 再迁移 | 「ensureDataRoot 只搬一次」里的旧位置清空断言 | 产物树整棵被跳过（库里每条链接都指向空目录） |
| `sessionSecret()` 换回仓库内路径 | 「密钥从新位置读出来」两条 | 迁移完仍在读旧位置 ⇒ 文件被删就换密钥 |
| `store.ts` 的 `ARTIFACT_ROOT` 换回 `REPO_ROOT/data/uemaster` | 「产物根在新根下」 | 产物仍住在会被清理的地方 |
| 删掉 `generator.ts` / `start.ts` / `attach.ts` 里任一处 `adoptLegacyArtifact` | `generate.test.ts` 的 runJob 三条 / `attach` 的 artifact_missing | 生成链路报「产物文件不存在」，或交回链接永远 404 |
| `adoptLegacyArtifact` 的「谁新听谁的」改成「目标赢」 | 「仓库那份更新：覆盖产物根那版」 | 重做一次静默无效，界面还显示旧版本 |
| `testDatabaseName` 去掉 `_<runId>` 后缀 | 「测试进程默认落到 `<基名>_<runId>`」 | 两个并发跑又共用一张库 |
| `testRunId` 去掉 `FLOWERS_TEST_RUN_ID` | 「runId 优先用 FLOWERS_TEST_RUN_ID」 | 一轮里每个文件各拿一张库（`globalSetup` 只建了一张） |
| `resolveDatabaseUrl` 删掉 `perRun === false` 分支 | 「perRun:false 时回到基名」 | `db:test:setup` 建一张用完就没人用的一次性库 |
| 删掉 `cleanArtifacts()` 里的 `assertTestDataRoot` | 「这一轮真的落在测试盘上」+ canary 存证 | 一次全量测试删掉所有真产物（本轮事故） |
| 删掉全屏那条 CSS | `walkmap.test.ts` 字节比对（剥补丁后不再逐字节相同） | 全屏左下角露出手机框 |

---

## 5 · 验证清单

| 命令 | 结果 |
| --- | --- |
| `npx vitest run` | 57 files / 1345 passed, 1 skipped（2m33s） |
| 两个 `npx vitest run` **并发** | 两轮各 57 files / 1345 passed，exit 0/0，库名 `…_97251…` / `…_97253…` |
| `npx tsc --noEmit` | 干净 |
| `npm run db:test:setup` | `库已存在：flowers_test` / `迁移完成：flowers_test` |
| 真请求（dev server `:3000`） | 用**迁移后**那份密钥签的 cookie 请求 `/` → `200`、页面里渲染出「吕品」；不带 cookie → `307`（跳登录） |
| 生产产物存证 | `PAN-11/evaluate.html` 跑全量前后 md5 一致（`794d2c6f…`） |

真请求那一条是这样造的：读 `~/Library/Application Support/flowers/.flowers-session-secret`
签一张 `v2.<name>.<exp>.<mac>`（`exp` 用库里 `members.session_epoch`），带上它请求 `/`。
200 而不是 307 ⇒ 这个 cookie 是「我们发的」⇒ **迁移保住了同一把密钥，已登录的人没有被
踢下线**。如果迁移换了一把密钥，这条请求会 307 到 `/login`。

---

## 6 · 残余风险

1. **生成过程中的短暂窗口**：外部 CLI 按任务包写到仓库内 `data/uemaster/…`，我们在命令
   退出后立刻搬走。若恰好在这个窗口里跑 `git clean -fdx`，这一份**本次生成**的产物会丢
   （已经搬走的历史产物不受影响）。要彻底消除得让 CLI 写仓库外，而 agent CLI 的写权限
   通常被限制在 cwd 之内——两者不可兼得，选的是「保住历史数据」。
2. **崩溃的测试跑会留下 `flowers_test_<runId>` 与 `$TMPDIR/flowers-test-<runId>`。**
   正常收尾会删；被 `SIGKILL` / 断电时不会。清理：
   `select datname from pg_database where datname like 'flowers_test_%'` 然后逐个 drop；
   临时目录 `rm -rf $TMPDIR/flowers-test-*`。没有自动 GC，是刻意的（自动删别人正在跑的
   库比留残骸更糟）。
3. **`FLOWERS_DATA_DIR` 指到生产目录时**，`adoptLegacyArtifact` 仍会把仓库里那份搬过去；
   而 `cleanArtifacts()` 的守卫会拦住删除。也就是说「指错」最多让产物落在错的地方，
   不会**删**掉它。
4. **迁移只在「没设 `FLOWERS_DATA_DIR`」时发生**。一台机器若长期用这个变量指自定义目录，
   仓库里的旧 `data/` 不会被自动搬——需要手工 `mv data/* "$FLOWERS_DATA_DIR"/` 一次。
   这是有意的：设了这个变量的人自己管目录。
5. **`git clean -fdx` 仍然是允许的操作，也仍然会删掉仓库内 `data/` 里的一切**。现在
   那里只剩「正在生成中的文件」与空目录；密钥与历史产物都在仓库外。文档级纪律保留在
   `.gitignore` 与 `2026-11-07-finish-gaps.md` 里，但不作为唯一防线。
6. **`code_index` 与迁移数据的守卫没动**（本任务边界）：`src/core/locate/*`、`src/db/migrations/*`、
   `reset.ts` 的破坏性 SQL 守卫都保持原样。
