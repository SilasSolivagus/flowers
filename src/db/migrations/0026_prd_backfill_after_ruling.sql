-- owner 裁定之后的收尾：删掉「已拒绝的那一条」，再给「只剩一条」的那个标题补上 PRD 链接。
--
-- ## 裁定（2026-11-08，owner）
--
-- 0025 有两个标题各对应两条需求，因此一条都没写（「一个文档、两个候选」= 歧义，不猜）：
--
--   标题                               候选
--   用户部分权益缩减调整                PAN-338（rejected） · PAN-742（queue）
--   【风控】我的分享违规文件展示逻辑问题  PAN-27（live）      · PAN-206（live）
--
-- 裁定内容：
--
-- - **已拒绝的那条删掉** —— 「用户部分权益缩减调整」只留 PAN-742。删的是 **PAN-338**，
--   而且是**软删**（`deleted_at = now()`）：这个仓库不硬删需求（见 `requirements.deletedAt`
--   那列的注释），它的 `events` 与产物必须留在表里可读；
-- - **已上线的不动** —— PAN-27 / PAN-206 两条都保留，**继续没有 PRD**（不填、不删）。
--   所以本迁移一个字节都不碰那个标题。
--
-- ## 为什么这里要写两条语句，而 0025 一条就够
--
-- 0025 的第四道门是「同题需求 count(*) = 1」，数的是**全表**（连软删的行一起数）。
-- 这个口径对当时那张库成立（803 条迁移行里 0 条软删，见 0025 的注释），但今天不再成立：
-- 软删 PAN-338 之后，那个标题在表里仍然是 2 行，0025 的判据永远数出 2 条、永远不写。
-- 也就是说「删掉一条」这件事本身**不会**让 0025 的规则自动生效——差的是「数哪些行」。
--
-- 所以本迁移先做删除，再用**同一条规则**（标题全等 + 需求侧唯一）补写，只把「唯一」
-- 从「全表唯一」收紧成「**未删的行**唯一」——与读侧口径一致：`deleted_at is not null`
-- 的行对外等于不存在（`src/core/read/board.ts`、`read/notify.ts`、`requirements/manage.ts`
-- 全都这么读）。这是本迁移唯一一处与 0025 不同的判据，其余四道门原样保留：
-- `legacy_ref is not null`（只碰迁移行）、`prd_url is null`（永不覆盖）、
-- `btrim(url) <> ''`（空 URL 不是链接）、以及「同题唯一」。
--
-- 为什么不改 0025 而是新开一条：0025 已经被跑过、被 review 过、被
-- `tests/prd-backfill.test.ts` 直接跑过，它不是一份可以随便重写的文件。而且两张库的
-- 历史不同（有的库已经跑过 0025），改旧迁移等于让「同一份迁移在不同库上做不同的事」。
--
-- ## URL 从哪来（数据不在本文件里，除了这一行）
--
-- 0025 把 203 条 `{title, url}` 放在 `src/db/seeds/prd-url-backfill.json`（外部数据，
-- 由 `npm run prd:backfill:emit` 从 Flower 生成）。那两个歧义标题**不在那份种子文件里**
-- ——`buildPlan` 按「需求侧唯一」筛选，歧义的不写进去。于是 0026 要用的那条 URL 没有
-- 现成的、可读的种子行可继承。
--
-- 处理方式：本迁移把**这一行**（1 条 `{title, url}`）写进 `prd_url_backfill_seed`，
-- 再让 `update` 从种子表取值。取值的判据仍然全部在 SQL 里，URL 也只出现在一处：
-- 来源是计划文档 `docs/superpowers/plans/2026-11-08-prd-backfill.md` 第 3 节记录的那份
-- 文档（同日 ssh dogyun 只读复核过，与 Flower `documents.external_url` 原文一致）。
-- 之后 `npm run prd:backfill` 重跑 0025 时，这一行已经在种子表里，不会丢。
--
-- `on conflict` 用 `do update`（与 `scripts/prd-backfill.ts` 的 `loadSeed` 同形状）：
-- 裁定给的是**哪份文档**，种子表里那一格必须是它，不能被一份旧的/手改的值留着。
--
-- ## 幂等
--
-- 第二遍：第一段命中 0 行（那行已软删 → 走「已经删过」分支），`insert ... on conflict`
-- 改 0 行，`update` 因 `prd_url is null` 不成立命中 0 行，校验段照旧通过。
--
-- ## 空库 / 没搬过老数据的库
--
-- `number = 338` 那行不存在时（新克隆跑 `npm run db:migrate`、CI）第一段什么都不做，
-- `update` 命中 0 行——与 0025「种子为空 → 命中 0 行、不报错」同一种正常结果。
-- 但**只要那行在、判据却对不上**（不是迁移行 / 不是 rejected），就 `raise exception`
-- 停下：宁可让迁移红着，也不猜一条要删掉的真实数据。
--> statement-breakpoint

