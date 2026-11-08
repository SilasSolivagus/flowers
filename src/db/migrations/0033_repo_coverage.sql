-- 仓覆盖率（0033）：从 3 个仓走到 ~139 个仓之前，先量一次「索引到底能看见什么」。
--
-- ## 这张表回答哪一个问题
--
-- 「这个仓接进来了」有两个完全不同的意思：
--   a) 服务器上有一个 bare 镜像，`git ls-tree` 能列文件；
--   b) 那些文件**真的进了索引**——被解析成 symbols / imports / pages / outline，
--      走查与评审从里面挑得出候选。
-- 两者之间会断：`pages.json` 不是合法 JSON（uni-app 的条件编译注释）、整仓是打包产物、
-- 解析器只认 [ts|tsx|js|jsx|mjs|cjs|vue]、镜像里只有非源码目录…… 断开时镜像「同步
-- 成功」、`mirror_health` 一片绿，而材料上写着「没找到相关代码」。
--
-- 所以每仓一行、每次测量一行结论：**树里有多少文件、索引真正吃进去多少、出来几张页面、
-- 几个文件有轮廓、几条 import**。这几个数放在一起，一眼能看出是「仓里没代码」还是
-- 「我们的解析器没认出它」——这两种坏法的下一步完全不同，而它们在被测之前长得一样。
--
-- ## 为什么不是给 `mirror_health` 加几列
--
-- 那一张是**每晚**覆盖的流水（`checked_at` 每次变，「它现在健康吗」），而这里是
-- **每次接入**的一次快照：「这个仓接进来那天，我们看见了什么」。两者的写入节奏差了
-- 两个数量级（139 个仓 × 每晚 vs 139 个仓 × 一次），合成一张会让「昨晚跑过了」把
-- 「接入时的覆盖率」刷掉——那正是下一次要对比的基线。主键也不同：这里按 `repo`
-- 一仓一行（同一 HEAD 重测覆盖），和 `mirror_health` 恰好一致，但语义是快照不是心跳。
--
-- ## 为什么没有外键、为什么不在 `reset.ts` 的 `RESET_TABLES` 里
--
-- 与 `blob_index` / `mirror_health` 同一条理由：没有外键、存的是 ssh 镜像里真实提交的
-- 状态，重建要重新跑一次批量接入（几十分钟的 clone + 解析）。用例自己收口：`repo_coverage`
-- 的用例只用 `fixture-` 前缀的仓名，跑完删掉自己那几行。
--
-- ## `head_date` 是提交日期，不是测量时刻
--
-- 与 0031 同一个坑：`measured_at` 变说明「测过」，`head_date` 变才说明「代码前进了」。
-- 合成一列之后，「今晚跑过了、但 HEAD 和上周一样」会看起来像新测的——那是**应该**被
-- 跳过的（见写入口的续跑判据：同 HEAD 且 ok 就不重测），不是应该被记成新结果的。
create table if not exists repo_coverage (
  -- 仓名（`config/repos.txt` 的仓名 = `code.mirror.repos` 的 id），一仓一行。
  repo           text primary key,
  -- 测量时镜像 HEAD 的完整 sha。续跑的判据就是它：同 sha 且上一轮 ok，本轮跳过。
  head_sha       text,
  -- 那个提交的**提交时间**（`git log -1 --format=%cI`），不是测量时刻。
  head_date      timestamptz,
  -- `git ls-tree -r` 在这个提交上的文件数（已去噪音：dist / asar / 锁文件不计）。
  files_total    integer not null default 0,
  -- 索引里真正有行的文件数（`CodeIndex.files` 的键数）。**与 files_total 的差就是要解释的那部分**。
  files_indexed  integer not null default 0,
  -- 页面清单条数（`pages.json` 说的 + 目录约定补的）。
  pages          integer not null default 0,
  -- 有结构轮廓的文件数（`.vue` template 组件 / `.tsx` JSX 标签 / `.ts` 导出符号）。
  outline_files  integer not null default 0,
  -- 仓内 import 边数（跨仓/外部包不计）。
  imports        integer not null default 0,
  -- 这一轮成不成：镜像建不出来、HEAD 读不到、索引失败，都是 false。
  ok             boolean not null,
  -- `ok = false` 时的一句中文原因（直接进批量汇总的失败清单，不是错误码）。
  error          text,
  -- 本轮测量时刻（每次覆盖）。它变而 head_sha 不变 = 重测了同一个提交。
  measured_at    timestamptz not null default now()
);

comment on table repo_coverage is
  '每个镜像仓接入时的覆盖率快照（0033）：树里多少文件 / 索引吃进多少 / 页面 + 轮廓 + import，一仓一行';
comment on column repo_coverage.files_total is
  'HEAD 树里的文件数（去噪音后）；files_indexed 与它的差 = 索引看不见的那部分';
comment on column repo_coverage.files_indexed is
  '索引里有内容的文件数（CodeIndex.files 键数），不是「可索引文件数」——后者是上限，不是结果';
comment on column repo_coverage.head_sha is
  '测量时的 HEAD；续跑据此跳过（同 sha 且 ok=true 不重测，除非 --force）';
