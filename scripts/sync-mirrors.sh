#!/bin/bash
# 123pan 镜像仓（/srv/123pan-mirror/*.git）每日同步——**仓清单来自文件，不写死在脚本里**。
#
# 谁在跑：dogyun 上 root 的 cron（`5 5 * * *`），由 `scripts/install-cron.sh --server`
# 安装。**仓库里这一份是源头**；服务器上那份是 `--server` rsync 过去的副本（安装时会
# 打两边的 sha256，`--check` 一比就知道有没有漂）。为什么是副本而不是薄壳：
# 服务器看不到这台 Mac 的仓库，而镜像的时效性不该取决于「05:05 时 Mac 醒着没有」。
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

MIRROR_ROOT="${MIRROR_ROOT:-/srv/123pan-mirror}"
CODEUP_BASE="${CODEUP_BASE:-https://codeup.aliyun.com/60f9058e68e2993a8e6d0750/123pan}"
LOG="${SYNC_FLOWERS_LOG:-/var/log/sync-flowers-mirror.log}"
LOCK="${SYNC_FLOWERS_LOCK:-/var/lock/sync-flowers-mirror.lock}"
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

读仓清单（默认 $(default_repos_file)），把每个仓的**清单里写的分支**从 codeup
fetch 进 \$MIRROR_ROOT/<仓名>.git（bare），用 CAS 更新本地同名 ref，然后把写位收回。
各仓**并行**跑（默认 8 个一批），逐仓日志先在内存盘/临时目录里缓冲，跑完按清单顺序
整份打出——所以并行不会把日志撕成互相交错的半行。

