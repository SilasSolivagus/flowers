-- 裁定（2026-11-08，owner 口述两次、修正一次）：两条**流程位置**规则，装在一条迁移里。
--
--   1. **无负责人的需求回「收集」**，但 `live` / `rejected` / `shelved` 不动。
--   2. **有负责人但没有 PRD 的需求回「待设计」**，但 `live` / `inbox` / `rejected` /
--      `shelved` 不动（`design` 本身当然也不动）。
--
-- 两条写在同一个文件里，因为它们是同一次裁定的两半，而且**都要能重复跑**：数据以后
-- 又会漂（有人用脚本 / MCP / 直接写库把状态推走），那时重跑一次就得把位置拉回来。
-- 分成两条迁移的话，这件事会变成「先跑 0028 再跑 0029」的仪式，而仪式总会漏一步。
--
-- 两条判据**互斥**（`owner_member_id is null` 与 `is not null`），所以顺序无关；仍然按
-- 裁定的顺序写，读起来与 owner 的话对齐。
--
-- ## 判据（就是下面那两条 update 的 where）
--
-- 规则 1：`owner_member_id is null and state not in ('inbox','live','rejected','shelved')`
-- 规则 2：`owner_member_id is not null and (prd_url is null or btrim(prd_url) = '')`
--         `and state not in ('design','live','inbox','rejected','shelved')`
--
-- `btrim(prd_url) = ''` 也算「没有 PRD」：空白链接不是链接，与
-- `submit_review.ts` 的 `if (!url)`、0025 / 0026 的 `btrim(s.url) <> ''` 是同一条口径。
-- 今天库里 0 条 `prd_url` 是空白串（实测），所以这条只影响「以后」——而它正是这条迁移
-- 存在的理由。
--
-- ## 为什么排除终态（`live` / `rejected` / `shelved`）
--
-- **终态是结论，不是流程位置。** 0021 的第一版把「无主」当成唯一判据，于是把 17 条
-- `rejected`、6 条 `shelved`、6 条 `live` 也拉回了收集，0023 又逐条搬回去——那次的
-- 教训原样适用于这两条规则：
--
-- - `live` → 待设计：一个**已经上线**的功能在看板上回到「待设计」，等于抹掉「它上线了」
--   这个事实。负责人在那儿看到一个「待设计」的卡片，会以为要重新设计一遍一个跑了三个
--   月的功能；按停留时间排序时，它还会显示成「刚进来的新活」。
-- - `rejected` → 任何位置：拒绝是有人做过的一个判断（有理由、有当时的信息）。把它还原
--   成「未处理」，等于**悄悄撤销一次拒绝决定**——没有人为这个撤销签过字。
-- - `shelved` → 任何位置：搁置是「决定先不做」，不是「还没轮到它」。拉回流程等于替
--   搁置它的人重新开一次工。
--
-- 规则 2 还多排除两个：
--
-- - `inbox` 不能回 `design`：那是**倒着走**。收集是入口、待设计是它之后的一步，而
--   `inbox → design` 是 `evaluate` 这个**动作**（要有人点「立项」、要写一条
--   `requirement.evaluated` 事件）。迁移替人走这一步，会让一条没人评估过的需求看起来
--   「已评估」，而事件流里没有那一笔——状态与事件从此对不上。
-- - `design` 本身不动：它已经是这条规则的目标状态；再写一次只会把 `state_entered_at`
--   刷成今天（见下一节），把「它在待设计停了 12 天」改成「今天刚进来」。
--
-- ## 为什么 `state_entered_at` 是 `now()`
--
-- 这一列的含义是「**进入当前状态的时刻**」：看板卡片上「停了 N 天」、抽屉里「进入本状态」、
-- 按停留时间排序，全都读它。这些行**今天真的重新进入了那个步骤**——一条无主的需求从
-- 待排期回到收集，是从这一刻起重新排队等认领；一条有主但没 PRD 的需求从待排期回到
-- 待设计，是从这一刻起重新等一份 PRD。所以 `now()` 是事实，不是顺手。
--
-- 反过来（保留旧时刻）会在库里写下一个假事实：那会显示「在待排期停了 90 天」，而那段
-- 停留没有换来任何动作，它卡住的原因（没人 / 没文档）与时长无关。
--
-- 与 0023 的取舍刻意相反：0023 那 29 行用 Flower 的 `state_changed_at`，因为那批行
-- **状态没变过**（是被 0021 的第一版误移的），原始时刻才是事实。这里的状态变了。
--
-- ## 为什么带 `deleted_at is null`（对 owner 原话的唯一一处收窄）
--
-- 软删的行**对外不存在**：`lockRequirement`、`requirementFacts`、`read/board.ts`、
-- 0024、0026 全部按这条口径读。给一条谁也看不见的行盖上「今天重新进入待设计」，只是
-- 改写一条对外已不存在的历史，而它不会自己回来（没有反删除）。
--
-- 实测（2026-11-08，执行前）两种写法**移动的行数完全相同**：规则 1 都是 0 行、规则 2
-- 都是 19 行——库里唯一那条软删行（PAN-338）是 `rejected`，本来就在终态排除里。所以
-- 这条收窄今天一个数字都不改，它只保证「以后软删一条进行中的需求」不会凭空多出一行
-- 假状态。
--
-- ## 不写事件
--
-- 这是一次**数据订正**，不是一次操作（0021 / 0023 / 0024 同一条口径）。事件流的形状是
-- 「谁在哪一刻让它走到了哪一步」，而这些行没有任何人做过那个动作——`actor` 写谁都错。
-- 要说清这件事的只有本文件与
-- `docs/superpowers/plans/2026-11-08-owner-and-prd-rules.md`。
--
-- ## 幂等
--
-- 守卫就是判据本身：跑完第一遍，该动的行已经落在 `inbox` / `design`（规则 1 的排除列表
-- 里有 `inbox`，规则 2 的有 `design`），第二遍命中 0 行，`state_entered_at` 也不会被
-- 再刷一次。空库 / 新克隆同样 0 行。
--
-- 重复执行是**安全而且期望**的：若以后有人把一条无主需求推到待设计、或把一条没 PRD 的
-- 需求排进待排期，再跑一次仍然把它放回它该在的位置——这正是这两条裁定要的口径。
-- （`npm run db:migrate` 第二次不会再执行本文件，drizzle 只按 `folderMillis` 跑新的；
-- 「再跑一次」在这里指把本文件的 SQL 直接重放，见 `tests/owner-and-prd-rules.test.ts`。）
--
-- ## 实测（2026-11-08，执行前 → 执行后）
--
-- 库：814 条未删需求（802 条迁移行 + 12 条演示），另有 1 条软删的 PAN-338。
--
--   规则 1：**0 行**。无主行共 195 条，其中 inbox 166 · live 6 · rejected 17 · shelved 6
--           ——没有任何一条「无主且在进行中」，所以它今天是一条**空转**的规则；
--           留着它是因为以后会有人把无主需求推去待设计（超管能改任何一行，见报告）。
--   规则 2：**19 行**，全部在 `queue`：PAN-43 / 318 / 350 / 775 / 776 / 778 / 779 / 781 /
--           783 / 784 / 786 / 787 / 788 / 805 / 806 / 808 / 813 / 814 / 816。
--           每一条都有负责人、都没有 PRD——正是裁定说的「有人接、但还没有正式文档」。
--
--   状态分布（未删行）：待设计 86 → 105（+19）· 待排期 36 → 17（−19）· 其余 8 个状态一条
--   不变；总数仍是 814，`legacy_ref` 仍是 802。
do $$
declare
  moved_ownerless int;
  moved_no_prd   int;
  leftover       int;
