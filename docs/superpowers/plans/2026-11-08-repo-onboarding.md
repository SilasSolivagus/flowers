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
