-- 页面清单与组件轮廓（Task 1/2）：让索引能回答「有哪些页面、每页用了哪些组件」。
--
-- ## 为什么加在 `blob_index` 上，而不是按提交存
--
-- 一次走查最常见的坏结论是「这个页面缺一个搜索框」——而搜索框可能已经在那一页的
-- `<template>` 里。要反驳它，需要的只是「这一页 template 里有哪些大写开头的标签」。
-- 这笔扫描的输入是**一块内容**，所以它和 `symbols` / `imports` 一样落在内容地址上：
-- 同一块 `.vue` 在 40 个提交、2 个仓里只有一行、只扫一次。按提交存会退回到 0029/0030
-- 已经推翻过的形状（一个提交就是一整棵树，行数按「文件 × 提交」增长）。
--
-- ## 两列各存什么
--
-- `outline`：`.vue` 的 template 里用到的组件（大写开头的标签 + 全文行号）。
-- 只做 template、只做 vue 是刻意的分层：进 script 解析 AST 是 Phase 3（tree-sitter）
-- 的事，而这一层要回答的那个问题不需要它。
--
-- `pages`：`pages.json` 自己说的页面清单（`route` + `navigationBarTitleText`）。
-- 真实的 `pages.json` 不是合法 JSON（uni-app 的条件编译注释让 `JSON.parse` 整份失败），
-- 所以那份清单由 `code-index.ts` 的 `pagesFromConfig()` 读出来，再按内容地址缓存。
--
-- ## 为什么可空、以及**为什么这一列会一直空着**（I5 的裁决）
--
-- 这两列出现之前写下的行是 null。读侧（`blob-index.ts` 的 `readBlobRows`）把 null
-- 当成 `[]`：一块老内容只是「这一页还没有组件清单」，不是一次装配失败。
--
-- 这一段的旧注释写着「等下一次 `--force-reparse`（或内容自己变化）就会重解析」，**后半句
-- 在实践中不成立**，所以它被改掉：`writeBlobRows` 是 `on conflict do nothing`，而
-- `blob_sha` 是**内容地址**——一个文件的内容不改，它的 blob 不变，那一行就永远不会被重写。
-- 结论：任何在 0032 之前同步过、之后没跑过 `--force-reparse` 的仓，`outline` / `pages`
-- **永远是 null**。这不是「等一下就好」，而是「必须有人说一声」。
--
-- 因此这条迁移**不做回填**（回填要重读每一块 blob，而且 git 不在迁移进程能到达的地方）。
-- 诚实的做法分两处：
-- 1. **读侧按「没读到」处理**，不是按「确实没有」：`copy.ts` 的 `pagesOutlineMissing()`
--    发现某个仓的页面一个轮廓条目都没有时，`surfaces.ts` 会把这一仓从提示词清单里去掉，
--    并让 `complete = false` + 「这份清单不完整：…（可能还没按新口径重解析）」进材料。
--    绝不让材料写「这一页没有组件」。
-- 2. **补数据靠手工**：`npx tsx scripts/index-sync.ts --repo <仓> --force-reparse`（它会
--    `forgetBlobs()` 删掉跨仓共享的内容行，下一轮装配当场自愈重解析）。
--
-- 幂等：两列都带 `if not exists`；空库上它只是两次无害的 DDL。
alter table blob_index add column if not exists outline jsonb;
alter table blob_index add column if not exists pages jsonb;

comment on column blob_index.outline is
  '组件轮廓：[{kind,name,line}]（.vue 的 template 标签 / .tsx 的 JSX 标签 / .ts 的导出符号）；null 按 [] 读。注意：0032 之前索引过的内容不会被自动重解析（on conflict do nothing + 内容地址），必须 --force-reparse；整仓为空时读侧按「没读到」处理，不按「确实没有」';
comment on column blob_index.pages is
  'pages.json 自己说的页面清单：[{route,title,source}]；其它内容恒为 null；同样只有 --force-reparse 才会回填';
