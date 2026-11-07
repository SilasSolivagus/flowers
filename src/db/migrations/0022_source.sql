-- Ruling 3（2026-11-08）：「来源」字段 —— 两列 + 从迁移事件回填。
--
-- 六类 + 自定义：线上问题 / 客服反馈 / 领导需求 / 需求挖掘 / 技术反馈 / 其他。
-- 「其他」允许一句自述，落在 `source_note`。词表**不在库里**（没有 CHECK），
-- 与服务层的那份常量（`src/core/requirements/source.ts`）同一个做法——加一类来源
-- 不该是一次迁移；写入端按词表校验，读侧认不出的值原样显示。
--
-- 存的是**中文**而不是 `platforms` 那种英文键：六类里只有两类在老系统里有英文键
-- （`online_issue` / `original`），另外四类（客服反馈 / 领导需求 / 需求挖掘 / 技术反馈）
-- 是这次新起的名字，硬造四个英文键只会在「键 ↔ 标签」之间再造一份没人维护的翻译；
-- 而且 owner 的验收查询就是按中文看的（`select source, count(*)`）。
--
-- ## 回填（幂等，只碰 `legacy_ref is not null` 的行）
--
-- 老系统的 `source` 值没有单独的列可搬，但**没有丢**：`migrate-flower.ts` 把它原样记进
-- 了 `requirement.migrated` 事件的 payload（`sourceSource`）。所以回填是「从自己写下过的
-- 事实里读回来」，不是猜。实测分布（803 条迁移行）：
--
--   线上问题  8 条（payload `online_issue`）
--   原创    332 条（payload `original`）
--   空      463 条（payload 里没有这个键）
--
-- ### 原创 → 需求挖掘（控制器的判断，**可回滚**）
--
-- 老系统把「我们自己发现的」叫作「原创」。六类里能表达这个意思的只有「需求挖掘」：
-- 线上问题 / 客服反馈 / 领导需求 / 技术反馈 都是**别人给的**，而「原创」恰恰是
-- 「不是别人给的」。所以 `original` → `需求挖掘`，**不是**因为它与「原创」同义，
-- 而是因为六类里只有它表示「我们自己发现的」。原始值仍留在事件 payload 里
-- （`payload::jsonb ->> 'sourceSource' = 'original'`），要推翻这个映射只需要一条
-- `update ... where source = '需求挖掘' and exists (... payload = 'original')`——
-- 这是这条映射敢做的前提：它没有毁掉证据。
--
-- ### 空 → 留空
--
-- 463 条老数据没有来源，`null` 就是「不知道」，不编。界面写「未标注」。
--
-- 下面两条 UPDATE 里的 `r.source is null` 是幂等键：跑第二次命中 0 行（第一次已经把
-- 该写的写完了）。**不能**用 `source is distinct from '线上问题'` 那种写法——那会把一条
-- 以后被人工改成「客服反馈」的行重新拉回「线上问题」，迁移不该覆盖人的判断。
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "source" text;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "source_note" text;--> statement-breakpoint
COMMENT ON COLUMN "requirements"."source" IS
  '来源（Ruling 3）：线上问题 / 客服反馈 / 领导需求 / 需求挖掘 / 技术反馈 / 其他；null = 未标注。'
  '词表在 src/core/requirements/source.ts（库里没有 CHECK：加一类来源不该是迁移）。'
  '迁移行的值从 events 里 requirement.migrated 的 payload.sourceSource 回填（online_issue → 线上问题，original → 需求挖掘）。';--> statement-breakpoint
COMMENT ON COLUMN "requirements"."source_note" IS
  '来源 = 其他 时的一句自述。服务层不强制「只有其他才有它」（静默丢掉调用方给的一句话比留着更坏），'
  '但表单只在选中「其他」时才渲染这一格。null = 没写。';--> statement-breakpoint
-- 线上问题：8 条。
update requirements r
   set source = '线上问题'
  from events e
 where e.requirement_id = r.id
   and e.type = 'requirement.migrated'
   and r.legacy_ref is not null
   and r.source is null
   and e.payload::jsonb ->> 'sourceSource' = 'online_issue';--> statement-breakpoint
-- 原创 → 需求挖掘：332 条（理由见上面那段）。
update requirements r
   set source = '需求挖掘'
  from events e
 where e.requirement_id = r.id
   and e.type = 'requirement.migrated'
   and r.legacy_ref is not null
   and r.source is null
   and e.payload::jsonb ->> 'sourceSource' = 'original';
