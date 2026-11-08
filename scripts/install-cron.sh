#!/bin/bash
# 把两个夜间任务装到它们该在的地方——**装的东西一律来自仓库**，这样「线上跑的是哪一版」
# 永远能回答。
#
# 三件事，各自可单独调：
#   --server  把 scripts/sync-mirrors.sh rsync 到 dogyun:/opt/123pan/tools/_ro/sync-flowers-mirror.sh，
#             备份 crontab，追加一条 `5 5 * * *`（已经有一模一样的一行就跳过），打两边 sha256。
#   --local   在本机装 launchd 任务（本机没有 crontab；launchd 已在用），05:10 跑
#             scripts/index-nightly.sh。
#   --check   只读：比服务器上那份的 sha256 与本仓库是否一致、cron 行 / launchd 任务在不在。
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
CRON_LINE="5 5 * * * $REMOTE_SCRIPT"
PLIST_LABEL="com.flowers.index-nightly"
PLIST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

usage() {
  cat <<'USAGE'
用法：install-cron.sh [--server|--local|--all|--check|--remove] [--help]

  --server  安装服务器端同步脚本 + cron 行（先备份 crontab）
  --local   安装本机 launchd 任务（05:10 跑 index-nightly.sh）
  --all     两者都装
  --check   只读核对（sha256 / cron 行 / launchd 任务）
  --remove  拆掉上面装的东西

环境变量：FLOWERS_SYNC_SSH_HOST  服务器 ssh 别名，默认 dogyun
USAGE
}

sha_of_local() { shasum -a 256 "$1" | cut -d' ' -f1; }
sha_of_remote() {
  ssh "$SSH_HOST" "if [ -f '$REMOTE_SCRIPT' ]; then (sha256sum '$REMOTE_SCRIPT' 2>/dev/null || openssl dgst -sha256 '$REMOTE_SCRIPT') | awk '{print \$1}'; else echo missing; fi"
}

install_server() {
  echo "== 服务器（${SSH_HOST}）"
  # 传之前先让本地那份可执行；rsync 之后在远端钉一次 755。
  chmod 755 "$ROOT/scripts/sync-mirrors.sh"
  ssh "$SSH_HOST" "mkdir -p '$REMOTE_DIR'"
  rsync -q "$ROOT/scripts/sync-mirrors.sh" "$SSH_HOST:$REMOTE_SCRIPT"
  ssh "$SSH_HOST" "chmod 755 '$REMOTE_SCRIPT'"
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
  local local_sha remote_sha
  local_sha="$(sha_of_local "$ROOT/scripts/sync-mirrors.sh")"
  remote_sha="$(sha_of_remote)"
  echo "   sync-mirrors.sh 本地 $local_sha"
  echo "   sync-mirrors.sh 远端 $remote_sha"
  [ "$local_sha" = "$remote_sha" ] && echo "   ✓ 一致" || echo "   ✗ 不一致：跑一次 --server"
  if ssh "$SSH_HOST" "crontab -l 2>/dev/null | grep -Fq '$REMOTE_SCRIPT'"; then
    echo "   ✓ cron 行在：$CRON_LINE"
  else
    echo "   ✗ cron 行不在"
  fi
  if launchctl print "gui/$(id -u)/$PLIST_LABEL" >/dev/null 2>&1; then
    echo "   ✓ launchd 任务已加载：${PLIST_LABEL}（05:10）"
  else
    echo "   ✗ launchd 任务未加载（${PLIST}）"
  fi
}

remove_all() {
  echo "== 拆除"
  ssh "$SSH_HOST" "crontab -l 2>/dev/null | grep -vF '$REMOTE_SCRIPT' | crontab - || true; rm -f '$REMOTE_SCRIPT'; echo '   服务器：cron 行与副本已删'"
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
  --local) install_local ;;
  --all) install_server; install_local ;;
  --check) check ;;
  --remove) remove_all ;;
  --help | -h) usage ;;
  '') usage; exit 2 ;;
  *) echo "未知参数：$1（--help 看用法）" >&2; exit 2 ;;
esac
