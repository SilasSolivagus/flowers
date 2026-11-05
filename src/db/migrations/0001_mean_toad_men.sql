CREATE SEQUENCE "public"."events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."requirements_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
-- 已有行不能被新序列撞上：把两个序列推到「当前最大值 + 1」。
-- setval(..., false) 表示下一次 nextval 直接返回这个值（不再自增一次）。
SELECT setval('events_seq_seq', COALESCE((SELECT max(seq) FROM events), 0) + 1, false);--> statement-breakpoint
SELECT setval('requirements_number_seq', COALESCE((SELECT max(number) FROM requirements), 0) + 1, false);--> statement-breakpoint
-- OWNED BY 手写：drizzle 的 pgSequence 不表达 ownership，而 `truncate ... restart identity`
-- 只重置「属于被清空表的」序列——没有这三行，测试里编号不会复位到 1。
ALTER SEQUENCE "events_seq_seq" OWNED BY "events"."seq";--> statement-breakpoint
ALTER SEQUENCE "requirements_number_seq" OWNED BY "requirements"."number";--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "seq" SET DEFAULT nextval('events_seq_seq');--> statement-breakpoint
ALTER TABLE "requirements" ALTER COLUMN "number" SET DEFAULT nextval('requirements_number_seq');
