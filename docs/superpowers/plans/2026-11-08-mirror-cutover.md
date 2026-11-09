# 镜像传输 cutover：ssh（dogyun）→ 本地盘（2026-11-09）

**一句话**：`code.mirror.transport` 从 `ssh` 换成 `local`。镜像本来就已经在这台机器上
（`~/code-mirrors` 142 个 + `~/code-mirrors-gl` 75 个 bare 仓），这次做的是四件事——
把两块盘接成**唯一**的一份（补上缺的 2 个、改名 5 个）、把读侧的 `path` 从
`/srv/123pan-mirror/…` 换成 `~/…`、证明换完之后装配出来的索引**逐字节不变**、
把服务器上那 26 GB 与那条会把它抓回来的 cron 一起停掉。

数字：`code.mirror.repos` 216 条（141 codeup + 75 GitLab；磁盘上 217 个 bare 仓，
差的那一个是上游空仓，见 §1.2）。装配耗时中位数 **209–700 ms → 46–57 ms**。

为什么要做：镜像只服务一个消费者，而那个消费者（走查 / 评审 / 材料 / 夜间索引）全部跑在
这台 Mac 上。也就是说 26 GB 数据放在一台服务器上，只为给一次 `git ls-tree` 多绕一趟
ssh——每次装配多付 150–370 ms 的往返，而「笔记本睡了也能同步」这个收益在镜像不再被
远端读之后就不存在了。

---

## 1. 清单的新格式：多一格 `source=`

```
<仓名><空白><分支>[<空白>source=codeup|gitlab][<空白>path=<组路径>][<空白>stale=<天数>|never]
```

| 格 | 谁读 | 为什么是它 |
| --- | --- | --- |
| `source=` | `repo-inventory.ts`（TS）＋ `sync-mirrors.sh`（bash） | **同时**决定本地 bare 根与克隆基址：`codeup → ~/code-mirrors` + `CODEUP_ORG`；`gitlab → ~/code-mirrors-gl` + `ssh://git@gitlab.123245.com:2222` |
| `path=` | 同上 | 上游的组路径（含仓名），克隆地址只由它拼一次 |
| `stale=` | `health.ts` | 每仓的新鲜度阈值（缺省 7 天，`never` = 不因上游不动而提醒） |

**为什么不写 217 条绝对路径**：`dir=` 是**部署事实**（盘挂在哪、用哪个用户），不是仓的
属性。写成绝对路径之后，换机 / 换挂载点 = 217 行手改，漏一行就是一次静默的换仓
（目录里躺着 A 仓，每晚去 fetch B 仓）。现在只有一张表（`SOURCE_ROOTS`）把来源翻译成根，
清单里一行一个来源。

**代码里只有这一处翻译**（`src/core/codemirror/repo-inventory.ts`）：

```ts
export const DEFAULT_MIRROR_ROOT        = path.join(homedir(), 'code-mirrors');    // codeup
export const DEFAULT_MIRROR_ROOT_GITLAB = path.join(homedir(), 'code-mirrors-gl'); // gitlab
export function mirrorRoots(env = process.env): MirrorRoots        // MIRROR_ROOT / MIRROR_ROOT_GITLAB 可覆盖
export function sourceBase(source: RepoSource): string            // CODEUP_ORG / GITLAB_ORG
export function inventoryToRepos(lines, roots): RepoRef[]          // {id, path: <root>/<id>.git}
```

`repos[].path` 的消费方式**没有变**：`mirror.ts` 的 `gitArgv()` 对两种传输用同一个
`--git-dir=<path>`，唯一差别是 ssh 那一支在 argv 前面加 `ssh <host>`。所以切传输不需要
改 `mirror.ts` 一行——要保证的是「`path` 指向的是同一棵树」，这正是 §3 的表。

`scripts/repos-apply.ts` 是唯一把清单播种成 `app_settings.code.mirror.repos` 的口（它先
过 `parseRepos()`，所以「写进去读不回来」在构造上不可能）：

```
$ npx tsx scripts/repos-apply.ts --dry-run
清单      /Users/silas/flowers/config/repos.txt（216 个仓，跳过 126 行注释/空行）
去向      app_settings.code.mirror.repos
  根      codeup=/Users/silas/code-mirrors
  根      gitlab=/Users/silas/code-mirrors-gl
现状      设置里 142 个仓
diff      + 75 个（GitLab）
diff      ~ 141 个 /srv/123pan-mirror/… → /Users/silas/code-mirrors/…
```

### 1.1 重名：5 个改名、6 个本地起名

codeup 与 GitLab 各有一个**同名但不同**的仓。`code.mirror.repos` 的 `id` 是身份
（`repo_coverage` / `mirror_health` / `commit_history` / `blob_index` 都按它存行），两行
同一个 id 就是两份仓的数据互相覆盖。改的是 **GitLab 这边**：codeup 那 141 个在库里已有
一批行，改 id 等于丢历史；GitLab 这 75 个是本轮新接入。

| GitLab 上游 | codeup 同名仓 | 采用的本地 id | 本地目录 |
| --- | --- | --- | --- |
| `fre/admin/123pan-agent-tracker` | `123pan/123pan-agent-tracker` | `gl-123pan-agent-tracker` | `~/code-mirrors-gl/gl-123pan-agent-tracker.git` |
| `go/cloud-driver/scripts/cron-scripts` | `crontab`（同组另有一个） | `gl-cron-scripts` | `~/code-mirrors-gl/gl-cron-scripts.git` |
| `go/gocron` | `gocron`（上游空仓，见 §1.2） | `gl-gocron` | `~/code-mirrors-gl/gl-gocron.git` |
| `proto/share` | `123pan/share` | `gl-share` | `~/code-mirrors-gl/gl-share.git` |
| `proto/transcode` | `123pan/transcode` | `gl-transcode` | `~/code-mirrors-gl/gl-transcode.git` |

五个目录是 `mv` 改的名（bare 仓里没有绝对路径，改名不动内容）。

另有 **6 个 GitLab 仓的本地名与上游最后一段本来就不同**（接入时刻意起的名字，因为上游名
太泛；这次没有改，只是让解析器明确接受并逐条打提示）：

| 本地 id | 上游 path | 为什么 |
| --- | --- | --- |
| `api-go-base` | `go/base/api` | 上游名就是 `api`，在 216 个仓里无法辨认 |
| `grpc-go-base` | `go/base/grpc` | 同上 |
| `worker-go-base` | `go/base/worker` | 同上 |
| `fix-worker` | `go/cloud-driver/worker/fix` | 同上（`fix` / `k2m` / `m2m` / `merge-table` 是 worker 下的子目录名） |
| `k2m-worker` | `go/cloud-driver/worker/k2m` | 同上 |
| `github-api-demo` | `go/cloud-driver/api-transcode-demo` | 上游名是历史遗留，与内容（github 网关 demo）不符 |

规则因此收成两条（`parseRepoInventory` 与 `sync-mirrors.sh` 同一套）：
**codeup 的行必须 id == path 最后一段**（那批目录一个都没改过名，任何不一致都是笔误）；
**GitLab 的行允许不一致，但每一行都留一条提示**——改名允许，「悄悄改名」不允许。

### 1.2 三个没进清单的仓（各有理由，都有记录）

| 仓 | 来源 | 处置 | 理由 |
| --- | --- | --- | --- |
| `fre/pc/ai` | GitLab | 未接入 | `git ls-remote` 返回 permission denied（不是 404、不是网络抖动，重试无意义） |
| `fre/pc/Code Review Agent` | GitLab | 未接入 | 同上；且仓名带空格，接入时要另给 id |
| `gocron` | codeup | 从清单剔除 | 上游是**空仓**（`git ls-remote` 零 refs）：每晚 fetch `master` 都以 `couldn't find remote ref` 收尾，等于装一条永远不会消失的红点。真正的 gocron 在 GitLab（`go/gocron` → `gl-gocron`） |

三条都写进 `config/repos-excluded.txt`（那份文件存在的唯一目的就是这个：**不遗不漏**要
能逐条回答）。空 bare 目录 `~/code-mirrors/gocron.git` 留着，没有删。