begin
  -- ── 规则 1：无负责人 → 收集（终态不动） ──
  update requirements
     set state = 'inbox',
         state_entered_at = now()
   where owner_member_id is null
     and state not in ('inbox', 'live', 'rejected', 'shelved')
     and deleted_at is null;
  get diagnostics moved_ownerless = row_count;

  -- ── 规则 2：有负责人但没有 PRD → 待设计（终态 / inbox / design 不动） ──
  update requirements
     set state = 'design',
         state_entered_at = now()
   where owner_member_id is not null
     and (prd_url is null or btrim(prd_url) = '')
     and state not in ('design', 'live', 'inbox', 'rejected', 'shelved')
     and deleted_at is null;
  get diagnostics moved_no_prd = row_count;

  raise notice '0027：无主回收集 % 条（今天应为 0）；有主无 PRD 回待设计 % 条（今天应为 19）',
    moved_ownerless, moved_no_prd;

  -- 跑完再问一次「还有谁不合口径」：这是这条迁移唯一真正想留下来的不变量，
  -- 不写死数字，所以它在任何一张库上都有意义（新库、测试库、订正过的库都是 0）。
  -- 与上面两条 where 逐字同源（含 `deleted_at is null`）：判据只有一份。
  select count(*) into leftover
    from requirements
   where deleted_at is null
     and (
       (owner_member_id is null and state not in ('inbox', 'live', 'rejected', 'shelved'))
       or (owner_member_id is not null
           and (prd_url is null or btrim(prd_url) = '')
           and state not in ('design', 'live', 'inbox', 'rejected', 'shelved'))
     );

  if leftover > 0 then
    raise warning '0027：仍有 % 条不符合裁定的行（无主不在收集 / 有主无 PRD 却已排期之后）', leftover;
  end if;
end $$;
