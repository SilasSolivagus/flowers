#!/bin/bash
# flowers 上线自检（2026-11-10）。
#
# 一条命令回答「这套东西现在是不是好的」：进程在不在、端口通不通、域名会不会把人
# 挡在门外、库连不连得上、企微授权还在不在、群播报与汇总表有没有在悄悄失败、
# 定时任务还活着没有。
#
#   部署机：/opt/flowers/scripts/healthcheck.sh
#   cron：  */30 * * * * /opt/flowers/scripts/healthcheck.sh --quiet || echo "flowers 自检失败" | mail -s …
#
# 退出码：0 全绿；1 有硬故障（登录不可用 / 进程挂了 / 库连不上）；2 只有告警
# （死信积压、日志太久没动、磁盘紧）。
set -uo pipefail

QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${FLOWERS_ENV_FILE:-$ROOT/.env.production}"
DOMAIN="${FLOWERS_CHECK_DOMAIN:-flower.dirctable.com}"
PORT="${FLOWERS_CHECK_PORT:-3010}"

fails=0
warns=0
say() { [[ $QUIET -eq 1 ]] || echo "$@"; }
ok()   { say "  ✓ $*"; }
warn() { say "  ! $*"; warns=$((warns + 1)); }
bad()  { echo "  ✗ $*" >&2; fails=$((fails + 1)); }

# ── 环境 ────────────────────────────────────────────────────────────────────
if [[ ! -f "${ENV_FILE}" ]]; then
  bad "找不到环境文件 ${ENV_FILE}"
else
  # 只取需要的两个，不 source 整份（里面有密钥，别让它进 ps 或子进程环境）。
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "${ENV_FILE}" | head -1 | cut -d= -f2-)"
  [[ -n "${DATABASE_URL:-}" ]] && ok "环境文件存在" || bad "环境文件里没有 DATABASE_URL"
fi

db() {
  # 优先用本机 psql；没有就借 flowers-postgres 容器里的 psql（部署机常见情况）。
  if command -v psql >/dev/null 2>&1; then
    psql "${DATABASE_URL}" -At -c "$1" 2>/dev/null
  else
    docker exec flowers-postgres psql "${DATABASE_URL}" -At -c "$1" 2>/dev/null
  fi
}

# ── 进程与端口 ──────────────────────────────────────────────────────────────
if ! command -v systemctl >/dev/null 2>&1; then
  warn "这台机器没有 systemd（本机自检？）：跳过进程检查"
elif systemctl is-active --quiet flowers; then
  ok "flowers.service 在跑（$(systemctl show -p MainPID --value flowers)）"
else
  bad "flowers.service 没在跑：systemctl status flowers"
fi

if ss -lnt 2>/dev/null | grep -q ":${PORT} "; then
  ok "端口 ${PORT} 在听"
else
  bad "端口 ${PORT} 没有监听"
fi

# ── 域名与登录页 ────────────────────────────────────────────────────────────
# curl 失败时自己也会打一个 000，外面再 `|| echo 000` 会拼成 000000——只在空的时候补。
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://${DOMAIN}/login" 2>/dev/null || true)"
code="${code:-000}"
if [[ "${code}" == "200" ]]; then
  ok "https://${DOMAIN}/login 200"
else
  bad "https://${DOMAIN}/login 返回 ${code}（nginx 上游 / 证书 / 进程）"
fi

# cookie 必须是 Secure 的：生产里非 https 会「登录成功但立刻掉线」。
setcookie="$(curl -s -D - -o /dev/null --max-time 8 "https://${DOMAIN}/login" | tr -d '\r' | grep -i '^set-cookie:' | head -1)"
if [[ -z "$setcookie" ]]; then
  warn "登录页没有下发 cookie（未登录时正常；有会话时应当有）"
fi

