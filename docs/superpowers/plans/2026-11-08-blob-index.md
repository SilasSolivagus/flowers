# P4-11 第 2 步（第二版）：索引按**内容**做一次，树每次现读

日期：2026-11-08
分支：`main`（基于 `a94ad13`，第一版 `821cc4e` / `7267284` / `7609359`）
一句话：只缓存**贵的那一半**——一块内容（git blob id）说了什么；树是便宜的，每次装配
现读 `git ls-tree -r <sha>`。迁移 `0030` 删掉了第一版的 `tree_entry` 与旧的 `code_index`。

---

## 1. 两次推翻，一次比一次更接近账单

| 版本 | 形状 | 实测判词 |
|---|---|---|
| v0 | `code_index`：`(repo, sha)` → 整树 JSON 快照 | 建一份 **1017–1095 ms**（uni-app，141 文件）/ **1330 ms**（pc，137 文件）；改两个文件的提交要整份重建。两个仓能忍，139 个仓不能 |
| v1（0029） | `blob_index`（内容地址）+ `tree_entry`（按提交 `path → blob`） | 内容层对了（两仓 HEAD 合计 **277 行**、增量 6 块 / 1 块）；提交层错了——**一个提交就是一整棵树**：638 / 575 行，4 个提交 2422 行，139 个仓 × 几千个提交 = 几百万行，而它存的只是 git 用 0.3 秒就能重新列出来的东西 |
| v2（0030，本版） | **只有 `blob_index`** | 装配 = 现读 `ls-tree` + 按 `blob_sha` join。行数与提交数**无关** |

结论写成一句话：**解析文件内容是贵的（值得缓存），列一棵树是便宜的（不值得缓存）**。

## 2. 形状

迁移 `0029_blob_index.sql` 建表，`0030_drop_tree_entry.sql` 删掉 `tree_entry` 与
`code_index`。今天库里与这套索引有关的只有一张表（`schema.ts` 的 `blobIndex`）：

```sql
create table blob_index (
  blob_sha    text primary key,   -- git blob id：内容地址，不按 repo、不按 path 分
  lang        text,               -- 第一次见到它时路径的扩展名（ts / vue / …）
  size        integer not null,
  symbols     jsonb   not null,   -- 这块内容的导出符号
  imports     jsonb   not null,   -- 向外的引用（未解析，见 §3）
  parsed_at   timestamptz not null default now()
);
```

装配一个 `(repo, sha)`（`core/codemirror/index-store.ts` 的 `assembleFor()`）：

1. **现读树**：`git ls-tree -r -l -z <sha>`（一次 ssh 往返，返回 path + blob id + size）。
   这就是 `tree_entry` 被删掉之后替代它的东西——同一份信息，git 每次现给，不占我们一行存储；
2. `select … from blob_index where blob_sha in (…)`：库里已有的解析结果（一次查询，141 块 ≈ 4 ms）；
3. 树里有、库里没有的块 → **一次 `git cat-file --batch` 读回来、解析、写回**（自愈：
   一个提交在完整同步之前被读过、或有人删过几行，下一次装配就补齐；写回是
   `on conflict do nothing`，两个请求同时自愈同一块内容也不会互相覆盖）；
4. `assembleIndex()`：说明符对着**这一棵树**解析（见 §3），拼出 `{ files, imports, routes }`。

`repoIndex()` / `readIndex()` 的返回类型没有任何变化：`src/core/locate/*` 与评审路径
消费的还是 `CodeIndex`，一行没动。

## 3. 导入解析的决定：存**说明符**，读的时候解析

`blob_index.imports` 的实际形状（一块 blob 的「向外引用」，全部未解析）：

```jsonc
{
  "specs":  ["@/components/B", "./x"],              // import / require / import() 的说明符
  "locals": { "Search": "pages/Search/Search" },    // 默认导入 / lazy() 的本地名 → 说明符
  "routes": [                                        // 路由声明（path + 标题 + 组件引用）
    { "kind": "router", "route": "/search", "title": "search", "ident": "Search", "spec": "" }
  ]
}
```

为什么不存解析后的仓内路径——三条实测理由：

1. **同一块内容在不同仓里落到不同文件**。夹具里逐字节相同的两块内容，同一句
   `@/services/share` 在仓一解析成 `src/services/share.ts`、在仓二（没有 `src/`）靠后缀
   兜底解析成 `app/services/share.ts`。存下来的那一份必然是其中一个仓的答案，另一个仓
   就会指错文件。`tests/blob-index.test.ts` 有一条用例钉这个。
