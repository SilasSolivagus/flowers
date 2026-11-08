# 2026-11-08 两条流程裁定：无主回收集 · 有主无 PRD 回待设计

分支 `main`（基于 `e3f5219`）。一条编号迁移、一处写入口守卫、两组用例。没有表结构变化，
没有新依赖，`src/core/locate/*` 与数据 guard 一个字节没动。

| 交付 | 文件 | 形状 |
|---|---|---|
| 迁移 0027 | `src/db/migrations/0027_ownerless_and_prd_rules.sql` + `meta/_journal.json`（idx 27） | 纯数据迁移：两条 `update … set state=…, state_entered_at=now()`，可重复执行 |
| 规则 2 的写入口 | `src/core/requirements/schedule.ts` | `queue → ready` 上新增 PRD 门：`missing_prd` + 中文文案，位置在状态门之后 |
| 口径说明 | `src/core/state-machine.ts`（只改注释） | 说清「排期也要 PRD」为什么**不**挂成 `guard: 'prd'` |
| 用例 | `tests/owner-and-prd-rules.test.ts`（14）、`tests/schedule-prd-guard.test.ts`（11） | 迁移跑真文件两遍；守卫的错误文案 / 事件 / 列全部钉住；无主行的能力矩阵 |

---

## 1. 两条裁定

owner 的原话（两次口述，修过一次）：

1. **无负责人的需求回收集**，但 `live` / `rejected` / `shelved` 不动。
2. **有负责人但没有 PRD 的需求回待设计**，但 `live` / `inbox` / `rejected` / `shelved`
   不动（`design` 本身当然也不动）。

判据（就是迁移里那两个 where，一个字都不另写一份）：

```sql
-- 规则 1
update requirements set state = 'inbox', state_entered_at = now()
 where owner_member_id is null
   and state not in ('inbox', 'live', 'rejected', 'shelved')
   and deleted_at is null;

-- 规则 2
update requirements set state = 'design', state_entered_at = now()
 where owner_member_id is not null
   and (prd_url is null or btrim(prd_url) = '')
   and state not in ('design', 'live', 'inbox', 'rejected', 'shelved')
   and deleted_at is null;
```

两条判据**互斥**（`owner_member_id` 为空 / 非空），所以语句顺序不影响结果；文件里仍按
owner 说话的顺序写，读起来与裁定对齐。

两处对原话的**补充**，都不是风格问题：

- `(prd_url is null or btrim(prd_url) = '')`：空白链接不是链接，与 `submit_review.ts`
  的 `if (!url)`、0025 / 0026 的 `btrim(url) <> ''` 同一条口径。今天库里 0 条空白串，
  所以它只影响「以后」——而那正是这条迁移存在的理由。
- `deleted_at is null`：软删的行对外不存在（`lockRequirement`、`requirementFacts`、
  `read/board.ts`、0024、0026 全部这么读）。这条收窄今天**不改变任何数字**（唯一那条
  软删行 PAN-338 是 `rejected`，本来就在终态排除里），它只保证「以后软删一条进行中的
  需求」不会凭空多出一行假状态。

## 2. 实测效果（`npm run db:migrate`，2026-11-08）

执行前：815 行，其中 814 条未删（802 条迁移行 + 12 条演示），1 条软删（PAN-338）。

| 规则 | 移动行数 | 明细 |
|---|---|---|
| 规则 1（无主 → 收集） | **0** | 无主行共 195 条，全部已在 `inbox`(166) 或终态 `live`(6) / `rejected`(17) / `shelved`(6)——没有任何一条「无主且进行中」 |
| 规则 2（有主无 PRD → 待设计） | **19** | 全部在 `queue`，全部有负责人、全部 `prd_url is null` |

19 行的号：PAN-43 / 318 / 350 / 775 / 776 / 778 / 779 / 781 / 783 / 784 / 786 / 787 /
788 / 805 / 806 / 808 / 813 / 814 / 816。

状态分布（未删行，执行前 → 执行后）：

| 状态 | 前 | 后 |
|---|---|---|
| 待设计 `design` | 86 | **105**（+19） |
| 待排期 `queue` | 36 | **17**（−19） |
| 收集 `inbox` | 284 | 284 |
| 待评审 `review` | 2 | 2 |
| 待开发 `ready` | 1 | 1 |
| 开发中 `dev` | 1 | 1 |
| 测试中 `test` | 3 | 3 |
| 已上线 `live` | 265 | 265 |
| 已拒绝 `rejected` | 72 | 72 |
| 已搁置 `shelved` | 64 | 64 |
| 合计（未删） | 814 | 814 |

**没有别的东西动**，逐条对过：

