# 用 flowers 替掉 Flower（含域名切换）

> 状态：**计划**。生产操作标 🔒，执行前需要 Silas 明确同意。
> 事实栏里的主机、端口、路径、域名都是 2026-11-10 在 `dogyun` 上**实际读到的**，
> 不是推断。命令可直接复制。

## 0. 现状（读到的，不是猜的）

| 项 | 值 | 怎么读到的 |
|---|---|---|
| 生产机 | `47.115.229.192`（ssh 别名 `dogyun`，root，Ubuntu 24.04.4，Node v22.22.1，npm 10.9.4） | `ssh dogyun '. /etc/os-release; node -v'` |
| 域名 | **`flower.dirctable.com`**（证书在 `/etc/letsencrypt/live/flower.dirctable.com/`） | `docker exec edge-nginx grep -rl flower.dirctable.com /etc/nginx` |
| 入口 | 容器 `edge-nginx`（nginx:alpine），配置 `/etc/nginx/conf.d/80-flower.conf` | 同上 |
| 上游 | `set $flower_upstream "flower:3000"`（edge_net 的 docker DNS） | `docker exec edge-nginx cat /etc/nginx/conf.d/80-flower.conf` |
| 老栈 | `/opt/flower`，容器 `flower-flower-1`（镜像 `flower:ganttreq-20261105`），`127.0.0.1:3000` | `docker ps` |
| edge 网络 | `edge_net`，网关 `172.19.0.1` | `docker network inspect edge_net` |
| 企微 CLI | `/usr/bin/wecom-cli`，`Status: authorized`，凭据在 `/root/.config/wecom`（root 私有） | `wecom-cli auth show` |
| 磁盘 | 99G，已用 44G，可用 51G | `df -h /` |

**结论：域名不用动 DNS，证书不用换。** 切换只是把 `80-flower.conf` 里那两处上游从
`flower:3000` 改成 `172.19.0.1:3010`，然后 reload edge-nginx。回滚就是改回来。

## 1. 目标架构

```
浏览器 ──https──▶ edge-nginx(容器, 443) ──▶ 172.19.0.1:3010（宿主机）
                                              └─ systemd: flowers.service
                                                   ├─ next start（/opt/flowers）
                                                   ├─ Postgres（容器 flowers-postgres, 127.0.0.1:5434）
                                                   ├─ wecom-cli（/usr/bin + /root/.config/wecom）
                                                   └─ cron：时钟推进 / 个人推送 / 群播报 / 汇总表
```

为什么是宿主机进程而不是容器：`wecom-cli` 的授权是扫码得来的、凭据在 root 家目录；
生成器调的是宿主机上的 agent CLI。放容器里要么多挂两个私有目录，要么每次换授权重建镜像，
而这个部署只有一台机 —— 容器化在这里没有换来任何东西。

## 2. 先拍板（不然后面全是白工）

| # | 要定的事 | 建议 | 不定的后果 |
|---|---|---|---|
| 1 | 功能取舍：Flower 的**迭代 / PRD 文档树 / 任务工时 / 多组织 / 操作日志 / Excel 导入**，flowers 没有 | 明确下线；PRD 只留外链 + 生成材料；工时由版本+甘特替代 | 替换不成立，只能继续双开 |
| 2 | 账号密码：Flower 用 argon2id、flowers 用 scrypt，**哈希不能搬** | 切换前统一重置为初始密码 + 群公告，登录后自改 | 切换后全员登不进来 |
| 3 | 切换窗口 | 工作日 19:00 之后（30–45 分钟停机） | 白天切会撞上评审会 |

## 3. 准备清单

**数据**

- [ ] Flower 库备份（`scripts/backup-flower.sh`，机外留一份）
- [ ] flowers 全量导入：`npx tsx scripts/migrate-flower.ts --apply`（803 条，按 `legacy_ref` 幂等）
- [ ] 增量对齐：`npx tsx scripts/migrate-flower.ts --refresh`（只看差异）→ `--refresh --apply`
- [ ] 重复条目处理（同名多条，如 PAN-1/439/603）：定规则并执行
- [ ] PRD 文档树导出为只读归档，批量改写 `prd_url` 指向归档地址
- [ ] 数据目录备份：`/var/lib/flowers`（会话密钥 + UEmaster 产物）

