# 仓批量接入（2026-11-08）：从 3 个仓到 ~139 个仓的机器、一次快照、一份磁盘算术

三件事，一条链：**仓清单只有一份 → 批量接入能断点续跑 → 接入之后量得出索引到底看见了什么**。
第三件是这一次的重点：3 个仓时「同步成功」就够用了，139 个仓时「同步成功、索引里什么都没有」
会成为最常见的那种静默失败。

- 清单：`config/repos.txt`（5 行真数据）→ 服务器 `/opt/123pan/tools/_ro/repos.txt`（随脚本 rsync）
- 播种：`scripts/repos-apply.ts` → `app_settings.code.mirror.repos`
- 批量：`scripts/onboard-repos.ts` → 镜像 + 索引 + `repo_coverage`（迁移 0033）
- 报告：本节

## 0. 结果速览

| 项 | 结果 |
|---|---|
| 清单 | `config/repos.txt`：5 个仓（pc / uni-app / cross-frontend / agent-tracker / gateway），分支写在行里 |
| 设置 | `code.mirror.repos` 3 → 5（`repos-apply.ts`，diff：`+ 123pan-agent-tracker、+ 123pan-gateway`） |
| 服务器 | `sync-mirrors.sh` 改读清单；`install-cron.sh --server` 两个文件各打两边 sha256，一致 |
| 镜像 | 新建 2 个 bare 仓（agent-tracker 6.8 M、gateway 32 M），5 个仓合计 **2.38 GB** |
| 覆盖率 | 5 行落库；`123pan-gateway` 是 **0/49**（Kong 的 Lua 仓，解析器只认 TS/Vue） |
| 顺带修的 | `123pan-cross-frontend` 的镜像停在 2026-10-21 → 本轮同步推到 `6c287f4`（2026-11-06） |
| 索引代价 | `blob_index` 312 → **506 行**（+194）：agent-tracker 的 195 个文件只新增了 194 行内容 |
| 用例 | 新增 25 条（inventory 15 + coverage/磁盘 10），全绿 |

## 1. 清单格式：`config/repos.txt`

```
<仓名><TAB 或空格><分支>      # `#` 开头整行是注释；空行忽略
```

```text
123pan-pc	master
123pan-uni-app	master
123pan-cross-frontend	master
123pan-agent-tracker	master
123pan-gateway	master
```

三条校验（`src/core/codemirror/repo-inventory.ts`，shell 侧同一套正则）：

1. **仓名形状** `[A-Za-z0-9][A-Za-z0-9._-]*`。这是安全边界而不是洁癖：仓名会被拼成
   `/srv/123pan-mirror/<仓名>.git` 交给 ssh，带 `/` 或 `..` 就是一次路径穿越。
2. **一行坏了整份作废**（与 `parseRepos()` 同一条取舍）：半份仓库列表比没有更糟，
   因为调用方会以为自己读的是全部。报错点名**行号 + 行内容 + 为什么**。
3. **重名是错误**，不是「后者覆盖」：两行同一个仓说明有人改到一半，而两处的分支可能不同。

**分支为什么在清单里**：`sync-mirrors.sh` 以前对所有仓 fetch 同一个 `$BRANCH`。仓一多
这个假设立刻不成立（`master` / `main` / `dev` 都有），而写错的错法是**安静的**——
fetch 成功、HEAD 很新、材料对着另一个分支的代码。所以分支是每仓一格、必填。

**为什么是纯文本**：三处要读它，其中一处是 Linux 上的 bash（服务器上没有 node）。
JSON 要 jq、YAML 要 yq，都不保证有；`while read` 是 POSIX。而且加仓 = 加一行 + commit，
diff 里看得见。

加仓的顺序（第二步幂等）：

```bash
# 1. 编辑 config/repos.txt + commit
npx tsx scripts/repos-apply.ts --dry-run   # 看 diff
npx tsx scripts/repos-apply.ts             # 写设置
npx tsx scripts/onboard-repos.ts --limit 10 # 建镜像 + 索引 + 覆盖率（分批）
scripts/install-cron.sh --server           # 把新清单发到服务器（同步脚本读它）
```

## 2. 播种路径：一份清单，零漂移

```
config/repos.txt ──(repos-apply.ts)──> app_settings.code.mirror.repos ──> resolveMirrorConfig()
       │                                                                        ↑
       └──(install-cron.sh --server, rsync)──> dogyun:/opt/…/repos.txt          │
                                                    └──> sync-mirrors.sh（bash，读文件）
