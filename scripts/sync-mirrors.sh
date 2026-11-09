#!/bin/bash
# 123pan 镜像仓（`~/code-mirrors/*.git` 与 `~/code-mirrors-gl/*.git`）每日同步——
# **仓清单来自文件，不写死在脚本里**。
#
# 谁在跑（2026-11-09 起）：**本机**的 `com.flowers.index-nightly`（launchd，05:10）第一步。
# 在这之前是 dogyun 上 root 的 cron（`5 5 * * *`）——那条已经在 cutover 时停用并备份
# （见 `docs/superpowers/plans/2026-11-08-mirror-cutover.md`）：镜像搬回本机之后，
# 服务器上那条 cron 只会把 26 GB 重新抓回一台不再提供镜像的机器。
#
# 为什么现在是本机：镜像的消费者（走查/评审/材料/夜间索引）全部在这台 Mac 上。走 ssh
# 读远端镜像的代价是每次读多一次往返（实测装配 150–370 ms，本地是个位数到几十毫秒），
# 而收益（「笔记本睡了也能同步」）在镜像不再被远端消费者读之后就不存在了。
#
# `scripts/install-cron.sh --server` 仍然能把这份脚本 + 清单 rsync 到 dogyun 的
# `/opt/123pan/tools/_ro/`（sha256 可对），那是**回滚**用的：把 `code.mirror.transport`
# 改回 ssh 之前，得先在服务器上重新抓回一批镜像。
#
# ## 仓清单：config/repos.txt（与 `--server` 一起发到同一目录）
#
# 以前这里是 `REPOS=(123pan-pc 123pan-uni-app)`。3 个仓时能靠人记得改两处，139 个仓时
# 不可能——2026-11-08 的 `123pan-cross-frontend` 就是这么漏的：它在设置里、不在数组里，
# 服务器从来不去抓，镜像停在 10-21，材料上「代码快照较旧」挂了十几天。
#
# 现在唯一来源是 `config/repos.txt`（一行「仓名<TAB>分支」），本脚本读它，
# `scripts/repos-apply.ts` 把它播种成 `app_settings.code.mirror.repos`，
# `scripts/onboard-repos.ts` 按它建镜像。**加一个仓 = 改那个文件 + 重跑安装**，
# 本脚本一行都不用动。
#
# 分支也是每仓一格：仓一多，「所有仓都叫 master」立刻不成立（有的叫 main，有的就是 dev），
# 而分支写错的错法是安静的——fetch 成功、HEAD 很新、材料对着另一个分支的代码。
#
# 第三格 `stale_after_days`（可选）：**本脚本只负责认它、不解释它**。它被
# `src/core/codemirror/health.ts` 的新鲜度判定读（超过这么多天才提醒；`never` = 上游
# 已归档、不因「上游不动了」提醒，但同步失败照报）。两处必须认同一套语法：一份清单在
# TS 侧能读、在 bash 侧报错退出 2，那一晚就一条仓都不同步——所以这里的校验与
# `parseRepoInventory()` 逐条对齐（`never` 或正整数，缺省 7 天）。
#
# 与 `sync-repos-ro.sh`（另一批仓，影子只读挂载）的关系：同一套约定（flock、单一日志、
# GIT_TERMINAL_PROMPT=0、日志里抹掉 userinfo、safe.directory），但它**不**复用那份
# 脚本——那三个仓是 brainboil 的 555 只读影子，这些仓是 root 的 bare 镜像，权限与
# 失败语义都不同，混在一个脚本里只会让「哪一段坏了」更难读。
#
# ── 并行（2026-11-09）：为什么「串行」在 90 个仓上必然坏掉
#
# 串行 21 个仓实测中位 **110 s**、最坏 **266 s**，14 轮里 **0 轮全绿**（codeup 持续掉
# 连接）。这个数不是「网络慢」，而是**串行的等待被加起来了**：每个仓都是一次独立的
# HTTPS 握手 + 一次 15 s 级的连接失败 + 退避 sleep，串行意味着这些等待一个挨一个地
# 排队。90 个仓时 `90 × 110 s ≈ 2 小时 45 分`，而 05:05 → 05:10 只有 5 分钟——窗口不是
# 「紧张」，是**根本不存在**：`index-nightly`（05:10）会开始索引一批还没同步的镜像，
# 材料上那句「代码快照」就慢一天。
#
# 改法只有一条：把「一个仓一次 fetch」变成「N 个仓同时 fetch」。上限 `SYNC_JOBS`
# （默认 8）不是拍出来的——单个 fetch 是**网络等待**为主（CPU 几乎不占，profile 里
# 99% 时间在等 TLS 与 codeup），所以并发是近乎线性的收益；但 codeup 是本就不稳定的
# 对端，N 开太大换来的不是更快的「成功」，而是更多 `Failed to connect`（并发越高，
# 对端限流/抖动越频繁）。8 是这一夜实测「没有一个仓因为并发而新失败」的最大值，
# 它把 21 个仓的**最坏**情形从 266 s 压到 1 个批次内（见 docs 报告的实测表）。
#
# 窗口的算术因此从 `N × 单仓` 变成 `ceil(N/JOBS) × 单仓`：90 个仓 / 8 = **12 个批次**，
# 按 110 s 的中位数仍是 22 分钟——但那是「每个仓都慢」的口径；真实的中位数是健康的
# 仓 2–3 s（§5 实测），110 s 是**整轮**（含抖动）。健康一轮 90 个仓 ≈ 30–60 s。
# 真正的上界是 `ceil(N/JOBS) × (FETCH_TIMEOUT × 2)`（超时最多重试一次，见 `sync_one`）：
# 90/8 = 12 批 × 600 s = 2 小时，所以**病态仓的个数**才是要盯的东西，不是一个仓。
#
# ── 并行的三条纪律（并行化最容易丢掉的正是这三件事）
#
# 1. **日志不许互相插进半行**。N 个 `sync_one` 同时 `echo` 到同一个 fd 时，长行会被
#    撕开交错成读不懂的垃圾——而这份日志是「哪一晚坏了」的唯一证据。做法是**每仓一个
#    缓冲文件**（`$JOBDIR/<仓名>.log`），全部跑完后按**清单顺序**整份 `cat` 出来：
#    一次 `cat` 是一个完整的读写段，行不会交错，顺序还与清单一致（可 diff、可 grep）。
# 2. **退出码的聚合必须与串行逐字一致**。子进程各自把 `sync_one` 的 rc（0/1/2）写进
#    `$JOBDIR/<仓名>.rc`，父进程按清单顺序读回来做同样的分档：任一个 1 → 整轮 3、
#    任一个 2 → `missing++`（只在没有真故障时升级成 4）。**不许**让 `xargs` 的退出码
#    参与判断：那是「某次调用非零」，与「哪个仓坏了」不是一件事。
# 3. **失败隔离仍要成立**。一个仓的失败/挂住只影响它自己那一个 job：`timeout` 在子进程
#    里（函数内），父进程只等 `xargs` 把 N 个槽位跑空。子进程还显式 `exec 9>&-`
#    ——不把锁的 fd 带进子进程，否则一个挂住的子进程会让下一轮的 `flock -n` 拿到
#    「另一轮在做」的假象。
#
# 每个仓各判各的：一个失败**不许**拖住别人（镜像里一仓新一仓旧是常态），
# 但整体退出码要非零——cron 的邮件/日志必须能区分「没变」与「坏了」。
#
# 用法：
#   scripts/sync-mirrors.sh              # 正常同步（清单默认在脚本旁边）
#   REPOS_FILE=/path/repos.txt scripts/sync-mirrors.sh
#   SYNC_FLOWERS_LOG=/tmp/x.log scripts/sync-mirrors.sh
#   SYNC_JOBS=16 scripts/sync-mirrors.sh  # 调并发（默认 8）
#   scripts/sync-mirrors.sh --help
#
# 退出码（2026-11-09 起四档，理由见「两个信号不能共用一格」那段）：
#   0 = 全部成功（含「已经是最新」，日志里 moved=0 能分辨）
#   3 = **真故障**：至少一个仓在所有重试之后仍然 fetch / update-ref 失败，或收尾的
#       cfg 检查不过（镜像里有 remote、或 config 里带凭据 URL）
#   4 = **没有真故障**，但有仓在服务器上没有镜像目录（清单里有、还没 onboard）。
#       这不是「同步坏了」，下一步是跑 scripts/onboard-repos.ts —— 所以它必须是另一个码，
#       否则「昨晚加了 5 个仓、还没来得及建镜像」和「codeup 连不上」在 cron 里长得一样。
#   2 = 环境/清单不对（清单读不到或不合格式 / 建不了日志或锁文件 / SYNC_JOBS 不是正整数）
#       —— 一个仓都还没动
#   flock 被人占着时退出 0：那一轮是**另一次同步在做**，不是失败（次数少、且下一次会补上）
set -euo pipefail

