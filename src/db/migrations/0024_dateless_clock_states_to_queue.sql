-- 裁定 6（2026-11-08）：缺日期的「待开发 / 开发中 / 测试中」退回「待排期」。
--
-- ## 问题：一个没有日期的时钟状态，是永久冻结
--
-- `ready` / `dev` / `test` 三个状态**只由时钟推进**（`clock/tick.ts` 的 `clockEdges`
-- 读 `releases.window_start` / `requirements.commit_test_at` / `commit_due_at`）。
-- 一条缺了驱动日期的行停在里面，看板上位置完全正确、卡片看起来也正常——但它**永远
-- 动不了**：没有人欠它一个动作（卡片 `waitingOn` 是 `none`），时钟也没有可比的日期。
-- 圈内它是「已排期但日期没填」，真实位置就是待排期。
--
-- 而且它不止冻住自己。tick 对缺日期的行不是「跳过」，是**整次抛出**
-- （`deadlineDay`：`需求 … 处于「开发中」但缺少提测日，无法自动推进`；
-- `assertHasRelease`：三个时钟状态都必须挂在版本上）。所以库里只要有一条这样的行，
-- 同一轮 tick 里**所有**该推进的需求一起停住，而 `tickThenDispatch` 里排在 tick 后面的
-- 企微推送与绑定自检也跟着不跑——一次数据缺口变成整条自动化管线停摆。
--
-- 实测（2026-11-08，执行前）：
--
--   select state, count(*) from requirements where state in ('ready','dev','test') group by 1
--   → ready 19 · dev 16 · test 4
--
-- 其中缺日期 34 行（ready 18 · dev 14 · test 2）。34 行**全部** `release_id` 为 null
-- （连版本都没有，`assertHasRelease` 第一句就抛）、全部有负责人、没有一行是软删除；
-- 另外 5 行日期齐全（ready 1 · dev 2 · test 2），本次一条都不动。
-- 老系统没有这三个日期：Flower 的 `expected_date` 在 803 条迁移行里 801 条是 null，
-- 所以这不是「几个人漏填」，是一次从未被排期的历史状态。
--
-- ## owner 的裁定：退回「待排期」
--
-- 一个状态的前提条件不成立，它就不是那个状态。没有日期的「开发中」等价于
-- 「已排期但日期没填」——所以把它放回它真实所在的步骤。只动**动不了**的行：
--
--   state = 'ready' 且 commit_test_at 为空
--   state = 'dev'   且 commit_test_at 或 commit_due_at 为空
--   state = 'test'  且 commit_due_at 为空
--
-- `ready` 为什么看的是**提测日**而不是它自己的开工日：ready 的驱动日期确实是开工日
-- （版本给的 `window_start`），但它走一步就要读提测日——提测日为空的 ready 行只是
-- 「把冻结推迟了一步」，让它先走到开发中再冻住，问题只会藏得更深。健康的 ready 行
-- 不会有这种形状：`schedule` 一次写三个日期，缺一个就报 `missing_dates`。
--
-- `dev` 为什么也看承诺完成日：dev 走一步读提测日、下一步读承诺完成日，两者缺一都会
-- 在后面冻住，和「今天还在开发中」这个说法无关。
--
-- ## `state_entered_at` 为什么是 `now()`（与 0023 刻意相反）
--
-- 0023 那 29 行用的是 Flower 的 `state_changed_at`，因为那批行**状态本身没变过**
-- （是被 0021 的第一版误移的），原始时刻才是事实。这 34 行不一样：它们**今天真的
-- 重新进入了待排期**，重新回到排期队列里等一个日期。看板卡片上「停了 N 天」从今天
-- 起算，抽屉里「进入本状态」也写今天——它们从这一刻起才开始等排期。
-- 反过来保留旧时刻更坏：那会在库里写下一个「在开发中停了 200 天」的假事实，而那段
-- 停留没有任何人负责、也没有任何时钟读过它。
--
-- ## 不碰什么
--
-- `release_id` 与三个日期列一个字节都不改：日期缺失是**事实**（老系统就没有），
-- 补齐日期是排期的人要做的事，迁移猜不出来，也不该替谁填一个。
--
-- 不写事件：这是一次**数据订正**，不是一次操作（0021 / 0023 同一条口径）。事件流的
-- 形状是「谁在哪一刻让它走到了哪一步」，而这 34 行没有任何人做过那个动作——`actor`
-- 写谁都错。要说清这件事的只有本文件与
-- `docs/superpowers/plans/2026-11-08-dateless-rows-to-queue.md`。
--
-- 也不加 CHECK 约束（比如 `check (state <> 'dev' or commit_test_at is not null)`）：
-- 这条迁移本身就证明了这种行**历史上存在**，而约束拦不住「从老系统搬数据」的那条路
-- ——`migrate-flower.ts` 是一次性脚本，它撞上约束只会让下次全量导入跑不完，或者被迫
-- 在导入里塞假日期。真正拦它的是写入口（`schedule` 的 `missing_dates`），读侧再给
-- 一句诚实的警告（`read/board.ts` 的 `missingDeadlines` + 卡片上的「缺提测日」），
-- 再加一条用例钉住那句话。约束留空，是因为这里要的是「看得见」，不是「写不进」。
--
-- ## 幂等
--
-- 守卫就是判据本身：第一遍跑完这些行的 `state` 已经是 `queue`，第二遍命中 0 行；
-- 空库 / 新克隆同样 0 行（演示数据走的是正常流程，日期齐全）。**不按 `legacy_ref`
-- 点名**：那会把以后人工重新排期进来的行再拉回去，而这 34 行没有一条需要点名——
-- 判据（缺日期）就是它们的全部共同点。
--
-- 反过来，重复执行是安全而且**期望**的：若有人（脚本 / MCP / 直接写库）又把一条缺
-- 日期的行推进 `dev`，再跑一次仍然把它放回待排期——这正是这条裁定要的口径。
--
-- 三句 `update` 分开写只为一件事：`notice` 里说得出「这一类各移了几行」，
-- 出事时一眼能看出是哪一类不对（一条 `or` 写在一起的语句只给一个总数）。
--
-- 实测（执行后）：
--
--   select state, count(*) from requirements where state in ('ready','dev','test') group by 1
--   → ready 1 · dev 2 · test 2；queue 由 2 变 36；总数仍是 815，legacy_ref 仍是 803。
do $$
declare
  moved_ready int;
  moved_dev int;
  moved_test int;
  leftover int;
