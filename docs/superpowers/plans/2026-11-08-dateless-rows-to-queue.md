# 2026-11-08 裁定 6：缺日期的时钟状态退回「待排期」

分支 `main`（基于 `01c7fad`）。一条编号迁移、一处读模型警告、一组用例，没有表结构变化。

| 交付 | 文件 | 形状 |
|---|---|---|
| 迁移 | `src/db/migrations/0024_dateless_clock_states_to_queue.sql` + `meta/_journal.json` | 纯数据迁移：三条 `update ... set state='queue', state_entered_at=now()`，幂等 |
| 读模型警告 | `src/core/read/board.ts`（`missingDeadlines` / `BoardCard.missingDates` / `waitingFor`） | 缺哪几天就点名哪几天，`waitingOn` 仍是 `none` |
| 词表统一 | `src/core/clock/tick.ts`（`FIELD_LABEL` → 导出 `DEADLINE_LABEL`） | 卡片上的「缺提测日」与 tick 报错的「缺少提测日」是同一份词 |
| 用例 | `tests/dateless-to-queue.test.ts`（5）、`tests/read.test.ts`（6） | 迁移跑真文件两遍；警告删掉就红 |
| `schema.ts` | 一行没改 | 没有新列 / 新约束，drizzle 的 schema 与库仍然一致 |

---

## 1. 问题：一个没有日期的时钟状态是永久冻结，而且会让整轮 tick 抛出

`ready` / `dev` / `test` 三个状态**只由时钟推进**（`clock/tick.ts` 的 `clockEdges` 读
`releases.window_start` / `commit_test_at` / `commit_due_at`）。一条缺了驱动日期的行停在里面：

- 看板上位置完全正确、卡片看起来也正常；
- 但**永远动不了**：没有人欠它一个动作（`waitingOn: 'none'`），时钟也没有可比的日期；
- 它是「已排期但日期没填」，真实位置就是待排期。

更坏的一层在 `tick` 里：对缺日期的行它不是「跳过」，是**整次抛出**
（`deadlineDay`：「处于「开发中」但缺少提测日，无法自动推进」；
`assertHasRelease`：「处于「待开发」但没有排期版本」）。库里只要有一条这样的行，
同一轮 tick 里**所有**该推进的需求一起停住；而 `dispatch.ts` 的 `tickThenDispatch` 把
tick 排在推送与企微绑定自检之前，于是「一次数据缺口」等于「整条自动化管线停摆」。

执行前的 34 行**全部** `release_id` 为 null——意味着 tick 从第一条就抛
（`assertHasRelease` 在 `deadlineDay` 之前），那条早已到点的 `dev`/`test` 行（第 12 条提测日
11-05、第 9 条承诺日 11-10）也一直没被推走。这不是推测：`clock.test.ts` 已经把那两条
报错路径逐条钉住（`release_id = null` 与缺日期各一条）。

来源是历史：老系统没有这三个日期，Flower 的 `expected_date` 在 803 条迁移行里 801 条是
null。所以这 34 条不是「几个人漏填」，是一次**从未被排期**的状态被原样搬了进来。

---

## 2. 裁定与判据

owner 的口径：**一个状态的前提条件不成立，它就不是那个状态。** 没有日期的「开发中」
等价于「已排期但日期没填」——放回它真实所在的步骤。

只动**动不了**的行：

| 状态 | 判据 | 为什么是这一列 |
|---|---|---|
| `ready` | `commit_test_at is null` | 它的驱动日期是开工日，但走一步就改读提测日；提测日为空的 ready 只是「把冻结推迟一步」 |
| `dev` | `commit_test_at is null or commit_due_at is null` | 这一步读提测日、下一步读承诺完成日，缺一个都会在后面冻住 |
| `test` | `commit_due_at is null` | 唯一的驱动日期 |

`ready` 不看承诺完成日：从 ready 到 test 之间还有一次调度机会（dev 里能改日期），
把「还远着的缺失」也标出来只会让警告很快没人看。