# ── 两个来源、两个根（2026-11-09：镜像从服务器搬回本机）
#
# 这是本脚本最大的一次假设变化。原来只有**一个**根、**一台**对端：dogyun 上的
# `/srv/123pan-mirror`，从 codeup 拉。换成本地盘之后：
#
#   source=codeup  → 根 $MIRROR_ROOT          缺省 ~/code-mirrors     对端 $CODEUP_ORG
#   source=gitlab  → 根 $MIRROR_ROOT_GITLAB   缺省 ~/code-mirrors-gl  对端 $GITLAB_ORG
#
# 两个根不能合成一个：`share`/`transcode`/`gocron`/`cron-scripts`/`123pan-agent-tracker`
# 这五个仓名在两边**各有一个不同的仓**，合在一个目录里就是互相覆盖（GitLab 那边已改名
# 成 `gl-<名字>`，那是 `config/repos.txt` 的事，不是这里的）。对端也不能合并：一个走
# https + 凭据，一个走 ssh:2222 匿名读。
#
# 缺省值改成 `~/…` 而不是 `/srv/…`：盘就在这台 Mac 上，服务器那份已经删了（拆之前
# 每个镜像 HEAD 的 sha256 记在 docs/superpowers/plans/2026-11-08-mirror-cutover.md）。
#
# `SYNC_READONLY`（缺省：root 装上 = 1，否则 0）：服务器上那批镜像归 root 所有、
# 目录 555 / 文件 444，因为读它的是另一个进程；本机是同一个用户在读写，收写位会让
# **下一次 fetch 自己失败**。所以「收写位」这件事变成一个显式开关，而不是无条件的收尾。
MIRROR_ROOT="${MIRROR_ROOT:-$HOME/code-mirrors}"
MIRROR_ROOT_GITLAB="${MIRROR_ROOT_GITLAB:-$HOME/code-mirrors-gl}"
GITLAB_ORG="${GITLAB_ORG:-ssh://git@gitlab.123245.com:2222}"
if [ "${SYNC_READONLY:-}" = "" ]; then
  if [ "$(id -u)" = "0" ]; then SYNC_READONLY=1; else SYNC_READONLY=0; fi
fi
case "$SYNC_READONLY" in
  0|1) ;;
  *) echo "SYNC_READONLY 只能是 0 或 1（当前「$SYNC_READONLY」）" >&2; exit 2 ;;
esac
# 缺镜像时要不要就地 clone（见 sync_one）：本机缺了没人能替它建，服务器上由
# `onboard-repos.ts` 负责（它还要顺带写覆盖率），所以缺省跟着 SYNC_READONLY 走。
if [ "${SYNC_CLONE_MISSING:-}" = "" ]; then
  if [ "$SYNC_READONLY" = "1" ]; then SYNC_CLONE_MISSING=0; else SYNC_CLONE_MISSING=1; fi
