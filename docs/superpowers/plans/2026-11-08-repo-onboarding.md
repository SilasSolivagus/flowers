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
