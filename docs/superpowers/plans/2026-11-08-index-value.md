# 索引价值提升 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让索引从「文件清单 + 函数名」变成「能说清产品长什么样子」的结构，使**评估材料**能回答「这一步落在哪个现有页面／要动几个文件」，并使**走查材料**能回答「改这里会波及哪几处」。

**Architecture:** 全部建立在已有的 `blob_index`（内容寻址）之上，不新增数据源。四条主线：① 挖深单个文件（页面由哪些组件组成）；② 把文件连成关系（反向导入图）；③ 补齐定义页面的非代码资产（`pages.json` / 路由配置）；④ 把已有的历史数据（`commit_history`）接进材料。每一层都通过**读模型函数**暴露，最终由 `uemaster` 的提示词消费；不改变 `locate` 的评分逻辑。

**Tech Stack:** Node 20 + TypeScript strict、Next 16 App Router、drizzle-orm/Postgres 17、tree-sitter（Phase 3 才引入）、Vitest。

**Spec:** `docs/superpowers/plans/2026-11-08-index-value.md` §0（本文件，讨论结论见 §0.3）

---

## 0. 背景与边界

### 0.1 现状（实测）

- `blob_index` 284→311 行，171 KB 级；两仓（pc/uni-app）＋ cross-frontend 已接入
- 每 blob 存 `symbols: string[]`（例如 `["filterAds"]`）与 `imports`
- 路由：uni-app 27 条（**全部由目录约定猜出**）、pc 3 条、cross-frontend 9 条
- `parsePagesJson` 是**死代码**：`CODE_EXT` 不含 `.json`
- 评估链路（`compose.ts` 的 `flowPrompt` / `fragmentsPrompt`）**完全不读索引**

### 0.2 目标与非目标

**目标（可验收）**：一条新需求，通过六问 + 索引，能生成一份评估材料，其中
- 每一步标注「现有页面 / 新增页面」
- 标注「改 1 个文件 / 新增 2 个文件」
- 复用既有组件时点名（「已有 `SearchBar`」）

**非目标（明确不做）**
- 全文检索（`git grep` 已够）
- 向量/语义检索（等结构层补齐后再谈）
- 改变 `locate` 的命中率评分（那是另一条线，与本计划正交）

### 0.3 唯一诚实的指标

```
「其实早就存在、却被材料标成新增」的比例
```
基线：**不可测**（评估链路未接索引）。Phase 1 完成后必须先测出这个数，再谈后续优化。

---

## Global Constraints

- 每个新测试必须**变异验证**：改坏那一行 → 看它变红 → 复原 → 报告里列变异表。
- 中文文案与注释；注释写「为什么」，不写「是什么」。
- 不新增依赖，Phase 3 的 tree-sitter 例外（需先经确认）。
- **禁止** `git clean` / `git checkout -- .` / 删除未跟踪文件的任何命令。
- 数据安全：`flowers` 库里 814 条未删需求、802 条带 `legacy_ref`，任何迁移跑完必须逐数核对。
- 迁移一律新编号、幂等、可空库空转。
- `blob_index` 是内容寻址的：**改解析产物形状时必须加新列**，不得改变既有列语义（下游 `locate`/`review` 还在读 `symbols`）。
- 每个 Phase 结束跑 `npx vitest run` + `npx tsc --noEmit` + `npm run build`。

---

## Phase 1：让索引说清「这页由什么组成」

### Task 1: 解析 `pages.json` / 路由配置，把页面清单变成真的

**Files:**
- Modify: `src/core/codemirror/code-index.ts`（`CODE_EXT`、`isIndexable`、`parsePagesJson`、`assembleIndex`）
- Modify: `src/core/codemirror/index-store.ts:233` `assembleFor`
- Test: `tests/code-index-pages.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type IndexPage = { route: string; title: string | null; source: 'pages.json' | 'convention' };
  // CodeIndex 增加一列，不动既有字段
  export type CodeIndex = { files: …; imports: …; routes: IndexRoute[]; pages: IndexPage[] };
  ```
