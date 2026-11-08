-- 静态索引改成**内容寻址**（P4-11 的第 1 步：索引一次，之后只做增量）。
--
-- ## 为什么推翻 `code_index` 的形状
--
-- 旧表主键是 `(repo, sha)`，值是一份**整棵树的 JSON 快照**（`files` / `imports` /
-- `routes`）。实测建一份要 1017–1095 ms（123pan-uni-app，141 个文件）与 1330 ms
-- （123pan-pc，137 个文件）——贵的原因不是解析，而是每次都要重新从镜像读整棵树。
-- 更要紧的是**新提交会强制整份重建**：改了两个文件，另外 139 个文件也重读、重解、重写。
--
-- 两个仓时这笔账能忍（一次 1 秒，一天几十次）。owner 的规划是 139 个仓，那时每个仓
-- 每个 HEAD 各建一份，就是 139 秒起、且每次提交再来一遍。所以这一层必须换成：
-- **同样的文件内容只解析一次，永远复用**。
--
-- ## 两张表的分工
--
-- `blob_index` 的键是 git 的 blob id ——**内容地址**。同一份内容出现在 40 个提交里、
-- 出现在两个仓里，都只有一行。它存的是「这块内容说了什么」：语言、大小、导出的符号、
-- 它引用的东西（说明符 / 本地名 / 路由声明，**全是未解析的字符串**，见
-- `src/core/codemirror/blob-index.ts` 的注释）。
--
-- `tree_entry` 是**唯一按提交存的东西**，而且只是一张映射表：`(repo, commit, path) →
-- blob`。一个改了 600 个文件里的 2 个的提交，只多 2 行。它不能省：一句话「这个提交上
-- 这个路径是什么内容」只有提交本身知道，而路径→内容的关系正是 `repoIndex()` 要还回去
-- 的那份 `CodeIndex`。
--
-- ## 为什么导入关系不落成「解析后的仓内路径」
--
-- 解析一条 `@/services/share` 需要**整棵树**（别名指向哪、`./x` 相对哪个目录、后缀匹配
-- 谁的路径以它结尾）。同一块 blob 在两个仓里可能落在不同的文件上——把它解析后的路径写
-- 进共享的 blob 行，等于把某一个仓的目录布局焊死在内容地址上。所以 `imports` 存的是
-- 说明符与本地名绑定，解析在**读的时候**、拿当前提交的树做。代价是每次读多几十次字符串
-- 比较（实测一次装配 3–8 ms），换来的是跨仓共享不掺假。
--
-- `lang` 只从**第一次见到它时的路径扩展名**推一次：符号抽取只关心「是不是 `.vue`」
-- （`.vue` 的 `<script setup>` 里没有 `export`，顶层声明就是它的符号）。这是唯一一处
-- 依赖路径的解析，所以它落成一列、且不参与主键。
--
-- `code_index` 不删：它还在 `schema.ts` 里、`reset.ts` 里按「故意留下」处理。新路径
-- 不再写它，读也不再读它（`repoIndex()` 完全走这两张表）。留着的理由只有一条：
-- 演示库里那 32 行是上一版实测的对照数据，删表容易，重建那份对照要重扫镜像。等这份
-- 新形状在 139 个仓上站住了，0029 的下一步就是 drop table。
create table blob_index (
  -- git blob id（`ls-tree -r -l` 的第三列）。**内容地址**：不按 repo、不按 path 分。
  blob_sha    text primary key,
  -- 第一次见到这块内容时，路径的扩展名（ts / tsx / js / jsx / vue / mjs / cjs）。
  lang        text,
  -- 字节数。`CodeIndex.files[].size` 直接取它，所以它必须是 blob 自己的大小。
  size        integer not null,
  -- 导出符号：`["searchFiles","shareLink"]`。
  symbols     jsonb   not null,
  -- 这块内容向外的引用，**未解析**：`{ specs, locals, routes }`。
  imports     jsonb   not null,
  -- 解析时刻。用例用它钉「同一块内容不会被解析第二次」。
  parsed_at   timestamptz not null default now()
);

create table tree_entry (
  repo        text not null,
  commit_sha  text not null,
  path        text not null,
  blob_sha    text not null,
  primary key (repo, commit_sha, path)
);