```

- **为什么不废掉设置、让 TS 直接读文件**：读侧（走查 / 评审 / 材料 / MCP / 夜间索引）都走
  `resolveMirrorConfig()`，而它们的 cwd 各不相同（测试进程、MCP 进程、服务器那次同步根本
  不经过 node）。文件是**录入界面**，设置是**读侧状态**——一个部署事实不该要求读侧能碰文件。
- **为什么不给 bash 一份 JSON**：见上一节（服务器没有 jq/node）。
- **零漂移的两个动作**：`repos-apply.ts` 写之前过 `parseRepos()`（读侧同一个解析器），
  写之后再用 `resolveMirrorConfig()` 读一遍；`index-nightly.ts` 每夜比一次「清单 vs 设置」，
  不一致就写一行 `(inventory)` 告警（**不改退出码**：下一步是跑 `repos-apply.ts`，不是同步失败）。
- **宿主机的 `FLOWERS_MIRROR_REPOS`**：它会盖过设置。`repos-apply.ts` 发现读侧看到的
  不是刚写的这份时，直接指出来——这是「两边不一致」最常见的原因。

`onboard-repos.ts` 则**不读设置**：它把清单注入成 `FLOWERS_MIRROR_REPOS`（env 是第一优先级），
于是 `head()` / `lsTreeEntries()` / 索引装配都自动认得**设置里还没播种的新仓**。
`transport` / `sshHost` 仍然从设置读——只有 `repos` 这一格被清单盖住。

## 3. 覆盖率：5 个仓的实况（`repo_coverage`，2026-11-08）

| 仓 | HEAD | 树文件 | 索引 | 页面 | 轮廓 | import | 镜像 |
|---|---|---|---|---|---|---|---|
| `123pan-pc` | `3354b4a1`（11-06） | 582 | **137** | 2 | 94 | 507 | 2.32 GB |
| `123pan-uni-app` | `6ee08a14`（11-06） | 639 | **142** | 27 | 97 | 580 | 0.012 GB |
| `123pan-cross-frontend` | `6c287f4e`（11-06） | 130 | **24** | 4 | 13 | 83 | 0.008 GB |
| `123pan-agent-tracker` | `7a5a508d`（08-28） | 310 | **195** | 0 | 163 | 477 | 0.007 GB |
| `123pan-gateway` | `6359f39b`（09-20） | 49 | **0** | 0 | 0 | 0 | 0.032 GB |
| 合计 | | 1710 | 498 | 33 | 367 | 1647 | **2.38 GB** |

怎么读这张表：

- `files_indexed / files_total` 的差**不是失败**，是「树里有、解析器不看」的那部分
  （图片 / 锁文件 / `dist` 之外的 JSON / `.md` / 后端语言）。pc 137/582、uni-app 142/639
  都在这个量级上，与 0032 时的口径一致。
- **`123pan-gateway` 是 0/49**，而且这一行是**对的**：它是一个 Kong 网关仓——39 个 `.lua`、
  4 个 `.sh`、1 个 `.conf`，没有一行是 `[ts|tsx|js|jsx|mjs|cjs|vue]`。索引「看不见」它
  不是 bug，是解析器只覆盖前端。它的价值在于：**这种仓不该按「前端仓」进来**，而以前
  只有「镜像同步成功」这一个信号，看起来与 pc 一样绿。
- `123pan-agent-tracker` 页面 0 是正常的（不是 uni-app，没有 `pages.json`），但它
  195 个文件、163 个轮廓、477 条 import——它有真代码，只是没有页面清单。
- `pages` 相对文件数偏低的仓（pc 2 条）说明页面清单主要来自 `pages.json` 之外的目录约定，
  这一格的值要跟 `code-index-pages` 的口径一起看，不能单独当「页面数量」。

## 4. 磁盘：139 个仓的算术（以及它为什么给区间）

实测（`du -sk`，KB → GB）：

```
pc          2,436,272 KB = 2.323 GB
gateway        33,052 KB = 0.032 GB
uni-app        12,208 KB = 0.012 GB
cross-front     8,048 KB = 0.008 GB
agent-tracker   7,164 KB = 0.007 GB
合计        2,496,744 KB = 2.381 GB
```

服务器可用（`df -Pk /srv`）：`50,587,388 KB = 48.24 GB`。

三种外推，差别不是精度问题而是**结论问题**：

| 口径 | 算术 | 139 个仓 | 与 48.2 GB 可用比 |
|---|---|---|---|
| 中位数 × N | 0.012 × 139 | **1.6 GB** | 看起来很宽裕 |
| 均值 × N | (2.381/5) × 139 = 0.476 × 139 | **66.2 GB** | **装不下** |
| 两簇 × N（下面的算法） | 见下 | 取决于重仓比例 | 分界点在 **16 个** |

中位数与均值差 40 倍，因为样本里有一个 2.3 GB 的 pc 和四个 10 M 级的仓。真实的分布
不是「平均」而是**两簇**：

- **重仓**（把 `dist` / `asar` 提交进仓库的前端应用）：≈ 2.32 GB（n=1，pc 的 pack 2.4 G
  几乎全是构建产物）
- **轻仓**（源码 + 少量配置）：≈ 0.012 GB（n=4）

于是：可用余量 = 48.24 − 10（水位）= 38.24 GB，`38.24 / 2.323 ≈ 16.5` →
**139 个仓里只要有 17 个像 pc，磁盘闸就会拦下后续的 clone**。若重仓是 5 个：
`5×2.323 + 134×0.012 = 11.6 + 1.6 = 13.2 GB`（够）；10 个：`23.2 + 1.5 = 24.7 GB`（够，剩 23.5）；
16 个：`37.2 + 1.4 = 38.6 GB`（越线）。

**不确定性在哪**（这一段比上面的数重要）：

1. **样本只有 5 个，且重仓簇 n=1。** 一个样本撑不起一类。「2.32 GB」是 pc 这一个仓的
   性质，不是「重仓类」的均值。
2. **重仓与否无法从仓名/语言推断**，只能 clone 之后量：它取决于「有没有把构建产物
   提交进去」这个工程习惯，pc 提交了（`web-file/frontend/dist/web.asar`），gateway 没有。
3. 因此区间是 **1.6 – 323 GB**（全轻 ↔ 全重），点估计在 13–25 GB（重仓 5–10 个）。
   **首轮只测量不拦**就是这个原因：用 4 个样本的均值去拦 139 个仓，估大了会拦住本来
   装得下的批次。
4. 磁盘闸的判据是「可用 − **这一批还没建的部分** ≥ 10 GB」，不是「可用 ≥ 10 GB」——
   后者会在第 100 个仓之后才开始喊，而那时 `ENOSPC` 已经在写一半的 pack 上发生了
   （留下半成品 bare 仓，下一次看起来「目录已经在了」）。

## 5. 规模化：先坏的是什么

按「多久之后会被撞到」排序，都是本轮实测出来的，不是推演：

1. **磁盘**（数学上最先）。见 §4：第 17 个 pc 级重仓就撞水位。`onboard-repos.ts` 现在
   会在 clone **之前**拦，并把 `--budget-gb` / `--floor-gb` 的口径打在日志里。
2. **05:05 的串行 fetch 窗口**。本轮 5 个仓的同步耗时 28 秒（含一次 15 秒的连接失败），
   健康时约 2.5 秒/仓。139 个仓 × 2.5 s ≈ **6 分钟**，已经超过 05:05 → 05:10 那 5 分钟
   的间隔：`index-nightly` 会在镜像还没同步完时开始索引，材料上那句「代码快照」就慢一天。
   更糟的是**串行 + 单仓 300 秒超时**：一个死仓会把后面所有仓顶到队列末尾（最坏
   139 × 300 s = 11.5 小时）。修法（未做）：按仓并行（`xargs -P`）+ 把超时降到 60 s
   + 让夜间索引等一个「镜像这一轮跑完了没有」的信号。
3. **codeup 的间歇性不可达**。本轮实测到了三次不同形态：`Could not resolve host`、
   `Failed to connect … after 15001 ms`、以及同一分钟内 `getent hosts` 失败而
   `git ls-remote` 成功。批量接入已经加了重试（`--retries`，默认 2 次、线性退避）；
   `sync-mirrors.sh` **没有**重试——它的失败语义是「记下来 + 退出 3」，所以夜里少
   一个仓仍然要人看日志。
4. **镜像约定被 clone 破坏**。第一次跑批量接入时两个新仓的 `.git/config` 带着
   `[remote "origin"]`，而 `sync-mirrors.sh` 的收尾检查（`remotes=0`）因此把整轮
   判成 `rc=3`——真仓都好好的。已在 `ensureMirror` 里补 `remote remove origin`
   （顺带的好处：镜像里不留任何远端 URL，凭据只在 `/root/.git-credentials`）。
   这一类「手工建的镜像 vs clone 出来的镜像长得不一样」还会以别的形式出现，
   `install-cron.sh --check` 与 `sync-mirrors.sh` 的 cfg 检查是唯一的抓手。
5. **单进程 Postgres 的解析吞吐**。`blob_index` 现在 506 行 / 267 KB（5 个仓）。按
   「唯一内容」增长（同一个组件跨仓只一行），所以 139 个仓大概率是几万行、几 MB——
   不是瓶颈。真正的成本是**首次接入**那一次解析：它按仓串行跑（同内容不会被两个仓
   同时解析），而 `on conflict do nothing` + 内容地址意味着重跑是安全的。
6. **两个新仓的 master 本来就旧**：agent-tracker HEAD 2026-08-28（72 天前）、
   gateway 2026-09-20（49 天前）。按 0031 的判据它们每天各触发一条 `mirror.stale`。
   这不是接入出错——但 owner 会在铃铛里看到两条长期提醒，需要提前说清。

**没有做、也不该在这一轮做的**：按仓并行接入、140 个仓的增量调度、把
`repo_coverage` 接到材料上的「索引覆盖率」横幅。前两件要等磁盘与 05:05 窗口的实测
（第 1、2 条）先定下来。

## 6. mutation 表

| 文件 | 动作 | 为什么 / 风险 |
|---|---|---|
| `config/repos.txt` | 新增 | 唯一仓清单（5 仓）；纯数据，无代码风险 |
| `src/core/codemirror/repo-inventory.ts` | 新增 | 解析 / 路径 / diff 纯函数；不碰任何既有读路径 |
| `src/core/codemirror/repo-coverage.ts` | 新增 | 覆盖率计数 + 续跑判据 + 磁盘闸（全是纯函数 + 两条 SQL） |
| `src/db/migrations/0033_repo_coverage.sql` + journal | 新增 | 新表 `repo_coverage`；既有迁移一个字节没动 |
| `src/db/schema.ts` | 追加 `repoCoverage` | 与 0031/0032 同一个位置、同一个风格；不改既有表 |
| `scripts/repos-apply.ts` | 新增 | 清单 → 设置（唯一写 `code.mirror.repos` 的脚本） |
| `scripts/onboard-repos.ts` | 新增 | 批量接入；只读 git + 建镜像（clone 到 `.tmp-onboard` 再 mv） |
| `scripts/sync-mirrors.sh` | 改写仓列表来源 | `REPOS=(…)` → 读清单；分支按行；CAS / flock / chmod / 退出码语义原样保留 |
| `scripts/install-cron.sh` | 追加一次 rsync + 一组 sha256 | 清单与脚本一起发；`--check` / `--remove` 同步覆盖 |
| `scripts/index-nightly.ts` | 加一段 `(inventory)` 告警 | 只写日志行，**不改退出码**、不改同步逻辑 |
| `scripts/README.md` | 更新 | 三个新脚本 + 清单格式 + 已知会旧的地方 |
| `tests/repo-inventory.test.ts` / `tests/repo-coverage.test.ts` | 新增 25 条 | 解析 / 续跑判据 / 磁盘算术 |

**没动**：`src/core/locate/*`、通知逻辑（`read/notify.ts`、`notify/*`）、既有迁移、
`requirements`（仍 814 live 行，未 reseed）、`blob_index` 的口径（内容地址，一行没删）。

## 7. 复现与验证

```bash
npx tsx scripts/repos-apply.ts --dry-run                 # diff 预览
npx tsx scripts/onboard-repos.ts                         # 全清单，断点续跑（本轮 rc=0）
npx tsx scripts/onboard-repos.ts --file /tmp/x.txt --no-clone   # 验证失败隔离 → rc=3 且点名
npx tsx scripts/index-nightly.ts --log /tmp/n.log        # 5 仓各 0 块新内容（幂等）→ rc=0
scripts/install-cron.sh --server && scripts/install-cron.sh --check
ssh dogyun 'SYNC_FLOWERS_LOG=/tmp/s.log /opt/123pan/tools/_ro/sync-flowers-mirror.sh'  # rc 取决于上游
```

本轮观察到的真实退出码：`onboard-repos.ts` 两次 0、一次 3（含一个人为的坏仓，
`--no-clone`，整批其余仓照跑）；`sync-mirrors.sh` 一次 3（`agent-tracker` 的 fetch
撞上 codeup 瞬断，其余四仓 `moved` 正常，`cross-frontend` 前进 15 天）。

## 8. 第二批：17 个前端仓（2026-11-08 夜）

第一轮把机器造出来了（5 个仓），这一轮**第一次把它用在规模上**：从服务器文档
《代码仓库全景图-2026-04-16.md》里挑 17 个前端仓加进清单，跑批量接入、量覆盖率、
量磁盘、量 05:05 那个同步窗口。结论先写在下面，每条都带本轮的实测数。

### 8.1 清单的来源，以及它已经有多旧

- **来源**：服务器上的一份产品文档 `代码仓库全景图-2026-04-16.md`，列 141 个服务。
  本机没有这份文件的副本（`find / -name '代码仓库全景图*'` 无结果），它只在服务器/文档侧活着。
- **日期 2026-04-16 → 本轮 2026-11-08：约 6.8 个月**。它是**产品文档**，不是仓注册表：
  它回答「有哪些服务」，不回答「这些仓今天还在不在、叫什么、默认分支是什么」。
- **实测的误差形态**（逐个 `git ls-remote --symref <url> HEAD` 验过，每个名字 3–7 次尝试）：

| 形态 | 数量 | 例子 |
|---|---|---|
| 名字对、远端在、默认分支就是 `master` | 10 | `frontend`（无 `123pan-` 前缀）、`Nimbus`（大写 N）、`eslint-config` |
| 远端已经不存在的仓（`未知的仓库路径`） | 7 | `123pan-ssr`、`123pan-video`、`123pan-windowsPro`、`crazy-api`、`app-ui-test`、`web-ui-test`、`platform-fontend` |
| 疑似笔误 | 1 | `platform-fontend`——`platform-frontend` 也试了，同样不存在 |
| 不是应用的（库 / 测试件） | 3 | `eslint-config`、`app-ui-test`、`web-ui-test` |

所以「141 个服务」不能当「141 个可接入的仓」用：**17 个名字里 7 个（41%）对着空气**。
这不是接入失败，是清单的时效问题；机器按「一仓失败不停一批」记下来就够，但**下一轮
不该再从这份文档抄名字**——要么拿 codeup 的仓列表当输入，要么把这份文档冻结成历史。

### 8.2 追加与播种

```text
config/repos.txt   5 行 → 22 行（+17，注释里写清了挑前端不挑 Go 的理由）
repos-apply.ts     diff：+ frontend、share、phoenix-share、123pan-ssr、123pan-video、
                       123pan_manager_frontend、123pan-ele-react、123pan-resource-library、
                       123pan-virtuallist-antd、123pan-windowsPro、123pan-image-hosting、
                       Nimbus、crazy-api、platform-fontend、eslint-config、app-ui-test、web-ui-test
                   结果：已写入 22 个仓；读侧 resolveMirrorConfig() 读回 22 个，与清单一致
```

**一个必须说清的并行事实**：同夜另一条线在 `dcb33c3`（00:11）往同一份清单里加了
`apisrv`（Go 解析器那条线），并播种成 23 个仓。所以现在 `config/repos.txt` 是 **23 行**、
设置里也是 23 个仓，本节只报**本批的 22 个**；`repo_coverage` 里那第 23 行 `apisrv`
（583/624，0.37 GB）是同一条线的产物，不是本轮的。

### 8.3 22 个仓的覆盖率（`repo_coverage`，本轮测量）

| 仓 | HEAD | 日期 | 树文件 | 索引 | 页面 | 轮廓 | import | 镜像 |
|---|---|---|---|---|---|---|---|---|
| `frontend` | `dc17a79c` | 11-06 | 3241 | **1144** | 27 | 874 | 4881 | 1317.8 MB |
| `123pan_manager_frontend` | `5cd21189` | 11-06 | 1017 | **606** | 85 | 469 | 1338 | 93.2 MB |
| `share` | `e73c5527` | 2025-12-05 | 530 | **201** | 0 | 150 | 830 | 1268.1 MB |
| `phoenix-share` | `4f10ed99` | 11-03 | 895 | **238** | 0 | 167 | 1055 | 78.2 MB |
| `123pan-agent-tracker` | `7a5a508d` | 08-28 | 310 | **195** | 0 | 163 | 477 | 7.0 MB |
| `123pan-uni-app` | `6ee08a14` | 11-06 | 639 | **142** | 27 | 97 | 580 | 11.9 MB |
| `123pan-pc` | `3354b4a1` | 11-06 | 582 | **137** | 2 | 94 | 507 | 2379.2 MB |
| `123pan-image-hosting` | `f00c684f` | 11-06 | 155 | **78** | 2 | 29 | 236 | 4.5 MB |
| `Nimbus` | `e8dd383f` | 11-06 | 193 | **47** | 3 | 28 | 129 | 14.6 MB |
| `123pan-resource-library` | `0d0d660c` | 11-06 | 85 | **43** | 5 | 34 | 119 | 2.2 MB |
| `eslint-config` | `06cc94ed` | 06-01 | 86 | **33** | 1 | 15 | 95 | 1.3 MB |
| `123pan-cross-frontend` | `6c287f4e` | 11-06 | 130 | **24** | 4 | 13 | 83 | 8.0 MB |
| `123pan-ele-react` | `3be4b646` | 2025-11-10 | 544 | **6** | 2 | 2 | 18 | 260.3 MB |
| `123pan-virtuallist-antd` | `3073737b` | 2023-06-04 | 38 | **0** | 0 | 0 | 0 | 9.7 MB |
| `123pan-gateway` | `6359f39b` | 09-20 | 49 | **0** | 0 | 0 | 0 | 32.3 MB |
| `123pan-ssr` | — | — | — | **失败** | — | — | — | 未建 |
| `123pan-video` | — | — | — | **失败** | — | — | — | 未建 |
| `123pan-windowsPro` | — | — | — | **失败** | — | — | — | 未建 |
| `crazy-api` | — | — | — | **失败** | — | — | — | 未建 |
| `platform-fontend` | — | — | — | **失败** | — | — | — | 未建 |
| `app-ui-test` | — | — | — | **失败** | — | — | — | 未建 |
| `web-ui-test` | — | — | — | **失败** | — | — | — | 未建 |
| 合计（15 个有镜像） | | | 9089 | 2895 | 158 | 2146 | 10348 | **5.36 GB** |

（合计不含 `apisrv` 的 624/583 与 0.37 GB。）
能索引的仓一共 15 个，合计 9089 个文件里索引到 2895 个（32%）——与第一轮 5 个仓的
比例（1710 里 498，29%）一致，「树里有、解析器不看」的那部分仍然主要是图片、安装器
二进制、`.md`、锁文件与 `.nsh/.nlf` 这类 Electron 包体。

**两个 0/near-0 的行不是索引坏了，是两个不同的原因**：

- `123pan-gateway` **0/49**：Kong 网关，39 个 `.lua`，`CODE_EXT` 里没有 `.lua`。第一轮就
  是这个结论，本轮没变。
- `123pan-virtuallist-antd` **0/38**、`123pan-ele-react` **6/544**：**是目录约定挡的**，
  不是扩展名。`classifyKind()` 只认 `pages|views`、`components`、`services|apis`、
  `stores|hooks`、`routers` 这几类目录，平铺在 `src/index.tsx` 的库仓一律落 `other`
  （= 不进索引）；`ele-react` 的 58 个源码文件大多在 `123pan-nsis*/`、`123pan-bin/`
  这类构建脚本目录里，同样落 `other`，544 个文件里 480 个是 `.nsh/.nlf/.png` 安装器资源。
  这条口径是**故意的**（避免配置/工具函数稀释候选），本轮按约束**没有动解析器**；
  要改就得单独一轮，且要先说服「库仓的 `src/index.tsx` 值得进索引」。

### 8.4 克隆：10 个成功、7 个失败（原因原文）

两次 `onboard-repos.ts`（第一次 `--retries 3`，第二次 `--retries 6` 补跑），
`123pan_manager_frontend` 第一次因连接失败记了失败、第二次成功——**这就是重试存在的理由**。

| 仓 | 原因（最终一次） | 判定 |
|---|---|---|
| `123pan-ssr` | `remote: 未知的仓库路径…repository … not found`（7 次里出现过） + 连接失败 | 远端不存在 |
| `123pan-video` | 同上（`video`、`123pan-Video`、`video-player` 也都不存在） | 远端不存在 |
| `123pan-windowsPro` | `未知的仓库路径`（`123pan-windowspro` 也不存在） | 远端不存在 |
| `crazy-api` | `未知的仓库路径`（`crazy_api` 也不存在） | 远端不存在 |
| `platform-fontend` | `未知的仓库路径`（`platform-frontend` 也不存在） | 远端不存在 / 疑似笔误 |
| `app-ui-test` | 连接失败 7 次；独立 `ls-remote` 3 次均 `not found` | 远端不存在 |
| `web-ui-test` | 连接失败 7 次；独立 `ls-remote` 3 次均 `not found` | 远端不存在 |

**这 7 行留在清单里是有意的**（指令要求「不许静默丢掉」）：`repo_coverage` 里有它们
`ok=false` + 原因的 7 行，这就是「查过、没有」的证据。但代价在 §8.6/§8.8 里说清：
`sync-mirrors.sh` 每晚会对它们各打一条 `FAIL … 目录不存在` 并让整轮 `rc=3`。

### 8.5 磁盘：实测，不是外推

```
/srv/123pan-mirror 全量            5.73 GB（16 个镜像，含同夜那条线的 apisrv 0.37 GB）
本批 22 个仓的 15 个镜像           5.36 GB
```

最大三个：`123pan-pc` **2379 MB**、`frontend` **1318 MB**、`share` **1268 MB**。
**没有任何单仓超过 5 GB**（最大的 pc 是 2.32 GB，与第一轮同一个数），所以
「pc 一个仓就吃掉 1/20 可用空间」这句话本轮仍然成立，但没有出现第二个 pc 级重仓：
`frontend` 与 `share` 是 1.3 GB 级（把 `dist`/安装器提交进了仓库），其余 12 个仓都在
0.3 GB 以下，最小 1.3 MB。

服务器可用空间：本轮开始 **48.2 GB** → 结束 **45.4 GB**（`df -Ph /srv`：`45G` available，
53% used）。这一批净吃掉 **≈ 5.3 GB**，与 `du` 合计对得上（0.1 GB 是 `.tmp-onboard`
残留与 tmp 清理之前的临时占用，已被脚本清掉）。

**两簇分布在这一轮被证实了**（第一轮只有一个重仓样本，不敢下结论）：17 个尝试里
3 个 ≥ 1.2 GB、1 个 0.26 GB、其余 ≤ 0.1 GB。中位数 0.01 GB 仍然没用（这一批的中位数
是 9.7 MB，均值 0.36 GB，差 37 倍）；真实判据是「有没有把构建产物提交进仓」，
**与仓名、语言、是不是前端都无关**——`ele-react` 是最小的源码仓之一，却因为 544 个
安装器资源占了 260 MB。

### 8.6 05:05 那个窗口：22/23 个仓的实测

`sync-mirrors.sh` 是**串行**的，一个仓一次 `fetch`（`FETCH_TIMEOUT=300`）。本轮在
dogyun 上跑了 **14 次整轮**（`SYNC_FLOWERS_LOG=/tmp/sN.log`，用 `date +%s%N` 掐表）：

| 观测 | 值 |
|---|---|
| 最好一轮 | **6.3 s**（23 仓；11 个 fetch 成功、5 个失败、7 个目录不存在） |
| 最快但只有 10 个成功 | 6.4 s |
| 中位 | ≈ 110 s |
| 最坏一轮 | **266 s**（23 仓里只有 1 个 fetch 成功） |
| 全绿的一轮 | **一次都没有** |

**为什么没有「22 仓全绿」的实测数**：整晚 codeup 都在抖——14 次跑里 13 次出现 ≥5 个
`FAIL fetch`（`Could not resolve host` / `Failed to connect … port 443 after 1 ms`），
与第一轮记的间歇性不可达是同一种。所以：

- **外推的全绿耗时 ≈ 7 s**（11 个 fetch 在 6.3 s 内跑完 + 其余 5 个同量级），
  远在 05:05 → 05:10 那个 **300 s** 间隔之内。
- **真实耗时由网络决定，不由仓数决定**：30 s – 266 s 全部出现过。266 s 这一轮已经
  逼近 300 s 窗口，而它只有 23 个仓。
- **真正的风险仍然是「单仓卡死」**：串行 + 单仓 300 s 超时意味着一个挂住的仓就能把
  整轮顶过 05:10（最坏 23 × 300 s = 1.9 h）。本轮没遇到挂死，只遇到「连不上」（失败很快）。

**没有改动 cron**（指令要求不许静默改）。要改的话，最小的一步不是改时间，是给
`sync-mirrors.sh` 加 `FETCH_RETRIES`（见 §8.8 第 1 条）——今晚 13/14 轮的失败里，
绝大部分是重试一次就好的瞬时错误。

### 8.7 上游本身已经旧的仓（每个都会每晚一条 `mirror.stale`）

`MIRROR_STALE_DAYS = 7`（`src/core/codemirror/health.ts`，严格大于），判据只看
`head_date`。以 2026-11-09 为今天，本批 15 个有镜像的仓里 **HEAD 超过 60 天的有 5 个**：

| 仓 | HEAD 日期 | 天数 | 说明 |
|---|---|---|---|
| `123pan-virtuallist-antd` | 2023-06-04 | **1254** | 三年半没动，是个已归档的库 |
| `123pan-ele-react` | 2025-11-10 | **364** | Electron 版客户端，基本停更 |
| `share` | 2025-12-05 | **339** | 但仓里有 201 个可索引文件、830 条 import |
| `eslint-config` | 2026-06-01 | **161** | 配置库，天然不常改 |
| `123pan-agent-tracker` | 2026-08-28 | **73** | 第一轮就知道 |
| `123pan-gateway` | 2026-09-20 | 50 | **还没过 60，但 10 天内会跨线** |

其余 9 个仓的 HEAD 都是 11-03 ~ 11-06（3–6 天），正常。
再加上网关那一个：**清单稳定下来之后，每晚会有 5 条（很快就 6 条）长期红点**；
owner 明确说过不要一墙红。这不是接入出错，是「上游真的不动了」——所以处理方式应该是
**给这几个仓单独定阈值**，而不是把全局 7 天调大（那会让真·停摆的仓晚 3 周才被发现）。

### 8.8 提议的告警改动（**只提议，本轮一行都没实现**）

按「改动面从小到大」排：

1. **`sync-mirrors.sh` 加 `FETCH_RETRIES`（默认 2，线性退避）**。今晚 14 轮里 13 轮有
   ≥5 个 `FAIL fetch`，全是瞬时错误；不重试的话每一轮都会以 `rc=3` 收尾并留下几条
   `FAIL`，而仓本身是好的。这是「红墙」的最大来源，也是最便宜的修（约 10 行 bash，
   与 `onboard-repos.ts` 的 `cloneWithRetry` 同一套语义）。
2. **7 个远端不存在的仓要有归属**。现在它们每晚各产一条 `FAIL … 目录不存在` 并让整轮
   `rc=3`。两条路：删行（证据留在 §8.4 与本报告里），或在清单里给它们一个状态
   （例如第三格写 `absent`），让 `sync-mirrors.sh` 跳过、`onboard-repos.ts` 记 `ok=false`
   但不参与退出码。**这是一次决定，本轮没做**。
3. **每仓一个 `stale_after_days`（这一条是 owner 问的那个）**。最小形态：
   `config/repos.txt` 每行**可选第三格** `stale_after_days`（缺省 7，`0` = 不报），
   §8.7 里那 5 个仓写成 `180`/`365`/`0`。要改的地方是四处，不算小：
   - `parseRepoInventory()`：现在第三格直接报错（`多了 N 格`），要改成可选列；
   - `sync-mirrors.sh`：同一套解析，多一格现在也报错（`多了格子`），要同步；
   - `checkMirrorFreshness()`：`MIRROR_STALE_DAYS` 从常量变成「按仓取值」，于是读侧
     需要一张「仓 → 阈值」的表——最省事的是给 `mirror_health`（或 `repo_coverage`）
     加一列 `stale_after_days`，由 `onboard-repos.ts`/`repos-apply.ts` 播种；
   - `tests/mirror-health.test.ts`：7/8 两个边界数是钉住的，要补「每仓阈值」的用例。
   替代方案（更小但更糙）：只加一列 `no_alert boolean`，把「上游已停更」的仓标死，
   代价是这类仓真的坏掉时也不会报。**两者都只是提议。**
4. （可选）`mirror.stale` 的正文按「这批仓」聚合一句，而不是一仓一条。这属于通知
   fan-out，本轮明确不碰。

### 8.9 为什么没加那 79 个 Go 仓——以及这条前提当晚就变了一半

**本轮按指令没有加任何 Go 仓**，当时的理由是：解析器只读 `[ts|tsx|js|jsx|vue]` +
`pages.json`，`123pan-gateway`（39 个 `.lua`）已经证明「克隆成功、同步绿、索引 **0/49**」
这种静默失败长什么样；79 个 Go 仓会换来几十 GB 磁盘和一张全是 0 的表。

**必须补一句**：同夜 `dcb33c3`（00:11，另一条线）把 `.go` 加进了 `CODE_EXT`，并且
`apisrv` 已经量到 **583/624 文件、561 个轮廓**——所以「79 个 Go 仓全是 0」这个前提
**只对 `.lua` 成立的网关仓还成立，对 Go 仓已经不成立**。本轮不动（指令明确），
但下一轮应该重估：先挑 5 个 Go 仓量一次覆盖率与磁盘，再决定要不要整批进。
`123pan-gateway` 那行 0/49 仍然是对的，它的价值不变——它证明的是「语言不在解析器里
的仓，接进来等于没接」。

### 8.10 本轮没有做、也不该顺手做的事

- 没碰 `src/core/locate/*`、解析器、通知 fan-out（§8.8 的改动全部只是提议）；
- 没删任何既有镜像、没跑 `git clean` / `git checkout -- .`；
- 没重播 `requirements`（815 行、最后一行仍是 11-07 的种子；文档里那句「814」与现库
  差 1，不是本轮造成的——本轮一个 `insert into requirements` 都没有）；
- 没改 cron 时间、没改 `sync-mirrors.sh` 的失败语义；
- 那 7 个不存在的仓**留在清单里**（带 `ok=false` 的证据），删不删由 owner 决定。

---

## 9. 第三轮（2026-11-09 凌晨）：删掉 7 个不存在的仓、阈值按仓定、同步重试、5 个 Go 仓

§8.8 里那几条「只提议、一行没实现」的东西，这一轮挑了两条落地（第 1、3 条），
外加 owner 的三条裁定。**衡量标准只有一条：把「每晚都亮」的灯关掉，把「该亮」的灯留下。**

### 9.1 清单：23 → 21 行（文件 66 → 104 行）

| 项 | 之前 | 现在 |
|---|---|---|
| `config/repos.txt` 总行数 | 66 | **104**（多出来的是删仓说明与第三格的理由） |
| 仓行（非注释非空） | 23 | **21**（−7 不存在，+5 Go） |
| `app_settings.code.mirror.repos` | 23 | **21**（`repos-apply.ts` 已播种，读侧读回 21） |
| `repo_coverage` 行 | 23 | **28**（21 个在清单里 + 7 个孤儿行，**一行都没删**） |
| `blob_index` 行 | 3229 | **3603**（+374：5 个 Go 仓的唯一内容 + 2 个仓重测） |
| `requirements` 活行 | 814 | **814**（没 reseed，一个 insert 都没有） |

删掉的 7 个：`123pan-ssr`、`123pan-video`、`123pan-windowsPro`、`crazy-api`、
`platform-fontend`、`app-ui-test`、`web-ui-test`。**证据留在表里**：那 7 行仍是
`ok=false` + 原因原文（§8.4）。清单里加了一段注释，写清「这 7 个去哪了、要查为什么
当初以为它们存在就看 `repo_coverage`、**不要再从《代码仓库全景图-2026-04-16.md》把名字
抄回来**」。

为什么这一步值得单独一次决定：`sync-mirrors.sh` 对每个目录不存在的仓各打一条
`FAIL … 目录不存在` 并让整轮 `rc=3`。**一整年每晚都是 3 的退出码，读到第 30 天就不再是
信息了**——而真正的那一次 fetch 故障也会被算进「反正每天都红」。

### 9.2 `stale_after_days`：语法、语义、以及为什么它不进库

`config/repos.txt` 的第三格，可选：

```text
<仓名>  <分支>  [<stale_after_days>]
```

| 写法 | 含义 |
|---|---|
| 不写 | 用全局 `MIRROR_STALE_DAYS = 7` |
| 正整数（1–999999） | 超过这么多天没有新提交才提醒 |
| `never` | **不因「上游不动了」提醒**；同步失败照报 |

- 解析：`parseRepoInventory()` 收 2 或 3 格（第四格起整份失败并点名行号）；
  `sync-mirrors.sh` 同一套校验（**只认不解释**）。两处必须一起改：一边能读、一边报错
  退出 2，那一晚整份清单都不同步。
- `0` / 负数 / `1.5` 一律拒绝：0 不是一个天数，而「关掉」有专门的写法 `never`。
  两种「关掉」的写法会给下一个人留下一个必须猜的歧义。
- **不需要迁移，也不落库**：阈值是**清单里的配置**（这个仓是什么），`mirror_health`
  存的是**测量**（它现在停在哪一天）。混进 `mirror_health` 会让「改一次阈值」变成一次
  数据迁移，而改清单只是一次 `git diff`。读侧每轮从清单读一次：
  `scripts/index-nightly.ts` 本来就在读清单（漂移检查），直接复用同一次读取，
  读不到时退回全局 7 天并在日志里说清退回了哪种口径。
- 用例钉住了边界（`tests/mirror-health.test.ts`）：同一个 400 天前的仓，阈值 365 → 报、
  500 → 不报、`never` → 不报；**同一个仓、同一个 `never`，`ok=false` 时仍然报**。
  这就是「上游死了」与「我们抓不到」不能共用一个静音开关的那条线。

六个仓的取值，以及为什么这几个数：

| 仓 | HEAD | 天数 | 第三格 | 理由 |
|---|---|---|---|---|
| `123pan-virtuallist-antd` | 2023-06-04 | 1254 | **`never`** | 已归档的组件库。任何有限数字早晚被跨过，写 1460 只是把同一句话推迟一年 |
| `123pan-ele-react` | 2025-11-10 | 364 | `730` | 停更的 Electron 客户端；留一条硬上界，两年后有人接手时那句提醒仍然会响 |
| `share` | 2025-12-05 | 339 | `540` | 产品仓，只是发版稀疏：一年半没有提交本身就该被问一句 |
| `eslint-config` | 2026-06-01 | 161 | `365` | 配置库，按年改一次是正常节奏 |
| `123pan-agent-tracker` | 2026-08-28 | 73 | `365` | 内部工具，季度级改动 |
| `123pan-gateway` | 2026-09-20 | 50 | `180` | 活跃组件，十天前刚越过全局 7 天；半年是上界 |

**只有这六个写了第三格**，其余 15 个仍是全局 7 天：给所有仓放宽阈值等于把这一列取消掉。

### 9.3 同步重试，以及 `rc` 现在是什么意思

两段改动，都在 `scripts/sync-mirrors.sh`：

1. **只重试瞬时失败**（`FETCH_RETRIES` 默认 2，退避 `RETRY_BACKOFF × 第几次`，默认 2 s）。
   判定按**错误文本**（git 的退出码太粗：DNS 失败、连不上、认证失败都是 128）：
   `Could not resolve host` / `Failed to connect` / `Connection reset|refused|timed out` /
   `early EOF` / `RPC failed` / `HTTP 5xx` / 我们自己的超时。分支不存在、仓不存在、
   凭据失效**不重试**——它们的答案已经很明确，重试三次只是把一个明确的答案拖成 3 倍
   等待，而且日志会长得和真故障一样。实测验证：`123pan-pc` 写一个不存在的分支 →
   `FAIL … 试了 1 次: fatal: couldn't find remote ref no-such-branch`。
2. **超时最多再试一次**。一次 300 s 的挂起已经吃掉 05:05→05:10 那 5 分钟窗口的十分之一，
   两次就顶穿（那时 `index-nightly` 会开始索引一个还在同步的镜像）。「连不上」是秒级
   失败，重试它很便宜；「挂住」不是，所以两者不共用同一个次数上限。

实测（dogyun，21 个仓，清单已换成新版）：

| 轮次 | 耗时 | `RETRY` 行 | 重试后仍失败 | rc |
|---|---|---|---|---|
| 第 1 轮 | **114 s** | **13**（10 个仓触发） | 2（`123pan-cross-frontend`、`123pan-agent-tracker`） | 3 |
| 第 2 轮 | 155 s | **22**（14 个仓触发） | 6 | 3 |
| 合成：清单里一个没建镜像的仓 | 秒级 | 0 | — | **4** |
| 合成：一个不存在的分支 | 秒级 | 0 | 1 | **3** |

两轮各救回 **8 个仓**（第 1 轮 10 个触发重试 → 8 个成功、2 个三次仍失败；第 2 轮 14 个
触发 → 8 个成功、6 个失败）。这一夜 codeup 是持续抖动（同一条 `Failed to connect …
after 1 ms` 反复出现），所以两轮都以 3 收尾是**诚实**的：那不是噪音，是真的没抓到。
**关键的一格是「仓本身没坏」**：这 20 个失败仓的镜像与 HEAD 全都正常，只是那一夜连不上
——这正是「重试」与「rc=3」各自该负责的那一半。

新的退出码契约（四档，`scripts/README.md` 与脚本头部同步改了）：

| rc | 意思 | 下一步 |
|---|---|---|
| `0` | 全部仓 fetch + `update-ref` 成功（含 `moved=0`），cfg 检查通过 | 不用管 |
| `3` | **真故障**：某仓在所有重试后仍失败，或 `config` 里出现 `remote` / 带凭据 URL | 看 `/var/log/sync-flowers-mirror.log` |
| `4` | **没有真故障，但有仓还没有镜像**（清单里有、还没 onboard） | 跑 `scripts/onboard-repos.ts` |
| `2` | 环境/清单不对（缺 flock、清单不合格式、建不了日志或锁目录） | 修清单或环境 |
| `0`（flock 被占） | 另一次同步在做，这一轮跳过 | 不用管 |

`4` 与 `3` 分开，是因为两者的下一步完全不同：一个是「去建镜像」，一个是「去查网络」。
合成之前它们是同一个真值，只有读日志才知道差别。实现上 `sync_one` 用返回码 `2` 表达
「镜像不存在」，调用方据此把整轮收成 `4`——`if ! sync_one` 那种写法会把两者合成一个 1。

### 9.4 5 个 Go 仓（不是 79 个）

**怎么挑的**：先看 35 条 `backend` 活需求落在哪，再看仓在不在 codeup 的 123pan 组下。
需求聚成四块：风控/封禁（10 条）、对象存储与 CDN 直链（6 条）、会员/付费/发票（3 条）、
文件域（回收站/批量重命名/修改时间/搜索，4 条）；`apisrv` 已接（583/624）。

| 仓 | 入选理由 |
|---|---|
| `usercenter` | 账号与封禁字段——8 条风控需求都改在这类字段上 |
| `pay_server` | 会员到期时间、活动商品配置、发票 |
| `contentTreeSrv` | 文件树/目录结构：回收站恢复、批量重命名、`file.update_at` |
| `api_server_restful` | RESTful 入口（`/blacklist/add` 这类接口的另一份实现） |
| `osssrv` | 对象存储：直链产品的回源/生命周期/日志/成本 |

**没能进来的**：`cdn-manager`、`cloud-drive` 在 `codeup.aliyun.com/…/123pan/` 下**不存在**
（`ls-remote` 每种拼法都 `未知的仓库路径`；`cloud-drive` 试过 `cloud_drive`/`clouddrive`）。
直链那 6 条需求因此只有 `osssrv` 这一侧的代码。而 `123pan_manager`（GoFrame 管理后台）
**存在**、且 `[封禁阶梯-BugH] /blacklist/add 接口可绕过阶梯` 直接指向它——下一轮该换它。

实测（`repo_coverage` + 本轮 `du -sk` + `ls-tree` 计数）：

| 仓 | HEAD | 日期 | 索引/树 | 跳过生成 | 页面 | 轮廓 | outline 节点（按 kind） | import | 镜像 | `vendor/` |
|---|---|---|---|---|---|---|---|---|---|---|
| `usercenter` | `2caf4507` | 2023-10-24 | **38/67** | 7 | 0 | 31 | 149（method 85 / struct 40 / func 24） | 0 | 0.24 MB | 无 |
| `pay_server` | `d1f7c0c8` | 2026-11-03 | **174/296** | 95 | 0 | 163 | 964（method 489 / func 277 / struct 198） | 0 | 5.4 MB | 无 |
| `contentTreeSrv` | `b3aed6dd` | 2026-10-19 | **35/58** | 12 | 0 | 26 | 216（method 146 / func 40 / struct 30） | 0 | 19.0 MB | 无 |
| `api_server_restful` | `8f81ae7a` | 2026-11-02 | **102/115** | 0 | 0 | 99 | 946（struct 517 / method 362 / func 67） | 0 | 139.6 MB | 无 |
| `osssrv` | `161c3cbc` | 2026-09-18 | **40/62** | 12 | 0 | 33 | 166（method 81 / struct 52 / func 33） | 0 | 2.0 MB | 无 |

怎么读这张表：

- **`import` 一律 0 是设计**（§2.1 的取舍：Go 的导入单位是包，不是文件），不是没接上。
- **`files_indexed < files_total` 的三块原因**：`_test.go` 整类排除（`_test.go`：usercenter 0、
  pay_server 19、contentTreeSrv 6、api_server_restful 1、osssrv 5）、非 `.go`（`go.mod`/`.md`/
  `.json`/脚本）、以及 **`vendor/` 类目录**。`123pan-gateway` 那行 0/49 的解释在这里同样成立：
  语言不在解析器里 = 接进来等于没接。
- **`vendor/` 这五个仓一个都没有**（`ls-tree | grep -c '^vendor/'` 全是 0），所以
  `5c69dd3` 那条 `vendor/` 排除规矩这一轮**没有被真正考验到**。79 个一起接的时候它才是关键。
- **`usercenter` 是一个新发现**：上游只有 `v1` 一个分支（`ls-remote --heads` 只返回它），
  HEAD `2023-10-24`（**1112 天**）。这个仓名下的代码是 2023 年的——如果风控/封禁逻辑今天
  还在跑，它不在这个仓里。这一条没有在本轮解决（换仓需要 owner 定），但它意味着
  **usercenter 那一格覆盖率只能当「历史参考」用，不能当「后端现状」**。
- 磁盘：5 个仓合计 **≈ 0.17 GB**（166 MB），服务器可用 44.9 → 44.7 GB。按 apisrv 0.37 GB
  与这五个的中位数量级外推，79 个约 5–30 GB——**装得下**，但 `api_server_restful` 一个就
  139.6 MB（它把 `dist` 类产物提交了？没有：那 103 个 `.go` 之外还有 13 个非源码），
  说明「Go 仓都小」这句话不能当预算用。

### 9.5 两个覆盖率洞：一个修了，一个判定「不修」

**`123pan-virtuallist-antd`：0/38 → 1/38（修了）**

- 根因：这个仓 38 个文件里**只有一个产品源码** `src/index.tsx`，其余是
  `.eslintrc.js`、`rollup.config.js`、`jest.config.js`、`babel.config.js`、
  `__mocks__/`×2、`tests/basic.test.js`、`docs/` 下 20 个 md + `docs/examples/*.tsx` 9 个演示、
  `.umirc.ts`、`tsconfig.json`、`src/style.css`。组件库没有 `pages/`、没有 `components/`，
  于是**唯一的那个产品文件落 `other`**，整仓 0。
- 修法（`code-index.ts` 新增 `LIB_ENTRY`）：`src/index.*` 或 `lib/index.*` 判 `component`。
  **故意窄**：只认这两个目录的**直接子文件**且名字正好是 `index.<源码扩展名>`；
  `src/main.ts`、`src/utils/index.ts`、`app/index.ts` 仍然是 `other`（用例钉住）。
- 为什么判 `component` 而不是新造 `'entry'`：`FileKind` 是**前端角色**的轴，组件库入口导出的
  就是组件；新加一个 kind 会让 `KIND_RANK`、`locate` 排序、所有穷举 `FileKind` 的地方各多
  一条分支，而它能表达的信息没有消费者。副作用写明在代码注释里：普通 app 仓的
  `src/index.tsx` 此后也会以 `component` 进索引。
- 结果：**1/38**，1 个轮廓、1 条 import。剩下的 37 个全是配置/文档/演示/测试——那 37 个
  **不该进索引**，0.026 这个比例是诚实的。

**`123pan-ele-react`：6/544 保留不动（判定：我们的约定不适配这个布局，猜会更糟）**

先把 544 拆开（1080 个树文件先被 `isNoisePath` 去掉 536 个 png/ico/bmp/dll/exe 与 `build/`）：

| 块 | 数量 | 是什么 |
|---|---|---|
| NSIS 安装器资源 | **403** | 220 `.nsh` + 116 `.nlf` + 67 `.xml`（`123pan-nsis/`、`123pan-nsis-version/`） |
| 源码扩展名但没进索引 | **55** | 6 个 `.d.ts`、15 个 `123pan-bin` 构建/打包脚本、23 个 Electron 主进程模块（tray/dialog/updater/sentry/monitor/window/system/ipc/preload）、2 个配置（`.umirc.ts`、`eslint.config.mjs`）、1 个打包产物 `dist-dll/vendor.dll.js`、8 个前端 utils/enum/bin |
| **进了索引** | **6** | 2 个页面（`pages/home`、`pages/home2`）、1 个组件、2 个 store、1 个 service |
| 其它非源码 | 80 | `.json`/`.md`/`.less`/`.svg`/`.nsi`/`.bat`/NSIS 二进制 `Stubs/` |

结论：**这个仓的 UI 面只有 4 个文件**（一个 Electron 壳 + 两屏），它们**已经全在索引里**
（页面 2 / 组件 1 / store 有 2）。剩下能进索引的只有 Electron 主进程那一层，而我们的角色轴
（页面/组件/服务/状态/路由表）对「主进程的 tray / updater / sentry」没有诚实的桶——塞进
`service` 会让 `locate` 把 `updater/index.ts` 报成「已有这个接口」，那正是 §2.1 拒绝
「把测试当产品」的同一类错误。所以**不改**：6/544 是对这个仓的正确读数，538 里 403 是安装器
资源、80 是非源码、49 是构建与本不该属于「前端角色」的主进程代码、6 是 `.d.ts`。

**一句话**：`virtuallist-antd` 是「我们的约定漏了一个真的产品文件」，`ele-react` 是
「这个仓本来就没有更多产品文件」。两者的数字都是 0/near-0，但只有前者该修。

### 9.6 mutation 表

| 文件 | 动作 | 为什么 / 风险 |
|---|---|---|
| `config/repos.txt` | −7 行、+5 行、6 行加第三格、注释写明去向与取值理由 | 纯数据；66 → 104 行 |
| `src/core/codemirror/repo-inventory.ts` | 第三格解析 + `DEFAULT_STALE_AFTER_DAYS` / `STALE_NEVER` / `staleThresholdsOf()` | 只放宽格子数，其余校验一格没松 |
| `src/core/codemirror/health.ts` | `judgeMirror` / `checkMirrorFreshness` 收 `staleAfterDays` | **只作用于 `old` 那条判据**；`failed` / `unknown` 一个字没动 |
| `src/core/codemirror/code-index.ts` | 新增 `LIB_ENTRY`（一行判断 + 注释） | 不碰抽取规则（`outlineOf`/`imports`/`exports`）、不碰 `isIndexable` 的扩展名 |
| `scripts/sync-mirrors.sh` | 第三格解析、`is_transient()`、重试循环、`sync_one` 返回 2、rc 3/4 分档 | CAS / flock / chmod / userinfo 抹除 / 超时语义原样保留 |
| `scripts/index-nightly.ts` | 漂移检查里顺手取阈值表，传给 `checkMirrorFreshness` | 只多一次纯映射；清单读不到时退回 7 天 |
| `scripts/README.md` | 第三格三行表 + `never` 的边界 + 四档 rc | 与脚本/解析器逐条对齐 |
| `tests/repo-inventory.test.ts` | 15 → **17** 条 | 第三格解析 / 非法值 / 只写偏离默认的格子 |
| `tests/mirror-health.test.ts` | 12 → **14** 条 | 判定表 + 端到端（含「never 也报失败」） |
| `tests/index.test.ts` | 17 → **18** 条 | 库仓入口 + 「不是什么都算组件」 |

**没动**：`src/core/locate/*`、解析器的抽取规则、`requirements`（814 活行）、既有迁移
（**没有新迁移**——阈值不需要存储）、镜像（一个都没删）、`repo_coverage` 的历史行
（7 个孤儿行原样保留）、cron 时间。

### 9.7 用例与验证

```bash
npx vitest run                     # 78 个文件 / 1630 passed + 1 skipped（本轮 +4 条：这三个文件 44 → 48）
npx tsc --noEmit -p tsconfig.json   # 干净
npx tsx scripts/repos-apply.ts --dry-run   # diff：+5 / −7
npx tsx scripts/onboard-repos.ts --retries 3            # 测量 5、跳过 16、失败 0
npx tsx scripts/onboard-repos.ts --file /tmp/two.txt --force --no-clone  # 两个覆盖率洞重测
scripts/install-cron.sh --server                        # 脚本 + 清单各打两边 sha256，一致
ssh dogyun 'SYNC_FLOWERS_LOG=/tmp/s.log /opt/123pan/tools/_ro/sync-flowers-mirror.sh; echo $?'
```

### 9.8 剩下的告警噪音面（下一步该看什么）

1. **今晚会亮 3 条 `mirror.stale`**（模拟 `judgeMirror` 跑出来的，不是猜）：
   `usercenter` 1112 天、`osssrv` 52 天、`contentTreeSrv` 21 天。前两个是**新信息**
   （一个仓是 2023 年的、一个 52 天没动），按「上游死了 ≠ 我们抓不到」的口径它们该亮。
   要不要给它们第三格，是 owner 的决定——**本轮没有替 owner 静音**。
   上一轮那 6 条（1254/364/339/161/73/50 天）已经不再出现。
2. **`sync-mirrors.sh` 的失败仍然靠日志**：镜像 fetch 失败一行都不进库（`mirror_health`
   只由 `index-nightly` 的 `head()` / `index-sync` 写）。所以「fetch 一直失败、但镜像还能读」
   这种坏法只有日志与 rc 知道。下一步最小的一步：让 `sync-mirrors.sh` 把每仓的结果
   （ok/rc/耗时）写成一行 JSON，交给 `index-nightly` 并进 `mirror_health.ok`——那之后
   rc 与铃铛才是同一个事实。
3. **`never` 的代价**：`123pan-virtuallist-antd` 那条「cron 悄悄停了」也不再报（HEAD 不变、
   `ok=true`）。上游已归档的仓可以接受；**别把这个写法用到「只是慢」的仓上**。
4. **8 分钟 vs 5 分钟窗口没变**：21 个仓在坏网络下 114–155 s（本轮实测），最好的一轮仍是
   6–7 s。仓数到 79 个 Go 仓时，坏网络下的重试睡眠本身就能吃掉 300 s 窗口——那时该做的
   不是再调 `RETRY_BACKOFF`，是 `xargs -P` 并行（§8.6 第 2 条，仍未做）。
5. **`repo_coverage` 里 7 个孤儿行**：它们不在清单里，读侧不遍历表，所以不影响判断；
   但「表里有 28 行、清单 21 个仓」这个差会被下一个人当成 bug 问一次。答案在 §9.1。

## 10. 第四轮（2026-11-09 上午）：同步改并行、10 仓排除口径验证、Go 全量 45 个

这一轮的顺序是**先修路再进车**：`sync-mirrors.sh` 串行 21 个仓就已经 154–267 s，而 05:05 →
05:10 只有 300 s；在这个前提下把仓数从 21 推到 66，等于每天让 `index-nightly` 索引一批
还没同步完的镜像。所以 §10.1–§10.4 是同步的改动与实测（**先过**），§10.5 是排除口径在
10 个真仓上的验证（**再过**），§10.6 起才是批量接入。

### 10.1 并行：`xargs -P N`，默认 8

改动全在 `scripts/sync-mirrors.sh`，三条纪律各自对应一种「并行最容易丢的东西」：

| 纪律 | 做法 | 不这么做会怎样 |
|---|---|---|
| 日志不许插半行 | 每仓一个缓冲文件 `$JOBDIR/<仓>.log`，全部跑完后按**清单顺序**整份 `cat` | N 个进程同时 `echo` 到同一个 fd，>4 K 的写不保证原子，长行被撕开成读不懂的垃圾——而这份日志是「哪一晚坏了」的唯一证据 |
| 退出码聚合与串行逐字一致 | 子进程把 `sync_one` 的 rc（0/1/2）写进 `$JOBDIR/<仓>.rc`，父进程按清单顺序读回做同样的分档 | 拿 `xargs` 的退出码当聚合信号，只知道「某次调用非零」，丢掉「哪个仓坏了」；rc=3/4 的分界也随之消失 |
| 失败隔离 + 锁不泄漏 | `timeout` 仍在子进程里（函数内）；子进程 `exec 9>&-` 摘掉锁 fd | 一个挂住的子进程会让下一轮 `flock -n` 拿到「另一轮在做」的假象，整轮静默跳过 |

`SYNC_JOBS`（默认 8，1–64）是新环境变量。**默认 8 不是拍出来的**：单个 fetch 99% 时间在等
TLS 与 codeup，所以并发近乎线性；但 codeup 本来就不稳定，N 越大换来的是更多
`Failed to connect`（对端限流/抖动）而不是更多成功。8 是实测中「没有一个仓因为并发而
新失败」的最大档。上限卡 64 是因为 `xargs -P 0` 是**无限**并发——一个笔误就能把 codeup
打成整轮失败。

窗口的算术因此从 `N × 单仓` 变成 `ceil(N/JOBS) × 单仓`。

### 10.2 实测一：21 个仓前后各 5 轮（交错跑，抵消时段性抖动）

串行（旧脚本）与并行（新脚本）**交错**执行，同一份清单、同一台服务器：

| 轮 | 串行 21 仓 | 并行 21 仓（J=8） |
|---|---|---|
| 1 | 154.4 s | 29.6 s |
| 2 | 183.5 s | 85.3 s |
| 3 | 267.1 s | 67.6 s |
| 4 | 194.5 s | 58.3 s |
| 5 | 206.5 s | 42.6 s |
| **中位** | **194.5 s** | **58.3 s** |
| **最坏** | **267.1 s** | **85.3 s** |

**3.34×（中位）/ 3.13×（最坏）**。十轮全部 `rc=3`——**两边都是**：这一夜 codeup 持续抖动
（`Failed to connect … after 1 ms` / `Could not resolve host`），每轮都有 1–6 个仓在三次
尝试后仍失败。**并行没有修好 codeup，它修的是窗口**。改前 14 轮 0 次全绿（§9.3），改后
5 轮仍 0 次全绿——这是同一个上游事实，不是回退。

一个必须说清的边界：`SYNC_JOBS` 只压缩**排队**，不压缩**单仓**的 300 s 超时。一个真挂住的
仓仍然占一个槽位到 `FETCH_TIMEOUT`，所以上界是 `ceil(N/JOBS) × 600 s`（超时最多重试一次）。

### 10.3 实测二：60 条合成清单（走过失败路径的两条岔路）

「不存在的仓名」会掉进两条不同的岔路，两条都要量：

| 合成场景 | 串行 | 并行（J=8） | 结果 |
|---|---|---|---|
| 60 条**没有镜像目录**（rc=4 那条路） | 0.34 s | 0.54 s | 每轮 `FAIL … 目录不存在` ×60，`rc=4` |
| 60 条**镜像在、上游不存在**（走 fetch + 重试 + 退避） | **604.3 s** | **110.8 s** | `FAIL` ×60，`rc=3` |
| 90 条同型（= 90 个仓的真实规模，**每个都失败**） | —（外推 906 s） | **189.3 s** | `FAIL` ×90，`rc=3` |

第一行是「缺镜像」的聚合正确性（60 条全归到 `missing`，退出码 4）；第二、三行才是窗口
证据：**最坏情况（90 个仓全部 fetch 失败并且都重试过）189 s < 300 s**，窗口装得下。
串行在同一个最坏情况下是 906 s——15 分钟，窗口的 3 倍。

端到端（真清单 66 个仓、服务器上部署的那一份 `/opt/123pan/tools/_ro/sync-flowers-mirror.sh`）：

| 轮 | 耗时 | OK | FAIL | 重试行 | cfg 行 | rc |
|---|---|---|---|---|---|---|
| 1 | 94.6 s | 59 | 7 | 45 | 66 | 3 |
| 2 | 98.2 s | 56 | 10 | 51 | 66 | 3 |
| 3 | 96.0 s | 59 | 7 | 44 | 66 | 3 |
| 4（**cron 原样调用**：不带任何环境变量，脚本自己找旁边的 `repos.txt`） | 132.7 s | 56 | 10 | 51 | 66 | 3 |

66 个仓的**全部** `OK`/`FAIL` 行与 66 条 `cfg` 行都在，没有一条被截断或交错（
`grep -hvE '^(OK|FAIL|RETRY|cfg|NOTE|=== sync)'` 对 66 仓和 60/90 条合成日志均为空）。
失败率 10.6%（7/66），与 21 仓时的 5–14% 同一水平——**并发没有改变失败率，只是把
绝对条数按仓数放大了**（见 §10.9 第 1 条）。

`scripts/install-cron.sh --server` 已重装（两边 sha256 一致、cron 行在），
`--check` 全绿：脚本 + 清单两份 sha256 一致、`5 5 * * *` 在、`com.flowers.index-nightly`
（05:10）已加载。

一个顺手修掉的坑：`--check` 原来在**漂了**的时候也退 0（清单 21 → 66 那一改，它打了 `✗`
却仍以 0 收尾）。而这条命令唯一的用法是 `scripts/install-cron.sh --check && echo 装好了`
——退出码为 0 等于把 `✗` 降级成一句注释。现在三条判据（两份 sha256 / cron 行 / launchd 任务）
任意一条不成立即 `rc=3`，`--server` 之后 `--check` 回到 0。

### 10.4 四档 rc 与「不重试确定性失败」的回归

| 场景 | 期望 | 实测 |
|---|---|---|
| 清单里有仓、服务器上没有镜像 | 4 | **4**（合成 `MIRROR_ROOT`） |
| 镜像 `config` 里带 `[remote]` | 3 | **3**（`cfg apisrv remotes=1`） |
| 清单里仓名形状不合法（`bad/name`） | 2 | **2**（一个仓都没动） |
| `flock` 被别人占着 | 0 | **0** + `skip: another sync is running` |
| 分支不存在 | 3，且**只试 1 次** | **3**，`试了 1 次: fatal: couldn't find remote ref no-such-branch` |
| 瞬时失败 | 3，重试到 `FETCH_RETRIES+1` 次 | 3，`试了 3 次` / 中途转确定性时 `试了 2 次` |

最后一行值得单独看：同一条命令在不同时刻会走两条路——先撞上 `Failed to connect`（瞬时，
重试），重试撞上 `couldn't find remote ref`（确定性，立刻停）。日志里 `试了 2 次` 正是
「一次瞬时 + 一次确定性」的指纹，说明判定按**错误文本**而不是尝试次数。

### 10.5 排除口径验证：10 个真 Go 仓

口径两条（都在 `mirror.ts` / `code-index.ts`，本轮**一行未改**）：`isNoisePath` 的
`vendor|third_party|testdata` 目录段 + `_test.go`；生成代码按 `Code generated … DO NOT EDIT.`
的**注释头**（前 5 行）整类剔除。验证方法是「地面真值 vs 库」：地面真值直接在镜像上
`git ls-tree` + `git show HEAD:<path> | head -5` 逐文件判，**不经过我们的正则**。

| 仓 | 树文件 | 去噪后 `files_total` | 候选 `.go` | 地面真值生成文件 | `files_skipped_generated` | `files_indexed` | 闭合 |
|---|---|---|---|---|---|---|---|
| `api_server` | 961 | 960 | 884 | **298** | **298** | 586 | 884−298=586 ✓ |
| `upload-server` | 241 | 241 | 225 | 73 | 73 | 152 | ✓ |
| `123pan-slb` | 285 | 189 | 66 | 12 | 12 | 54 | ✓ |
| `transcode` | 89 | 89 | 56 | 3 | 3 | 53 | ✓ |
| `offline-download` | 74 | 73 | 58 | 9 | 9 | 49 | ✓ |
| `silentDataES` | 41 | 41 | 26 | 7 | 7 | 19 | ✓ |
| `cdk_manager` | 41 | 41 | 32 | 5 | 5 | 27 | ✓ |
| `gofs` | 64 | 59 | 21 | 0 | 0 | 21 | ✓ |
| `mount-disk-ws` | 20 | 19 | 11 | 0 | 0 | 11 | ✓ |
| `uuidsrv` | 14 | 13 | 8 | 0 | 0 | 8 | ✓ |

**10/10 闭合**：`files_indexed == 候选 .go − 生成文件`，一个不多一个不少。也就是说这 10 个
仓里「进不了索引的东西」只有两类——`_test.go`（按设计不进）与生成代码（真值 == 库里的数），
没有第三类沉默丢失。`files_total` 是**去噪之后**的树（`vendor/dist/图片/锁文件` 已被
`isNoisePath` 去掉），所以它不等于 `ls-tree -r | wc -l`（`123pan-slb` 285 → 189 就是差了
96 个 png/zip/dist 文件）——这一格以前没写清，容易被当成漏索引。

**两处人工核对（每仓各一个被排除、一个被索引）**：

| 仓 | 被排除的文件（`excludedInIndex=false`） | 被索引的文件（`indexedInIndex=true`） | 判得对不对 |
|---|---|---|---|
| `api_server` | `app/dao/internal/abnormal_user.go`：头两行 `// Code generated by GoFrame CLI tool. DO NOT EDIT.`，内容是 `gdb` 的字段映射 | `app/api/activity_goods.go`（手写 handler） | 对：前者是数据库表的镜像，后者是产品 |
| `upload-server` | `app/dao/internal/abnormal_user.go`（同上） | `app/api/file.go` | 对 |
| `123pan-slb` | `app/dao/internal/base_config.go` | `app/api/manage.go` | 对 |
| `transcode` | `app/dao/internal/file.go` | **`app/dao/file.go`**（同目录的孪生文件） | 对，且这一对最能说明问题：见下 |
| `offline-download` | `app/dao/internal/base_config.go` | `app/api/http_download.go` | 对 |
| `silentDataES` | `app/dao/internal/cluster.go` | `app/consumer.go` | 对 |
| `cdk_manager` | `app/dao/internal/cdk_batch_info.go` | `app/api/auth.go` | 对 |
| `gofs` | —（该仓 0 个生成文件） | `api/api.go` | 对 |
| `mount-disk-ws` | —（0 个） | `boot/boot.go` | 对 |
| `uuidsrv` | —（0 个） | `app/grpcserver/server.go` | 对 |

`transcode` 那一对是这套口径的核心证据：

```go
// app/dao/internal/file.go   ← 被排除（表镜像，开发者不会改）
// Code generated by GoFrame CLI tool. DO NOT EDIT.

// app/dao/file.go            ← 被索引（28 行的扩展点）
// This is auto-generated by GoFrame CLI tool only once. Fill this file as you wish.
type fileDao struct { *internal.FileDao }
```

GoFrame 的 `dao/*.go` 是「只生成一次、之后由人往里写方法」的壳子，`dao/internal/*.go` 才是
每次重新生成的表镜像。**我们只剔后者**——这正是「不按目录剔、按文件自己的话说」那条规矩
想要的结果。

**变体：没有观察到需要扩的，所以一行没改。** 10 个仓 1722 个候选 `.go` 里，被我们的正则
漏掉、但前 5 行出现 `DO NOT EDIT` 的文件 **0 个**；`protoc-gen-go` / `goctl` 的写法都带
`// Code generated … DO NOT EDIT.`，本来就在口径内。唯一「像但不是」的是上面那个
`auto-generated … only once. Fill this file as you wish.`——它**不该**被排除（排除它等于
丢掉开发者写的那些方法），所以现在的行为是对的。结论：**按观察到的样本，口径够用，未扩**。

**`vendor/`：这一轮仍然没被考验到。** 10 个样本仓 `vendor/` 文件数全为 0；把 66 个镜像
全扫一遍（`ls-tree -r | grep -cE '(^|/)vendor/'`）也是 **0 个仓**有 `vendor/`。
123pan 的 Go 服务全部走 modules、没有一个 `go mod vendor` 的产物被提交进来。
所以 `vendor/` 排除这一条**到现在为止仍是「写了但没被真数据验证过」**——它不会有害
（没有目录可剔），但它是否剔对，只能等第一个 vendor 仓出现时才知道。这是本轮的一个
明确缺口，写在这里而不是假装验过。

### 10.6 全量 72 名：45 存在、27 不存在

名单 `.superpowers/sdd/2026-11-08-index-value/go-repos.txt`（72 名，从 2026-04-16 的清单
抽的）。逐个 `git ls-remote --symref <url> HEAD` 验过；**网络抖动的失败不当结论**，
对失败项按 3–4 次退避重探，再用 `git clone` 二次确认：

| 分类 | 数量 | 判定依据 | 去向 |
|---|---|---|---|
| 存在且在清单里 | **45** | `ls-remote` 成功（其中 2 个默认分支不是 master：`silentDataES`=`dev`、`go-etag-worker`=`main`） | 写进 `config/repos.txt` |
| **不存在** | **27** | `remote: 未知的仓库路径，请检查仓库路径是否正确`（确定性，不是网络） | 不写清单；`repo_coverage` 各留一行 `ok=false` + 原因原文 |
| 分支不对 | 0 | — | — |
| 太大（磁盘闸拦下） | 0 | 磁盘闸从未触发（最大单仓 1.24 GB，可用 43.8 GB） | — |
| 网络（clone 三次仍失败） | 0（最终） | 中途 7 个仓失败，下一批重跑时全部成功 | — |

27 个不存在的：`artifacts`、`audit-tools`、`beats`、`cdn-admin`、`cdn-agent`、`cdn-dispatch`、
`cdn-go-proxy`、`cdn-manager`、`cdn-proxy`、`cloud-drive`、`coredns-cdn`、`crontab`、`crypto`、
`dispatch-monitor`、`download_peed`、`event-tracking`、`go-protobuf`、`gts`、`helper`、`log`、
`log-agent`、`ploto`、`redis`、`refresh-center-agent`、`sqlstring`、`tl`、`xgo`。

**2026-04-16 的清单在这一批上过期率 37.5%（27/72）。** 这个数本身就是结论：那份文档不能
当「有哪些仓」用，只能当「曾经有过什么」用。它同时解释了 §9.1 为什么要删 7 个仓——
同一类错误的第二次出现。27 个里 `cdn-*` 占 6 个、`cloud-drive`/`sqlstring`/`log` 都是
「名字很像存在」的那种，光看名字判断不了，只有 `ls-remote` 能。

接入过程（`onboard-repos.ts`，四批 + 续跑，能力面全部复用现成路径）：
第 1 批 12 个（5 个网络失败）、第 2 批 12 个（2 失败）、第 3 批 10 个（1 失败）、第 4 批 1 个
（0 失败）——最后一次 `rc=0`，`测量 1 个、跳过 65 个`，即 66 个仓全部有 `repo_coverage` 行。
失败仓在下一批被重试时成功，**没有一个是「静默丢掉」的**。

### 10.7 Go 覆盖率表（51 个仓，按 `files_indexed/files_total` 升序）

`files_indexed == 0` 的仓：**0 个**。这一格是这张表存在的理由（「cloned but invisible」），
这一轮 51 个 Go 仓一个都没有踩到。

| 仓 | indexed/total | 跳过生成 | 轮廓 | HEAD | HEAD 日期 |
|---|---|---|---|---|---|
| `go-async-etag-worker` | 22/114 | 0 | 22 | `75c0e76c` | 2026-08-06 |
| `gcache-adapter` | 1/5 | 0 | 1 | `81b5b833` | 2024-05-23 |
| `health_check` | 2/9 | 0 | 2 | `4d809103` | 2026-08-06 |
| `get_domain` | 2/8 | 0 | 2 | `7aa11b72` | 2026-08-06 |
| `123pan-slb` | 54/189 | 12 | 52 | `84225237` | 2026-08-28 |
| `gofs` | 21/59 | 0 | 21 | `f469b09c` | 2023-04-29 |
| `binlog_go_new` | 7/18 | 0 | 7 | `e4ca89dd` | 2026-02-05 |
| `getconfig-api` | 28/68 | 0 | 28 | `dc076d64` | 2026-11-03 |
| `log-agent-client` | 10/23 | 2 | 7 | `e89e355f` | 2023-04-12 |
| `reference-count-worker` | 22/50 | 0 | 22 | `6aaf3882` | 2026-05-21 |
| `go-cloud-capacity-worker` | 24/54 | 0 | 24 | `d000f8f2` | 2026-05-19 |
| `silentDataES` | 19/41 | 7 | 19 | `d4b8dc98` | 2025-06-15 |
| `go-thumbnail` | 7/15 | 0 | 7 | `7e8f7629` | 2026-04-29 |
| `go-etag-worker` | 25/52 | 0 | 25 | `4c3fcdca` | 2026-08-06 |
| `batch-process-data-worker` | 9/18 | 0 | 9 | `5f138731` | 2026-10-10 |
| `audit-consumer` | 24/43 | 7 | 23 | `a17d509c` | 2026-08-06 |
| `gf16` | 428/765 | 0 | 412 | `286501fd` | 2026-09-14 |
| `apisrv` | 352/624 | 231 | 330 | `199cd433` | 2026-11-06 |
| `usercenter` | 38/67 | 7 | 31 | `2caf4507` | 2023-10-24 |
| `123pan-traffic` | 144/252 | 52 | 139 | `9965114e` | 2026-11-04 |
| `silentDataBinlog` | 8/14 | 0 | 8 | `d25f0fb8` | 2025-06-20 |
| `mount-disk-ws` | 11/19 | 0 | 11 | `c04d125f` | 2026-08-06 |
| `upload-consumer` | 28/48 | 12 | 26 | `b622410a` | 2026-11-03 |
| `pay_server` | 174/296 | 95 | 163 | `d1f7c0c8` | 2026-11-03 |
| `transcode` | 53/89 | 3 | 43 | `24126b6d` | 2026-11-04 |
| `contentTreeSrv` | 35/58 | 12 | 26 | `b3aed6dd` | 2026-10-19 |
| `api_server` | 586/960 | 298 | 561 | `90f78f46` | 2026-11-03 |
| `123pan_manager` | 542/885 | 284 | 532 | `46a73482` | 2026-11-06 |
| `binlog-srv` | 8/13 | 0 | 7 | `1a509433` | 2026-07-08 |
| `gf-jwt` | 8/13 | 0 | 7 | `8325f78d` | 2026-05-07 |
| `uuidsrv` | 8/13 | 0 | 7 | `21d49cae` | 2026-08-06 |
| `new_audit` | 15/24 | 0 | 14 | `ef11497b` | 2023-05-16 |
| `upload-server` | 152/241 | 73 | 145 | `1c21122c` | 2026-11-03 |
| `file-analysis-worker` | 12/19 | 0 | 11 | `0630478e` | 2026-09-11 |
| `osssrv` | 40/62 | 12 | 33 | `161c3cbc` | 2026-09-18 |
| `s3-migration` | 20/31 | 7 | 20 | `c691fb1e` | 2023-04-29 |
| `cdk_manager` | 27/41 | 5 | 25 | `ab413aba` | 2026-08-06 |
| `resource_manager` | 37/56 | 11 | 35 | `1a985235` | 2026-10-10 |
| `offline-download` | 49/73 | 9 | 44 | `aa81f6dc` | 2026-10-20 |
| `binlog-to-elasticsearch` | 25/36 | 3 | 23 | `5763d3ac` | 2026-09-22 |
| `metrics-consumer` | 21/30 | 3 | 16 | `725809cf` | 2026-08-06 |
| `cloud-drive-migration` | 62/88 | 2 | 57 | `3aaad51a` | 2026-07-08 |
| `uncompress_srv` | 43/58 | 6 | 40 | `3fb09f40` | 2026-11-05 |
| `cloud-disk-ws` | 29/39 | 0 | 24 | `81d83811` | 2026-08-06 |
| `dispatch` | 41/52 | 0 | 39 | `b17e0c8c` | 2023-03-23 |
| `123pan-piecehash` | 29/36 | 1 | 27 | `cc15d2fd` | 2026-09-30 |
| `OpenAPI` | 106/130 | 10 | 100 | `3cdbc576` | 2026-11-03 |
| `webdav` | 218/262 | 0 | 192 | `717f48d8` | 2026-09-10 |
| `123pan-pc-go` | 99/114 | 5 | 94 | `a99a8821` | 2026-09-22 |
| `api_server_restful` | 102/115 | 0 | 99 | `8f81ae7a` | 2026-11-02 |
| `123pan-dylib-go` | 46/50 | 0 | 35 | `41a9d6fd` | 2023-05-23 |

51 个仓合计：`files_total` 6439、`files_indexed` 3873（60.1%）、`files_skipped_generated` 1169。
**分母里 18% 是生成代码**（1169/6439），这个数不是「看不见」，是「正当跳过」——`apisrv`
231 与 `api_server` 298、`123pan_manager` 284 是三个大头，全是 GoFrame 的 `dao/internal`。

底部那几行（`go-async-etag-worker` 22/114、`gcache-adapter` 1/5、`health_check` 2/9）
不是漏索引：它们的树里多是 `.md`/`.yaml`/`go.mod`/脚本与图片，`.go` 本来就个位数。
**`imports` 一列在 51 个 Go 仓里全是 0**——`imports` 是「前端模块解析」那条线的产物，
Go 解析器不产 import 边。§4 写的「`imports = 0` 是解析进去了但连不起来的信号」**对 Go 仓
不成立**，这一条要在读材料时被记住，否则下一个看表的人会把 51 个 0 当成 51 个故障。

### 10.8 磁盘、行数、以及 7 GB 那个投影

| 项 | 数值 |
|---|---|
| 本批新建镜像（45 个 Go 仓） | **4.43 GB**（`du -sk` 合计） |
| `/srv/123pan-mirror` 全量（66 个仓） | **10.31 GB** |
| 服务器可用 | 44.72 GB → **42.24 GB**（净减 **4.44 GB**） |
| `blob_index` 行数 | 3607 → **6639**（+3032） |
| `blob_index` 体积 | 4.5 MB |
| 其中 `lang='go'` 的块 | 3757 |
| `repo_coverage` 行数 | 28 → **100**（66 `ok=true` + 34 `ok=false`：7 个 §9.1 删掉的 + `sqlstring` + 26 个本轮判不存在的） |
| `requirements` | **815 行**（本轮一行未写；开工前后按 state 的分布完全一致：live 265 / inbox 248 / design 107 / shelved 98 / rejected 73 / queue 17 / test 3 / review 2 / dev 1 / ready 1） |

**7 GB 那个投影：数字上几乎对，但它对得没有意义。** 实测 45 个 Go 仓 4.43 GB，
按「每个名字的平均字节 × 72 个名字」外推到 7.1 GB——看起来 7 GB 很准。但分布不是均值分布：

```
中位   1.33 MB
均值 100.72 MB     ← 中位的 75 倍
最大   1.24 GB     （binlog_go_new，18 个可索引文件）
次大   1.11 GB     （getconfig-api，68 个可索引文件）
前二合计 2.32 GB = 全部 4.43 GB 的 52%
```

也就是说：**下一批 30 个仓可能是 0.04 GB，也可能是 3 GB**，取决于里面有没有「把二进制/
构建产物提交进历史」的仓——`binlog_go_new` 只有 18 个可索引文件却有 1.24 GB 的 pack，
它的体积与代码量完全无关。用均值 7 GB 去预留磁盘，会在「恰好没有重仓」的批次上浪费，
在「连着两个 binlog_go_new」的批次上撞水位。§4 那条「两簇」的结论在这一批上被第二次
证实，而且更尖锐：**重仓与否只能 clone 之后量**（`--budget-gb` 的默认外推用的是中位数，
所以它对这一批给的是 0.1 GB，实际上用了 4.43 GB——外推在这里低估 44 倍）。

磁盘水位没有触发：最紧张的一刻是 40.3 GB 可用（水位 10 GB），离拦截很远。

### 10.9 这个规模下会继续变坏的东西（按「多久会被撞到」排序）

1. **`rc=3` 又要变成「每晚都红」了。** 66 个仓、10.6% 的单仓失败率，意味着**每一轮都有
   7–10 条 `FAIL`**，3 轮端到端全 `rc=3`（并行前后都一样）。21 个仓时这个数还是 1–6 条，
   还能一条条看；90 个仓时会是 9–12 条。§9.1 花了一节论证「每晚都红等于没有红」，这一条
   正在以另一种方式回来：不是残留的不存在仓，而是 codeup 自身的抖动 × 仓数。
   **该做（未做）**：把「上游整体不可达」（DNS 级、所有仓同时失败）与「个别仓失败」分开
   ——前者不该是一个需要人看的告警，后者才该。现在的 rc 只有一档 3。
2. **`imports = 0` 在 Go 仓里是恒真。** 见 §10.7：51 个 0 会让任何「imports=0 就是坏了」的
   读法失效。材料侧必须按语言分流，或者 Go 仓那一列干脆不显示。
3. **`files_indexed == 0` 这一格会一直是 0。** 不是因为我们做对了，而是因为 Go 仓的
   `.go` 一律落 `service`（`classifyKind` 的 `.go` 分支），没有「目录约定」可踩空。
   真正会踩空的是**非 Go、非前端**的仓（Java/Python 那些）——它们接进来时这一格才会亮。
4. **`blob_index` 的增长是内容地址的，不是仓数的。** 45 个 Go 仓只多了 3032 行（2.5 KB/仓
   量级），因为 GoFrame 脚手架在仓之间高度重复。这很好，但它掩盖了一个前提：**生成代码
   不入库**，所以这 3032 行里没有一块是 `dao/internal`。如果哪天有人把
   `--force-reparse` 跑一遍，这 1169 个生成文件会以「已解析」的形式重新试图入库（`isGeneratedSource`
   会让它们再次被跳过，但代价是 1169 次读取）——重扫成本按**树里的文件数**算，不按行数算。
5. **`repo_coverage` 里 34 行 `ok=false` 会让「覆盖率」这个说法变得含糊。** 66 个 `ok=true`
   是真实接入面；34 行里 26 个是「这个仓不存在」、7 个是 §9.1 删掉的、1 个是 `sqlstring`。
   读侧不遍历表，所以不影响判断；但「表 100 行、清单 66 个仓」这个差，下一个人还会问一次。
6. **`123pan-slb` 那类「镜像 285 个文件、分母只有 189」的仓会持续制造误解。** `files_total`
   是**去噪后**的树，不是 `ls-tree` 的行数；这一轮把它写进了 §10.5，但表上没有列能区分
   「噪声 96 个」与「漏索引 96 个」。**该做（未做）**：在 `repo_coverage` 加一列
   `files_noise`，或者报告里固定打一行「树 N / 去噪 M / 索引 K / 生成 G」。

### 10.10 mutation 表（本轮）

| 文件 | 动作 | 为什么 / 风险 |
|---|---|---|
| `scripts/sync-mirrors.sh` | 改（串行 → `xargs -P`，默认 8；逐仓缓冲；rc 聚合；`exec 9>&-`） | 服务器上 05:05 那条 cron 跑的就是它。失败语义、四档 rc、日志行格式**一字未变**；新增只有 `SYNC_JOBS` 与两行 `NOTE`。回滚 = `install-cron.sh --server` 覆盖回旧版 |
| `config/repos.txt` | +45 行（10 个阶段二样本 + 35 个其余存在的 Go 仓），文件 104 → 169 行 | 纯数据。27 个不存在的**没有**写进来（理由见 §10.6） |
| `app_settings.code.mirror.repos` | 21 → 66（`repos-apply.ts` 播种，读侧校验一致） | 读侧自动认得新仓；`index-nightly` 从 05:10 起会索引 66 个仓 |
| `repo_coverage` | +45 行 `ok=true`、+26 行 `ok=false`（不存在）、`sqlstring` 1 行 `ok=false` | 一行未删；§9.1 的 7 个孤儿行原地保留 |
| `blob_index` | +3032 行 | 内容地址，`on conflict do nothing`，跨仓共享；未做任何 `forgetBlobs` |
| `requirements` | **未动**（815 行，state 分布与开工前逐项相同） | 不 reseed |
| `scripts/install-cron.sh` | 改 `--check` 的退出码（漂了 → 3） | 只动 `check()`；`--server` / `--local` / `--remove` 一字未变 |
| `src/core/locate/*`、解析器规则、通知逻辑、迁移 | **未动** | 本轮改的代码只有 `scripts/sync-mirrors.sh` 与 `install-cron.sh` 的 `--check` |

### 10.11 复现

```bash
# 1) 同步：并行前后各跑几轮（交错，别串行跑完再并行跑——codeup 有自己的时段）
ssh dogyun 'SYNC_JOBS=8 SYNC_FLOWERS_LOG=/tmp/x.log REPOS_FILE=/opt/123pan/tools/_ro/repos.txt \
  /opt/123pan/tools/_ro/sync-flowers-mirror.sh; echo rc=$?'

# 2) 合成 60/90 条（走 fetch 失败路径：先给不存在的上游各建一个空 bare 镜像）
for i in $(seq -w 1 90); do git init --bare --quiet /tmp/mirror60/no-such-repo-$i.git; done
MIRROR_ROOT=/tmp/mirror60 SYNC_JOBS=8 scripts/sync-mirrors.sh   # 需在 Linux 上（flock）

# 3) 排除口径的地面真值（不经过我们的正则）
git --git-dir=/srv/123pan-mirror/<仓>.git ls-tree -r --name-only HEAD \
  | grep '\.go$' | grep -vE '(^|/)(vendor|third_party|testdata)/' | grep -v '_test\.go$' \
  | while read f; do git --git-dir=... show "HEAD:$f" | head -5 \
      | grep -qE '(//|/\*)[[:space:]]*Code generated .*DO NOT EDIT\.' && echo "$f"; done | wc -l
#   与 select files_skipped_generated from repo_coverage where repo='<仓>' 比

# 4) 覆盖率表
docker exec flowers-db-1 psql -U postgres -d flowers -c \
 "select repo, files_indexed||'/'||files_total as ratio, files_skipped_generated, outline_files
    from repo_coverage where ok order by files_indexed::float/greatest(files_total,1)"
```

## 11. 第五轮（2026-11-09 上午）：URL 拼错了 —— 144 个仓的全量接入

这一轮先纠正一件事：**前几轮那些「仓不存在」是假的**。`ListRepositories`（云效 OpenAPI，
`x-total: 144`）的返回落在 `.superpowers/sdd/2026-11-08-index-value/real-repos.tsv`（一行
`name<TAB>groupPath`）与 `real-repos.json`（原始载荷）。照着它把 144 条路径逐个
`git ls-remote` 探完之后，34 个失败里 **27 个是地址问题**，不是现实。

### 11.1 根因：克隆地址被「拼」出来，而组路径是仓的属性

旧地址是 `https://codeup.aliyun.com/60f9058e68e2993a8e6d0750/123pan/<仓名>.git`——把
「仓在哪个组」写死成 `123pan`。真实分布（144 条路径按第一段）：

| 位置 | 仓数 | 例子 |
|---|---|---|
| 组织根（path 就是仓名） | 24 | `artifacts`、`trafficserver`、`ats-9.0.2`、`cdn-admin`、`Web-Nexus` |
| `123pan/` | 96 | `123pan/apisrv`、`123pan/review` |
| `cdn-groups/` | 12 | `cdn-groups/beats`、`cdn-groups/gts` |
| `test-groups/` | 10 | `test-groups/tl`、`test-groups/platform-api` |

于是 `…/123pan/artifacts.git` 得到的回答是 `remote: 未知的仓库路径，请检查仓库路径是否正确`
——一句听起来像「这个仓不存在」的话，`repo_coverage.error` 就照抄成了「不存在」。**这是同
一个错误在两处各写了一次**（`sync-mirrors.sh` 的 `$CODEUP_BASE/$repo.git`、
`onboard-repos.ts` 的一行模板字符串），错的地方一致，所以错得很像真的。

修法只有一条：**地址只拼一次**，输入是清单里的 `path=`。`repo-inventory.ts` 的
`cloneUrlOf()` 是唯一那一处，`sync-mirrors.sh` 与 `onboard-repos.ts` 都从它（或它的 bash
等价物）拿地址。

### 11.2 清单格式：多一格 `path=`，镜像目录名一个都没改

```
<仓名><空白><分支>[<空白>path=<组路径>][<空白>stale=<天数>|never]
```

```text
apisrv                  master         path=123pan/apisrv
artifacts               master         path=artifacts
beats                   master         path=cdn-groups/beats
performance_front_test  lighthouse_v1  path=test-groups/performance_front_test
review                  master         path=123pan/review   stale=never
```

- `path=` 是**组织相对、含仓名**的整条路径（与 TSV 第二列逐字相同）；缺省 = `123pan/<仓名>`
  （旧清单逐行读出来仍指向原地址，并留一条 note）。
- 第三格起是 `key=value`（`path=` / `stale=`）；光着写 `never`/正整数仍按 `stale` 读（历史
  写法）。为什么不是「再加两个位置格」：`stale` 是可选的，可选位置格与下一格天生分不开。
- 校验多一条：**`path` 的最后一段必须等于仓名**。镜像目录按仓名建、地址按 path 拼，不相等
  时的错法是安静的（目录里躺着 A 仓，每晚去 fetch B 仓）。
- **镜像目录名不改**（仍是 `/srv/123pan-mirror/<仓名>.git`）：66 个老镜像一个都没动，改的只是
  URL。这样「改名 66 个目录 + 改 66 条设置」里漏一个就换仓的风险直接不存在。

同步脚本把 `CODEUP_BASE`（旧语义：`…/123pan`）换成 `CODEUP_ORG`（组织根）；旧变量仍然认，
但值以 `/123pan` 结尾时会剥掉尾巴并在日志里留一行 `NOTE`——否则拼出来多一层 `/123pan`，
整轮 fetch 全红，而原因藏在变量语义里。

### 11.3 144 → 142：重名两份与归档那一份怎么处理的

| 仓名 | 两个路径 | 取哪一个 | 为什么 |
|---|---|---|---|
| `artifacts` | `artifacts` / `cdn-groups/artifacts` | `artifacts`（根） | `lastActivityAt` 2026-10-30 vs 2026-01-13 |
| `go-protobuf` | `go-protobuf` / `cdn-groups/go-protobuf` | `go-protobuf`（根） | 2026-11-09 vs 2026-01-13（昨天还在动） |

owner 给的判据是「取 `lastActivityAt` 更新的那份」，实测**与直觉相反**：两个 `cdn-groups/`
副本都停在 2026-01-13（像某次一次性推送留下的），根下那两份才是活的。所以两份都取根下。
被放弃的两条路径写在 **`config/repos-excluded.txt`**（一行一理由）——它们不能进
`config/repos.txt`（同名是硬错误），但也不能就这么消失，否则「不遗不漏」少两个。

归档的那一个：`123pan/review`（`archived: true`，最后活动 2021-08-19）。**归档 ≠ 不存在**，
所以它仍然建镜像、仍然索引（`0/1`，树里只有一个 `README.md`），只是在清单里写
`stale=never`——沿用「上游已归档，不因上游不动了提醒」那个哨兵，同步失败照样报。

### 11.4 分支：144 条路径逐个 `ls-remote --symref` 探过

`master` 133、`main` 5、`dev` 2、`v1` 1（`usercenter`）、`lighthouse_v1` 1
（`performance_front_test`）。这份分支表不是猜的：144 条路径跑了两轮探测（第一轮 60 条被
codeup 的 DNS/443 抖动打掉，第二轮逐条重试四次），143 条拿到默认分支；剩下 `gocron`
是**空仓**（`ls-remote` 成功但没有 HEAD）。

### 11.5 接入结果：66 → 141 个镜像，覆盖率 139 行 `ok=true`

| 项 | 结果 |
|---|---|
| 清单 | `config/repos.txt`：**142** 个仓（另 84 行注释/空行），= 144 − 2 重名放弃 |
| 设置 | `code.mirror.repos` 66 → **142**（`repos-apply.ts`，读侧回读一致） |
| 服务器 | 镜像 **66 → 141** 个（`gocron` 空仓不建：一个 ref 都没有，建了也只是每晚一条 FAIL） |
| 覆盖率 | **139 行 `ok=true`、3 行 `ok=false`**；142 行覆盖 142 个仓，外加 2 条显式排除 = **144** |
| 树文件 | `files_total` 合计 **51,329**（已去掉 vendor/dist/图片等噪音路径），`files_indexed` 合计 **9,936** |
| 页面 / import | `pages` **193**、`imports` **12,459** |
| 磁盘 | `/srv/123pan-mirror` **10.31 GB → 25.58 GB**（+15.27 GB）；可用空间最低见到 **24.9 GB** |
| `blob_index` | **6,639 → 9,231** 行（+2,592：内容地址让 139 个仓只新增 2.6k 行） |
| 用例 | `npx vitest run`：**79 个文件、1674 通过 / 1 跳过** |

磁盘水位 10 GB（`DEFAULT_DISK_FLOOR_GB`）**一次都没接近过**：最坏时刻离它还有约 15 GB。
这不是运气——144 个仓里文件最多的三个（`frontend` 3.2k、`trafficserver` 4.3k、
`openresty-cdn-gateway` 2.8k）镜像都在 0.1–0.5 GB 量级；真正大的是 `beats`（552 MB，
因为里面提交了一个 106 MB 的 `mfy_self_build/filebeat`）。

### 11.6 那 34 个「失败」重跑的结果：30 个现在就进得来

| 结论 | 个数 | 是哪些 |
|---|---|---|
| 现在 `ok=true` | **30** | 含 27 个原先被判「不存在」的（`artifacts` 108/155、`cloud-drive` 484/559、`123pan-ssr` 321/700、`coredns-cdn` 318/808、`cdn-manager` 212/436…） |
| 仍失败 | 2 | `beats`（索引读不完，见 11.9）、`platform-fontend`（索引挂住，见 11.9） |
| 不在 144 里 | 2 | `ploto`、`sqlstring`——API 里没有这两个仓。**旧行不删**（那是证据），但它们是历史行，不计入 144 的分母 |

也就是说：原 34 个里 **32 个在权威清单内，其中 30 个现在通过**；剩下 2 个是解析层的两个
不同问题，不是地址问题。

### 11.7 142 行覆盖率（按 `files_indexed / files_total` 升序；`—` = 没测成）

| 仓 | 组路径 | 索引/树 | 比例 | 跳过生成 | 页面 | 轮廓 | import | 树里最像的几种文件 / 失败原因 |
|---|---|---|---|---|---|---|---|---|
| `beats` | `cdn-groups/beats` | — | — | — | — | — | — | 索引失败（树里 11958 个文件）：git cat-file 读取超时：20 秒内没有返回 |
| `gocron` | `gocron` | — | — | — | — | — | — | 远端是空仓（clone 成功但一个 ref 都没有，索引无从下手） |
| `platform-fontend` | `test-groups/platform-fontend` | — | — | — | — | — | — | 索引挂起：抽取阶段同步阻塞（25 分钟无任何进展，连 --index-timeout-s 240 的看门狗都不触发，说明事件循环被同步占死而不是某个 ssh 回调不回）。镜像与 HEAD 均正常（ee47b36，574  |
| `123pan-gateway` | `123pan/123pan-gateway` | 0/49 | 0.0% | 0 | 0 | 0 | 0 | lua:39 sh:4 md:2 (noext):1 |
| `123pan_app_package` | `123pan/123pan_app_package` | 0/456 | 0.0% | 0 | 0 | 0 | 0 | dart:253 webp:74 png:45 java:32 |
| `ai-test-agent` | `test-groups/ai-test-agent` | 0/86 | 0.0% | 0 | 0 | 0 | 0 | py:73 md:3 yml:1 txt:1 |
| `app` | `123pan/app` | 0/1414 | 0.0% | 0 | 0 | 0 | 0 | dart:516 svg:462 webp:296 png:234 |
| `app_tv` | `123pan/app_tv` | 0/171 | 0.0% | 0 | 0 | 0 | 0 | dart:113 png:60 webp:25 xml:11 |
| `ats-9.0.2` | `ats-9.0.2` | 0/3933 | 0.0% | 0 | 0 | 0 | 0 | cc:827 h:754 rst:531 po:444 |
| `backup-disk` | `123pan/backup-disk` | 0/32 | 0.0% | 0 | 0 | 0 | 0 | h:16 cpp:10 vcxproj:1 sln:1 |
| `cdn` | `cdn-groups/cdn` | 0/159 | 0.0% | 0 | 0 | 0 | 0 | lua:46 sh:33 yml:28 (noext):14 |
| `cdn-cp` | `cdn-cp` | 0/7 | 0.0% | 0 | 0 | 0 | 0 | sh:3 (noext):1 md:1 ipdb:1 |
| `cron-scripts` | `123pan/cron-scripts` | 0/28 | 0.0% | 0 | 0 | 0 | 0 | py:25 DS_Store:2 conf:1 |
| `defense-nginx` | `123pan/defense-nginx` | 0/167 | 0.0% | 0 | 0 | 0 | 0 | lua:127 conf:10 (noext):7 md:7 |
| `devops` | `123pan/devops` | 0/180 | 0.0% | 0 | 0 | 0 | 0 | rs:80 xml:31 py:10 yaml:9 |
| `go-protobuf` | `go-protobuf` | 0/199 | 0.0% | 98 | 0 | 0 | 0 | proto:98 go:98 sum:1 mod:1 |
| `jmeter-offline` | `test-groups/jmeter-offline` | 0/26 | 0.0% | 0 | 0 | 0 | 0 | jar:346 sh:9 txt:5 md:5 |
| `minio_deploy` | `123pan/minio_deploy` | 0/76 | 0.0% | 0 | 0 | 0 | 0 | conf:36 sh:21 (noext):10 key:2 |
| `mount-disk` | `123pan/mount-disk` | 0/2160 | 0.0% | 0 | 0 | 0 | 0 | h:1662 hpp:589 png:145 cpp:135 |
| `mq_copy` | `123pan/mq_copy` | 0/1 | 0.0% | 0 | 0 | 0 | 0 | MD:1 |
| `nginx-proxy` | `123pan/nginx-proxy` | 0/159 | 0.0% | 0 | 0 | 0 | 0 | lua:127 (noext):7 md:7 default:6 |
| `openresty-cdn-gateway` | `cdn-groups/openresty-cdn-gateway` | 0/2756 | 0.0% | 0 | 0 | 0 | 0 | t:689 c:535 h:444 lua:300 |
| `performance_front_test` | `test-groups/performance_front_test` | 0/16 | 0.0% | 0 | 0 | 0 | 0 | py:11 sh:2 txt:1 md:1 |
| `php-audit` | `123pan/php-audit` | 0/37 | 0.0% | 0 | 0 | 0 | 0 | php:1718 json:59 md:32 rst:30 |
| `platform-api` | `test-groups/platform-api` | 0/608 | 0.0% | 0 | 0 | 0 | 0 | py:565 patch:22 log:4 json:3 |
| `review` | `123pan/review` | 0/1 | 0.0% | 0 | 0 | 0 | 0 | md:1 |
| `thumbnail` | `123pan/thumbnail` | 0/16 | 0.0% | 0 | 0 | 0 | 0 | (noext):6 default:6 conf:2 types:1 |
| `trafficserver` | `trafficserver` | 0/4279 | 0.0% | 0 | 0 | 0 | 0 | cc:885 h:806 rst:558 po:443 |
| `transcode-proxy` | `123pan/transcode-proxy` | 0/2742 | 0.0% | 0 | 0 | 0 | 0 | t:714 c:538 h:444 lua:266 |
| `video_audit_work` | `123pan/video_audit_work` | 0/1 | 0.0% | 0 | 0 | 0 | 0 | md:1 |
| `windows-component` | `123pan/windows-component` | 0/182 | 0.0% | 0 | 0 | 0 | 0 | h:116 hpp:45 cpp:7 pro:3 |
| `app_plugin` | `123pan/app_plugin` | 1/4736 | 0.0% | 0 | 0 | 0 | 0 | dart:1482 ets:455 png:375 java:251 |
| `kong-2.5.0` | `kong-2.5.0` | 1/838 | 0.1% | 0 | 0 | 1 | 0 | lua:645 t:89 md:14 crt:13 |
| `123pan-ele-react` | `123pan/123pan-ele-react` | 6/544 | 1.1% | 0 | 2 | 2 | 18 | png:287 nsh:220 nlf:116 ico:68 |
| `Web-Nexus` | `Web-Nexus` | 47/4187 | 1.1% | 0 | 0 | 35 | 92 | tsx:1006 md:975 svg:930 ts:648 |
| `123pan-video` | `123pan-video` | 2/106 | 1.9% | 0 | 0 | 0 | 0 | js:38 svg:28 less:13 md:9 |
| `123pan-virtuallist-antd` | `123pan/123pan-virtuallist-antd` | 1/38 | 2.6% | 0 | 0 | 1 | 1 | md:13 tsx:10 js:7 json:2 |
| `crazy-api` | `test-groups/crazy-api` | 41/534 | 7.7% | 0 | 0 | 0 | 84 | js:364 png:189 scss:66 jpg:53 |
| `web-ui-test` | `test-groups/web-ui-test` | 13/90 | 14.4% | 0 | 0 | 5 | 19 | ts:30 yaml":24 json:15 js:8 |
| `download_peed` | `download_peed` | 41/235 | 17.4% | 0 | 0 | 39 | 0 | dart:75 go:48 png:41 md:9 |
| `app-ui-test` | `test-groups/app-ui-test` | 8/44 | 18.2% | 0 | 0 | 0 | 15 | html:27 ts:13 json:2 md:1 |
| `123pan-cross-frontend` | `123pan/123pan-cross-frontend` | 24/130 | 18.5% | 0 | 4 | 13 | 83 | ts:50 tsx:29 less:24 png:14 |
| `go-direct-link-worker` | `123pan/go-direct-link-worker` | 21/109 | 19.3% | 0 | 0 | 21 | 0 | conf:69 json:42 go:28 (noext):4 |
| `go-async-etag-worker` | `123pan/go-async-etag-worker` | 22/114 | 19.3% | 0 | 0 | 22 | 0 | json:75 conf:73 go:29 (noext):4 |
| `gcache-adapter` | `123pan/gcache-adapter` | 1/5 | 20.0% | 0 | 0 | 1 | 0 | sum:1 mod:1 md:1 go:1 |
| `123pan-uni-app` | `123pan/123pan-uni-app` | 142/639 | 22.2% | 0 | 27 | 97 | 580 | svg:442 vue:102 png:87 ts:73 |
| `health_check` | `123pan/health_check` | 2/9 | 22.2% | 0 | 0 | 2 | 0 | go:2 gitignore:2 toml:1 sum:1 |
| `123pan-pc` | `123pan/123pan-pc` | 137/582 | 23.5% | 0 | 2 | 94 | 507 | ts:184 svg:96 dll:87 png:86 |
| `Nimbus` | `123pan/Nimbus` | 47/193 | 24.4% | 0 | 3 | 28 | 129 | png:93 svg:87 ts:37 js:22 |
| `cdn-proxy` | `cdn-proxy` | 1/4 | 25.0% | 0 | 0 | 1 | 0 | mod:1 md:1 go:1 gitignore:1 |
| `get_domain` | `123pan/get_domain` | 2/8 | 25.0% | 0 | 0 | 2 | 0 | sh:2 go:2 toml:1 sum:1 |
| `event-tracking` | `cdn-groups/event-tracking` | 15/59 | 25.4% | 7 | 0 | 12 | 0 | go:22 gitkeep:14 yaml:8 sh:3 |
| `phoenix-share` | `123pan/phoenix-share` | 238/895 | 26.6% | 0 | 0 | 167 | 1055 | png:307 svg:223 ts:209 tsx:176 |
| `123pan-slb` | `123pan/123pan-slb` | 54/189 | 28.6% | 12 | 0 | 52 | 0 | js:76 gif:75 go:69 css:12 |
| `save-copy-worker` | `123pan/save-copy-worker` | 45/156 | 28.8% | 0 | 0 | 39 | 0 | json:91 conf:89 go:54 (noext):4 |
| `123pan-windowsPro` | `123pan-windowsPro` | 154/521 | 29.6% | 0 | 14 | 84 | 659 | png:129 js:117 nsh:110 ts:82 |
| `copy-file-worker` | `123pan/copy-file-worker` | 29/97 | 29.9% | 0 | 0 | 27 | 0 | json:52 conf:48 go:36 (noext):4 |
| `coverage` | `test-groups/coverage` | 23/71 | 32.4% | 0 | 0 | 23 | 0 | sh:24 (noext):24 go:23 |
| `frontend` | `123pan/frontend` | 1144/3241 | 35.3% | 0 | 27 | 874 | 4881 | ts:938 md:933 tsx:583 png:391 |
| `gofs` | `123pan/gofs` | 21/59 | 35.6% | 0 | 0 | 21 | 0 | go:27 sh:5 png:4 md:4 |
| `go-kafka-service` | `123pan/go-kafka-service` | 14/38 | 36.8% | 0 | 0 | 14 | 0 | go:14 json:13 conf:10 (noext):4 |
| `share` | `123pan/share` | 201/530 | 37.9% | 0 | 0 | 150 | 830 | png:255 svg:173 ts:142 tsx:131 |
| `eslint-config` | `123pan/eslint-config` | 33/86 | 38.4% | 0 | 1 | 15 | 95 | ts:34 less:14 tsx:13 js:7 |
| `binlog_go_new` | `123pan/binlog_go_new` | 7/18 | 38.9% | 0 | 0 | 7 | 0 | go:7 (noext):4 conf:3 json:2 |
| `coredns-cdn` | `cdn-groups/coredns-cdn` | 318/808 | 39.4% | 2 | 0 | 294 | 0 | go:608 md:126 7:51 (noext):6 |
| `crontab` | `crontab` | 2/5 | 40.0% | 0 | 0 | 2 | 0 | go:2 sum:1 mod:1 md:1 |
| `getconfig-api` | `123pan/getconfig-api` | 28/68 | 41.2% | 0 | 0 | 28 | 0 | go:36 conf:18 json:17 (noext):4 |
| `transfer-schedul-worker` | `123pan/transfer-schedul-worker` | 23/55 | 41.8% | 0 | 0 | 23 | 0 | go:32 json:13 conf:11 (noext):5 |
| `log-agent-client` | `123pan/log-agent-client` | 10/23 | 43.5% | 2 | 0 | 7 | 0 | go:12 gitkeep:4 (noext):2 yaml:1 |
| `reference-count-worker` | `123pan/reference-count-worker` | 22/50 | 44.0% | 0 | 0 | 22 | 0 | go:30 json:11 conf:9 (noext):4 |
| `crypto` | `crypto` | 4/9 | 44.4% | 0 | 0 | 4 | 0 | go:7 mod:1 md:1 |
| `go-cloud-capacity-worker` | `123pan/go-cloud-capacity-worker` | 24/54 | 44.4% | 0 | 0 | 24 | 0 | go:32 json:11 conf:9 (noext):4 |
| `123pan-ssr` | `123pan-ssr` | 321/700 | 45.9% | 0 | 21 | 211 | 1241 | png:368 tsx:199 ts:188 less:156 |
| `cdn-agent` | `cdn-groups/cdn-agent` | 34/74 | 45.9% | 7 | 0 | 31 | 0 | go:42 gitkeep:14 yaml:8 (noext):3 |
| `silentDataES` | `123pan/silentDataES` | 19/41 | 46.3% | 7 | 0 | 19 | 0 | go:29 (noext):4 toml:2 sh:2 |
| `go-thumbnail` | `123pan/go-thumbnail` | 7/15 | 46.7% | 0 | 0 | 7 | 0 | go:9 toml:1 sh:1 (noext):1 |
| `copy-file-schedule-worker` | `123pan/copy-file-schedule-worker` | 23/49 | 46.9% | 0 | 0 | 23 | 0 | go:30 json:11 conf:9 (noext):4 |
| `go-etag-worker` | `123pan/go-etag-worker` | 25/52 | 48.1% | 0 | 0 | 25 | 0 | go:32 json:11 conf:9 (noext):4 |
| `new-year-worker` | `123pan/new-year-worker` | 25/52 | 48.1% | 0 | 0 | 25 | 0 | go:32 json:10 conf:9 (noext):4 |
| `cdn-manager` | `cdn-groups/cdn-manager` | 212/436 | 48.6% | 180 | 0 | 196 | 0 | go:401 gitkeep:14 yaml:8 (noext):4 |
| `grpc` | `cdn-groups/grpc` | 212/436 | 48.6% | 180 | 0 | 196 | 0 | go:401 gitkeep:14 yaml:8 (noext):4 |
| `batch-process-data-worker` | `123pan/batch-process-data-worker` | 9/18 | 50.0% | 0 | 0 | 9 | 0 | go:11 yml:1 toml:1 sql:1 |
| `share-consumer` | `123pan/share-consumer` | 19/38 | 50.0% | 1 | 0 | 16 | 0 | go:23 xml:4 DS_Store:3 yml:1 |
| `123pan-image-hosting` | `123pan/123pan-image-hosting` | 78/155 | 50.3% | 0 | 2 | 29 | 236 | png:98 js:41 ts:40 tsx:33 |
| `123pan-resource-library` | `123pan/123pan-resource-library` | 43/85 | 50.6% | 0 | 5 | 34 | 119 | tsx:27 ts:26 less:11 json:4 |
| `refresh-center-agent` | `cdn-groups/refresh-center-agent` | 40/74 | 54.1% | 3 | 0 | 32 | 0 | go:43 gitkeep:14 yaml:8 (noext):3 |
| `audit-consumer` | `123pan/audit-consumer` | 24/43 | 55.8% | 7 | 0 | 23 | 0 | go:36 yml:1 toml:1 sh:1 |
| `gf16` | `123pan/gf16` | 428/765 | 55.9% | 0 | 0 | 412 | 0 | go:760 toml:38 html:29 json:11 |
| `apisrv` | `123pan/apisrv` | 352/624 | 56.4% | 231 | 0 | 330 | 0 | go:616 yml:1 toml:1 sh:1 |
| `usercenter` | `123pan/usercenter` | 38/67 | 56.7% | 7 | 0 | 31 | 0 | go:45 gitkeep:15 toml:1 sh:1 |
| `123pan-traffic` | `123pan/123pan-traffic` | 144/252 | 57.1% | 52 | 0 | 139 | 0 | go:245 yml:1 toml:1 sum:1 |
| `log` | `log` | 4/7 | 57.1% | 0 | 0 | 4 | 0 | go:4 sum:1 mod:1 md:1 |
| `silentDataBinlog` | `123pan/silentDataBinlog` | 8/14 | 57.1% | 0 | 0 | 8 | 0 | go:8 (noext):2 toml:1 sh:1 |
| `mount-disk-ws` | `123pan/mount-disk-ws` | 11/19 | 57.9% | 0 | 0 | 11 | 0 | go:11 yml:1 toml:1 sum:1 |
| `upload-consumer` | `123pan/upload-consumer` | 28/48 | 58.3% | 12 | 0 | 26 | 0 | go:41 toml:1 sum:1 sh:1 |
| `pay_server` | `123pan/pay_server` | 174/296 | 58.8% | 95 | 0 | 163 | 0 | go:288 (noext):2 yml:1 toml:1 |
| `transcode` | `123pan/transcode` | 53/89 | 59.6% | 3 | 0 | 43 | 0 | go:69 (noext):4 sh:3 xml:2 |
| `123pan_manager_frontend` | `123pan/123pan_manager_frontend` | 606/1017 | 59.6% | 0 | 85 | 469 | 1338 | tsx:379 ts:340 less:150 md:73 |
| `dispatch-monitor` | `dispatch-monitor` | 12/20 | 60.0% | 0 | 0 | 10 | 0 | go:13 yml:1 toml:1 sum:1 |
| `contentTreeSrv` | `123pan/contentTreeSrv` | 35/58 | 60.3% | 12 | 0 | 26 | 0 | go:53 yml:1 toml:1 (noext):1 |
| `api_server` | `123pan/api_server` | 586/960 | 61.0% | 298 | 0 | 561 | 0 | go:930 sql:6 gitkeep:5 sh:4 |
| `123pan_manager` | `123pan/123pan_manager` | 542/885 | 61.2% | 284 | 0 | 532 | 0 | go:860 gitkeep:14 DS_Store:2 yml:1 |
| `binlog-srv` | `123pan/binlog-srv` | 8/13 | 61.5% | 0 | 0 | 7 | 0 | go:8 toml:1 sum:1 sh:1 |
| `gf-jwt` | `123pan/gf-jwt` | 8/13 | 61.5% | 0 | 0 | 7 | 0 | go:8 png:5 md:2 (noext):1 |
| `uuidsrv` | `123pan/uuidsrv` | 8/13 | 61.5% | 0 | 0 | 7 | 0 | go:8 toml:1 sum:1 sh:1 |
| `new_audit` | `123pan/new_audit` | 15/24 | 62.5% | 0 | 0 | 14 | 0 | go:16 toml:2 yml:1 sum:1 |
| `123pan-agent-tracker` | `123pan/123pan-agent-tracker` | 195/310 | 62.9% | 0 | 0 | 163 | 477 | tsx:161 ts:75 svg:46 png:13 |
| `upload-server` | `123pan/upload-server` | 152/241 | 63.1% | 73 | 0 | 145 | 0 | go:229 yml:2 sh:2 toml:1 |
| `file-analysis-worker` | `123pan/file-analysis-worker` | 12/19 | 63.2% | 0 | 0 | 11 | 0 | go:13 yml:1 toml:1 sum:1 |
| `gts` | `cdn-groups/gts` | 229/359 | 63.8% | 3 | 0 | 200 | 0 | go:299 (noext):13 md:13 yml:7 |
| `osssrv` | `123pan/osssrv` | 40/62 | 64.5% | 12 | 0 | 33 | 0 | go:57 toml:1 sum:1 sh:1 |
| `s3-migration` | `123pan/s3-migration` | 20/31 | 64.5% | 7 | 0 | 20 | 0 | go:27 toml:1 sum:1 mod:1 |
| `track-consumer` | `123pan/track-consumer` | 15/23 | 65.2% | 0 | 0 | 15 | 0 | go:17 toml:1 sum:1 sh:1 |
| `cdk_manager` | `123pan/cdk_manager` | 27/41 | 65.9% | 5 | 0 | 25 | 0 | go:33 yml:1 toml:1 sh:1 |
| `resource_manager` | `123pan/resource_manager` | 37/56 | 66.1% | 11 | 0 | 35 | 0 | go:50 toml:1 sh:1 (noext):1 |
| `offline-download` | `123pan/offline-download` | 49/73 | 67.1% | 9 | 0 | 44 | 0 | go:60 log:3 sh:2 (noext):2 |
| `mq_consumer_v5` | `123pan/mq_consumer_v5` | 114/166 | 68.7% | 36 | 0 | 107 | 0 | go:157 mod:2 toml:1 sum:1 |
| `go-share` | `123pan/go-share` | 18/26 | 69.2% | 0 | 0 | 17 | 0 | go:19 yml:1 toml:1 sum:1 |
| `binlog-to-elasticsearch` | `123pan/binlog-to-elasticsearch` | 25/36 | 69.4% | 3 | 0 | 23 | 0 | go:31 txt:22 json:14 (noext):2 |
| `audit-tools` | `audit-tools` | 16/23 | 69.6% | 0 | 0 | 15 | 0 | go:17 (noext):2 sum:1 sh:1 |
| `artifacts` | `artifacts` | 108/155 | 69.7% | 1 | 0 | 101 | 0 | go:147 md:2 yml:1 sum:1 |
| `metrics-consumer` | `123pan/metrics-consumer` | 21/30 | 70.0% | 3 | 0 | 16 | 0 | go:24 toml:1 sum:1 sh:1 |
| `cloud-drive-migration` | `123pan/cloud-drive-migration` | 62/88 | 70.5% | 2 | 0 | 57 | 0 | go:67 proto:12 yml:1 toml:1 |
| `mq_consumer` | `123pan/mq_consumer` | 178/249 | 71.5% | 49 | 0 | 157 | 0 | go:238 yml:1 yaml:1 toml:1 |
| `uncompress_srv` | `123pan/uncompress_srv` | 43/58 | 74.1% | 6 | 0 | 40 | 0 | go:50 sh:2 yml:1 toml:1 |
| `cloud-disk-ws` | `123pan/cloud-disk-ws` | 29/39 | 74.4% | 0 | 0 | 24 | 0 | go:31 yml:1 toml:1 sh:1 |
| `log-agent` | `log-agent` | 30/40 | 75.0% | 0 | 0 | 29 | 0 | go:32 yml:1 yaml:1 toml:1 |
| `dispatch` | `123pan/dispatch` | 41/52 | 78.8% | 0 | 0 | 39 | 0 | go:41 yml:5 (noext):2 sum:1 |
| `redis` | `redis` | 12/15 | 80.0% | 0 | 0 | 12 | 0 | go:12 sum:1 mod:1 md:1 |
| `123pan-piecehash` | `123pan/123pan-piecehash` | 29/36 | 80.6% | 1 | 0 | 27 | 0 | go:30 yml:1 toml:1 sum:1 |
| `helper` | `helper` | 13/16 | 81.3% | 0 | 0 | 13 | 0 | go:13 sum:1 mod:1 md:1 |
| `OpenAPI` | `123pan/OpenAPI` | 106/130 | 81.5% | 10 | 0 | 100 | 0 | go:119 yml:2 sh:2 toml:1 |
| `tl` | `test-groups/tl` | 32/39 | 82.1% | 0 | 0 | 30 | 0 | go:32 xml:2 md:2 sum:1 |
| `cdn-dispatch` | `cdn-groups/cdn-dispatch` | 56/68 | 82.4% | 0 | 0 | 49 | 0 | go:59 yml:3 sum:1 sh:1 |
| `webdav` | `123pan/webdav` | 218/262 | 83.2% | 0 | 0 | 192 | 0 | go:237 (noext):8 md:8 sh:3 |
| `cdn-go-proxy` | `cdn-groups/cdn-go-proxy` | 38/44 | 86.4% | 0 | 0 | 34 | 0 | go:38 toml:1 sum:1 sh:1 |
| `cloud-drive` | `cloud-drive` | 484/559 | 86.6% | 2 | 0 | 418 | 0 | go:486 yaml:40 sql:25 (noext):3 |
| `123pan-pc-go` | `123pan/123pan-pc-go` | 99/114 | 86.8% | 5 | 0 | 94 | 0 | go:106 yml:1 yaml:1 sum:1 |
| `cdn-admin` | `cdn-admin` | 51/58 | 87.9% | 0 | 0 | 45 | 0 | go:51 yml:1 toml:1 sum:1 |
| `api_server_restful` | `123pan/api_server_restful` | 102/115 | 88.7% | 0 | 0 | 99 | 0 | go:103 xml:2 gitignore:2 yml:1 |
| `xgo` | `xgo` | 69/76 | 90.8% | 0 | 0 | 63 | 0 | go:69 yaml:2 (noext):2 sum:1 |
| `123pan-dylib-go` | `123pan/123pan-dylib-go` | 46/50 | 92.0% | 0 | 0 | 35 | 0 | go:48 sum:1 sqlite:1 mod:1 |

> `files_total` 是 `ls-tree` **去掉噪音路径**之后的数（`vendor/`、`node_modules/`、`dist/`、
> 图片字体二进制、锁文件、`*.min.js`，判据见 `mirror.ts` 的 `isNoisePath`），所以它比
> `git ls-tree -r | wc -l` 小：`php-audit` 树里 1925 个文件，去噪后 37 个，全部是 PHP。

### 11.8 「克隆成功但索引 0」的 28 个仓：22 个是语言不认识，6 个是生成物/零散文件

| 类别 | 个数 | 仓 |
|---|---|---|
| 树里**一个**解析器认的语言都没有 | **22** | Lua/conf：`123pan-gateway`(39 lua)、`cdn`(46 lua)、`defense-nginx`(127 lua)、`nginx-proxy`(127 lua)、`cdn-cp`；C/C++：`ats-9.0.2`(827 cc+754 h)、`trafficserver`(885 cc+806 h)、`mount-disk`(1203 h+589 hpp)、`backup-disk`；Dart/Flutter：`123pan_app_package`(253 dart)、`app_tv`(113 dart)；Python：`ai-test-agent`(73 py)、`cron-scripts`(25 py)、`platform-api`(565 py)、`performance_front_test`(11 py)；PHP：`php-audit`(25 php)；纯部署：`minio_deploy`、`jmeter-offline`(26 个 jar)；只有文档：`review`、`video_audit_work`、`mq_copy`、`thumbnail` |
| 去噪后只剩 1–98 个可解析文件 | 6 | `go-protobuf`（98 个 `.go` **全是生成代码**，索引层主动跳过；另外 98 个 `.proto`）；`app`（Flutter 客户端，5 个零散 `.ts`/`.js`，其中一个是 `main.*.js` 打包产物）；`devops`、`transcode-proxy`、`openresty-cdn-gateway`、`windows-component`（各剩 1 个贴边文件） |

**这就是「不遗不漏」的诚实边界**：这 28 个仓我们做了能做的全部——镜像建了、HEAD 读到了、
树数清了、理由记下来了；但**解析器今天只认 `[ts|tsx|js|jsx|mjs|cjs|vue|go]`**，Lua、C/C++、
Dart、PHP、Python、纯部署、纯文档一个都不认。所以「不遗不漏」在今天的定义只能是：
**144 个仓，每一个要么被索引（111 个：9,936 个文件、193 个页面、12,459 条 import），要么有
一行 `ok=false` 且原因可查（`beats`/`gocron`/`platform-fontend` 三行 + 28 行 `0/N` 的扩展名
证据），要么被显式排除并写明理由（2 个重名副本）**——不是「144 个仓的代码都能被检索」。
要让那 22 个进索引，需要的是**新的语言解析器**（Lua 与 C/C++ 最值：`123pan-gateway` 与
`ats-9.0.2`/`trafficserver` 是其中文件最多的），那是另一条工作线。

### 11.9 三个 `ok=false`：两个是解析层的新发现

| 仓 | 原因（库里原文） | 判断 |
|---|---|---|
| `gocron` | 远端是空仓（clone 成功但一个 ref 都没有，索引无从下手） | 真·空仓。镜像不建（建了也是每晚一条 FAIL）；行留在表里 |
| `beats` | 索引失败（树里 11958 个文件）：git cat-file 读取超时：20 秒内没有返回 | 一次 `cat-file --batch` 读不完：树里 1.3 万个文件、含 106 MB 的 `mfy_self_build/filebeat` 与 21 MB 的夹具。`GIT_TIMEOUT_MS = 20 s` 是单次读的上限 |
| `platform-fontend` | 索引挂起：抽取阶段**同步阻塞**（25 分钟无进展，连 `--index-timeout-s 240` 的看门狗都不触发） | 镜像与 HEAD 都正常（`ee47b36`，574 个文件 / 5.7 MB，最大单文件 199 KB），所以不是「仓太大」。`sample` 显示进程停在 `AsyncFunctionAwaitResolveClosure` 而 `setTimeout` 不触发 ⇒ 事件循环被同步占死，指向解析器对某个文件的退化 |

这一轮为此加了两件事（都属于「批量脚本不许把一个问题变成整批不结束」）：

1. `onboard-repos.ts --index-timeout-s N`：单仓索引的墙钟上限（默认 1800 s），超时记
   `ok=false` + 中文原因。**它的边界写在代码注释里**：只能拦「异步挂住」，拦不住同步阻塞
   ——`platform-fontend` 就是后者，所以它的结论是用下面的口子落的。
2. `scripts/record-coverage.ts`：只给「管道自己产不出这一行」的仓用的手工记账口
   （`--reason` 必填且必须是一句中文，只能写 `ok=false`，仓名必须在清单里）。没有它，
   这两类仓在表里**一行都没有**，而「没有行」与「测过且失败」在报告里长得一样。

### 11.10 端到端验证（不是「看起来对了」）

```bash
# 1) 清单能被两侧读成同一件事：142 个仓、零解析错误
npx tsx scripts/repos-apply.ts --dry-run        # 142 个仓；diff 只显示新增与重排
npx tsx scripts/onboard-repos.ts --file <单行清单>  # 单仓冒烟：artifacts 108/155

# 2) bash 侧解析同一份清单（空镜像根 → 每个仓都报「目录不存在」，但一个都不许报格式错）
MIRROR_ROOT=/tmp/emptymirror REPOS_FILE=/tmp/repos-new.txt \
  SYNC_FLOWERS_LOG=/tmp/sync-validate.log SYNC_JOBS=4 bash scripts/sync-mirrors.sh
#   实测：rc=4、FAIL 142 条（全是「目录不存在」）、日志头 org=https://…/60f9…750（无多余花括号）

# 3) 两种组路径各真 fetch 一次（证明拼出来的地址对）
git init --bare /tmp/relmirror/audit-tools.git; git init --bare /tmp/relmirror/contentTreeSrv.git
printf 'audit-tools\tmaster\tpath=audit-tools\ncontentTreeSrv\tmaster\tpath=123pan/contentTreeSrv\n' > /tmp/tiny.txt
MIRROR_ROOT=/tmp/relmirror REPOS_FILE=/tmp/tiny.txt … bash scripts/sync-mirrors.sh
#   实测 rc=0：OK audit-tools@master (none) -> bc6b81f moved=1；OK contentTreeSrv@master -> b3aed6d

# 4) 服务器与本仓库不漂：两个文件的 sha256 都要一致
bash scripts/install-cron.sh --server && bash scripts/install-cron.sh --check
#   实测：sync-flowers-mirror.sh / repos.txt 两侧 sha256 一致，cron 行与 launchd 任务都在

# 5) 覆盖率与等式
docker exec flowers-db-1 psql -U postgres -d flowers -c \
 "select count(*) filter (where ok) ok, count(*) filter (where not ok) bad from repo_coverage"
#   期望：ok=139 bad=3（表里另有 2 行历史仓 ploto / sqlstring，不计入 144）
```

### 11.11 这一轮没做、也不该顺手做的

- **没有改解析器的抽取规则**，也没有碰 `src/core/locate/*`：`platform-fontend` 的挂起与
  22 个语言不认的仓都需要那条线的工作，而那是另一件事（且必须先有可复现的失败样本）。
- **没有动 `requirements`**（814 行，接入前后同一个数）。
- **没有删任何旧 `repo_coverage` 行**：`ploto`、`sqlstring` 等不在 144 里的历史行原样保留，
  它们是「当初为什么以为这些仓存在」的证据。
- **没有改镜像目录名**（见 11.2）。
- 服务器 05:05 那一轮同步**没有等它跑**：本轮验证的是「地址拼对」与「清单两侧一致」；
  夜间整轮 fetch 的耗时属于下一次观察（141 个仓、`SYNC_JOBS=8`，按 §10.1 的算式约 18 个批次）。

### 11.12 复现

```bash
# 权威清单（144 条路径 + 原始载荷）
cut -f2 .superpowers/sdd/2026-11-08-index-value/real-repos.tsv | wc -l           # 144
cut -f1 .superpowers/sdd/2026-11-08-index-value/real-repos.tsv | sort -u | wc -l # 142（2 个重名）

# 分支是一次性探出来的（不是抄的）
ssh dogyun 'cut -f1 /root/probe/paths.tsv | xargs -P 4 -I{} bash -c "git ls-remote --symref \
  https://codeup.aliyun.com/60f9058e68e2993a8e6d0750/\"$1\".git HEAD" _ {}'

# 全量接入（可续跑：同 HEAD 且上一轮 ok 的仓自动跳过）
npx tsx scripts/onboard-repos.ts --floor-gb 12
```

