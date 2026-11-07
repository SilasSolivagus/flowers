# 数据守卫（P2）：让「错的命令」删不掉 803 条迁移需求

- 日期：2026-11-07
- 起点：`main` @ `745ce6f`
- 主题：**一条错的命令不能毁掉数据。** 这是同一类缺陷的第三处（前两处：`mergeHistory`
  吞掉退出码、`ensureHistory` 的部分写入）。
- 结论：`flowers` 现状 **815 条需求（803 条 `legacy_ref` 非空）**、`commit_history`
  **657 行**，本轮改动后逐项复验，一行未少（见 §6）。

## 0. 五个入口的共同点

`resetDb` 本身早就有「库名」守卫（`src/db/reset.ts`：测试进程只许清 _test 库）。
本轮补的是它**下游**的五个洞——每一个都能在守卫之后、或者干脆绕开守卫，把数据带走：

| # | 入口 | 风险 | 本轮处置 |
|---|---|---|---|
| 1 | `npm run seed -- --reset` / `/tmp/restore-demo.sh` | truncate 掉全部 803 条并重编号 | seed.ts 里加迁移数据守卫（第二个开关才放行） |
| 2 | `tests/auth.test.ts:913`、`tests/helpers/schema.test.ts:7` 的裸 `truncate members cascade` | cascade 递归到 requirements 等表，删在守卫之前 | 改走 `truncateMembersOnly()` / `resetDb()` |
| 3 | `npm run db:test:setup` | 库名不对也照跑迁移，往真库里建表 | 加 `_test` 形状检查（中文拒绝） |
| 4 | 缺 `flowers_test` 时裸 `3D000` | 一屏红看起来像代码坏了 | 翻译成「先跑 npm run db:test:setup」 |
| 5 | `resetDb` 只清 11/16 张表 | 残留跨用例感染 | 四张写进清单；`code_index` 判定留下（附实测依据） |

## 1. Item 1：`--reset` 的第二道门

**做法**：`scripts/seed.ts` 的 `--reset` 分支里，在 `assertSafeToReset()`（库名）之后、
`resetDb()`（truncate）之前，插入 `assertNoMigratedRequirements({ force, database })`。

**谁是最后一道门、为什么在这里**：

- `/tmp/restore-demo.sh` 不进版本库——换台机器就没了、也没人 review 它的 diff。把唯一的
  守卫放在那里等于把门建在库外。所以实现放在 `src/db/reset.ts`（会被提交、会被读到、会被
  用例钉住），**调用点必须在 `seed.ts`**，因为那是唯一带着 `--reset` 走进 `resetDb` 的
  脚本入口。
- 顺序也是刻意的：先判库名（配置错 → 立刻停，连 count 都不查），再判迁移数据（库对、
  但里面是 803 条真数据 → 拒绝）。两道都不走到 `resetDb`。

**判据**：`select count(*) from requirements where legacy_ref is not null`。迁移脚本每条都写
`legacy_ref`（旧系统主键），演示种子 12 条一律为 null——数这一列正好等于数真数据，不需要
维护「哪些是演示」的名单（名单会漂，列不会）。

**第二个开关**：`--reset --force-with-migrated` 或 `FLOWERS_WIPE_MIGRATED=1`。两个参数/一个
专门的变量名，才叫「决定」，一个参数只叫「手滑」。放行时先把要删的条数打出来。

**拒绝文案（原文，含数量与下一步）**：

> 拒绝重置：库「flowers」里有 803 条从旧系统迁移来的需求（legacy_ref 非空）。--reset 会
> truncate requirements … restart identity cascade，把这 803 条连同它们的历史一起删掉，编号
> 也会从 1 重新开始；而迁移不会自己回来（重跑迁移会覆盖人工修正过的那部分）。确实要清空
> （例如只要一屏演示数据），请显式加上第二个开关——一次是命令，两次才是决定：
> npm run seed -- --reset --force-with-migrated（或 FLOWERS_WIPE_MIGRATED=1）。只想刷新演示
> 数据、保留迁移数据，请跑 /tmp/restore-demo.sh 的安全路径。

