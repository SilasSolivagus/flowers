-- 「生成代码」在覆盖率表上的独立一列（0034）。
--
-- ## 这一列回答哪一个问题
--
-- 0033 的判据是「`files_total - files_indexed` 就是要解释的那部分」。Go 仓接进来之后，
-- 这个差有了一大块**完全正当**的来源：`Code generated … DO NOT EDIT.` 的文件
-- （GoFrame 的 model / dao、protoc 的 `*.pb.go`、mockgen 的 mocks）。
-- `apisrv` 实测 583 个可索引文件里有 231 个是生成代码（39.6%）。
--
-- 不单开一列，覆盖率表会把「索引吃进了 352 个」写成「583 里只进了 352」，
-- 而下一个人对着这个差去查解析器——解析器没坏，是我们在**故意**跳。所以：
--
--   files_total = 583（树里可索引）
--   files_indexed = 352（真进了索引）
--   files_skipped_generated = 231（正当跳过，生成代码）
--   两者之和 = files_total（只剩「读不回来」这种真故障）
--
-- ## 为什么是加列而不是新表
--
-- 它与 `files_indexed` 是同一行、同一次测量、同一条写入路径（`recordCoverage`）。
-- 新表会让「索引看见了什么」这个问题要 join 两次才能回答，而它本来就该一眼看完。
--
-- ## 为什么 `not null default 0` 而不是可空
--
-- 「0」在这里是**真值**（这个仓没有生成代码），与 `files_indexed = 0` 同一个语义。
-- 可空会造出第三种含义（老行不知道），而老行本来就是 0（那时还没有这条规则）。
alter table repo_coverage
  add column if not exists files_skipped_generated integer not null default 0;

comment on column repo_coverage.files_skipped_generated is
  '因为「生成代码」（Code generated … DO NOT EDIT.）被跳过的文件数；与 files_indexed 之和 ≈ files_total';
