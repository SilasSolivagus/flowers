-- 裁定 2 修订（2026-11-08）：把被 `0021` 第一版误移的 29 条终态无主需求放回去。
--
-- ## 为什么要一条新迁移
--
-- `0021_ownerless_to_inbox.sql` 的第一版条件只有 `owner_member_id is null and state <> 'inbox'`，
-- 于是把 `rejected` 17 条、`shelved` 6 条、`live` 6 条也一起拉回了收集——那是一个错误的判断，
-- owner 已经裁定终态不动（**终态是结论，不是流程位置**；没有负责人只说明「当年谁负责没记录」，
-- 不说明「这件事要重来」）。`0021` 已在本库跑过，改文件不会让已应用的库重跑（drizzle 的
-- 迁移记录只比对 `folderMillis`），所以「已经错了的那 52 行」必须由这条迁移修正。
--
-- 为什么不直接 `update ... set state = 'inbox' …` 的逆操作：状态值不是猜得出来的。这些行现在
-- 全在 `inbox`，它们原本是 `rejected` 还是 `live`，只有**原始事实**说得清——`scripts/migrate-flower.ts`
-- 当年写下的 `requirement.migrated` 事件（`payload.state`）与 Flower 线上库的 `state_key`。
-- 迁移是纯 SQL，碰不到 Flower，所以下表把 2026-11-08 从两边读到、并且**逐条核对一致**的
-- 29 组「Flower uuid → 我们的状态 → Flower 的 state_changed_at」写死在这里。
--
-- ## 时间戳为什么必须写死
--
-- `0021` 的第一版把 `state_entered_at` 一起刷成了 `now()`（见它自己的注释），原始时刻在
-- 我们库里**已经被覆盖掉了**，只剩 Flower 那一份。而这一列正是看板「停了 N 天」与抽屉
-- 「进入本状态」的来源：给 6 条去年就上线的功能盖上「今天上线」，或给 17 条被拒的需求
-- 盖上「今天被拒」，都是在库里写下一个假事实——而这条迁移本来的目的就是让库说实话。
-- 所以 `state_entered_at` 一律取 Flower 的 `state_changed_at`，**不是** `now()`。
--
-- 取数（只读，2026-11-08）：
--
--   ssh dogyun "docker exec -i flower-postgres-1 psql -U flower_admin -d flower -tA -F '|' -c \
--     \"select id, state_key, state_changed_at from requirements where id in (<本库 194 条无主行的 legacy_ref>)\""
--
-- 194 条无主迁移行的 Flower 状态分布：collect 122 · to_evaluate 20 · evaluated 18 · rejected 17 ·
-- launched 6 · shelved 6 · to_design 3 · designing 1 · developing 1。
-- 映射（`STATE_MAP`：launched → live、rejected → rejected、shelved → shelved）后落在三个终态的
-- 正好是 **rejected 17 · live 6 · shelved 6 = 29 行**；其余 165 行（含原就在 inbox 的 142 行、
-- 被本次修订认可的 design 22 行、dev 1 行）**一个字节都不动**。
-- 每一行都和 `requirement.migrated` 事件里的 `payload.state`（当年落地时的映射结果）核对过，
-- 194/194 一致；下面的 `exists` 子句把这条核对留在迁移里——状态对不上就不改。
--
-- ## 幂等
--
-- 守卫是 `r.state = 'inbox'`：第一遍跑完这 29 行已经不在 inbox，第二遍命中 0 行（`NOTICE` 会
-- 打 0）。空库 / 新克隆同理：那些 `legacy_ref` 不存在，命中 0 行。**不能**用
-- `state is distinct from 'rejected'` 这种写法，那会把以后人工从拒绝改成别的行重新拉回来。
--
-- 实测（执行前）：无主行 195 条全在 `inbox`；执行后
-- `select state, count(*) from requirements where owner_member_id is null group by 1 order by 1`
-- → `inbox 166 | live 6 | rejected 17 | shelved 6`（总数仍是 195）。
do $$
declare
  restored int;
