# tick 抗坏行：一条坏数据不许停掉全场

- 日期：2026-11-08
- 起点：`main` @ `5001a3b`
- 范围：`src/core/clock/tick.ts`（推进逻辑）、新增 `src/core/clock/skips.ts`（跳过提醒）、
  `src/core/notify/classes.ts`、`src/core/read/notify.ts`、`src/core/notify/dispatch.ts`、
  `scripts/wecom-dispatch.ts`、`tests/clock.test.ts`
- 没动：`src/core/locate/*`、数据守卫（`src/db/reset.ts` / `src/db/url.ts`）、迁移 `0024`

## 1. Bug：一行坏数据 = 全场停摆

`tick` 在一个事务里逐行推进 `ready → dev → test → live`，判定要读 `releases.window_start`、
`commit_test_at`、`commit_due_at`，并用 `assertHasRelease` / `deadlineDay` 在三格数据缺失
时**抛 `AppError`**。抛在事务里 = 整轮回滚：一条坏行让这一轮什么都没有发生。

这不是理论风险，它已经发生过一次：

- 迁移 `0024` 把 803 条迁入行搬进 `requirements`，它们**没有 `release_id`**；
- 于是 tick 从迁移那天起**一轮都没跑完过**：状态不推进、超时提醒不响、企微推送不发、
  企微绑定自愈永远轮不到（它排在 tick 之后）；
- 症状看起来只是「看板今天没动」——最坏的一种静默失败：系统停了，而日志里只有一条
  每 15 分钟重复的 `clock_missing_deadline`。

迁移后来把 34 条**缺日期**的行退回 `queue`，顺手清掉了当时的现场，**机制却完全没动**：
下一次导入、一次手改、某个写库旁路造出同样一行，整轮再停一次。

## 2. 裁定

**一条坏数据不许停掉全场。** 跳过它、记下它、继续，最后一并报账。

具体到实现，四件事各有落点：

| 要求 | 落点 |
|---|---|
| 坏行原样不动、继续下一行 | `tick.ts` 的 `judgeRow` 返回 `{ kind: 'skip' }`，循环里 `continue` |
| 记下**为什么** | `Skipped.reason` 中文一句：`没有排期版本` / `缺少提测日` / `缺少承诺完成日` / `<某日>不是有效时间`；`Skipped.field` 是机器可读那一半 |
| 一轮有跳过就报给超管，**每天最多一条** | `src/core/clock/skips.ts` 的 `notifySkipped`：写一条 `requirement_id = null` 的 `clock.tick_skipped` 事件（站内通知是 `events` 的投影，没有通知表），`pg_advisory_xact_lock` 里按 `payload.day` 去重——与企微绑定自愈的 `self-heal.ts` 完全同一套做法 |
| 返回值带跳过清单 | `tick(db, now): Promise<{ moved: Moved[]; skipped: Skipped[] }>`；`tickThenDispatch` 原样透传 |

**不是静默**（这一条是裁定的另一半）。一条被跳过的行在四个地方看得见：

1. `tick` 的返回值（测试、脚本、报告都读它）；
2. `scripts/wecom-dispatch.ts --tick` 的 stdout：`时钟推进：N 条需求前进了一步 · 跳过 M 条`
   以及逐行 `跳过 PAN-18（dev）：缺少提测日`（哪怕 0 条也打——「没有坏行」与「这项报告被
   删掉了」在日志里必须长得不一样）；
3. 超管铃铛里的一行 + 一条企微推送（`clock.tick_skipped` 归 `action` 类，默认档 `key` 也收）：
   ```
   时钟跳过 2 条需求（PAN-18、PAN-10）：缺少提测日 1 · 没有排期版本 1
   ——这几行的日期或排期版本坏了，不补就永远不会自己往前走
   ```
4. 看板卡片上的「缺提测日」红字（`read/board.ts` 的 `missingDeadlines`，上一个提交
   `5001a3b` 已经做了读侧那一半；这次补的是**钟侧**那一半）。

## 3. 哪些 throw 仍然致命（以及为什么）

「坏行」和「坏系统」不是一回事。只把**这一行数据**的两类 `AppError` 翻成跳过：

`clock_missing_deadline` / `clock_bad_deadline`，且只在 `assertHasRelease` 与
`deadlineDay` 两个调用点上（`isRowDataError`）。其余照旧整轮失败：

