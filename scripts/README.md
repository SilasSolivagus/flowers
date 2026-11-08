# scripts/ 里的夜间任务与批量接入

两件事，一个目的：**材料上那句「代码快照」必须是真的**；再加一层「仓多起来之后
哪些仓、按什么顺序进来」。

```
05:05（dogyun）  scripts/sync-mirrors.sh     清单里每个仓的分支跟上 codeup
05:10（本机）    scripts/index-nightly.sh    新提交的静态索引进本地 Postgres
手工/分批        scripts/onboard-repos.ts    建镜像 + 索引 + 覆盖率（repo_coverage）
手工/改清单后    scripts/repos-apply.ts      config/repos.txt → code.mirror.repos
```

仓清单只有一份：`config/repos.txt`（见下一节）。

两边都是**仓库里的脚本**（本目录），线上/定时器里只装「薄壳或哈希可见的副本」，
没有第三份手改的版本。

## config/repos.txt（唯一一份仓清单）

「哪些仓」只写在 `config/repos.txt` 里（一行 `仓名<TAB 或空格>分支[<空白>stale_after_days]`，
`#` 整行注释）。三个读者：服务器上的 `sync-mirrors.sh`、`scripts/repos-apply.ts`（播种设置）、
`scripts/onboard-repos.ts`（批量接入）。**加一个仓 = 改这个文件 + commit**，脚本一行
都不用动。格式、校验、加仓步骤见文件头的注释。

第三格 `stale_after_days`（可选，2026-11-09 起）：

| 写法 | 含义 |
|---|---|
| 不写 | 过期判据用全局 7 天（`MIRROR_STALE_DAYS`） |
| `365` | 这个仓超过 365 天没有新提交才提醒 |
| `never` | **不因「上游不动了」提醒**（上游已归档的仓），但同步失败照样提醒 |

`never` 的边界（重要）：它只静音「HEAD 旧了」这一条判据。`mirror_health.ok = false`
（fetch/索引失败）与「表里没有这个仓」两条**不读**这一列，在任何阈值下都报——
「上游死了」与「我们抓不到」不是一件事，不能因为静音前者而吞掉后者。代价是这几种仓
「cron 悄悄停了」这种安静坏法也没有铃铛了，见报告里「剩下的告警噪音面」一节。

## sync-mirrors.sh（服务器）

在 `dogyun` 上以 root 跑，读**脚本旁边的 `repos.txt`**（`install-cron.sh --server`
把 `config/repos.txt` 与脚本一起 rsync 过去：`/opt/123pan/tools/_ro/`），把清单里
每个仓的**清单里写的分支**从 codeup fetch 进 `/srv/123pan-mirror/<仓名>.git`（bare），
用 CAS（`update-ref` 带旧值）更新本地同名 ref，然后把写位收回（目录 555 / 文件 444，
owner root）——这些仓被 flowers 的走查/评审**只读**读取，同步完就不该再有人能改。

- 清单：默认「脚本旁边那份」，`REPOS_FILE` 可整条覆盖；清单坏了在锁之前就 rc=2
  （一行坏就整份作废：半份仓库列表比没有更糟）
- 日志：`/var/log/sync-flowers-mirror.log`（`SYNC_FLOWERS_LOG` 可改）
- 锁：`/var/lock/sync-flowers-mirror.lock`（`flock -n`，抢不到退出 0 并留一行
  `skip: another sync is running`）
- 一个仓失败不拖住另一个；**瞬时**失败按 `FETCH_RETRIES`（默认 2）重试，退避
  `RETRY_BACKOFF × 第几次`（默认 2 s）——2026-11-08 夜 14 轮实测里 13 轮有 ≥5 个
  `Could not resolve host` / `Failed to connect … after 1 ms`，全是重试一次就好的
  瞬时错误。只重试瞬时错误：分支不存在、仓不存在、凭据失效重试三次只是把答案拖长。
  超时（我们自己的 `timeout` 杀的）**最多再试一次**：两次 300 s 的挂起就能把
  05:05→05:10 的窗口顶过，那时夜间索引会开始索引一个还在同步的镜像。
