# 静态索引 + next probes：把「猜路径」换成「走图」

> 起因：一次评审里 `locate` 段实测 29–48 秒，全都是 8 个关键词 × 2 个仓库的 ssh 往返；
> 而且**猜出来的文件经常不是那个功能**（挑到过 `app/downLoad/index.ts`、`src/enum/umengPoint.ts`、
> `src/pages/doc/privacy.vue`）。最后靠一张中英对照表 + 路径加权才勉强选中
> `src/pages/search/search.vue`。

## 1. 现状怎么定位的（要替换掉的那段）

```
PRD 全文
  → keywordsFrom()：抽 8 个中文词（搜索/文件/目录/上一级/结果/返回/当前/范围）
  → 每个词一趟 ssh `git grep`，2 个仓库 = 16 趟
  → 按「路径里出现关键词」打分，中文词靠 PATH_TERMS 映射成英文（搜索→search）
  → 每仓取前 6 个文件 → `git show` 全文 → 最多 28k 字符塞进提示词
```

三个毛病，都是**结构性的**，不是参数没调好：

1. **猜测**：关键词命中 ≠ 这个文件实现这个功能。`privacy.vue` 里有「文件」两个字，
   但它不是文件管理页。
2. **往返**：每个词一趟 ssh，延迟叠加。
3. **塞满**：全文进提示词，模型要在一堆无关代码里自己找。

## 2. 目标

| 指标 | 现在 | 目标 |
|---|---|---|
| locate 耗时 | 29–48 s | <1 s（索引命中）/ 2–3 s（首次建索引） |
| 进提示词的代码量 | ≤28k 字符全文 | ≤10k 字符（签名 + 关键片段） |
| 选中正确率 | 靠加权勉强 | 路由命中即确定 |

## 3. 设计

### 3.1 索引：`repoIndex(repo, sha)`

**存哪**：新表 `code_index`。

```sql
create table code_index (
  repo        text        not null,
  sha         text        not null,
  files       jsonb       not null,   -- path → {kind, exports[], size}
  imports     jsonb       not null,   -- path → [被 import 的仓内路径]
  routes      jsonb       not null,   -- [{route, file, title}]
  built_at    timestamptz not null default now(),
  primary key (repo, sha)
);
```

按 `(repo, sha)` 做主键：**sha 一变，索引自然失效**，不需要失效逻辑，也不会拿旧索引去解释新代码。

**怎么抽**（纯正则 + 目录约定，**不引 AST 依赖**）：

| 要抽的东西 | 怎么抽 |
|---|---|
| 文件分类 | 路径：`pages?/` `views?/` → page；`components?/` → component；`services?/` `api/` → service；`store/` `hooks/` → state；`router` → route |
| 导出符号 | `export (const|function|class|default) NAME`、`defineComponent`、`<script setup>` 里的顶层 `const` |
| 导入关系 | `from 'x'` / `require('x')` → 解析成仓内相对路径（`@/`、`~/` 别名按仓的 tsconfig/jsconfig 约定处理） |
| 路由 | React：`path: '/x'` + `component: Y` 配对；uni-app：`pages.json` 的 `pages[].path`；兜底：`pages/<dir>/<name>` 目录约定 |

**何时建**：`locate` 发现 `(repo, sha)` 没有索引时建一次。2–3 秒（一次 `git ls-tree` + 批量
`git show` 全部页面的**前 80 行**，在本地做正则）。建完写库，此后同 sha 零成本。

**为什么读「前 80 行」而不是全文**：导入语句、导出声明都在文件头部；80 行足够抽关系，
又不至于把 2000 行的组件整个拉过来。

### 3.2 定位：`locate(index, prd)` → `Probe[]`

在索引上打分，**不发一次 ssh**：