清单格式：<仓名><TAB 或空格><分支>[<TAB 或空格><stale_after_days>]；
\`#\` 开头整行是注释；空行忽略。第三格缺省 7 天，写 never = 不因「上游不动了」提醒
（本脚本只认这一格，判定在 src/core/codemirror/health.ts）。

环境变量：
  REPOS_FILE          仓清单            默认 脚本旁边的 repos.txt（或 ../config/repos.txt）
  MIRROR_ROOT         bare 仓根目录     默认 /srv/123pan-mirror
  CODEUP_BASE         codeup 的 123pan 根 默认 https://codeup.aliyun.com/.../123pan
  SYNC_FLOWERS_LOG    日志文件          默认 /var/log/sync-flowers-mirror.log
  SYNC_FLOWERS_LOCK   锁文件            默认 /var/lock/sync-flowers-mirror.lock
  SYNC_JOBS           并发仓数          默认 8（1–64；单仓失败不影响别的仓）
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

# 这个脚本跑在 dogyun 上（Linux）；macOS 没有 flock，直接说清楚，不要假装「已经有一轮在跑」。
command -v flock >/dev/null 2>&1 || {
  echo "sync-mirrors.sh 需要 flock（util-linux）：它是服务器上的脚本（dogyun 上那条 05:05 的 cron），本机请用 scripts/index-nightly.sh" >&2
  exit 2
}

# ─── 读清单 ──────────────────────────────────────────────────────────────────
# 在锁之前就解析：清单坏了要在动任何仓之前失败，而不是同步了一半才报错。
REPOS=()
BRANCHES=()
declare -A SEEN=()
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
  if [ -n "${4:-}" ]; then
    echo "清单里「$trimmed」多了格子（格式是「仓名 分支 [stale_after_days]」，注释只能整行）" >&2
    exit 2
  fi
  # 第三格：可选，本脚本只认不解释（判定在 health.ts）。校验要与 parseRepoInventory 对齐：
  # 一边能读、一边报错退出 2，那一晚整份清单都不同步。
  stale="${3:-}"
  if [ -n "$stale" ]; then
    if ! printf '%s' "$stale" | grep -Eqi '^never$' && ! printf '%s' "$stale" | grep -Eq '^[1-9][0-9]{0,5}$'; then
      echo "清单里「$name」的 stale_after_days「$stale」不合法：只接受正整数或 never" >&2
      exit 2
    fi
  fi
  if [ -z "$branch" ]; then
    branch=master   # 与 TS 侧 FALLBACK_BRANCH 同一个值；TS 会给一行提示，这里只记日志
  fi
  if ! printf '%s' "$branch" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/-]*$' || printf '%s' "$branch" | grep -q '\.\.'; then
    echo "清单里「$name」的分支「$branch」形状不合法（不许空格、不许 ..）" >&2
    exit 2
  fi
  if [ -n "${SEEN[$name]:-}" ]; then
    echo "清单里仓「$name」出现了两次" >&2
    exit 2
  fi
  SEEN[$name]=1
  REPOS+=("$name")
  BRANCHES+=("$branch")
done <"$REPOS_FILE"

if [ "${#REPOS[@]}" -eq 0 ]; then
  echo "清单 $REPOS_FILE 里一个仓都没有（全空或是全注释）" >&2
  exit 2
fi

mkdir -p "$(dirname "$LOG")" 2>/dev/null || { echo "建不了日志目录：$(dirname "$LOG")" >&2; exit 2; }
mkdir -p "$(dirname "$LOCK")" 2>/dev/null || { echo "建不了锁目录：$(dirname "$LOCK")" >&2; exit 2; }

# 同一时刻只允许一轮。抢不到锁不算失败：那一轮是别人在做。
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -Iseconds) skip: another sync is running" >>"$LOG"
  exit 0
fi

exec >>"$LOG" 2>&1
started_at=$(date +%s)
echo "=== sync start $(date -Iseconds) repos=${#REPOS[@]} jobs=$SYNC_JOBS manifest=$REPOS_FILE ==="

# 逐仓缓冲目录：日志与退出码都先落在这里，跑完按清单顺序整份打出。
# 为什么需要它：并行时 N 个 printf 打同一份日志，长行会被内核写进同一个文件时撕开
# （>4 K 的写不保证原子），结果就是「FAIL 123pan-pc … OK 123pan-uni-app …」半行交错。
# 落临时文件再 `cat` 一次，交错的可能性从「取决于行长」变成「不可能」。
JOBDIR="$(mktemp -d "${TMPDIR:-/tmp}/sync-flowers.XXXXXX")" || {
  echo "建不了逐仓缓冲目录（mktemp 失败）：并行日志会被撕碎，宁可不跑" >&2
  exit 2
}
cleanup_jobdir() { rm -rf "$JOBDIR"; }
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
  local dir="$MIRROR_ROOT/$repo.git"
  local g=(git -c safe.directory='*' -C "$dir")
  local before after out st

  if [ ! -d "$dir" ]; then
    # 镜像不存在不是「同步失败」而是「还没接入」：说清楚下一步（onboard-repos 建它），
    # 而不是让人去猜为什么一个目录凭空该存在。
    echo "FAIL $repo: 目录不存在（${dir}）——先跑 scripts/onboard-repos.ts 建这个镜像"
    return 2
  fi

  before=$("${g[@]}" rev-parse --short HEAD 2>/dev/null) || before="(none)"

  # fetch 只写 FETCH_HEAD，不动任何 ref：真正的更新在下面用 CAS 写，
  # 这样「fetch 到一半失败」不会把 master 留在半更新的状态。
  local attempt=0 max=$((FETCH_RETRIES + 1))
  while :; do
    attempt=$((attempt + 1))
    set +e
    out=$(timeout "$FETCH_TIMEOUT" "${g[@]}" fetch --quiet --no-tags --prune \
      "$CODEUP_BASE/$repo.git" "$branch" 2>&1)
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
    if ! "${g[@]}" update-ref -m "sync-flowers-mirror $(date -Iseconds)" \
      "refs/heads/$branch" "$new_full" ${old_full:+"$old_full"}; then
      echo "FAIL update-ref ${repo}@${branch}（$before -> ${after}）"
      return 1
    fi
    echo "OK $repo@$branch $before -> $after moved=1（$("${g[@]}" log -1 --format=%cd --date=format:'%F %T' "$after")）"
  fi

  # 只读权限：这些仓被另一个进程（flowers 的走查/评审）**只读**读取，所以同步完
  # 立刻收回写位——目录 555 / 文件 444，owner root。root 自己下一次 fetch 不受影响
  # （CAP_DAC_OVERRIDE），非 root 谁都改不动。
  chown -R root:root "$dir"
  find "$dir" -type d -exec chmod 555 {} +
  find "$dir" -type f -exec chmod 444 {} +
  return 0
}

# 一个并行槽位里跑的东西：**整仓的输出与退出码都落文件**，自己不往 stdout 写一个字。
#
# 为什么不在这里直接 echo：那是串行版本的做法，在 N 个进程同时跑时正是日志交错的来源。
# 也为什么 `return 0` 恒定：xargs 的退出码只表示「某次调用非零」，把它当聚合信号会让
# 「哪个仓坏了」这个信息丢掉——聚合只认 `<仓名>.rc`，见下面那段。
# `exec 9>&-` 把锁的 fd 从子进程里摘掉：子进程挂住时不该继续「持有」这一轮的锁。
worker() {
  local line="$1" repo branch st=0
  exec 9>&- 2>/dev/null || true
  repo="${line%% *}"
  branch="${line#* }"
  [ "$branch" = "$repo" ] && branch=master
  sync_one "$repo" "$branch" >"$JOBDIR/$repo.log" 2>&1 || st=$?
  printf '%s\n' "$st" >"$JOBDIR/$repo.rc"
  return 0
}

# 子进程要看得见的东西：函数用 export -f，配置用 export。两者缺一个，子进程里的
# `sync_one` 就会以「未定义」的方式静默地一个仓都不同步。
export MIRROR_ROOT CODEUP_BASE FETCH_TIMEOUT FETCH_RETRIES RETRY_BACKOFF JOBDIR
export -f sync_one is_transient mask worker

JOBS_FILE="$JOBDIR/jobs.txt"
: >"$JOBS_FILE"
for i in "${!REPOS[@]}"; do
  printf '%s %s\n' "${REPOS[$i]}" "${BRANCHES[$i]}" >>"$JOBS_FILE"
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

# 与 sync-repos-ro.sh 同一条收尾检查：镜像不许有 remote、config 里不许有带凭据的 URL。
for repo in "${REPOS[@]}"; do
  dir="$MIRROR_ROOT/$repo.git"
  [ -f "$dir/config" ] || continue
  c=$(grep -c '^\[remote' "$dir/config" || true)
  u=$(grep -c '://[^/]*@' "$dir/config" || true)
  echo "cfg $repo remotes=$c userinfo_urls=$u"
  if [ "$c" -ne 0 ] || [ "$u" -ne 0 ]; then rc=3; fi
done

# 只有「没有真故障」时，缺镜像才升级成 rc=4：一个既连不上 codeup、又有仓没建镜像的夜里，
# 人要先看到的是 3（同步坏了），不是 4（去建镜像）。
if [ "$rc" -eq 0 ] && [ "$missing" -gt 0 ]; then
  rc=4
  echo "NOTE $missing 个仓还没有镜像（清单里有）：跑 scripts/onboard-repos.ts 建；本轮 fetch 全绿"
fi
echo "NOTE 本轮到 $(( $(date +%s) - started_at ))s repos=${#REPOS[@]} jobs=$SYNC_JOBS 失败=$failed 缺镜像=$missing"
echo "=== sync done rc=$rc $(date -Iseconds) ==="
exit "$rc"
