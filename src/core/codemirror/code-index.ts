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
 * 一页里用到的一个组件（Task 2 的 outline 第一层）。
 *
 * 只排到「template 里的标签」这一层是刻意的：评估要回答的是「这页里已经有搜索框了吗」，
 * 而那个答案就是标签名本身。`kind` 现在只产出 `component-use`；留 `tag` 是为了将来
 * 把「原生标签」也记下来时不改形状（`div` / `li` 这类现在**不进** outline）。
 */
export type OutlineNode = {
  kind: 'component-use' | 'tag';
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
  routes: IndexRoute[];
  /** 页面清单：`pages.json` 自己说的 ＋ 目录约定补的（同一条 route 时前者胜出）。 */
  pages: IndexPage[];
  /** path → 这一页 template 里用到的组件（只做 `.vue`；没有组件的那一页不占一个键）。 */
  outline: Record<string, OutlineNode[]>;
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

/** 只认这几种扩展名：索引不是「全仓文本搜索」。 */
export const CODE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|vue)$/i;

/**
 * 一个路径属于哪一类。**顺序即优先级**：
 * - `pages.json` 与 `router/` 先判：它们是路由表，比「页面」更该被当成结构；
 * - `pages/` 再判：`pages/Search/api.ts` 描述的是「这一页」，不是「一个接口」；
 * - 然后是组件、服务、状态。
 *
 * 认不出的落 `other`（等于「不进索引」）：一个仓里大量是配置、类型、工具函数，
 * 它们不会成为「这个功能在哪」的答案，进来只会稀释候选。
 */
export function classifyKind(path: string): FileKind {
  const clean = path.replace(/^\.?\//, '');
  if (ROUTE_FILE.test(clean) || ROUTER_DIR.test(clean)) return 'route';
  if (PAGE_DIR.test(clean)) return 'page';
  if (COMPONENT_DIR.test(clean)) return 'component';
  if (SERVICE_DIR.test(clean)) return 'service';
  if (STATE_DIR.test(clean)) return 'state';
  return 'other';
}

/** 这个路径要不要进索引：类别认得出，扩展名是源码（或它是 `pages.json`）。 */
export function isIndexable(path: string): boolean {
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
const COMPONENT_NAME = /\bdefineComponent\s*\(|name\s*:\s*['"]([\w$-]+)['"]/;

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
  if (text.includes('defineComponent')) {
    COMPONENT_NAME.lastIndex = 0;
    for (let m = COMPONENT_NAME.exec(text); m !== null; m = COMPONENT_NAME.exec(text)) {
      if (m[1] !== undefined) push(m[1]);
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

/**
 * 一页 template 里用到的组件（Task 2 的第一层）。
 *
 * 为什么只做 template、只做 vue：评估要回答的是「这页里已经有什么组件」，template 里的
 * 标签名就是答案，不需要进 script 解析 AST。而修 script 里的函数与 props 是 Phase 3 的
 * 事——那时才需要 tree-sitter。
 *
 * 为什么闭合取**最后一个** `</template>`：template 里还有 `<template v-if>` / `<template
 * #slot>` 这种嵌套写法，用第一个闭合会被内层截断，后面的组件全部消失（这正是
 * 「这页缺一个 X」类错误结论的来源）。行号给全文行号（`grep -n` 对得上），不是块内偏移。
 */
export function outlineOf(path: string, text: string): OutlineNode[] {
  if (!/\.vue$/i.test(path)) return [];
  const open = TEMPLATE_OPEN.exec(text);
  if (open === null) return [];
  const bodyStart = open.index + open[0].length;
  const close = text.lastIndexOf('</template>');
  if (close < bodyStart) return [];
  const body = text.slice(bodyStart, close);
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
 */
export function parseBlob(text: string, path: string): ParsedBlob {
  const lang = langOf(path);
  const routes = routeDecls(text);
  const locals: Record<string, string> = {};
  // 本地名映射只对路由表有意义（其它文件的 `import X from 'y'` 不进索引的图），
  // 而 `localNames` 要逐行扫——不给每块 blob 都付这笔钱。
  if (routes.length > 0) {
    for (const [name, spec] of localNames(text)) locals[name] = spec;
  }
  return {
    lang,
    symbols: exportsOf(text, `index.${lang}`),
    refs: { specs: importSpecs(text), locals, routes },
    outline: outlineOf(`index.${lang}`, text),
    // 进索引的 json 只有 `pages.json`（见 `isIndexable`），所以这里用它的名字问一次。
    pages: lang === 'json' ? pagesFromConfig('pages.json', text) : [],
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

  // 组件轮廓：按路径挂上每一页 template 里的组件（没有组件的那一页不占一个键）。
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
    routes,
    pages,
    outline,
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
