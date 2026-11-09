#!/bin/bash
# 把两个夜间任务装到它们该在的地方——**装的东西一律来自仓库**，这样「线上跑的是哪一版」
# 永远能回答。
#
# 三件事，各自可单独调：
#   --server  把 scripts/sync-mirrors.sh **和 config/repos.txt** rsync 到
#             dogyun:/opt/123pan/tools/_ro/（脚本 + 同一目录下的 repos.txt：服务器上那份
#             同步脚本读的就是它，所以两份必须一起来，分开传会出现「新脚本 + 旧清单」），
#             备份 crontab，追加一条 `5 5 * * *`（已经有一模一样的一行就跳过），两个文件各打两边 sha256。
#   --local   在本机装 launchd 任务（本机没有 crontab；launchd 已在用），05:10 跑
#             scripts/index-nightly.sh。
#   --check   只读：比服务器上两个文件的 sha256 与本仓库是否一致、cron 行 / launchd 任务在不在。
#             任一条不成立退出 3（漂了就该让 `--check && echo ok` 断掉）。
#   --server-off  只停服务器那条 `5 5 * * *` cron 行，别的行一个字节都不动，先备份 crontab。
#             2026-11-09 的 mirror cutover 用它：镜像搬回本机之后，那一条只会在
#             服务器上把 26 GB 重新抓回一台不再提供镜像的机器。
#   --remove  拆掉：删 cron 行、删服务器上那份副本、卸载并删 plist。
#
# 为什么服务器上是**副本**而不是「薄壳 exec 仓库里的脚本」：服务器看不到这台 Mac 的仓库。
# 另一条路是「整个同步从 Mac 上 ssh 过去跑」——那会让镜像的时效性绑在「05:05 时 Mac 醒着
# 没有」上，而镜像服务的是服务器上的另一个进程，不该被一台笔电的睡眠拖住。所以选副本，
# 并用 sha256 让漂移可见（`--check` 一条命令就够）。
#
# 用法：
#   scripts/install-cron.sh --server
#   scripts/install-cron.sh --local
#   scripts/install-cron.sh --check
#   scripts/install-cron.sh --remove
#   scripts/install-cron.sh --all        # = --server + --local
#
# 退出码：0 成功（含「已经装好了」）；2 参数/环境不对；3 远端操作失败。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_HOST="${FLOWERS_SYNC_SSH_HOST:-dogyun}"
REMOTE_DIR="/opt/123pan/tools/_ro"
REMOTE_SCRIPT="$REMOTE_DIR/sync-flowers-mirror.sh"
# 仓清单与脚本同目录：服务器上没有仓库，`sync-mirrors.sh` 只认「脚本旁边的 repos.txt」。
# 两份一起 rsync、两份一起校验——只传脚本会变成「新逻辑 + 旧仓清单」，而那种漂是安静的
# （少同步几个仓，日志里只表现为那几行不存在）。
LOCAL_REPOS="$ROOT/config/repos.txt"
REMOTE_REPOS="$REMOTE_DIR/repos.txt"
CRON_LINE="5 5 * * * $REMOTE_SCRIPT"
PLIST_LABEL="com.flowers.index-nightly"
PLIST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

usage() {
  cat <<'USAGE'
用法：install-cron.sh [--server|--server-off|--local|--all|--check|--remove] [--help]

  --server  安装服务器端同步脚本 + 仓清单 + cron 行（先备份 crontab）
  --server-off  只停服务器那条 cron 行（先备份 crontab；脚本与清单留着当回滚材料）
  --local   安装本机 launchd 任务（05:10 跑 index-nightly.sh）
  --all     两者都装
  --check   只读核对（sha256 / cron 行 / launchd 任务）
  --remove  拆掉上面装的东西

环境变量：FLOWERS_SYNC_SSH_HOST  服务器 ssh 别名，默认 dogyun
USAGE
}

sha_of_local() { shasum -a 256 "$1" | cut -d' ' -f1; }
sha_of_remote_file() {
  local remote="$1"
  ssh "$SSH_HOST" "if [ -f '$remote' ]; then (sha256sum '$remote' 2>/dev/null || openssl dgst -sha256 '$remote') | awk '{print \$1}'; else echo missing; fi"
}
sha_of_remote() { sha_of_remote_file "$REMOTE_SCRIPT"; }

