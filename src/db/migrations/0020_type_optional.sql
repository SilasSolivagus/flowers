-- Ruling 1（2026-11-08）：`requirements.type` 不再必填（**只放宽约束，不动既有值**）。
--
-- owner 的依据：P4-06 之后「负责人决定评审人」——派单锚在负责人那一行的 `members.line`，
-- 需求类型不参与任何权限判断（见 `src/core/auth/roles.ts` 与 `read/notify.ts` 的注释）。
-- 一条没有类型的需求于是不该被卡住：它只是「还没人说要算商业还是功能」，不是一条不完整
-- 到不能走流程的需求。所以 `inbox → design` 上那道 `guard: 'type'` 也一并摘掉
-- （见 `src/core/state-machine.ts`）。
--
-- 既有 815 行的值一个字都不改：`commercial` / `feature` 仍是合法值，只是不再是**唯一**
-- 合法状态。`null` 从此是一个真值（界面写「未指定」），不是「缺失数据」。
--
-- 幂等：`DROP NOT NULL` 在列已经可空时是一条 no-op（PG 不报错），所以这条迁移跑两次
-- 第二次什么都不做。
ALTER TABLE "requirements" ALTER COLUMN "type" DROP NOT NULL;--> statement-breakpoint
COMMENT ON COLUMN "requirements"."type" IS
  '需求类型：commercial（商业）/ feature（功能）/ null（未指定，Ruling 1 起合法）。'
  '不承载权限——P4-06 之后派单与改动权锚在负责人那一行的 members.line。'
  'null 不参与指纹（fingerprint.ts：type 不是「描述」），所以补/清类型不会把产物打成「需求已更新」。';
