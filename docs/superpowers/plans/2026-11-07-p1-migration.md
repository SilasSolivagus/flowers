# P1a 实施报告：803 条线上需求搬进新库

日期：2026-11-07
计划：`docs/superpowers/plans/2026-11-07-finish-gaps.md` §P1（「803 条全量迁移」）
owner 裁决：**803 条全搬，含 264 条已上线**。

## 结论（先看这段）

| 项目 | 结果 |
|---|---|
| 搬入条数 | **803**（`legacy_ref` 非空 803 / 演示 12，共 815） |
| 逐条落点与基线一致 | **是**（803 条 0 缺失、0 多余、0 字段不一致） |
| 再跑一次 `--apply` | **0 新增**（803 跳过） |
| 回滚可执行 | **是**（`delete where legacy_ref is not null` 删 803，演示 12 行摘要不变） |
| `/tmp/restore-demo.sh` 现在会毁数据 | **是，见 §6** |
| 数据缺陷 | 4 条，逐条计数见 §5（其中 1 条平台标签整条丢失） |

## 1. 基线（比较基准）

- 机器比对版：`docs/superpowers/plans/2026-11-07-p1-baseline.json`（803 行逐条 + 全套分布）
- 人读版：`docs/superpowers/plans/2026-11-07-p1-baseline.md`
- 生成命令：`npx tsx scripts/migrate-flower.ts --baseline docs/superpowers/plans/2026-11-07-p1-baseline.json`
  （即 `--dry-run` + 落盘；对 Flower **只读**，一条 `copy ... to stdout`）

基线里的分布（803 条）：

| 旧状态 | 条数 | 我们的状态 |
|---|---:|---|
| `launched` | 264 | `live` |
| `collect` | 158 | `inbox` |
| `to_evaluate` | 102 | `inbox` |
| `rejected` | 73 | `rejected` |
| `shelved` | 64 | `shelved` |
| `to_design` | 48 | `design` |
| `evaluated` | 41 | `design` |
| `designing` | 18 | `design` |
| `to_develop` | 18 | `ready` |
| `developing` | 15 | `dev` |
| `testing` | 2 | `test` |

落点合计：`live` 264 / `inbox` 260 / `design` 107 / `rejected` 73 / `shelved` 64 / `ready` 18 / `dev` 15 / `test` 2。
优先级：`p2` 331、`p0` 223、`p1` 193、`p3` 30、`green` 23、未定 3（合计 **800 条有值**）。
平台（行数）：web 277、mobile 224、pc 220、mini 46、backend 35、admin 17、manager 13、h5 9、frontend 7、open 3、harmony 2、tv 2，未标注 297。

## 2. 回滚演练（动真数据之前）

标识手段：`requirements.legacy_ref`（迁移 `0018_legacy_ref.sql`，可空 + `where legacy_ref is not null` 的部分唯一索引）。幂等键、回滚条件、逐条对账都靠它。

### 2.1 练一次：插 3 条 → 按 `legacy_ref` 删 → 演示 12 行摘要比对（全程在事务里，最后 `rollback`）

```
docker exec -i flowers-db-1 psql -U postgres -d flowers -e -f - < /tmp/rollback-rehearsal.sql
```

```
begin;
BEGIN
select count(*) as total_before, count(legacy_ref) as migrated_before from requirements;
 total_before | migrated_before
--------------+-----------------
           12 |               0

select md5(string_agg(id::text || '|' || number || '|' || state, ',' order by number)) as demo_digest_before
  from requirements where legacy_ref is null;
        demo_digest_before
----------------------------------
 c6a8c0ef04d596a04371d800d2aa9bdc

insert into requirements (title, type, state, requester, legacy_ref) values ...;
INSERT 0 3
select count(*) as total_after_insert, count(legacy_ref) as migrated_after_insert from requirements;
 total_after_insert | migrated_after_insert
--------------------+-----------------------
                 15 |                     3

select legacy_ref, number, state, title from requirements where legacy_ref is not null order by number;
              legacy_ref              | number | state  |      title
--------------------------------------+--------+--------+-----------------
 aaaaaaaa-0000-4000-8000-000000000001 |     13 | inbox  | [演练] 回滚用-a
 aaaaaaaa-0000-4000-8000-000000000002 |     14 | design | [演练] 回滚用-b
 aaaaaaaa-0000-4000-8000-000000000003 |     15 | live   | [演练] 回滚用-c

delete from requirements where legacy_ref is not null;
DELETE 3
select count(*) as total_after_delete, count(legacy_ref) as migrated_after_delete from requirements;
 total_after_delete | migrated_after_delete
--------------------+----------------------
                 12 |                     0

select md5(...) as demo_digest_after from requirements where legacy_ref is null;
        demo_digest_after
----------------------------------
 c6a8c0ef04d596a04371d800d2aa9bdc     ← 与 before 逐字节相同
select md5(...) as all_digest_after from requirements;
         all_digest_after
----------------------------------
 c6a8c0ef04d596a04371d800d2aa9bdc

rollback;
ROLLBACK
select count(*) as total_final, count(legacy_ref) as migrated_final from requirements;
 total_final | migrated_final
-------------+----------------
          12 |              0
```