install_server() {
  echo "== 服务器（${SSH_HOST}）"
  # 清单先自检：形状不合法就不要传（服务器上那份会被 05:05 的 cron 直接执行，
  # 传上去一份坏清单等于每晚一次 rc=2）。检查口径与 TS 侧同一套正则。
  if [ ! -f "$LOCAL_REPOS" ]; then
    echo "   ✗ 找不到仓清单 $LOCAL_REPOS" >&2
    return 3
  fi
  if ! grep -Evq '^[[:space:]]*(#|$)' "$LOCAL_REPOS"; then
    echo "   ✗ 仓清单里一个仓都没有：$LOCAL_REPOS" >&2
    return 3
  fi
  # 传之前先让本地那份可执行；rsync 之后在远端钉一次 755。
  chmod 755 "$ROOT/scripts/sync-mirrors.sh"
  ssh "$SSH_HOST" "mkdir -p '$REMOTE_DIR'"
  rsync -q "$ROOT/scripts/sync-mirrors.sh" "$SSH_HOST:$REMOTE_SCRIPT"
  rsync -q "$LOCAL_REPOS" "$SSH_HOST:$REMOTE_REPOS"
  ssh "$SSH_HOST" "chmod 755 '$REMOTE_SCRIPT'; chmod 644 '$REMOTE_REPOS'"
  local local_sha remote_sha
  local_sha="$(sha_of_local "$ROOT/scripts/sync-mirrors.sh")"
  remote_sha="$(sha_of_remote)"
  echo "   写入 $SSH_HOST:$REMOTE_SCRIPT"
  echo "   本地 sha256 $local_sha"
  echo "   远端 sha256 $remote_sha"
  if [ "$local_sha" != "$remote_sha" ]; then
    echo "   ✗ 两边 sha256 不一致（rsync 没落地？）" >&2
    return 3
  fi
  local local_repos_sha remote_repos_sha
  local_repos_sha="$(sha_of_local "$LOCAL_REPOS")"
  remote_repos_sha="$(sha_of_remote_file "$REMOTE_REPOS")"
  echo "   写入 $SSH_HOST:$REMOTE_REPOS"
  echo "   本地 sha256 $local_repos_sha"
  echo "   远端 sha256 $remote_repos_sha"
  if [ "$local_repos_sha" != "$remote_repos_sha" ]; then
    echo "   ✗ 仓清单两边 sha256 不一致（rsync 没落地？）" >&2
    return 3
  fi
  echo "   仓 $(grep -Evc '^[[:space:]]*(#|$)' "${LOCAL_REPOS}") 个（${LOCAL_REPOS}）"

  # 追加而不是重写：`crontab -l | crontab -` 会按行原样写回，别人的行一个字节都不动。
  local backup
  backup="/root/crontab.bak.$(date +%Y%m%d-%H%M%S)"
  ssh "$SSH_HOST" "crontab -l > '$backup' 2>/dev/null || true; echo '   备份 crontab → $backup'"
  if ssh "$SSH_HOST" "crontab -l 2>/dev/null | grep -Fq '$REMOTE_SCRIPT'"; then
    echo "   cron 行已存在，未改动：$CRON_LINE"
  else
    ssh "$SSH_HOST" "(crontab -l 2>/dev/null || true; echo '$CRON_LINE') | crontab -"
    echo "   已追加 cron 行：$CRON_LINE"
  fi
  echo "   手工验证：ssh $SSH_HOST '$REMOTE_SCRIPT'（日志 /var/log/sync-flowers-mirror.log）"
  echo "   撤销：ssh $SSH_HOST \"crontab -l | grep -vF '$REMOTE_SCRIPT' | crontab - && rm -f '$REMOTE_SCRIPT'\""
}

# 只停服务器那条 cron 行。为什么单独一个动作而不是复用 `--remove`：
# `--remove` 会连本地 launchd 任务一起卸掉——而 cutover 之后**本地那个才是要留的**。
# 为什么按整条脚本体 `grep -vF` 而不是按时间字段：相邻有一条 `0 5 * * *` 是另一个任务
# （brainboil 的只读影子），按字段删会连它一起删掉。
server_off() {
  echo "== 停服务器 cron（${SSH_HOST}）"
  local backup
  backup="/root/crontab.bak.$(date +%Y%m%d-%H%M%S)"
  ssh "$SSH_HOST" "crontab -l > '$backup' 2>/dev/null || true; echo \"   备份 crontab → $backup（\$(wc -l < '$backup') 行）\""
  ssh "$SSH_HOST" "crontab -l 2>/dev/null | grep -vF '$REMOTE_SCRIPT' | crontab -"
  local left
  left="$(ssh "$SSH_HOST" "crontab -l 2>/dev/null | grep -cF '$REMOTE_SCRIPT' || true")"
  echo "   剩余的 $REMOTE_SCRIPT 行数：$left（应为 0）"
  echo "   脚本与清单**没有删**：$REMOTE_SCRIPT / $REMOTE_REPOS（回滚材料）"
  echo "   回滚：先重抓镜像，再把 transport 改回 ssh，然后 run --server 或从 $backup 恢回那一行"
  [ "$left" = "0" ] || return 3
}

install_local() {
  echo "== 本机（launchd）"
  mkdir -p "$HOME/Library/LaunchAgents"
  # launchd 不读 shell 启动文件，PATH 得自己给。node 的目录按安装时探测（这台机器是
  # ~/.local/bin/node → homebrew Cellar），脚本本身仍然显式找 node，不依赖这一行。
  local node_dir=""
  node_dir="$(dirname "$(command -v node 2>/dev/null || echo /opt/homebrew/bin/node)")"
  local plist_path="$node_dir:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  local logdir="$HOME/Library/Application Support/flowers/logs"
  mkdir -p "$logdir"
  cat >"$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT/scripts/index-nightly.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$plist_path</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>5</integer>
    <key>Minute</key><integer>10</integer>
  </dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$logdir/index-nightly.launchd.log</string>
  <key>StandardErrorPath</key><string>$logdir/index-nightly.launchd.log</string>
</dict>
</plist>
PLIST_EOF
  chmod 644 "$PLIST"
  launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "   写入 ${PLIST}（StartCalendarInterval 05:10，等价 cron 的 10 5 * * *）"
  echo "   日志 ~/Library/Application Support/flowers/logs/index-nightly.log"
  echo "   手工验证：$ROOT/scripts/index-nightly.sh"
  echo "   撤销：launchctl bootout gui/$(id -u)/$PLIST_LABEL && rm -f $PLIST"
}