# ── 数据库 ──────────────────────────────────────────────────────────────────
rows="$(db 'select count(*) from requirements where deleted_at is null' || echo '')"
if [[ -n "${rows}" ]]; then
  ok "库连得上：未删需求 ${rows} 条"
else
  bad "库连不上：检查 DATABASE_URL / postgres 容器"
fi

queue="$(db "select count(*) from requirements where state='queue' and deleted_at is null" || echo '')"
[[ -n "${queue}" ]] && ok "待排期 ${queue} 条"

# ── 企微授权与配置 ──────────────────────────────────────────────────────────
if command -v wecom-cli >/dev/null 2>&1; then
  if wecom-cli auth show 2>/dev/null | grep -q 'Status: authorized'; then
    ok "wecom-cli 已授权"
  else
    bad "wecom-cli 未授权：wecom-cli auth init"
  fi
else
  warn "没装 wecom-cli：个人推送 / PRD 读取 / 汇总表同步都会失败"
fi

hook="$(db "select coalesce(value,'') from app_settings where key='notify.groupWebhook'" || echo '')"
[[ -n "${hook}" ]] && ok "群机器人 webhook 已配置（末 4 位 …${hook: -4}）" || warn "没配群机器人：群播报不会发（--webhook 配一次）"

# ── 台账：悄悄失败的东西 ────────────────────────────────────────────────────
# 库连不上时这三条没有意义（空值会被当成 0 报绿），直接跳过。
if [[ -z "${rows}" ]]; then
  warn "库不可读：跳过失败台账检查"
else
failed_push="$(db "select count(*) from notify_deliveries where status='failed' and created_at > now() - interval '2 hours'" || echo '')"
[[ "${failed_push:-0}" == "0" ]] && ok "个人推送近 2h 无失败" || warn "个人推送近 2h 有 ${failed_push} 条失败"

failed_group="$(db "select count(*) from group_posts where status='failed' and created_at > now() - interval '2 hours'" || echo '')"
[[ "${failed_group:-0}" == "0" ]] && ok "群播报近 2h 无失败" || warn "群播报近 2h 有 ${failed_group} 条失败"

failed_sheet="$(db "select count(*) from sheet_sync where state='failed'" || echo '')"
[[ "${failed_sheet:-0}" == "0" ]] && ok "汇总表无待重试行" || warn "汇总表有 ${failed_sheet} 条 failed：npm run sheet:sync -- --limit 5"
fi

# ── 定时任务是否还活着 ──────────────────────────────────────────────────────
for log in /var/log/flowers-push.log /var/log/flowers-group.log /var/log/flowers-sheet.log; do
  if [[ ! -f "${log}" ]]; then
    warn "没有日志 ${log}（cron 还没跑过？）"
    continue
  fi
  age=$(( ( $(date +%s) - $(stat -c %Y "${log}" 2>/dev/null || echo 0) ) / 60 ))
  # push / group 是每 5 分钟，sheet 是每 10 分钟；给 3 倍余量。
  limit=30
  [[ "${log}" == *sheet* ]] && limit=45
  if [[ ${age} -le ${limit} ]]; then
    ok "$(basename "${log}") ${age} 分钟前更新"
  else
    warn "$(basename "${log}") 已经 ${age} 分钟没更新（cron 停了？）"
  fi
done

# ── 磁盘 ────────────────────────────────────────────────────────────────────
avail="$(df -Pk / | tail -1 | awk '{print int($4/1024/1024)}')"
[[ "${avail}" -ge 5 ]] && ok "根分区剩余 ${avail}G" || warn "根分区只剩 ${avail}G"

# ── 结论 ────────────────────────────────────────────────────────────────────
say ""
if [[ ${fails} -gt 0 ]]; then
  echo "自检失败：${fails} 条硬故障，${warns} 条告警" >&2
  exit 1
elif [[ ${warns} -gt 0 ]]; then
  echo "自检通过，${warns} 条告警"
  exit 2
else
  echo "自检全绿"
  exit 0
fi