2. **路由表的 `component: Search` 要经过本地名映射**，而映射是「这块内容自己的事实」
   （`import Search from 'x'` 与 `import { Search } from 'x'` 语义不同）。
3. 解析需要**整棵树**（别名指向哪、`./x` 相对哪个目录、谁的路径以它结尾），而整棵树
   现在是现读的——它本来就不在我们库里。

`lang` 同样只依赖「第一次见到它时路径的扩展名」：符号抽取只在一处用到路径——
判断是不是 `.vue`（`<script setup>` 没有 `export`，顶层声明就是符号）。所以
`parseBlob()` 用 `index.<lang>` 这个假路径调用 `exportsOf()`，结果与真路径逐字相同。

## 4. 实测（dogyun，2026-11-08）

```bash
export FLOWERS_MIRROR_TRANSPORT=ssh FLOWERS_MIRROR_SSH_HOST=dogyun
export FLOWERS_MIRROR_REPOS='[{"id":"123pan-uni-app","path":"/srv/123pan-mirror/123pan-uni-app.git"},
                             {"id":"123pan-pc","path":"/srv/123pan-mirror/123pan-pc.git"}]'
npx tsx scripts/index-sync.ts --repo 123pan-uni-app          # 首建 / 预热
npx tsx scripts/index-sync.ts --repo 123pan-uni-app          # 第二次：必须 0 块新内容
npx tsx scripts/index-sync.ts --repo 123pan-pc --sha <sha>   # 增量
```

### 4.1 解析（贵的那一半）——与 v1 一致，本版没有动它

| | 123pan-uni-app | 123pan-pc |
|---|---|---|
| HEAD | `5eaa03cd` | `afff7295` |
| 树里的文件 | 638 | 575 |
| 源码文件（`ts/tsx/js/jsx/mjs/cjs/vue`） | 180（进索引 141） | 283（进索引 137） |
| **首建解析的 blob** | **141** | **136** |
| **去重比（解析块 / 树文件）** | **22.1 %**（141 / 638） | **23.7 %**（136 / 575） |
| 源码文件 → 内容（仓内去重） | 180 → 141（1.28×） | 283 → 136（**2.08×**） |
| 首建耗时（新形状，含解析 + 写库） | 1429 ms | 1344 ms |
| 首建耗时（旧路径，同一会话 A/B） | 1545 ms | 2386 ms |
| 第二次同 sha | **0 块新内容** | **0 块新内容** |
| 增量：更早的合并 | `c570fba5`（间隔 16 个提交）**6 块新内容**、复用 133、620 ms | `2f90d8ff`（`release-prof`，间隔 4 个提交）**1 块新内容**、复用 135、526 ms |
| 索引内容与旧路径逐字比 | `files` / `imports` / `routes` **全等**（40980 字节、580 导入、27 路由） | 全等（38279 字节、506 导入、3 路由） |

### 4.2 装配（这一版新增的账单）

`assembleFor()` 是热路径（每次 `repoIndex()` 都要一次）。同一进程内、缓存绕开：

| | 123pan-uni-app | 123pan-pc |
|---|---|---|
| **cold**（进程内第一次，含 ssh 握手） | **248 ms** | **373 ms** |
| **warm**（同进程第二次，握手与远端页缓存热了） | **234 ms** | **304 ms** |
| **进程内缓存命中**（同一个 `(repo, sha)` 第二次） | **0.01 ms** | **0.01 ms** |
| 旧路径：读一行 `code_index` jsonb（41 KB / 38 KB，5 次取最小） | **3.7 ms** | 3.7 ms |

拆开看（3 次取最小，warm）：

| 段 | uni | pc | 说明 |
|---|---|---|---|
| `ls-tree -r -l -z` | **158 ms** | **170 ms** | 一次 ssh 往返；**每次装配都要付** |
| `select … where blob_sha in (141/137 个)` | 4.0 ms | 3.9 ms | 内容行的 join |
| `assembleIndex()`（纯内存） | 48.5 ms | 73.8 ms | 说明符解析 + 路由装配 + 后缀匹配 |
| 合计 | ≈ 210 ms | ≈ 248 ms | |

**诚实结论：现读装配在每一次未命中缓存的调用上都比旧路径慢 ~60–80 倍**
（3.7 ms → 210–370 ms）。这就是这笔交易的正反面：

