# 镜像新鲜度（2026-11-08）：让「代码快照」是真的

三件事，一条链：**镜像跟上 → 索引跟上 → 材料说清对着哪一版代码**。
前两件是管道，第三件是产物上唯一能被 PM 看见的那句话。

- 服务器：`dogyun:/opt/123pan/tools/_ro/sync-flowers-mirror.sh`，cron `5 5 * * *`（root）
- 本机：`~/Library/LaunchAgents/com.flowers.index-nightly.plist`，05:10（launchd；本机没有 crontab）
- 两边的脚本都在仓库里：`scripts/sync-mirrors.sh`、`scripts/index-nightly.sh`
  （+ `scripts/index-nightly.ts` 实现、`scripts/install-cron.sh` 安装器、`scripts/README.md` 说明）

## 0. 结果速览

| 项 | 结果 |
|---|---|
| `123pan-pc` | `afff7295` → `3354b4a1`（**真前进**，2026-11-06 18:18:29） |
| `123pan-uni-app` | `5eaa03c` → `6ee08a1`（**真前进**，2026-11-06 18:18:15） |
| 服务器 cron | 已加 `5 5 * * * …`，crontab 先备份 |
| 本机索引 | 首次跑：pc 4 块新内容、uni-app 0、cross-frontend 23；重跑全 0 |
| 材料横幅 | 「代码快照：<仓> @ <日期>」+「代码快照较旧（N 天前）」 |

## 1. 服务器：镜像仓跟上 codeup

### 1.1 为什么是「副本 + sha256」而不是「薄壳 exec 仓库脚本」

两条路都考虑过：

- **薄壳**：`/opt/…/sync-flowers-mirror.sh` 两行 `exec` 仓库里的脚本 —— 做不到：
  服务器看不到这台 Mac 的仓库。
- **整段同步从 Mac 上 ssh 过去跑**：可行，但会把镜像的时效性绑在「05:05 时 Mac 醒着
  没有」上。镜像服务的是服务器上的另一个进程（flowers 的走查/评审），不该被一台笔电的
  睡眠拖住。

所以选**副本**：`scripts/sync-mirrors.sh` rsync 到服务器，安装时打印两边 sha256，
`--check` 一比就知道漂没漂。漂了重跑 `--server` 即可。

```
$ scripts/install-cron.sh --server
== 服务器（dogyun）
   写入 dogyun:/opt/123pan/tools/_ro/sync-flowers-mirror.sh
   本地 sha256 0c00035fc8f50742eaff79e5426e100f29e75b02a48367df4282a2e419ddc2d2
   远端 sha256 0c00035fc8f50742eaff79e5426e100f29e75b02a48367df4282a2e419ddc2d2
   备份 crontab → /root/crontab.bak.20261108-094500
   已追加 cron 行：5 5 * * * /opt/123pan/tools/_ro/sync-flowers-mirror.sh
```

（第二次执行时那一行已存在，安装器跳过追加，只又留了一份 `crontab.bak.20261108-094742`。）

### 1.2 脚本要点（完整实现见 `scripts/sync-mirrors.sh`）

- `set -euo pipefail` + `flock -n /var/lock/sync-flowers-mirror.lock`；
  `GIT_TERMINAL_PROMPT=0`；日志 `/var/log/sync-flowers-mirror.log`（`SYNC_FLOWERS_LOG` 可改）
- 凭据走 root 的 `~/.git-credentials`，命令行 URL **不带** userinfo；日志统一过
  `sed -E 's#//[^/@ ]*@#//<userinfo>@#g'`，`config` 里 `remotes=0 / userinfo_urls=0` 也照旧检查
- `git fetch <url> master` 只写 `FETCH_HEAD`；更新 ref 用
  `update-ref refs/heads/master <new> <old>`（**CAS**）——fetch 半路失败不会留下半更新的 master
- 每仓独立：`sync_one` 返回非零只置 `rc=3`，循环继续（一个失败不拖另一个）
- 日志逐仓 `old -> new moved=0|1`；退出码 `0` 成功（含 already up to date）/ `3` 至少一仓失败 / `2` 环境不对
- 权限：同步完 `chown -R root:root` + 目录 `555` / 文件 `444`（这两个仓被只读读取；
  root 自己下次 fetch 不受影响）
- `flock` 不在时（例如有人误在 macOS 上跑）直接 `exit 2` 并说清「这是服务器上的脚本」，
  不许伪装成「已经有一轮在跑」