### 2.2 唯一索引确实是幂等的底线（重复 `legacy_ref` 被库拒绝）

```
begin;
insert ... values ('[演练] 唯一索引-a', ... 'bbbbbbbb-0000-4000-8000-000000000001');
INSERT 0 1
insert ... values ('[演练] 唯一索引-b', ... 'bbbbbbbb-0000-4000-8000-000000000001');
ERROR:  duplicate key value violates unique constraint "requirements_legacy_ref_unique"
DETAIL:  Key (legacy_ref)=(bbbbbbbb-0000-4000-8000-000000000001) already exists.
rollback;
ROLLBACK
select count(*) as total_final from requirements;   → 12
```

### 2.3 搬完之后再练一次（真数据版：删 803 → 演示 12 行摘要不变 → `rollback`）

```
begin;
select count(*) as total_before, count(legacy_ref) as migrated_before from requirements;
 815 | 803
delete from requirements where legacy_ref is not null;
DELETE 803
select count(*) as total_after_delete, count(legacy_ref) as migrated_after_delete from requirements;
 12 | 0
select md5(...) as demo_digest_in_txn from requirements where legacy_ref is null;
 c6a8c0ef04d596a04371d800d2aa9bdc      ← 与迁移前完全相同
rollback;
ROLLBACK
select count(*) as total_final, count(legacy_ref) as migrated_final from requirements;
 815 | 803
```

**真要撤的时候**（不是演练）：把上面第二条换成 `commit`，即

```sql
delete from requirements where legacy_ref is not null;
```

不要用 `created_at` / `number` 区间 / `events.actor='migrate-flower'` 猜哪些是搬来的：前两条会连坐真实数据，第三条是副作用（事件可以被单独删掉或补写），而 `legacy_ref` 是被搬的那一行自己的属性。

## 3. 应用

```
npx tsx scripts/migrate-flower.ts --apply
写入 803 条，跳过（已搬过）0 条。
```

（每条一个事务：插需求 + 写一条 `requirement.migrated` 事件，payload 带
`sourceId / sourceNumber / sourceState / sourceSource / state / title`。）

搬来的行占 `number` 18–820，演示 12 条仍是 1–12，没有撞号。

## 4. 验证（查询 + 输出）

### 4.1 逐条对账（`--verify`，与基线一条一条比 state / priority / platforms / type / title）

```
npx tsx scripts/migrate-flower.ts --verify docs/superpowers/plans/2026-11-07-p1-baseline.json

== 逐条对账 ==
基线 803 条；库内 legacy_ref 非空 803 条；缺失 0；多余 0；字段不一致 0
requirements 总行数 815（搬来的 803 + 本系统自建 12）

== 按旧状态（Flower → 我们：基线 = 库内） ==
launched        → live      基线 264   库内 264   一致
collect         → inbox     基线 158   库内 158   一致
to_evaluate     → inbox     基线 102   库内 102   一致
rejected        → rejected  基线 73    库内 73    一致
shelved         → shelved   基线 64    库内 64    一致
to_design       → design    基线 48    库内 48    一致
evaluated       → design    基线 41    库内 41    一致
designing       → design    基线 18    库内 18    一致
to_develop      → ready     基线 18    库内 18    一致
developing      → dev       基线 15    库内 15    一致
testing         → test      基线 2     库内 2     一致

== 按落点（我们的状态：基线 = 库内） ==
live 264 | inbox 260 | design 107 | rejected 73 | shelved 64 | ready 18 | dev 15 | test 2   全部一致

对账通过。
```

### 4.2 SQL 直查