**账号**

- [ ] `npx tsx scripts/reset-passwords.ts` 预览名单（在册 7 人）
- [ ] 切换日 `--apply` 重置
- [ ] 群公告：账号=邮箱，初始密码见公告，登录后自改

**基础设施**

- [ ] `/opt/flowers` 放仓库，`npm ci && npm run build`（必须 webpack，脚本已固定）
- [ ] Postgres：新容器 `flowers-postgres`（postgres:17-alpine，`127.0.0.1:5434`），建库建角色
- [ ] `.env.production`（见 `deploy/flowers.env.example`），权限 600
  - `FLOWERS_PUBLIC_URL=https://flower.dirctable.com`、`FLOWERS_DATA_DIR=/var/lib/flowers`
  - `FLOWERS_SESSION_SECRET` 固定值并进保险箱（丢了全员掉线）
- [ ] `npm run db:migrate` 跑到最新（含 `0039 sheet_sync`、`0040 group_posts`）
- [ ] systemd：`cp deploy/flowers.service /etc/systemd/system && systemctl enable --now flowers`
- [ ] nginx：`deploy/nginx-flower.conf` 对照改 `/etc/nginx/conf.d/80-flower.conf`，**先 `nginx -t`**
- [ ] 安全组 / ufw：3010 只允许 edge 容器访问，Postgres 端口不对公网

**外部依赖**

- [ ] `wecom-cli auth show` = authorized（已验证；切换后 `auth init` 需扫码，提前确认能扫）
- [ ] 群机器人 webhook 已配（`app_settings.notify.groupWebhook`，末 4 位 `…cdbc`）
- [ ] 汇总表 `kvf2dh` 可读可写（`npx tsx scripts/sheet-sync.ts` 无 failed）
- [ ] 生成器 CLI + 模型 key，设置页「测试」通过

**定时任务**

```cron
*/5 * * * *  cd /opt/flowers && npx tsx scripts/wecom-dispatch.ts --tick >> /var/log/flowers-push.log 2>&1
*/5 * * * *  cd /opt/flowers && npx tsx scripts/group-dispatch.ts        >> /var/log/flowers-group.log 2>&1
0 10 * * *   cd /opt/flowers && npx tsx scripts/group-dispatch.ts --daily >> /var/log/flowers-group.log 2>&1
*/10 * * * * cd /opt/flowers && npx tsx scripts/sheet-sync.ts            >> /var/log/flowers-sheet.log 2>&1
*/30 * * * * /opt/flowers/scripts/healthcheck.sh --quiet || logger -t flowers "healthcheck 失败"
```

第一条的 `--tick` 是**时钟推进的唯一入口**（开发中→测试中→已上线），漏了需求会永远卡住。

## 4. 时间表

| 时间 | 做什么 | 验收 |
|---|---|---|
| **T-7** | 拍板第 2 节三件事 | 三条决定落字 |
| **T-5** | 新栈起到「内网能登录」：build、migrate、`127.0.0.1:3010/login` 200 | 本机 curl 200 |
| **T-4** | 全量导入 + `--refresh` 差异为 0 + 重复条目处理 | 对账 0 差异 |
| **T-3** | 企微授权、群播报 dry-run、汇总表、生成器测通 | 四条 dry-run 全绿 |
| **T-2** | 重置密码 + 公告；nginx 改好但**先指旧上游**，`nginx -t` 通过 | 名单 7 人 |
| **T-1** | 备份 Flower 库 + flowers 库 + `/var/lib/flowers`；`healthcheck.sh` 跑一遍 | 备份 sha256 OK |
| **D0** | 见第 5 节 | 第 7 节全绿 |
| **D+1~D+3** | 每天看：登录失败、群播报、汇总表 failed、cron 日志 | 无新增 failed |
| **D+14** | Flower 与旧系统下线（单独批准 🔒）；`/opt/flower` 保留只读归档 | 备份留档 |

## 5. D0 切换（分钟级）