- 总行数 815 → 815，未删 814 → 814，`legacy_ref` 非空 802 → 802；
- 事件总数 865 → 865（迁移不写事件）；
- 「除状态与状态时刻之外的每一列」的指纹
  `md5(string_agg(id:title:owner:prd_url:release_id:commit_test_at:commit_due_at:deleted_at:legacy_ref:number))`
  执行前后**完全相同**（`21f815d0…341f`）——负责人、PRD 链接、版本、两个日期、软删标记
  一个字节都没改。

幂等：`npm run db:migrate` 第二次不再执行 0027（drizzle 只按 `folderMillis` 跑新的），
把 0027 的 SQL 直接重放两次，两次的 `NOTICE` 都是「0 条 / 0 条」，状态分布保持不变。

## 3. 为什么排除终态（`live` / `rejected` / `shelved`）

**终态是结论，不是流程位置。** 0021 的第一版把「无主」当成唯一判据，把 17 条
`rejected`、6 条 `shelved`、6 条 `live` 拉回了收集，0023 又逐条搬回去——那次的教训原样
适用于这两条规则：

- `live` → 待设计：一个**已经上线**的功能回到「待设计」，等于说「它要重新设计一遍」。
  按停留时间排序时它还会显示成「刚进来的新活」；看板「停了 N 天」从今天起算。
- `rejected` → 任何位置：拒绝是有人做过的一个判断（有理由、有当时的信息）。把它还原成
  「未处理」等于**悄悄撤销一次拒绝决定**——没有人为这个撤销签过字。
- `shelved` → 任何位置：搁置是「决定先不做」，不是「还没轮到它」。拉回流程等于替搁置它
  的人重新开一次工。

规则 2 还多排除两个：

- `inbox` 不能回 `design`：**那是倒着走**。收集是入口，待设计是它之后的一步；`inbox →
  design` 是 `evaluate` 这个**动作**（要有人点「立项」、要写一条 `requirement.evaluated`
  事件）。迁移替人走这一步，会让一条没人评估过的需求看起来「已评估」，而事件流里没有那
  一笔——状态与事件从此对不上。
- `design` 本身不动：它已经是目标状态，再写一次只会把 `state_entered_at` 刷成今天。

`state_entered_at = now()` 是事实，不是顺手：这一列的含义是「进入当前状态的时刻」，看板
「停了 N 天」、抽屉「进入本状态」、按停留时间排序全读它。这些行**今天真的重新进入**了
那个步骤（无主的从这一刻起重新排队等认领；没文档的从这一刻起重新等一份 PRD）。与 0023
刻意相反：0023 那 29 行用 Flower 的 `state_changed_at`，因为那批行**状态没变过**（是被误
移的），原始时刻才是事实。

## 4. 规则 1 为什么不需要代码：结构保证（以及唯一的例外）

结论：**除超管外，无主需求只能被「认领」这一条路动到。** 有代码为证，也有测试为证；
超管是**记录在案的例外**，不是被忽略的洞。

`can()` 在 `ownerMemberId = null, ownerLine = null` 这组事实上：

| 能力 | 非超管（PM / 条线负责人） | 超管（`product_owner`） |
|---|---|---|
| `claim` | **true**（唯一一个） | true |
| `edit` | false（`governs` 需要 `ownerLine`，自己的行需要 `ownerMemberId`） | **true** |
| `reassignOwner` | false | **true** |
| `review` | false（`governs` 为 false；且状态要 `review`） | 状态为 `review` 时 true |
| `admin` / `manageMembers` | false | true |

服务层与这张表严格对齐：**每一个状态动作**（evaluate / submit_review / review_pass /
review_reject / schedule / bounce / reject / shelve / restore）都 `assertCan(…, 'edit')`，
改描述与软删除也是 `edit`，只有认领是 `claim`。所以「无主需求被推进状态」在非超管手里
不存在。

两条结构性支撑：

1. **无主需求只能被创建在收集里**：`createRequirement` 的 `state` 是写死的 `'inbox'`，
   而 `ownerMemberId = null` 只有超管能显式传。非超管的每一条新需求，负责人就是他自己。
2. **认领不改状态**：`claimRequirement` 只写 `owner_member_id` 与一条
   `requirement.owner_assigned` 事件，状态机一个字都不动。认领之后这条需求仍在收集，
   下一步仍然是评估或提交评审——「立项」在这个系统里就是「成为负责人」。

**例外（如实记录）**：`roles.ts` 的第一档是「超管：改任何一条」，`edit` / `reassignOwner`
对 `ownerLine = null` 的行也成立。于是超管可以把一条无主需求评估、提交评审（带 PRD）、
拒绝、搁置——造出一条「无主但不在收集」的行。这不是要修的 bug（超管的存在意义就是兜底），
所以规则 1 的保证写成两层：**非超管：只有认领；超管：能改，但 0027 重跑会把它拉回来。**
迁移末尾那条 `leftover` 自检就是这层兜底的报警器。