- 换到的是：**表不随提交数增长**（旧 `code_index` 是「仓 × 提交」份快照；v1 的
  `tree_entry` 是「文件 × 提交」行），139 个仓时是 O(内容) 而不是 O(内容 × 提交)；
- 付掉的是：每次 `repoIndex()` 一次 `ls-tree`（150–170 ms）+ 一次内存装配（50–75 ms）。

所以配了一个**有界的进程内缓存**（§5）。走查/评审里 `repoIndex()` 对同一个 sha 常被
问好几次（`inspect` 一次、`review` 再一次），缓存把那几次拉回 0.01 ms；而它不落库、
不跨进程、上限 8 条。

### 4.3 `blob_index` 行数（139 个仓的规模指标）

| | 行数 |
|---|---|
| 两个仓的 HEAD | **277 行**（141 + 136，跨仓重叠 0） |
| 加上那两次更早提交新引入的 7 块 | **284 行**（88 KB） |
| 0030 迁移前后 | **284 → 284**（删 `tree_entry` / `code_index` 一行内容都没动） |

277 行 = 两个仓 278 个进索引文件的**全部内容**。按这个比例，139 个仓 × 约 140 个文件
≈ **1.9 万行**——这才是 139 个仓的账单（v1 的 `tree_entry` 是「几千个提交 × 600 行」）。

## 5. 为什么是有界缓存，而不是另一张表

`ASSEMBLE_CACHE_MAX = 8`，键是 `(repo, sha)`，值是装配好的 `CodeIndex`：

- **只留 8 条**：一轮走查/评审最多同时看几个仓，8 条足够覆盖「同一轮里反复问同一个 sha」，
  也不会把几十个历史提交的装配结果攒在内存里；
- **不落库、不跨进程**：进程退出就没了，重启后第一次装配付一次 210–370 ms——这是可接受的；
- **可失效**：`forgetBlobs()` / `dropIndex()` / `syncRepoIndex()` 都会清掉它。凡是动过
  `blob_index` 的路径都清缓存，所以它不会把旧内容喂给新请求；
- `repoIndex(..., { rebuild: true })` 绕过它。

它**不是** `tree_entry` 的还魂：那张表按提交存映射（几百万行、跨进程持久）；
这个缓存按内容装配结果存（8 条、内存、进程内）。「不随提交数增长」这条性质两边都成立，
但只有后者不需要写任何一行。

## 6. 旧表的下场（0030）

| 表 | 处置 | 为什么安全 |
|---|---|---|
| `code_index` | **drop** | 没有代码读它（`repoIndex` / `readIndex` / 脚本全部改完），没有外键指向它；它作为「与旧路径逐字对比」的对照物已经完成使命（§4.1 那两行就是它的墓志铭） |
| `tree_entry` | **drop** | 同上；而且它按 `文件 × 提交` 增长，139 个仓时是几百万行——留着就是留一个会爆的缓存 |

`reset.ts` 的 `KEPT_TABLES` 现在只剩 `['blob_index']`（同一条判断：没外键、`cascade`
带不到、重建要扫镜像 + 解析）。`tests/reset.test.ts` 里那条「清单即声明」的用例
跟着把 `code_index` 换成 `blob_index`。

## 7. 三个 brief 回答

**① `pages.json` 不在 `CODE_EXT` 里，`parsePagesJson` 是死路径。**
是一行改动（`CODE_EXT` 加 `json`），但**不是这一轮该做的**：加了它，索引内容会变
（uni-app 会多出 `pages.json` 这一条 `route` 类文件、路由条数从「27 条目录约定」变成
「27 条 + 真路由表的 27 条」去重后的结果），而本轮唯一能证明「没搞坏定位」的证据就是
「与旧路径逐字相同」（§4.1）。它值得做，做完应该重跑 `scripts/compare-locate.ts`。
它**会更好**：目录约定只能给 `pages/<dir>/<name>` 这一层、拿不到标题
（`navigationBarTitleText`）、也拿不到子包与 `subPackages`；真 `pages.json` 给的是
「注册过的路由 + 标题」，`route` 命中（权重 10）会从「猜」变成「读」。前提是先确认
`resolveSpecifier(route, 'pages.json', files)` 在这两个仓上的命中率（27 条里有多少条
真落到文件），否则它会变成 27 条解不出文件的路由，`routesWithoutFile` 会涨。

