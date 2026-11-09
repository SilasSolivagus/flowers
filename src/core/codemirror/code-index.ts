import { reverseImports } from './reverse-imports.js';
import { expandTerms, isGenericWord, type Term } from './terms.js';

/**
 * 静态索引：一个仓库在一个提交上的「结构」，不读正文也能回答「这个功能在哪」。
 *
 * 起因是一张实测账单：走查的定位段跑了 29–48 秒，全是 8 个关键词 × 2 个仓库的 ssh
 * 往返；而且猜出来的文件经常不是那个功能（挑到过 `app/downLoad/index.ts`、
 * `src/enum/umengPoint.ts`、`src/pages/doc/privacy.vue`）。最后一个功能靠一张中英
 * 对照表加路径权重才勉强选中 `src/pages/search/search.vue`。
 *
 * 那三个毛病都是结构性的：
 * 1. **猜**：关键词命中 ≠ 这个文件实现这个功能。`privacy.vue` 里有「文件」两个字，
 *    但它不是文件管理页。
 * 2. **往返**：每个词一趟 ssh，延迟叠加。
 * 3. **索引缺失**：每次都要重新发现自己仓库里有什么。
 *
 * 所以这一层存的是三张关系，不是一个搜索框：
 * - `files`：路径 → 类别 + 导出符号 + 大小（「有哪些页面/组件/服务」）；
 * - `imports`：路径 → 它 import 的仓内路径（「这个页面用了哪些组件」，一跳图）；
 * - `routes`：路由 → 文件（「/search 是哪一页」，最强的那条信号）。
 *
 * **纯正则 + 目录约定，不引 AST**：多一个原生依赖（tree-sitter / ts-morph）换来的是
 * 更准的符号表，而要先证明的是「路由 + 导入」这一层够不够用。等它不够用了再谈 AST。
 */

// ─── 形状 ────────────────────────────────────────────────────────────────────

/**
 * 文件类别。`route` 是**路由表本身**（`router.js` / `pages.json`），不是页面：
 * 它没有自己的界面，但它定义了「哪条路径落到哪个文件」。
 */
export type FileKind = 'page' | 'component' | 'service' | 'state' | 'route' | 'other';

export type IndexFile = {
  kind: FileKind;
  /** 导出符号名（`searchFiles`、`Search`）。只留名字，不留签名。 */
  exports: string[];
  /** 字节数：写进索引是为了回答「这棵树有多大」，不参与打分。 */
  size: number;
};

export type IndexRoute = {
  /** 路由路径，如 `/search` 或 `pages/search/search`。 */
  route: string;
  /** 落到哪个文件（解不出来就是空串——如实留着，别丢）。 */
  file: string;
  /** 页面标题（`name` / `navigationBarTitleText`），没有就是空串。 */
  title: string;
};

/**
 * 一条**页面清单**（Task 1）：应用自己说的那些页面，以及我们按目录补的那些。
 *
 * 它与 `IndexRoute` 的区别不是「有没有文件」，而是**谁说的**：`routes` 回答「这条路径
 * 落到哪个文件」，`pages` 回答「这个应用有哪些屏」。评估材料要的是后者——它最容易
 * 编出来的错误是「加一个分享页」，而分享页已经在 `pages.json` 里；没有这份清单，
 * 模型只能从目录名猜，猜出来的页面既可能重复也可能不存在。
 */
export type IndexPage = {
  /** 路由，统一带前导 `/`（`pages.json` 的 `path` 是相对 `src/` 的说明符，不是路由）。 */
  route: string;
  /** 标题（`navigationBarTitleText`）。约定推出来的那一条没有标题——null 而不是空串。 */
  title: string | null;
  /** `pages.json` 是**它自己说的**；`convention` 是我们按 `pages/<dir>/<name>` 猜的。 */
  source: 'pages.json' | 'convention';
};

/**
 * 一页里用到的一个组件（Task 2 的 outline 第一层），或一个文件对外提供的符号（Task 2b）。
 *
 * 只排到「template / JSX 里的标签」这一层是刻意的：评估要回答的是「这页里已经有搜索框
 * 吗」，而那个答案就是标签名本身。`kind` 现在产六种：
 * - `component-use`：`.vue` 的 template 与 `.tsx` / `.jsx` 的 JSX 里**大写开头**的标签；
 * - `symbol`：`.ts` / `.tsx` 没有 JSX 可言时，文件 `export` 出来的那些名字；
 * - `go-func` / `go-method` / `go-struct` / `go-iface`：Go 仓的顶层声明（见 `goOutline`）。
 *   四种分开而不共用 `symbol`，是因为后端材料要说的话不一样：「有没有这个方法」与
 *   「有没有这个结构体」是两个问题，混成一个 kind 之后调用方还得回头解析名字。
 * 留 `tag` 是为了将来把「原生标签」也记下来时不改形状（`div` / `li` 这类现在**不进** outline）。
 */
export type OutlineNode = {
  kind: 'component-use' | 'tag' | 'symbol' | 'go-func' | 'go-struct' | 'go-iface' | 'go-method';
  name: string;
  /** 1 起算的全文行号（`grep -n` 对得上）。 */
  line: number;
};

export type CodeIndex = {
  repo: string;
  /** 这份索引描述的是哪个提交。**主键的一半**：sha 一变，索引自然失效。 */
  sha: string;
  files: Record<string, IndexFile>;
  /** path → 被它 import 的仓内路径（外部包不进来）。 */
  imports: Record<string, string[]>;
  /**
   * path → 引用了它的文件路径（Task 3）。**装配期由 `imports` 现算**，不落库。
   *
   * 为什么需要它：`imports` 只能回答「这个文件用了谁」，而评审要回答的是「改它会波及
   * 几个页面」。方向必须反过来一次——见 `reverse-imports.ts`。没有入边的文件不占键
   * （不制造空数组噪音）。
   */
  importedBy: Record<string, string[]>;
  routes: IndexRoute[];
  /** 页面清单：`pages.json` 自己说的 ＋ 目录约定补的（同一条 route 时前者胜出）。 */
  pages: IndexPage[];
  /**
   * path → 这个文件的结构轮廓（Task 2 / 2b：`.vue` 的 template 组件、`.tsx` / `.jsx`
   * 的 JSX 标签、`.ts` 的导出符号；一个都没有的文件不占键）。
   */
  outline: Record<string, OutlineNode[]>;
  /**
   * 这一棵树里**因为「生成代码」被跳过**的文件数（`isGeneratedSource`）。
   *
   * 为什么这个数必须挂在索引上、而不是只留在日志里：`files_total - files_indexed` 的差
   * 本来是「要解释的那部分」，而生成代码是其中**完全正当**的一块。少了这个数，
   * 覆盖率表会把 231 个文件写成「索引看不见」，于是下一次有人以为解析器漏了半天，
   * 去调一个没坏的东西。有了它，表上能写 `indexed 352 / skipped-generated 231`。
   */
  skippedGenerated: number;
  /** 建索引的时刻（ISO）。第二次读到同一个 `(repo, sha)` 时，这个值不该变。 */
  builtAt: string;
};

/** 索引里会产生的类别计数（报告与 CLI 用）。 */
export type KindCounts = Record<FileKind, number>;

export const EMPTY_KIND_COUNTS: KindCounts = {
  page: 0, component: 0, service: 0, state: 0, route: 0, other: 0,
};

/**
 * 解析前给每个**非 `.vue`** 文件留多少行：导入/导出/路由表都在文件头部。
 *
 * `.vue` 与 `pages.json` 不再走这条截断（见 `index-store.ts` 的 `clipFor`）：它们的
 * template 与页面清单会在第 80 行之后，截掉就等于让「这页有什么组件」这一层失真。
 */
export const HEAD_LINES = 80;

/**
 * 索引的时间戳，**只到秒**。
 *
 * 为什么要截到秒：它要原样往返一次数据库（`jsonb` 之外的那一列是 timestamptz）。
 * 毫秒写进去、读回来会被 pg 的文本表示吃掉末尾的零（`.100` → `.1`），于是
 * 「同一个 sha 第二次读到的是不是原来那一行」这个判断会在毫秒位上假失败。
 * 秒级足够回答「这份索引是什么时候建的」。
 */
export function indexTimestamp(date: Date = new Date()): string {
  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString();
}

/** 一批源码文件（内容只含前 `HEAD_LINES` 行）。 */
export type SourceEntry = { path: string; size: number; text: string };

// ─── 分类：路径即约定 ────────────────────────────────────────────────────────

/**
 * uni-app 的路由表：**唯一**一种值得进索引的 json。
 *
 * 为什么只放行这一个名字：索引不是「全仓 json 搜索」。`package-lock.json`、`tsconfig.json`
 * 一次能到几百 KB，进来只会让每一块内容都付一次读取与解析，而它们永远不是「这个功能
 * 在哪」的答案。`pages.json` 不同：它本身就是一份页面清单。
 */
export const PAGES_JSON = /(^|\/)pages\.json$/i;
const ROUTE_FILE = PAGES_JSON;
const ROUTER_DIR = /(^|\/)routers?\//i;
const PAGE_DIR = /(^|\/)(pages?|views?|screens?)\//i;
const COMPONENT_DIR = /(^|\/)components?\//i;
const SERVICE_DIR = /(^|\/)(services?|apis?)\//i;
const STATE_DIR = /(^|\/)(stores?|hooks?|composables?)\//i;

/**
 * **库仓的平铺入口**：`src/index.ts` / `src/index.tsx` / `lib/index.js` 这一类。
 *
 * 为什么需要它（2026-11-09 实测）：`123pan-virtuallist-antd` 的 38 个文件里**只有一个**
 * 产品源码——`src/index.tsx`（其余 37 个是 `.eslintrc.js`、`rollup.config.js`、
 * `jest.config.js`、`docs/` 下的 20 个 md、`docs/examples/*.tsx` 演示、`__mocks__/`、
 * `tests/`、`.umirc.ts`、`tsconfig.json`）。组件库没有 `components/`、没有 `pages/`，
 * 于是它落 `other`，整个仓 **0/38**——而 0 在覆盖率表里与「这个仓不值得接」长得一样。
 *
 * 为什么判 `component` 而不是新造一个 kind：`FileKind` 是**前端角色**的轴
 * （页面/组件/服务/状态/路由表），一个组件库的入口导出的就是组件；新加 `'entry'` 会让
 * `KIND_RANK`、`locate` 的排序、以及所有穷举 `FileKind` 的地方各多一条分支，而它能表达的
 * 信息（「这个文件是库的公开面」）在这张表里没有消费者。
 *
 * **故意窄**：只认 `src/` 或 `lib/` 的**直接子文件**且名字正好是 `index.<源码扩展名>`。
 * 更宽的写法（`src/` 下的任意源码、`app/index.ts`、任意深度的 `index.ts`）会把每个 app 仓的入口与每个
 * 目录的 barrel 都收进来——那正是这条规则要避免的「什么都算组件」。副作用要说清：
 * 一个普通 app 仓的 `src/index.tsx`（真正的应用入口）此后也会以 `component` 进索引，
 * 那是这一类文件在 `locate` 里最接近的桶，而不是「它真的是个组件」。
 */
