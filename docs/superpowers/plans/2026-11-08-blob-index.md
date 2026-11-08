# P4-11 第 2 步：索引按**内容**做一次，之后永远增量

日期：2026-11-08
分支：`main`（基于 `a94ad13`）
一句话：把 `code_index`（`(repo, sha)` → 整棵树的 JSON 快照）换成
`blob_index`（**git blob id** → 这块内容说了什么）+ `tree_entry`（按提交的
`path → blob` 映射）。同一块内容只解析一次；改一个文件的提交只多一块内容。

---

## 1. 为什么推翻旧形状（那张实测账单）

| | 旧形状的事实 |
|---|---|
| 建一份索引 | **1017–1095 ms**（`123pan-uni-app`，141 个文件）、**1330 ms**（`123pan-pc`，137 个文件） |
| 主键 | `(repo, sha)`，值是 `files` / `imports` / `routes` 三份整树 JSON |
| 新提交 | 主键换一半 → **整份重建**：改 2 个文件，另外 139 个也重读、重解、重写 |

两个仓时这笔账能忍。owner 的规划是 **139 个仓**：那是 139 秒起，而且每次提交再来一遍——
其中 98% 的工作是在重解析**没有变过**的字节。所以这一层必须换成「同样的内容只解析一次」。

## 2. 新形状

迁移 `0029_blob_index.sql`（`schema.ts` 里对应 `blobIndex` / `treeEntry`）：

```sql
create table blob_index (
  blob_sha    text primary key,   -- git blob id：内容地址
  lang        text,               -- 第一次见到它时路径的扩展名（ts / vue / …）
  size        integer not null,
  symbols     jsonb   not null,   -- 这块内容的导出符号
  imports     jsonb   not null,   -- 这块内容向外的引用（未解析，见 §3）
  parsed_at   timestamptz not null default now()
);

create table tree_entry (
  repo        text not null,
  commit_sha  text not null,
  path        text not null,
  blob_sha    text not null,
  primary key (repo, commit_sha, path)
);
```

- **`blob_index` 是内容地址**：不按 repo、不按 path 分。同一份内容出现在 40 个提交里、
  出现在两个仓里，都只有一行。
- **`tree_entry` 是唯一按提交存的数据**，而且只是一张映射表。
- 噪音路径（`dist/`、`node_modules/`、二进制）不进 `tree_entry`：`lsTreeEntries` 已经滤过，
  而 `CodeIndex` 的解析文件集历来就是那份滤过的清单——放进来会改变后缀匹配的结果。

`reset.ts`：两张新表写进 `KEPT_TABLES`（与 `code_index` 同一条判断：没有外键指向它们，
`cascade` 带不到，而重建要逐个仓 ssh 扫镜像）。**不清不会留残留**：会看上一轮残留的是
需求/事件/派单那几张（都在 `RESET_TABLES`），索引表只有 fixture 自己读写，且
`tests/index.test.ts` / `tests/blob-index.test.ts` 在 `beforeAll` / `afterAll` 里按
fixture 仓名收口（`dropIndex` + `forgetBlobs`）。

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

1. **同一块内容在不同仓里落到不同文件**。夹具里逐字节相同的
   `src/pages/Search/Search.tsx` 与 `app/pages/Search/Search.tsx`，同一句
   `@/services/share` 在仓一解析成 `src/services/share.ts`、在仓二（没有 `src/`）靠后缀
   兜底解析成 `app/services/share.ts`。存下来的那一份必然是其中一个仓的答案，另一个仓
   就会指错文件。`tests/blob-index.test.ts` 有一条用例钉这个。
2. **路由表的 `component: Search` 要经过本地名映射**，而映射是「这块内容自己的事实」
   （`import Search from 'x'` 与 `import { Search } from 'x'` 语义不同），不能塞进说明符数组。
3. 解析本身需要**整棵树**（别名指向哪、`./x` 相对哪个目录、谁的路径以它结尾），
   而整棵树恰好是 `tree_entry` 已经存着的东西。

代价与收益：每次读多几十次字符串比较（装配一次 **3–8 ms**，见 §4 的第二次读数），
换来跨仓、跨提交复用不掺假。另外 `imports` 从「路径 → 路径数组」变成了上面这个对象——
这是**形状变化**，不是新增列：给每块 blob 加 `locals` / `routes` 两列只为路由表文件服务，
比一个 jsonb 对象更难解释。

`lang` 同样只依赖「第一次见到它时路径的扩展名」：符号抽取只在一处用到路径——
判断是不是 `.vue`（`<script setup>` 没有 `export`，顶层声明就是符号）。所以
`parseBlob()` 用 `index.<lang>` 这个假路径调用 `exportsOf()`，结果与真路径逐字相同，
而「同一内容 → 同一符号表」变成不依赖调用顺序的事实。