fi
# 组织根（**不是** `123pan` 组）：克隆地址 = $CODEUP_ORG/<清单里的 path>.git。
#
# 为什么不再拼 `/123pan/`：144 个仓里多数就在组织根下（`…/artifacts.git`），少数在
# `123pan/`、`cdn-groups/`、`test-groups/`。以前这里把组写死成 `123pan`，于是
# `…/123pan/artifacts.git` 这样的地址被远端答成「未知的仓库路径」——一句听起来像
# 「仓不存在」的话。组路径是**仓的属性**，清单带 `path=` 那一格，地址只拼一次。
#
# `CODEUP_BASE` 仍然认（老 cron 里写着它），但语义变了：它现在必须给**组织根**。
# 给的是旧值（以 `/123pan` 结尾）时，这里把尾巴剥掉并在日志里留一行——否则
# 拼出来的地址会多一层 `/123pan`，整轮 fetch 全红，而原因藏在变量语义里。
CODEUP_ORG="${CODEUP_ORG:-${CODEUP_BASE:-https://codeup.aliyun.com/60f9058e68e2993a8e6d0750}}"
LEGACY_ORG_BASE=0
case "$CODEUP_ORG" in
  */123pan|*/123pan/)
    # 旧语义的值：它指向**组**而不是组织根。剥掉尾巴，别让拼出来的地址多一层 /123pan。
    CODEUP_ORG="${CODEUP_ORG%/}"
    CODEUP_ORG="${CODEUP_ORG%/123pan}"
    LEGACY_ORG_BASE=1
    ;;
esac
CODEUP_ORG="${CODEUP_ORG%/}"
# 日志与锁：root（服务器）走 /var/log、/var/lock；本机（非 root）走
# ~/Library/Application Support/flowers/logs 与 TMPDIR。写死 /var/log 在 Mac 上会以
# 「建不了日志目录」退出 2——一句听起来像权限问题、实际是「这台机器没有 /var/log 的写权」
# 的话，每晚一次。
if [ "$(id -u)" = "0" ]; then
  DEFAULT_LOG=/var/log/sync-flowers-mirror.log
  DEFAULT_LOCK=/var/lock/sync-flowers-mirror.lock
else
  DEFAULT_LOG="$HOME/Library/Application Support/flowers/logs/mirror-sync.log"
  DEFAULT_LOCK="${TMPDIR:-/tmp}/flowers-mirror-sync.lock"
fi
LOG="${SYNC_FLOWERS_LOG:-$DEFAULT_LOG}"
LOCK="${SYNC_FLOWERS_LOCK:-$DEFAULT_LOCK}"
FETCH_TIMEOUT="${FETCH_TIMEOUT:-300}"
# 重试：2026-11-08 夜在 dogyun 上跑了 14 次整轮，**13 次**出现 ≥5 个瞬时 fetch 失败
# （`Could not resolve host` / `Failed to connect … port 443 after 1 ms`），而仓本身全是好的。
# 不重试的话每一轮都以 rc=3 收尾并留下几条 FAIL——那种「每晚都红」的日志没有人会读，
# 于是真正的故障也一起被淹掉。与 `onboard-repos.ts` 的 `cloneWithRetry` 同一套语义
# （同一条故障源、同一份证据），区别只在退避更短：夜间窗口只有 5 分钟。
FETCH_RETRIES="${FETCH_RETRIES:-2}"
RETRY_BACKOFF="${RETRY_BACKOFF:-2}"

# 并发上限。默认 8 的理由见文件头「并行」那一节——不是越快越好，而是「快到装进窗口、
# 又没有因为并发本身制造新失败」的那个点。必须显式给小整数：`xargs -P 0` 是**无限**
# 并发（90 个同时 fetch 会被 codeup 限流成整轮失败），`-P 空` 在 GNU xargs 里又是另一个
# 语义，两种都太容易因为一个笔误变成「更糟」。
SYNC_JOBS="${SYNC_JOBS:-8}"
case "$SYNC_JOBS" in
  ''|*[!0-9]*) echo "SYNC_JOBS 必须是正整数（当前「$SYNC_JOBS」）" >&2; exit 2 ;;
esac
if [ "$SYNC_JOBS" -lt 1 ] || [ "$SYNC_JOBS" -gt 64 ]; then
  echo "SYNC_JOBS 只接受 1–64（当前 $SYNC_JOBS）；0 = 无限并发，会把 codeup 打成整轮失败" >&2
  exit 2
fi

# 清单位置：默认**脚本旁边那一份**（`install-cron.sh --server` 会把 config/repos.txt
# rsync 到 `/opt/123pan/tools/_ro/repos.txt`，与脚本同一个目录）。在仓库里直接跑时
# 退回 `../config/repos.txt`——两条路都不写死仓名，也都只需要一条规则。
default_repos_file() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "$here/repos.txt" ]; then
    printf '%s\n' "$here/repos.txt"
  else
    printf '%s\n' "$here/../config/repos.txt"
  fi
}
REPOS_FILE="${REPOS_FILE:-$(default_repos_file)}"