**所以数字对齐关系是**：磁盘上 142 + 75 = **217 个 bare 仓**；`code.mirror.repos` 里
**216 条**（141 codeup + 75 GitLab；`gocron` 是那个差 1）。

### 1.3 接入 GitLab 时顺手修的两件旧账

1. **镜像文件的权限是 444**（510 个 codeup + 225 个 GitLab 文件）：那批是从服务器
   `rsync -a` 下来的，把服务器上「收写位」的 444 一起带过来了。表现是
   `git fetch` 报 `cannot open 'FETCH_HEAD': Permission denied`——一句看起来像权限策略、
   实际是「拷贝时把只读位也拷了」的话。`chmod -R u+w` 一次性修好（0 个残留）。
2. **`.git/config` 里有 oauth2 token**（136 个 codeup 镜像是 `git clone --bare <带 token 的 URL>`
   出来的）。已把 `remote.origin.url` 换成匿名地址（实测匿名可读：`git ls-remote` 成功）；
   `sync-mirrors.sh` 的收尾检查现在只把「URL 里带口令」当故障——`ssh://git@host` 的
   `git@` 是用户名，按 `://[^@]*@` 判会把 75 个 GitLab 镜像全误报成泄漏，那种闸早晚被关掉。

---

## 2. 传输切换（设置了什么）

| 设置 | 之前 | 之后 |
| --- | --- | --- |
| `code.mirror.transport` | `ssh` | `local` |
| `code.mirror.repos` | 142 条 `/srv/123pan-mirror/<名>.git` | **216 条**：141 条 `~/code-mirrors/<名>.git` + 75 条 `~/code-mirrors-gl/<名>.git` |
| `code.mirror.sshHost` | `dogyun` | `dogyun`（**没动**：留着，回滚要用；`transport=local` 时它不被读） |

写库只有一条路（`repos-apply.ts` → `writeSetting()`），写完立刻用读侧入口
`resolveMirrorConfig()` 读回来比对：

```
结果      已写入 216 个仓
校验      读侧 resolveMirrorConfig() 读回 216 个仓，与清单一致
```

`transport` 那一格是单独一次 `writeSetting()`（它是部署动作，不是清单的投影——把它塞进
`repos-apply.ts` 会让「清单 → 设置」这条路顺手改掉读侧的传输方式，那是一次隐形的换传输）。

---

## 3. 等价性：不是「能跑」，是逐字节相同

同一份 `blob_index`（同一张 Postgres），同一个仓，两种传输各读一遍：
`head()` 的 sha / 提交日期、`repoIndex()` 的文件数 / 页面数 / 轮廓条数、以及**整份索引
`JSON.stringify` 的字节数与 sha256**。

命令（`scripts/mirror-compare.ts`，两段式：同一进程里只能解析出一份配置）：

```
# 旧（ssh）：repos 用切换前设置里那份 /srv/… 的 JSON
FLOWERS_MIRROR_TRANSPORT=ssh FLOWERS_MIRROR_REPOS="$(cat /tmp/repos-old.json)" \
  npx tsx scripts/mirror-compare.ts capture --repos apisrv,123pan-uni-app,123pan-pc -o cap-ssh.json
# 新（local）：直接从设置读
npx tsx scripts/mirror-compare.ts capture --repos apisrv,123pan-uni-app,123pan-pc -o cap-local.json
npx tsx scripts/mirror-compare.ts compare cap-ssh.json cap-local.json
```

| 仓 | HEAD sha | 提交日期 | 文件数 ssh/local | 页面 ssh/local | 轮廓 ssh/local | 索引字节 ssh/local | 索引 sha256（两边逐字节同） | 判定 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| `apisrv` | `199cd433…` | 2026-11-06T18:35:27+08:00 | 352 / 352 | 0 / 0 | 2204 / 2204 | 190881 / 190881 | `d3b33c313b5b86f60fb1f16b3cf86f337c01f6fa8a5d44fbf9e959e56b1e26ef` | **match** |
| `123pan-uni-app` | `6ee08a14…` | 2026-11-06T18:18:15+08:00 | 142 / 142 | 27 / 27 | 288 / 288 | 89480 / 89480 | `b4a2efab4bd84784ce79530463b8dc0e3e98595be14e4665106b1ae05068d13a` | **match** |
| `123pan-pc` | `3354b4a1…` | 2026-11-06T18:18:29+08:00 | 138 / 138 | 2 / 2 | 441 / 441 | 97256 / 97256 | `6341970a6570a98793cc3725de7593c1b89c515db602dc14205a0502e98f4d15` | **match** |

`compare` 的结论行：`结论 3 个仓全部 match`。sha / 日期 / 文件 / 页面 / 轮廓 / imports /
字节 / sha256 八个字段逐项比，**零差异**——所以「换传输」对材料与索引是**不可观测**的。

`grpc-benefit` 没进这张表：它是 GitLab 的仓，服务器上**从来没有**它的镜像（服务器只装
codeup 那批），所以它没有「旧」的一侧可比。GitLab 那 75 个的等价性是另一种证据：本地
镜像的 HEAD 与上游 `git ls-remote --symref` 逐个对过（例如 `proto/transcode` →
`refs/heads/feature-transcode-refactor` @ `d6159052`、`go/cloud-driver/api-transcode-demo`
→ `refs/heads/feature_v1` @ `69804e2a`），清单里的分支就是这么读出来的。

### 3.1 141/141：服务器上每个镜像的 HEAD 本地都有同一个

删之前把服务器 141 个镜像的 HEAD 逐个读出来，与本地 `~/code-mirrors/<名>.git` 比：

```
same 141  diff 0  missing 0
```

这一条比 §3 的表更宽（覆盖全部 141 个仓，不只是 3 个），但更浅（只比 HEAD，不比索引）。
两条合起来回答的是「本地这份是不是原来那份」。

---

## 4. 一份真材料（requirement 800 «【发票】换开次数限制»，有 `prd_url`）

切换后走真实生成路径（`inspect()`，两轮模型调用，214 s，45 875 字节）：

```
requirement 800 【发票】换开次数限制 design
[body-language] PAN-800 inspect hits=0 left=0 通过
material /uemaster/PAN-800/inspect.html bytes= 45875 ms= 214236
locate {"123pan-pc":"candidates","123pan-uni-app":"none"}
```

材料末尾的「研发参考」小节（代码写死、模型不参与）：

```
研发参考
123pan-uni-app:src/pages/me/invoice-info.vue
123pan-uni-app:src/services/invoice/index.ts
受影响文件：2 个
```

两个坐标都在本地镜像的 HEAD 上真实存在（`git cat-file -e HEAD:<path>` 都返回存在），
而 HEAD 就是 §3 表里那个 `6ee08a14` ——**同仓、同提交、同路径**。装配不需要模型，
所以「坐标没变」的判据落在「同一棵树 + 同一份 blob_index」上，这两条 §3 已经逐字节证过。

横幅里那句「代码快照：123pan-uni-app @ 2026-11-06」在切换前后**逐字相同**
（切换前 41369 字节的那份产物与切换后 40754 字节的这份，两条快照行都是
`123pan-pc @ 2026-11-06` / `123pan-uni-app @ 2026-11-06`）。字节数不同是因为切换前那份
是更早的代码版本生成的（那时还没有「研发参考」小节，`data-dev-reference` 不存在）。

---

## 5. 装配耗时：ssh → local

每侧 3 轮 × 3 个仓，`repoIndex()` 的 `buildMs`（含 `ls-tree` 的那一次往返；同一份
blob_index，库里已有解析结果，所以差异几乎全在传输上）：

| 仓 | ssh（3 轮） | local（3 轮） | 中位数 |
| --- | --- | --- | --- |
| `apisrv` | 750 / 700 / 618 ms | 46 / 45 / 52 ms | **700 → 46 ms** |
| `123pan-uni-app` | 205 / 209 / 214 ms | 57 / 49 / 49 ms | **209 → 49 ms** |
| `123pan-pc` | 223 / 218 / 215 ms | 116 / 56 / 56 ms | **218 → 56 ms** |

