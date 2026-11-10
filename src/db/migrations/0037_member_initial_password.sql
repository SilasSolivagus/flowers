-- 存量成员落到团队统一的初始密码（2026-11-10，owner 的裁定）。
--
-- ## 这一条改的是什么
--
-- 在这之前，初始密码是**每人一条随机串**，由 `scripts/seed.ts` 生成并只在终端打印
-- 一次。代价落在发密码那条路上：超管要把 `kXm3fQ…` 念给新人，念错一个字符就进不去，
-- 而谁都拿不回明文（库里只有 scrypt 串）。owner 的判断是这个部署在内网、人不多、
-- 入职当天就要能登——统一一条大家知道的初始密码比「每人一串抄不走的东西」可靠。
--
-- 所以这一条把**现有成员**全部落到那一条上，`scripts/seed.ts` 与
-- `createMember`（设置 · 成员 · 新增）的默认值也改成同一条（`DEFAULT_MEMBER_PASSWORD`，
-- 见 `src/core/auth/password.ts`）。三处口径同一份，没有第二处写字面量。
--
-- ## 为什么哈希是预先算好写死在这里
--
-- scrypt 不在 SQL 里。这里写的是**一条** `scrypt$…` 串，由 `hashPassword` 在写这条
-- 迁移时算出来（`src/core/auth/password.ts` 的存储格式：参数 + 盐 + 派生键都记在串里，
-- 所以将来调 N 也不影响这一行的可验证性）。
--
-- 所有行共用同一个盐，这在这里是**可接受的**：盐的作用是让「一次预计算打穿所有人」
-- 失效，而这批账号共用的是一条**已知的**初始密码——预计算对它毫无意义。真正的防线
-- 是「登录之后自己改」，所以界面上那一行写明了改的入口。
--
-- 明文不写进这个文件、也不进任何日志：文件里只有派生键。
--
-- ## 副作用（照实写）
--
-- `session_epoch` 一起往前推：改密码 = 让旧票作废。否则所有人会在「密码已经换了」
-- 的情况下继续用旧 cookie 登着，直到它 12 小时后自然过期。
--
-- 幂等：`update` 不带 where 条件的行数在第二次跑时是「全部行」，但这一条迁移只跑一次
-- （drizzle 的迁移表记着它跑过）；就算手工重跑，结果仍然是把密码设成同一条。
update members
   set password_hash = 'scrypt$16384$8$1$BRWCG9usGCOwvgW8EkXRIQ$xIhes3KLYD3bw5_FjKBA3HwuAR_RXu3FDSIgSJgWsgkvzOcYPm5U3PdLU1WVS5ZpaEZY4hpJHrI3pYya8YaC3g',
       password_updated_at = now(),
       session_epoch = now()
 where password_hash is distinct from 'scrypt$16384$8$1$BRWCG9usGCOwvgW8EkXRIQ$xIhes3KLYD3bw5_FjKBA3HwuAR_RXu3FDSIgSJgWsgkvzOcYPm5U3PdLU1WVS5ZpaEZY4hpJHrI3pYya8YaC3g';

comment on column members.password_hash is
  'scrypt 串（参数+盐+派生键）；2026-11-10 起存量与新增的初始密码统一为团队约定的一条，见迁移 0037';
