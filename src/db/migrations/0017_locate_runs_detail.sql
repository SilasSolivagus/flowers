-- 2026-11-07 修复二波：`locate_runs` 加一列分仓明细（**纯加列，可空，不动既有行**）。
--
-- 裁定（推翻「一轮一行、不留细节」那条）：一轮一行的口径保留，但必须把「每个仓各是什么状态」
-- 落库。理由：走查一轮判两个仓，一行只有一个 `outcome`，于是「一仓读不到 + 一仓有候选」被记成
-- `low`——盲仓在准确率分母里彻底消失；而 `why` 里那句「仓 id：原句」只是给人看的一行字，
-- 句子不进库，读回来就没了。
--
-- `IF NOT EXISTS` 是手写的（drizzle 生成的是裸 `ADD COLUMN`）：这条迁移的验收要求是
-- 「跑两次都干净」，而手写迁移里已经用过 `CREATE TABLE IF NOT EXISTS` 这个先例。
ALTER TABLE "locate_runs" ADD COLUMN IF NOT EXISTS "detail" jsonb;
--> statement-breakpoint
COMMENT ON COLUMN "locate_runs"."detail" IS
  '一轮一案的分仓明细：{"repos":{"123pan-pc":{"kind":"absent","why":"…"},"123pan-uni-app":{"kind":"none"}}}。kind 用 LocateResult 的词（absent/none/candidates，不是本表 outcome 的 low）；why 只在 absent 时写。用途：排除盲样本——detail->''repos'' 里出现任一 absent 即「半盲」，where not exists (select 1 from jsonb_each(detail->''repos'') e where e.value->>''kind'' = ''absent'') 就是全见样本；detail 为 null（评审那一轮）没有分仓信息，不能按这条筛。outcome 的含义不因此改变，仍是「材料上那句话怎么说的」。';