### 1.3 第一次手工跑——真实的两次，都留着

第一次（09:45:03，pc 因 DNS 抖动失败；**这正是「一个失败不拖另一个」的证据**）：

```
=== sync start 2026-11-08T09:45:03+08:00 ===
FAIL fetch 123pan-pc (rc=128): fatal: unable to access 'https://codeup.aliyun.com/60f9058e68e2993a8e6d0750/123pan/123pan-pc.git/': Could not resolve host: codeup.aliyun.com
OK 123pan-uni-app 5eaa03c -> 6ee08a1 moved=1（2026-11-06 18:18:15）
cfg 123pan-pc remotes=0 userinfo_urls=0
cfg 123pan-uni-app remotes=0 userinfo_urls=0
=== sync done rc=3 2026-11-08T09:45:29+08:00 ===
```

第二次（09:45:33，pc 追上，uni-app 已是最新）：

```
=== sync start 2026-11-08T09:45:33+08:00 ===
OK 123pan-pc afff7295 -> 3354b4a1 moved=1（2026-11-06 18:18:29）
OK 123pan-uni-app 6ee08a1 -> 6ee08a1 moved=0（已经是最新）
cfg 123pan-pc remotes=0 userinfo_urls=0
cfg 123pan-uni-app remotes=0 userinfo_urls=0
=== sync done rc=0 2026-11-08T09:45:50+08:00 ===
```

权限与读路径：

```
root:root 555 /srv/123pan-mirror/123pan-pc.git
root:root 444 /srv/123pan-mirror/123pan-pc.git/HEAD
$ git --git-dir=/srv/123pan-mirror/123pan-pc.git log -1 --format='%H %cI' HEAD
3354b4a15aae1dd44753a767eeb91ebd3d076a66 2026-11-06T18:18:29+08:00
```

失败路径也验过（`MIRROR_ROOT=/tmp/no-mirrors`）：两仓各一行 `FAIL … 目录不存在`，`rc=3`。

### 1.4 cron（逐字）

写在 root 的 crontab（`crontab -e` 语义：追加，不重写），位置在第 20 行，紧接 05:00 那条之后：

```
0 5 * * * /opt/123pan/tools/_ro/sync-repos-ro.sh
5 5 * * * /opt/123pan/tools/_ro/sync-flowers-mirror.sh
```

备份：`/root/crontab.bak.20261108-094500`（另有重装时的 `/root/crontab.bak.20261108-094742`）。
撤销：`ssh dogyun "crontab -l | grep -vF '/opt/123pan/tools/_ro/sync-flowers-mirror.sh' | crontab - && rm -f /opt/123pan/tools/_ro/sync-flowers-mirror.sh"`。

## 2. 本机：新提交的索引在 05:10 补上

### 2.1 定时器：launchd（本机没有 crontab）

`crontab -l` → `no crontab for silas`；`~/Library/LaunchAgents` 里已有一批
`com.silas.*.plist`。按「已经在用的机制」选 launchd，`StartCalendarInterval`
Hour=5 Minute=10（**等价 `10 5 * * *`**）：

```
$ scripts/install-cron.sh --local
== 本机（launchd）
   写入 /Users/silas/Library/LaunchAgents/com.flowers.index-nightly.plist（StartCalendarInterval 05:10，等价 cron 的 10 5 * * *）
```

plist 关键项（全文在机器上，安装器会重写）：

```xml
<key>ProgramArguments</key>
<array><string>/bin/bash</string><string>/Users/silas/flowers/scripts/index-nightly.sh</string></array>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>5</integer><key>Minute</key><integer>10</integer></dict>
<key>PATH</key><string>/Users/silas/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
```

**踩过的坑（已修）**：第一次 `launchctl kickstart` 的 `last exit code = 127`，
`.launchd.log` 里是 `env: node: No such file or directory`——`node_modules/.bin/tsx` 的
shebang 是 `#!/usr/bin/env node`，而 launchd 的 PATH 不带 `~/.local/bin`（这台机器的 node
在 `/Users/silas/.local/bin/node`）。修法不是「给 PATH 补一行就完」，而是**不依赖 PATH**：
`index-nightly.sh` 显式找 node 并用它起 tsx，`index-nightly.ts` 里 spawn 子进程也用
`process.execPath`。修完 `kickstart` → `runs = 1, last exit code = 0`。

### 2.2 脚本与日志

