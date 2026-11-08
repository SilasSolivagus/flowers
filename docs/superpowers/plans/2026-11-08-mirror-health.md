# 镜像新鲜度变主动（2026-11-08）：把「代码停在哪天」从日志搬进库，再变成一条通知

三环链：**服务器 cron 抓 → Mac 索引 → 材料写快照**。这一轮修的是「第三环之前」的那件事：
第一环坏掉时，没有任何东西会说话。

## 0. 结果速览

| 项 | 结果 |
|---|---|
| 新表 | `mirror_health`（迁移 `0031`，一仓一行） |
| 写入口 | `scripts/index-nightly.ts` 每处理完一个仓 upsert 一行（失败也写） |
| 判据 | `ok = false`，**或** HEAD 的提交日期距今 **> 7 天**（上海日历日） |
| 通知 | 新事件 `mirror.stale`（`requirement_id = null`）→ 读模型扇出给超管 |
| 去重 | 每仓每天最多一条（`payload.day` + `advisory lock`，锁按仓） |
| 真实一轮 | 三个仓全部 `ok = true`；`123pan-cross-frontend` 停在 2026-10-21（**18 天前**）→ **写出一条通知** |
| 用例 | `tests/mirror-health.test.ts` 12 条；全量 `67 files / 1458 passed / 1 skipped` |
| 门禁 | `npx vitest run` ✅、`npx tsc --noEmit` ✅、`npm run build` ✅ |

## 1. 表（迁移 0031）

```sql
mirror_health (
  repo        text primary key,
  head_sha    text,
  head_date   timestamptz,      -- 提交日期，不是检查时刻
  checked_at  timestamptz not null default now(),
  ok          boolean not null,
  error       text              -- ok = false 时的中文原因
)
```

两条语义是这张表存在的全部理由：

1. **`head_date` 是提交日期，不是检查时刻。** 两列必须分开：`checked_at` 每次覆盖，
   `head_date` 只在**真的前进**时变。「今晚跑过了、但拉到的代码和上周一样」必须看起来像
   **旧**——合成一列的话，这一层就白建了。
2. **失败不清空 `head_sha` / `head_date`。** 写入口用
   `coalesce(excluded.head_sha, mirror_health.head_sha)` 保留上一次已知值：一个 ssh 连不上
   的夜里，读者仍要能说出「它停在 2026-10-21」——那是通知正文里最有用的一半。

写入口只有一处（`src/core/codemirror/health.ts` 的 `recordMirrorHealth`），由夜间索引器在
**每个仓**处理完之后调用：

| 这一轮发生什么 | `ok` | `head_sha` / `head_date` | `error` |
|---|---|---|---|
| 正常同步完 | `true` | 本轮 HEAD | `null` |
| `head()` 失败（ssh/DNS/git 报错） | `false` | 传 `null` → **保留旧值** | 中文原因 |
| 仓是空仓（还没有提交） | `false` | 传 `null` → 保留旧值 | 「镜像仓库还没有任何提交」 |
| `index-sync` 失败 | `false` | 本轮 HEAD（读到了） | stderr 尾巴 |

## 2. 触发规则

对**当前配置里的每个仓**（`app_settings.code.mirror.repos` 的 `id`，不是表里的行）：

```
报 = (ok = false) or (head_date≠null 且 days > 7)
其中 days = 上海日历日的「今天」- HEAD 提交日期
```

三处刻意的口径：

- **严格大于 7**（`MIRROR_STALE_DAYS = 7`）：第 7 天不报，第 8 天报。与 `locate/copy.ts`
  的 `age > SNAPSHOT_STALE_DAYS` 同一个习惯，读代码的人不用猜边界属于哪边。
- **判头部日期，不判 `ok`**：健康但旧（cron 好好跑着、上游这段时间就是没有提交）**照样报**。
  owner 关心的是「我看的代码是旧的」，不是「同步过程有没有报错」。这是本项最容易被写歪的
  一格——只报失败会漏掉最常见的那种旧。
- **判「配置里的仓」，不判「表里的行」**：从配置里删掉的仓会留下一条陈旧行，按行遍历会
  让它永远报警；而**配了却一行都没有**的仓（索引器从没成功跑到它）恰恰是最该报的那类静默
  失败 → 按「未知」报一条，不跳过。