## 4. 真镜头上的数字（dogyun，2026-11-08）

命令（两仓同一台镜像、同一条 ssh 链路，交替跑，避免只量到一次网络抖动）：

```bash
export FLOWERS_MIRROR_TRANSPORT=ssh FLOWERS_MIRROR_SSH_HOST=dogyun
export FLOWERS_MIRROR_REPOS='[{"id":"123pan-uni-app","path":"/srv/123pan-mirror/123pan-uni-app.git"},
                             {"id":"123pan-pc","path":"/srv/123pan-mirror/123pan-pc.git"}]'
npx tsx scripts/index-sync.ts --repo 123pan-uni-app          # 首建
npx tsx scripts/index-sync.ts --repo 123pan-uni-app          # 第二次：必须 0 块新内容
npx tsx scripts/index-sync.ts --repo 123pan-pc --sha <sha>   # 增量
```

| | 123pan-uni-app | 123pan-pc |
|---|---|---|
| HEAD | `5eaa03cd` | `afff7295` |
| 树里的文件 | 638 | 575 |
| 源码文件（`ts/tsx/js/jsx/mjs/cjs/vue`） | 180（进索引 141） | 283（进索引 137） |
| **首建解析的 blob** | **141** | **136** |
| **去重比（解析块 / 树文件）** | **22.1 %**（141 / 638） | **23.7 %**（136 / 575） |
| 源码文件 → 内容（仓内去重） | 180 → 141（1.28×） | 283 → 136（**2.08×**） |
| **首建耗时（新形状）** | **1429 ms** | **1344 ms** |
| 首建耗时（旧路径，同一会话 A/B） | 1545 ms | 2386 ms |
| 旧口径（`p4-11-static-index.md` §5） | 1017–1095 ms | 1330 ms |
| 第二次（同 sha） | **301 ms，0 块新内容** | **309 ms，0 块新内容** |
| 增量：更早的合并 | `c570fba5`（间隔 16 个提交）**620 ms，6 块新内容**、634 行新映射、复用 133 | `2f90d8ff`（`release-prof`，间隔 4 个提交）**526 ms，1 块新内容**、575 行新映射、复用 135 |
| 索引内容与旧路径逐字比 | `files` / `imports` / `routes` **全等**，40980 字节、580 条导入、27 条路由 | 全等，38279 字节、506 条导入、3 条路由 |

**`blob_index` 行数（两个仓的 HEAD，这才是 139 个仓的规模指标）：277 行**
（141 + 136，跨仓重叠 0）。库里此刻是 284 行——多的 7 块来自上表那两次更早提交。

几件要如实说的事：

- **绝对耗时随链路抖动**。同一会话里旧路径 pc 量到 2386 ms，而文档里是 1330 ms；
  旧路径的 `git show` 批量读本身就有 1–2 秒的方差（同一天先后两次量 `showHeads`：
  974 ms / 1871 ms）。所以「新旧对比」只认**同一会话交替量**的那一列：uni
  1545 → 1429（−7.5 %）、pc 2386 → 1344（−44 %）。新形状的固定成本是
  `ls-tree`（306 / 239 ms）+ 一次 `cat-file --batch`（1033 / 1884 ms）+ 解析与写库（≈ 80 ms）。
- **首建不是这次的重点**。真正变的是第二次以后：同 sha 只需 **1 次 ssh 往返**
  （`ls-tree`）——301 / 309 ms，一块内容都不解析；增量提交只付「变了的那几块」。
- `tree_entry` 每个提交一整棵树（638 / 575 行）：主键里有 `commit_sha`，一个提交的
  每个路径必须各有一行。所以**按提交看**，行数不是「改了 2 个文件就 2 行」——
  那是 `blob_index` 的性质。索引 4 个提交 = 2422 行。这一条在 §7 里单独说。

## 5. 旧表 `code_index` 的处置

- **不写了**：`writeIndex()` 已删除，`repoIndex()` 只写 `tree_entry` / `blob_index`。
  演示库那 32 行的时间戳仍是 `2026-11-07T13:38:21Z`（本轮之后跑完两次首建与两次增量，
  它一行没变）。
- **不读了**：`readIndex()` 改成从两张新表**装配**（`assembleStored`）。
- **表留在 schema 里**（`schema.ts` 里补了一段「它是历史，不是缓存」的注释），
  `reset.ts` 的 `KEPT_TABLES` 仍旧包含它。理由：演示库那 32 行是上一版实测的对照数据，
  删表容易，重建对照要重扫镜像。
- **`drop table code_index` 现在是安全的**：没有代码路径读它（`scripts/index-repo.ts` 的
  统计已改报 `blob_index`），没有外键指向它，`tests/reset.test.ts` 里那两条断言是
  「`code_index` 在 `KEPT_TABLES` 里」——真要删表，那两条与 `KEPT_TABLES` 一起改即可。
  建议下一步（新形状在 139 个仓上站住之后）单独一条迁移做掉。

