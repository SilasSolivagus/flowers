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
-- ## 为什么可空、以及为什么旧行不用回填
--
-- 这两列出现之前写下的行是 null。读侧（`blob-index.ts` 的 `readBlobRows`）把 null
-- 当成 `[]`：一块老内容只是「这一页还没有组件清单」，不是一次装配失败。回填要重读
-- 每一块 blob，而正确的做法是等下一次 `--force-reparse`（或内容自己变化）——那时
-- 它会按新口径重解析一次。
--
-- 幂等：两列都带 `if not exists`；空库上它只是两次无害的 DDL。
alter table blob_index add column if not exists outline jsonb;
alter table blob_index add column if not exists pages jsonb;

comment on column blob_index.outline is
  'template 里的组件使用（Task 2）：[{kind,name,line}]；只做 .vue，null 按 [] 读';
comment on column blob_index.pages is
  'pages.json 自己说的页面清单（Task 1）：[{route,title,source}]；其它内容恒为 null';