## 5. 规则 2 的写入口：为什么在 `schedule.ts` 而不是状态机表

`queue → ready` 在 `TRANSITIONS` 里只有 `schedule` 一个 trigger（时钟的边是 `ready→dev`、
`dev→test`、`test→live`），所以门只有这一处需要。加在服务里，理由三条：

1. **不借用评审那道门**。`Guard = 'prd'` 可以挂到任意一行上，但 `assertGuards` 为它准备
   的那句话是评审专用的：`直接提交评审必须有正式 PRD 链接`。挂着它去点「排期」，用户看到
   的是「直接提交评审…」，而他没有提交评审。要修就得让文案按 trigger 分叉，那等于改
   `submit_review` 共用的那个门对象（`tests/state-machine.test.ts` 逐字钉着它）——**评审的
   行为与措辞一个字节都没动**，这是刻意的。
2. **位置在 `assertTransition` 之后**，与状态机自己的顺序一致（`assertTrigger` 就是
   find → trigger → guard）。于是一条「待设计」的需求被点排期时，报的是
   `不能从「待设计」直接到「待开发」`，不是 `missing_prd`——后者会让用户以为补个链接就
   能排期，而他补完仍然排不了。（这条**被变异验过**：把门挪到状态门之前，
   「状态不对时先报状态」立刻变红。）
3. **在事务里、锁行之后**：`prd_url` 是这一行的内容，只能从库里读；锁住再读，才不会读到
   「判的时候没 PRD、写的时候已经有了」的半旧值。

「拒绝时什么都没发生」这件事由**事务**保证，不是由门的位置保证——变异测试把门挪到
`moveTo` 之后，11 条用例**全绿**：`moveTo` 写下的状态被同一次 `throw` 回滚掉了。所以门的位置
只影响**报错优先级**（第 2 点），不影响原子性。这条也写进用例里（「不写事件、不改状态、
不落日期」是断言，不是注释）。

形状：

```ts
assertTransition(row.state, 'ready');
if (!hasPrd(row.prd_url)) throw new AppError('missing_prd', MISSING_PRD);
```

- 码复用 `missing_prd`（界面上「缺 PRD」只有一种形状），**措辞是排期自己的**：
  `没有正式 PRD 链接的需求不能排期`；
- 判据 `hasPrd()` 与迁移逐字同源（`prd_url` 非空、且不是一串空白）；
- 拒绝时不写事件、不改状态、不落日期——事务整体回滚，与 `missing_dates` / `bad_dates`
  两条已有拒绝路径同一形状（有用例逐条钉住）。

`src/core/state-machine.ts` 只加了一段注释，说明这道门为什么**不在**表里、它在哪一份文件；
`TRANSITIONS` 本身一行没改（`tests/state-machine.test.ts` 里那张逐字表仍然绿）。

## 6. 变异表（21 条，每一条都跑过）

做法：备份实现文件 → 改一处 → `npx vitest run <相关用例文件>` → 记录红/绿 → 立刻还原。
**21 次变异，20 次变红，1 次仍然是绿**（第 15 行）——那条绿是一次发现，不是漏网，见第 5 节。

| # | 变异（改的那一处） | 变红的用例 |
|---|---|---|
| 1 | 规则 1 的 where 去掉 `state not in (…)` | 规则 1 ｜today 形状一行不动（时刻被刷）· 无主的终态不动 · 幂等 |
| 2 | 规则 1 的排除列表只留 `inbox`（放开三个终态） | 规则 1 ｜today 形状 · 无主的终态不动 |
| 3 | 规则 1 的排除列表只留 `live`（放开 rejected / shelved） | 规则 1 ｜today 形状 · 无主的终态不动 · 幂等 |
| 4 | 规则 1 删掉 `deleted_at is null` | 规则 1 ｜软删的行不动 |
| 5 | 规则 1 的 `state_entered_at = now()` 改成 `= state_entered_at` | 规则 1 ｜无主的进行中状态全部回收集（时刻断言） |
| 6 | 规则 1 的判据 `is null` → `is not null`（写反） | 规则 1 ｜无主的进行中状态…（有主行被拉进收集，源行为 0 行）· 规则 2 的五条 |
| 7 | 规则 2 的 PRD 条件整行删掉（完全不看 PRD） | 规则 2 ｜有 PRD 的待排期不动 |
| 8 | 规则 2 的判据只留 `prd_url is null`（丢空白） | 规则 2 ｜PRD 是一串空白也算没有 PRD |
| 9 | 规则 2 的判据写成 `prd_url is null or prd_url = ''`（丢 btrim） | 同上（`'   '` 不是空串） |
| 10 | 规则 2 的排除列表删掉 `inbox` | 规则 2 ｜回到收集是倒着走 |
| 11 | 规则 2 的排除列表删掉 `design` | 规则 2 ｜终态与目标状态不动 · 幂等 |
| 12 | 规则 2 删掉 `deleted_at is null` | 规则 2 ｜软删的行不动 |
| 13 | `schedule` 删掉 `hasPrd` 这道门 | 写入口 ｜没有 PRD：中文报错 · PRD 是一串空白 · 错误码同源 |
| 14 | 门的判据只判 `row.prd_url === null`（空白放行） | 写入口 ｜PRD 是一串空白也算没有 PRD |
| 15 | 门挪到 `assertTransition` **之前** | 写入口 ｜状态不对时先报状态，不报 PRD |
| 16 | 门挪到 `moveTo` **之后** | **没有一条变红**——`moveTo` 的写入被同一次 `throw` 回滚了（见第 5 节：原子性来自事务，门的位置只决定报错优先级） |
| 17 | `MISSING_PRD` 换成评审那句「直接提交评审…」 | 写入口 ｜没有 PRD · 一串空白 · 错误码同源（`not.toContain('提交评审')`） |
| 18 | `can()` 的 `edit` 改成恒真（去掉「需要负责人」） | 结构保证 ｜无主需求拒绝改描述 · 能力层矩阵 |
| 19 | `can('claim')` 去掉 `ownerMemberId === null` | 结构保证 ｜已过期的认领不会覆盖别人的归属 |
| 20 | `claimRequirement` 顺手写 `state = 'design'`（越过状态机） | 结构保证 ｜认领：状态不动 · 认领之后这条路就通了 |
| 21 | 给 `queue → ready` 挂上 `guard: 'prd'`（复用评审那道门） | `tests/state-machine.test.ts` 的「转移表与规格逐条一致」 |

