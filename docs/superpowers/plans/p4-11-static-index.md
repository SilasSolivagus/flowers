# P4-11：静态索引 + 在索引上定位（P4-10 的第 1–2 步）

日期：2026-11-07
分支：`main`（基于 `c46dbec`）
一句话：把「8 个关键词 × 2 个仓库的 ssh grep」换成**一份按 `(repo, sha)` 落库的结构索引**，
`locate` 在索引上按路由 / 名字 / 导入 / 符号打分。真镜头上实测：建一次 1.0–1.3 秒，
之后每次定位 3–16 毫秒，`src/pages/search/search.vue` 由路由确定地排第一。

> 这次只做第 1、2 步（索引 + 定位 + 降级）。**提示词没有改**——`next probes` 形态与
> `unread_candidates` 是第 3 步（`p4-10` §3.3/§3.4）。索引给出的 `why` / `route`
> 已经随 `Probe` 带出来了，第 3 步直接可用。

---

## 1. 索引存什么

表 `code_index`（迁移 `0015_perpetual_stephen_strange.sql`）：

```sql
create table code_index (
  repo     text        not null,
  sha      text        not null,
  files    jsonb       not null,  -- path → { kind, exports[], size }
  imports  jsonb       not null,  -- path → [被 import 的仓内路径]
  routes   jsonb       not null,  -- [{ route, file, title }]
  built_at timestamptz not null default now(),
  primary key (repo, sha)
);
```

四件事值得单独说：

1. **主键 `(repo, sha)` 就是全部失效策略。** 新提交来了，主键换了一半，查不到就当场重建；
   没有 TTL、没有「过期标记」，也就没有「拿旧索引解释新代码」这个失败模式。
2. **`files` 里的 `size` 是字节数**，不参与打分，只用来回答「这棵树有多大」。
3. **`routes[].file` 允许是空串**：路由表里解不出来的那几条如实留着（而不是丢掉），
   CLI 会把「解不出文件的路由条数」单独打出来——这个数字变大就说明路由的写法超出了
   我们的正则，该看的是它。
4. **`built_at` 只到秒**（`indexTimestamp()`）。毫秒写进去、读回来会被 pg 的文本表示
   吃掉末尾的零（`.100` → `.1`），于是「同一 sha 第二次读到的是不是原来那一行」会在
   毫秒位上假失败。秒级足够回答「这份索引什么时候建的」。

## 2. 怎么抽（纯正则 + 目录约定，不引 AST）

一个仓 = **两次 ssh 往返**：`ls-tree -r -l -z <sha>`（带大小与 oid）+ 一次批量
`git show <oid> <oid> …`（git 对多个 blob 是原样拼接，按 `ls-tree` 给的大小切片，
切完校验总长；对不上就退回逐文件 `show`）。**解析只吃每个文件的前 80 行。**

| 要抽的东西 | 规则 | 备注 |
|---|---|---|
| 文件类别 | `pages.json` / `router/` → route；`pages/ views/ screens/` → page；`components/` → component；`services/ apis/` → service；`stores/ hooks/ composables/` → state；其余 → other（**不进索引**） | 顺序即优先级；`other` 不进来是因为它不会成为「这个功能在哪」的答案 |
| 导出符号 | `export (default )?(async )?(const|let|var|function|class) NAME`、`export { a as b }`、`export default NAME`、`defineComponent({ name })`、`.vue` 的 `<script setup>` 里顶层 `const/let/function/class` | uni-app 页面没有 `export` 关键字，符号就是那些顶层名字 |
| 导入关系 | `from '…'`、`require('…')`、`import('…')`（**允许 `import(/* chunk name */ '…')` 这种注释**）、副作用导入；解析成仓内路径 | 外部包（`vue`、`@dcloudio/uni-app`）解析不出 → 空，不进索引 |
| 说明符解析 | 相对 → 归一化；`@/`、`~/` → `src/` 与裸路径两条都试；裸路径（`pages/Login/login`，`baseUrl: "./"` 的仓）→ 仓根与 `src/`；再按 `+ext` / `+/index` 试；最后**整树后缀匹配**（唯一才采纳） | 后缀那一层是给 `pages.json` 的 `"path": "pages/search/search"` 用的（相对 `src/`） |
| React 路由 | `path: '…'` 之后开一个窗口（止于**下一个** `path:`）找 `component: Ident` / `element: <Ident/>`；`Ident` 用**默认导入 / lazy() / defineAsyncComponent()** 的本地名映射落回文件 | 窗口必须止于下一个 `path:`，否则 `name:` 会从下一个路由对象借过来 |
| uni-app 路由 | `"path": "pages/x/y"`，标题取 `"navigationBarTitleText"` | 用正则读 JSON：那份文件里的 `// #ifdef MP-ALIPAY` 是真注释，`JSON.parse` 会失败 |
| 目录约定 | 只认 `<pages>/<dir>/<name>` 这一层：`index` → `/<dir>`；同名 → `/<name>`；`.vue` → `/<name>` | 不同名的 `.ts`（`VideoPage/videoFileUtils.ts`）是工具函数不是一页；再深一层（`pages/Login/components/…`）是页面的子组件，给它造路由等于造假 |