```bash
# T+0  冻结：Flower 挂维护页（或停容器），群里通知「切换中，约 20 分钟」
ssh dogyun 'docker stop flower-flower-1'

# T+2  最后一次增量（Flower 已停写，差异应当是 0 或只有我刚才改的几条）
cd /opt/flowers && npx tsx scripts/migrate-flower.ts --refresh            # 看差异
cd /opt/flowers && npx tsx scripts/migrate-flower.ts --refresh --apply    # 写回去

# T+6  账号重置（如果 T-2 没做）
cd /opt/flowers && npx tsx scripts/reset-passwords.ts --apply

# T+8  对账：总数 / 状态分布 / 待排期条数 / 抽样 20 条
npx tsx scripts/migrate-flower.ts --apply          # 新行（幂等，只会补缺）
# 不过就回滚（第 6 节第一档）

# T+12 切上游：改 /etc/nginx/conf.d/80-flower.conf 两处 -> 172.19.0.1:3010
ssh dogyun 'docker exec edge-nginx nginx -t && docker exec edge-nginx nginx -s reload'

# T+14 自检
ssh dogyun '/opt/flowers/scripts/healthcheck.sh'

# T+18 真业务：认领一条需求 → 群里应出现「需求认领」；跑一次 --tick 看状态推进
cd /opt/flowers && npx tsx scripts/wecom-dispatch.ts --tick --dry-run

# T+22 汇总表 / 群播报
cd /opt/flowers && npx tsx scripts/sheet-sync.ts
cd /opt/flowers && npx tsx scripts/group-dispatch.ts --dry-run

# T+35 群里发「已切换」；Flower 保持停止但镜像与数据卷不删
```

## 6. 回滚

| 触发 | 动作 | 耗时 |
|---|---|---|
| T+8 对账不过（还没切 nginx） | `docker start flower-flower-1`，什么都不用改 | 2 分钟 |
| 已切 nginx、还没人写数据 | `80-flower.conf` 两处改回 `flower:3000` → `nginx -s reload`；启动 Flower 容器 | 5 分钟 |
| 已有人写数据 | 先备份 flowers 库（**这段数据回不去**），再改回上游 | 15 分钟 |
| flowers 自身故障 | `systemctl restart flowers`；仍不行则恢复库 + `/var/lib/flowers`，同时可临时指回 Flower | 20 分钟 |

切域名后写进 flowers 的数据**没法回灌 Flower**——它读不懂 flowers 的事件流。

## 7. 验收清单

- [ ] `https://flower.dirctable.com/login` 200，证书有效，cookie 带 `Secure`
- [ ] 用邮箱 + 初始密码能登录；左轨有身份，顶栏有主题开关/铃铛
- [ ] 看板：默认 607 条（`?scope=all` 814），待排期 17 条
- [ ] 抽屉：六问、事件时间轴、动作按钮按状态正确（已上线有「回滚」）
- [ ] 认领一条 → 群里出现播报，`group_posts.status='sent'`
- [ ] `sheet-sync` 无 failed；汇总表 A 列能读到 `PAN-`
- [ ] `wecom-dispatch --dry-run` 能看到收件人与正文
- [ ] 生成器「测试」通过，能生成并打开一份材料
- [ ] MCP：`requirement_list` 用 token 调通
- [ ] 四条 cron 都在跑（三个日志各有新行）
- [ ] `healthcheck.sh` 退出码 0

## 8. 风险

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 账号登不进来 | 高 | 全员阻塞 | 统一初始密码 + 公告 + 首日值守 |
| `wecom-cli` 换机器要重新扫码 | 中 | 推送/汇总表全哑 | 不换机；T-3 先确认能扫 |
| 状态语义错位（Flower 11 态 → 我们 10 态） | 中 | 需求卡在错的列 | `--refresh` 逐条打印差异；抽样 20 条人工核 |
| PRD 文档树下线 | 高 | 评审找不到依据 | 导出只读归档 + `prd_url` 改写 |
| 3010 被公网扫到 | 低 | 绕过 nginx 限流/日志 | 安全组只开 80/443；ufw deny 3010 |
| 群播报刷屏 | 低 | 群里反感 | 水位机制；批量操作先 `--dry-run` |

## 9. 附：这次不迁的东西（明确写下来，免得切换后被当成 bug）

Flower 的 **迭代、PRD 文档与修订、任务与工时、跟进/阻塞、多组织与权限矩阵、操作日志、
Excel 导入、AI 预审与日报生成**——flowers 没有对等物，也不打算有。切换意味着这些能力
下线；需要留档的，在 T-4 之前导出成静态文件。