- Consumes: 无（自足）

- [ ] **Step 1: 写失败测试**

```ts
// tests/code-index-pages.test.ts
import { describe, expect, it } from 'vitest';
import { pagesFromConfig } from '../src/core/codemirror/code-index.js';

describe('pagesFromConfig', () => {
  it('从 pages.json 取出 route 与 navigationBarTitleText', () => {
    const json = JSON.stringify({
      pages: [
        { path: 'pages/share/index', style: { navigationBarTitleText: '分享页' } },
        { path: 'pages/search/index', style: { navigationBarTitleText: '搜索结果' } },
      ],
    });
    expect(pagesFromConfig('pages.json', json)).toEqual([
      { route: '/pages/share/index', title: '分享页', source: 'pages.json' },
      { route: '/pages/search/index', title: '搜索结果', source: 'pages.json' },
    ]);
  });

  it('不是 pages.json 的路径返回空数组（不做猜测）', () => {
    expect(pagesFromConfig('src/router.ts', '{}')).toEqual([]);
  });

  it('JSON 坏了返回空数组而不是抛错（索引不能因为一个坏文件整体失败）', () => {
    expect(pagesFromConfig('pages.json', '{oops')).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run tests/code-index-pages.test.ts`
Expected: FAIL — `pagesFromConfig is not a function`

- [ ] **Step 3: 实现**

在 `code-index.ts` 里：

```ts
export type IndexPage = { route: string; title: string | null; source: 'pages.json' | 'convention' };

/**
 * 只认 pages.json 这种明确的页面清单。为什么不做通用路由解析：
 * pc 仓的路由在 cross-frontend 里、uni 的路由靠目录约定，两者都不是一个
 * 能被同一条规则覆盖的东西；猜错会让评估材料把不存在的页面当成"现有"。
 */
export function pagesFromConfig(path: string, text: string): IndexPage[] {
  if (!/(^|\/)pages\.json$/.test(path)) return [];
  try {
    const doc = JSON.parse(text) as { pages?: Array<{ path?: string; style?: { navigationBarTitleText?: string } }> };
    const out: IndexPage[] = [];
    for (const p of doc.pages ?? []) {
      if (typeof p?.path !== 'string' || p.path === '') continue;
      out.push({
        route: '/' + p.path.replace(/^\/+/, ''),
        title: p.style?.navigationBarTitleText ?? null,
        source: 'pages.json',
      });
    }
    return out;
  } catch {
    return [];
  }
}
```

再把 `pages.json` 纳入可索引范围：`isIndexable` 增加对 `.json` 的判定（**只收 `pages.json`**，避免把 lock 文件、配置大文件读进来）。

在 `assembleFor` 装配时：`pages` = `pagesFromConfig` 的结果 ＋ 现有目录约定推出的 routes（标 `source:'convention'`）；**同名 route 时 pages.json 胜出**。

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run tests/code-index-pages.test.ts && npx tsc --noEmit`
Expected: PASS，tsc 干净

- [ ] **Step 5: 用真仓验证并记录数字**

Run:
```bash
npx tsx -e "import('./src/core/codemirror/index-store.js')" # 或写临时脚本调用 assembleFor
```
Expected: uni-app 的 `pages` 条数 ≥ 27，且 `source:'pages.json'` 的条目带中文标题。**把条数写进报告**。

- [ ] **Step 6: 提交**

```bash
git add src/core/codemirror/code-index.ts src/core/codemirror/index-store.ts tests/code-index-pages.test.ts
git commit -m "feat(index): 解析 pages.json —— 页面清单不再靠目录约定猜"
```

---

### Task 2: 页面 → 用了哪些组件（outline 第一层）

**Files:**
- Modify: `src/core/codemirror/code-index.ts`（新增 `outlineOf`）
- Modify: `src/db/schema.ts` + 新迁移 `0032_blob_outline.sql`（新增列 `outline jsonb`）
- Modify: `src/core/codemirror/index-store.ts`（解析时写入 outline）
- Test: `tests/code-index-outline.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type OutlineNode = { kind: 'component-use' | 'tag'; name: string; line: number };
  export function outlineOf(path: string, text: string): OutlineNode[];
  ```
- Consumes: 无

- [ ] **Step 1: 写失败测试**

```ts
// tests/code-index-outline.test.ts
import { describe, expect, it } from 'vitest';
import { outlineOf } from '../src/core/codemirror/code-index.js';