**未知（表里没有这个仓）＝ 报一条**，理由：这一项要修的失败形态就是「什么都没发生、也没人
知道」。`mirror_health` 里没有行只有一个来源——夜间索引一次都没成功跑到这个仓（配置刚加、
索引器在写它之前崩了、库写失败）。跳过等于把「从没跑过」当成「没问题」。代价可控：一天一条，
而且真跑成一次之后它自己就消失了。

门槛为什么是 7 而不是材料那个 14：材料是**被动**声明（每份材料都写「较旧」会变噪音），
通知是**主动**打断（在周末之前发现「这个仓一周没动了」）。两者不是同一个数，也不该是。

## 3. 渲染出来的两句话（逐字）

两半都在 `src/core/read/notify.ts` 的 `memberLineOf` 里，铃铛与企微**共用**这一份
（企微的抬头是 `memberHeadlineOf` → 「镜像新鲜度提醒」）。

**A. 同步失败（`error ≠ null`）**

```
123pan-cross-frontend 的镜像停在 2026-10-21（19 天前），上次同步失败：Could not resolve host: codeup
```

**B. 健康但旧（`error = null`）**——**不写**「上次同步失败：」这一截，改成

```
123pan-cross-frontend 的镜像停在 2026-10-21（18 天前），上游这段时间没有新提交
```

把一次成功的同步说成失败，会让人去修一个没坏的东西；而真正该做的是去问上游/研发「这个仓
两周没提交，对劲吗」。原因走既有的 `clip(…, 40)`（铃铛只有一行），超长会被截断。

两个退化形状：

- 从没读到过 HEAD（`head_date = null`，`error ≠ null`）：`<仓> 的镜像从来没有同步成功过，上次同步失败：<原因>`
- 表里一行都没有：`<仓> 的镜像还没有同步记录——夜间索引可能一次都没跑成`

## 4. 真实的一轮（`bash scripts/index-nightly.sh`，2026-11-08 10:24 +08）

索引器输出：

```
[123pan-pc] 3354b4a1 新内容 0 块（1988 ms）
[123pan-uni-app] 6ee08a14 新内容 0 块（1976 ms）
[123pan-cross-frontend] aefda585 新内容 0 块（1523 ms）
[123pan-cross-frontend] 镜像变旧：18 天前
exit=0
```

`mirror_health` 的内容（`select repo, head_sha, head_date, checked_at, ok, error`）：

| repo | head_sha | head_date | checked_at | ok | error |
|---|---|---|---|---|---|
| `123pan-cross-frontend` | `aefda5852304eeb0b475f87baa88263164babc4c` | 2026-10-21 16:25:31+08 | 2026-11-08 10:24:05+08 | `true` | `null` |
| `123pan-pc` | `3354b4a15aae1dd44753a767eeb91ebd3d076a66` | 2026-11-06 18:18:29+08 | 2026-11-08 10:24:01+08 | `true` | `null` |
| `123pan-uni-app` | `6ee08a142bd068e20cb69dddc6272ac5594ea81f` | 2026-11-06 18:18:15+08 | 2026-11-08 10:24:03+08 | `true` | `null` |

（`head_date` 在库里是 UTC：`2026-10-21T08:25:31Z` / `2026-11-06T10:18:29Z` / `2026-11-06T10:18:15Z`。）

**通知：写了 1 条。** `events` 里那一行：

```json
{"seq":900,"type":"mirror.stale","requirement_id":null,"actor":"system",
 "payload":{"repo":"123pan-cross-frontend","head_date":"2026-10-21","days":18,
            "error":null,"reason":"old","day":20765}}
```

超管（房超）的铃铛与企微候选各读到同一句：

```
铃铛：123pan-cross-frontend 的镜像停在 2026-10-21（18 天前），上游这段时间没有新提交
企微：镜像新鲜度提醒 | 123pan-cross-frontend 的镜像停在 2026-10-21（18 天前），上游这段时间没有新提交
```

夜间日志收尾多了一行 `(health)`（不加这一行，「检查跑过没有」又只活在 stdout 里）：

```json
{"ts":"2026-11-08T02:24:05.645Z","repo":"(health)","newBlobs":null,"ms":80,"error":"已提醒 123pan-cross-frontend"}
```

**这一轮同时也是「B 类文案」的实证**：三个仓都 `ok = true`（服务器这一晚是好的），只有
cross-frontend 旧，正文因此**不带**「上次同步失败」——如果实现只按「失败」报，这一晚一条
都不会有，而那正是 owner 最想被提醒的那一晚。

## 5. 变异表（用例逐条钉住的）