## 3. 打分（`locate`）

| 命中位置 | 权重 | 理由 |
|---|---|---|
| 路由路径 | **10** | 最强：`/search` 命中「搜索」= 这一页就是干这个的 |
| 文件/目录名 | 6 | 次强：命名即意图（`search-entrance/`） |
| 被命中的路由直接 import | 4 | 走一跳图：搜索页用了哪个组件 |
| 导出符号 | 3 | 最弱：`searchFiles()` 说明「提供了能力」，不是「这一屏」 |

同一个文件同一类信号**只算一次**（路由命中三条也只加 10）。排序：分高 → 类别
（page > component > service > state > route）→ 路径字典序，所以同一个 PRD + 同一个 sha
永远给出同一份顺序。

**通用词最后才算数**（`terms.ts` 的 `GENERIC_WORDS`，也就是 `review.ts` 里原来那张
`STOP_WORDS` 表）：先只用非通用词打分，一个都没命中才把通用词放回来。这一条不是修饰，
是决定性的——PAN-6 的八个词里有七个是「文件/目录/当前/返回」这类，全用上时排第一的是
`directory.vue`（它叫「目录」，也是 `/directory` 的页面），而 PRD 真正讲的是搜索；
只用「搜索」时第一名是 `search.vue`、第二名 `search-entrance.vue`，与设计稿的期望一致。

`Probe = { path, kind, score, why, route? }`，`why` 是中文短句，例：
`路由 /search 的页面（命中「搜索」）；目录/文件名 search 命中「搜索」`。

### 3.1 通用词补位：判断属于**整个需求**，不属于单个仓

第一版把「非通用词一个都没命中就退回通用词」写在 `locate()` 里、**每仓各自判**。
PAN-6 上它直接翻了车（`scripts/compare-locate.ts` 实测）：`搜索` 在 `123pan-pc`
一个文件都不命中 → 那一仓自己降级到「文件」→ 8 个噪音（`videoFileUtils.ts` [9]、
`file/type.ts` [6]……）与 uni-app 的候选**拼在一起** → `search.vue` 明明 16 分，
却排到 **rank 7**。分数是对的，错的是「谁来决定要不要用通用词」。

「这份 PRD 有没有具体线索」是需求的属性。所以新增 `locateAcross(entries, keywords)`：

1. **第一趟**：每个有索引的仓都按 `allowGeneric: false` 打分；
2. **只要有任何一个仓**给出候选，这就是最终答案——没命中的仓贡献**零**个候选
   （与旧路径的 `emptyRepos` 同一个口径）；
3. 只有**整个需求**一个候选都没有（很薄的 PRD，例如「文件列表优化」），才允许通用词补位。

`locate()` 的 `allowGeneric` 默认 `true`（单仓调用保持原行为，既有用例不漂）。
两个调用点都改成**先拿到所有仓的索引、再一起定位**：`inspect.ts` 拆出
`structureOf()`（head/tree/shape/index）与 `baselineOf(struct, choice)`，
在 `inspect()` 里调一次 `locateAcross`；`review.ts` 的 `gatherBaseline` 同样改成
「第一趟收树与索引、第二趟定位、第三趟按 choice 取候选或跑旧 grep」。
降级仍是**每仓独立**的：`index === null`（镜像读不到）与「索引在但没线索」是两件事。

## 4. 降级规则（§3.5）

`locateOrFallback(index, keywords) → { source: 'index', probes } | { source: 'grep', reason }`

| 情况 | 行为 |
|---|---|
| 没有索引（镜像读不到、建索引失败） | `source: 'grep'`，reason 是一句中文 |
| 索引为空（后端仓：一个 JS/TS 页面都没有） | `source: 'grep'` |
| 索引在、但一个候选都没有 | **仍然走索引**（候选为空是真答案：「这个功能不在这个仓」）——旧路径正是拿 grep 的噪音把 `app/downLoad/index.ts` 顶上来盖住这个答案的 |

旧代码**一行没删**：`inspect.ts` 的 `rankCandidates` / `review.ts` 的 grep 加权段落仍在，
`RepoBaseline.source: 'index' | 'grep'` 把「这次走的是哪条」写进数据，
`tests/index.test.ts` 钉住「只有 `.go` 的仓 → 选 grep」（只断言**选了哪条路**，不断言 grep 的输出）。