usage() {
  cat <<USAGE
用法：sync-mirrors.sh [--help]

读仓清单（默认 $(default_repos_file)），把每个仓的**清单里写的分支**从它的来源
（codeup / GitLab）fetch 进 $MIRROR_ROOT/<仓名>.git 或 $MIRROR_ROOT_GITLAB/<仓名>.git
（bare），用 CAS 更新本地同名 ref；root 下才把写位收回。
各仓**并行**跑（默认 8 个一批），逐仓日志先在内存盘/临时目录里缓冲，跑完按清单顺序
整份打出——所以并行不会把日志撕成互相交错的半行。

清单格式：<仓名><TAB 或空格><分支>[<TAB 或空格>source=codeup|gitlab]
          [<TAB 或空格>path=<组路径>][<TAB 或空格>stale=<天数>|never]；
\`#\` 开头整行是注释；空行忽略。source 缺省 codeup，stale 缺省 7 天
（本脚本只认这两格、不解释它们，判定在 src/core/codemirror/health.ts）。

环境变量：
  REPOS_FILE           仓清单           默认 脚本旁边的 repos.txt（或 ../config/repos.txt）
  MIRROR_ROOT          codeup 的 bare 根  默认 ~/code-mirrors（root 下是 /srv/123pan-mirror）
  MIRROR_ROOT_GITLAB   GitLab 的 bare 根  默认 ~/code-mirrors-gl
  CODEUP_ORG           codeup 的组织根   默认 https://codeup.aliyun.com/60f9...750
                      （克隆地址 = $CODEUP_ORG/<清单里的 path>.git；CODEUP_BASE 仍认，
                        但它现在也必须给组织根，旧值以 /123pan 结尾会被剥掉并记一行）
  GITLAB_ORG           GitLab 的基址     默认 ssh://git@gitlab.123245.com:2222
  SYNC_READONLY        收写位（chown root + 555/444）  默认：root 下 1，否则 0
  SYNC_CLONE_MISSING   目录缺失时就地 clone --bare     默认：root 下 0，否则 1
  SYNC_FLOWERS_LOG     日志文件           默认 /var/log/...（root）/ ~/Library/Application Support/flowers/logs/mirror-sync.log
  SYNC_FLOWERS_LOCK    锁文件             默认 /var/lock/...（root）/ $TMPDIR/flowers-mirror-sync.lock
  SYNC_JOBS            并发仓数           默认 8（1–64；单仓失败不影响别的仓）
  FETCH_TIMEOUT       单次 fetch 超时（秒） 默认 300
  FETCH_RETRIES       瞬时失败重试次数      默认 2（只重试瞬时错误，见脚本头部）
  RETRY_BACKOFF       重试退避基数（秒）     默认 2（第 n 次失败后等 n×这个数）

退出码：0 全部成功（含 already up to date）/ 3 重试后仍失败的仓或 cfg 检查不过
        / 4 有仓还没有镜像（跑 onboard-repos.ts）/ 2 环境或清单不对。
USAGE
}

case "${1:-}" in
  --help | -h) usage; exit 0 ;;
  '') ;;
  *) echo "未知参数：$1（--help 看用法）" >&2; exit 2 ;;
esac

# ── 可移植性（2026-11-09：这台脚本从 Linux 挪到 macOS 上跑）
#
# 三处 GNU 专用写法必须换掉，否则「搬回本机」第一天就以一个看起来像别的问题的方式失败：
#   1. `date -Iseconds` —— macOS 的 date 不认（`date: illegal time format`），而它出现在
#      每一条日志行里，于是整轮同步在写第一行日志时就退出。
#   2. `flock` —— macOS 没有。锁的意义（同一时刻只允许一轮）不变，换成 mkdir 的原子性，
#      pid 判活清陈旧锁（与 `index-nightly.sh` 同一套写法）。
#   3. `timeout` —— macOS 没有（brew 的 coreutils 才给 gtimeout）。而 fetch 的挂起保护
#      正靠它，没有它一个挂住的仓会把整轮拖到天亮。
# 注意 bash 是 **3.2**（Apple 最后一代 GPLv2）：没有关联数组，所以下面的重名去重
# 用的是「一行一个名字」的字符串，不是 `declare -A`。
iso_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# 一次带超时的调用：有 timeout / gtimeout 就用它（Linux 与装了 coreutils 的 Mac），
# 否则用「后台跑 + 看门狗 kill」的便携版。超时统一报 124——调用方（`is_transient`）
# 只认这一个数，两种实现的差别不该漏到判定里。
run_with_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; return $?; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"; return $?; fi
  "$@" &
  local pid=$! wd rc=0
  # 看门狗的三个 fd 必须**离开调用者的管道**：`out=$(run_with_timeout …)` 会一直读到
  # 所有写端关闭为止，而 `sleep` 是看门狗的子进程、会继承这个管道——不重定向的话
  # 命令替换会等到 sleep 自然结束（实测：10 s 的「超时」把 3 个仓拖成 120 s，
  # 而每个 fetch 其实 2 s 就回来了）。
  ( sleep "$secs"; kill -TERM "$pid" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
  wd=$!
  wait "$pid" || rc=$?
  kill -TERM "$wd" 2>/dev/null
  wait "$wd" 2>/dev/null || true
  # 被看门狗 TERM 掉：128+15。映射成 124，与 timeout(1) 同一个约定。
  if [ "$rc" -eq 143 ] || [ "$rc" -eq 137 ]; then return 124; fi
  return "$rc"
}

# ─── 读清单 ──────────────────────────────────────────────────────────────────
# 在锁之前就解析：清单坏了要在动任何仓之前失败，而不是同步了一半才报错。
REPOS=()
BRANCHES=()
PATHS=()
SOURCES=()
SEEN_LIST=""   # 换行分隔的一串仓名；bash 3.2 没有关联数组
if [ ! -f "$REPOS_FILE" ]; then
  echo "读不到仓清单：$REPOS_FILE（它是 config/repos.txt，用 install-cron.sh --server 随脚本发过来）" >&2
  exit 2
fi
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"                       # 有人用 Windows 编辑器存过
  trimmed="${line#"${line%%[![:space:]]*}"}"  # 去左空白
  [ -z "$trimmed" ] && continue
  case "$trimmed" in \#*) continue ;; esac
  # shellcheck disable=SC2086
  set -- $trimmed                            # 空白（TAB 或空格，可连续）分格
  name="${1:-}"
  branch="${2:-}"
  if [ -z "$name" ]; then
    echo "清单 $REPOS_FILE 有一行没有仓名：「$trimmed」" >&2
    exit 2
  fi
  # 仓名会被拼成 $MIRROR_ROOT/<仓名>.git：带 / 或 .. 就是一次路径穿越。
  if ! printf '%s' "$name" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$'; then
    echo "清单里仓名「$name」形状不合法：只允许 [A-Za-z0-9._-]" >&2
    exit 2
  fi
  # ─── 第三格起：`path=<组路径>` 与 `stale=<天数>|never>`（本脚本只认，不解释）───
  #
  # `path=` 是**克隆地址的那一段**（组织相对、含仓名）：`123pan/apisrv` / `apisrv`。
  # 以前这里没有这一格，地址靠拼 `$CODEUP_BASE/$name.git` 得到，于是组织根下的仓
  # 被问成 `…/123pan/artifacts.git`（远端答「未知的仓库路径」）。**地址只拼一次**：
  # 就在下面的 fetch 里，用 path 拼。
  #
  # 兼容：第三格光着写 `never` 或正整数时仍按 stale 读（历史格式）。
  # 校验与 `parseRepoInventory()` 逐条对齐——一边能读、一边报错退出 2，那一晚整份清单
  # 都不同步。
  path="123pan/${name}"   # 没写 path= 时按历史默认（与 TS 侧 DEFAULT_GROUP 同一个值）
  source="codeup"         # 没写 source= 时按历史默认（2026-11-09 之前只有 codeup）
  stale=""
  shift 2 || true         # 前两格（仓名、分支）已经取走，剩下的格子按 key=value 逐个看
  for cell in "$@"; do
    case "$cell" in
      path=*)
        path="${cell#path=}"
        if [ -z "$path" ]; then
          echo "清单里「$name」的 path= 是空的（组织根下的仓写仓名本身，如 path=artifacts）" >&2
          exit 2
        fi
        if printf '%s' "$path" | grep -q '\.\.' \
          || ! printf '%s' "$path" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$'; then
          echo "清单里「$name」的 path「$path」形状不合法（段只允许 [A-Za-z0-9._-]，不许 .. ）" >&2
          exit 2
        fi
        ;;
      source=*)
        source="${cell#source=}"
        case "$source" in
          codeup|gitlab) ;;
          *)
            # 来源写错会安静地落到默认根上（目录里躺着另一个仓），所以当场失败。
            echo "清单里「$name」的 source「$source」不合法：只认 codeup / gitlab" >&2
            exit 2
            ;;
        esac
        ;;
      stale=*)
        if [ -n "$stale" ]; then
          echo "清单里「$trimmed」写了两个 stale=" >&2
          exit 2
        fi
        stale="${cell#stale=}"
        ;;
      *)
        # 历史写法：第三格光着写 `never` / 正整数，就是 stale。
        if [ -z "$stale" ] && printf '%s' "$cell" | grep -Eqi '^(never|[1-9][0-9]{0,5})$'; then
          stale="$cell"
        else
          echo "清单里「$trimmed」有认不出的格子「$cell」（第三格起只认 source= / path= / stale=）" >&2
          exit 2
        fi
        ;;
    esac
  done
  if [ -n "$stale" ]; then
    if ! printf '%s' "$stale" | grep -Eqi '^never$' && ! printf '%s' "$stale" | grep -Eq '^[1-9][0-9]{0,5}$'; then
      echo "清单里「$name」的 stale_after_days「$stale」不合法：只接受正整数或 never" >&2
      exit 2
    fi
  fi
  if [ "$source" = "gitlab" ] && [ "$path" = "123pan/${name}" ]; then
    # 没写 path= 时这里填的是 codeup 的历史默认值。GitLab 的组路径是多级的，没有可猜的
    # 默认值——拿 `123pan/<名字>` 去问 GitLab 只会得到「仓不存在」，而真正的原因是漏了 path=。
    echo "清单里「$name」是 source=gitlab 却没写 path=（GitLab 必须给组路径，如 path=go/cloud-driver/grpc-share）" >&2
    exit 2
  fi
  if [ -z "$branch" ]; then
    branch=master   # 与 TS 侧 FALLBACK_BRANCH 同一个值；TS 会给一行提示，这里只记日志
  fi
  if ! printf '%s' "$branch" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/-]*$' || printf '%s' "$branch" | grep -q '\.\.'; then
    echo "清单里「$name」的分支「$branch」形状不合法（不许空格、不许 ..）" >&2
    exit 2
  fi
  # 镜像目录名与 path 的最后一段必须是同一个名字：目录按 name 建、地址按 path 拼，
  # 两者不一致时错法是安静的（目录里是 A 仓，每晚去 fetch B 仓）。
  # 本地目录名与上游名默认必须一致（错法是安静的：目录里是 A 仓，每晚去 fetch B 仓）。
  # GitLab 那批允许不一致——4 个刻意起的本地名（`go/base/api` → `api-go-base` 等）+ 5 个
  # 重名改名（`gl-` 前缀）；codeup 那 142 行一个都不许改（目录全是裸仓名）。
  # 与 TS 侧 `parseRepoInventory` 同一条规则（那边对 gitlab 的不一致留一条 notes）。
  if [ "${path##*/}" != "$name" ] && [ "$source" != "gitlab" ]; then
    echo "清单里「$name」的 path「$path」最后一段不是它自己：codeup 的镜像目录按仓名建，两者必须同一个仓" >&2
    exit 2
  fi
  case "$SEEN_LIST" in
    *$'\n'"$name"$'\n'*)
      echo "清单里仓「$name」出现了两次" >&2
      exit 2
      ;;
  esac
  SEEN_LIST="$SEEN_LIST"$'\n'"$name"$'\n'
  REPOS+=("$name")
  BRANCHES+=("$branch")
  PATHS+=("$path")
  SOURCES+=("$source")
done <"$REPOS_FILE"

if [ "${#REPOS[@]}" -eq 0 ]; then
  echo "清单 $REPOS_FILE 里一个仓都没有（全空或是全注释）" >&2
  exit 2
fi

mkdir -p "$(dirname "$LOG")" 2>/dev/null || { echo "建不了日志目录：$(dirname "$LOG")" >&2; exit 2; }
mkdir -p "$(dirname "$LOCK")" 2>/dev/null || { echo "建不了锁目录：$(dirname "$LOCK")" >&2; exit 2; }

# 同一时刻只允许一轮。抢不到锁不算失败：那一轮是别人在做。
#
# 两种实现：服务器（Linux，glibc 的 flock 是 fcntl 锁）用 flock；本机（macOS，没有
# flock）用 mkdir 的原子性 + pid 判活。语义完全一样，差别只在「怎么知道锁是谁的」——
# mkdir 版把 pid 写进目录里，上一轮被杀掉留下的目录会在下一次被清掉，而不是把
# 后续每一轮都挡在门外（那是一个永久性的假故障）。
LOCK_DIR=""
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  if ! flock -n 9; then
    echo "$(iso_now) skip: another sync is running" >>"$LOG"
    exit 0
  fi
else
  LOCK_DIR="$LOCK.d"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    other="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
      echo "$(iso_now) skip: another sync is running (pid $other)" >>"$LOG"
      exit 0
    fi
    rm -rf "$LOCK_DIR"
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
      echo "$(iso_now) skip: lock is held by someone else ($LOCK_DIR)" >>"$LOG"
      exit 0
    fi
    echo "$(iso_now) note: cleared a stale lock (pid ${other:-?})" >>"$LOG"
  fi
  printf '%s\n' "$$" >"$LOCK_DIR/pid"
fi

exec >>"$LOG" 2>&1
started_at=$(date +%s)
echo "=== sync start $(iso_now) repos=${#REPOS[@]} jobs=$SYNC_JOBS manifest=$REPOS_FILE codeup=$CODEUP_ORG root=$MIRROR_ROOT gitlab=$GITLAB_ORG root_gl=$MIRROR_ROOT_GITLAB readonly=$SYNC_READONLY ==="
if [ "$LEGACY_ORG_BASE" -eq 1 ]; then
  echo "NOTE CODEUP_BASE 给的是旧的「组」地址（以 /123pan 结尾）：已剥成组织根 $CODEUP_ORG；下次把它改成 CODEUP_ORG"
fi

# 逐仓缓冲目录：日志与退出码都先落在这里，跑完按清单顺序整份打出。
# 为什么需要它：并行时 N 个 printf 打同一份日志，长行会被内核写进同一个文件时撕开
# （>4 K 的写不保证原子），结果就是「FAIL 123pan-pc … OK 123pan-uni-app …」半行交错。
# 落临时文件再 `cat` 一次，交错的可能性从「取决于行长」变成「不可能」。
JOBDIR="$(mktemp -d "${TMPDIR:-/tmp}/sync-flowers.XXXXXX")" || {
  echo "建不了逐仓缓冲目录（mktemp 失败）：并行日志会被撕碎，宁可不跑" >&2
  exit 2
}
cleanup_jobdir() {
  rm -rf "$JOBDIR"
  # mkdir 版锁要自己收：漏掉它，下一轮会看到「锁被占着」——而占着它的正是上一轮自己。
  [ -n "$LOCK_DIR" ] && rm -rf "$LOCK_DIR"
}
trap cleanup_jobdir EXIT

# 日志里不出现 userinfo：现在的 BASEURL 本身不带凭据（走 /root/.git-credentials），
# 但一旦有人顺手把 token 拼进 URL，这一行是最后一道闸。
mask() { sed -E 's#//[^/@ ]*@#//<userinfo>@#g'; }

# 这次失败是不是**瞬时**的（值得再试一次）。
#
# 只重试瞬时错误，不重试「确定性」错误：分支不存在（`couldn't find remote ref`）、仓不存在
# （`not found`）、凭据失效（`Authentication failed`）重试三次只会把一个明确的答案拖成
# 3 倍的等待，而且它们的日志会长得和真实故障一模一样。判定按**错误文本**（git 的退出码
# 太粗：DNS 失败、连不上、认证失败都是 128）。
is_transient() {
  local rc="$1" out="$2"
  [ "$rc" -eq 124 ] && return 0   # 我们自己 timeout 杀的：最典型的瞬时
  printf '%s' "$out" | grep -Eqi \
    'could not resolve host|temporary failure in name resolution|failed to connect|connection (reset|refused|timed out|aborted)|recv failure|send failure|early eof|rpc failed|remote end hung up|operation timed out|the remote end hung up unexpectedly|tls handshake|unexpected disconnect|http 5[0-9][0-9]|returned error: 5[0-9][0-9]'
}

# 同步一个仓。成功返回 0（无论 ref 有没有动）、镜像不存在返回 2、失败返回 1--
# 调用方按这三种收尾（rc=3 与 rc=4 的区别就来自这个 2，见文件头）。
sync_one() {
  local repo="$1"
  local branch="$2"
  # 第三格：组织相对的克隆路径。地址 = 该来源的基址 + path —— 两段，且**只在这里拼**。
  local path="${3:-123pan/$repo}"
  local source="${4:-codeup}"
  # 根与基址**按来源分叉**（见文件头「两个来源、两个根」）：同一个仓名在两个来源下
  # 是两个不同的仓，合错根 = 把 B 仓的 ref 写进 A 仓的目录。
  local root base
  case "$source" in
    gitlab) root="$MIRROR_ROOT_GITLAB"; base="$GITLAB_ORG" ;;
    *)      root="$MIRROR_ROOT";        base="$CODEUP_ORG" ;;
  esac
  local dir="$root/$repo.git"
  local g=(git -c safe.directory='*' -C "$dir")
  local before after out st

  if [ ! -d "$dir" ]; then
    # 镜像不存在不是「同步失败」而是「还没接入」（返回 2，聚合时算 rc=4）。
    #
    # 但 2026-11-09 之后「接入」这一步只能在这里做：`scripts/onboard-repos.ts` 是给
    # **服务器**写的（它要求 transport=ssh、还要 df 服务器的盘），镜像搬回本机之后它
    # 一进来就说「批量接入只支持 ssh」。所以本机模式下这里顺手 clone（`SYNC_CLONE_MISSING`，
    # 缺省：非 root = 1，root = 0）：加一个仓 = 清单加一行 + `repos-apply` + 跑这一轮。
    if [ "${SYNC_CLONE_MISSING:-0}" = "1" ]; then
      echo "CLONE $repo: 目录不存在，从 $base/$path.git 建 bare 镜像（${dir}）"
      # 先建到临时目录再 mv：中途失败不该留下一个「看起来存在」的半仓——那会让下一轮
      # 走 fetch 分支，然后以一句「拿不到 FETCH_HEAD」收场。
      local tmp="${dir}.clone-$$"
      rm -rf "$tmp"
      local crc=0
      out=$(run_with_timeout "$FETCH_TIMEOUT" git clone --bare --quiet "$base/$path.git" "$tmp" 2>&1) || crc=$?
      if [ "$crc" -ne 0 ]; then
        echo "FAIL clone $repo (rc=$crc): $(printf '%s' "$out" | mask | tail -3 | tr '\n' ' ')"
        rm -rf "$tmp"
        return 1
      fi
      mv "$tmp" "$dir"
      echo "CLONE $repo: 完成（$(git -c safe.directory='*' -C "$dir" rev-parse --short HEAD 2>/dev/null || echo '没有 HEAD')）"
      return 0
    fi
    echo "FAIL $repo: 目录不存在（${dir}）——先跑 scripts/onboard-repos.ts 建这个镜像"
    echo "       （本机模式可设 SYNC_CLONE_MISSING=1 让它在这里 clone）"
    return 2
  fi

  before=$("${g[@]}" rev-parse --short HEAD 2>/dev/null) || before="(none)"

  # fetch 只写 FETCH_HEAD，不动任何 ref：真正的更新在下面用 CAS 写，
  # 这样「fetch 到一半失败」不会把 master 留在半更新的状态。
  local attempt=0 max=$((FETCH_RETRIES + 1))
  while :; do
    attempt=$((attempt + 1))
    set +e
    out=$(run_with_timeout "$FETCH_TIMEOUT" "${g[@]}" fetch --quiet --no-tags --prune \
      "$base/$path.git" "$branch" 2>&1)
    st=$?
    set -e
    [ "$st" -eq 0 ] && break
    # 超时**最多再试一次**：一次 300 s 的挂起已经吃掉 05:05→05:10 那 5 分钟窗口的十分之一，
    # 而两次挂起就能把整轮顶过 05:10（那时夜间索引会开始索引一个还在同步的镜像）。
    # 「连不上」是秒级失败，重试它很便宜；「挂住」不是，所以两者不共用同一个次数上限。
    if [ "$st" -eq 124 ] && [ "$attempt" -ge 2 ]; then
      echo "FAIL fetch $repo@$branch (rc=$st, 超时，试了 $attempt 次): $(printf '%s' "$out" | mask | tail -3 | tr '\n' ' ')"
      return 1
    fi
    if [ "$attempt" -ge "$max" ] || ! is_transient "$st" "$out"; then
      echo "FAIL fetch $repo@$branch (rc=$st, 试了 $attempt 次): $(printf '%s' "$out" | mask | tail -3 | tr '\n' ' ')"
      return 1
    fi
    local wait_secs=$((RETRY_BACKOFF * attempt))
    echo "RETRY fetch $repo@$branch (rc=$st, 第 $attempt 次失败，${wait_secs}s 后重试): $(printf '%s' "$out" | mask | tail -1)"
    sleep "$wait_secs"
  done

  local new_full
  new_full=$("${g[@]}" rev-parse FETCH_HEAD 2>/dev/null) || {
    echo "FAIL $repo: 拿不到 FETCH_HEAD（分支 $branch 在远端不存在？）"
    return 1
  }
  after=$("${g[@]}" rev-parse --short "$new_full" 2>/dev/null) || after="$new_full"

  if [ "$before" = "$after" ]; then
    echo "OK $repo@$branch $before -> $after moved=0（已经是最新）"
  else
    local old_full
    old_full=$("${g[@]}" rev-parse "refs/heads/$branch" 2>/dev/null) || old_full=""
    # CAS：期望旧值还指着我们刚读到的那个提交；并发写会在这里失败，而不是悄悄覆盖。
    if ! "${g[@]}" update-ref -m "sync-flowers-mirror $(iso_now)" \
      "refs/heads/$branch" "$new_full" ${old_full:+"$old_full"}; then
      echo "FAIL update-ref ${repo}@${branch}（$before -> ${after}）"
      return 1
    fi
    echo "OK $repo@$branch $before -> $after moved=1（$("${g[@]}" log -1 --format=%cd --date=format:'%F %T' "$after")）"
  fi

  # 只读权限（`SYNC_READONLY=1`，缺省只在 root 下成立）：服务器上这些仓被另一个进程
  # （flowers 的走查/评审）**只读**读取，所以同步完立刻收回写位——目录 555 / 文件 444，
  # owner root；root 自己下一次 fetch 不受影响（CAP_DAC_OVERRIDE），非 root 谁都改不动。
  #
  # 本机关掉：读写同一个用户，收写位等于让**下一次** fetch 在 .git 上失败。
  if [ "$SYNC_READONLY" = "1" ]; then
    chown -R root:root "$dir"
    find "$dir" -type d -exec chmod 555 {} +
    find "$dir" -type f -exec chmod 444 {} +
  fi
  return 0
}