**② 整棵树都是噪音的提交会重复 `ls-tree`。** 可以接受：那种提交在我们的两个仓里
不存在（噪音是「混在源码里」的 `dist/`，不是「整棵树只有 dist」）；即使出现，代价就是
每次装配多一次 `ls-tree`（150–170 ms），而**没有正确性损失**——装配出来的就是一份空
索引（与后端仓同一个出口：退回 grep）。用一张「已索引的提交」表去省这 150 ms，就把
`tree_entry` 那个错误按另一种形状买回来了：那张表按提交增长，而它省下的是 git 最擅长
的那件事。

**③ `code_index` 可删。** 已在**同一个 `0030` 迁移**里删掉了（`drop table code_index`）。
判据是「有没有人读」：`grep -r code_index src tests scripts` 只剩注释，`scripts/index-repo.ts`
的统计已改报 `blob_index`，`tests/reset.test.ts` 里对它的探针换成了 `blob_index`。
留在 schema 里只会让下一个人以为它是缓存。

## 8. 变异表

| 用例（`tests/blob-index.test.ts`，7 条） | 打到哪个变异 | 变异后的现象 |
|---|---|---|
| 两个提交共享一个没变过的文件 → 只读一次、`parsed_at` 不变 | 装配不查 `blob_index`、每次重解析 | 那两块内容出现在 `readBlobs` 的请求里，`parsed_at` 变新 |
| 同一个提交同步两次：0 块新内容 | `on conflict do nothing` 改成 `do update` | `newBlobs` 不为 0 |
| 两个仓共享一块内容 → 只解析一次 | `blob_index` 主键带 `repo`（或 path） | 仓二 `newBlobs` 变 2 而不是 1 |
| 缺一块 → 当场解析并写回；下一次不再解析 | 缺内容时跳过（不自愈） | `parsedBlobs` 为 0、文件数少一个、那块内容永远补不上 |
| 装配两次不会重复插内容行 | 写回不看冲突 | 行数从 6 变 7+ |
| 旧提交的文件集不是 HEAD 的（新文件不出现、符号是旧版） | 装配用 HEAD 的树（或按路径缓存符号） | 旧提交里出现 `share-badge`，或 `shareStats` 提前出现 |
| 装配 == 一次性全量解析（`files`/`imports`/`routes` 全等） | 把**解析后的仓内路径**存进共享 blob 行 | 仓二的 `app/pages/...` 读到仓一的 `src/services/share.ts` |

`tests/index.test.ts`（16 条，本轮改动只有「收口方式」）：`dropIndex` 从「删提交行」变成
「清装配缓存」，`beforeAll` / `afterAll` 从「按 sha 删 `code_index` 行」变成「按 blob id
`forgetBlobs`」；`建一次是两次往返` 那条的准备步骤保留（`forgetBlobs` 之后才量得到
「必须解析时几次往返」）。

全量：**65 个文件 / 1439 条通过、1 条跳过**（`npx vitest run`）。

## 9. 这次仍然**没有**解决什么

- **没有全文 / 向量索引**：仍然只有「路由 / 名字 / 导入 / 符号」四种信号。正文一个字节
  都没留；正文检索与语义相似度是后面的阶段。
- **每次装配付一次 `ls-tree`**（150–170 ms）：缓存只救「同一进程里同一个 sha 的重复提问」，
  跨进程的第一问永远要付。要更快只有两条路，都不是这一轮该选的：持久化（＝把
  `tree_entry` 买回来）或让镜像侧常驻一个服务。
- **装配是内存里的 O(路径 × 说明符)**（50–75 ms）：`resolveSpecifier()` 的后缀兜底要扫
  整棵树的路径。141 个文件时能忍，1000 个文件的仓会变成几百毫秒——那时该先优化的是
  后缀匹配（建一次 `path → stem` 索引），不是缓存。
- **`parseBlob` 只吃前 80 行**（`HEAD_LINES`）：导出声明在第 80 行之后的文件抽不到符号。
  这一条与旧版一致。
- **`lang` 依赖「第一次见到它的路径」**：同一块内容若在两个仓里分别以 `.ts` 与 `.vue`
  出现（现实中不会有：`.vue` 的内容里有 `<template>`），符号抽取会沿用第一眼的扩展名。
- **并发**：两个请求同时装配同一个新提交时都会解析同一批内容，`on conflict do nothing`
  保住先写的，另一边白解析一次。没有正确性问题（与旧版相同的结论）。