## 5. 真镜头上的数字（dogyun）

`scripts/index-repo.ts`，关键词取 `p4-10` §1 的 PAN-6 那组：
`搜索、文件、目录、上一级、结果、返回、当前、范围`。

| | 123pan-uni-app | 123pan-pc |
|---|---|---|
| HEAD | `5eaa03cd` | `afff7295` |
| 首建（清空后） | **1017–1095 ms** | **1330 ms** |
| 第二次（同 sha，命中库） | **6 ms**（定位本身 16 ms） | **3 ms**（定位本身 14 ms） |
| 索引文件数 | 141（page 27 / component 82 / service 17 / state 15） | 137（page 14 / component 71 / service 40 / state 11 / route 1） |
| 路由 | 27 条（0 条解不出文件） | 3 条（0 条解不出文件） |
| 导入关系 | 580 条 | 506 条 |
| 索引大小 | 40,980 字节 | 38,279 字节 |

**验收（§3.6）**：`npx tsx scripts/compare-locate.ts`（A = 旧 ssh grep，B = 索引，
PRD = `tests/fixtures/prd-pan6.md`，两仓一起看）

| | A · 旧 grep | B · 索引 |
|---|---|---|
| 耗时 | **2713 ms** | **227 ms**（12.0×） |
| 进提示词 | 7457 字符 | **734 字符** |
| 选中 | 2 个（uni-app） | 6 个（uni-app） |
| `src/pages/search/search.vue` | 第 1 位 | **第 1 位** |
| `src/components/search-entrance/search-entrance.vue` | 第 2 位 | **第 2 位** |

单仓看也一样（`scripts/index-repo.ts`，uni-app@`5eaa03cd`）：

```
1. [16] src/pages/search/search.vue                          ← 路由 /search 的页面（命中「搜索」）
2. [6]  src/components/search-entrance/search-entrance.vue   ← 目录/文件名 search-entrance 命中「搜索」
3. [4]  src/components/file-actions/file-actions.vue         ← 被 search.vue 直接引用
```

第一名是路由确定的，第二名紧跟其后，定位 8–16 ms —— 远低于 1 秒。pc 侧这次**一个候选
都不给**（「搜索」在那仓没有命中 → 按 §3.1 的规矩贡献零个），这正是旧路径靠全局
`STOP_WORDS` 做对、第一版索引做错的那一处。

## 6. 还没做好的地方

- **只读前 80 行**：导出声明在第 80 行之后的文件抽不到符号（实测两个仓里没有这种形状的
  页面，但这不是保证）。同理，`export` 写在文件末尾的 `index.ts`（重导出）会漏。
  真正传的是整块 blob、只在本地切 80 行——git 没有「只给我前 N 行」的读命令，多传的
  那 0.7MB 比多几十次 ssh 往返便宜。
- **路由解析仍是正则**：`path: computed(...)`、`import.meta.glob` 批量注册、
  `createBrowserRouter([...])` 的对象字面量都能吃掉一部分；解出来的条数一旦变少，
  `routesWithoutFile` 会涨（CLI 单独打这一栏），但**没有告警**。
- **`@/` 的落点写死成 `src/`**：两个仓都是这么配的。换一个把 `@/` 指到别处的仓，
  别名那一支会解到错的地方，只剩后缀兜底能救。
- **pc 只有 3 条路由**：那个仓的页面注册不在 `src/router/router.js` 里（它只注册了
  登录/视频页/布局），真实的路由表在打包后的 `web-file/frontend` 里，我们没索引它。
- **通用词仍是「全有或全无」的**：`GENERIC_WORDS` 是一张手写表，不是按 `df`（这个词
  命中了多少文件）算出来的。所以「文件」在一个只有「文件」可讲的 PRD 里会被降级到
  第二趟（给出弱候选），而在别的 PRD 里被彻底忽略。按 `df` 动态判定能同时解决两件事，
  但那要先有「什么算高频」的实测口径，留给下一步。
- **`why` 还没进提示词**（第 3 步）。现在它只出现在 CLI 输出与 `Baseline.probes` 里。
- **建索引并发**：两个请求同时命中同一个空索引时会各建一次（`on conflict do nothing`
  保住先写的，后写的丢弃）。结果是多花一次 ssh，没有正确性问题。
- **用例会往生产仓 id 上写夹具索引**：`inspect` / `review` 的用例把 `123pan-pc` 指到
  临时仓，于是 `code_index` 里会多出几行「`123pan-pc` + 夹具 sha」的行。它们不会被读到
  （查的是 `(repo, HEAD sha)`），但会一直躺在表里。清法：
  `delete from code_index where sha <> (真实 HEAD)`；根治要在写库那一层区分「夹具」，
  这次没做（会碰另一个 worker 正在改的用例）。