# 一个并行槽位里跑的东西：**整仓的输出与退出码都落文件**，自己不往 stdout 写一个字。
#
# 为什么不在这里直接 echo：那是串行版本的做法，在 N 个进程同时跑时正是日志交错的来源。
# 也为什么 `return 0` 恒定：xargs 的退出码只表示「某次调用非零」，把它当聚合信号会让
# 「哪个仓坏了」这个信息丢掉——聚合只认 `<仓名>.rc`，见下面那段。
# `exec 9>&-` 把锁的 fd 从子进程里摘掉：子进程挂住时不该继续「持有」这一轮的锁。
worker() {
  local line="$1" repo branch path source st=0
  exec 9>&- 2>/dev/null || true
  repo="${line%% *}"
  line="${line#* }"
  branch="${line%% *}"
  line="${line#* }"
  path="${line%% *}"
  source="${line#* }"
  [ "$branch" = "$repo" ] && branch=master
  [ "$path" = "$branch" ] && path="123pan/$repo"
  [ "$source" = "$path" ] && source=codeup
  sync_one "$repo" "$branch" "$path" "$source" >"$JOBDIR/$repo.log" 2>&1 || st=$?
  printf '%s\n' "$st" >"$JOBDIR/$repo.rc"
  return 0
}

# 子进程要看得见的东西：函数用 export -f，配置用 export。两者缺一个，子进程里的
# `sync_one` 就会以「未定义」的方式静默地一个仓都不同步。
export MIRROR_ROOT MIRROR_ROOT_GITLAB CODEUP_ORG GITLAB_ORG FETCH_TIMEOUT FETCH_RETRIES RETRY_BACKOFF JOBDIR SYNC_READONLY SYNC_CLONE_MISSING
export -f sync_one is_transient mask worker run_with_timeout

