-- 作业的「还有没有人在替我干活」与「用户自己停的」（0035）。
--
-- ## 这一条修的是哪一次事故
--
-- dev server 重启把 detached worker 带走了，`uemaster_jobs` 里留下一条 `running`：
-- 抽屉那一行写着「评估材料 · 正在生成页面片段 1:29:12 · 第 2 次尝试」，转了 90 分钟。
-- 没有进程在跑，也就没有任何人会把它写成 done / failed；界面上的秒表按本地时钟继续跳，
-- 看起来像「还在动」。owner 只能手工 `UPDATE 1` 才把这行收掉——产品不该需要他这么做。
--
-- ## 三个新东西，各回答一个问题
--
-- `worker_pid`：**谁在跑**。`process.kill(pid, 0)` 能当场回答「它还活着吗」。
--   为什么记 pid 而不是只靠时间：时间只会说「它跑了很久」，pid 说的是「没有人在跑」。
--   一条 pid 已经不在的 running 行不是「状态未知」，而是**确定不会再变**——那个能写它
--   的进程没了，作业 id 也不会被复用。所以读侧可以直接收成 failed，不必等一个阈值。
--
-- `heartbeat_at`：**它最后一次说自己还活着**是什么时候。pid 可能为空（0035 之前的老行、
--   或者 spawn 之后 pid 还没写回的那一瞬），此时 pid 什么也证明不了；心跳是那一格的
--   补位，也是「进程活着但卡死」的唯一线索（例如 CLI 挂在一次网络请求上）。
--
-- `canceled`：**用户按了停止**。为什么不折成 failed：这两件事在界面上是两句不同的话
--   （「生成失败：…」vs「已手动停止」），在时间线里也不该混——一个是程序出事，
--   一个是人的决定。`failed` 里塞一个「已手动停止」的错误串，会让「失败率」这种
--   数字从此说不清。
--
-- ## 为什么加列而不是新表
--
-- 它与 `status` / `created_at` 是同一行、同一条读取路径（`jobStatus` / 进度卡 / 抽屉）。
-- 新表会让「这条作业还活着吗」从一次读取变成一次 join，而这一格每 2 秒被问一次。
--
-- ## 为什么 `worker_pid` 可空、`heartbeat_at` 也可空
--
-- 老行没有这两格。可空 = 「这一行不知道自己是谁在跑」，回收判据于是退到心跳、再退到
-- 绝对年龄上限（见 `src/core/uemaster/liveness.ts`：三档判据，越靠前越确定）。
alter table uemaster_jobs
  add column if not exists worker_pid   integer,
  add column if not exists heartbeat_at timestamptz;

-- 状态多一档：canceled。CHECK 只能整条重下——PG 没有「给 CHECK 加一个值」的语法。
--
-- 顺序（先 drop 再 add）在这张表上安全：此刻库里没有任何 `canceled` 行，也没有写入
-- 正在改 status（迁移跑在服务起来之前）。
alter table uemaster_jobs drop constraint if exists uemaster_jobs_status_check;
alter table uemaster_jobs add constraint uemaster_jobs_status_check
  check (status in ('running', 'done', 'failed', 'canceled'));

comment on column uemaster_jobs.worker_pid is
  '跑这条作业的 worker 进程号（可空：老行 / spawn 前那一瞬）；pid 不在 = 这条作业永远不会有下文';
comment on column uemaster_jobs.heartbeat_at is
  'worker 最后一次报到（running 时每 15 秒一次）；pid 为空时用它判断「活着但卡住」';
comment on column uemaster_jobs.status is
  'running | done | failed | canceled；canceled 是用户按了「停止」，不是程序失败';
