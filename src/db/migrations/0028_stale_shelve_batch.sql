-- 裁定（2026-11-08，owner 签字）：把过期审计里那 34 条「无主 + 半年没动」的需求**搁置**。
--
-- 输入是 `docs/superpowers/plans/2026-11-08-stale-audit.json`（已算完、已复核的那份），
-- 但**本文件不读它**：迁移必须自洽——文件被搬到一台没有 docs 的机器上、或 docs 以后
-- 被改写，历史也必须能一模一样地重放。所以那 34 个 id 是生成后**写死**在这里的，每行
-- 带自己的 PAN 号（对账、翻旧系统、跟人说话都用 PAN）。
--
-- ## 为什么是「搁置」而不是「拒绝」
--
-- `rejected` 是一句**判断**：「这件事我们不做」。这 34 条没有任何人做出过那个判断——
-- 它们只是 192 到 241 天没有人碰过，连一条业务事件都没有。拒绝会把它写成一个决定，
-- 而那个决定是谁做的、凭什么做的，事件流里答不出来；半年后翻旧账时，一条 `rejected`
-- 与一条「真的评审过、真的毙了」的行长得一模一样，无法区分。
--
-- `shelved` 是一句**状态**：「先不做，可以回来」。它有三个性质正好对上这次的事实：
--   1. `shelved` 是终态但**可恢复**：`restore` 一步回 `inbox`（见
--      `src/core/requirements/terminal.ts` 的 `restoreRequirement`），编号 / PRD 链接
--      这些身份信息全部保留——搞错了能原路退回，成本是一次点击；
--   2. 它出现在看板的「已搁置」列，不再占「收集」的位置，也不在待认领的候选集里
--      ——这正是审计要的效果（195 条无主里 154 条「活」的留在原地等人认领）；
--   3. 理由是必填的（`MISSING_REASON_SHELVE`），所以这 34 行**有**一句中文解释，
--      而批量拒绝只会留下一句「我们不想要它」。
--
-- 一句话：**拒绝断言了一个没人做过的决定，搁置只记录了已经发生的事实。**
--
-- ## 逐条守卫（宁可不跑，也不猜）
--
-- 每条被点名的行必须先通过四项核对，任何一项不成立就 `raise exception`，整条迁移
-- 回滚（`do` 块是一个语句，抛错即全撤，不会留下半截数据）：
--
--   1. **行还在**——`requirements` 里查得到这个 id；
--   2. **仍然无主**——`owner_member_id is null`。有人在这两天认领了它，就是有人接管了
--      这件事，「过期」这个前提当场失效；
--   3. **没被软删**——`deleted_at is null`（软删的行对外不存在，与 0024 / 0026 / 0027
--      同一条口径）；
--   4. **状态是预期的那个**——要么 `inbox`（本批要收的那批，34 条全在这里），要么
--      `shelved` 且那条搁置事件带本批的 `batch` 标记（已经跑过一遍）。其余状态
--      （`design` / `ready` / `dev` / `live` / `rejected` …）一律抛错：那说明有人在
--      这两天把它推走了，谁对谁错得人来看。
--
-- 唯一的例外是**行不存在**：新克隆、空的测试库、别人的库都没有这 34 行，那时这条
-- 迁移只能是一条空转语句。所以「查不到」计进 `missing`，只在 `raise notice` 里报数，不抛错
-- （与 0023 的 `legacy_ref` 查不到即 0 行同一条口径）。这不是放水——真实库里这 34 行
-- 全都在，`missing` 一旦不是 0（也不是 34），就说明连接串指错了库。
--
-- ## 写事件：与 `shelveRequirement` 同一条事件，另加 `batch` 标记
--
-- 一次真实的搁置会落下：`type = 'requirement.shelved'`、`payload = {from, to, reason}`
-- （见 `terminal.ts` 的 `recordEvent` 调用）。读侧只认这三样：抽屉时间轴的「搁置」+
-- 原因（`read/detail.ts`）、站内/企微通知的「被搁置：<原因>」（`read/notify.ts`）、
-- 事件分类 `outcome`（`notify/classes.ts`）。所以这里**照抄那个形状**，一个键都不改名，
-- 否则时间轴上会出现一条读不懂的 `requirement.shelved`。
--
-- 「批量产生的」这件事在这个仓库里没有现成的约定（`terminal.ts` 的 payload 只有三键，
-- 0021 / 0023 / 0024 / 0027 干脆不写事件）。这里用两个互补的标记：
--
--   * `actor = 'system'`——**不是某个人**。34 条里没有一个「按了按钮的人」，写任何一个
--     成员的名字都是假账（这个人从没做过这个动作，通知还会被当成「他自己做的」而被
--     扇出规则排除掉）。`system` 是本仓库已有的非人 actor（`core/notify/self-heal.ts`
--     写成员级事件时用的就是它）；
--   * `payload.batch = '2026-11-08-stale-audit'`——**可查询的批量标识**。它同时是幂等
--     的钥匙（见下）：`payload->>'batch'` 一问就知道这条搁置是这批迁移做的，还是哪个
--     人在抽屉里点的。
--
-- 不写 `requirement.updated` / 不写备注列：搁置只需要一条事件，理由在 `reason` 里。
--
-- ## 只动两列
--
-- `state` 与 `state_entered_at`，**别的列一个字节都不改**。尤其不动 `review_assignments`
-- ——一次真实搁置会顺手把还挂着的派单作废（`terminal.ts` 里那条 `update`），但这 34 条
-- 全在 `inbox`，派单只可能存在于 `review` 之前的动作之后；实测这 34 行没有一行挂着
-- `handed` 的派单（它们连一条评审事件都没有），所以那条 SQL 在这里命中 0 行。不写它的
-- 另一个理由：写了就是「顺手改了第三个表」，而这次裁定的范围只有这 34 条需求的状态。
--
-- `state_entered_at = now()`：这一列的含义是「进入当前状态的时刻」，看板上的「停了 N 天」
-- 与抽屉里的「进入本状态」都读它。它们**今天真的进入了搁置**，从这一刻起开始计「搁了
-- 多久」，所以 `now()` 是事实（与 0024 / 0027 同一条理由；与 0023 刻意相反，那批行状态
-- 没变过，原始时刻才是事实）。
--
-- ## 幂等
--
-- 两个条件合起来让第二遍必然 0 行：`state` 已经是 `shelved`（进 `shelved` 分支，因为已经
-- 有本批事件而计进 `already`），且派生的 `update` 只认 `state = 'inbox'`。
--
-- 更关键的一条：**被人恢复过的行不会再被搁回去**。`state = 'inbox'` + 已有本批 `shelved`
-- 事件，说明有人按过「恢复」——那是人对这次批量决定的一次**否决**，迁移不该替他撤销。
-- 所以「有没有本批事件」是守卫的一部分，不是审计信息。恢复路径本身照旧工作：
-- `restore` 只要求 `shelved → inbox` 与 `edit` 权限（无主行只有超管有，见
-- `roles.ts` 的 `can()`），事件流里留下一条 `requirement.restored`，本文件不会回手。
--
-- 实测（2026-11-08，`npm run db:migrate`）：
--   执行前：shelved 64 · inbox 284 · 其余 8 个状态共 466，未删合计 814。
--   执行后：shelved 98（+34）· inbox 250（−34）· 其余状态一条不变，合计仍是 814，
--           `live` 仍是 265。34 行各多一条 `requirement.shelved`（actor `system`）。
--   第二遍重放：`shelved 0 · already 34 · missing 0`，`state_entered_at` 不再被刷。
do $$
declare
  -- 批量标识：写进 payload，同时是幂等判据（哪些搁置是这批迁移做的）。
  c_batch  constant text := '2026-11-08-stale-audit';
  -- 与 `terminal.ts` 的 `shelveRequirement` 同一条理由文案（原因必填，且要说清为什么）。
  c_reason constant text := '停 192–241 天且无任何业务活动，按 2026-11-08 过期审计批量搁置';
  -- 非人 actor，见文件头「写事件」那一节。
  c_actor  constant text := 'system';

  t            record;
  v_state      text;
  v_owner      uuid;
  v_deleted    timestamptz;
  v_batch_done int;

  shelved int := 0;   -- 本次真的挪进搁置的行数（第一遍 34，之后 0）
  already int := 0;   -- 已经是本批搁置过的（第二遍 34；被恢复过的也计这里）
  missing int := 0;   -- 库里根本没有这行（空库 / 新克隆 / 连错库）
  bad     text[] := array[]::text[];  -- 违反前置条件的行，最后一个错误里点名列出来