两个刻意的取舍：

- **`state_entered_at = now()`**，不用 Flower 的时刻。0023 那 29 行用旧时刻是因为它们
  **状态没变过**（被 0021 误移）；这 34 行**今天真的重新进入待排期**，从这一刻起重新排队
  等一个日期。给它们盖上「在开发中停了 200 天」是假事实：那段停留没有人负责，也没有
  时钟读过它。
- **不碰 `release_id` 与三个日期列**。日期缺失是事实，补齐是排期的人要做的事，迁移不猜。

---

## 3. 迁移 0024

三条 `update` 分开写，只为一件事：`notice` 里说得出「每一类各移了几行」。守卫就是判据
本身（`state = 'dev' and (commit_test_at is null or ...)`），所以第二遍命中 0 行。
**不按 `legacy_ref` 点名**：那会把以后人工重新排期进来的行再拉回去；而这 34 行的全部
共同点就是「缺日期」，判据本身已经够了。

反过来，重复执行是安全而且**期望**的：若有人（脚本 / MCP / 直接写库）又把一条缺日期的
行推进 `dev`，再跑一次仍然把它放回待排期——这正是这条裁定要的口径。

### 不加 CHECK 约束（刻意）

`check (state <> 'dev' or commit_test_at is not null)` 看起来更彻底，但它有三处不合适：

1. 这条迁移本身就证明这种行**历史上存在**，加约束等于把历史判成非法（要么先修数据，
   要么约束建不上）；
2. 它拦不住真正的问题来源——`migrate-flower.ts` 这类一次性导入。导入撞上约束只会
   「全量导入跑不完」，或者被迫在导入里塞一个假日期（比缺日期更坏：假的日期会让时钟
   真的推进它）；
3. 真正该拦的地方是写入口，那里已经有门：`schedule` 缺任一个日期就报
   `missing_dates`（「排期必须填版本、提测日和承诺完成日」）。

所以这一轮的答案是「**看得见**」而不是「写不进」：读模型点名缺哪一天（第 4 节），
一条用例钉住那句话。

### 不写事件（与 0021 / 0023 同一条口径）

事件流的形状是「谁在哪一刻让它走到了哪一步」，而这 34 行没有任何人做过那个动作，
`actor` 写谁都错。说清这件事的只有本文件与迁移注释。

### 实测（2026-11-08 05:57 +08，`flowers` 库）

执行前：

```
select state, count(*) from requirements where state in ('ready','dev','test') group by 1
→ ready 19 · dev 16 · test 4
```

| 状态 | 行数 | 缺日期（移走） | 日期齐全（留下） |
|---|---|---|---|
| `ready` | 19 | **18** | 1（第 7 条） |
| `dev` | 16 | **14** | 2（第 8、12 条） |
| `test` | 4 | **2** | 2（第 9、11 条） |
| 合计 | 39 | **34** | 5 |

那 34 行：全部 `release_id` 为 null、全部有负责人、没有一行是软删除（软删除的行不动：
看板不显示它、tick 也不推进它，动它只是改写一条对外已不存在的历史）。

执行后：

```
select state, count(*) from requirements where state in ('ready','dev','test') group by 1
→ ready 1 · dev 2 · test 2
select count(*) from requirements where state = 'queue'  → 36（原 2 + 34）
select count(*), count(legacy_ref) from requirements      → 815 / 803（不变）
```

`state_entered_at` 抽检：34 行的都是 `2026-11-07 21:57:49Z`（= 11-08 05:57 +08）；
留下的 5 行时刻原封不动（11-01 / 11-03 / 11-06 / 11-07 的旧值）。

第二遍（手跑同一份文件）：`0024：退回待排期 0 条（ready 0 · dev 0 · test 0…）`，
且没有「仍有 N 条缺日期」的 warning——即迁移末尾那条不变量查询返回 0。