begin
  -- `deleted_at is null`：软删除的行看板不显示、tick 也不推进（`tick` 的 where 同样
  -- 带这一条），动它只是改写一条对外已不存在的历史。它们不会自己回来（没有反删除），
  -- 所以「恢复之后还得排期」这件事在这里不成立。
  update requirements
     set state = 'queue',
         state_entered_at = now()
   where state = 'ready'
     and commit_test_at is null
     and deleted_at is null;
  get diagnostics moved_ready = row_count;

  update requirements
     set state = 'queue',
         state_entered_at = now()
   where state = 'dev'
     and (commit_test_at is null or commit_due_at is null)
     and deleted_at is null;
  get diagnostics moved_dev = row_count;

  update requirements
     set state = 'queue',
         state_entered_at = now()
   where state = 'test'
     and commit_due_at is null
     and deleted_at is null;
  get diagnostics moved_test = row_count;

  raise notice '0024：退回待排期 % 条（ready % · dev % · test %；期望 34 / 18 / 14 / 2，'
    '已跑过的库与空库为 0）', moved_ready + moved_dev + moved_test, moved_ready, moved_dev, moved_test;

  -- 跑完再问一次「还剩谁走不动」：这是这条迁移唯一真正想留下来的不变量。
  -- 不写死数字，所以它在任何一张库上都有意义（新库、测试库、订正过的库都是 0）。
  -- 留着的前提是「日期齐全」：缺版本、缺驱动日期、日期不可解析，tick 都会抛。
  select count(*) into leftover
    from requirements r
    left join releases rel on rel.id = r.release_id
   where r.deleted_at is null
     and (
       (r.state = 'ready' and (rel.window_start is null or r.commit_test_at is null))
       or (r.state = 'dev' and (r.commit_test_at is null or r.commit_due_at is null))
       or (r.state = 'test' and r.commit_due_at is null)
     );

  if leftover > 0 then
    raise warning '0024：仍有 % 条时钟状态的行缺日期（它们会让 tick 整次抛出），请人工排期或再核对判据', leftover;
  end if;
end $$;