| 仍然致命 | 为什么 |
|---|---|
| `now` 是 Invalid Date / `shanghaiDayOf` 返回 null | 时钟口径本身坏了。此时所有比较都是 `false`，跳过一切会表现为「今天什么都没到点」——把最坏的一种静默失败包装成正常答案 |
| 取行 / `moveTo` / `recordEvent` 的数据库错误（连不上、SQL 错、死锁、`not_found`） | 与数据内容无关。跳过它等于把「库挂了」伪装成「今天没活」；而 tick 的一次推进必须原子（状态 + 事件 + `state_entered_at` 要么全写要么全不写） |
| `clockEdges()` 抛的 `clock_missing_deadline` | 状态机表里多出一条没有日期列的 clock 边——**代码/配置**问题，不是某一行。它在取行之前抛，跳过它会让时钟静默少一条边（这正是 `state-machine.test.ts` 那条等式用例存在的理由） |
| `assertTrigger(from, to, 'clock')` | 「这条边不该由时钟推进」说明表和实现对不上。硬推会写出状态机不承认的转移 |
| `notifySkipped` 自身的写失败 | 与数据库错误同类：那时什么也做不了，静默才是更坏的选择 |

## 4. 真实 tick（`flowers`，815 条需求）

`DATABASE_URL` 指向 `flowers`，跑 `tick(db, new Date())`（`npx tsx tmp-real-tick.mts`，
脚本用完即删，不入库）：

```
库：flowers（时钟状态行 5 条）
now：2026-11-07T22:08:41.370Z（14ms）        ← 北京 2026-11-08 06:08
推进：1 条
  PAN-12 dev → test
跳过：0 条
事件：861 → 862（本轮写 1 条）
clock.tick_skipped 提醒：之前 0 条，之后 0 条（本轮没有新建）
```

- **推进 1 条**：PAN-12 提测日 `2026-11-05`，今天 11-08，`dev → test`。这是 tick 合法的
  一次推进（`state_entered_at` 落在注入时刻，一条 `requirement.auto_test` 事件），也是这轮
  对真库**唯一**的改动。
- 其余 4 行都还没到点（PAN-7 开工日 11-14、PAN-8 提测日 11-09、PAN-9 完成日 11-10、
  PAN-11 完成日 11-13），不是跳过——「还没到点」与「推不动」在返回值里是两件事。
- **跳过 0 条、没有新建提醒**：说明 `0024` 之后真库里确实没有坏行了，这条路径不会自己
  冒出来打扰人。

### 4.1 同一套代码在有坏行时是什么样（真数据的克隆）

`flowers` 815 行的 `pg_dump` → `flowers_tickdemo`，注入两行（这就是迁移当时那种形状），
再跑同一个脚本：

```
推进：1 条
  PAN-12 dev → test
跳过：2 条
  PAN-18（dev，commit_test_at）：缺少提测日
  PAN-10（ready，release_id）：没有排期版本
事件：861 → 863（本轮写 2 条）                 ← 1 条 auto_test + 1 条 clock.tick_skipped
clock.tick_skipped 提醒：之前 0 条，之后 1 条
  #863 {"day":20765,"count":2,"numbers":[18,10],"more":0,
        "reasons":{"缺少提测日":1,"没有排期版本":1},
        "items":[{"number":18,"state":"dev","field":"commit_test_at","reason":"缺少提测日"},
                 {"number":10,"state":"ready","field":"release_id","reason":"没有排期版本"}]}
房超铃铛里的跳过提醒：1 条
  时钟跳过 2 条需求（PAN-18、PAN-10）：缺少提测日 1 · 没有排期版本 1
  ——这几行的日期或排期版本坏了，不补就永远不会自己往前走
```

同一天再跑一次（去重）：`推进 0 条 · 跳过 2 条`，事件数不变，提醒仍是 **1** 条。
克隆库用完即 `drop database`。

## 5. 变异表（先有实现，再把实现改坏，确认用例真的红）

每次只改一处、只跑 `tests/clock.test.ts`（27 条），改完立刻还原。