-- ── 1. 软删 PAN-338（判据：number = 338 且 legacy_ref 非空 且 state = 'rejected'） ──
--
-- 三道判据一起用，是为了「删掉的确实是那条被拒的迁移行」：
-- `number` 只是我们这边的号（人工可读、但单靠它不够——号可以被重排）；
-- `legacy_ref is not null` 保证它是从 Flower 搬来的那 803 条之一（12 条演示行不碰）；
-- `state = 'rejected'` 是裁定里「已拒绝的那条」的机器可判据。
do $$
declare
  cnt_number  int;  -- 库里 number = 338 的行数（不论状态）
  cnt_deleted int;  -- 其中已经软删的行数
  cnt_target  int;  -- 命中全部判据且未删的行数（应该正好 1）
begin
  select count(*) into cnt_number from requirements where number = 338;

  if cnt_number = 0 then
    -- 这张库里没有那一行：还没搬过老数据（新克隆 / CI）。无可删，迁移正常继续。
    null;
  else
    select count(*) filter (where deleted_at is not null) into cnt_deleted
      from requirements where number = 338;

    select count(*) into cnt_target
      from requirements
     where number = 338
       and legacy_ref is not null
       and state = 'rejected'
       and deleted_at is null;

    if cnt_target = 1 then
      update requirements
         set deleted_at = now()
       where number = 338
         and legacy_ref is not null
         and state = 'rejected'
         and deleted_at is null;
    elsif cnt_target = 0 and cnt_deleted = 1 then
      -- 第二遍（或人工已经删过）：幂等，什么都不做。
      null;
    else
      raise exception
        'PAN-338 判据对不上：number = 338 共 % 行（其中已软删 % 行），命中「迁移行 + rejected + 未删」% 行。本迁移不猜，先人工核对。',
        cnt_number, cnt_deleted, cnt_target;
    end if;
  end if;
end $$;
--> statement-breakpoint

-- ── 2. 把裁定选定的那份文档写进种子表（唯一一行 URL） ──
--
-- 标题 = 需求标题（全等，不 trim / 不归一化）——与 0025、与 `buildPlan` 同一条口径。
-- 这张表的形状保证「文档侧同题唯一」（`title` 是主键）。
insert into prd_url_backfill_seed (title, url)
values (
  '用户部分权益缩减调整',
  'https://doc.weixin.qq.com/doc/w3_AY0AtQboAD4CNh0SmhkawQQeGX256?scode=ALgASwf6AA00dBNilLAY0AtQboAD4'
)
on conflict (title) do update
   set url = excluded.url, loaded_at = now()
 where prd_url_backfill_seed.url is distinct from excluded.url;
--> statement-breakpoint

-- ── 3. 按 0025 的规则补写 PRD 链接（「唯一」= 未删的行里唯一） ──
--
-- 不按 number 点名、不按标题写死分支：判据就是下面这几道门，所以本语句对任何一张库
-- 都成立，第二遍命中 0 行。「用户部分权益缩减调整」那一行限定，是裁定的作用域
-- （另一个歧义标题 PAN-27 / PAN-206 明确不填）。
--
-- 第 4 道门（`count(*) ... = 1`）是本迁移与 0025 的**唯一差别**：加了 `deleted_at is null`。
-- 今天这个标题未删的行正好一条 = PAN-742；哪天再冒出第二条未删的同题需求，
-- 这条语句会自己停下（命中 0 行）而不是挑一条——与 0025 拒写歧义的理由完全一样：
-- 错挂一份 PRD 比没挂坏得多（`prd_snapshots` 与材料生成把它当权威源）。
update requirements r
   set prd_url = s.url
  from prd_url_backfill_seed s
 where s.title = '用户部分权益缩减调整'
   and r.title = s.title
   and r.legacy_ref is not null
   and r.prd_url is null
   and r.deleted_at is null
   and btrim(s.url) <> ''
   and (select count(*) from requirements r2
         where r2.title = s.title
           and r2.deleted_at is null) = 1;
--> statement-breakpoint

-- ── 4. 自检：删对了、填上了 ──
--
-- 迁移跑在一个事务里，这一段红了整条回滚——但「红」比「悄悄少写一条」好：
-- 这一步是数据修复，静默的半成功比失败更难发现。
do $$
declare
  seed_url     text;
  cnt_live     int;  -- 该标题下未删的迁移行数
  cnt_filled   int;  -- 其中 prd_url 等于裁定 URL 的行数
begin
  select url into seed_url
    from prd_url_backfill_seed
   where title = '用户部分权益缩减调整';

  if seed_url is null then
    raise exception '种子表里没有「用户部分权益缩减调整」的 URL：第 2 段 insert 没生效。';
  end if;

  select count(*) into cnt_live
    from requirements
   where title = '用户部分权益缩减调整'
     and legacy_ref is not null
     and deleted_at is null;

  if cnt_live = 0 then
    -- 还没搬过老数据：没有可校验的对象。
    null;
  else
    select count(*) into cnt_filled
      from requirements
     where title = '用户部分权益缩减调整'
       and legacy_ref is not null
       and deleted_at is null
       and prd_url = seed_url;

    if cnt_filled <> 1 then
      raise exception
        '「用户部分权益缩减调整」该有恰好一条未删的迁移行挂上裁定 URL，实际 % 条（未删的迁移行共 % 条）。可能原因：未删的候选不止一条（歧义门挡住了），或那一行已经有别的 prd_url。',
        cnt_filled, cnt_live;
    end if;
  end if;
end $$;