计划里那个 **150–370 ms** 是 ssh 侧的历史口径（`ls-tree` 150–170 ms + 装配 50–75 ms，
见 `docs/superpowers/plans/2026-11-08-blob-index.md`）；这次实测的 ssh 侧是 205–750 ms
（`apisrv` 352 个文件、树比当年那批大，往返+传输都更贵）。**口径不同，方向一致**：
本地 45–116 ms，中位 46–57 ms，约 ssh 的 **1/4 到 1/10**。

`123pan-pc` 的第一轮 local 是 116 ms、后面两轮 56 ms：那是 OS 文件缓存（本地盘第一次
读也要走 page cache miss）。ssh 侧没有这个方差，因为它每次都真的过网络。

---

## 6. 拆除服务器（只在 §3 的表落进这份文档之后）

### 6.1 先停 cron（它会在删完之后把 26 GB 抓回去）

`install-cron.sh --server` 当年写的那一行是
`5 5 * * * /opt/123pan/tools/_ro/sync-flowers-mirror.sh`。**只删这一行，别的一行不动**，
并且先备份整份 crontab：

```
backup=/root/crontab.bak.20261109-134655   （20 行，删之前那份）
crontab -l | grep -vF "/opt/123pan/tools/_ro/sync-flowers-mirror.sh" | crontab -
→ crontab 20 行 → 19 行，`grep -c sync-flowers-mirror` = 0
```

相邻那条 `0 5 * * * /opt/123pan/tools/_ro/sync-repos-ro.sh` 是**另一个任务**（brainboil 的
只读影子，不是这批镜像），`grep -vF` 按整条脚本体匹配，所以它没有被误删——事后核对过：

```
0 19 * * * /opt/backups/daily-backup.sh
0 5 * * * /opt/123pan/tools/_ro/sync-repos-ro.sh
35 * * * * … gen_insight.py …
```

上表那次是手工 `ssh` 跑的；同样的动作有一个可重复的形式
（`scripts/install-cron.sh --server-off`：备份 crontab → `grep -vF "$REMOTE_SCRIPT"` → 报告剩余
行数，退出码 0 只在剩余 0 行时成立）。手工那次与它的唯一差别是没走 `--help` 里那句提示。

`--check` 也跟着改了：cron 行**不在**现在是 cutover 后的**预期状态**（`✓`，不算失败），
而服务器那两份文件的 sha256 在 cron 停用之后只算「回滚材料比仓库旧」，不再让
`--check && echo ok` 永远断——它现在只对 launchd 任务与「cron 行还在但文件漂了」这两种
真故障非零退出。

服务器上 `/opt/123pan/tools/_ro/sync-flowers-mirror.sh` 与 `repos.txt` **留着**（没删）：
它们是回滚材料，只是没人调用了。回滚 = 在服务器上重抓镜像 + 把 `transport` 改回 `ssh` +
把这一行加回 crontab（备份里逐字有）。

### 6.2 删之前记录的 sha256（安全网，不打包）

按仓记录两样东西：服务器上该镜像 `HEAD` 的 sha，以及 `git rev-parse HEAD` 输出（40 字节
十六进制 + 换行）的 sha256。有了这两列，任何一份**声称**是「原来那份」的拷贝都可以
逐仓验明；不需要 tarball，也不需要留 26 GB。

- 仓数：**141**
- 全表聚合 sha256（`<仓名>\t<sha>\n` 逐行拼接，按仓名升序）：
  `f469eea37f121a83eb3507a25272b55ba27067e87a7145cd0ccdeeb6ec0deb91`
- 逐仓明细见文末附录 A。

### 6.3 删除与释放空间

```
$ ssh dogyun 'df -h /srv; du -sh /srv/123pan-mirror'      # 删之前
/dev/vda3        99G   69G   25G  74% /
26G     /srv/123pan-mirror

$ ssh dogyun 'rm -rf /srv/123pan-mirror/*'                # 只删内容，目录留着
```

删之后的 `df` 见 §6.4（本次在删除命令之后立刻读的）。

### 6.4 结果

```
$ ssh dogyun 'rm -rf /srv/123pan-mirror/*; ls -A /srv/123pan-mirror | wc -l; df -h /srv'
remaining=0
/dev/vda3        99G   44G   51G  47% /
```

| | 删之前 | 删之后 | 差 |
| --- | --- | --- | --- |
| 已用 | 69 G | **44 G** | **−25 G** |
| 可用 | 25 G | **51 G** | **+26 G** |
| 使用率 | 74 % | **47 %** | −27 个百分点 |
| `/srv/123pan-mirror` | 26 G / 141 个 bare 仓 | 4.0 K（空目录） | −141 个仓 |

（`df` 与 `du` 的差是块粒度与文件系统保留，`du` 说 26 G、`df` 说省了 25 G，两者差 1 G
以内都属于正常。目录本身没删——留着当「这里原来有什么」的锚点。）

---

## 7. 夜间任务：现在两步，都在本机

`com.flowers.index-nightly`（launchd，05:10）跑 `scripts/index-nightly.sh`，它现在做两件事：

1. **`scripts/sync-mirrors.sh`** —— 把 codeup 与 GitLab 的新提交抓进本地 bare 镜像。
   实测一轮 216 个仓 **23 s**（`SYNC_JOBS=8`，0 失败）。
2. **`scripts/index-nightly.ts`** —— 把新提交的静态索引补进 Postgres（不变）。

同步的退出码：索引自己的码优先（它点名「哪个仓的索引坏了」）；索引全绿而同步红了，就把
同步的码带出去——否则「抓不到新提交」这件事在 launchd 那边看不见，会一直绿到有人发现材料
对着半个月前的代码。

**整条链跑了一次真账**（`FLOWERS_INDEX_TIMEOUT_MS=60000 bash scripts/index-nightly.sh`）：

```
[mirror-sync] NOTE 本轮到 24s repos=216 jobs=8 失败=0 缺镜像=0
[index]      216 个仓逐个索引，newBlobs 合计 3526 块
[index]      (run) ms=250728 newBlobs=3526 「2 个仓失败」
rc=3
```

4 分 11 秒（含两次 60 s 超时）。75 个 GitLab 仓是第一次进索引，块数是实打实的：
`api-ufs` 333、`api-uc` 316、`api-share` 274、`admin-adm` 236、`123pan-website` 236、
`grpc-auth` 192、`grpc-ftree` 157……`mirror_health` 从此有 216 行（214 ok / 2 failed）。

rc=3 的两个仓是同一个**解析器**问题，不是传输问题：

| 仓 | 现象 | 根因（已定位到文件） |
| --- | --- | --- |
| `platform-fontend` | 索引 60 s 未完成 | `src/components/SvgIcon/index.vue`（903 字节）让某个正则回溯到爆炸——`sample` 的栈一路停在 `RegExpPrototypeExec`；逐个文件跑 `parseBlob()` 时卡在这一行，它前面的文件都是个位数毫秒 |
| `fe-tool` | 同上 | 同形态（同类 icon 组件，未逐个定位） |

改的是**夜间的失败形态**，不是解析器（`src/core/codemirror/*` 这次不动）：

- `index-nightly.ts` 给每个仓加了 `spawnSync(..., { timeout })`（`FLOWERS_INDEX_TIMEOUT_MS`，
  缺省 600 s）。之前没有超时：`spawnSync` 会一直等，于是**整晚停在这一个仓上**，后面
  74 个仓一个都没索引，而 launchd 那边看起来只是「还在跑」——这是这次实测撞到的真事
  （跑了 20 分钟还没过 `platform-fontend`）。
- 超时被杀时点名说「索引超过 N 秒被终止」，而不是留一句空 stderr 让人去猜。

于是现在的行为是：坏仓**单独失败、名字写进 `mirror_health.error`、下一轮再试**，
其余 214 个仓照常索引。**这一个文件仍然会让那一晚的索引停在那里**——修它属于解析器
的事（回溯型正则），这次明确不动。