**为什么是拒绝而不是「半清」**：`--reset` 的语义是「从空库重灌 12 条」，它对 requirements
是 `truncate … restart identity cascade`（连编号回 1）。半清（只清 members 或只清 events）会
留下一张「有 803 条真需求、成员被换掉、编号还接着涨」的库，比拒绝更难发现。

**测试**（`tests/reset.test.ts` → `Item 1`）：子进程跑**整条命令**（不是只测纯函数），
断言退出码非 0、文案含「1 条」与 `--force-with-migrated`，并且 before/after 的
`(总, 迁移)` 完全相等。

**恢复代价（必须知道）**：`resetDb` 的清单里有 `commit_history`（657 行）与 `locate_runs`。
所以 `--force-with-migrated` 删掉的不止 803 条需求。重建路径：
`npx tsx scripts/index-history.ts --repo 123pan-pc --repo 123pan-uni-app`（走 ssh 镜像，
pc 侧全量约 16 秒）；`code_index` 不在清单里，不受影响。

## 2. Item 2：裸 truncate 归零

两处直接对 `members` 做 `truncate … cascade`，而 `cascade` 会顺着外键递归到
`requirements.owner_member_id`、`review_assignments`、`notification_reads`、
`notify_deliveries`、`mcp_tokens`、`uemaster_*`。也就是说 `TEST_DATABASE_URL` 一旦指到
`flowers`，803 条会在这两个用例的 beforeAll/正文里被删掉，**比任何守卫抛错都早**。

- `tests/helpers/schema.test.ts`：beforeAll → `resetDb()`。
- `tests/auth.test.ts:913`（「一个成员都没有 → no_member」）：→ `truncateMembersOnly()`。

`truncateMembersOnly()` 是 `src/db/reset.ts` 新加的**窄门**：它要「只清一张表」这个窄动作，
但用的是与 `resetDb` **同一把锁**（同一个 `resetRefusal`）。破坏性 SQL 只有一道门，门上
只有一把锁；`ResetOptions` 的 `guardDatabase` 注入口让这把锁能被用例钉住而不必造假库。

**测试**：①`guardDatabase: 'flowers'` + `env={VITEST:'true'}` → 抛错且「哨兵」成员还在；
②真把 `TEST_DATABASE_URL` 指到 `flowers`，用子进程探针 `tests/fixtures/reset-guard-probe.ts`
调 `assertSafeToReset()` —— 断言打印 `REFUSED`。

探针**只读 `current_database()`、从不 truncate**：这条变异因此是安全的——守卫若被拆，探针
只会打印 `ALLOWED`（用例红），不会真的删掉演示库。

## 3. Item 3：`db:test:setup` 的库名形状

`scripts/db-test-setup.ts` 里两道检查，问的是两件事：

1. `SAFE_DATABASE_NAME`（原有）：能不能拼进 `create database "…"` 的标识符位置。
2. `testDatabaseShapeRefusal(database)`（本轮）：**该不该在这张库里建表**。

**为什么需要第二道**：`TEST_DATABASE_URL=…/flowers` 时这条命令会当着真数据的面跑迁移。
它不删行，所以没有任何守卫会响；但演示库里凭空长出一批测试用的表、迁移历史被写进去，
等有人往里灌数据才发现这张库早被测试改过——比删数据更难发现。拒绝文案点名
`TEST_DATABASE_URL` 与默认落点 `flowers_test`。形状正则提到 `src/db/url.ts`
（`TEST_DATABASE_SHAPE`），`reset.ts` 与脚本共用一份，避免「一处放行、一处拒绝」。

## 4. Item 4：`3D000` 说人话

新克隆 → `npm run db:up` → `npx vitest run`，第一个用例死在裸 pg
`database "flowers_test" does not exist`。真实原因只有一个：没跑 `db:test:setup`。

- `src/db/url.ts` 的 `missingDatabaseRefusal(database)`：`测试库 flowers_test 不存在，先跑
  npm run db:test:setup`（附带一句「TEST_DATABASE_URL 指错了就先改对」）。
- `src/db/preflight.ts` 的 `assertDatabaseReachable(env)`：连一次库，**只翻译 3D000**；
  连接被拒、口令错、主机不可达一律原样抛（那不是「忘了 setup」，编一句话只会误导）。