const LIB_ENTRY = /^(?:src|lib)\/index\.(?:ts|tsx|js|jsx|mjs|cjs|vue)$/i;

/** 只认这几种扩展名：索引不是「全仓文本搜索」。`.go` 是 2026-11-08 扩的（后端 35 条需求）。 */
export const CODE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|vue|go)$/i;

/**
 * Go 的**测试文件**：`xxx_test.go` 与它同目录的 `_test.go` 辅助件。
 *
 * 为什么整类排除而不是「索引进去但 outline 留空」：`_test.go` 里的 `TestCreateFolder`
 * 命中「文件夹」这个词时，`locate` 会把它当候选交给材料——而材料照着测试名说
 * 「已有创建文件夹的接口」，那是把**测试**当成**产品**。测试不是产品，一行都不该进。
 * 代价：覆盖率的分母（`ls-tree` 总数）里还有它们，所以 Go 仓的 `files_indexed/files_total`
 * 天生小于 1；报告里要把这一条写清，别让人以为是漏索引。
 */
const GO_TEST_FILE = /_test\.go$/i;

/**
 * 生成代码的标准头（Go 官方规定的形状：`^// Code generated .* DO NOT EDIT\.$`）。
 *
 * 为什么要把它从索引里**整类剔掉**（2026-11-09，接 79 个 Go 仓之前）：
 * `apisrv` 的 583 个可索引文件里有 231 个（39.6%）是 GoFrame 生成的 model / dao ——
 * 它们进 outline 之后，材料会把 `UserVip` 这种自动生成的结构体当成「产品已有的能力」。
 * 那不是信息缺失，是**一句假话**：这些结构体是数据库表的镜像，不是任何人决定要做的功能。
 *
 * 口径两条，都照着 Go 自己的定义来（不是我们猜的）：
 * 1. **只认注释头**，且必须在**前几行**——`go/ast.IsGenerated` 的口径是「package 子句之前、
 *    整行匹配」。我们读到的只是一块内容的前 80 行，所以按「前 5 行」扫，足够覆盖
 *    build tag 之后的那个位置（实测 GoFrame 在 `package` 上一行）。
 * 2. **不认路径**：`model/` `dao/` 里也有手写文件，按目录剔会把真产品代码一起丢掉。
 *    生成与否写在文件自己身上，就按文件自己的字说。
 *
 * 一处技术债：`blob_index` 是内容地址，**这次之前**解析过的块不会有这个判断的结果
 * （那时还没有这条规则）。要给已有内容重新判定一次，得整表重算（`--rebuild` /
 * `forgetBlobs`），见报告里的 `apisrv` before/after。
 */
const GENERATED_HEADER = /(?:\/\/|\/\*)\s*Code generated .*DO NOT EDIT\./;

/** 扫多少行找那一句：Go 的约定是「package 之前」，实测都在前 3 行。 */
export const GENERATED_SCAN_LINES = 5;

/**
 * 这块内容是不是**生成出来的**（`Code generated … DO NOT EDIT.`）。
 *
 * 纯函数、只看前 `GENERATED_SCAN_LINES` 行：调用方传进来的是「文件开头」，
 * 全量细读没有意义（也和索引层的读取预算一致）。
 */
export function isGeneratedSource(text: string): boolean {
  const lines = text.split('\n', GENERATED_SCAN_LINES);
  return lines.some((line) => GENERATED_HEADER.test(line));
}

/**
 * 一个路径属于哪一类。**顺序即优先级**：
 * - `.go` 先判并**一律** `service`（见下）；
 * - `pages.json` 与 `router/` 再判：它们是路由表，比「页面」更该被当成结构；
 * - `pages/`：`pages/Search/api.ts` 描述的是「这一页」，不是「一个接口」；
 * - 然后是组件、服务、状态。
 *
 * 认不出的落 `other`（等于「不进索引」）：一个仓里大量是配置、类型、工具函数，
 * 它们不会成为「这个功能在哪」的答案，进来只会稀释候选。
 *
 * **为什么 `.go` 不走目录约定、直接判 `service`**：`FileKind` 这一根轴是**前端角色**
 * 的轴（页面/组件/服务/状态）。Go 仓里没有「一屏」也没有「一个可复用组件」——
 * `apisrv/component/` 是一个库包、`app/` 是 handler、`service/` 是业务层，它们的角色
 * 完全相同：服务端实现。若沿用目录约定，`apisrv/component/*.go` 会被判成 `component`
 * （于是定位排序把它当成「前端组件」抬到页面前面），`app/` / `library/` / `constvar/`
 * 会落 `other`（于是整个仓又变成 0）。两种错法都不如一个诚实的桶：`.go` = `service`。
 */
export function classifyKind(path: string): FileKind {
  const clean = path.replace(/^\.?\//, '');
  if (/\.go$/i.test(clean)) return 'service';
  if (ROUTE_FILE.test(clean) || ROUTER_DIR.test(clean)) return 'route';
  if (PAGE_DIR.test(clean)) return 'page';
  if (COMPONENT_DIR.test(clean)) return 'component';
  if (SERVICE_DIR.test(clean)) return 'service';
  if (STATE_DIR.test(clean)) return 'state';
  if (LIB_ENTRY.test(clean)) return 'component';
  return 'other';
}

/**
 * 这个路径要不要进索引：类别认得出，扩展名是源码（或它是 `pages.json`），且不是
 * Go 的测试文件（见 `GO_TEST_FILE`）。
 */
export function isIndexable(path: string): boolean {
  if (GO_TEST_FILE.test(path)) return false;
  return (CODE_EXT.test(path) || PAGES_JSON.test(path)) && classifyKind(path) !== 'other';
}

// ─── 抽取：导入 / 导出 ───────────────────────────────────────────────────────

const FROM_SPEC = /\bfrom\s*['"]([^'"]+)['"]/g;
const CALL_SPEC = /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const BARE_IMPORT = /^\s*import\s+['"]([^'"]+)['"]/gm;

/** `import Foo from 'x'`：默认导入的那个名字（路由表里 `component: Foo` 靠它落地）。 */
const DEFAULT_IMPORT = /^\s*import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s+from\s*['"]([^'"]+)['"]/;

/** `const Foo = lazy(() => import('x'))` / `defineAsyncComponent(() => import('x'))`。 */
const LAZY_DECL = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:React\s*\.\s*)?(?:lazy|defineAsyncComponent)\s*\(/;
const LAZY_INLINE = /\bimport\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?['"]([^'"]+)['"]/;

/** 导入语句里的模块说明符（去重、保持出现顺序）。 */
export function importSpecs(text: string): string[] {
  const out: string[] = [];
  const push = (spec: string | undefined): void => {
    const clean = (spec ?? '').trim();
    if (clean !== '' && !out.includes(clean)) out.push(clean);
  };
  for (const re of [FROM_SPEC, CALL_SPEC, BARE_IMPORT]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) push(m[1]);
  }
  return out;
}

/**
 * 默认导入的本地名 → 模块说明符。
 *
 * 只收默认导入与 `lazy`/`defineAsyncComponent`：路由表里 `component: Search` 指的是
 * **默认导出**，而 `import { Search } from 'x'` 是命名导出——两者混在一起会让路由
 * 指到错的文件。多行 `const Foo = lazy(\n () => import('x')\n)` 通过「声明行 + 往后
 * 找 import()」处理。
 */
export function localNames(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const named = DEFAULT_IMPORT.exec(line);
    if (named !== null) {
      const name = named[1] ?? '';
      const spec = named[2] ?? '';
      if (name !== '' && spec !== '') out.set(name, spec);
      continue;
    }
    const lazy = LAZY_DECL.exec(line);
    if (lazy === null) continue;
    const name = lazy[1] ?? '';
    const inline = LAZY_INLINE.exec(line);
    if (inline !== null) {
      out.set(name, inline[1] ?? '');
      continue;
    }
    // 多行写法：从声明行往后最多看 4 行。
    for (let k = i + 1; k < Math.min(i + 5, lines.length); k += 1) {
      const next = LAZY_INLINE.exec(lines[k] ?? '');
      if (next !== null) {
        out.set(name, next[1] ?? '');
        break;
      }
    }
  }
  return out;
}

