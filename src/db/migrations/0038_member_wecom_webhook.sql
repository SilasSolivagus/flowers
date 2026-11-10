-- 每人一条自己的企微群机器人（2026-11-10）。
--
-- ## 这一条加的是什么
--
-- `members.wecom_webhook`：这个人自己的机器人 webhook URL。null = 没有，通知走共用的
-- 那条（`wecom-cli` + `wecom_userid`，P4-07 的老路）。
--
-- 为什么允许每人一条：共用的机器人是**部署**的身份——消息从它发出去，收件人栏里永远
-- 是同一个名字；想让不同的人进不同的群只能改代码。这一列把它变成一个人的属性。
--
-- ## 为什么不加「是否已验证」这种列
--
-- 绑定状态是**算出来的**，不是存出来的：`wecom_userid` 非空 = 已绑定；
-- `wecom_userid` 为空而 `wecom_lookup_at` 非空 = 上次验证失败；两者都空 = 未绑定。
-- 多一列状态就要与那两列保持同步，而「同一件事有两个来源」迟早会说两种话。
--
-- ## 没有索引、没有外键
--
-- 只按成员 id 读（主键），没有任何按 webhook 查人的路径。
--
-- 幂等：`add column if not exists`。
alter table members
  add column if not exists wecom_webhook text;

comment on column members.wecom_webhook is
  '这个人自己的企微群机器人 webhook（含 key，只有服务端读）；null = 走共用机器人。界面只显示掩码';