---

## 4. 读模型的警告：原来那句话诚实但不完整

**发现**：卡片本来就会在缺日期时写「缺开工日 / 缺提测日 / 缺承诺完成日」，`waitingOn`
也已经是 `none`（没人欠动作）。但判定用的是**当前状态的那一列**，于是：

- `ready` 只查开工日。一条版本还在、开工日还在、**提测日从来没填**的迁移行，卡片显示
  「等开工日 11-14」——看起来和一条正常排好的卡**一模一样**，直到开工日到了、被推进
  开发中，才第一次露出「缺提测日」。
- `dev` 只查提测日。只缺承诺完成日的卡显示「11-05 提测」，同样看起来正常。

也就是说：那句话本身是诚实的，但它答的是「今天卡在哪天」，而这一轮要回答的是
「它还差哪几天才走得完」。看板上那 18 条 ready 之所以被看见，是因为它们连版本都没有
（`window_start` 也为空）——纯属同一个原因碰巧同时成立。

**改法**（`board.ts`）：

- 新增 `missingDeadlines(row)`：`ready` → 开工日 + 提测日；`dev` → 提测日 + 承诺完成日；
  `test` → 承诺完成日；其它状态恒为空。日期列有值但解析不出来也算缺（`shanghaiDayOf`
  返回 null 的串在 tick 里同样会抛 `clock_bad_deadline`，那就等于没有这个日期）。
- 三个时钟状态共用一条前置判断：**缺任何一天就先说缺**，别说「在等哪天」。放在 `switch`
  外面只写一次，三个 case 里各写一次早晚会有一个忘掉。
- 卡片多一格 `BoardCard.missingDates: DeadlineField[]`（空数组 = 不缺）。`waiting` 那句话
  是**从这一格拼出来的**（「缺」+ 词表），不是另写的字符串——否则把这一格清空、留一个
  写死的字符串也能过用例，那样什么都没钉住。
- 词表复用 `clock/tick.ts` 导出的 `DEADLINE_LABEL`：卡片说「缺提测日」与 tick 报「缺少
  提测日」是同一个日期，两处各抄一份词迟早会对不上。

**卡片外观**：除了 `waiting` 那一行，这张卡与正常卡仍然一样（标题、`编号 · N 天`、
`late: false`、不框任何人）。按 owner 的口径这是可以接受的——**它说了那句话**，而且
`waitingOn: 'none'` 也说明了「没人欠动作、该修的是数据」。没有额外做红色/角标：那种
样式只在这个状态存在时才有意义，而迁移之后板上已经没有这样的卡（将来再出现就是一次
导入事故，届时 `waiting` 那一行本身就是告警）。

---

## 5. 用例

`tests/read.test.ts`（新 describe：缺日期的时钟状态：卡片点名缺的是哪一天，6 条）

| 用例 | 钉什么 |
|---|---|
| 待开发缺提测日 | **目标用例**：`missingDates === ['commit_test_at']`、`waiting === '缺提测日'`、`waitingOn === 'none'`、`mine === false` |
| 开发中缺承诺完成日 | 提测日在、出去就冻住 → 「缺承诺完成日」 |
| 测试中缺承诺完成日 | 「缺承诺完成日」 |
| 几个都缺就一起点名 | 无版本 + 无提测日 → 「缺开工日、提测日」（顺序按 `REQUIRED_DEADLINES`） |
| 日期齐全不误报 | `missingDates === []`、`waiting` 仍是「等开工日 …」、`waitingOn === 'clock'` |
| 其它状态不看日期 | `inbox` 的 `missingDates` 恒为空 |

**红/绿验证**（删掉 `waitingFor` 里那条前置判断，只留 `switch`）：

```
× 待开发缺提测日：说「缺提测日」，不装作在等开工日
× 开发中缺承诺完成日：说「缺承诺完成日」（提测日在，但走出去就冻住）
× 测试中缺承诺完成日：说「缺承诺完成日」
× 几个都缺就一起点名（词序按状态需要的那几列…）
Tests 4 failed | 34 passed (38)
```

