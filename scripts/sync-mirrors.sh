#!/bin/bash
# 123pan 镜像仓（/srv/123pan-mirror/*.git）每日同步。
#
# 谁在跑：dogyun 上 root 的 cron（`5 5 * * *`），由 `scripts/install-cron.sh --server`
# 安装。**仓库里这一份是源头**；服务器上那份是 `--server` rsync 过去的副本（安装时会
# 打两边的 sha256，`--check` 一比就知道有没有漂）。为什么是副本而不是薄壳：
# 服务器看不到这台 Mac 的仓库，而镜像的时效性不该取决于「05:05 时 Mac 醒着没有」。
#
# 与 `sync-repos-ro.sh`（另一批仓，影子只读挂载）的关系：同一套约定（flock、单一日志、
# GIT_TERMINAL_PROMPT=0、日志里抹掉 userinfo、safe.directory），但它**不**复用那份
# 脚本——那三个仓是 brainboil 的 555 只读影子，这两个仓是 root 的 bare 镜像，权限与
# 失败语义都不同，混在一个脚本里只会让「哪一段坏了」更难读。
#
# 两个仓各判各的：一个失败**不许**拖住另一个（镜像里一仓新一仓旧是常态），
# 但整体退出码要非零——cron 的邮件/日志必须能区分「没变」与「坏了」。
#
# 用法：
#   scripts/sync-mirrors.sh              # 正常同步
#   SYNC_FLOWERS_LOG=/tmp/x.log scripts/sync-mirrors.sh
#   scripts/sync-mirrors.sh --help
#
# 退出码：0 = 全部成功（含「已经是最新」，日志里 moved=0 能分辨）；3 = 至少一个仓失败；
#         2 = 环境不对（缺仓目录 / 建不了日志或锁文件）。flock 被人占着时退出 0：
#         那一轮是**另一次同步在做**，不是失败（次数少、且下一次会补上）。
set -euo pipefail

MIRROR_ROOT="${MIRROR_ROOT:-/srv/123pan-mirror}"
CODEUP_BASE="${CODEUP_BASE:-https://codeup.aliyun.com/60f9058e68e2993a8e6d0750/123pan}"
BRANCH="${BRANCH:-master}"
LOG="${SYNC_FLOWERS_LOG:-/var/log/sync-flowers-mirror.log}"
LOCK="${SYNC_FLOWERS_LOCK:-/var/lock/sync-flowers-mirror.lock}"
FETCH_TIMEOUT="${FETCH_TIMEOUT:-300}"
# 白名单写死在脚本里：这两个仓是「这个产品的前端」的定义，不是可配置项。
# 想加仓就改这一行——顺带提醒：加仓要同时确认 `code.mirror.repos` 里也配了它。
# 一个仓失败不拖另一个（见 --help 与退出码约定）。
# cross-frontend 是 owner 2026-11-08 追加的：它在 code.mirror.repos 里，不跟上的话
# 材料会一直按它的旧快照算，并显示「代码快照较旧」。
REPOS=(123pan-pc 123pan-uni-app 123pan-cross-frontend)

usage() {
  cat <<'USAGE'
用法：sync-mirrors.sh [--help]

把 123pan-pc / 123pan-uni-app 的 master 从 codeup fetch 进
$MIRROR_ROOT/<repo>.git（bare），用 CAS 更新本地 master ref。

环境变量：
  MIRROR_ROOT     bare 仓根目录        默认 /srv/123pan-mirror
  CODEUP_BASE     codeup 的 123pan 根   默认 https://codeup.aliyun.com/.../123pan
  BRANCH          远端分支              默认 master
  SYNC_FLOWERS_LOG   日志文件           默认 /var/log/sync-flowers-mirror.log
  SYNC_FLOWERS_LOCK  锁文件             默认 /var/lock/sync-flowers-mirror.lock
  FETCH_TIMEOUT  单次 fetch 超时（秒）  默认 300

退出码：0 成功（含 already up to date）/ 3 至少一个仓失败 / 2 环境不对。
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

mkdir -p "$(dirname "$LOG")" 2>/dev/null || { echo "建不了日志目录：$(dirname "$LOG")" >&2; exit 2; }
mkdir -p "$(dirname "$LOCK")" 2>/dev/null || { echo "建不了锁目录：$(dirname "$LOCK")" >&2; exit 2; }

# 同一时刻只允许一轮。抢不到锁不算失败：那一轮是别人在做。
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -Iseconds) skip: another sync is running" >>"$LOG"
  exit 0
