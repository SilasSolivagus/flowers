#!/bin/bash
# 索引夜间增量同步（Mac，05:10）。镜像 05:05 在 dogyun 上更新完，这里把**新提交**的
# 静态索引补进本地 Postgres——索引不是被查时才建的吗？是懒建的，但懒建意味着
# 「第一个打开材料的人」替所有人付那 200–400 ms 的装配；更重要的是：**索引里有哪个
# sha，是材料上那句「代码快照」诚实的前提**（docs/superpowers/plans/2026-11-08-mirror-freshness.md）。
#
# 这一层只做三件事：锁、日志目录、把退出码原样带出去。真正的工作在
# `scripts/index-nightly.ts`（仓列表来自 `app_settings.code.mirror.repos`，
# 解析复用 `resolveMirrorConfig()`，不硬编码仓名）。
#
# 用法：
#   scripts/index-nightly.sh            # 正常跑
#   FLOWERS_INDEX_LOG=/tmp/n.log scripts/index-nightly.sh
#   scripts/index-nightly.sh --help
#
# 退出码：0 = 每个仓都成功（含「0 块新内容」）；2 = 环境/配置不对（缺 tsx、读不到设置）；
#         3 = 至少一个仓失败（镜像连不上、仓没提交、索引失败）；4 = 上一轮还在跑。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${FLOWERS_INDEX_LOG:-$HOME/Library/Application Support/flowers/logs/index-nightly.log}"
LOCK="${FLOWERS_INDEX_LOCK:-${TMPDIR:-/tmp}/flowers-index-nightly.lock}"
TSX="$ROOT/node_modules/.bin/tsx"

usage() {
  cat <<'USAGE'
用法：index-nightly.sh [--help]

读 app_settings.code.mirror.repos，对每个仓取 HEAD，再用 scripts/index-sync.ts 增量同步
该提交的静态索引，结果逐行追加到日志。

环境变量：
  FLOWERS_INDEX_LOG   日志文件  默认 ~/Library/Application Support/flowers/logs/index-nightly.log
  FLOWERS_INDEX_LOCK  锁目录    默认 ${TMPDIR:-/tmp}/flowers-index-nightly.lock

退出码：0 成功（含 0 块新内容）/ 2 配置或环境不对 / 3 至少一个仓失败 / 4 上一轮还在跑。
USAGE
}

case "${1:-}" in
  --help | -h) usage; exit 0 ;;
  '') ;;
  *) echo "未知参数：$1（--help 看用法）" >&2; exit 2 ;;
esac

mkdir -p "$(dirname "$LOG")" || { echo "建不了日志目录：$(dirname "$LOG")" >&2; exit 2; }

# 同一时刻只允许一轮。macOS 没有 flock，用 mkdir 的原子性（POSIX 也有）。
# 上一轮被杀掉时会留下一个带 pid 的目录：pid 不在了就当成陈旧锁清掉，重试一次。
acquire_lock() {
  if mkdir "$LOCK" 2>/dev/null; then
    printf '%s\n' "$$" >"$LOCK/pid"
    return 0
  fi
  local other=""
  [ -f "$LOCK/pid" ] && other="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
    echo "$(date -Iseconds) skip: another run is in progress (pid $other)" >>"$LOG"
    return 1
  fi
  rm -rf "$LOCK"
  if mkdir "$LOCK" 2>/dev/null; then
    printf '%s\n' "$$" >"$LOCK/pid"
    echo "$(date -Iseconds) note: cleared a stale lock (pid ${other:-?})" >>"$LOG"
    return 0
  fi
  echo "$(date -Iseconds) skip: lock is held by someone else ($LOCK)" >>"$LOG"
  return 1
}

if ! acquire_lock; then
  # 锁被占着不是失败：那一轮是另一次同步在做，下一次会补上。退出码 4 让手工跑的人
  # 一眼看出「没跑」，但**不**当成故障（launchd 不会因此报警）。
  exit 4
fi
trap 'rm -rf "$LOCK"' EXIT

# launchd 的 PATH 是干净的（不带 shell 启动文件），而 `node_modules/.bin/tsx` 的
# shebang 是 `#!/usr/bin/env node`：少了 node 的目录就 exit 127（实测踩过一次）。
# 所以这里显式找 node，再用它起 tsx——PATH 里有没有 node 都不影响。
NODE="${NODE_BIN:-}"
if [ -z "$NODE" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE="$(command -v node)"
  elif [ -x /opt/homebrew/bin/node ]; then
    NODE=/opt/homebrew/bin/node
  elif [ -x /usr/local/bin/node ]; then
    NODE=/usr/local/bin/node
  elif [ -x "$HOME/.local/bin/node" ]; then
    NODE="$HOME/.local/bin/node"
  fi
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "$(date -Iseconds) FAIL 找不到 node（NODE_BIN 可以指定）" >>"$LOG"
  echo "找不到 node：用 NODE_BIN=/path/to/node 指定，或把 node 装到 /opt/homebrew/bin" >&2
  exit 2
fi

if [ ! -x "$TSX" ]; then
  echo "$(date -Iseconds) FAIL 找不到 ${TSX}（先 npm install）" >>"$LOG"
  echo "找不到 ${TSX}：先在 $ROOT 里 npm install" >&2
  exit 2
fi

set +e
"$NODE" "$TSX" "$ROOT/scripts/index-nightly.ts" --log "$LOG"
rc=$?
set -e
exit "$rc"