`scripts/index-nightly.sh`：`set -euo pipefail`、`--help`、`mkdir` 原子锁
（`${TMPDIR}/flowers-index-nightly.lock`，macOS 没有 flock；陈旧锁按 pid 判活）、
`FLOWERS_INDEX_LOG` / `FLOWERS_INDEX_LOCK` 可覆盖、退出码 `0/2/3/4`。
仓列表**不硬编码**：`scripts/index-nightly.ts` 用 `resolveMirrorConfig()` 读
`app_settings.code.mirror.repos`（env → 设置 → 默认，整份作废不拼半份），逐仓
`head()` → `scripts/index-sync.ts --repo <id> --sha <sha> --json`。

日志每个仓一行 JSON（`~/Library/Application Support/flowers/logs/index-nightly.log`）：

```
{"ts":"…","repo":"123pan-pc","sha":"3354b4a1…","newBlobs":4,"ms":1616}
{"ts":"…","repo":"(run)","sha":null,"newBlobs":27,"ms":4312}
```

首次跑（09:46）：

```
[123pan-pc] 3354b4a1 新内容 4 块（1616 ms）
[123pan-uni-app] 6ee08a14 新内容 0 块（1050 ms）
[123pan-cross-frontend] aefda585 新内容 23 块（1174 ms）
{"ts":"2026-11-08T01:46:01.738Z","repo":"123pan-pc","sha":"3354b4a15aae1dd44753a767eeb91ebd3d076a66","newBlobs":4,"ms":1616}
{"ts":"2026-11-08T01:46:02.930Z","repo":"123pan-uni-app","sha":"6ee08a142bd068e20cb69dddc6272ac5594ea81f","newBlobs":0,"ms":1050}
{"ts":"2026-11-08T01:46:04.253Z","repo":"123pan-cross-frontend","sha":"aefda5852304eeb0b475f87baa88263164babc4c","newBlobs":23,"ms":1174}
{"ts":"2026-11-08T01:46:04.254Z","repo":"(run)","sha":null,"newBlobs":27,"ms":4312}
```

重跑（同一 sha，**必须** 0 块）：

```
{"ts":"2026-11-08T01:46:10.879Z","repo":"123pan-pc",…,"newBlobs":0,"ms":1240}
{"ts":"2026-11-08T01:46:14.159Z","repo":"(run)",…,"newBlobs":0,"ms":4918}
```

镜像不可达（`FLOWERS_MIRROR_SSH_HOST=no-such-host.invalid`）→ `exit 3`、每仓一行带
`error`、锁目录已被 trap 清掉（`ls: … No such file or directory`）：

```
{"ts":"2026-11-08T01:46:15.746Z","repo":"123pan-pc","sha":null,"newBlobs":null,"ms":91,"error":"ssh 读取失败（退出码 255）：ssh: Could not resolve hostname no-such-host.invalid…"}
{"ts":"2026-11-08T01:46:15.770Z","repo":"(run)","sha":null,"newBlobs":0,"ms":114,"error":"3 个仓失败"}
```

## 3. 材料里写上「代码快照」

### 3.1 措辞（`src/core/locate/copy.ts`，逐字）

```
代码快照：123pan-pc @ 2026-10-16
代码快照较旧（23 天前）
代码快照：123pan-uni-app @ 2026-11-03
```

- 用了几个仓就写几行（`snapshotLines()` 按传入顺序，一行一仓）；
- 某仓 HEAD 距今 **> 14 天**（`SNAPSHOT_STALE_DAYS`），紧跟它那一行再写
  `代码快照较旧（N 天前）`——「较旧」说的是它上面那一行，所以不重复仓名；
- 「今天」按 `Asia/Shanghai` 算（提交时间的 `%cI` 是 `+08:00`；按 UTC 算会让 0–8 点
  之间门槛来回跳一天）；
- 日期不可解析时写「代码快照：<仓> @ 日期未知」，不编日期、也不判旧。

整段横幅（候选情形，`tests/locate-snapshot.test.ts` 的 inline snapshot 逐字钉住）：

```
最可能的位置（待研发确认）：
1. `src/pages/search/search.vue` ← 路由 /search 的页面
以上是线索，不是结论。请与研发确认现在实际是怎么做的，确认后更新 PRD 文档，材料会标记为旧版并重新生成。
代码快照：123pan-uni-app @ 2026-11-06
```

### 3.2 接在哪

- 走查材料（`inspect.ts` 的 `locateBannerText`）：结论（去重后）末尾 `withSnapshots(body, repos)`，
  `repos` 是 `RepoBaseline`（自带 `id` / `date`）。