## 7. 验证

```
npm run db:migrate        # 第一次：NOTICE「无主回收集 0 条；有主无 PRD 回待设计 19 条」
npm run db:migrate        # 第二次：无待跑迁移（0027 已记录），数字不动
（重放 0027 的 SQL 两次：两次都是 0 条 / 0 条 —— 幂等的直接证据）
npx vitest run            # 62 files / 1415 passed / 1 skipped（新增 25 条：14 + 11）
npx tsc --noEmit          # 0 error
npm run build             # 成功（7 条路由照旧）
```

## 8. 以后还可能违反这两条规则的路（如实列出）

规则 1 / 2 现在各自只有**一个**写入口被守住，其余写库的路都绕过服务层。按危险程度排：

1. **`scripts/migrate-flower.ts`（全量导入）**：直接把 Flower 的 `state_key` 映射后写进
   `state`，并且 `owner_member_id` 与 `prd_url` 都可能为空。它一次能造出几十条「无主且
   进行中」或「有主但无 PRD 的待排期/待开发」。**这是最现实的一条**：下次全量导入之后必须
   重跑一次 0027（或把两条判据并进导入的落库口径）。
2. **`scripts/prd-backfill.ts` 的回滚口径**：它自己的注释里就写着
   `update requirements set prd_url = null`。对一条已在 `queue` / `ready` 的行执行它，就把
   一条有 PRD 的需求变成「有主无 PRD 且已排期之后」——正是规则 2 想消灭的形状。今天没有
   代码自动这么做，它是人手执行的建议动作。
3. **`updateRequirement` 可以清空 `prd_url`**（`EDITABLE_FIELDS` 里有 `prdUrl`）：在一条
   待排期 / 待开发的卡上把 PRD 删掉是允许的。删完之后 `schedule` 的门会拦住后续推进
   （不会再多走一步），但这一行已经不符合规则 2 了。
4. **超管 + 任何状态动作**：见第 4 节的例外。超管能在无主行上评估 / 提审 / 拒绝 / 搁置。
5. **直接写库 / 一次性脚本 / `tsx` 里手搓 SQL**：`update requirements set state = …` 没有任何
   拦截层。这类漂移只能靠重跑 0027 拉回来——这也是这条迁移写成「可重复执行」而不是
   「一次性订正」的全部理由。
6. **时钟不需要 PRD**：`dev → test → live` 只读日期。一条（来自导入的）无 PRD 的 `dev` 行
   照样会上线。规则 2 的排除列表把 `live` 留在原地，所以它不会被拉回待设计——这是裁定
   要的口径（上线是结论），但意味着「上线了却没有 PRD」是允许存在的终态。

反向的一条（不是洞，是设计）：**`review_reject` 会把一条有 PRD 的需求放回 `design`**，
它之后就在规则 2 的目标状态里，不会触发任何移动；要再排期仍然得先有 PRD。

## 9. 提交

两个提交，一个讲数据口径、一个讲证据：

1. `feat(db): 0027 两条流程裁定（无主回收集 · 有主无 PRD 回待设计）+ 排期 PRD 门`
2. `test/docs: 0027 与排期 PRD 门的变异表、结构证据（认领是唯一路径）与报告`