const EXPORT_DECL = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST = /\bexport\s*\{([^}]*)\}/g;
const EXPORT_DEFAULT_ID = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/gm;
const SCRIPT_SETUP = /<script[^>]*\bsetup\b[^>]*>([\s\S]*?)<\/script>/g;
const SETUP_DECL = /^\s*(?:export\s+)?(?:async\s+)?(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm;
/**
 * `name: 'Xxx'` 里的组件名（`defineComponent({ name: 'SearchEntrance' })`）。
 *
 * **2026-11-09 事故后重写，两条改动都是为了让这条扫描是线性的**：
 *
 * 1. 加 `g`。原来是 `/\bdefineComponent\s*\(|name\s*:\s*['"]([\w$-]+)['"]/`——**没有 `g`**，
 *    却被下面那个 `for (… exec(text) …)` 循环反复执行。**不带 `g` 的 `exec` 每次都从
 *    下标 0 重新开始**，于是同一个匹配被无限次命中：`SvgIcon/index.vue`（903 字节，里面有
 *    `defineComponent(`）让那个循环变成死循环，15 秒跑了 580 万次 `exec`，`platform-fontend`
 *    与 `fe-tool` 的索引因此永远不返回、整晚的索引被一个文件按住。sample 出来的栈停在
 *    `RegExpPrototypeExec`，看上去像回溯爆炸，实际是**匹配永不前进**——两者的区别很大：
 *    回溯是「一次 exec 太久」，这里是「exec 次数无限」。
 * 2. 去掉左半边 `\bdefineComponent\s*\(`。那个分支一个字符都不捕获（`m[1] === undefined`，
 *    原代码在 `if` 里什么都不做），它对结果的唯一作用是「这个文件里得有 defineComponent」——
 *    那是调用方用 `indexOf` 判的一句话。留在正则里只会多一条分支、多一种回溯形状。
 *
 * 现在的形状：`name` `\s*` `:` `\s*` 引号 `[\w$-]+` 引号。没有嵌套量词、没有量词套量词、
 * 没有共享前缀的多分支，扫描一次只会往前走，命中与不命中都是 O(输入长度)。
 * **口径没变**：仍然只看 `name:` 后面的值、仍然只在文件里出现 `defineComponent` 时才看。
 */
const COMPONENT_NAME = /name\s*:\s*['"]([\w$-]+)['"]/g;

/**
 * 导出符号。
 *
 * 为什么连 `<script setup>` 里的顶层 `const` 也算：uni-app 的页面就是
 * `<script lang='ts' setup>` 加一堆 `const`/`function`——它没有 `export` 关键字，
 * 但那个页面的「符号」正是这些名字（`getList`、`searchValue`）。
 *
 * 为什么 `.vue` 之外也会看 `name:`：`defineComponent({ name: 'SearchEntrance' })`
 * 是组件在运行时的名字，路径拼写与它不一致时（`search-entrance/index.vue`）它有用。
 */
export function exportsOf(text: string, path: string): string[] {
  const out: string[] = [];
  const push = (name: string | undefined): void => {
    const clean = (name ?? '').trim();
    if (clean === '' || out.includes(clean)) return;
    if (out.length >= 40) return;
    out.push(clean);
  };

  for (const re of [EXPORT_DECL, EXPORT_DEFAULT_ID]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) push(m[1]);
  }
  EXPORT_LIST.lastIndex = 0;
  for (let m = EXPORT_LIST.exec(text); m !== null; m = EXPORT_LIST.exec(text)) {
    for (const item of (m[1] ?? '').split(',')) {
      // `a as b`：对外叫 b。
      const alias = /\bas\s+([A-Za-z_$][\w$]*)/.exec(item);
      push(alias === null ? item.trim() : (alias[1] ?? ''));
    }
  }
  if (/\.vue$/i.test(path)) {
    SCRIPT_SETUP.lastIndex = 0;
    for (let m = SCRIPT_SETUP.exec(text); m !== null; m = SCRIPT_SETUP.exec(text)) {
      SETUP_DECL.lastIndex = 0;
      const block = m[1] ?? '';
      for (let d = SETUP_DECL.exec(block); d !== null; d = SETUP_DECL.exec(block)) push(d[1]);
    }
  }
  // 门槛用 `indexOf`（单次前向扫描）：`name:` 在 vue/react 仓里满地都是，只有在组件
  // **定义**文件里它才是「组件名」，而没有 `defineComponent` 的文件里这一趟没必要跑。
  if (text.indexOf('defineComponent') !== -1) {
    COMPONENT_NAME.lastIndex = 0;
    // 循环安全的前提是这条正则带 `g`（见 `COMPONENT_NAME` 的注释）：带 `g` 的 `exec`
    // 每命中一次都把 `lastIndex` 推到匹配之后，匹配长度 ≥ 5 个字符，所以必然前进。
    for (let m = COMPONENT_NAME.exec(text); m !== null; m = COMPONENT_NAME.exec(text)) {
      push(m[1]);
    }
  }
  return out;
}

// ─── 解析：模块说明符 → 仓内路径 ─────────────────────────────────────────────

const RESOLVE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.mjs', '.cjs', '.json'] as const;
const INDEX_STEMS = ['/index', '/Index', '/main'] as const;

/** 目录栈归一化（处理 `..` 与 `.`，不碰文件系统）。 */
export function normalizeJoin(base: string, rel: string): string {
  const parts = [
    ...(base === '' ? [] : base.split('/')),
    ...rel.split('/'),
  ];
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

function dirOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

function stripExt(path: string): string {
  return path.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs|vue|json)$/i, '');
}

/**
 * 一个模块说明符落到仓内哪个文件。
 *
 * 四条路，按优先级：
 * 1. **相对路径**（`./x`、`../x`）——最确定的，直接相对当前文件归一化；
 * 2. **`@/` 与 `~/` 别名**——两个仓都在 tsconfig 里把 `@/*` 指到 `src/*`（uni-app
 *    的 `<script setup>` 里全是 `@/components/...`），`~/` 在别的工程里也指同一处；
 * 3. **裸路径**（`pages/Login/login`）——`123pan-pc` 的 `baseUrl: "./"` 让这种写法
 *    合法，先按仓根试，再按 `src/` 试；
 * 4. **后缀兜底**——`pages.json` 的 `"path": "pages/search/search"` 是相对 `src/`
 *    的，所以「整棵树里谁以它结尾」是唯一靠谱的解法。
 *
 * 解不出来（`vue`、`@dcloudio/uni-app` 这种外部包）返回 `null`：外部包不进索引，
 * 进了只会让「被引用」这个信号变噪音。
 */
export function resolveSpecifier(
  spec: string,
  from: string,
  files: ReadonlySet<string>,
): string | null {
  const raw = spec.split('?')[0]?.split('#')[0]?.trim() ?? '';
  if (raw === '') return null;

  const bases: string[] = [];
  const add = (value: string): void => {
    const clean = normalizeJoin('', value);
    if (clean !== '' && !bases.includes(clean)) bases.push(clean);
  };

  if (raw.startsWith('.')) {
    add(normalizeJoin(dirOf(from), raw));
  } else if (raw.startsWith('@/')) {
    add(normalizeJoin('src', raw.slice(2)));
    add(raw.slice(2));
  } else if (raw.startsWith('~/')) {
    add(normalizeJoin('src', raw.slice(2)));
    add(raw.slice(2));
  } else if (raw.startsWith('/')) {
    add(raw.slice(1));
  } else {
    add(raw);
    add(normalizeJoin('src', raw));
  }

  const tryBase = (base: string): string | null => {
    if (files.has(base)) return base;
    for (const ext of RESOLVE_EXT) {
      if (files.has(base + ext)) return base + ext;
    }
    for (const stem of INDEX_STEMS) {
      for (const ext of RESOLVE_EXT) {
        if (files.has(base + stem + ext)) return base + stem + ext;
      }
    }
    return null;
  };

  for (const base of bases) {
    const hit = tryBase(base);
    if (hit !== null) return hit;
  }

  // 后缀兜底：只在「只有一个文件以它结尾」时采纳，两个同名就放弃——猜错比空着糟。
  // 目录导入（`import('pages/VideoPage')`）在这里补一次 `/index`。
  const suffixes: string[] = [];
  for (const base of bases) {
    suffixes.push(base, `${base}/index`, `${base}/Index`);
  }
  for (const base of suffixes) {
    const matches: string[] = [];
    for (const path of files) {
      const stem = stripExt(path);
      if (stem === base || stem.endsWith(`/${base}`)) matches.push(path);
      if (matches.length > 1) break;
    }
    if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  }
  return null;
}

// ─── 抽取：页面清单（`pages.json`） ─────────────────────────────────────────

/**
 * 去掉 `//` 与 `/* … *\/` 注释，**字符串里的不算**。
 *
 * 为什么必须先去注释：真实的 `pages.json` 里是 uni-app 的条件编译注释
 * （`// #ifdef MP-ALIPAY`），`JSON.parse` 会在这第一行就整份失败——实测
 * `123pan-uni-app/src/pages.json` 250 行、27 条页面，`JSON.parse` 一个都不给。
 * 而字符串里的 `//`（标题写成 `https://123pan.com`）不能被当成注释吃掉，否则后面
 * 的声明会连着字符串一起消失。所以扫描时带 `inString` 与转义状态。
 */
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (inString) {
      if (ch === '\\') {
        out += ch + (text[i + 1] ?? '');
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * `"pages": [ … ]` 里的**顶层对象**原文（注释已经去掉）。
 *
 * 为什么不用 `JSON.parse`：注释之外还有一处坑——条件编译让两条分支之间**没有逗号**
 * （`} // #endif` 换行 `// #ifdef` 换行 `{`）。去掉注释之后那份文本是 `} {`，
 * 无论怎么补都不是合法 JSON。而我们要的只有每个页面对象里的两个字符串，所以这里按
 * 大括号深度切对象，逗号存不存在都不影响——与 `routeDecls()` 用正则读路由是同一个理由。
 */
function pagesArrayItems(text: string): string[] {
  const at = /"pages"\s*:\s*\[/.exec(text);
  if (at === null) return [];
  const items: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = at.index + at[0].length; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        items.push(text.slice(start, i + 1));
        start = -1;
      }
      continue;
    }
    // 数组结束（深度回到 0 时遇到 `]`）：后面的 `subPackages` / `tabBar` 不是 pages。
    if (ch === ']' && depth === 0) break;
  }
  return items;
}

const PAGE_PATH = /"path"\s*:\s*"([^"]*)"/;
const PAGE_TITLE = /"navigationBarTitleText"\s*:\s*"([^"]*)"/;

/** 一条 `pages.json` 声明（**内容级**：不问这块内容将来叫哪个路径）。 */
function pageEntries(text: string): Array<{ path: string; title: string | null }> {
  const out: Array<{ path: string; title: string | null }> = [];
  for (const item of pagesArrayItems(stripJsonComments(text))) {
    const at = PAGE_PATH.exec(item);
    const path = (at?.[1] ?? '').trim();
    if (path === '') continue;
    out.push({ path, title: PAGE_TITLE.exec(item)?.[1] ?? null });
  }
  return out;
}

/**
 * 只认 `pages.json` 这种明确的页面清单。为什么不做通用路由解析：pc 仓的路由在
 * cross-frontend 里、uni 的路由靠目录约定，两者都不是一个能被同一条规则覆盖的东西；
 * 猜错会让评估材料把不存在的页面当成「现有」。
 *
 * `route` 补上前导 `/`：`pages.json` 写的是 `pages/share/index`（相对 `src/` 的说明符），
 * 而对外要回答的是「哪一屏」，前者带不带斜杠会让同一页在报表里出现两次。
 */
export function pagesFromConfig(path: string, text: string): IndexPage[] {
  if (!PAGES_JSON.test(path)) return [];
  return pageEntries(text).map((entry) => ({
    route: `/${entry.path.replace(/^\/+/, '')}`,
    title: entry.title,
    source: 'pages.json',
  }));
}

// ─── 抽取：路由 ──────────────────────────────────────────────────────────────