### 7.1 `sync-mirrors.sh` 原来假设服务器布局，改了这些

| 原来的假设 | 现在 | 为什么 |
| --- | --- | --- |
| 一个根 `MIRROR_ROOT=/srv/123pan-mirror` | `MIRROR_ROOT` + `MIRROR_ROOT_GITLAB`，按清单的 `source=` 选 | 两个来源两份盘，合一个根 = 五个同名仓互相覆盖 |
| 一个对端 `CODEUP_ORG` | `source=codeup → CODEUP_ORG`；`source=gitlab → GITLAB_ORG`（`ssh://git@gitlab.123245.com:2222`） | 一个 https+凭据、一个 ssh 匿名，没有共同拼法 |
| `path` 拼地址 | 不变（地址仍只拼一次），但基址跟着来源 | 同上 |
| 需要 `flock`（Linux） | 有 flock 用 flock，没有就用 mkdir + pid 判活 | macOS 没有 flock（同一个语义，见 `index-nightly.sh` 的同一套写法） |
| 需要 `timeout`（coreutils） | `timeout` / `gtimeout` / 便携看门狗三选一，超时统一报 124 | macOS 没有 `timeout`；而挂起保护正靠它 |
| `date -Iseconds` | `iso_now()`（`date -u +%Y-%m-%dT%H:%M:%SZ`） | macOS 的 date 不认 `-Iseconds`，而它出现在每一行日志里 |
| `declare -A SEEN` | 换行分隔的字符串 | bash 3.2（Apple 最后一代 GPLv2）没有关联数组 |
| 同步完无条件 `chown root` + 555/444 | `SYNC_READONLY`（缺省：root 下 1，否则 0） | 本机读写同一个用户，收写位会让**下一次** fetch 自己失败 |
| 日志/锁固定 `/var/log`、`/var/lock` | root 不变；非 root 走 `~/Library/Application Support/flowers/logs/` 与 `TMPDIR` | 本机没有那两处的写权，会以「建不了日志目录」退出 2 |
| 缺镜像 → 退出码 4「去跑 onboard-repos」 | 本机模式就地 `git clone --bare`（`SYNC_CLONE_MISSING`，缺省：非 root = 1） | `onboard-repos.ts` 是给服务器写的（要求 `transport=ssh`、还要 df 服务器的盘），镜像搬回本机之后它一进来就拒绝——「加一个仓」这条路不能断 |
| cfg 收尾检查「不许有 remote」 | 只查「URL 里带口令」；`SYNC_READONLY=1` 时才额外查 remote | 本地镜像带 `remote.origin.url`（记录来源）是正常的；带 token 才是真问题 |

**一次性修的两处数据问题**（不修的话第一晚就红）：510+225 个文件是 444（从服务器
`rsync -a` 拷来）→ `chmod -R u+w`；136 个 `.git/config` 里有 oauth2 token → 换成匿名 URL。
另外 `FETCH_HEAD` 只读时 `git fetch` 报 `cannot open 'FETCH_HEAD': Permission denied`，
同一个 chmod 一起修掉。

### 7.2 现在「加一个仓」是四步

1. `config/repos.txt` 加一行（`源名 分支 source=… path=…`）；GitLab 的仓要带组路径。
2. `npx tsx scripts/repos-apply.ts --dry-run`（看 diff）→ 去掉 `--dry-run` 再跑一次。
3. `scripts/sync-mirrors.sh`（或等夜里那一轮）：目录不存在时它**自己 clone**（见上表），
   存在时只 fetch。失败会点名是「仓不存在 / 分支不存在 / 连不上」哪一种。
4. `scripts/index-nightly.ts`（或等 05:10）把那棵树索引进库。

`scripts/onboard-repos.ts`（建镜像 + 索引 + 写 `repo_coverage` 的批量入口）**留作服务器
时代的工具**：它第一句就要求 `transport=ssh`，`transport=local` 时会带着
「批量接入只支持 ssh」退出 2。这是**已知的缺口**，不是遗漏：覆盖率表的写入还没有本地
版本（`index-nightly.ts` 只写 `blob_index`，不写 `repo_coverage`），新接的 75 个 GitLab
仓因此暂时没有 `repo_coverage` 行。补它属于另一件事（「覆盖率怎么在本地算」），
不在这次 cutover 的范围里。

### 7.3 75 个 GitLab 仓现在能不能读？能。

`code.mirror.repos` 里那 75 条 `~/code-mirrors-gl/<id>.git` 走的是同一个 `--git-dir` 读口，
实测（`mirror-compare.ts capture`，`transport=local`）：

| 仓 | HEAD | 文件数 | 轮廓 | 索引字节 | 耗时 |
| --- | --- | ---: | ---: | ---: | ---: |
| `grpc-benefit` | `68bfa1e3`（2026-11-03） | 169 | 454 | 52487 | 72 ms |
| `api-go-base` | `b9b76976`（2026-09-01） | 21 | 38 | 4539 | 29 ms |
| `gl-share` | `4e96cc88`（2026-03-02） | 0 | 0 | 202 | 30 ms |

`gl-share` 的 0 个文件是**预期**的：19 个 `proto` 仓里是 `.proto` + `*.pb.go`，而
`CODE_EXT` 只收 `ts/tsx/js/jsx/mjs/cjs/vue/go`，生成代码（`Code generated … DO NOT EDIT`）
又被 `isGeneratedSource()` 跳过——所以 proto 仓的索引今天是空的。它们仍在清单里，因为
它们是后端仓的**契约**；要不要把 `.proto` 也索引是一个独立决定（改的是解析器，
这次明确不动）。

---

## 8. 如果本地这两块盘消失

**那就没有镜像了。** 这是这次 cutover 唯一的真实代价，必须写清楚：

| 断掉的东西 | 立刻的样子 | 怎么恢复 |
| --- | --- | --- |
| 走查 / 评审 / 材料里的代码定位 | `bad_config` / `unknown_repo`：`code.mirror.repos` 里 216 条绝对路径全部指向不存在的目录 | 重建镜像（下一条） |
| 夜间索引 | 每个仓「镜像里没有 HEAD」；材料上「代码快照」那句开始说「较旧」 | 同上 |
| 覆盖率 / 健康度 | `repo_coverage` / `mirror_health` 的行还在（库里），但它们描述的是**现在读不到的仓** | 同上 |

恢复路径**只有一条**：重新 clone（`git clone --bare` 从 codeup / GitLab），然后
`repos-apply` 再播种一次设置——清单（`config/repos.txt`）是仓库里的一等公民，它没有丢，
丢的是 26 GB 的 bare 副本。代价是时间（当年全量克隆是小时级，现在 codeup 匿名可读、
GitLab 走 ssh 匿名，网络正常时 216 个仓是可重来的）。

因此服务器上那份 `/opt/123pan/tools/_ro/{sync-flowers-mirror.sh,repos.txt}` 与备份的
crontab（`/root/crontab.bak.20261109-134655`）是**回滚材料**，别删；但注意回滚不是
「把盘挂回来」（盘已经空了），而是「在 dogyun 上重抓一遍」——也就是回到 cutover 之前
那套「镜像在服务器、读侧走 ssh」的状态。

---

## 9. 验证（这次真的跑过什么）

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 0 error |
| `npx vitest run` | **80 个文件 / 1709 passed + 1 skipped**（`repo-inventory.test.ts` 27 条，其中 4 条是这次新增：`source=` 校验、gitlab 必须 `path=`、本地名≠上游名的两条规则、两个根） |
| `scripts/repos-apply.ts` | 写 216 条，`resolveMirrorConfig()` 读回 216 条一致 |
| `scripts/mirror-compare.ts compare` | 3 个仓 × 8 个字段零差异，`结论 3 个仓全部 match` |
| 服务器 141 个 HEAD vs 本地 | `same 141 / diff 0 / missing 0` |
| `scripts/sync-mirrors.sh`（216 个仓） | rc=0，**23 s**，0 失败 |
| `inspect()`（requirement 800） | 45 875 字节，214 s，研发参考 2 条坐标全部在 HEAD 上存在 |
| `scripts/index-nightly.sh`（整条链） | 同步 24 s（216 仓 0 失败）+ 索引 250 s（3526 块），rc=3 = 2 个仓索引超时（解析器，见 §7） |
| `scripts/install-cron.sh --check` | launchd 已加载、服务器 cron 已停用（两份副本的 sha 漂移按「回滚材料」记为提示） |