begin
  update requirements r
     set state = f.state,
         state_entered_at = f.entered_at::timestamptz
    from (values
      ('3dd9e9b6-430e-5909-86ce-11d85b3b92fd', 'live', '2026-05-29 00:41:09.000000+00'),
      ('61d46aef-4bec-5170-8bbd-af0fc8f5a409', 'live', '2026-03-12 07:32:56.636000+00'),
      ('67f42222-f3ad-56d0-8f0e-9633d7a411e8', 'live', '2026-06-02 03:38:08.000000+00'),
      ('bd704801-ae96-5a2f-a597-aed77f8d5d54', 'live', '2026-05-27 00:48:19.000000+00'),
      ('d0ecdbfd-7b01-5b5f-8b30-1ac1975c9852', 'live', '2026-04-30 02:12:08.000000+00'),
      ('fea076e0-6010-521b-a6ac-a4ff0678fc8b', 'live', '2026-04-03 10:04:34.000000+00'),
      ('08ca0eb3-e0a8-52d9-9d7e-0faf2848da53', 'rejected', '2026-06-04 02:49:32.000000+00'),
      ('1f583421-bb6f-5a2e-a014-f52beec85dc1', 'rejected', '2026-07-01 04:01:34.000000+00'),
      ('2405c1eb-9d23-5002-ade0-1c18a9644152', 'rejected', '2026-06-04 02:47:51.000000+00'),
      ('36dd56bb-2940-5150-8767-42f22fbcdc1d', 'rejected', '2026-06-04 02:47:45.000000+00'),
      ('44de665f-1579-5436-96be-ce642d469553', 'rejected', '2026-06-04 02:37:04.000000+00'),
      ('678ab187-987f-50e4-afc9-a7b9df7c29b0', 'rejected', '2026-06-04 02:49:28.000000+00'),
      ('70aea7b1-1dce-5e07-96c7-651198467703', 'rejected', '2026-06-04 02:49:35.000000+00'),
      ('766f1d85-ac24-579e-b299-3a7d9e47770b', 'rejected', '2026-06-08 01:56:21.000000+00'),
      ('7860b22a-e584-5ebb-b9b1-7c7394adf9b5', 'rejected', '2026-06-04 02:47:43.000000+00'),
      ('97bb13a8-5519-59b7-9afa-0cc9d43b6685', 'rejected', '2026-06-04 02:49:30.000000+00'),
      ('9a6f3a0f-f18c-5ccd-af82-a4aaafe33588', 'rejected', '2026-06-04 02:47:48.000000+00'),
      ('a05c2fd4-dad7-5e95-847f-163d36e00717', 'rejected', '2026-06-04 02:52:09.000000+00'),
      ('a9ec0879-f031-5af6-ae46-2b6629ee978e', 'rejected', '2026-06-04 02:36:36.000000+00'),
      ('ae90b38b-e7dc-5e8c-8b66-b7e4d79c7a33', 'rejected', '2026-07-06 11:34:05.000000+00'),
      ('cf2904ac-5205-5dca-a770-3d418fb27577', 'rejected', '2026-06-04 02:36:27.000000+00'),
      ('da36de21-c8c0-5cab-90d4-0a6950de3666', 'rejected', '2026-06-04 03:23:57.000000+00'),
      ('f2db53bf-f27c-5a6c-85e8-426cca40355a', 'rejected', '2026-06-04 02:43:18.000000+00'),
      ('2f07a3e0-230b-572e-8789-365f63759ee9', 'shelved', '2026-07-21 06:31:23.000000+00'),
      ('6d074cf2-823e-5101-afae-1c14f8775df4', 'shelved', '2026-04-27 05:00:30.000000+00'),
      ('c6a7bd9c-a2ad-5298-8612-fdd8b2449bda', 'shelved', '2026-04-27 05:00:30.000000+00'),
      ('c9327bff-1f48-517f-950d-2c43de47f6db', 'shelved', '2026-07-21 06:31:27.000000+00'),
      ('df6d3a95-5092-59e4-bda9-c7c1fd14a473', 'shelved', '2026-04-27 05:00:30.000000+00'),
      ('ff963a6a-37ff-53f9-be29-709ec8ddcbe5', 'shelved', '2026-04-27 05:00:30.000000+00')
    ) as f(legacy_ref, state, entered_at)
   where r.legacy_ref = f.legacy_ref
     -- 只收「无主 + 还在 inbox」的行：0021 只动过无主行，也只会把它们停在 inbox。
     and r.owner_member_id is null
     and r.state = 'inbox'
     -- 与当年落地时的事件核对：状态对不上就不改（宁可漏，不可编）。
     and exists (
       select 1
         from events e
        where e.requirement_id = r.id
          and e.type = 'requirement.migrated'
          and e.payload::jsonb ->> 'state' = f.state
     );

  get diagnostics restored = row_count;
  raise notice '0023：恢复 % 条无主终态需求（期望 29；已修过的库与空库为 0）', restored;

  if restored not in (0, 29) then
    raise warning '0023：只恢复了 % 条（期望 29）——请核对 legacy_ref / events 与 Flower 的 state_key', restored;
  end if;
end $$;