const ROUTER_PATH = /(?:^|[\s,{])path\s*:\s*['"]([^'"]+)['"]/g;
const ROUTER_COMPONENT = /\bcomponent\s*:\s*(?:([A-Za-z_$][\w$]*)|['"]([^'"]+)['"])/;
const ROUTER_ELEMENT = /\belement\s*:\s*<\s*([A-Za-z_$][\w$]*)/;
const ROUTER_TITLE = /\b(?:name|title)\s*:\s*['"]([^'"]+)['"]/;
const JSON_PATH = /"path"\s*:\s*"([^"]+)"/g;
const JSON_TITLE = /"navigationBarTitleText"\s*:\s*"([^"]*)"/;

/**
 * 一条路由的**声明**：键与标题已经读出来了，但 `component` 还没有落到文件上。
 *
 * 为什么要把「读」与「解析」拆开（P4-11）：路由声明的全部依据是这块 blob 的内容，
 * 而落到哪个文件取决于**这一棵树的布局**。前者可以按内容地址缓存一次，后者必须
 * 每次读的时候现算。`kind` 说明这条声明是用哪种语法读出来的：
 * - `pages`：uni-app 的 `pages.json`（`"path": "pages/x/y"`，路径本身就是说明符）；
 * - `router`：React/Vue-Router 的路由表（`path: '/x'` + `component: Ident`）。
 */
export type RouteDecl = {
  kind: 'pages' | 'router';
  route: string;
  title: string;
  /** `component: Ident` / `element: <Ident />` 里的那个标识符；字面量或 json 声明时为空串。 */
  ident: string;
  /** `component: './x'` 的字面量，或 `pages.json` 的路径字符串（本身就是一个说明符）。 */
  spec: string;
};

/** 一条路由的解析结果：文件可能解不出来（留空，不猜）。 */
export type ParsedRoute = { route: string; file: string; title: string };

/**
 * 路由声明（**不解析**，纯内容）。
 *
 * 为什么按**内容**而不是文件名区分 `pages.json` 与路由表：这块 blob 不知道自己将来
 * 叫 `pages.json` 还是 `router.js`，而内容寻址要求「同样的内容 = 同样的解析结果」。
 * 判据是 `"pages": [`（uni-app 的页面数组）或 `"path": "…"`（带引号的键）——
 * react-router 的写法是 `path: '/x'`，两种不会互相误判（实测两个仓：
 * `123pan-uni-app/src/pages.json` 有 27 条，`123pan-pc/src/router/router.js` 一条都没有）。
 *
 * `pages.json` 那一条路走 `pageEntries()`（去注释 + 按深度切对象），标题直接取
 * `style.navigationBarTitleText`，不再靠「path 后面 400 字符里捞一个标题」。
 */
export function routeDecls(text: string): RouteDecl[] {
  const out: RouteDecl[] = [];

  const pages = pageEntries(text);
  if (pages.length > 0) {
    for (const entry of pages) {
      out.push({
        kind: 'pages',
        route: entry.path,
        title: entry.title ?? '',
        ident: '',
        spec: entry.path,
      });
    }
    return out;
  }

  JSON_PATH.lastIndex = 0;
  const isPages = JSON_PATH.exec(text) !== null;
  if (isPages) {
    JSON_PATH.lastIndex = 0;
    for (let m = JSON_PATH.exec(text); m !== null; m = JSON_PATH.exec(text)) {
      const route = (m[1] ?? '').trim();
      if (route === '') continue;
      const window = text.slice(m.index, m.index + 400);
      const title = JSON_TITLE.exec(window)?.[1] ?? '';
      out.push({ kind: 'pages', route, title, ident: '', spec: route });
    }
    return out;
  }

  ROUTER_PATH.lastIndex = 0;
  for (let m = ROUTER_PATH.exec(text); m !== null; m = ROUTER_PATH.exec(text)) {
    const route = (m[1] ?? '').trim();
    if (route === '') continue;
    // 窗口止于**下一个** `path:`：否则 `name:` 会从下一个路由对象里借过来
    // （实测 `/videoPage` 的标题变成了下一个路由的 `home`）。
    const raw = text.slice(m.index, m.index + 600);
    // 从**这个** `path:` 键之后开始找下一个（正则连前面的空白一起吃掉了，索引 0 不是 path）。
    const nextPath = raw.indexOf('path:', m[0].length);
    const window = nextPath < 0 ? raw : raw.slice(0, nextPath);
    const comp = ROUTER_COMPONENT.exec(window);
    const element = ROUTER_ELEMENT.exec(window);
    const ident = comp?.[1] ?? element?.[1] ?? '';
    const literal = comp?.[2] ?? '';
    const title = ROUTER_TITLE.exec(window)?.[1] ?? '';
    out.push({ kind: 'router', route, title, ident, spec: literal });
  }
  return out;
}

/**
 * React 路由表：`path: '/x'` 后面跟着 `component: Y`（或 `element: <Y />`）。
 *
 * 为什么在 `path` 之后**开一个窗口**找 `component` 而不是逐行配对：格式化之后
 * 一个路由对象可以写成三行，也可以一行；而 `path` 永远在 `component` 之前
 * （`123pan-pc` 的 `router.js` 就是这样）。窗口 600 字符，够一个路由对象，不够跨到
 * 下一个 `path`（实测下一个 `path` 至少隔着一个 route 对象）。
 *
 * 2026-11-08 起它只是 `routeDecls()` + 一次解析的薄包装：解析这一步必须发生在
 * 「有一棵树」的地方（`assembleIndex`），所以两件事被拆开了。
 */
export function parseRouterTable(
  text: string,
  resolveId: (name: string) => string | null,
  files: ReadonlySet<string>,
): ParsedRoute[] {
  const out: ParsedRoute[] = [];
  for (const decl of routeDecls(text)) {
    if (decl.kind !== 'router') continue;
    let file = '';
    if (decl.spec !== '') file = resolveSpecifier(decl.spec, '', files) ?? '';
    else if (decl.ident !== '') file = resolveId(decl.ident) ?? '';
    out.push({ route: decl.route, file, title: decl.title });
  }
  return out;
}

/**
 * 目录约定：`pages/<dir>/<name>` → `/<name>`，`index` 取上一级目录名。
 *
 * 为什么需要它：路由表只写得下「注册过的页面」，而一个页面文件常常是**子路由**
 * （`pages/doc/privacy.vue` 在 `pages.json` 里就是 `pages/doc/privacy`）。约定是
 * uni-app / React 目录树共同的那条：最后一段是名字，`index` 就用目录名。
 */
export function conventionRoute(path: string): string | null {
  const clean = path.replace(/^\.?\//, '');
  const segments = clean.split('/');
  const at = segments.findIndex((segment) => /^(pages?|views?|screens?)$/i.test(segment));
  if (at < 0) return null;
  const rest = segments.slice(at + 1);
  // 只认 `<pages>/<dir>/<name>` 这一层：再深一层通常是页面自己的子组件
  // （`pages/Login/components/BindPhoneModal/index.tsx`），给它们造路由等于造假。
  if (rest.length !== 2) return null;
  const dir = rest[0] ?? '';
  const name = stripExt(rest[1] ?? '');
  if (name === '') return null;
  if (/^index$/i.test(name)) return dir === '' ? null : `/${dir}`;
  // 名字要和目录同名（`Search/Search.tsx`、`search/search.vue`），或它是 `.vue`——
  // uni-app 的页面永远是 `.vue`。不同名的 `.ts`（`VideoPage/videoFileUtils.ts`）
  // 是这一页的工具函数，不是一页。
  if (name.toLowerCase() === dir.toLowerCase() || /\.vue$/i.test(clean)) return `/${name}`;
  return null;
}

// ─── 抽取：组件轮廓（outline 第一层） ───────────────────────────────────────

/** `<template>` 开标签（允许属性：`<template v-if="x">`）。 */
const TEMPLATE_OPEN = /<template(?:\s[^>]*)?>/i;
/** 组件标签：**大写开头**。`div` / `ul` / `li` 不是我们维护的东西，不进 outline。 */
const COMPONENT_TAG = /<([A-Z][A-Za-z0-9_]*)\b/g;

/** `.ts` 的导出函数（含 `export async function` 与 `export function*`）。 */
const TS_EXPORT_FN = /\bexport\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g;
/** `.ts` 的导出常量（hook、配置对象、单例都在这里）。 */
const TS_EXPORT_CONST = /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;

/** 偏移 → 1 起算的行号（`grep -n` 对得上）。 */
function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** `<!-- … -->` 抹成空格（换行保留）：`.vue` 的 template 里注释掉的旧组件不算这页的组件。 */
function maskHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (block) => block.replace(/[^\n]/g, ' '));
}

/**
 * 把注释与引号字符串抹成空格（换行保留）。
 *
 * 为什么必须抹：`.tsx` 里 `// <OldHeader /> 已删` 与 `const hint = '<LegacyBar />'`
 * 会让正则凭空造出两个不存在的组件，而评估材料会拿它们说「这页已经有这个组件了」。
 * 为什么抹成空格而不是删掉：**偏移与行号必须留在原地**——删字符会让后面每一个节点的
 * 行号都往前挪，而 outline 的 `line` 是要和 `grep -n` 对账的。
 *
 * 代价两处，都写在这里免得下次有人以为是 bug：模板字符串里的 `${…}` 会连插值一起被
 * 抹掉（JSX 写在插值里的情况不存在）；正则字面量（`/<[A-Z]/`）仍可能误命中——它没有
 * 「引号」可依，扫不出来。
 *
 * `rawBacktick`：反引号里的 `\` 算不算转义。JS 算（模板字符串），**Go 不算**——Go 的
 * 反引号是**原始字符串**，`\` 就是反斜杠本身。这一条不区分会出现真错位：`` `C:\` ``
 * 在 JS 语义下会把结尾的反引号吃掉，于是一整段代码被当成字符串抹掉，后面的
 * `func Foo(` 全部消失（少说）或者让下一个引号错位（编一个）。默认 `false` = JS 口径，
 * Go 的调用方显式传 `true`。
 */