| # | 改动 / 输入 | 期望 | 用例 |
|---|---|---|---|
| 1 | `ok=false` + 原因 + 19 天前的 HEAD | 1 条，正文含原因；同日再跑 → 仍 1 条 | `ok = false → 一条…` |
| 2 | 健康，HEAD 8 天前 | 1 条，**不含**「上次同步失败」，含「上游这段时间没有新提交」 | `健康但 8 天前` |
| 3 | 健康，HEAD 6 天前 | 0 条 | `健康且 6 天前` |
| 4 | 健康，HEAD **正好 7 天** | 0 条（`> 7`）；挪到 8 天 → 1 条 | `正好 7 天` |
| 5 | 表里没有这个仓 | 1 条（`reason = unknown`），正文「还没有同步记录」；再跑 → 0 条 | `表里没有这个仓` |
| 6 | 两个仓同时旧 | 2 条（去重按仓，不是全局一条） | `两个仓同时旧` |
| 7 | 从没读到过 HEAD 且失败 | 正文「从来没有同步成功过，上次同步失败：…」 | `失败且一次都没读到 HEAD` |
| 8 | 失败写回时 `headSha/headDate = null` | 旧 sha / 日期**不丢**，`ok`/`error` 刷新；正文仍能说「停在 X（19 天前）」 | `失败不抹掉上一次已知的 HEAD` |
| 9 | 成功写回 | 覆盖成新 sha / 日期；前进之后不再报 | `成功写回` |
| 10 | `judgeMirror` 纯函数五格（失败/旧/新/第 7 天/未知） | 与上表同一个答案，不连库也能钉 | `judgeMirror：判定表` |
| 11 | 扇出 | 超管收到；PM 收不到；企微候选同一批（同 `addressed`）、`requirementId = null`、抬头「镜像新鲜度提醒」 | `扇出：只有超管收` |
| 12 | 事件分类 | `EVENT_CLASS['mirror.stale'] === 'action'`（默认档 `key` 也能看到） | `事件分类` |

`tests/notify-channels.test.ts` 的那个扫描器（扫源码里 `EVENT_… = '…'` 字面量并要求与
`EVENT_CLASS` 的键**相等**）自动把 `mirror.stale` 收进来了——所以「加了事件忘了分类」这条
用例仍然会红。

## 6. 它还是抓不到什么

按「离得越远越不知道」排：

1. **抓取「成功」但抓到的是旧 ref。** `git fetch` 退出 0、`update-ref` 也 0，但上游凭据
   悄悄失效成只读镜像源、或 cron 里 fetch 的 refspec 写错，服务器日志是 `OK … moved=0`。
   这时 HEAD 日期不变 → 本功能**只会在第 8 天**说「上游这段时间没有新提交」——一句**错的
   原因**（真相是「我们抓错了东西」）。要抓它，服务器那一侧必须**自报**：每次同步写一行
   `sync_heartbeat(host, at, upstream_sha, moved, rc)`，Mac 侧比对「上游看到的 sha」与「本地
   镜像 HEAD」，不一致就是抓错了。这需要服务器把状态交出来（现在它只写日志）。
2. **上游凭据/权限失效但退出码 0 的路径**（同上一条的另一半）：`fetch` 打到的是一个 302
   登录页或空仓镜像。判据同样是「服务器报的 upstream_sha」，不是「HEAD 有多旧」。
3. **索引器自己停摆，但镜像很新。** 判据只看 `head_date`：launchd 挂了、Mac 三天没醒，
   而服务器每天都在抓——`head_date` 是新的，这三天里没人知道索引没跑。要抓它，得加一条
   「`checked_at` 超过 N 小时」的判据（表里已经有这一列，缺的只是一个触发）。
4. **材料那一刻的诚实性。** 这一层保证「旧了会被说」，但不保证「材料上的日期是生成那一刻
   的」，更不保证「说完之后有人去修」。`mirror.stale` 是提醒，不是自愈。

## 7. 验证命令与结果

```
npx vitest run        → 67 files / 1458 passed / 1 skipped (1459)；新增 tests/mirror-health.test.ts：12 passed
npx tsc --noEmit      → 无输出（0 error）
npm run build         → exit 0（7 条路由，静态页 6 页生成通过）
bash scripts/index-nightly.sh → exit 0；3 行 mirror_health + 1 条 mirror.stale
```

没有重灌演示库（不跑 `restore-demo.sh`、不 `git clean`）：这一轮的全部写入都是 `mirror_health`
的三行 + 一条事件，其余表没动。
