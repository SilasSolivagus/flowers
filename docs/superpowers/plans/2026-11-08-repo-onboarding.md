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
