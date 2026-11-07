-- P4-08：登录名换成邮箱 · 需求加「平台」那一列
--
-- 两条都是**有历史行的列**，所以顺序是硬的：先加可空 → 回填 → 再上约束。
-- 直接 `add column ... not null` 会在有行的库上立刻失败（这一条正是 drizzle 生成的
-- 那版 SQL 的问题：它假设表是空的）。

-- ── 1. members.email：登录名 ────────────────────────────────────────────────
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "email" text;--> statement-breakpoint

-- 回填：七个人的邮箱来自企业微信通讯录（**不猜拼音**）。这七行就是种子表，
-- 生产库里的人也跟着这条映射走；命中不了的人（自己加进来的、改名过的）落到
-- 下面那条 `member-<id>@123pan.com` —— 一个一眼看得出是占位的唯一地址。
-- 为什么不删掉这些行：`events.actor`、`requirements.owner_member_id` 都指着它们。
UPDATE "members" SET "email" = v.email
  FROM (VALUES
    ('房超',   'fangchao@123pan.com'),
    ('吕正豪', 'lvzhenghao@123pan.com'),
    ('赵越',   'zhaoyue@123pan.com'),
    ('吕品',   'lvpin@123pan.com'),
    ('李嘉',   'lijia@123pan.com'),
    ('罗丹',   'luodan@123pan.com'),
    ('王妍',   'wangyan@123pan.com')
  ) AS v(name, email)
 WHERE "members"."name" = v.name AND "members"."email" IS NULL;--> statement-breakpoint

UPDATE "members"
   SET "email" = 'member-' || "id"::text || '@123pan.com'
 WHERE "email" IS NULL;--> statement-breakpoint

ALTER TABLE "members" ALTER COLUMN "email" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "members_email_unique" ON "members" USING btree ("email");--> statement-breakpoint

-- ── 2. members.session_epoch ────────────────────────────────────────────────
-- 这一列是 0012_session_epoch.sql 手写加的，drizzle 的 snapshot 里一直没记。
-- 这里补一条 IF NOT EXISTS，让「照 journal 从头跑」与「就地升级」两条路都对得上。
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "session_epoch" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint

-- ── 3. requirements.platforms：多值平台 ────────────────────────────────────
-- `text[]` + `not null default '{}'`：空数组 = 未标注，历史行由 default 一次性回填成
-- 空数组（不是 null）。理由见 `src/db/schema.ts` 里这一列的注释与
-- `src/core/requirements/platforms.ts` 的文件头。
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "platforms" text[] DEFAULT '{}'::text[] NOT NULL;