const vue = `<template>
  <div class="wrap">
    <ShareHeader :title="t" />
    <SearchBar v-model="kw" />
    <ul><li v-for="f in list">{{ f.name }}</li></ul>
  </div>
</template>
<script setup lang="ts">
const kw = ref('');
</script>`;

describe('outlineOf', () => {
  it('只取 template 里的组件使用（大写开头标签）', () => {
    expect(outlineOf('pages/share/index.vue', vue)).toEqual([
      { kind: 'component-use', name: 'ShareHeader', line: 3 },
      { kind: 'component-use', name: 'SearchBar', line: 4 },
    ]);
  });

  it('小写 HTML 标签不算组件（div/ul/li 不是我们维护的东西）', () => {
    const names = outlineOf('a.vue', vue).map((n) => n.name);
    expect(names).not.toContain('div');
    expect(names).not.toContain('ul');
  });

  it('非 vue 文件返回空数组（这一层只做 vue）', () => {
    expect(outlineOf('src/util.ts', 'export const a = 1;')).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认红** — `npx vitest run tests/code-index-outline.test.ts` → FAIL

- [ ] **Step 3: 实现 `outlineOf`**

```ts
export type OutlineNode = { kind: 'component-use' | 'tag'; name: string; line: number };

/**
 * 为什么只做 template、只做 vue：评估要回答的是「这页里已经有什么组件」，
 * template 里的标签名就是答案，不需要进 script 解析 AST。而修 script 里的
 * 函数与 props 是 Phase 3 的事——那时才需要 tree-sitter。
 */
export function outlineOf(path: string, text: string): OutlineNode[] {
  if (!/\.vue$/i.test(path)) return [];
  const tpl = /<template>([\s\S]*?)<\/template>/i.exec(text);
  if (tpl === null) return [];
  const body = tpl[1];
  const baseLine = text.slice(0, tpl.index).split('\n').length;
  const out: OutlineNode[] = [];
  const re = /<([A-Z][A-Za-z0-9]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.push({
      kind: 'component-use',
      name: m[1],
      line: baseLine + body.slice(0, m.index).split('\n').length - 1,
    });
  }
  return out;
}
```

迁移 `0032`：`alter table blob_index add column if not exists outline jsonb;`

`blob_index` 写入时带 `outline: outlineOf(path, text)`。**加新列不动 `symbols`**（Global Constraints）。

- [ ] **Step 4: 跑测试确认绿**

- [ ] **Step 5: 全量重解析一次并记录去重效果**

Run: `npx tsx scripts/index-sync.ts --repo 123pan-uni-app --sha <HEAD> --force-reparse`
（若无 `--force-reparse`，先实现它：清掉该仓 blobs 的 `outline` 为 null，再同步）
Expected: uni-app 的 `outline` 非空行数 ≈ 141；记录 `ShareBar` 这类组件在多少个页面里出现。

- [ ] **Step 6: 提交**

---

### Task 3: 反向导入图——「改这个组件会波及几个页面」

**Files:**
- Create: `src/core/codemirror/reverse-imports.ts`
- Modify: `src/core/codemirror/code-index.ts`（`CodeIndex` 增加 `importedBy: Record<string, string[]>`）
- Test: `tests/reverse-imports.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** 路径 → 引用了它的文件路径（去重、稳定序） */
  export function reverseImports(imports: Record<string, string[]>): Record<string, string[]>;
  ```
- Consumes: `CodeIndex.imports`（已有，形如 `{ 'src/a.ts': ['src/b.ts'] }`）

- [ ] **Step 1: 写失败测试**

```ts
// tests/reverse-imports.test.ts
import { describe, expect, it } from 'vitest';
import { reverseImports } from '../src/core/codemirror/reverse-imports.js';

describe('reverseImports', () => {
  it('把 文件→引用 翻成 被引用→文件', () => {
    const out = reverseImports({
      'pages/share/index.vue': ['components/SearchBar.vue'],
      'pages/fav/index.vue': ['components/SearchBar.vue'],
      'components/SearchBar.vue': [],
    });
    expect(out['components/SearchBar.vue']).toEqual([
      'pages/fav/index.vue',
      'pages/share/index.vue',
    ]);
  });

  it('没有入边的文件不出现在结果里（不制造空数组噪音）', () => {
    const out = reverseImports({ 'a.ts': ['b.ts'] });
    expect(Object.keys(out)).toEqual(['b.ts']);
  });

  it('结果稳定排序（同一个仓跑两次结果逐字相同）', () => {
    const once = reverseImports({ c: ['x'], a: ['x'], b: ['x'] });
    const twice = reverseImports({ b: ['x'], c: ['x'], a: ['x'] });
    expect(once).toEqual(twice);
  });
});
```

- [ ] **Step 2: 跑测试确认红**

- [ ] **Step 3: 实现**

```ts
/**
 * 评估里最容易判错的一件事是「改一处 vs 改三处」。正向 import 只能回答
 * 「这个文件用了谁」，回答「谁在用它」必须反向。排序固定，否则同一份材料
 * 每次生成的说法顺序都不一样，评审会以为看到了新东西。
 */
export function reverseImports(imports: Record<string, readonly string[]>): Record<string, string[]> {
  const map = new Map<string, Set<string>>();
  for (const from of Object.keys(imports)) {
    for (const to of imports[from] ?? []) {
      if (to === from) continue;
      let set = map.get(to);
      if (set === undefined) { set = new Set(); map.set(to, set); }
      set.add(from);
    }
  }
  const out: Record<string, string[]> = {};
  for (const [k, set] of [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out[k] = [...set].sort();
  }
  return out;
}
```

在 `assembleFor` 里把 `importedBy` 一并返回。

- [ ] **Step 4: 跑测试确认绿**

- [ ] **Step 5: 真仓验证**

记录：uni-app 里被引用最多的 5 个组件及其被引用次数。**写进报告**——这是判断「改一处还是三处」的真实分布。

- [ ] **Step 6: 提交**

---

### Task 4: 把「现有页面 + 组件」接进评估提示词，并第一次测出基线指标

**Files:**
- Modify: `src/core/uemaster/compose.ts:195` `flowPrompt`、`:359` `fragmentsPrompt`
- Modify: `src/core/uemaster/review.ts`（调用处传参）
- Modify: `src/core/locate/copy.ts`（新增页面清单片段）
- Test: `tests/evaluate-known-surfaces.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type KnownSurface = { route: string; title: string | null; components: string[] };
  export function knownSurfaces(index: CodeIndex, limit?: number): KnownSurface[];
  ```
- Consumes: `CodeIndex.pages`（Task 1）、`CodeIndex.outline`（Task 2）、`CodeIndex.importedBy`（Task 3）

- [ ] **Step 1: 写失败测试**

```ts
// tests/evaluate-known-surfaces.test.ts
import { describe, expect, it } from 'vitest';
import { flowPrompt } from '../src/core/uemaster/compose.js';
import { knownSurfaces } from '../src/core/locate/copy.js';

describe('knownSurfaces', () => {
  it('把页面、标题、组件收成评估提示词能吃的形状', () => {
    const s = knownSurfaces({
      files: {},
      imports: {},
      routes: [],
      pages: [{ route: '/pages/share/index', title: '分享页', source: 'pages.json' }],
      outline: {},
      importedBy: {},
    } as never);
    expect(s).toEqual([{ route: '/pages/share/index', title: '分享页', components: [] }]);
  });
});

describe('flowPrompt 带现有页面', () => {
  it('提示词里出现页面清单，且要求区分现有/新增', () => {
    const p = flowPrompt(req as never, 'evaluate', [
      { route: '/pages/share/index', title: '分享页', components: ['SearchBar'] },
    ]);
    expect(p).toContain('/pages/share/index');
    expect(p).toContain('现有页面');
    expect(p).toContain('新增页面');
  });

  it('没有索引时不写这段（不能凭空说"现有页面上什么都没有"）', () => {
    const p = flowPrompt(req as never, 'evaluate', []);
    expect(p).not.toContain('现有页面');
  });
});
```

- [ ] **Step 2: 跑测试确认红**

- [ ] **Step 3: 实现**

`copy.ts`：
```ts
export type KnownSurface = { route: string; title: string | null; components: string[] };

/** 评估提示词里的「现有页面」段。没有索引时返回空数组，调用方据此不写这段。 */
export function knownSurfaces(index: Pick<CodeIndex, 'pages' | 'outline' | 'files'>, limit = 40): KnownSurface[] {
  const filesByRoute = (route: string): string[] =>
    Object.keys(index.files).filter((p) => p.includes(route.replace(/^\//, '')));
  return index.pages.slice(0, limit).map((p) => ({
    route: p.route,
    title: p.title,
    components: filesByRoute(p.route).flatMap((f) => index.outline[f] ?? []).map((n) => n.name).slice(0, 12),
  }));
}
```

`compose.ts`：
```ts
export function flowPrompt(req: RequirementRow, stage: Stage, known: readonly KnownSurface[] = []): string
```
在提示词里追加：
```
已知现有页面（来自代码索引）。流程里落在这些页面上的步骤，必须写「现有页面：<route>」；
不在清单里的写「新增页面」。不要假设清单之外还有页面。
<逐行： - /pages/share/index（分享页）：组件 ShareBar, SearchBar, FileList>
```

- [ ] **Step 4: 跑测试确认绿**

- [ ] **Step 5: 生成 3 份真评估材料，人工数指标**

选三条有 PRD 的需求（`select number from requirements where prd_url is not null and state in ('inbox','design') limit 3`），逐份统计：
```
标「现有页面」的条数
标「新增」但人工确认其实已存在的条数   ← 这就是基线指标
```
把三份的分子/分母写进报告。**这是 Phase 1 的唯一验收点。**

- [ ] **Step 6: 提交**

---

## Phase 2：把已有的历史数据接进材料（不新增数据源）

### Task 5: 同类需求先例——「上次做类似的事改了哪几个文件」

**Files:**
- Modify: `src/core/locate/history.ts`（新增 `similarMerges(rows, title, k)`，复用既有 `grams`/`rankMerges`）
- Modify: `src/core/uemaster/inspect.ts`（走查材料里加一行「参照」）
- Test: `tests/similar-merges.test.ts`

**Interfaces:**
- Produces: `export function similarMerges(rows: readonly HistoryRow[], title: string, k = 3): Array<{ sha: string; subject: string; files: number }>`
- Consumes: `commit_history`（既有）

- [ ] **Step 1: 写失败测试**（三条：命中同名需求、无命中返回空、文件数按合并统计而非累加重复）
- [ ] **Step 2: 确认红**
- [ ] **Step 3: 实现**：直接调用既有 `rankMerges`，取前 k，`files` 用该 merge 的改动文件数（已有字段）
- [ ] **Step 4: 确认绿**
- [ ] **Step 5: 真数据验证**：拿 5 条真需求标题跑，人工判断「先例像不像」。像的比例写进报告——**不像就别接进材料**
- [ ] **Step 6: 提交**

### Task 6: 文件热度与代码年龄

**Files:**
- Modify: `src/core/codemirror/index-store.ts`（返回 `lastTouched: Record<string, string>`，来自该 blob 最后一次出现在合并里的日期）
- Modify: `src/core/locate/copy.ts`（材料里加一句「这部分代码最近一次改动：2026-09-12」）
- Test: `tests/file-age.test.ts`

- [ ] **Step 1-4:** TDD（含：未知时写「改动时间未知」而不是编一个日期）
- [ ] **Step 5:** 真数据验证：随机 10 个文件，人工核对最近改动日期对不对
- [ ] **Step 6:** 提交

---

## Phase 3：精确到函数（需先确认 tree-sitter 依赖）

### Task 7: script 里的函数与 props（tree-sitter）

> **前置确认**：本任务引入 `web-tree-sitter` + 3 个语法（vue/ts/tsx）。在执行前必须先得到 owner 确认（Global Constraints）。若未确认，整段跳过，不影响 Phase 1–2 的交付。

- [ ] 步骤同前：先写 `propsOf(path, text)` 与 `functionsOf(path, text)` 的失败测试（fixture 用真实组件文件），再实现，再变异验证。
- [ ] 验收：对一个真实页面，能列出它的 props 与函数名，且行号与文件一致。

### Task 8: 路由 → 页面 → 组件三层打通

- [ ] 让 `KnownSurface.components` 不再是「路径包含 route 的文件」，而是真正的路由映射（用 Task 1 的 `pages.json` 路径 → Task 2 的 outline）。
- [ ] 验收：随机 5 个路由，人工核对「这页由哪些组件组成」是否对。

---

## Phase 4：扩大适用范围（持续任务，非一次性）

### Task 9: 逐个接入更多仓

对每个候选仓：
1. 加入 `scripts/sync-mirrors.sh` 的 `REPOS`
2. 确认路由/页面清单能被挖出来（若挖不出来，**先记录「这个仓定义了页面但索引挖不到」**，不要假装覆盖了）
3. 跑一次全量索引，记录 blob 数与耗时
4. 写进 `docs/superpowers/plans/2026-11-08-index-coverage.md`：仓名、blob 数、路由数、能否挖出页面

**验收**：覆盖率表里每个仓都有「挖到 / 挖不到 / 不需要」三种结论之一，没有空白。

---

## Self-Review

**Spec coverage：**
- 「现有页面 / 新增页面」标注 → Task 1 + Task 4 ✓
- 「改几个文件」 → Task 3 ✓
- 「复用既有组件」 → Task 2 + Task 4 ✓
- 「以前怎么做的」 → Task 5 ✓
- 「这块代码还活着吗」 → Task 6 ✓
- 指标可测 → Task 4 Step 5 ✓
- 覆盖性 → Phase 4 ✓

**Placeholder scan：** Phase 3 的两个任务写成了步骤级要求而非完整代码——因为它们是**有条件执行**（依赖确认 + 依赖 tree-sitter）。执行者若跳过 Phase 3，前两阶段仍然完整可用；若要执行 Phase 3，必须先写测试再实现，格式同 Task 1–3。

**Type consistency：** `IndexPage`（Task 1）→ `KnownSurface`（Task 4）→ `similarMerges`（Task 5）命名一致；`CodeIndex` 的字段在各 Task 里累加而非改名（`pages`/`outline`/`importedBy`）。

**已知风险：**
1. `pages.json` 只存在于 uni-app 类仓，pc 仓可能没有——Task 1 完成后 pc 的页面清单仍可能是 3 条。这不是 bug，是事实；报告里必须写出来。
2. Task 4 的提示词变长会让模型输出变慢、可能跑偏。验收时同时看「材料是否变慢/变差」，若变差就回退这一段（保留索引，不接提示词）。
3. Task 5 的先例若「不像」，宁可不接——宁可材料少一句，也不要给一句错的话。
