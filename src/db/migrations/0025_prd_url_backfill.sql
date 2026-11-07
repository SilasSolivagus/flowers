-- 老系统的 PRD 链接回填（203 条），判据：**标题全等 + 两边都唯一**。
--
-- ## 链接从哪来：标题等值，这是老系统里唯一存在的那条链接
--
-- 老系统（Flower）确实存着 PRD 链接：`documents.external_url`。实测（2026-11-08，
-- 只读 ssh 查证）：
--
--   documents                    217 行，kind 全为 'change'
--   其中 external_url 非空        205 行
--   entity_links                   0 行（空表）
--   requirements.brief_document_id / change_document_id
--                                  258 行里 0 行有值（全 null）
--   documents.title 命中 PAN-[0-9]  0 行
--
-- 也就是说：**没有任何一条外键、没有一条 link 行、标题里也没有 PAN 号**。文档与需求
-- 之间唯一存在的对应关系是「标题一样」。这不是本迁移的偷懒，是那份数据里只有这一个
-- 抓手——205 条带 URL 的文档标题，**全部**能在我们的 815 条需求里找到同名行（0 条对
-- 不上）。所以回填按标题全等做，并且不接受「差不多」：不 trim、不归一化、不分大小写、
-- 不做模糊匹配。任何一处放宽都会把链接推到一条**看起来对**的需求上。
--
-- ## 为什么歧义要拒绝，而不是取第一条
--
-- 205 条标题里，203 条**只对应一条**需求，2 条各对应两条（见报告）。剩下的那 4 行
-- （2 个标题 × 2 条需求）本迁移一条都不写：
--
--   「用户部分权益缩减调整」          → PAN-338 / PAN-742
--   「【风控】我的分享违规文件展示逻辑问题」 → PAN-27  / PAN-206
--
-- 取「第一条」（`number` 最小的那条）看着只错 50%，但这一列的读者不是人：
-- `prd_snapshots` 与材料生成把它当成**权威源**（见 `src/core/prd/*`）。写错一条，
-- 下游会照着一份别人的 PRD 生成材料，而错的地方**没有任何人看得出来**——库里那一列
-- 有值，界面就显示「PRD 已挂」，比空着更坏。空着只是「还没挂」，错挂是「挂错了」。
-- 所以：**宁可少 4 条，不猜一次**。这 4 条留给 owner 指定，挑完各写一条 update 即可。
--
-- ## 为什么另有一张种子表（数据不在本文件里）
--
-- 迁移文件是被 **pg 驱动**逐条执行的纯 SQL，它唯一看得见的数据就是文件的字节；而
-- `external_url` 只在 Flower 里，CI 与新克隆都没有那条 ssh 通道。把 203 行 `values`
-- 抄进这个文件就是「把一次性的外部数据烧进 schema 历史」，谁也 review 不动它。
-- 于是分成两半：
--
--   - **规则**（下面的 `update`）：判据全在这里，可 review、可被用例直接跑；
--   - **数据**：`src/db/seeds/prd-url-backfill.json`（203 行 `{title, url}`，按标题码点
--     排序，一个 title 一行 diff），由 `scripts/prd-backfill.ts --emit` 生成。
--
-- `npm run prd:backfill` 把种子装进这张表再**重跑本文件**——跑的是这里的 SQL，不是
-- 脚本里另抄的一份口径。没有种子时（新克隆 / CI / `npm run db:migrate`）这张表是空的，
-- 本迁移命中 0 行、不报错。
--
-- `title` 是主键：文档侧「同题唯一」由这张表的形状保证，不需要在 update 里再数一遍
-- 文档。需求侧的「同题唯一」数不了，只能当场 `count(*)`（下面那条子查询）。
--
-- 种子表**故意不在 `src/db/reset.ts` 的 `RESET_TABLES` 里**：它不是应用数据，是老系统
-- 的一份快照（与 `code_index` 同类：`cascade` 带不到它，重灌演示库之后仍在，重建的
-- 代价是 `npm run prd:backfill` 一条命令）。清掉它只会让本迁移「看起来跑过、其实
-- 什么也没填」。
create table if not exists prd_url_backfill_seed (
  title     text primary key,          -- 文档标题 = 需求标题（全等）
  url       text not null,             -- documents.external_url 原文，不做任何改写
  loaded_at timestamptz not null default now()
);
--> statement-breakpoint
-- 一条语句说完全部判据。四道门，缺一条就会把库写坏：
--
-- 1. `r.legacy_ref is not null` —— 只碰**迁移行**。12 条演示需求里也有同名于文档的
--    （`权益套餐产品结构改造` 等），它们已经有自己的 prd_url，且不是这份数据的对象；
-- 2. `r.prd_url is null` —— **永不覆盖**。已有值的行是人填的或别的脚本填的，
--    两种都比一次按标题猜的回填可信；
-- 3. `btrim(s.url) <> ''` —— 没有 URL 的文档不是一条 PRD 链接。种子文件已经过滤过
--    空 URL，这道门守的是「有人手写了种子」；
-- 4. `(select count(*) ... ) = 1` —— **同题需求必须唯一**。这条子查询是整条迁移的
--    承重墙：去掉它（或放宽成 `>= 1`），那 2 个歧义标题会各写两条需求，4 行全错。
--    `tests/prd-backfill.test.ts` 里有一条变异用例专门钉这件事。
--
-- 不按标题点名、不按 number 点名：判据就是这四道门，所以本迁移对任何一张库都成立
-- （含以后人工补进来的数据），第二遍命中 0 行。
--
-- `deleted_at` 刻意不看：0024 扣的是**状态**（软删的行看板不显示、tick 不推进，动它
-- 只是改写一条对外不存在的历史），而 `prd_url` 是这条需求的**属性**，删掉的行的 PRD
-- 也还是它自己的 PRD。实测 803 条迁移行里 0 条软删，这道门在这里永远不会触发。
update requirements r
   set prd_url = s.url
  from prd_url_backfill_seed s
 where r.title = s.title
   and r.legacy_ref is not null
   and r.prd_url is null
   and btrim(s.url) <> ''
   and (select count(*) from requirements r2 where r2.title = s.title) = 1;