- 日志里 userinfo 一律抹成 `//<userinfo>@`；`config` 里不许有 `remote`、不许有带凭据的 URL
- 退出码（四档）：
  - `0` 成功（含 `moved=0` 已是最新）
  - `3` **真故障**：某仓在所有重试之后仍 fetch / `update-ref` 失败，或收尾 cfg 检查不过
  - `4` **没有真故障，但有仓还没有镜像**（清单里有、还没 onboard）。这不是同步坏了，
    下一步是跑 `onboard-repos.ts`——所以它是另一个码，否则「昨晚加了 5 个仓」与
    「codeup 连不上」在 cron 里长得一样
  - `2` 环境/清单不对（缺 flock、清单读不到或不合格式、建不了日志或锁目录）。
    注意 `set -e` 之外还有一层：`sync_one` 用返回码 `2` 表示「镜像不存在」，
    调用方据此把整轮收成 `4` 而不是 `3`
  - `flock` 抢不到 → `0`（另一次同步在做）

**它必须跑在服务器上**，所以本仓库这一份会被 rsync 过去：

```bash
scripts/install-cron.sh --server   # rsync 脚本 + repos.txt（各打两边 sha256）+ 备份 crontab + 追加 cron 行
scripts/install-cron.sh --check    # 比两边 sha256、看 cron 行是否在
scripts/install-cron.sh --remove   # 删 cron 行与副本
```

为什么是副本而不是「薄壳 exec 仓库里的脚本」：服务器看不到这台 Mac 的仓库。另一条路
是「整个同步从 Mac 上 ssh 过去跑」，但那会把镜像的时效性绑在「05:05 时 Mac 醒着没有」
上——镜像服务的是服务器上的另一个进程，不该被一台笔电的睡眠拖住。代价是副本可能漂，
所以安装时**打两边 sha256**，`--check` 一比就知道。

## index-nightly.sh（本机）

读 `app_settings.code.mirror.repos`（解析复用 `src/core/codemirror/mirror.ts` 的
`resolveMirrorConfig()`，**不硬编码仓名**），对每个仓 `head()` → `scripts/index-sync.ts
--sha <sha> --json`，一行一仓追加到日志。

日志里还会多一行 `(inventory)`：清单与 `code.mirror.repos` 不一致时告警（**不改退出码**
——下一步是跑 `scripts/repos-apply.ts`）。2026-11-08 的 `123pan-cross-frontend` 就是
「设置里有、shell 数组里没有」漏掉的，这条告警专门盯这一类漂移。

- 日志：`~/Library/Application Support/flowers/logs/index-nightly.log`
  （`FLOWERS_INDEX_LOG` 可改）；launchd 的 stdout/stderr 另有一份 `.launchd.log`
- 锁：`${TMPDIR}/flowers-index-nightly.lock`（macOS 没有 flock，用 `mkdir` 的原子性；
  陈旧锁按 pid 判活，清理后重试一次）
- 日志每行一个 JSON：

```json
{"ts":"2026-11-08T01:46:01.738Z","repo":"123pan-pc","sha":"3354b4a1…","newBlobs":4,"ms":1616}
{"ts":"2026-11-08T01:46:04.254Z","repo":"(run)","sha":null,"newBlobs":27,"ms":4312}
```

  `newBlobs: 0` 是正常的（没有新提交）；失败行带 `"error"` 且 `newBlobs: null`；
  `(run)` 是这一轮的收尾（失败时带 `"error": "N 个仓失败"`）。
- 退出码：`0` 全部成功（含 0 块新内容）/ `2` 配置或环境不对 / `3` 至少一个仓失败 /
  `4` 上一轮还在跑（不算故障，不报警）

安装（本机没有 `crontab`，用的是已经在用的 launchd）：

```bash
scripts/install-cron.sh --local    # 写 ~/Library/LaunchAgents/com.flowers.index-nightly.plist 并 bootstrap
scripts/install-cron.sh --check    # 看任务在不在、服务器那份有没有漂
scripts/install-cron.sh --remove   # bootout + 删 plist（日志与索引数据保留）
```

plist 里是 `StartCalendarInterval` Hour=5 Minute=10，等价于 `10 5 * * *`。

## repos-apply.ts（清单 → 设置）

```bash
npx tsx scripts/repos-apply.ts --dry-run   # 只看 diff（+ / - / ~ / ↕）
npx tsx scripts/repos-apply.ts             # 写进 app_settings.code.mirror.repos
```