JOBS_FILE="$JOBDIR/jobs.txt"
: >"$JOBS_FILE"
for i in "${!REPOS[@]}"; do
  # 四格：仓名 分支 path 来源。来源**必须**跟着 job 走——worker 在另一个进程里，
  # 它没有 REPOS/SOURCES 这两个数组可查（bash 3.2 也不能导出数组）。
  printf '%s %s %s %s\n' "${REPOS[$i]}" "${BRANCHES[$i]}" "${PATHS[$i]}" "${SOURCES[$i]}" >>"$JOBS_FILE"
done

# 有界并行：`-P SYNC_JOBS` 个槽位，一个仓一个 job。`-I{}` 保证整行（「仓名 分支」）
# 原样作为**一个**参数交进去——仓名与分支已被清单校验卡过形状，不含空白。
xargs_rc=0
xargs -P "$SYNC_JOBS" -I{} bash -c 'worker "$@"' _ {} <"$JOBS_FILE" || xargs_rc=$?
[ "$xargs_rc" -eq 0 ] || echo "NOTE xargs 收尾非零（rc=$xargs_rc）：可能有槽位被信号杀掉，缺 rc 的仓按失败算"

rc=0
missing=0
failed=0
for i in "${!REPOS[@]}"; do
  repo="${REPOS[$i]}"
  # 逐仓日志整份打出：一次 cat 一个文件 = 一个连续的读写段，行不会与别的仓交错。
  if [ -f "$JOBDIR/$repo.log" ]; then
    cat "$JOBDIR/$repo.log"
  fi
  # 逐仓判定，**不许**用 `if ! sync_one`：那样「镜像还没建」（2）与「同步失败」（1）
  # 会合成同一个真值，而这两件事的下一步完全不同（跑 onboard-repos.ts vs 看网络）。
  if [ -f "$JOBDIR/$repo.rc" ]; then
    st="$(cat "$JOBDIR/$repo.rc" 2>/dev/null || echo 1)"
  else
    st=1
    echo "FAIL $repo: 并行槽位没有留下退出码（被信号杀掉/子进程没起来）"
  fi
  case "$st" in
    0) ;;
    2) missing=$((missing + 1)) ;;
    *) failed=$((failed + 1)); rc=3 ;;
  esac