- `tests/global-setup.ts` + `vitest.config.ts` 的 `globalSetup`：整轮只敲一次门，打印
  `测试库：flowers_test`。
- `scripts/db-test-setup.ts` 的 migrate 也映射 3D000（建库连维护库、迁移连目标库，
  主机不一致时会撞上）。

## 5. Item 5：五张表的去留

先实测（`flowers_test` 里各插一行，跑 `resetDb()`，再数）：

| 表 | 外键 | 跑前 | 跑后 | 判定 |
|---|---|---|---|---|
| `uemaster_artifacts` | → requirements | 1 | 0 | 写进清单（原来是靠 cascade） |
| `uemaster_jobs` | → requirements, uemaster_artifacts | 1 | 0 | 同上 |
| `uemaster_job_attempts` | → uemaster_jobs (cascade) | 1 | 0 | 同上 |
| `mcp_tokens` | → members | 1 | 0 | 同上 |
| `code_index` | **无** | 1 | **1** | 留下（附注释与收口人） |

「以前没人管」的四张其实一直被 `truncate … cascade` 顺带清掉，但那是**借来的**：哪天外键
改成 `set null`、或只 truncate members 不 truncate requirements，行就静默留下。现在写进
`RESET_TABLES`（`resetDb` 的 SQL 由这个常量 `sql.raw` 拼出，清单即 SQL），是声明而不是继承。

`code_index` **故意留下**：无外键、cascade 带不到；演示库那 32 行是真实结构索引（123pan-pc /
123pan-uni-app 的真实 sha），重建要跑 `scripts/index-repo.ts` 逐 sha 扫 ssh 镜像——一次
「重灌演示数据」不该付这笔账。它的泄漏由唯一用户 `tests/index.test.ts` 自己收口
（beforeAll / afterAll 按 fixture 仓名 `dropIndex`）。`KEPT_TABLES` 常量把这个判断写进代码。

## 6. 变异表（每一条都实跑过：改坏 → 红 → 还原）

| # | 变异 | 命中用例 | 结果 |
|---|---|---|---|
| M1 | `seed.ts` 删掉 `assertNoMigratedRequirements(...)` 调用 | Item 1「--reset 拒绝」 | **红**（`expected +0 not to be +0`，子进程退出码 0） |
| M2 | `truncateMembersOnly` 删掉 `resetRefusal` 判断 | Item 2「守卫以为库是 flowers」 | **红**（哨兵成员被清） |
| M3 | `assertSafeToReset` 删掉 `resetRefusal` 判断 | Item 2「TEST_DATABASE_URL 指到 flowers」 | **红**（探针打印 `ALLOWED`） |
| M4 | `testDatabaseShapeRefusal` 改成永远返回 null | Item 3 两条 | **红** |
| M5 | `preflight.ts` 删掉 3D000 映射 | Item 4「库不存在」 | **红**（抛 pg 原文） |
| M6 | `RESET_TABLES` 去掉 `mcp_tokens` | Item 5「清单本身就是声明」 | **红** |
| M7 | `RESET_TABLES` 加上 `code_index` | Item 5「code_index 按设计留下」 | **红**（`code_index: 0`） |
| M8 | `RESET_TABLES` 去掉四张显式表（保留外键） | Item 5 | **绿（记录在案）**：cascade 仍会清——正因如此，Item 5 的「留下/清掉」判断由 M6/M7 那种**清单断言**钉住，而不是只靠行为断言 |
| M9 | `resetDb` 清单去掉 `members`（保留 `mcp_tokens` 显式项） | Item 5 | **绿一起（记录在案）**：显式项替代了 cascade 路径——M6 才是这条的变异 |

## 7. 新的 `/tmp/restore-demo.sh`（全文，便于重建）