## 6. 变异表（每条用例打的是哪个变异）

新增 `tests/blob-index.test.ts`（6 条）。全部用当场 `git init` 出来的真仓：`ls-tree -l`
的 oid 列、`cat-file --batch` 的长度前缀都是真格式，`cat-file` 那条路一次 ssh 都不发。

| 用例 | 打到哪个变异 | 变异后的现象 |
|---|---|---|
| 两个提交共享一个没变过的文件 → 只读一次、`parsed_at` 不变 | 增量不查 `existingBlobShas`（每次都重读重解析） | 第二次 `readBlobs` 里出现那两块没变的 sha，`parsed_at` 变新 |
| 同一个提交同步两次：0 块新内容、0 行新映射 | `on conflict do nothing` 改成 `do update` / 不查已有行 | `newBlobs` / `newEntries` 不为 0 |
| 旧提交的文件集不是 HEAD 的（新文件不出现、符号是旧版） | 装配用 HEAD 的树（或按路径缓存符号） | 旧提交里出现 `share-badge`，或 `shareStats` 提前出现 |
| 库里的装配 == 一次性全量解析（`files`/`imports`/`routes` 全等） | 把**解析后的仓内路径**存进共享 blob 行 | 仓二的 `app/pages/...` 读到仓一的 `src/services/share.ts`，`imports` 不等 |
| 两个仓共享一块内容 → 只解析一次 | `blob_index` 主键带 `repo`（或 path） | 仓二 `newBlobs` 变 2 而不是 1 |
| 夹具用例（`tests/index.test.ts`，16 条）全部通过 | —— | —— |

`tests/index.test.ts` 只动了一条用例的**准备步骤**：`建一次是两次往返` 在
`repoIndex` 之前先 `forgetBlobs(...)`。原因不是行为变了，而是**内容跨用例共享**——
上一轮已经把这块内容解析过了，不先忘掉就会量到「一块都不用读」的复用路径（那只有
1 次 `ls-tree` 往返，是更好的结果，但不是这条用例要钉的东西）。断言本身没改。

全量：**65 个文件 / 1438 条通过、1 条跳过**（`npx vitest run`）。

## 7. 这次**没有**解决什么

- **`tree_entry` 按提交线性增长**：一个提交一整棵树（638 / 575 行）。139 个仓各索引
  一个 HEAD ≈ 8 万行（可接受），但如果把**每次提交**都索引，它会长得比 `blob_index` 快
  几百倍。真要那样，得改成「只存相对第一父提交的差异 + 向上回溯」，那是另一个形状
  （回溯要读父提交，装配会变复杂）。当前调用方只索引 `(repo, HEAD sha)`，所以先不做。
- **没有全文 / 向量索引**：这一层仍然只有「路由 / 名字 / 导入 / 符号」四种信号。正文
  检索、语义相似度是后面的阶段；`blob_index` 只存了前 80 行推出的符号，正文一个字节都没留。
- **`parseBlob` 的输入仍然是前 80 行**（`HEAD_LINES`）：导出声明在第 80 行之后的文件抽不到
  符号。这一条与旧版一致，没有变好也没有变坏。
- **`pages.json` 仍然不在索引里**：`CODE_EXT` 只收 `ts/tsx/js/jsx/mjs/cjs/vue`，所以
  uni-app 的 27 条路由全部来自「目录约定」，`parsePagesJson` 那条分支在这两个仓里是
  死代码（本轮没有顺手改：改它等于改索引内容，会让本轮的「与旧路径逐字相同」这条对照失效）。
- **空树提交无法标记「已索引」**：命中判据是「这个 `(repo, sha)` 有没有 `tree_entry` 行」，
  一个整棵树都是噪音（只有图片/`dist`）的提交永远是 0 行，于是每次都会重新 `ls-tree`。
  两个真实仓里没有这种形状，但它是已知的退化情形。
- **`lang` 依赖「第一次见到它的路径」**：同一块内容若在两个仓里分别以 `.ts` 与 `.vue`
  出现（现实中不会有：`.vue` 的内容里有 `<template>`），符号抽取会沿用第一眼的那个扩展名。
- **装配是每次读现算**（3–8 ms）：`locate` 一次要装配 2 个仓，约 10–15 ms；比旧版
  「读一行 jsonb」贵，但仍在毫秒级，且这是「解析结果不能跨仓共享」的必然代价。
- **并发**：两个请求同时同步同一个提交时，`on conflict do nothing` 保住先写的，两边都会
  多花一次 ssh，没有正确性问题（与旧版的结论相同）。