写之前先过 `parseRepos()`（与读侧同一个解析器），写之后再用 `resolveMirrorConfig()`
读一遍：**「写进去的东西读不回来」在构造上不可能发生**。环境里有人钉了
`FLOWERS_MIRROR_REPOS` 时，读侧看到的不是设置那一份——脚本会当场指出（这是最常见的
「两边不一致」）。退出码：`0` 成功（含已经一致）/ `2` 清单或现状不合法 / `1` 写库失败。

## onboard-repos.ts（批量接入 + 覆盖率）

```bash
npx tsx scripts/onboard-repos.ts                 # 全清单，断点续跑
npx tsx scripts/onboard-repos.ts --limit 10      # 只做前 10 个待做的（分批上线）
npx tsx scripts/onboard-repos.ts --budget-gb 20  # 这一批最多占 20 GB
npx tsx scripts/onboard-repos.ts --force         # 同 HEAD 也重测
```

每个仓：确保镜像在服务器上存在（缺了就从 codeup `clone --mirror`，**先 clone 到
`<path>.tmp-onboard` 再 mv**，避免半成品 bare 仓被下一次当成「已存在」）→ 读 HEAD →
增量索引（`syncRepoIndex`，与 `index-sync.ts` 同一个函数）→ 量覆盖率 → 写
`repo_coverage`（迁移 0033）一行。一个仓失败**不打断**这一批（记 `ok=false` + 中文原因），
结尾点名全部失败并 `exit 3`。同 HEAD 且上一轮 ok 的仓跳过（`--force` 才重测）。

磁盘闸：clone 之前用 `df` 的可用空间减掉「这一批还要」判水位（默认 10 GB，
`--floor-gb` 可调）。首轮没有实测样本时**只测量不拦**并告警——用猜出来的均值去拦
139 个仓，比不拦更容易误判。退出码：`0` 全成功 / `3` 至少一个仓失败 / `2` 清单、
配置或 ssh 读不到。

## 手工验证

```bash
/opt/123pan/tools/_ro/sync-flowers-mirror.sh; tail /var/log/sync-flowers-mirror.log   # 服务器
scripts/index-nightly.sh; tail ~/Library/Application\ Support/flowers/logs/index-nightly.log
scripts/install-cron.sh --check
```

## Mac 睡着了会怎样

`StartCalendarInterval` 的任务在**唤醒后补跑一次**（launchd 的语义：错过的日历触发
在唤醒时补一次，不会补好几次）。所以：

- 05:10 时机器睡着 → 唤醒后那次补跑执行，日志里 `ts` 是唤醒时刻，不是 05:10；
- 机器整天没醒 → 那一天不跑；第二天的补跑会把 HEAD 追到当时的最新，之前那次增量
  不会丢内容（索引是**按 sha** 的：新 sha 的整棵树都会解析，中间跳过的 sha 只是没进
  索引，材料一旦指向它，懒建那条路会现建）；
- 因此**没有任何东西会因为「少跑一夜」而错**，但材料上那句「代码快照」可能比镜像
  旧一天以内——`SNAPSHOT_STALE_DAYS`（14 天）比这个抖动大得多，所以不会误报「较旧」。

## 仍然会旧的地方（已知）

- 镜像本身依赖 codeup 可达：2026-11-08 09:45 的一次手工跑里，`123pan-pc` 就因为
  `Could not resolve host` 失败过一次（同一分钟内重跑成功）。脚本对这种情况是
  「一个仓失败不拖另一个 + 退出 3」，所以**要有人看日志**才知道那一夜少了一仓。
- 「同步脚本的仓列表」与「设置里的仓列表」曾经是两份（`REPOS=(…)` vs
  `code.mirror.repos`），`123pan-cross-frontend` 因此从 2026-10-21 一直没抓。
  现在两份由 `config/repos.txt` 统一，`index-nightly` 里那条 `(inventory)` 告警盯漂移；
  但**漂移仍要人去跑 `repos-apply.ts`**——这一层不自动改设置。
- `123pan-agent-tracker`（HEAD 2026-08-28）、`123pan-gateway`（2026-09-20）、`share`
  （2025-12-05）、`123pan-ele-react`（2025-11-10）、`eslint-config`（2026-06-01）、
  `123pan-virtuallist-antd`（2023-06-04）的 `master` 本身就旧。2026-11-09 起这几个仓在
  清单里有自己的第三格（`365`/`180`/`540`/`730`/`365`/`never`），所以它们不再每晚各产
  一条 `mirror.stale`。这不是接入出错，是那些仓真的没动。