function maskCode(text: string, opts: { rawBacktick?: boolean } = {}): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? '';
    const next = text[i + 1] ?? '';
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < text.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ' ';
      i += 1;
      while (i < text.length) {
        const inner = text[i] ?? '';
        if (inner === '\\' && !(opts.rawBacktick === true && quote === '`')) {
          out += '  ';
          i += 2;
          continue;
        }
        if (inner === quote) {
          out += ' ';
          i += 1;
          break;
        }
        out += inner === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** `.vue`：template 里的组件（Task 2 的原始口径；只多一条「注释抹成空格」，见下）。 */
function vueOutline(text: string): OutlineNode[] {
  const open = TEMPLATE_OPEN.exec(text);
  if (open === null) return [];
  const bodyStart = open.index + open[0].length;
  const close = text.lastIndexOf('</template>');
  if (close < bodyStart) return [];
  // `<!-- <LegacyBar /> 已删 -->` 在 Vue 仓里是最常见的一类注释，而注释掉的东西**不是**
  // 这页已经有的组件。`.tsx` 那半边一直跑 `maskCode`（注释也抹），这里不抹就是同一个
  // 文件类型两套口径：`.vue` 说「这页已经有 LegacyBar」，`.tsx` 不会说。
  // 抹成空格而不是删掉，理由与 `maskCode` 同一条：行号必须留在原地。
  const body = maskHtmlComments(text.slice(bodyStart, close));
  const before = text.slice(0, bodyStart).split('\n').length - 1;
  const out: OutlineNode[] = [];
  COMPONENT_TAG.lastIndex = 0;
  for (let m = COMPONENT_TAG.exec(body); m !== null; m = COMPONENT_TAG.exec(body)) {
    out.push({
      kind: 'component-use',
      name: m[1] ?? '',
      line: before + body.slice(0, m.index).split('\n').length,
    });
  }
  return out.filter((node) => node.name !== '');
}

/**
 * `<` 前面与标签名后面是什么，决定它是 JSX 标签还是**泛型实参**。
 *
 * 为什么必须有这一条：`useState<IFile>(null)` 在正则眼里就是一个大写开头的标签，而它会
 * 原样进 `blob_index.outline`，于是评估材料写「`/VideoPage` 已有组件 `IFile`」——`IFile`
 * 是一个类型参数（实测 `src/pages/VideoPage/VideoModule.tsx` 一行代码造出 3 个假组件）。
 *
 * 判据分两段，只为了「宁可少说一个真组件，也不编一个假组件」，同时不误伤同行嵌套：
 * - 前一字符是标识符字符或 `]` → 类型位置（`useState<IFile>`、`Array<T>`、`Foo<T>[]`…）；
 * - 前一字符是 `>` → 只有**标签名后面既没有属性也没有自闭合斜线**时才算泛型
 *   （`Foo<Bar>` / `Foo<Bar,>` 是这个形态）。`<div><HeaderBar /></div>` 这种同行嵌套
 *   前面也是 `>`，但名字后面跟的是属性或 `/>`，所以保留。
 */
function typeArgPosition(masked: string, index: number, name: string): boolean {
  const prev = masked[index - 1] ?? '';
  if (/[A-Za-z0-9_$]/.test(prev) || prev === ']') return true;
  if (prev !== '>') return false;
  const next = masked[index + 1 + name.length] ?? '';
  return next === '>' || next === ',';
}

/**
 * `.tsx` / `.jsx`：JSX 里**大写开头**的标签，与 `.vue` 的 template 同一条规矩。
 *
 * 为什么整份匹配而不是先找 `return (`：React 组件可以写成 `const Page = () => <div/>`、
 * 也可以 `return <A/>` 多行、还可以在 `?.` / `&&` 后面直接跟 JSX。找「起点」的规则一多
 * 就会漏，而「大写开头的标签」在这个文件类型里几乎没有别的含义——除了泛型实参，
 * 那一条由 `typeArgPosition` 单独挡掉。
 */
function jsxOutline(text: string): OutlineNode[] {
  const masked = maskCode(text);
  const out: OutlineNode[] = [];
  COMPONENT_TAG.lastIndex = 0;
  for (let m = COMPONENT_TAG.exec(masked); m !== null; m = COMPONENT_TAG.exec(masked)) {
    const name = m[1] ?? '';
    if (name === '') continue;
    if (typeArgPosition(masked, m.index, name)) continue;
    out.push({ kind: 'component-use', name, line: lineAt(masked, m.index) });
  }
  return out;
}

/**
 * `.ts`：`export` 出来的符号（PC 仓 184 个 `.ts` 没有 JSX，但有导出符号）。
 *
 * 为什么只认导出的、不认文件内的局部声明：`const local = 1` 满地都是，把它们记进
 * outline 等于给每个文件造几十行噪音；而「这一页/这个服务对外提供了什么」正是导出名。
 * 为什么两类合在一起按位置排序：`export const useA` 写在 `export function b` 前面时，
 * outline 的顺序必须与文件一致，否则同一份内容两次读出来的顺序会不一样。
 *
 * 为什么要先 `maskCode`：`// export const legacy = 1` / `'export const fromString = 2'`
 * 在这条正则眼里都是导出符号（实测一个文件里 4 条「导出」有 3 条出自注释与字符串），
 * 而它们会原样进 `blob_index.outline`。`.tsx` 那半边一直抹注释，`.ts` 不抹就是同一个
 * 索引里两套口径；`maskCode` 保留换行，所以行号不动。
 */
function symbolOutline(text: string): OutlineNode[] {
  const masked = maskCode(text);
  const hits: Array<{ index: number; name: string }> = [];
  for (const re of [TS_EXPORT_FN, TS_EXPORT_CONST]) {
    re.lastIndex = 0;
    for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
      const name = (m[1] ?? '').trim();
      if (name !== '') hits.push({ index: m.index, name });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return hits.map((hit) => ({ kind: 'symbol', name: hit.name, line: lineAt(masked, hit.index) }));
}

// ─── 抽取：Go 的顶层声明 ─────────────────────────────────────────────────────

/**
 * Go 的四种顶层声明。**为什么是正则而不是 AST**：tree-sitter / go/parser 都是新依赖，
 * 而这一层要回答的问题只有一个——「这个文件里有哪些函数/方法/类型」。Go 有一条对正则
 * 极友好的性质：`gofmt` 把每一条顶层声明都顶在第 0 列、`func` / `type` 关键字开头，
 * 于是 `^func` 这种锚点不需要任何缩进推断就能用（与 `.ts` 那半边必须逐行猜 `export`
 * 形成对比）。
 *
 * 正则的盲区（报告里也写了，因为这是选型的代价）：
 * - **接口里的方法**（`type X interface { Do(a int) error }` 里那些行）没有 `func`
 *   关键字，一个都不会被抽到——只有接口名进 outline；
 * - **多行 receiver**（`func (\n\ts *Server,\n) Name(`）会漏：`gofmt` 不这么排版，所以只在
 *   手写/生成代码里出现；
 * - **泛型类型参数里带换行或嵌套括号**（`func F[A interface{ M() }, B any]()`）能抽出名字，
 *   但 `[` 之后的形态没有校验——名字对了，签名理解不了；
 * - **构建标签**（`//go:build windows`）不看：同一个包里各平台的实现都会进 outline；
 * - **匿名函数、闭包**不算声明，正确跳过；**`func init()`** 按约定跳过（它不是产品能力）。
 */
const GO_FUNC = /^func\s+([A-Za-z_]\w*)\s*[([]/gm;
/** `func (r *Recv) Name(` / `func (Recv) Name(` / `func (r *Recv[T]) Name(`。 */
const GO_METHOD = /^func\s*\(\s*(?:[A-Za-z_]\w*\s+)?\*?\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\)\s*([A-Za-z_]\w*)\s*[([]/gm;
const GO_TYPE = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/gm;
/** 分组类型块：`type (` … `)`。条目按 gofmt 的**一个 tab** 缩进认。 */
const GO_TYPE_BLOCK_OPEN = /^type\s*\(\s*$/gm;
const GO_TYPE_BLOCK_ITEM = /^\t([A-Za-z_]\w*)\s+(struct|interface)\b/gm;
const GO_TYPE_BLOCK_CLOSE = /^\)/gm;

/** `type (` 块的内部区间（`[start, end)` 偏移）。没有闭合的块算到文件尾。 */
function goTypeBlocks(masked: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  GO_TYPE_BLOCK_OPEN.lastIndex = 0;
  for (let m = GO_TYPE_BLOCK_OPEN.exec(masked); m !== null; m = GO_TYPE_BLOCK_OPEN.exec(masked)) {
    const start = m.index + m[0].length;
    GO_TYPE_BLOCK_CLOSE.lastIndex = start;
    const close = GO_TYPE_BLOCK_CLOSE.exec(masked);
    const end = close === null ? masked.length : close.index;
    out.push([start, end]);
    if (close !== null) GO_TYPE_BLOCK_OPEN.lastIndex = end;
  }
  return out;
}

/**
 * `.go`：函数、方法、结构体、接口（2026-11-08；起因是后端 35 条需求对材料无话可说）。
 *
 * 方法名写成 `Recv.Name`（`Server.Handle`）：`apisrv/service/` 里 `Handle`、`List`、
 * `Get` 这类名字会在十几个 receiver 上重复出现，只留 `Handle` 的材料说不出「谁的 Handle」。
 *
 * 先 `maskCode(…, { rawBacktick: true })`：Go 仓里最常见的假声明是注释掉的旧接口
 * （`// func CreateFolder(`）与 SQL/JSON 字符串里的 `type X struct`。抹成空格保留换行，
 * 所以 `line` 仍是全文行号，`grep -n` 对得上。
 */
function goOutline(text: string): OutlineNode[] {
  const masked = maskCode(text, { rawBacktick: true });
  const hits: Array<{ index: number; kind: OutlineNode['kind']; name: string }> = [];

  GO_METHOD.lastIndex = 0;
  for (let m = GO_METHOD.exec(masked); m !== null; m = GO_METHOD.exec(masked)) {
    const name = (m[2] ?? '').trim();
    if (name === '' || name === 'init') continue;
    hits.push({ index: m.index, kind: 'go-method', name: `${m[1] ?? ''}.${name}` });
  }
  GO_FUNC.lastIndex = 0;
  for (let m = GO_FUNC.exec(masked); m !== null; m = GO_FUNC.exec(masked)) {
    const name = (m[1] ?? '').trim();
    // `func init()` 是包的初始化钩子，不是「这个仓提供的能力」。
    if (name === '' || name === 'init') continue;
    hits.push({ index: m.index, kind: 'go-func', name });
  }
  const typeHit = (index: number, name: string, keyword: string): void => {
    if (name === '') return;
    hits.push({ index, kind: keyword === 'struct' ? 'go-struct' : 'go-iface', name });
  };
  GO_TYPE.lastIndex = 0;
  for (let m = GO_TYPE.exec(masked); m !== null; m = GO_TYPE.exec(masked)) {
    typeHit(m.index, (m[1] ?? '').trim(), m[2] ?? '');
  }
  for (const [start, end] of goTypeBlocks(masked)) {
    const block = masked.slice(start, end);
    GO_TYPE_BLOCK_ITEM.lastIndex = 0;
    for (let m = GO_TYPE_BLOCK_ITEM.exec(block); m !== null; m = GO_TYPE_BLOCK_ITEM.exec(block)) {
      typeHit(start + m.index, (m[1] ?? '').trim(), m[2] ?? '');
    }
  }

  hits.sort((a, b) => a.index - b.index);
  return hits.map((hit) => ({ kind: hit.kind, name: hit.name, line: lineAt(masked, hit.index) }));
}

/**
 * 一个文件的结构轮廓（Task 2 / 2b）。
 *
 * 为什么最早只做 template、只做 `.vue`：评估要回答的是「这页里已经有什么组件」，template
 * 里的标签名就是答案，不需要进 script 解析 AST。**但实测把这条路走窄了**：`.vue` 那一半
 * 只有 uni-app 的 59 个文件，`123pan-pc`（184 个 `.ts`）与 `123pan-cross-frontend`
 * （50 `.ts` + 29 `.tsx`）的 outline 一个文件都没有——产品的一大半对评估没有任何信息。
 * owner 裁决后按扩展名分三条路：
 * - `.vue`：template 里的大写标签（闭合取**最后一个** `</template>`：template 里还有
 *   嵌套的 `<template v-if>` / `<template #slot>`，用第一个闭合会被内层截断，后面的组件
 *   全部消失——那正是「这页缺一个 X」类错误结论的来源）；
 * - `.tsx` / `.jsx`：JSX 里的大写标签（先剥注释与字符串，见 `maskCode`）；
 * - `.ts`：`export` 出来的函数与常量，kind 记 `symbol`（`.ts` 编译不过 JSX）。
 * 行号一律给全文行号（`grep -n` 对得上），不是块内偏移。
 *
 * 2026-11-08 加第四条：`.go` 走 `goOutline`（`func` / 方法 / `struct` / `interface`）。
 * 起因是一张实测账单：索引只认 `.ts/.tsx/.js/.jsx/.vue` 与 `pages.json`，于是
 * `123pan-gateway` 接进来、同步绿了、覆盖率 `0/49`——79 个 Go 仓一个都没接；而 35 条
 * 活需求挂着 `backend` 平台，材料对它们一个字都说不出来。`_test.go` 在 `isIndexable`
 * 那一层就被挡掉了，这里再挡一次：`outlineOf` 是公开函数，别的调用方可能直接喂它。
 */
export function outlineOf(path: string, text: string): OutlineNode[] {
  if (/\.go$/i.test(path)) return GO_TEST_FILE.test(path) ? [] : goOutline(text);
  if (/\.vue$/i.test(path)) return vueOutline(text);
  if (/\.[jt]sx$/i.test(path)) return jsxOutline(text);
  if (/\.ts$/i.test(path)) return symbolOutline(text);
  return [];
}

// ─── 装配 ────────────────────────────────────────────────────────────────────

export type ExtractInput = {
  repo: string;
  sha: string;
  /** 全树路径（含噪音外的全部文件），用来解析说明符与后缀。 */
  all: readonly string[];
  /** 进了索引的那一批文件（只有前 `HEAD_LINES` 行）。 */
  sources: readonly SourceEntry[];
  builtAt?: string;
};

// ─── 内容事实：一块 blob 说了什么（与路径无关，只与内容有关） ────────────────

/** 路径的扩展名（小写，不带点）。`blob_index.lang` 就是它。 */
export function langOf(path: string): string {
  const hit = /\.([A-Za-z0-9]+)$/.exec(path.trim());
  return hit === null ? '' : (hit[1] ?? '').toLowerCase();
}

/**
 * 一块 blob 向外的**引用**，全部保持未解析：
 * - `specs`：`import` / `require` / `import()` 的模块说明符（去重、保序）；
 * - `locals`：默认导入 / `lazy()` / `defineAsyncComponent()` 的本地名 → 说明符
 *   （路由表 `component: Search` 靠它落回文件，而 `import { Search }` 是命名导入，
 *   两者混在一起会让路由指到错的文件）；
 * - `routes`：这块内容里的路由声明（见 `routeDecls`）。
 *
 * 为什么一条解析结果都不存：解析要用**整棵树**（别名指向哪、`./x` 相对哪个目录、
 * 谁的路径以它结尾）。同一块 blob 在两个仓里可能落到不同文件上，把解析结果写进
 * 共享行就是拿 A 仓的布局去解释 B 仓的代码。代价是读的时候多几十次字符串比较。
 */
export type BlobRefs = {
  specs: string[];
  locals: Record<string, string>;
  routes: RouteDecl[];
};

/** 一块 blob 的解析结果。**除 `lang` 外不含任何路径信息**，所以可以按内容地址缓存。 */
export type ParsedBlob = {
  lang: string;
  symbols: string[];
  refs: BlobRefs;
  /** 这一块内容里 template 用到的组件（`.vue` 之外恒为空）。 */
  outline: OutlineNode[];
  /** 这一块内容是不是一份页面清单（进索引的 json 只有 `pages.json`）。 */
  pages: IndexPage[];
};

/**
 * 解析一块 blob。P4-11 的核心：这个函数只吃「内容 + 最后一次决定性的路径信息
 * （扩展名）」，所以同一份内容在 40 个提交、2 个仓里只跑一次。
 *
 * 为什么符号抽取仍然要一个假路径（`index.<lang>`）：`exportsOf` 只在一处用路径——
 * 判断是不是 `.vue`（`.vue` 的 `<script setup>` 没有 `export`，顶层声明就是它的符号）。
 * 用 `index.<lang>` 与用真路径的结果**逐字相同**，而前者让「同一内容 → 同一符号表」
 * 变成不依赖调用顺序的事实。`outlineOf` / `pagesFromConfig` 同理：它们各自只看扩展名。
 *
 * **两个文本参数（I3 的裁决）**：`text` 是**符号与引用**的输入，`fullText` 是
 * **outline 与 pages** 的输入。调用方（`index-store.ts` 的 `parseInto`）给前者的是
 * 「文件头 `HEAD_LINES` 行」，给后者的是整份内容。为什么必须分开：整份读是 outline 的
 * 需求（`</template>` 常在 80 行之后），但它顺手让 `exports` 多看到 545 个导出名，
 * 而 `exports` 是 `locate` 的评分输入——那是计划 §0.2 明确的非目标。两条需求方向相反，
 * 只能各给各的文本；`fullText` 缺省等于 `text`，纯函数调用方（用例、`extractIndex`）
 * 不需要关心这件事。
 */
export function parseBlob(text: string, path: string, fullText: string = text): ParsedBlob {
  const lang = langOf(path);
  const routes = routeDecls(text);
  const locals: Record<string, string> = {};
  // 本地名映射只对路由表有意义（其它文件的 `import X from 'y'` 不进索引的图），
  // 而 `localNames` 要逐行扫——不给每块 blob 都付这笔钱。
  if (routes.length > 0) {
    for (const [name, spec] of localNames(text)) locals[name] = spec;
  }
  /**
   * **Go 的 `imports` 一律留空**（2026-11-08 的裁决），理由不是懒：
   *
   * `imports` 这张图是 `path → 仓内**文件**路径`，而 Go 的导入单位是**包（一个目录）**。
   * `apisrv` 的 import 写的是完整模块路径
   * （`codeup.aliyun.com/…/123pan/apisrv/app/grpcserver`），要落地必须先把模块路径
   * 去掉前缀——而模块根不一定是仓根（`cmd/x/go.mod` 这种多模块仓），前缀还随 `go.mod`
   * 的 `module` 行变。落地之后拿到的仍是一个目录，目录里有 N 个文件，随便挑一个写进
   * `imports` 就是**编一条边**：`importedBy` 会照着这条假边给「改它会波及几个页面」下
   * 结论。这个仓已经被一个「猜」出来的 matcher 坑过一次（`resolveSpecifier` 的后缀
   * 兜底就是这么来的：只在唯一命中时才采纳），所以 Go 这一半宁可空着：
   * 一条错的边比缺一条边糟。
   *
   * 空着意味着：Go 文件的定位只能靠「目录/文件名 + outline」，走不了一跳图。这是
   * 已知且被接受的上限，`docs/superpowers/plans/2026-11-08-go-parser.md` 写了代价。
   */
  const specs = lang === 'go' ? [] : importSpecs(text);
  return {
    lang,
    symbols: exportsOf(text, `index.${lang}`),
    refs: { specs, locals, routes },
    outline: outlineOf(`index.${lang}`, fullText),
    // 进索引的 json 只有 `pages.json`（见 `isIndexable`），所以这里用它的名字问一次。
    pages: lang === 'json' ? pagesFromConfig('pages.json', fullText) : [],
  };
}

/** 装配要用的一块：路径 + 大小 + 内容事实（`blob_index` 的那三列）。 */
export type AssembledSource = ParsedBlob & { path: string; size: number };

export type AssembleInput = {
  repo: string;
  sha: string;
  /** 全树路径（用来解析说明符与后缀匹配）。 */
  all: readonly string[];
  /** 进了索引的文件，**顺序 = 树序**（`ls-tree` 是路径字典序，路由的去重依赖它）。 */
  sources: readonly AssembledSource[];
  /**
   * 因为「生成代码」被跳过的文件数。装配层自己数不出来（它只看得见 `sources`），
   * 所以由读内容的那一层传进来（见 `index-store.ts` 的 `assembleFor` / `buildIndex`）。
   */
  skippedGenerated?: number;
  builtAt?: string;
};

/**
 * 把「一组内容事实」拼成索引（`CodeIndex`）。纯函数，不碰 git、不碰库。
 *
 * 这是 P4-11 里唯一一处「解析」与「装配」的分界：`parseBlob` 按内容缓存，
 * `assembleIndex` 每次读都跑（一次 3–8 ms，实测），因为它必须看着**这一棵树**。
 *
 * 顺序是硬的，与旧版逐字一致：先按路径建 `files` 与 `imports`（`imports` 要用全树
 * 路径解析），再解析路由（路由要用 `locals` 的本地名映射）。反过来，`component: Search`
 * 就落不到文件上。
 */
export function assembleIndex(input: AssembleInput): CodeIndex {
  const fileSet = new Set(input.all);
  const files: Record<string, IndexFile> = {};
  const imports: Record<string, string[]> = {};

  for (const source of input.sources) {
    // 生产路径（`index-store.ts`）在**读内容之前**就用 `isIndexable` 筛过一遍，所以这里
    // 只对纯函数调用方（`extractIndex`）起作用。仍然要判：`_test.go` 一旦被手工塞进来，
    // 它没有 outline、却会因为文件名进 `files`，于是 `locate` 拿「folder_test」命中
    // 「文件夹」这个词，材料照着说「已有这个能力」——那是把测试当产品。
    if (!isIndexable(source.path)) continue;
    const kind = classifyKind(source.path);
    if (kind === 'other') continue;
    files[source.path] = { kind, exports: source.symbols, size: source.size };
    const resolved: string[] = [];
    for (const spec of source.refs.specs) {
      const target = resolveSpecifier(spec, source.path, fileSet);
      if (target !== null && target !== source.path && !resolved.includes(target)) {
        resolved.push(target);
      }
    }
    imports[source.path] = resolved;
  }

  const routes: IndexRoute[] = [];
  const seen = new Set<string>();
  const push = (entry: ParsedRoute): void => {
    const route = entry.route.trim();
    if (route === '') return;
    const key = `${route.toLowerCase()}\u0000${entry.file}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push({ route, file: entry.file, title: entry.title });
  };

  for (const source of input.sources) {
    const name = source.path.split('/').pop() ?? '';
    if (ROUTE_FILE.test(name)) {
      for (const decl of source.refs.routes) {
        if (decl.kind !== 'pages') continue;
        push({
          route: decl.route,
          file: resolveSpecifier(decl.spec, 'pages.json', fileSet) ?? '',
          title: decl.title,
        });
      }
      continue;
    }
    if (classifyKind(source.path) !== 'route') continue;
    for (const decl of source.refs.routes) {
      if (decl.kind !== 'router') continue;
      let file = '';
      // 字面量（`component: './x'`）与标识符（`component: Search`）的解析基准不同，
      // 与旧版一字不差地保留：字面量按仓根，标识符按**声明所在文件**的目录。
      if (decl.spec !== '') {
        file = resolveSpecifier(decl.spec, '', fileSet) ?? '';
      } else if (decl.ident !== '') {
        const spec = source.refs.locals[decl.ident];
        if (spec !== undefined) file = resolveSpecifier(spec, source.path, fileSet) ?? '';
      }
      push({ route: decl.route, file, title: decl.title });
    }
  }

  // 目录约定的兜底：只给「还没有任何路由指向它」的页面加一条。
  const covered = new Set(routes.filter((r) => r.file !== '').map((r) => r.file));
  for (const path of Object.keys(files)) {
    if (files[path]?.kind !== 'page') continue;
    if (covered.has(path)) continue;
    const route = conventionRoute(path);
    if (route === null) continue;
    push({ route, file: path, title: '' });
    covered.add(path);
  }

  // 页面清单：先收 `pages.json` **自己说的**，再给目录约定补的那些。
  //
  // 两条压制，都是为了不让同一页在清单里出现两次（评估材料看到两条会以为有两个入口）：
  // 1. 同一条 route 字符串时 `pages.json` 胜出（`pages.json` 连标题都有）；
  // 2. 已被 `pages.json` 说过的**那个文件**，不再按目录约定造一条——`pages/share/index`
  //    与约定推出的 `/share` 是同一屏的两种拼法，而应用里真实存在的只有前者。
  const pages: IndexPage[] = [];
  const pageRoutes = new Set<string>();
  const pageFiles = new Set<string>();
  for (const source of input.sources) {
    for (const page of source.pages) {
      const key = page.route.toLowerCase();
      if (pageRoutes.has(key)) continue;
      pageRoutes.add(key);
      pages.push(page);
      const file = resolveSpecifier(page.route.replace(/^\/+/, ''), 'pages.json', fileSet);
      if (file !== null) pageFiles.add(file);
    }
  }
  for (const path of Object.keys(files)) {
    if (files[path]?.kind !== 'page') continue;
    if (pageFiles.has(path)) continue;
    const route = conventionRoute(path);
    if (route === null) continue;
    const key = route.toLowerCase();
    if (pageRoutes.has(key)) continue;
    pageRoutes.add(key);
    pages.push({ route, title: null, source: 'convention' });
  }

  // 组件轮廓 / 导出符号：按路径挂上（一个都没有的文件不占键）。
  const outline: Record<string, OutlineNode[]> = {};
  for (const source of input.sources) {
    if (source.outline.length === 0) continue;
    outline[source.path] = source.outline;
  }

  return {
    repo: input.repo,
    sha: input.sha,
    files,
    imports,
    // 反向图在这里一次算完：它只由上面的 `imports` 决定，而 `imports` 是用**这一棵树**
    // 解析出来的。存进库里就等于存一个会过期的副本（见 `reverse-imports.ts`）。
    importedBy: reverseImports(imports),
    routes,
    pages,
    outline,
    // 不传就是 0（纯函数调用方 / 老用例）：这个数的语义是「我们主动跳过了几个」，
    // 「没说」与「一个都没跳过」在这一层没必要分开。
    skippedGenerated: input.skippedGenerated ?? 0,
    builtAt: input.builtAt ?? indexTimestamp(),
  };
}

/**
 * 从一批「文件头部」拼成索引：`parseBlob` 每一个源文件，再 `assembleIndex`。
 *
 * 这条路仍然有用处——`--dry-run`（不写库地量一次全量建索引的耗时）与纯函数用例
 * 都走它。生产路径是 `index-store.ts` 的 `repoIndex()`：那里按内容地址复用已解析的
 * blob，只解析缺的那几块。
 */
export function extractIndex(input: ExtractInput): CodeIndex {
  const sources: AssembledSource[] = [];
  for (const source of input.sources) {
    sources.push({ path: source.path, size: source.size, ...parseBlob(source.text, source.path) });
  }
  return assembleIndex({
    repo: input.repo,
    sha: input.sha,
    all: input.all,
    sources,
    builtAt: input.builtAt,
  });
}

// ─── 索引摘要（CLI 与报告共用一份） ─────────────────────────────────────────

export type IndexSummary = {
  /** 进了索引的文件数（不含噪音、不含 other 类别）。 */
  files: number;
  byKind: KindCounts;
  /** 解析出的路由条数（含解不出文件的）。 */
  routes: number;
  /** 解不出文件的路由条数：这条数字大说明路由表写法超出了我们的正则。 */
  routesWithoutFile: number;
  /** 已解析的导入关系条数。 */
  imports: number;
  /** 前 20 条路由（CLI 打印用）。 */
  topRoutes: IndexRoute[];
  /** 索引序列化后的字节数（jsonb 落库的大小量级）。 */
  bytes: number;
};

export function summarize(index: CodeIndex): IndexSummary {
  const byKind: KindCounts = { ...EMPTY_KIND_COUNTS };
  for (const file of Object.values(index.files)) byKind[file.kind] += 1;
  let imports = 0;
  for (const list of Object.values(index.imports)) imports += list.length;
  return {
    files: Object.keys(index.files).length,
    byKind,
    routes: index.routes.length,
    routesWithoutFile: index.routes.filter((r) => r.file === '').length,
    imports,
    topRoutes: index.routes.slice(0, 20),
    bytes: Buffer.byteLength(JSON.stringify(index), 'utf8'),
  };
}

// ─── 定位：在索引上打分 ──────────────────────────────────────────────────────

/**
 * 一个候选：**为什么选它**要能一句话说出来。
 *
 * `why` 不是给人看的装饰：它要进提示词（让模型知道自己在看什么），也要进材料的
 * 证据栏（让评审会上有人问「为什么改这里」时有答）。所以它必须说清**哪条信号**
 * 命中了什么，而不是一句「相关」。
 */
export type Probe = {
  path: string;
  kind: FileKind;
  score: number;
  why: string;
  route?: string;
};

/**
 * 打分权重，一条一条都有理由：
 * - **路由路径 10**：最强信号。`/search` 命中「搜索」= 这个页面就是干这个的。
 * - **文件/目录名 6**：次强。命名即意图（`search-entrance/`）。
 * - **被命中的路由直接 import 4**：走一跳图——搜索页用了哪个组件。
 *   `search-entrance.vue` 不一定被搜索页直接 import（它是首页的入口），所以它
 *   靠名字（6）排在「被引用」（4）前面；而真正的实现文件靠路由（10）排第一。
 * - **导出符号 3**：最弱。`searchFiles()` 出现在 service 里，但那只是「提供了能力」，
 *   不是「这一屏」。
 */
export const SCORE = { route: 10, name: 6, imported: 4, symbol: 3 } as const;

/** 类别在**同分**时的先后：页面 > 组件 > 服务 > 状态 > 路由表 > 其它。 */
const KIND_RANK: Record<FileKind, number> = {
  page: 0, component: 1, service: 2, state: 3, route: 4, other: 5,
};

export type LocateOptions = {
  /** 最多回几个（默认 12，与 `CANDIDATE_CAP` 同一个量级）。 */
  limit?: number;
  /** 关键词→片段表（测试可注入；默认用 `terms.ts` 的那一张）。 */
  expand?: (keywords: readonly string[]) => Term[];
  /**
   * 通用词（`GENERIC_WORDS`）能不能在「非通用词一个都没命中」时补位。默认 `true`。
   *
   * **多仓定位时必须是 `false`**：一个仓没线索 ≠ 这份 PRD 没线索。PAN-6 的「搜索」
   * 在 `123pan-pc` 里一个文件都不命中，若那一个仓自己降级到「文件」，它会吐出一堆
   * 噪音（`videoFileUtils.ts`、`file/type.ts`），而那些噪音在**跨仓拼接**时会排在
   * `search.vue` 前面——实测 rank 7。所以「要不要用通用词」这件事只能由**整个需求**
   * 的结论决定，见 `locateAcross()`。
   */
  allowGeneric?: boolean;
};

type Evidence = {
  routes: Array<{ route: string; term: string }>;
  names: Array<{ segment: string; term: string }>;
  symbols: Array<{ name: string; term: string }>;
  importedBy: string[];
};

function emptyEvidence(): Evidence {
  return { routes: [], names: [], symbols: [], importedBy: [] };
}

/** 一个路径的「名字」片段：目录名 + 文件名（去扩展名），全部小写。 */
function nameSegments(path: string): string[] {
  const clean = path.replace(/^\.?\//, '');
  const segments = clean.split('/');
  const last = stripExt(segments[segments.length - 1] ?? '');
  const dirs = segments.slice(0, -1);
  return [...dirs, last].filter((segment) => segment !== '').map((segment) => segment.toLowerCase());
}

/**
 * 定位：在一个索引上按 PRD 关键词打分，**不发一次 ssh**。
 *
 * 七条规矩：
 * 1. 中文词先过 `PATH_TERMS`（`terms.ts`）翻成英文片段，再匹配——中文词与英文路径
 *    直接比是永远不中的。
 * 2. **通用词最后才用**：先只用非通用词（`GENERIC_WORDS` 之外的）打分；一个都没命中，
 *    才把通用词放回来。实测就是这条决定了成败——PAN-6 的八个词里有七个是
 *    「文件/目录/当前/返回」这类通用词，全用上时排第一的是 `directory.vue`
 *    （它叫「目录」，也是 `/directory` 的页面），而 PRD 真正讲的是搜索。
 * 3. 同一个文件同一类信号只算一次（路由命中 3 条也只加 10），否则一个路由表里
 *    写了两遍的路径会把分数堆到天上。
 * 4. 分高的在前；同分按类别（页面优先）、再按路径字典序——**稳定**，同一个 PRD +
 *    同一个 sha 永远同一份顺序。
 * 5. `why` 用分最高的一条信号写（多句用「；」连），必须能读成一句中文。
 * 6. `route` 只在路由命中时填：它是「这一页的路由」，给提示词与证据栏用。
 * 7. 索引为空就直接回空数组——调用方据此退回 grep（见 `index-store.ts`）。
 */
export function locate(
  index: CodeIndex,
  keywords: readonly string[],
  opts: LocateOptions = {},
): Probe[] {
  const limit = Number.isFinite(opts.limit) && (opts.limit ?? 0) > 0 ? Math.floor(opts.limit as number) : 12;
  const terms = (opts.expand ?? expandTerms)(keywords);
  if (terms.length === 0) return [];
  if (Object.keys(index.files).length === 0) return [];

  const allowGeneric = opts.allowGeneric ?? true;
  const specific = terms.filter((term) => !isGenericWord(term.cn));
  const first = specific.length === 0 ? [] : scoreTerms(index, specific);
  if (first.length > 0) return first.slice(0, limit);
  // 非通用词一个都没命中。**这个仓**要不要拿通用词补位，由调用方决定：
  // 单仓调用默认补（`allowGeneric` 默认 true），多仓定位时一律不补（见 `locateAcross`）。
  if (!allowGeneric) return [];
  return scoreTerms(index, terms).slice(0, limit);
}

/** 用给定的词表给整个索引打分（`locate` 的第一趟与兜底那一趟都是它）。 */
function scoreTerms(index: CodeIndex, terms: readonly Term[]): Probe[] {
  const paths = Object.keys(index.files);

  const evidence = new Map<string, Evidence>();
  const at = (path: string): Evidence => {
    const found = evidence.get(path);
    if (found !== undefined) return found;
    const fresh = emptyEvidence();
    evidence.set(path, fresh);
    return fresh;
  };

  // 1) 路由命中：先算，因为它给下面的「被引用」当锚点。
  const routeHit = new Set<string>();
  for (const entry of index.routes) {
    const file = entry.file;
    if (file === '' || index.files[file] === undefined) continue;
    const route = entry.route.toLowerCase();
    for (const term of terms) {
      const token = term.tokens.find((candidate) => route.includes(candidate));
      if (token === undefined) continue;
      at(file).routes.push({ route: entry.route, term: term.cn });
      routeHit.add(file);
      break;
    }
  }

  // 2) 名字命中：目录名与文件名。
  for (const path of paths) {
    const segments = nameSegments(path);
    for (const term of terms) {
      for (const segment of segments) {
        const token = term.tokens.find((candidate) => segment.includes(candidate));
        if (token === undefined) continue;
        at(path).names.push({ segment, term: term.cn });
        break;
      }
    }
  }

  // 3) 被命中的路由直接 import：走一跳图。
  for (const importer of routeHit) {
    for (const target of index.imports[importer] ?? []) {
      if (index.files[target] === undefined) continue;
      const list = at(target).importedBy;
      if (!list.includes(importer)) list.push(importer);
    }
  }

  // 4) 导出符号命中。
  for (const path of paths) {
    const file = index.files[path];
    if (file === undefined) continue;
    for (const term of terms) {
      const symbol = file.exports.find((name) => {
        const low = name.toLowerCase();
        return term.tokens.some((token) => low.includes(token));
      });
      if (symbol !== undefined) at(path).symbols.push({ name: symbol, term: term.cn });
    }
  }

  const probes: Probe[] = [];
  for (const path of paths) {
    const found = evidence.get(path);
    if (found === undefined) continue;
    const file = index.files[path];
    if (file === undefined) continue;

    let score = 0;
    const why: string[] = [];
    let route: string | undefined;

    if (found.routes.length > 0) {
      score += SCORE.route;
      const top = found.routes[0]!;
      route = top.route;
      why.push(`路由 ${top.route} 的页面（命中「${top.term}」）`);
    }
    if (found.names.length > 0) {
      score += SCORE.name;
      const top = found.names[0]!;
      why.push(`目录/文件名 ${top.segment} 命中「${top.term}」`);
    }
    if (found.importedBy.length > 0) {
      score += SCORE.imported;
      why.push(`被 ${found.importedBy[0]} 直接引用`);
    }
    if (found.symbols.length > 0) {
      score += SCORE.symbol;
      why.push(`导出 ${found.symbols.map((item) => item.name).slice(0, 3).join('/')}`);
    }
    if (score === 0) continue;

    const probe: Probe = { path, kind: file.kind, score, why: why.join('；') };
    if (route !== undefined) probe.route = route;
    probes.push(probe);
  }

  probes.sort((a, b) => b.score - a.score
    || KIND_RANK[a.kind] - KIND_RANK[b.kind]
    || a.path.localeCompare(b.path));
  return probes;
}

/** 索引「什么也没抽到」：只有这种索引才会让调用方退回 grep。 */
export function isEmptyIndex(index: CodeIndex): boolean {
  return Object.keys(index.files).length === 0;
}

/**
 * 定位，或者**明说**退回 grep。
 *
 * 为什么要把这个选择做成一个有返回值的函数，而不是两处 `if`：走查的候选集与评审的
 * 现状基线是两块代码，各自判断「有没有索引」时口径一定会漂（一处按 `files` 为空，
 * 一处按「异常」，还有一处忘了判空索引）。这里只有一个判据：
 *
 * - 没有索引（镜像读不到、建索引失败）→ `grep`；
 * - 索引是空的（后端仓：一个 JS/TS 页面都没有）→ `grep`；
 * - 其余一律走索引——**包括「索引在、但一个候选都没有」**。那种情况是「这个功能不在
 *   这个仓」，是个真答案，不该拿 grep 的噪音去盖住它（旧路径正是这样把
 *   `app/downLoad/index.ts` 顶上来的）。
 */
export type LocateChoice =
  | { source: 'index'; probes: Probe[] }
  | { source: 'grep'; reason: string };

export function locateOrFallback(
  index: CodeIndex | null,
  keywords: readonly string[],
  opts: LocateOptions = {},
): LocateChoice {
  if (index === null) {
    return { source: 'grep', reason: '没有可用的静态索引（镜像读不到或索引建失败），退回 grep' };
  }
  if (isEmptyIndex(index)) {
    return { source: 'grep', reason: '索引是空的（这个仓里没有 JS/TS 的页面/组件/服务文件），退回 grep' };
  }
  return { source: 'index', probes: locate(index, keywords, opts) };
}

/**
 * **所有仓库一起**定位：一条需求的候选清单，而不是每个仓各自的一份。
 *
 * 为什么不能每仓各判各的（P4-10 第 1–2 步的真实 bug）：`locate()` 的通用词补位是
 * 「这个仓里非通用词一个都没命中就用通用词」。PAN-6 的关键词是
 * 搜索/文件/目录/上一级/结果/返回/当前/范围，「搜索」在 `123pan-pc` 里一个文件都不命中，
 * 于是 pc 那一仓自己降级到「文件」，吐出 8 个噪音文件（`videoFileUtils.ts`、
 * `file/type.ts`……）；调用方把两个仓的候选**拼在一起**，`.vue` 的 16 分排在 pc 那些
 * 9/6/3 分后面——实测 rank 7。分数是对的，错的是「谁来决定要不要用通用词」。
 *
 * 「这份 PRD 有没有具体线索」是**需求**的属性，不是每个仓的属性。所以：
 * 1. **第一趟**：每个有索引的仓都按 `allowGeneric: false` 打分；
 * 2. 只要**有任何一个仓**给出了候选，这一趟就是最终答案——没命中的仓贡献**零**个候选
 *    （与旧 grep 路径的 `emptyRepos` 同一个口径：没有路径命中就是「这个功能不在这个仓」）；
 * 3. 只有**整个需求**一个候选都没有（很薄的 PRD，比如「文件列表优化」），才允许通用词补位，
 *    那时才回到「每个仓给自己最弱的候选」。
 *
 * 没有索引（`null`）或索引为空的仓不进第一趟，直接给 `source: 'grep'`——降级仍然是
 * **每仓独立**的：pc 是索引可用、只是没线索；后端仓是索引根本不存在。这两件事不同。
 */
export type RepoIndexEntry = { repo: string; index: CodeIndex | null };

export function locateAcross(
  entries: readonly RepoIndexEntry[],
  keywords: readonly string[],
  opts: LocateOptions = {},
): Map<string, LocateChoice> {
  const out = new Map<string, LocateChoice>();
  const usable = entries.filter((entry): entry is { repo: string; index: CodeIndex } =>
    entry.index !== null && !isEmptyIndex(entry.index));

  const first = new Map<string, Probe[]>();
  for (const entry of usable) {
    first.set(entry.repo, locate(entry.index, keywords, { ...opts, allowGeneric: false }));
  }
  const anyHit = [...first.values()].some((probes) => probes.length > 0);

  for (const entry of entries) {
    if (entry.index === null) {
      out.set(entry.repo, {
        source: 'grep',
        reason: '没有可用的静态索引（镜像读不到或索引建失败），退回 grep',
      });
      continue;
    }
    if (isEmptyIndex(entry.index)) {
      out.set(entry.repo, {
        source: 'grep',
        reason: '索引是空的（这个仓里没有 JS/TS 的页面/组件/服务文件），退回 grep',
      });
      continue;
    }
    if (anyHit) {
      // 整个需求有具体线索：这一仓没有命中就是零候选，不拿通用词顶数。
      out.set(entry.repo, { source: 'index', probes: first.get(entry.repo) ?? [] });
      continue;
    }
    // 全需求都没线索：这时通用词是唯一的线索，允许每仓给自己最弱的候选。
    out.set(entry.repo, {
      source: 'index',
      probes: locate(entry.index, keywords, { ...opts, allowGeneric: true }),
    });
  }
  return out;
}
