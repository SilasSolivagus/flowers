-- 待排期的需求写进企微汇总表（2026-11-10）。
--
-- ## 这一条加的两样东西
--
-- 1. `requirements.remark`：录入面上的「备注」。汇总表最后一列就叫「备注」，
--    这一列是它的唯一来源；没有它，那一列只能永远空着。
-- 2. `sheet_sync`：一次「该写、但还没写成功」的台账。
--
-- ## 为什么是台账，不是「状态迁移里顺手写完」
--
-- 往汇总表追加一行要 spawn 一次 `wecom-cli`（实测 1 秒上下），网络/~授权抖动时还会失败。
-- 把这次外部调用绑进 `review_pass` 的事务里，等于让企微的可用性决定一条需求能不能
-- 进待排期——外部系统挂了，内部流程跟着停，这条耦合没有任何收益。
--
-- 所以事务里只**登记**一条 pending（同事务，不会出现「状态变了但没登记」），
-- 真正的写入由 `scripts/sheet-sync.ts` 扫（与 `scripts/wecom-dispatch.ts` 同一个
-- 运维模型：一个定时任务、失败下次再来、失败原因留着）。
--
-- ## 为什么 unique (requirement_id, target)
--
-- 一条需求在汇总表里只该有一行。重跑、重放、并发扫描都靠这条唯一约束兜底：
-- 插入冲突 = 「已经登记过」，不是错误（`on conflict do nothing`）。
-- `target` 留着是因为同一张台账以后可能还有别的目标表，不想为第二张表再建一张台账。
--
-- ## 幂等
--
-- `add column if not exists` / `create table if not exists` / `create index if not exists`，
-- 与 0038 同一条口径：这张迁移能在已经跑过的库上再跑一次。
alter table requirements
  add column if not exists remark text;

comment on column requirements.remark is
  '备注：录入时随手记的一句上下文；汇总表「备注」列的唯一来源。null = 没写';

create table if not exists sheet_sync (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references requirements(id) on delete cascade,
  -- 'queue-sheet'：进待排期时写汇总表。以后多一个目标就多一个值，不建新表。
  target text not null,
  -- pending（已登记待写）/ ok（写成了，或表里已经有这一条）/ failed（写失败，下次重试）
  state text not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  appended_at timestamptz,
  -- 真正追加进表的那一行（11 格），失败时用来回答「当时准备写什么」。
  row_values jsonb,
  created_at timestamptz not null default now(),
  unique (requirement_id, target)
);

create index if not exists sheet_sync_pending_idx
  on sheet_sync (state, created_at)
  where state in ('pending', 'failed');

comment on table sheet_sync is
  '外部表格同步台账：一条需求一个目标一行。pending/failed 由 scripts/sheet-sync.ts 扫';

comment on column sheet_sync.row_values is
  '追加进汇总表的那一行（按列顺序的 11 个值）；失败时用于回答「当时准备写什么」';