begin
  for t in
    select * from (values
      (91, '727dabc0-1643-4dc9-94f5-3db3ad29e2e9'::uuid),   -- PAN-91 · 停 226 天（最后活动 2026-03-27）
      (93, '9b550d7f-a8ac-489f-a254-7edab6553471'::uuid),   -- PAN-93 · 停 226 天（最后活动 2026-03-27）
      (115, '434be248-806f-48c2-b107-2749fd616931'::uuid),  -- PAN-115 · 停 241 天（最后活动 2026-03-12）
      (116, 'bab04fd9-2cc2-48e3-8d20-ec04ed6a60d0'::uuid),  -- PAN-116 · 停 219 天（最后活动 2026-04-03）
      (125, '9573f4e1-398d-4e5a-a1cc-b7cb8bf7fd0b'::uuid),  -- PAN-125 · 停 226 天（最后活动 2026-03-27）
      (128, '8721da76-53b0-4929-86e6-a056141a19a6'::uuid),  -- PAN-128 · 停 226 天（最后活动 2026-03-27）
      (129, '8169212c-c426-4533-93ba-2c839d7b9498'::uuid),  -- PAN-129 · 停 241 天（最后活动 2026-03-12）
      (132, '20e75246-8b65-4935-82a0-66ccde58f5cc'::uuid),  -- PAN-132 · 停 219 天（最后活动 2026-04-03）
      (136, '9a013488-f240-459a-93f0-29d5a8a659be'::uuid),  -- PAN-136 · 停 241 天（最后活动 2026-03-12）
      (142, '5bc06286-1ac7-4189-86a9-b55c0d3b97bc'::uuid),  -- PAN-142 · 停 241 天（最后活动 2026-03-12）
      (143, 'c70c32e4-5563-41de-92d9-1548963ce688'::uuid),  -- PAN-143 · 停 241 天（最后活动 2026-03-12）
      (152, 'b24fea06-a82e-439c-8716-2af72d9e636b'::uuid),  -- PAN-152 · 停 241 天（最后活动 2026-03-12）
      (153, '77a88784-339a-4870-ab94-117ec4385e34'::uuid),  -- PAN-153 · 停 219 天（最后活动 2026-04-03）
      (157, '2f9f2565-ba8b-493f-a2fc-3a2a83e2704d'::uuid),  -- PAN-157 · 停 226 天（最后活动 2026-03-27）
      (158, '94b09c1c-1ed4-428d-8ebf-9715ebd355e5'::uuid),  -- PAN-158 · 停 226 天（最后活动 2026-03-27）
      (160, '620c6c4a-1a61-42d4-9712-5d6be003e10a'::uuid),  -- PAN-160 · 停 241 天（最后活动 2026-03-12）
      (162, '1c5b8407-c5dc-4e1e-8daf-127d45afcf9d'::uuid),  -- PAN-162 · 停 241 天（最后活动 2026-03-12）
      (205, '276106a2-6f2b-404d-89b1-ed95e230450d'::uuid),  -- PAN-205 · 停 230 天（最后活动 2026-03-23）
      (215, 'd26afe46-235e-45bc-ad0f-cdfad1d86b54'::uuid),  -- PAN-215 · 停 226 天（最后活动 2026-03-27）
      (222, '450b5f81-c712-4dd0-bce1-3a4a537888cb'::uuid),  -- PAN-222 · 停 227 天（最后活动 2026-03-26）
      (265, '7ee70614-7594-4ce5-a752-0b5051dd9ce9'::uuid),  -- PAN-265 · 停 214 天（最后活动 2026-04-08）
      (266, '7d87e6d7-b67b-4bab-bcb5-c354cffb56da'::uuid),  -- PAN-266 · 停 214 天（最后活动 2026-04-08）
      (267, '4fa6bdf6-7b85-461c-a900-2f619960c00f'::uuid),  -- PAN-267 · 停 214 天（最后活动 2026-04-08）
      (268, '82799d47-99e0-4f39-8bce-fab81029652e'::uuid),  -- PAN-268 · 停 214 天（最后活动 2026-04-08）
      (269, 'c88fd5ec-7b5a-4c0f-9341-889a83003ae9'::uuid),  -- PAN-269 · 停 214 天（最后活动 2026-04-08）
      (270, 'ebc7d7e4-615d-4a15-b7fa-5f87c9703add'::uuid),  -- PAN-270 · 停 214 天（最后活动 2026-04-08）
      (271, '0a4b57df-9782-4e88-8f0d-5ada9e1e3733'::uuid),  -- PAN-271 · 停 214 天（最后活动 2026-04-08）
      (272, '0079d8df-c40b-4456-a15a-1961cdaefcd5'::uuid),  -- PAN-272 · 停 214 天（最后活动 2026-04-08）
      (274, '4321ccc3-b6b5-4272-bbff-37c104f04a45'::uuid),  -- PAN-274 · 停 214 天（最后活动 2026-04-08）
      (275, '55d614c4-3314-445f-b7c0-94af193ce354'::uuid),  -- PAN-275 · 停 214 天（最后活动 2026-04-08）
      (280, '2bb0c1de-9dad-4f98-b341-6bfbbbf5bf94'::uuid),  -- PAN-280 · 停 209 天（最后活动 2026-04-13）
      (301, 'f13d7c92-b52c-4612-a331-253c595eb8ac'::uuid),  -- PAN-301 · 停 209 天（最后活动 2026-04-13）
      (345, '8cf90e75-400d-4188-af49-44101b3c47df'::uuid),  -- PAN-345 · 停 197 天（最后活动 2026-04-25）
      (358, 'e1bf31ab-0afb-4246-bc49-9ce019ffbb7d'::uuid)   -- PAN-358 · 停 192 天（最后活动 2026-04-30）
    ) as v(pan, id)
    order by pan
  loop
    -- `select … into` 查不到行时会把三个变量都置 null，正好用来区分「不存在」。
    select r.state, r.owner_member_id, r.deleted_at
      into v_state, v_owner, v_deleted
      from requirements r
     where r.id = t.id;

    if v_state is null then
      missing := missing + 1;
      continue;
    end if;

    -- 本批已经给它写过搁置事件了吗？（判据只有这一个：batch 标记 + 事件类型）
    select count(*)
      into v_batch_done
      from events e
     where e.requirement_id = t.id
       and e.type = 'requirement.shelved'
       and e.payload::jsonb ->> 'batch' = c_batch;

    if v_owner is not null then
      bad := bad || format('PAN-%s（已有负责人，不能替人搁置）', t.pan);
      continue;
    end if;

    if v_deleted is not null then
      bad := bad || format('PAN-%s（已软删）', t.pan);
      continue;
    end if;

    if v_state = 'shelved' then
      -- 已经搁置：本批做的（第二遍）算幂等；不是本批做的说明有人先动过手，停下来看。
      if v_batch_done = 1 then
        already := already + 1;
      elsif v_batch_done = 0 then
        bad := bad || format('PAN-%s（已被别的动作搁置，不是本批）', t.pan);
      else
        bad := bad || format('PAN-%s（本批搁置事件 %s 条，不是 1 条）', t.pan, v_batch_done);
      end if;
      continue;
    end if;

    if v_state <> 'inbox' then
      -- 这 34 条全部在收集里（审计 2026-11-07 23:48 实测）；被推走了就停下。
      bad := bad || format('PAN-%s（状态是 %s，不在收集里）', t.pan, v_state);
      continue;
    end if;

    if v_batch_done > 0 then
      -- 收集 + 已有本批搁置事件 = 有人按过「恢复」。那是人对这批决定的一次否决，
      -- 迁移不回手（见文件头「幂等」）。
      already := already + 1;
      continue;
    end if;

    -- 只改这两列。`and` 后面是把守卫再钉一次：即使上游判断将来被改坏，这条 SQL
    -- 也不会把一条有主 / 已删 / 不在收集的行挪走。
    update requirements
       set state = 'shelved',
           state_entered_at = now()
     where id = t.id
       and state = 'inbox'
       and owner_member_id is null
       and deleted_at is null;

    if not found then
      bad := bad || format('PAN-%s（更新命中 0 行）', t.pan);
      continue;
    end if;

    -- 与 `shelveRequirement` 同形状的 payload（from / to / reason），另加 batch 标记。
    insert into events (requirement_id, actor, type, payload)
    values (
      t.id,
      c_actor,
      'requirement.shelved',
      jsonb_build_object(
        'from', 'inbox',
        'to', 'shelved',
        'reason', c_reason,
        'batch', c_batch
      )::text
    );

    shelved := shelved + 1;
  end loop;

  -- 有任何一条不满足前置条件就整条回滚（`do` 是一个语句，抛错即全撤）。
  if coalesce(array_length(bad, 1), 0) > 0 then
    raise exception '0028：% 条不满足前置条件，整条迁移已回滚：%',
      array_length(bad, 1), array_to_string(bad, ' · ');
  end if;

  raise notice '0028：搁置 % 条（本批已搁置 % 条 · 库中不存在 % 条；首次期望 34 / 0 / 0，重放期望 0 / 34 / 0，空库期望 0 / 0 / 34）',
    shelved, already, missing;
end $$;