`tests/dateless-to-queue.test.ts`（新文件，5 条：跑**真迁移文件**两遍）

1. 三个状态各一对「缺日期 → queue / 日期齐全 → 原地」；移走的行 `state_entered_at` 比
  200 天前新，`release_id` 与两个日期列逐字节不变；留下的行整行 `toEqual` 原值。
2. 第二遍 no-op（`state_entered_at` 不被再刷一次——否则「停了 N 天」每次迁移归零）。
3. `queue` / `live` / `rejected` 缺日期也不动（只有三个时钟状态看日期）。
4. 软删除的行不动。
5. 跑完之后「三个时钟状态里再没有缺日期的行」= 0：`left join releases` 的口径与
   `tick` 的 `assertHasRelease` / `deadlineDay` 一致。**这才是这条迁移真正想留下的不变量**。

---

## 6. 将来一条缺日期的 `dev` 行会怎样（说清楚）

导入脚本 / MCP / 直接写库把一条 `state='dev'` 且没有提测日的行写进库，接下来会发生：

1. **它会被看见**：看板开发中列出现这张卡，`waiting` 写「缺提测日」，`waitingOn: 'none'`
   ——没人欠动作，是数据缺了一块。
2. **它仍然冻结**：不会自己动，因为 tick 没有可比的日期。
3. **而且它会连累整轮 tick**：`deadlineDay` 在这条行上抛
   `clock_missing_deadline`，`tickThenDispatch` 里排在后面的企微推送与绑定自检也不跑。
   也就是说：**看得见 ≠ 会自己好**。在下一个人给它排期之前，它一直冻着，而且每轮
   tick 都会把这一轮的时钟与推送一起停住。
4. 修法只有一个：给它排期（`schedule` 写三个日期 → 状态回到 ready，日期补齐），或者
   打回 / 搁置 / 拒绝。迁移 0024 只收拾了**已经存在**的 34 条，它不是一条持续生效的
   规则——能持续生效的只有写入口的 `missing_dates` 与这层读侧警告。

换句话说：这一轮做到的是「**不会再有静悄悄的冻结**」。让「缺日期的行永远进不来」需要
在导入路径上也过 `schedule`（或等价的日期校验），那是另一次改动；本轮刻意不加 CHECK，
理由见 §3。

---

## 7. 验证命令

```bash
npm run db:test:setup          # flowers_test 跑上 0024（schema 迁移，非数据）
npm run db:migrate             # flowers 真库：NOTICE 0024：退回待排期 34 条（ready 18 · dev 14 · test 2）
npx tsx <手跑同一份 sql 第二遍>  # NOTICE 0024：退回待排期 0 条 → 幂等成立、无 leftover warning
npx vitest run                 # 全量
```

执行后的库（`flowers`）：

```
state      n
design    86
dev        2   ← 8、12
inbox    284
live     265
queue     36   ← 2 + 34
ready      1   ← 7
rejected  73
review     2
shelved   64
test       2   ← 9、11
total 815 · legacy_ref 803
```

---

## 8. 残留 / 未做

- 事件流里没有这 34 行的退回记录（§3 的理由）。要查「它为什么在待排期」，依据是迁移
  注释与本文件，不是抽屉里的时间轴。
- `tick` 对「缺日期的时钟行」仍然是整次抛出（`clock.test.ts` 钉着这个行为）。本轮没有
  改成「逐行跳过 + 汇总」：那会让一条坏行变成一条没人看的日志，而整次抛出至少会被
  监控看见。真正该做的是让坏行进不来（§6 末段）。
- `ready` 的必填清单里没有 `commit_due_at`（§2 的理由）。如果以后 dev 阶段不再允许改
  日期，这个清单要跟着变成三天。