```
select count(*) as total, count(legacy_ref) as migrated,
       count(*) filter (where legacy_ref is null) as native from requirements;
 total | migrated | native
-------+----------+--------
   815 |      803 |     12

select state, count(*) from requirements where legacy_ref is not null group by state order by 2 desc;
  state   | count
----------+-------
 live     |   264
 inbox    |   260
 design   |   107
 rejected |    73
 shelved  |    64
 ready    |    18
 dev      |    15
 test     |     2

select priority, count(*) from requirements where legacy_ref is not null group by priority order by 2 desc;
 priority | count
----------+-------
 p2       |   331
 p0       |   223
 p1       |   193
 p3       |    30
 green    |    23
          |     3          ← 3 条无优先级，与线上一致（有值合计 800）

select count(*) as commit_history_rows from commit_history;   → 657
select count(*) as members_rows from members;                 → 7
select md5(...) as demo_digest_now from requirements where legacy_ref is null;
 c6a8c0ef04d596a04371d800d2aa9bdc                            ← 12 条演示数据一位没动
```

### 4.3 平台：抽 12 条逐条比 Flower 自己的值

我们这边（`platforms`）：

```
1306dd6a… | 20 | {web,pc}
61d46aef… | 22 | {web,pc}
c4a53372… | 24 | {web,pc}
d582b6d5… | 25 | {web,pc}
050c68fd… | 29 | {web,pc}
d6749444… | 34 | {mobile,mini}
0bd7572b… | 37 | {web,pc}
b8203a23… | 39 | {web,pc}
1c593f6d… | 45 | {web,pc}
9c764d55… | 46 | {web,pc}
7c1a58fa… | 47 | {backend,frontend}
2d822254… | 49 | {web,pc}
```

Flower 那边（同一个 uuid，`field_definitions.key='platform'` 的标签）：

```
1306dd6a… | 3   | PC客户端,Web端
61d46aef… | 5   | PC客户端,Web端
c4a53372… | 7   | PC客户端,Web端
d582b6d5… | 8   | PC客户端,Web端
d6749444… | 17  | 移动端,小程序
0bd7572b… | 20  | PC客户端,Web端
b8203a23… | 22  | PC客户端,Web端
1c593f6d… | 28  | PC客户端,Web端
9c764d55… | 29  | PC客户端,Web端
050c68fd… | 32  | PC客户端,Web端
2d822254… | 33  | PC客户端,Web端
7c1a58fa… | 731 | 后端,前端
```

12/12 一致（`PC客户端,Web端 → {pc,web}`、`移动端,小程序 → {mobile,mini}`、`后端,前端 → {backend,frontend}`）。

### 4.4 幂等：再跑一次 `--apply`

```
before: select count(*) from requirements;              → 815
npx tsx scripts/migrate-flower.ts --apply
写入 0 条，跳过（已搬过）803 条。
after:  select count(*) from requirements;              → 815
        select count(*) from events where type='requirement.migrated';  → 803
```

### 4.5 迁移后完整回归

```
npx tsc --noEmit                       → 干净（无输出）
npx vitest run                         → 46 files / 1222 passed | 1 skipped（94s）
跑完之后再查：requirements 815（803 搬入 + 12 演示）、commit_history 657、events 860
```

测试跑在 `flowers_test`，没有碰演示库那 803 条。

## 5. 数据缺陷（观察到的计数，不是抄计划）

| 缺陷 | 观察值 | 处理 |
|---|---:|---|
| 没有 `line`（没有类型依据） | **463 条** | 全落 `type='feature'`（NOT NULL，没有「未定」格）。`line=功能` 279 → feature、`商业` 61 → commercial，所以 `feature` 合计 **742**、`commercial` 61 |
| 复合平台值无法表示成多值 | **1 条** | Flower #775「用户部分权益缩减调整」（落 `rejected`，本库 `number=338`），平台标签原文是一个值 `Web / PC / App / H5商品中心 / 分享页`（一个选项里塞了五个端）。翻不成任何键 → 该行 `platforms = {}`，整行平台信息丢失。我们的空平台行共 298 = 297 条本来没标注 + 这 1 条。同名的另一条（Flower #693 → 本库 742）平台是四条独立标签，正常搬成 `{web,mobile,pc,h5}` |
| `description` → `context` 只是近似 | 非空 **625 条**、空 **178 条** | 非空整段进 `context`（「谁在什么情况下用」，而原文常混着问题/目标/阶段备注）；空的不编，留 null。六问的另外五格（problem / outcome / surfaces / edge_cases / out_of_scope）一律 null |
| `source` 未搬 | 有值 **340 条**（`original` 332、`online_issue` 8），空 **463 条** | 我们没有这一列。原值只写进 `requirement.migrated` 事件的 payload（`sourceSource`），要统计时查事件 |