done

# 与 sync-repos-ro.sh 同一条收尾检查，但**按模式分叉**：
#
# - 服务器（`SYNC_READONLY=1`）：镜像不许有 remote、config 里不许有带凭据的 URL。
#   那批目录归 root 所有、别的进程只读挂进来，一个可写的 remote 就是一条「谁都能改」的路。
# - 本机（`SYNC_READONLY=0`）：只查**带凭据的 URL**。本地这批是 `git clone --bare` 出来的，
#   每个仓都带 `remote.origin.url`（记录「它从哪来」），按 server 那条判据会 217 行全红；
#   而带凭据的 URL 是真问题——`.git/config` 里躺着 token，任何读到这个目录的东西都拿到了它。
for i in "${!REPOS[@]}"; do
  repo="${REPOS[$i]}"
  root="$MIRROR_ROOT"
  [ "${SOURCES[$i]}" = "gitlab" ] && root="$MIRROR_ROOT_GITLAB"
  dir="$root/$repo.git"
  [ -f "$dir/config" ] || continue
  c=$(grep -c '^\[remote' "$dir/config" || true)
  # 只把「URL 里带口令」当问题：`ssh://git@host` 的 `git@` 是**用户名**不是凭据，
  # 按 `://[^/]*@` 判会把 75 个 GitLab 镜像全部误报成凭据泄漏——那种闸会被人关掉。
  u=$(grep -cE '://[^/@:]+:[^/@]+@' "$dir/config" || true)
  echo "cfg $repo remotes=$c userinfo_urls=$u"
  if [ "$u" -ne 0 ]; then rc=3; fi
  if [ "$SYNC_READONLY" = "1" ] && [ "$c" -ne 0 ]; then rc=3; fi
done

# 只有「没有真故障」时，缺镜像才升级成 rc=4：一个既连不上 codeup、又有仓没建镜像的夜里，
# 人要先看到的是 3（同步坏了），不是 4（去建镜像）。
if [ "$rc" -eq 0 ] && [ "$missing" -gt 0 ]; then
  rc=4
  echo "NOTE $missing 个仓还没有镜像（清单里有）：跑 scripts/onboard-repos.ts 建；本轮 fetch 全绿"
fi
echo "NOTE 本轮到 $(( $(date +%s) - started_at ))s repos=${#REPOS[@]} jobs=$SYNC_JOBS 失败=$failed 缺镜像=$missing"
echo "=== sync done rc=$rc $(iso_now) ==="
exit "$rc"
