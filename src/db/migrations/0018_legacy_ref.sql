-- P1（2026-11-07）：`requirements` 加迁移溯源列 `legacy_ref`（**纯加列，可空，不动既有行**）。
--
-- 裁定（owner）：线上 Flower 803 条**全量**搬进本库，含 264 条已上线。搬进来的行必须
-- 自己说得清「我是从哪来的」，否则后面三件事都做不了：
--   1. 幂等 —— 再跑一次 `migrate:flower --apply` 必须 0 新增。以前靠 events 里
--      `requirement.migrated` 的 payload 反推，那是从副作用推事实；写在行上才是答案。
--   2. 回滚 —— `delete from requirements where legacy_ref is not null` 即撤销整次迁移，
--      不碰 12 条演示数据、不碰本系统自建的需求。
--   3. 核对 —— 逐条 `legacy_ref → state / priority / platforms` 与 dry-run 基线对账。
--
-- 索引带 `where legacy_ref is not null`：唯一性只对「搬来的行」成立。普通唯一索引会把
-- 本系统自建的 null 行当成互相重复，第二行就报错——这是它必须带 where 的唯一原因。
ALTER TABLE "requirements" ADD COLUMN "legacy_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "requirements_legacy_ref_unique" ON "requirements" USING btree ("legacy_ref") WHERE "requirements"."legacy_ref" is not null;--> statement-breakpoint
COMMENT ON COLUMN "requirements"."legacy_ref" IS
  '迁移溯源：这一行来自线上 Flower 哪一条需求（Flower requirements.id uuid 的原样字符串）。null = 本系统自建。用途三条：migrate-flower 的幂等键、回滚条件（delete where legacy_ref is not null）、逐条对账。不参与任何业务判断。';
