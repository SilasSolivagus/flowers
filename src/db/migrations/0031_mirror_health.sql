-- 镜像健康（0031）：夜间索引**已经知道**的事，落一行。
--
-- ## 它修的是哪一种坏法
--
-- 新鲜度是一条三环链：服务器 cron 05:05 从 codeup 抓 → Mac launchd 05:10 索引新 blob →
-- 材料上写「代码快照：<仓> @ <日期>」。2026-11-08 那天第一环**坏了**：从服务器
-- `codeup.aliyun.com` 解析得出来但 HTTPS 连不上（`000`），三个仓全部 `rc=128`，
-- 而唯一的痕迹是服务器上的 `/var/log/sync-flowers-mirror.log`——没有人读它。
-- 与此同时 `123pan-cross-frontend` 还停在 2026-10-21，而材料上那句「代码快照较旧」
-- 只有**下一次生成材料时**才会出现，是**被动**兜底。
--
-- 所以这张表只做一件事：把「今晚每个仓的 HEAD 是哪一天、这次同步成不成、为什么不成」
-- 从日志里搬到库里，让读侧（`src/core/codemirror/health.ts`）能把它变成一条通知。
--
-- ## 为什么是一张表，而不是给 `app_settings` 加几个键
--
-- 日志是**一行一轮**的流水，要回答的是「现在这个仓是什么状态」——那是**每仓一行**的
-- 形状（主键 `repo`）。键值对的 `app_settings` 会让 `head_date` 的比较落在 JSON 字符串
-- 上，而这张表的判据是「HEAD 的提交日期距今几天」，是一个日期比较。
--
-- ## `head_date` 是**提交日期**，不是检查时刻
--
-- 这两列必须分开，否则整件事没有意义：`checked_at` 每次都变（它证明索引跑过），
-- `head_date` 只在**真的前进**时变（它证明代码是新的）。合成一列之后，「今晚跑过了、
-- 但拉到的代码和上周一样」会看起来像新鲜的——那正是要抓的那一类静默失败。
--
-- ## 失败时**不抹掉**上一次已知的 HEAD
--
-- 一次 `ssh` 连不上的夜里，`head()` 什么都拿不到。如果那时把 `head_sha` / `head_date`
-- 清成 null，读者就再也说不出「它停在 2026-10-21」——而这恰好是最该说的那句话
-- （通知正文：「<仓> 的镜像停在 <日期>（N 天前），上次同步失败：<原因>」）。
-- 所以写入口（`recordMirrorHealth`）用 `coalesce(excluded.head_sha, mirror_health.head_sha)`
-- 保留旧值，只把 `ok` / `error` / `checked_at` 刷成本轮的结果。
--
-- 没有外键、没有序列：`repo` 就是配置里的仓名（`app_settings.code.mirror.repos` 的 `id`），
-- 两侧都对它 stringly 相等。仓从配置里删掉之后那一行仍在——读侧按**当前配置**遍历
-- （不是按这张表的行遍历），所以遗留行不会造成「删掉的仓永远在报警」。
create table if not exists mirror_health (
  -- 仓名（配置里的 id），一仓一行。
  repo        text primary key,
  -- 上一次**读到**的 HEAD 完整 sha；一次都没读到过时是 null（空仓 / 第一次就失败）。
  head_sha    text,
  -- 那个提交的提交时间（`git log -1 --format=%cI`），**不是**检查时刻。
  head_date   timestamptz,
  -- 这一轮检查的时刻（每次覆盖）。谁想知道「索引多久没跑了」就读它。
  checked_at  timestamptz not null default now(),
  -- 这一轮成不成：读 HEAD 失败、仓还是空的、索引同步失败，都是 false。
  ok          boolean not null,
  -- `ok = false` 时的一句中文原因（直接进通知正文，不是错误码）。
  error       text
);

comment on table mirror_health is
  '每个镜像仓最后一次检查的结果（夜间索引写，0031）：HEAD 提交日期 + 成不成 + 中文原因';
comment on column mirror_health.head_date is
  'HEAD 的提交日期，不是检查时刻；失败时保留上一次已知值（读侧靠它说「停在哪天」）';
comment on column mirror_health.checked_at is
  '本轮检查时刻（每次覆盖）；它变而 head_date 不变 = 跑过了但代码没前进';