| 命中位置 | 权重 | 理由 |
|---|---|---|
| 路由路径（`/search` 命中「搜索」） | **10** | 最强的信号：这个页面就是干这个的 |
| 文件/目录名 | 6 | 次强：命名即意图 |
| 被命中的路由 **直接 import** | 4 | 走一跳图：搜索页用了哪个组件 |
| 导出符号名 | 3 | 弱：`searchFiles()` 出现在 service 里 |

中文词先过 `PATH_TERMS`（已有）映射成英文片段，再匹配。

输出：

```ts
type Probe = {
  path: string;
  kind: 'page' | 'component' | 'service' | ...;
  score: number;
  /** 一句话说清为什么选它——这一句要进提示词，也要进材料的证据栏 */
  why: string;   // '路由 /search 的页面' / '被 1 直接引用' / '导出 searchFiles'
  route?: string;
};
```

### 3.3 next probes：进提示词的不是正文，是「先看这几个」

现在的提示词是「这是 28k 字符代码，你自己找」。改成：

```
这个功能现在的位置（静态索引，未读正文）：
  1. src/pages/search/search.vue          路由 /search 的页面        [路由命中]
  2. src/components/search-entrance/…     被 1 直接引用             [导入关系]
  3. src/services/share/index.ts          导出 searchFiles          [符号命中]
  其余 12 个候选命中较弱，未列出。

请只根据这三处的**签名与片段**判断；需要更多上下文时，在 findings 的 limitations
里写「需要看 X」。不要假设没列出的代码不存在。
```

然后只对**前 2–3 个**做 `git show`，且只取签名区（前 80 行 + 导出行），不是全文。

### 3.4 limitations：让模型知道自己没看到什么

这是从 REA 抄的最重要一条：它的每个结果都带 `limitations` 与 `unknowns`，而不是一个
verdict。对我们的价值是**防止模型把「我没看到」说成「代码里没有」**。

`inspect` 的 findings 已经有 `searched` 字段。加一条：`unread_candidates: number` ——
「还有 N 个候选没读」。模型若给 `missing` 结论，必须同时报这个数；数是 0 才算「确实没有」。

### 3.5 失败与降级

| 情况 | 行为 |
|---|---|
| 仓里没有 JS/TS（后端仓库） | 索引为空 → **退回现在的 grep 路径**（不删旧代码） |
| 索引建到一半失败 | 不写库，报中文原因，本轮退回 grep |
| sha 与索引不一致 | 不可能：主键是 `(repo, sha)` |
| 镜像读不到 | 与现在一致：`mirror_failed` |

### 3.6 度量（做完要给的数字）

用 PAN-6 做基准，同一份 PRD：

| 指标 | 现在 | 做完 |
|---|---|---|
| locate 首轮 | 36.7 s | 首次（含建索引） |
| locate 第二轮同 sha | 36.7 s | 应 <0.2 s |
| 选中文件 | search.vue + search-entrance.vue（靠加权抢救） | 同两个，但由路由确定 |
| 提示词代码量 | 7.7–28k 字符 | 目标 ≤10k |

## 4. 不做

- **不引 AST / tree-sitter / ts-morph**：多一个原生依赖，换来的是更准的符号表；
  先证明「路由 + 导入」这一层够用。
- **不索引后端仓库**：现在只看两个前端仓；后端要单独设计（grep Go/Java 是另一套约定）。
- **不让模型自己决定读哪些**：一次生成只调 3–4 次模型，中间再加一轮「选文件」会多一次
  调用与一次失败点。**由代码按评分选**，把「为什么选」写进提示词——同样达到
  「模型知道自己看的是什么」的效果，且不增加调用。

## 5. 实施顺序

1. `repoIndex` + `code_index` 表 + 一个 `--dry-run` 的 CLI（能在本机打印索引摘要）
2. `locate` 改成查索引（保留 grep 作为降级）
3. 提示词改成 next probes 形态 + `unread_candidates`
4. 用 PAN-6 跑一遍，对比上表的四个数字

第 1、2 步能独立验收（不进提示词也能看「选中了什么、多快」）。