另外两处**语义损失**（脚本头里已写明，不算缺陷但要知道）：

- `to_evaluate` 102 → `inbox`、`evaluated` 41 → `design`（owner 裁决「没有待评估/已评估」）。这 143 条的**当前动作**会变一点点：原本是「等评估」，现在 `inbox` 列的动作是「立项」。
- 负责人按 `display_name` 对花名册；对不上的留空 → **194 条搬来的需求现在没有负责人**（待接单：inbox 142、design 22、rejected 17、shelved 6、live 6、dev 1），提出人对不上写 `未知`（`requester` 是自由文本，不强绑账号）。没有编任何负责人、没有改任何标题。

## 6. ⚠️ `/tmp/restore-demo.sh` 现在会毁掉这次迁移

脚本内容是 `npm run seed -- --reset` + 一段 `insert into app_settings … / update requirements … where number=6`。

- `seed --reset` 走 `resetDb()`，那是 `truncate requirements, … restart identity cascade`。
- **它会连 803 条一起清掉，一条不剩**，而且 `restart identity` 会把编号打回 1。
- 它没有任何「库里已有 803 条真实需求」的判断，也不会问。

结论：**从今天起 `/tmp/restore-demo.sh` 是危险命令**。它以前是「重灌 12 条演示数据」的日常动作，现在是「销毁 803 条线上搬来的需求」。

要么别再用它，要么先 `pg_dump`：`docker exec flowers-db-1 pg_dump -U postgres flowers > /tmp/flowers-before-reset.sql`。真要重灌演示库，用不带 `--reset` 的 `npm run seed`（空库才灌），或先 `--apply` 之前那样手写回滚再灌。

补充：脚本末尾那句 `update requirements set prd_url=… where number=6` 现在改的是**演示那条 PAN-6**（搬来的行占 18–820），这条暂时没错，但它是按 `number` 定位的——一旦以后重排编号就会改错行。

## 7. 改了什么

| 文件 | 改动 |
|---|---|
| `src/db/migrations/0018_legacy_ref.sql`（+ `meta/0018_snapshot.json`、`_journal.json`） | 加 `requirements.legacy_ref`（可空）、非空部分唯一索引 `requirements_legacy_ref_unique`、列注释 |
| `src/db/schema.ts` | `legacyRef` 列 + 上面那条唯一索引（drizzle 表达，`drizzle-kit generate` 生成，diff 只有这两句） |
| `scripts/migrate-flower.ts` | 四个模式：dry-run / `--baseline <path>` / `--apply` / `--verify <path>`；`planRow()` 一处算落点，报表·基线·写入·对账共用；幂等改看 `requirements.legacy_ref`（事件保留，只做溯源） |
| `docs/superpowers/plans/2026-11-07-p1-baseline.{json,md}` | 基线 |

`src/core` 一行没动。

## 8. 遗留 / 需要 owner 决定

1. **#775 的平台**：复合值整条丢了（本库 `number=338`，状态 `rejected`），要不要人工补 `web,pc,mobile`？我没猜。
2. **194 条无负责人**：搬进来的需求很多落在 `inbox`（收集，142 条），等接单是合理的；但 `design` 里也有 22 条没负责人，看板会显示「待接单」。
3. **`restore-demo.sh` 要么删、要么加守卫**（比如库里 `count(legacy_ref) > 0` 就拒绝 `--reset`）。这一条建议做成 P1 的收尾动作，不然迟早有人手快。

## 追加：#775 平台修正（owner 裁决 B）

老系统里 #775 的平台是一整串自由文本：「Web / PC / App / H5商品中心 / 分享页」，混了两个层次
（端 + 页面），多值字段表示不了，迁移时整条丢弃。owner 裁决 B：能对上的三个端落进 `platforms`，
对不上的两个页面用文字留在 `context`。

- 迁移 `0019_fix_775_platforms.sql`，用 `legacy_ref` 定位（不用 `number`——那是本库自己的序列）。
- 结果：本库 #338 → `platforms = {web,pc,mobile}`，`context` 保留原串与解释。
- 幂等：重复跑同一条 update，结果不变。