check() {
  echo "== 核对"
  # 判据是「有没有漂」，所以**漂了就要非零退出**。2026-11-09 实测：清单从 21 行改到 66 行
  # 之后 `--check` 打了 ✗ 却仍以 0 收尾——而这条命令唯一的使用方式就是
  # `scripts/install-cron.sh --check && echo 装好了`，退出码为 0 等于把 ✗ 变成一句注释。
  # 三个判据（两份文件的 sha256、cron 行、launchd 任务）任意一条不成立即 3。
  local bad=0
  # 服务器那份现在是什么角色：cron 行还在 = 它仍在被调度（漂了就是故障）；cron 行不在 =
  # 它只是回滚材料（漂了只是「比仓库旧」，不该让 `--check && echo ok` 永远断）。
  local server_active=0
  if ssh "$SSH_HOST" "crontab -l 2>/dev/null | grep -Fq '$REMOTE_SCRIPT'"; then server_active=1; fi
  local local_sha remote_sha
  local_sha="$(sha_of_local "$ROOT/scripts/sync-mirrors.sh")"
  remote_sha="$(sha_of_remote)"
  echo "   sync-mirrors.sh 本地 $local_sha"
  echo "   sync-mirrors.sh 远端 $remote_sha"
  [ "$local_sha" = "$remote_sha" ] && echo "   ✓ 一致" || {
    if [ "$server_active" -eq 1 ]; then echo "   ✗ 不一致：跑一次 --server"; bad=1
    else echo "   ! 不一致（服务器那一份已停用，只是回滚材料，不影响判定）"; fi
  }
  local local_repos_sha remote_repos_sha
  local_repos_sha="$(sha_of_local "$LOCAL_REPOS")"
  remote_repos_sha="$(sha_of_remote_file "$REMOTE_REPOS")"
  echo "   repos.txt 本地 $local_repos_sha"
  echo "   repos.txt 远端 $remote_repos_sha"
  [ "$local_repos_sha" = "$remote_repos_sha" ] && echo "   ✓ 一致" || {
    if [ "$server_active" -eq 1 ]; then echo "   ✗ 不一致：跑一次 --server（改了清单就必须重跑）"; bad=1
    else echo "   ! 不一致（服务器那一份已停用，只是回滚材料，不影响判定）"; fi
  }
  # 2026-11-09 的 cutover 之后，「服务器上没有这一行」是**正确状态**（镜像已搬回本机，
  # 那条 cron 只会把 26 GB 抓回去）。所以这一条只报状态、不参与失败判定；真要装回去，
  # `--server` 会把它加回来，`--check` 到时候照样看得见。
  if ssh "$SSH_HOST" "crontab -l 2>/dev/null | grep -Fq '$REMOTE_SCRIPT'"; then
    echo "   ! 服务器 cron 行还在：$CRON_LINE（cutover 之后本该停用：跑一次 --server-off）"
  else
    echo "   ✓ 服务器 cron 行已停用（2026-11-09 cutover 后的预期状态）"
  fi
  if launchctl print "gui/$(id -u)/$PLIST_LABEL" >/dev/null 2>&1; then
    echo "   ✓ launchd 任务已加载：${PLIST_LABEL}（05:10）"
  else
    echo "   ✗ launchd 任务未加载（${PLIST}）"; bad=1
  fi
  [ "$bad" -eq 0 ] || return 3
}

remove_all() {
  echo "== 拆除"
  ssh "$SSH_HOST" "crontab -l 2>/dev/null | grep -vF '$REMOTE_SCRIPT' | crontab - || true; rm -f '$REMOTE_SCRIPT' '$REMOTE_REPOS'; echo '   服务器：cron 行、副本与仓清单已删'"
  launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "   本机：launchd 任务已卸载、plist 已删（日志与索引数据保留）"
}

# 同一时刻只允许一轮安装：两条并发的 crontab 追加会互相把对方那行盖掉。
LOCK="/tmp/flowers-install-cron.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "另一个 install-cron.sh 正在跑（${LOCK}）" >&2
  exit 2
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

case "${1:-}" in
  --server) install_server ;;
  --server-off) server_off ;;
  --local) install_local ;;
  --all) install_server; install_local ;;
  --check) check ;;
  --remove) remove_all ;;
  --help | -h) usage ;;
  '') usage; exit 2 ;;
  *) echo "未知参数：$1（--help 看用法）" >&2; exit 2 ;;
esac