- 评审材料（`review.ts` 的 `injectBanner` 调用点）：`Baseline.repos` 由 `{id, sha}` 扩成
  `{id, sha, date}`，横幅 = `withSnapshots(renderLocate(baseline.locate), baseline.repos)`。
- **评估材料（`compose.ts`）没有代码段、也没有横幅** → 一个字不变（原本就没插 `injectBanner`）。
- 没有仓（代码根本没读到）→ `withSnapshots` 原样返回结论：不写一件我们并不知道的事。
- 提示词里的「现状基线：<仓>@<sha>（<日期>）」本来就带日期，未动。

### 3.3 变异表（实测跑过，压缩）

| 变异 | 红的用例（实跑） |
|---|---|
| `SNAPSHOT_PREFIX` 的全角「：」改半角「:」 | `locate-snapshot`：单行措辞 / 逐仓行 / 门槛 / 日期未知 / 整段 inline snapshot（多条） |
| `SNAPSHOT_STALE_DAYS` 14 → 15 | `locate-snapshot`：`14 天是门槛`（1 条） |
| `snapshotLines` 删掉「较旧」那一行 | `locate-snapshot`：`用了几个仓就写几行…` + `14 天是门槛`（2 条） |
| 走查横幅 `return withSnapshots(body, repos)` → `return body` | `tests/inspect.test.ts`：`读到了但没找到：横幅逐字是…`（1 条） |
| 评审横幅 `withSnapshots(renderLocate(...), baseline.repos)` → `renderLocate(...)` | `tests/review.test.ts`：`评审定位接线（任务 9）`（1 条） |
| 快照写在结论**之前** | 构造上覆盖：`整段横幅逐字快照`（inline snapshot 逐字，顺序敏感） |

每一条都先改源码、跑对应用例看它变红，再原样还原（`tsc --noEmit` 干净）。

## 4. 测试

- 新增 `tests/locate-snapshot.test.ts`：7 条（单行措辞、逐仓行 + 位置、14/15 天门槛、
  Asia/Shanghai 的「今天」、日期不可解析、两种 `absent` + 空仓、整段 inline snapshot + 进产物）。
- 既有 `tests/inspect.test.ts` 的横幅用例：结论仍逐字 `toBe`，其后的行必须是
  「代码快照」行，行数 = 用到的仓数（不是 `toContain` 放水）。
- 全量：`npx vitest run` → **66 个文件全通过，1446 passed / 1 skipped（1447）**。

## 5. 仍然会旧的地方（诚实清单）

1. **codeup 不可达**：09:45 那次 `123pan-pc` 就 `Could not resolve host` 过一次（同分钟
   重跑成功）。脚本行为是「一个失败不拖另一个 + 退出 3」——**要有人看日志**才知道那一夜
   少了一仓。镜像旧 → 材料里那句快照日期就停在旧的那天（这正是第 3 件要它写出来的原因）。
2. **Mac 05:10 睡着**：launchd 的 `StartCalendarInterval` 在唤醒后**补跑一次**（不补多次）。
   所以那天的 `ts` 是唤醒时刻；整天不醒就那天不跑。索引按 `sha` 计算，跳过的 sha 只是没
   预先解析，材料一旦指向它，懒建那条路会现建——**不会错，只是慢一次**。快照日期最多比
   镜像旧一天以内，远小于 14 天的门槛，不会误报「较旧」。
3. **`123pan-cross-frontend` 不在 `sync-mirrors.sh` 的白名单**（本轮只要求 pc / uni-app）：
   它在 `code.mirror.repos` 里（所以索引会照它算、材料会照它写快照日期），但
   `/srv/123pan-mirror/123pan-cross-frontend.git` 的 HEAD 仍是 `aefda58`（2026-10-21），
   而 `repos-ro` 那套（05:00）已经把它 synced 到 `6c287f4`。要一起跟上，把仓名加进
   `scripts/sync-mirrors.sh` 的 `REPOS` 即可（注释里写了这条提醒）。
4. **镜像在、索引没建**：夜间任务失败（退出 3）时不会自动重试；下一次跑会补上。若连续
   失败，材料上的快照行仍然是对的（它读的是镜像 HEAD），只是首屏会付一次懒建的 200–400 ms。
5. **服务器副本可能漂**：`scripts/install-cron.sh --check` 比 sha256；漂了重跑 `--server`。
   建议把它也塞进某个巡检（本轮没做：没有现成的地方）。
