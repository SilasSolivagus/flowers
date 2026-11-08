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
# 退出码：0 = 全部成功（含「已经是最新」，日志里 moved=0 能分辨）；3 = 至少一个仓失败；
#         2 = 环境/清单不对（缺仓目录 / 清单读不到或不合格式 / 建不了日志或锁文件）。
#         flock 被人占着时退出 0：那一轮是**另一次同步在做**，不是失败（次数少、且下一次会补上）。
set -euo pipefail

MIRROR_ROOT="${MIRROR_ROOT:-/srv/123pan-mirror}"
CODEUP_BASE="${CODEUP_BASE:-https://codeup.aliyun.com/60f9058e68e2993a8e6d0750/123pan}"
LOG="${SYNC_FLOWERS_LOG:-/var/log/sync-flowers-mirror.log}"
LOCK="${SYNC_FLOWERS_LOCK:-/var/lock/sync-flowers-mirror.lock}"
FETCH_TIMEOUT="${FETCH_TIMEOUT:-300}"

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

清单格式：<仓名><TAB 或空格><分支>；\`#\` 开头整行是注释；空行忽略。

环境变量：
  REPOS_FILE          仓清单            默认 脚本旁边的 repos.txt（或 ../config/repos.txt）
  MIRROR_ROOT         bare 仓根目录     默认 /srv/123pan-mirror
  CODEUP_BASE         codeup 的 123pan 根 默认 https://codeup.aliyun.com/.../123pan
  SYNC_FLOWERS_LOG    日志文件          默认 /var/log/sync-flowers-mirror.log
  SYNC_FLOWERS_LOCK   锁文件            默认 /var/lock/sync-flowers-mirror.lock
  FETCH_TIMEOUT       单次 fetch 超时（秒） 默认 300

退出码：0 成功（含 already up to date）/ 3 至少一个仓失败 / 2 环境或清单不对。
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
  if [ -n "${3:-}" ]; then
    echo "清单里「$trimmed」多了格子（格式是「仓名 分支」，注释只能整行）" >&2
    exit 2
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

# 同步一个仓。成功返回 0（无论 ref 有没有动），失败返回 1——调用方收集，不中断循环。
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
    return 1
  fi

  before=$("${g[@]}" rev-parse --short HEAD 2>/dev/null) || before="(none)"

  # fetch 只写 FETCH_HEAD，不动任何 ref：真正的更新在下面用 CAS 写，
  # 这样「fetch 到一半失败」不会把 master 留在半更新的状态。
  set +e
  out=$(timeout "$FETCH_TIMEOUT" "${g[@]}" fetch --quiet --no-tags --prune \
    "$CODEUP_BASE/$repo.git" "$branch" 2>&1)
  st=$?
  set -e
  if [ "$st" -ne 0 ]; then
    echo "FAIL fetch $repo@$branch (rc=$st): $(printf '%s' "$out" | mask | tail -3 | tr '\n' ' ')"
    return 1
  fi

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
for i in "${!REPOS[@]}"; do
  if ! sync_one "${REPOS[$i]}" "${BRANCHES[$i]}"; then rc=3; fi
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

echo "=== sync done rc=$rc $(date -Iseconds) ==="
exit "$rc"
