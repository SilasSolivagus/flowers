-- 存量产物「内容已被覆盖」的如实标注（2026-11-10 的第一次纠正）。
--
-- ## 这一条修的是什么
--
-- 2026-11-10 之前产物按**固定文件名**落盘：`data/uemaster/PAN-47/evaluate.html`。
-- 同一条需求生成两次，`uemaster_artifacts` 里是两行，磁盘上只有一份文件——后一次
-- 生成把前一次覆盖掉了。于是：
--
--   * 库说「存过两版」；
--   * 盘上只有一版，而且它装的是**后一版**的内容；
--   * 抽屉里两行都指向同一个链接，点开都是同一份材料。
--
-- 实测（迁移前）：7 组 (requirement, stage, url) 共享同一个链接，多出 13 行；
-- PAN-47 就是两行一行文件的那个例子。
--
-- ## 为什么是「标注」而不是「修复」
--
-- 被覆盖的字节**拿不回来**了：那是一次 write，不是一次删除，没有副本、没有快照。
-- 所以这一条迁移只做一件事——把「这一行的内容已经不在磁盘上」这件事记下来，
-- 让界面能如实说「更早的版本内容已被覆盖，无法恢复（当时按固定文件名保存）」，
-- 而不是把两行画成两个可以点开的历史版本（那是在编数据）。
--
-- 不删行：行是「当时确实生成过一次」的证据，删掉等于抹掉那次发生过的动作。
-- 不猜内容：不生成占位文件、不把最新那份拷成旧版的副本——那是伪造历史。
--
-- ## 判据
--
-- 同一 (requirement_id, stage) 内，**同一个 url 有多行**时，除了最新的那一行
-- （`created_at` 最大；同一时刻用 `id` 定序，与读侧的 `created_at desc, id desc`
-- 同一套），其余都是「被覆盖过的」：它们指向的文件后来又被写过一次。
--
-- 最新那一行**不标**：那个文件当前装的内容确实就是它写的那一份。
--
-- 为什么只认「同 url」：不同 url 的两行（时间戳文件名 `evaluate-<ms>.html`、或
-- 2026-11-10 起的 `evaluate-v001.html`）本来就是两份不同的文件，谁也没覆盖谁。
--
-- 幂等：`add column if not exists`；update 只写 false → true 的那一批，跑第二次
-- 影响 0 行（判据只看行与行之间的关系，而那次 update 不改 created_at / url）。
alter table uemaster_artifacts
  add column if not exists content_lost boolean not null default false;

update uemaster_artifacts a
   set content_lost = true
 where exists (
   select 1
     from uemaster_artifacts b
    where b.requirement_id = a.requirement_id
      and b.stage = a.stage
      and b.url = a.url
      and (
        b.created_at > a.created_at
        or (b.created_at = a.created_at and b.id > a.id)
      )
 );

comment on column uemaster_artifacts.content_lost is
  '这一行的内容已被后来的一版覆盖（固定文件名时代的存量数据）；true 表示无法恢复，只能如实标注';
