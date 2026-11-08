# scripts/ 里两个夜间任务

两件事，一个目的：**材料上那句「代码快照」必须是真的**。

```
05:05（dogyun）  scripts/sync-mirrors.sh     镜像仓 master 跟上 codeup
05:10（本机）    scripts/index-nightly.sh    新提交的静态索引进本地 Postgres
```

两边都是**仓库里的脚本**（本目录），线上/定时器里只装「薄壳或哈希可见的副本」，
没有第三份手改的版本。

## sync-mirrors.sh（服务器）

在 `dogyun` 上以 root 跑，把 `123pan-pc` / `123pan-uni-app` 的 `master` 从 codeup
fetch 进 `/srv/123pan-mirror/<repo>.git`（bare），用 CAS（`update-ref` 带旧值）更新
本地 `master`，然后把写位收回（目录 555 / 文件 444，owner root）——这两个仓被
flowers 的走查/评审**只读**读取，同步完就不该再有人能改。

- 日志：`/var/log/sync-flowers-mirror.log`（`SYNC_FLOWERS_LOG` 可改）
- 锁：`/var/lock/sync-flowers-mirror.lock`（`flock -n`，抢不到退出 0 并留一行
  `skip: another sync is running`）
- 一个仓失败不拖住另一个；任一失败整体退出 3
- 日志里 userinfo 一律抹成 `//<userinfo>@`；`config` 里不许有 `remote`、不许有带凭据的 URL
- 退出码：`0` 成功（含 `moved=0` 已是最新）/ `3` 至少一个仓失败 / `2` 环境不对（缺
  flock、建不了日志或锁目录）

**它必须跑在服务器上**，所以本仓库这一份会被 rsync 过去：

```bash
scripts/install-cron.sh --server   # rsync + chmod 755 + 备份 crontab + 追加 cron 行
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
- `/srv/123pan-mirror/123pan-cross-frontend.git` 不在 `sync-mirrors.sh` 的白名单里
  （本轮只要求 pc / uni-app），它的 HEAD 仍是 `aefda58`（2026-10-21），而
  `code.mirror.repos` 里有它——索引会照它算，材料里也会照它写快照日期。
