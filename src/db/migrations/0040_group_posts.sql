-- 群播报台账（2026-11-10）。
--
-- ## 它解决什么
--
-- 需求的状态变动要发到**团队群**（不是发给个人），版本要每天发一条进展。这两件事
-- 都是「一条消息对应一群人」，与 `notify_deliveries`（一条消息对应一个人）不是同一
-- 张表：把 member_id 变成可空会污染那张表的唯一索引，也让「谁收到」这个语义分叉。
--
-- ## 两列就是全部状态
--
-- `kind`：`events`（状态变动播报）| `daily`（版本每日进展）。
-- `ref`：事件的 `evt:<seq>`，或日报的 `daily:<YYYY-MM-DD>`（一天的日报是一条消息，含所有在播版本）。
-- 唯一约束 `(kind, ref)` = 同一条事件、同一个版本的同一天，只播一次。重跑、
-- 并发、失败重试都靠它兜底（`on conflict do nothing`）。
--
-- ## 为什么先落 pending 再发
--
-- 与 `notify_deliveries` 同一条理由：发出去的消息收不回来，所以「发过没有」这个记号
-- 必须先于发送存在。发送失败把那几行改成 `failed`，下一轮按原样再发一遍；成功则
-- `sent`，从此不再出现。
--
-- 幂等：`create table if not exists`。
create table if not exists group_posts (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  ref text not null,
  content text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  error text,
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (kind, ref)
);

create index if not exists group_posts_retry_idx
  on group_posts (status, created_at)
  where status <> 'sent';

comment on table group_posts is
  '群播报台账：事件播报与版本日报各一行，靠 (kind, ref) 去重';