`requirements` 仍是 **814** 条（材料生成让 800 从 `inbox` 走到 `design`——那是
`attachArtifact` 的既有行为，没有 reseed）。

---

## 附录 A：拆除前服务器 141 个镜像的 HEAD 与 sha256

| # | 仓 | 服务器 HEAD | sha256(`git rev-parse HEAD` 输出) |
| ---: | --- | --- | --- |
| 1 | `123pan-agent-tracker` | `7a5a508d9de6167ee8d973f2db070a66df10096c` | `c690d4fcd9117bcc9e4ce1d8ce4cff2f76759e2a7f4dbac59d68d04a974f315d` |
| 2 | `123pan_app_package` | `f3cbf1c9e55a4d99dadb4a8652c9c5d8005e9f35` | `6ea26eb9ecb1ff33638334d59c08fc841c8d74465247c75973dd384d1ae87076` |
| 3 | `123pan-cross-frontend` | `6c287f4eaf592d8a88662b6904c38e16246c9d3f` | `46eafa24721f297750788bef959d7df7959ed0d34fd44b12e5a845f3fc886999` |
| 4 | `123pan-dylib-go` | `41a9d6fd96baa1861f365a97f88192487301b9b4` | `951e69fc56935d08229afa9c7e5182bbc30b1089d805a6ce0b1c1f552e0e6fcc` |
| 5 | `123pan-ele-react` | `3be4b64675b5d9ed77c4cd90741a707b8f2ce4b6` | `4c2e4396b610baa1657f88c0bef0e9cbacfc0ad6b03e0f86736de99423686d44` |
| 6 | `123pan-gateway` | `6359f39be9d0d7d00d84eb3b5e7ed073cf0fd734` | `42d7846acb305cd85e4efbb7da28e84e68b5708dbd9c86daffb44e0a9a5030a0` |
| 7 | `123pan-image-hosting` | `f00c684f600388219c1c2e5e6053893510353d14` | `c3862d622a7a8c95166b37533f0949eb3e813d07afb1c4ecfecf53f1d3898c81` |
| 8 | `123pan_manager_frontend` | `5cd21189de05469e0c23d56b014a064dad9b315d` | `cceddba21c2a4b9079c6b63720ceb9b7ae98e8e737bf58b5d13755f2d9d6a70b` |
| 9 | `123pan_manager` | `46a73482fc62aceae03fbc3b1c454ded7c0e962a` | `dc8fbb1e7723b5a1af59520cdef448bf01560cd1d44b5369256e0ba83a2b2d1c` |
| 10 | `123pan-pc` | `3354b4a15aae1dd44753a767eeb91ebd3d076a66` | `a2e666561d349ef67aa39adacbbed37a1ca601e7469b19cac0a79cebe17964d5` |
| 11 | `123pan-pc-go` | `a99a8821dbb35889a8fdd067ae865a8603057028` | `f0a165b2aa02c974633a924a66ae6a9bfb90007973cd6e1be45280f22fa0cd6e` |
| 12 | `123pan-piecehash` | `cc15d2fde4902cc2b536aae6497c10e6786ae2e4` | `fa48d9d360b2a0c959ab8f4f104827c1a956242cd11159593741f3c178215e50` |
| 13 | `123pan-resource-library` | `0d0d660c1c94cf32ff6044cf0bbe93c9029373b8` | `9a7e6c55f4a149e613d143587a50d741dbb8897ed7717b6ca61777ae90d6578d` |
| 14 | `123pan-slb` | `8422523706471b4c9c7769783f09586a8cbbb106` | `ce671a401765f674751570f09f15a2f6b310dc8d7a10c3bebd19f41544611f86` |
| 15 | `123pan-ssr` | `917bc2b56e6defe67f0086c2ac4403c0cefbd80a` | `2c1f8bca83149a3c64ea31a5c5eba1237d3b58f056078bc0b00de748bc17e771` |
| 16 | `123pan-traffic` | `9965114ecae3d32a8d2949ffed0253096d8e4be6` | `ae1a529320751ff71d15f87b1a7c9f644e2f3eeb40642cbdef2c73f08010a8d7` |
| 17 | `123pan-uni-app` | `6ee08a142bd068e20cb69dddc6272ac5594ea81f` | `b0e0a135f6ef132e88deecec68e1d503121ed64ee3174ecbd0a90818a593e5e6` |
| 18 | `123pan-video` | `32cf90638769c12a955fcfcbe863eb116ed60f8b` | `afe3c574bb0c6fd941605d11b0ada2c99d604d5a85305d34e523f07362fc76cc` |
| 19 | `123pan-virtuallist-antd` | `3073737bd00ddeb5c86b4f50c4bdadd6abb32c75` | `0031df9cfdebeee4522f440118dab49087080390a4adb89a905fc40333d47848` |
| 20 | `123pan-windowsPro` | `dbfa1b5165714dacf9c7cf1e86b060670b49980b` | `19d37db960a4b7634cb347a562920c25d635ec0be666911d1aaffc4309ed3d6d` |
| 21 | `ai-test-agent` | `1a7c4853386a03f67bdd423201ac4a49db8e360d` | `07504407bdf1969eb7dc167a247545b1f8cc4d28f1f4bd7fb022508e577f1791` |
| 22 | `api_server` | `90f78f4673f6a16fe15aa426847feaa58112642c` | `bbafdc6c675375d2853c9625fc71b8df1f5325d43cbb16fc48fa123ede188999` |
| 23 | `api_server_restful` | `8f81ae7a39c09e071f6daadfd8ad92ac888adae8` | `ef87c9807cdc81878062203f4b53b772acd041b5538346ce00c6e6b7ab79486b` |
| 24 | `apisrv` | `199cd433eef186b414d8d417736714005d1f0382` | `5dd3c40a7c1142af186a397f1ba4e1a4eb6e64dc1c6930c52426320f35b82bdb` |
| 25 | `app` | `b8cf2dfa4f1fb392f3574d67d835f5d88137d4cd` | `b2dfc05355198200062542bbc248a39255cd964f53993249c1423bb963353cb5` |
| 26 | `app_plugin` | `47332fa2d8280f587dd71bfff41087694adcf777` | `9dc1ef57415a237085254c8cbfb749c43644478375b2e229126d3da2da22a176` |
| 27 | `app_tv` | `200c237321c40712bb228a82201cc323b5ecffec` | `f15e6754491af3788ce76458c8eec209fb548fa8d09093e05925d5b81b96c1f9` |
| 28 | `app-ui-test` | `d40f94142893a6b4a0c71b0e9924c29f914f6bd4` | `621c4cb9fa6a556acd340b45c4f6d55e29652cb1d8a53d7f11a4982e48369c47` |
| 29 | `artifacts` | `83cedd4510c4173304175ac3ca1d8e907caf86ff` | `3405a2d9f26c6a6f0ea34bd22b8fe4d4042255d666bd062a3078a50da6cb13ff` |
| 30 | `ats-9.0.2` | `19f0f6292a03e01f89f661274eb317d7146d6126` | `35c99f1277c94e7c4ecf1b358392c6c5e3e05a9351b546b74958981de43eca06` |
| 31 | `audit-consumer` | `a17d509ce396f6dea83c0cc57b1590a820eddfe3` | `6fb3cdfa1062d28dc03a374875027da6453ac46fe580d2daa9379502e0fef6f0` |
| 32 | `audit-tools` | `bc6b81f098915c6dab98b0715098de97cabc1ae2` | `1a83832247b2b3f677700f191312c2129f94cc659f9257145f6a8f8cdfc03d63` |
| 33 | `backup-disk` | `58e67d2321a294820da47475cef6bc0fdfac036d` | `46df4ca1988a680318930adc8410a6124df3e70f57f3425e76dad535cc612cbe` |
| 34 | `batch-process-data-worker` | `5f138731d52f91313e6c1409fefb51946a56b039` | `79ea36b60e32bee1eae49d0f7a8a9aea0a30c1412c3d8700e286adcb3e557c7d` |
| 35 | `beats` | `bf60bdaf30f8a2e9eb7a04db12692b1c3b56b818` | `7041cb5d6399100ee4e43d63c377a07e8fd766edebfa96184722de3451d4a775` |
| 36 | `binlog_go_new` | `e4ca89dd8e502d13cf79178ee1d08711d74c385e` | `d48c620dba5be92967a6ce1a482843249dd1bb8c32f2844181f3970def02473b` |
| 37 | `binlog-srv` | `1a5094330f06cbf0812507ea9b02e496e5bb49b5` | `b5ca9132e735a6bfa0f6116c344ac0c041c41e942e00895bd1af5b9ec52d2b4f` |
| 38 | `binlog-to-elasticsearch` | `5763d3acc3c085b58efe0b28c574e69859c97730` | `fa590c7fd1e54345dbbd171fd850a0d7944f3a6da95432e879584e69c751e676` |
| 39 | `cdk_manager` | `ab413aba1b2affb2328eabd9b7bca632e9e0dda1` | `784b4739e0f2b85d76844c2e3a5d7b40c59c068822b1f2ebf0e4e29034053f66` |
| 40 | `cdn-admin` | `c956e9c6f64bf2088339c6d54f04ca5307d938bc` | `63a0c5c5577f08629cabd0987568803b42fba5e9755e1131400f09c9af43c661` |
| 41 | `cdn-agent` | `cc88de43874048ce93d0f177857fb5d9cf5f0494` | `03dad69a3d6a4727d1af0b812050a5b94dd0767d10fe6bde6c629587e7f1d25b` |
| 42 | `cdn-cp` | `fc9e7565cd2d217f680a7a7dd7d19770fcbed98c` | `059ce1a37d773e81f39467af3cea058504b9b3be18a525c7c239f1df7b60b61d` |
| 43 | `cdn-dispatch` | `f8420d0372f7819568977cb0c28a4591988e8f1e` | `a0702f2ad1bc2b28d53016dbce03a03e4fe8c321ef0a4cd8ef7656df4f610efe` |
| 44 | `cdn` | `3b39d33570b1ac853e77c7b8e515e410701fff98` | `48cafef81745a454138ea8b641391d054896a7241aa84814c94c5d5c1050119a` |
| 45 | `cdn-go-proxy` | `91f8de7f17b6458496836186916d18166c326199` | `fcc46b8482444493db1bf01fbe33d1da295ebc934534e193c28f97a2ca81e002` |
| 46 | `cdn-manager` | `745413615cbcdcf7cf68db0dc75b4e15c576ff6c` | `8dd9d898c88e23f40910f3d6af00317f028afb42b16a4e0e7629dfa1d3318daa` |
| 47 | `cdn-proxy` | `060d4aade7b9b12a1da33e00657d450317a41e65` | `25699c266344c3196d1ea0fc6df0f9ebd22ee48f78b06fdbe29de944cb2d3854` |
| 48 | `cloud-disk-ws` | `81d83811533d0d46f343ce89ae47d8b9449ab9d4` | `065044b89d2455b2f1b88009908fdaa71c18ca970300b0635e6a9c8740926418` |
| 49 | `cloud-drive` | `db6f3a1e7e2edb8d1f86fcb7e42c1cdf3f6ee97f` | `12696c8ad83cc48eb2d59b53f015c055a45936008ec93e6042269780710ffd35` |
| 50 | `cloud-drive-migration` | `3aaad51a331960d97ed708baf5228d73c822569d` | `0f7e9d2f150ed17a2bb1667908930caa2a0872ff6b65817a99e72cf2d10aba49` |
| 51 | `contentTreeSrv` | `b3aed6dd6f5083d7d9cd95be869f2f44a0825a20` | `f9850e5e65975fa1e96f2e8a040589ccf86ab3b8cd922e9d4aa167f8920e82c2` |
| 52 | `copy-file-schedule-worker` | `313556bda6f67e221c81be882bbd28a56031fc00` | `2b737487675bcab864bdba4d321d9536f15c28d34aed5dcd40828753588bfc38` |
| 53 | `copy-file-worker` | `a2790f92ec99f264a5065e5546deca43ad6ff4d1` | `96aa190664beccc7978db9380a89901834990e5b5e2b7076fd07324fbcabfb11` |
| 54 | `coredns-cdn` | `575c9f14edacccbbbc4d4e5e1516b753b6a150c8` | `18c99015caae7fc4bc8cf08a211146751c7ae2c4a6a07e2c389091c6182cc74c` |
| 55 | `coverage` | `d09f2e8f7dfa69dbc9616624c646b23611fce2d7` | `04f5d79f3e2dd6faf9a004adc9078b35aa85132480491e6329bc92ec7c5b18ae` |
| 56 | `crazy-api` | `8666aa2b2449c8d1867f08cc54f0f91685da6c1f` | `713e06fd39c6ce219d65117c99a6f85d97b57159f1d67e820c20b68a0d2cffa1` |
| 57 | `cron-scripts` | `83f95ed728f9e5169d2f4f04b7659ac397853157` | `e93db5c3da43c485bdae1a02aa457bbc1b8ebbf5197a4172544a0b5b49f1e790` |
| 58 | `crontab` | `a073838bae071a85cbca2c36c6c60fa123fcd0a2` | `87a2cee5751389ca38d9fa2675cf8fac2a7a3b07b147d966eb936d3b8de661f9` |
| 59 | `crypto` | `796da340acfa0efe19f91482a709aa9dc4d10ac5` | `421aad611e504f578cc4757ef98bfd2b4dd486e2d148ea6ccb8537a81558c02c` |
| 60 | `defense-nginx` | `0f74d9888ff161a7c31e6c2b2da4115bf7efbf49` | `1263565a5b0ac80246658a4cdfd9956c70cdb70c9b91bb9e30e184cd70aef5b3` |
| 61 | `devops` | `ea6a2204a49a5991ede3ba5616410a07e09e0c67` | `88f1a044b4e2fd3fb6cbf83653f85071585387f2e6f4548ac0c19c3ab7a32621` |
| 62 | `dispatch` | `b17e0c8cb1d24e0e84c99de364b0d48b8466ca4e` | `32bd48a2950f8fdd25375a94d009540b06a54f0a4be6a0307d19265a4ebbc1d3` |
| 63 | `dispatch-monitor` | `a1141b1cd8be1df4a51e73eb9bc3b58f4217b071` | `0d663b39691d52c8e79fb0d7726798d44e7c8d2143ad3d07699ec2851c1067d2` |
| 64 | `download_peed` | `2a2a1d6042fd7a7bd260c892f9c4777a56911182` | `6a5d42fd005aba7b4e1b876abcfb17dfac109e177dfd05797e9b53dc5258186c` |
| 65 | `eslint-config` | `06cc94ed109597d590a2802a3ca1cb7ff9c3f208` | `9719a1bc3318b67eb7f61e64a70ff65b6de0a768db9cb56788fe7e91d07545f9` |
| 66 | `event-tracking` | `46e8425ec75e226ca294fce5e3f7aa3efd52f5d2` | `2ed7b5db1e9baf8622c620d360a91b80fe8a3cc67dfde22467dc9799a75b0864` |
| 67 | `file-analysis-worker` | `0630478e27d960c4446e9a3360985777d1a4c052` | `861e5a299b806fb5f255d7aeb08b23475c60e91bd5e31f8eb8bc680bc6bc508a` |
| 68 | `frontend` | `dc17a79c8f76fec468d8c5ff61efd16078977f26` | `a0ee44e765a611a750f217e531f7dd247baaf92821ae93c817aa96f3d9c83aa4` |
| 69 | `gcache-adapter` | `81b5b83322f09ec19c425d98039d10f428b7a2aa` | `14aaf545134e031a328ad7d0599caf07eec4fc514bbbebe7cdf4c7fc9fd4d504` |
| 70 | `getconfig-api` | `dc076d643733eab71faf415ad4ba95304fc6d892` | `1ddf3a8540a88d859247a4e1da003fc07a6c377d49a4cc8b0c729c7cebc7d956` |
| 71 | `get_domain` | `7aa11b72af5ee11712f4dd440b024bebcd94183b` | `36286814ff144345f2c246a233cd03e553809ec73aa1c680e26c098b047fa634` |
| 72 | `gf16` | `286501fdcb33b93921c0c271d0a088fc86ee91ab` | `041664c09ecb4e9d64e56c5d4cd2d315f879dec309dfd9ced6279f98999a2329` |
| 73 | `gf-jwt` | `8325f78dcbce474b1de645d67f44c6d3ca8a9a3c` | `02cd327b464b8b15a47abf0d02882f4dc79094621e2d624f651ac807a32f6317` |
| 74 | `go-async-etag-worker` | `75c0e76c7a88692a69d3d699a6e9bf3def14fe79` | `b93d3350e12595ec4ab1a7d47168369aa632d44982950786072ad4543a73d0a7` |
| 75 | `go-cloud-capacity-worker` | `d000f8f29c5f9c4ad5b791f7abc0566abeeee6c9` | `70c62834da49dd669dd76b000e8be02223d106ec26557bb6884ad0c1e9b5736f` |
| 76 | `go-direct-link-worker` | `999b3f16968549a78107208dcdc146b5e13d13df` | `823f768cc3183518a4f12b4da3e070639f73412dbceecb74f736ccc08f28a2bd` |
| 77 | `go-etag-worker` | `4c3fcdcaa12f949684ce0641ce9344c564bd107b` | `a7d69676984f9e4848b4e2e182d3d31be2dcb662f98b12ba498c6815d8fdb1cb` |
| 78 | `gofs` | `f469b09cd00c880fe2261ed56e9dc7f833ba8757` | `007e64baebbe1bd5e31b1b82fa29fd651617029255d46b5278573038620af989` |
| 79 | `go-kafka-service` | `06bf114b2641d728ba89f73d4359f258b3e3f9d8` | `d57996afb14476e669655fa6c16caa064c9ba28b0a36055789adf9f2f766b3ee` |
| 80 | `go-protobuf` | `f7241b51a41fce983a77cf959c049b4646c3d475` | `b96718a6812af41af448f2baaa153a4df986d7790c7f9e635986b2dedf2ab18d` |
| 81 | `go-share` | `227b1e05dca17bdd636b1587133bae43640f2a31` | `3aaa0439e7f35e888ebf9fea43362f68754b2dcae67b4c642075a63114c678a8` |
| 82 | `go-thumbnail` | `7e8f7629807f61b5e9cec1ba0efa66b8ffaddb8c` | `15fa7f5eaee2aedc3cfef7ff5a230c3fd39a10c93b7944f05f8c06c50b03e295` |
| 83 | `grpc` | `745413615cbcdcf7cf68db0dc75b4e15c576ff6c` | `8dd9d898c88e23f40910f3d6af00317f028afb42b16a4e0e7629dfa1d3318daa` |
| 84 | `gts` | `bc6e529d71336ac4da0ca186c8697a055a52affd` | `baf974515838e3408156b945948e0ed3ae0efb1914a2757f35cfb599208f3823` |
| 85 | `health_check` | `4d809103e4f9dc0ad6c42db1e9f339b17a0ad15d` | `880f82cbc0459c47f539ca039eff118ceb83469a9edf00823d8d8375ed33180a` |
| 86 | `helper` | `14ea969230c7270f01664628d40fcb78fa02fdc7` | `394f6f579373ec4a4d474377da774acea799d35e567d5fc4e6e766f598b6247a` |
| 87 | `jmeter-offline` | `50972e3c92ee681cd2fbe9d715dbc0e3c4233611` | `5cec7694ab2867f2ee17dfc799de928a3c44d34a22e570fc39dd4a387ed6d377` |
| 88 | `kong-2.5.0` | `050d3c3736950fa82d130195e9e874aa7822699b` | `061dcc0102868bcea34c7200b8b681d6aa19794a3c58ef65753d7798e248c326` |
| 89 | `log-agent-client` | `e89e355f16f7e3a8fffefd619eafe66ca2a47c00` | `dcc684da33de6ebcc599582f55c5e4e478df9d4738a7ed7520f17f326c8094e2` |
| 90 | `log-agent` | `f6a35c4a5e9c4512b1c8e9a875cf166b755a1d0b` | `2880a19e090e19c903128d0ab8597da29aa45de5d8be8de1b2c07cb695ac6e20` |
| 91 | `log` | `a15fd766045f951c3ae2c108fd3170e983f89ee8` | `c4bc377b45b1d97dc4ad56fc80480d235664d7656eb68da6d553d264cff1d9c9` |
| 92 | `metrics-consumer` | `725809cfd0d53918e544ff00adf3cfabca2fd22d` | `f087b201760f578ff9611036d3d1d3c28d88af12baa948386538d21fccfe19dc` |
| 93 | `minio_deploy` | `0544075bd92856d81d5788387dfe620565c1035c` | `75e2b4c6ab44814953ee494cb7451e6c4d552aa58cc638e13056d062518ee9c8` |
| 94 | `mount-disk` | `ee09a2fdfab91468825e775d03d7924e8d9ad5d8` | `ffbd94196e78edcc50f29ecc18ba479fcb3406a4f1c9cee120e6afc6b15da958` |
| 95 | `mount-disk-ws` | `c04d125fa9ebdfa8a7ddbf77ce01dfe9c12c3fcd` | `6175feb458f8bb2a35563d829a71901f3ac4906be1a409b50f2403f234c590ce` |
| 96 | `mq_consumer` | `4ababcb77890a5e1ef24a493a8e8acd1d258af5b` | `6467af3565b778a99c211f97ee8da115240dd7d25161c2c2bf3e0173c822f8b1` |
| 97 | `mq_consumer_v5` | `1ac84438485441ac5db5d49754012e7c2394693f` | `6b1c68256ddff7541134a76886db70f5f8fc932ffe1b189fab48d673f7ea2db1` |
| 98 | `mq_copy` | `21aeb5bac28f020ad045c247f574035ee7470abb` | `2fe8d5df984185fa041a731b312e39f01ab9e8c251ad64ea0739daedcb3eac81` |
| 99 | `new_audit` | `ef11497bfc5985ff043c7672e2336d1a395662f6` | `eda7710223b1ae1ecb983a893aeeca1ab23225230b7c96e9b5d8679407eb1677` |
| 100 | `new-year-worker` | `380c727cd287b99aeadc6d1767822c7835e1b0a5` | `9dde5add63c8e9165f5f34cfaa142194e0746c551cd72f1d1b1f113a3ffe8d4d` |
| 101 | `nginx-proxy` | `b542d43c4fd01b366b3d8deba5357b00f1f7fac4` | `bdc30379c2a49a051fa2f6d1bbbc41f57a84b04ed73348bb8115c599618bf523` |
| 102 | `Nimbus` | `e8dd383f4314bb990dd33c5ac2efeb05d4805e84` | `4a5289ef71434ac2f585730ae3ad21a52e1387526ce43acd2372ff2ed4ac01aa` |
| 103 | `offline-download` | `aa81f6dce8cf01745dfd43a8b0f4acee52dab9c8` | `75c8cb68c56590db6f5180b41202c5d14a0c66eb9742db1087059f3d991d12bb` |
| 104 | `OpenAPI` | `3cdbc5767551f58a7d6de2e7b5f43eb8fa7d6634` | `56ee21071167d4d010e012fbbd847ecb321bb8d915f05159d96496819cf9749a` |
| 105 | `openresty-cdn-gateway` | `6c687459e4d54b8dc4b632c5d634652bf4eb5943` | `f54ddb2f8f9857cea3d6f7dedf3796e7548d9a2d79fdc1b9a7f624356a054cfe` |
| 106 | `osssrv` | `161c3cbc92ed299f033c0e26e6911a4b09714639` | `80e3ffebe021fc9e3b2370dd1012536c53013b871cf46240f7e33af3326ac1d9` |
| 107 | `pay_server` | `d1f7c0c8649a86d48151b66c0322c3593318dd66` | `0ef63f219a85aaa767a7f5759c9e413e03c007510a048f59114174efb9935adc` |
| 108 | `performance_front_test` | `af6d6532d49b6265c0b2ae528610006d9aeac2c9` | `bb20d15b3b95952596ffbf6c17373a6ab278e2e95d5ceb59bd2eba377367d64e` |
| 109 | `phoenix-share` | `4f10ed99addff04d5f13f9ab218f629c6745a99f` | `483eedc3b5b743b1869673e52753664c0c76695a43d2cdca233a2465190e06e1` |
| 110 | `php-audit` | `b718cc18103a7190d437386172738ad891ab429c` | `5eee7ca782f295e2ccd4b43312eeb4d991ab88e58c143a794d1b4d4e73e5b175` |
| 111 | `platform-api` | `aeff1b7adefb29673ff80e92658dbf52a131337b` | `95dfa090e065a28ddc756b176ccc457df6c399d8615e0ffa7ce077ac77e8008b` |
| 112 | `platform-fontend` | `ee47b36de39c20f8ce96dd97861a0d65ef3586f8` | `38c683bafe3c52040ec54044d9d150cc1469a5b15c91280b9004e0296edfbd85` |
| 113 | `redis` | `b847ff0bf7bb05a5b9fad9a126a8dd71640a82b0` | `e24592ce473282ffdfe1782bbdbc12af41796d4b991eecb9cc6c077f19f40c00` |
| 114 | `reference-count-worker` | `6aaf3882087e656a24895f5edf151224442277f7` | `a12b7d9edc201aa05ffd4e4f924a95ffd576a49320f37fe2f0660f445de9504b` |
| 115 | `refresh-center-agent` | `4d35808b40ca3480ba13f120346dc03871c306fa` | `b88eb5d4a74249bbc54454f0c9e28068fdc2f493b49eda73b45e886414965dc1` |
| 116 | `resource_manager` | `1a9852355be02310c311f7943eac1b80da70823b` | `f0a63fe491573b9701e7be5e285b67b398dbff8d576161597525e6be050f7884` |
| 117 | `review` | `d92f6df0cee395a50d656ea9a4fdf9ec983c1bda` | `edb7cb83f80390cc1f90f93a8c3e68dc949a0a5651a2fe3b6d366de905c6975d` |
| 118 | `s3-migration` | `c691fb1e499dcbc98fc3d6453c985a38d565c115` | `5ecff79497c9f308b9c90037bf35f55f750ca855867d800579b07780c1543a81` |
| 119 | `save-copy-worker` | `047b550cffb104fb5c8203cc10ad7b2c87679521` | `cab05b4fee2a122df0e045efc32fa7d2c805bcd0876d32eed0efd4ed84035b94` |
| 120 | `share-consumer` | `6e70944753500dc46d188b7c3e70309e259e0443` | `bfc2b7edc4b4c2a1fd8b9c96f4fe535b2119538555cf5cffcfd2474d50d7baae` |
| 121 | `share` | `e73c5527120a8f824b874706093b06bb85e15d68` | `c0c68195be5b060b9fcb8b2e0d7ba40d3c94da26b8e3f4f9c4184e17d142aa75` |
| 122 | `silentDataBinlog` | `d25f0fb8851aa02b5fd0ff1337c6d60609bb8281` | `17c484b6a797d1c0a00fca8a85cc8b95186c6f91289312f645121bffc00be503` |
| 123 | `silentDataES` | `d4b8dc98ab2362f6dcbb25f77bed48973856a3d3` | `0ec755e742efb6e15b91119c57b56e310be43057ce8f55a790b19809e669eb78` |
| 124 | `thumbnail` | `2abb3c39bd1d50278fb8f3e3a0685a473947caa2` | `c238880ea5be26994fb4cd04aea2e1ec2be76790400d35df97832946bac026d8` |
| 125 | `tl` | `947413fe4ae48973079723348829a0287e39e129` | `1c64fbe7cb0eadd3c2a4fb3ab8922817036f3e17714f5c03acfc9d993bee84b6` |
| 126 | `track-consumer` | `45ecf3e30465005a2e665703b61aad87ba3b538a` | `83fa275ad5312ca59a984a650d677b5d71d0d39d372b5fd6bd766c313603c879` |
| 127 | `trafficserver` | `eca93ed61e15b2e25ce1e47b3672f7900a05a5df` | `11b7692b3b8581ae873cf917ff9d4a2ff0f4df05e0056550864c664a4b3f77dd` |
| 128 | `transcode` | `24126b6d5bbba33004c478e10d7490386ab758a1` | `fd642f8a689b36f8bed9b24e16732091277b4b5a49eab2e223df9db31441ad2a` |
| 129 | `transcode-proxy` | `171e3e51200077c03fbe9969cc691549386f2812` | `b056cd05e7da5f58a0fe6d70797822ffca3efd7a1976e5ac6355f98611cc43d6` |
| 130 | `transfer-schedul-worker` | `3bdf6432854098bb9c5d445cdcfcf29b7edcc66b` | `15d2ccd5ac052c4b064b58b57e661b1b786d744db87aedbe224efc4885caad70` |
| 131 | `uncompress_srv` | `3fb09f40e91381731889058e6ac4049528bcbffb` | `fe72f8d48d0869caddc580719a429339fcc14e12241e3189652eeaf7ad8e44f1` |
| 132 | `upload-consumer` | `b622410aa28bab24e4a07986496767189977a0f3` | `703f95352713c6e73234578fe098db68f18d0d3ce9a7cad4a7b58610c3a242b0` |
| 133 | `upload-server` | `1c21122ca55dd667b2b5845eb7ab8c9231aa6c2b` | `9f63df54193b2808a815099167e0ab3c580a8198842201ac4b89b5966b6074fe` |
| 134 | `usercenter` | `2caf4507c2a095b15c95d7db5a8385ab1a6a94fc` | `f0d44c406bb32fb8effd7fa1d2ab8a065eaaafe96ca25914afe3973c4047c608` |
| 135 | `uuidsrv` | `21d49caef390ce7da18b342e92e5288f837a3e94` | `056fe910c8cc27dc4bab94ede939a4a66e7cf290f4502c9fa7cb7f3f689e699e` |
| 136 | `video_audit_work` | `189976ddd51a02430e0aef389e8c0d5672836801` | `81d430471db1a1b63352d634be36efa39a528995c625c33b47a768d090467c8f` |
| 137 | `webdav` | `717f48d88c5c398bdc73e42c56bd9fcfddf99ef0` | `8aadbfeeec5afc06597b8127fae2f47fb4a77e4b894caa85e699442f28d740d7` |
| 138 | `Web-Nexus` | `c0bb5cd4677c74d6ab13431854753197ca2e4f82` | `4ccad7a7757ff8bfd8dfa98e0cd0b583e444e229501ab7268538ffc3192c4e5e` |
| 139 | `web-ui-test` | `fccb201bd5eb67b0b7f4a1c427d1bd7bb7328d5c` | `3f022519ae17ee95c79b7f0d9d6c9b6ccdba51198268480effc6eaacc6f179ae` |
| 140 | `windows-component` | `f94bce4115b6050e5e439e67403094dc1a414ff1` | `fce6295473557b20e4c6bb391ba35c5d387ab8231e40bd7efa8e68c70a4d0d72` |
| 141 | `xgo` | `b5747d20b7427fddeb1a1294f598f18b6acc4fe9` | `33fb7a858a9d349729374bd1b4260c40fa92b4cc21b1177d563394fb2f0b5552` |