```sh
#!/bin/sh
# /tmp/restore-demo.sh —— 刷新 flowers 的演示数据（安全路径）
#
# 背景（2026-11-07）：库里现在有 803 条从旧系统迁移来的真需求（legacy_ref 非空），
# 而 `npm run seed -- --reset` 会对 requirements 做 truncate … restart identity cascade。
# 这个脚本以前就是那一句话，按一次等于删掉 803 条真数据 + 657 行 commit_history。
#
# 现在它先打印「要动什么」，默认**不清空**有迁移数据的库；
# 要真的清空重灌，必须再显式给一个变量：FORCE_WIPE_MIGRATED=1。
set -eu

cd /Users/silas/flowers

DB_NAME="${DB_NAME:-flowers}"
PSQL_T="docker exec -i flowers-db-1 psql -U postgres -d ${DB_NAME} -q -t -A"
LOG=/tmp/restore-demo-seed.log

echo "== restore-demo =="
echo "目标库：${DB_NAME}（$(docker exec -i flowers-db-1 psql -U postgres -d "${DB_NAME}" -q -t -A -c 'select current_database()')）"

COUNTS=$($PSQL_T -c "select count(*) || '/' || count(legacy_ref) from requirements")
TOTAL=${COUNTS%%/*}
MIGRATED=${COUNTS##*/}
DEMO=$((TOTAL - MIGRATED))

echo "现状：requirements 共 ${TOTAL} 条 = 演示 ${DEMO} 条 + 迁移 ${MIGRATED} 条（legacy_ref 非空）"
echo "       commit_history $(docker exec -i flowers-db-1 psql -U postgres -d "${DB_NAME}" -q -t -A -c 'select count(*) from commit_history') 行，code_index $(docker exec -i flowers-db-1 psql -U postgres -d "${DB_NAME}" -q -t -A -c 'select count(*) from code_index') 行（reset 不清它）"

if [ "$MIGRATED" -gt 0 ] && [ "${FORCE_WIPE_MIGRATED:-0}" != "1" ]; then
  echo
  echo "→ 跳过 npm run seed -- --reset：它会把上面那 ${MIGRATED} 条真数据连编号一起 truncate 掉。"
  echo "→ 只做非破坏性的部分：app_settings（provider / 镜像配置）与 PAN-6 的 prd_url。"
  if [ "$DEMO" -eq 0 ]; then
    echo "   注意：这张库里已经没有演示需求了（DEMO=0），本次不会凭空造回来。"
    echo "   要重灌 12 条演示需求、并接受删掉 ${MIGRATED} 条迁移数据 + 657 行 commit_history，显式跑："
    echo "     FORCE_WIPE_MIGRATED=1 $0"
  fi
  MODE=skip
else
  if [ "$MIGRATED" -gt 0 ]; then
    echo
    echo "→ FORCE_WIPE_MIGRATED=1：即将删除 ${MIGRATED} 条迁移需求、657 行 commit_history、"
    echo "  locate_runs 与 code_index 之外的其余 15 张表，然后重灌 12 条演示需求。不可撤销。"
    echo "→ 执行：npm run seed -- --reset --force-with-migrated"
    MODE=force
  else
    echo
    echo "→ 库里没有迁移数据：执行 npm run seed -- --reset（清空 15 张表后重灌 12 条演示需求）"
    MODE=reset
  fi
fi

case "$MODE" in
  skip) echo ;;
  force)
    if npm run seed -- --reset --force-with-migrated 2>&1 | tee "$LOG" >/dev/null; then
      echo "   seed 完成（日志 ${LOG}）"
    else
      echo "   seed 失败，尾部日志："; tail -20 "$LOG"; exit 1
    fi ;;
  reset)
    if npm run seed -- --reset 2>&1 | tee "$LOG" >/dev/null; then
      echo "   seed 完成（日志 ${LOG}）"
    else
      echo "   seed 失败，尾部日志："; tail -20 "$LOG"; exit 1
    fi ;;
esac

echo "→ 写 app_settings 与 PAN-6 的 prd_url（按 key 覆盖，不碰需求内容）"
docker exec -i flowers-db-1 psql -U postgres -d "$DB_NAME" -q <<'SQL'
insert into app_settings (key,value) values
 ('provider.baseUrl','https://api.deepseek.com/v1'),
 ('provider.model','deepseek-flash'),
 ('provider.apiKey','<原值不变：见本机 app_settings；报告不重复抄写密钥>'),
 ('code.mirror.transport','ssh'),
 ('code.mirror.sshHost','dogyun'),
 ('code.mirror.repos','[{"id":"123pan-pc","path":"/srv/123pan-mirror/123pan-pc.git"},{"id":"123pan-uni-app","path":"/srv/123pan-mirror/123pan-uni-app.git"},{"id":"123pan-cross-frontend","path":"/srv/123pan-mirror/123pan-cross-frontend.git"}]')
on conflict (key) do update set value=excluded.value;
update requirements set prd_url='https://doc.weixin.qq.com/doc/w3_AW4A1gbtAKYCNrNKOiCOyR7ykQKyF' where number=6;
SQL

AFTER=$($PSQL_T -c "select count(*) || '/' || count(legacy_ref) from requirements")
echo "完成（模式 ${MODE}）：requirements 现在是 ${AFTER}（总/迁移），commit_history $(docker exec -i flowers-db-1 psql -U postgres -d "${DB_NAME}" -q -t -A -c 'select count(*) from commit_history') 行"
```