| # | 变异（把实现改回坏的样子） | 期望 | 实测 |
|---|---|---|---|
| M1 | `judgeRow` 两处 `if (!isRowDataError(error)) throw error;` → `throw error;`（= 恢复「整轮抛错」） | 坏行用例红，好行用例仍绿 | **8 红 / 19 绿**（27） |
| M2 | 删掉 `await notifySkipped(...)`（= 跳过但不报） | 提醒用例红 | **2 红 / 25 绿** |
| M3 | `notifySkipped` 里删掉 `if (await alertedOn(tx, input.day)) return;`（= 不去重） | 「同一天不翻倍」红 | **1 红 / 26 绿** |
| M4 | `return { moved, skipped: [] }`（= 跳过不进返回值） | skipped 断言红 | **6 红 / 21 绿** |
| M5 | `notifySkipped` 删掉 `if (input.skipped.length === 0) return false;`（= 干净的一轮也报） | 「干净一轮无提醒」红 | **1 红 / 26 绿** |

M1 是这次的核心：它红的正是那 8 条——包括「同一轮里别的行照常推进」那条（停摆的回归
用例），它只在「整轮抛错」时才会红。

## 6. 用例（`tests/clock.test.ts`：24 → 27 条）

「坏数据不静默跳过」那一组由 8 条改写成 9 条（原先是 6 条「必须抛错」+ 2 条纯函数），
再加 2 条去重 / 收件人用例；其余 15 条时钟用例一条没动。

| # | 用例 | 钉的是什么 |
|---|---|---|
| 1 | 待开发却没有版本 → 不推进、不抛，进 skipped 并带中文原因 | 坏行原样不动（状态、事件两条都查） |
| 2 | 同一轮里坏行被跳过，其它行照常推进 | **停摆回归**：M1 一改就红 |
| 3 | 开发中 / 测试中却没有版本 → 各自进 skipped | 版本检查对三个状态一视同仁，不会静默推到 live |
| 4 | 两类坏行（无版本 / 缺日期）都在 skipped 里，一轮照样跑完 | 一轮只写**一条**账（`count: 2`） |
| 5 | 测试中却没有承诺完成日 → 跳过，原因点名那一列 | 三个日期格各自可辨 |
| 6 | 干净的一轮：skipped 为空，也不写任何跳过提醒 | 不无中生有（M5 的靶子） |
| 7 | 有跳过的一轮：恰好一条提醒给超管，点名条数与编号，同一天再跑不翻倍 | 通知正文 + 去重（M2/M3 的靶子） |
| 8 | 跳过提醒只给超管，不发给 PM | 收件人 |
| 9 | 日期解析不出来 → 判定是「跳过这一行」（纯函数 `judgeRow`） | `clock_bad_deadline` 那一格：三列都是 `timestamptz`，真库写不进坏字符串，只能对判定入口钉 |
| 10 | `deadlineDay` 的三条文案不变 | 报错措辞仍然只在一个地方定义 |
| 11 | `tick` 的 now 非法 → 仍然致命 | 保留的致命项 |

（1–9 是改写/新增的那一组；10–11 是保留下来、指向判定入口与致命项的用例。）

## 7. 操作员现在会看到什么

| 场景 | 之前 | 现在 |
|---|---|---|
| 一行没有 `release_id` | 整轮抛 `clock_missing_deadline`，全场不动，日志里刷同一条错 | 这一行不动，其它行照常推进；铃铛里一行「时钟跳过 N 条需求（PAN-…）：没有排期版本 N」，每天最多一条；stdout 里逐行点名 |
| 一行 `dev` 缺提测日 | 同上 | 同上，原因写「缺少提测日」 |
| 数据都正常 | 正常推进 | 一模一样（`skipped: []`，不写提醒，不改任何既有语义） |
| 库挂了 / 状态机表被改坏 | 整轮抛 | **依旧整轮抛**——那不是「某一行数据坏了」 |

修法没有变：补日期走排期（`schedule`），补版本走排期窗口；`tick` 只报告、不修。

## 8. 验证

```
npx vitest run          → 55 files / 1309 passed | 1 skipped（1310）
npx tsc --noEmit        → 干净
真实 tick（flowers）     → 推进 1（PAN-12 dev→test）· 跳过 0 · 提醒 0（见 §4）
克隆上注入 2 行坏数据     → 推进 1 · 跳过 2（见 §4.1），同日重跑提醒不翻倍
```

真库状态（跑完 tick 之后）：`requirements` 815 行、`events` 862 行（+1 条合法的
`requirement.auto_test`）、`notify_deliveries` 0 行、`clock.tick_skipped` 0 行。