fi

exec >>"$LOG" 2>&1
echo "=== sync start $(date -Iseconds) ==="

# 日志里不出现 userinfo：现在的 BASEURL 本身不带凭据（走 /root/.git-credentials），
# 但一旦有人顺手把 token 拼进 URL，这一行是最后一道闸。
mask() { sed -E 's#//[^/@ ]*@#//<userinfo>@#g'; }

# 同步一个仓。成功返回 0（无论 ref 有没有动），失败返回 1——调用方收集，不中断循环。
sync_one() {
  local repo="$1"
  local dir="$MIRROR_ROOT/$repo.git"
  local g=(git -c safe.directory='*' -C "$dir")
  local before after out st

  if [ ! -d "$dir" ]; then
    echo "FAIL $repo: 目录不存在（${dir}）"
    return 1
  fi

  before=$("${g[@]}" rev-parse --short HEAD 2>/dev/null) || before="(none)"

  # fetch 只写 FETCH_HEAD，不动任何 ref：真正的更新在下面用 CAS 写，
  # 这样「fetch 到一半失败」不会把 master 留在半更新的状态。
  set +e
  out=$(timeout "$FETCH_TIMEOUT" "${g[@]}" fetch --quiet --no-tags --prune \
    "$CODEUP_BASE/$repo.git" "$BRANCH" 2>&1)
  st=$?
  set -e
  if [ "$st" -ne 0 ]; then
    echo "FAIL fetch $repo (rc=$st): $(printf '%s' "$out" | mask | tail -3 | tr '\n' ' ')"
    return 1
  fi

  local new_full
  new_full=$("${g[@]}" rev-parse FETCH_HEAD 2>/dev/null) || {
    echo "FAIL $repo: 拿不到 FETCH_HEAD"
    return 1
  }
  after=$("${g[@]}" rev-parse --short "$new_full" 2>/dev/null) || after="$new_full"

  if [ "$before" = "$after" ]; then
    echo "OK $repo $before -> $after moved=0（已经是最新）"
  else
    local old_full
    old_full=$("${g[@]}" rev-parse "$BRANCH" 2>/dev/null) || old_full=""
    # CAS：期望旧值还指着我们刚读到的那个提交；并发写会在这里失败，而不是悄悄覆盖。
    if ! "${g[@]}" update-ref -m "sync-flowers-mirror $(date -Iseconds)" \
      "refs/heads/$BRANCH" "$new_full" ${old_full:+"$old_full"}; then
      echo "FAIL update-ref ${repo}（$before -> ${after}）"
      return 1
    fi
    echo "OK $repo $before -> $after moved=1（$("${g[@]}" log -1 --format=%cd --date=format:'%F %T' "$after")）"
  fi

  # 只读权限：这两个仓被另一个进程（flowers 的走查/评审）**只读**读取，所以同步完
  # 立刻收回写位——目录 555 / 文件 444，owner root。root 自己下一次 fetch 不受影响
  # （CAP_DAC_OVERRIDE），非 root 谁都改不动。
  chown -R root:root "$dir"
  find "$dir" -type d -exec chmod 555 {} +
  find "$dir" -type f -exec chmod 444 {} +
  return 0
}

rc=0
for repo in "${REPOS[@]}"; do
  if ! sync_one "$repo"; then rc=3; fi
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