> 与本机唯一的差异：第 54 行 `provider.apiKey` 的实值。它在
> `/tmp/restore-demo.sh` 与 `app_settings` 表里都在；本报告有意不把密钥抄进版本库。
> 重建时把那一条换回 `('provider.apiKey','<原值>')` 即可，其余行一字不差。

## 8. 两条命令

**(a) 安全刷新演示数据（保留 803 条迁移数据 + 657 行历史）**

```sh
/tmp/restore-demo.sh
# 输出会先说明：跳过 seed --reset，只覆盖 app_settings 与 PAN-6 的 prd_url；
# 末尾打印 requirements（总/迁移）与 commit_history 行数，方便当场核对。
```

**(b) 故意清空迁移数据（不可撤销）**

```sh
FORCE_WIPE_MIGRATED=1 /tmp/restore-demo.sh
# 等价于：
#   npm run seed -- --reset --force-with-migrated
# 会删掉 803 条迁移需求 + 657 行 commit_history，重灌 12 条演示需求，编号从 1 开始。
# 事后要恢复历史索引：
#   npx tsx scripts/index-history.ts --repo 123pan-pc --repo 123pan-uni-app
#   npx tsx scripts/index-repo.ts --repo 123pan-pc            # code_index 不受影响
```

## 9. 验证记录

```
$ npm run seed -- --reset                 # 在 flowers 上
种子中断：Error: 拒绝重置：库「flowers」里有 803 条从旧系统迁移来的需求（legacy_ref 非空）…
exit=1

$ TEST_DATABASE_URL=…/flowers npm run db:test:setup
拒绝初始化测试库：库名「flowers」里没有 _test，不像一张测试库。… TEST_DATABASE_URL … flowers_test
exit=1

$ /tmp/restore-demo.sh                    # 安全路径
现状：requirements 共 815 条 = 演示 12 条 + 迁移 803 条（legacy_ref 非空）
       commit_history 657 行，code_index 32 行（reset 不清它）
→ 跳过 npm run seed -- --reset：它会把上面那 803 条真数据连编号一起 truncate 掉。
完成（模式 skip）：requirements 现在是 815/803（总/迁移），commit_history 657 行

$ npx vitest run
Test Files  47 passed (47)
     Tests  1234 passed | 1 skipped (1235)

$ npx tsc --noEmit
（无输出）

$ docker exec -i flowers-db-1 psql -U postgres -d flowers -tA \
    -c "select count(*), count(legacy_ref) from requirements" \
    -c "select count(*) from commit_history"
815|803
657
```

## 10. 未做 / 仍然存在的风险

1. `--force-with-migrated` 与 `FLOWERS_WIPE_MIGRATED=1` 仍是同一个人的两次按键；它挡的是
   「反射式手滑」，不是「恶意」。真要更强的保证得靠备份（`pg_dump` 到库外），本轮没做。
2. `code_index` 依赖 `tests/index.test.ts` 自己收口。若哪天有人在别处写 `code_index` 行，
   泄漏会跨用例——那时应给它一条廉价的重建路径，再考虑写进 `RESET_TABLES`。
3. `tests/global-setup.ts` 只在 vitest 里生效；`npm run db:migrate` / `db:test:setup` 各自
   有守卫，但别的自定义脚本若直连数据库仍会拿到裸 3D000。
4. `resetDb` 仍清 `commit_history`：这是测试需要（用例往里写行），代价是演示重灌要付一次
   重建。已写进 M1 的注释与 §1 的「恢复代价」。
