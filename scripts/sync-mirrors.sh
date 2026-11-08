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
# 每个仓各判各的：一个失败**不许**拖住别人（镜像里一仓新一仓旧是常态），
# 但整体退出码要非零——cron 的邮件/日志必须能区分「没变」与「坏了」。
#
# 用法：
#   scripts/sync-mirrors.sh              # 正常同步（清单默认在脚本旁边）
#   REPOS_FILE=/path/repos.txt scripts/sync-mirrors.sh
#   SYNC_FLOWERS_LOG=/tmp/x.log scripts/sync-mirrors.sh
#   scripts/sync-mirrors.sh --help
#
# 退出码（2026-11-09 起四档，理由见「两个信号不能共用一格」那段）：
#   0 = 全部成功（含「已经是最新」，日志里 moved=0 能分辨）
#   3 = **真故障**：至少一个仓在所有重试之后仍然 fetch / update-ref 失败，或收尾的
#       cfg 检查不过（镜像里有 remote、或 config 里带凭据 URL）
#   4 = **没有真故障**，但有仓在服务器上没有镜像目录（清单里有、还没 onboard）。
#       这不是「同步坏了」，下一步是跑 scripts/onboard-repos.ts —— 所以它必须是另一个码，
#       否则「昨晚加了 5 个仓、还没来得及建镜像」和「codeup 连不上」在 cron 里长得一样。
#   2 = 环境/清单不对（清单读不到或不合格式 / 建不了日志或锁文件）—— 一个仓都还没动
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

清单格式：<仓名><TAB 或空格><分支>[<TAB 或空格><stale_after_days>]；
\`#\` 开头整行是注释；空行忽略。第三格缺省 7 天，写 never = 不因「上游不动了」提醒
（本脚本只认这一格，判定在 src/core/codemirror/health.ts）。

环境变量：
  REPOS_FILE          仓清单            默认 脚本旁边的 repos.txt（或 ../config/repos.txt）
  MIRROR_ROOT         bare 仓根目录     默认 /srv/123pan-mirror
  CODEUP_BASE         codeup 的 123pan 根 默认 https://codeup.aliyun.com/.../123pan
  SYNC_FLOWERS_LOG    日志文件          默认 /var/log/sync-flowers-mirror.log
  SYNC_FLOWERS_LOCK   锁文件            默认 /var/lock/sync-flowers-mirror.lock
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
echo "=== sync start $(date -Iseconds) repos=${#REPOS[@]} manifest=$REPOS_FILE ==="

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

rc=0
missing=0
for i in "${!REPOS[@]}"; do
  # 逐仓判定，**不许**用 `if ! sync_one`：那样「镜像还没建」（2）与「同步失败」（1）
  # 会合成同一个真值，而这两件事的下一步完全不同（跑 onboard-repos.ts vs 看网络）。
  st=0
  sync_one "${REPOS[$i]}" "${BRANCHES[$i]}" || st=$?
  case "$st" in
    0) ;;
    2) missing=$((missing + 1)) ;;
    *) rc=3 ;;
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
echo "=== sync done rc=$rc $(date -Iseconds) ==="
exit "$rc"
