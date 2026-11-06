import { lsTree, ok, type MirrorResult } from './mirror.js';

/**
 * 走查阶段一的「形状」：一个 repo 在 HEAD 上有哪些页面、哪些接口客户端、哪些组件。
 *
 * 为什么不把 817 个文件直接丢给模型：`123pan-pc` 的树里既有 `src/router/router.js`
 * （真路由表），也有 `web-file/frontend/dist/web.asar`（2.4M 的打包产物）。模型看到
 * 后者会把它当成源码去引，走查结论就会指向一个压缩过的黑箱。所以这一层只回答
 * 「结构」：页面在哪、接口在哪、组件有多少，且**每张表都有上限**——超过上限时
 * 如实说「这是前 N 个」，让上层决定要不要再按前缀细分，而不是假装列表是全的。
 *
 * 分类是**路径模式**，不是 AST：三个仓分别是 React（`src/router` + `pages/`）、
 * uni-app（`pages/` + `pages.json`）与通用布局（`views/`、`app/**\/page.tsx`）。
 * 模式宽一点没关系（多列几个文件不致命），漏掉一条路由才致命——所以
 * `pages/**` 与 `src/router/**` 都是硬命中。
 */

export const SHAPE_CAPS = { pages: 120, api: 80, components: 200 } as const;

export type ShapeTag = 'page' | 'api' | 'component';

export type RepoShape = {
  /** 路由/页面文件。 */
  pages: string[];
  /** 接口客户端：`api/`、`services/`、`request.ts` 一类。 */
  api: string[];
  /** 组件，按上限截断。 */
  components: string[];
  /** 去掉噪音后的文件总数（不是仓库原始条目数）。 */
  totalFiles: number;
  /** 三张表各自的上限，原样回给调用方。 */
  caps: { pages: number; api: number; components: number };
  /** 哪张表被截断了——`true` 表示「这是前 N 个」，不是「一共就这些」。 */
  truncated: { pages: boolean; api: boolean; components: boolean };
};

/** React：`src/router/...`；也收 `router.js` 直接躺在 src 下的布局。 */
const PAGE_PATTERNS: readonly RegExp[] = [
  /(^|\/)src\/router\//,
  /(^|\/)routers?\//,
  /(^|\/)pages\//,
  /(^|\/)views\//,
  /(^|\/)screens\//,
  // Next.js App Router：app/**/page.tsx
  /(^|\/)app\/(?:.+\/)?page\.(?:tsx|jsx|ts|js)$/,
  // uni-app 的路由表本身就是「页面清单」
  /(^|\/)pages\.json$/,
];

/** 接口客户端。`api/user.ts`、`services/user.ts`、`utils/request.js`、`user.api.ts`。 */
const API_PATTERNS: readonly RegExp[] = [
  /(^|\/)api\//,
  /(^|\/)apis\//,
  /(^|\/)services?\//,
  /(^|\/)https?\//,
  /(^|\/)(?:request|http|axios|fetch)\.(?:ts|js|tsx|jsx)$/,
  /\.(?:api|service)\.(?:ts|js|tsx|jsx)$/,
];

/** 组件目录。扩展名那条在最后兜底（见 `classifyPath` 的顺序）。 */
const COMPONENT_PATTERNS: readonly RegExp[] = [
  /(^|\/)components?\//,
  /(^|\/)widgets?\//,
  /\.(?:component|view)\.(?:tsx|jsx|ts|js|vue)$/,
];

const COMPONENT_EXT = /\.(?:tsx|jsx|vue)$/;

/**
 * 只有「代码」才配进这三张表。样式表（`.less` / `.css` / `.scss`）在 `pages/**`
 * 下面和页面同目录，路径模式会把它们一起捞上来——123pan-pc 的第一次真实跑给出
 * 的 25 个「页面」里，一大半是 `index.less`。模型要的是「这一页在哪」，不是
 * 「这一页的样式文件叫什么」。
 */
const CODE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|vue|json)$/;

/**
 * 一个路径属于哪一类。**页面优先**：`pages/Home/api.ts` 是一个页面旁边的接口，
 * 放在 pages 表里更有用（它描述的是「这一页」）；同理 `api/user.ts` 不会因为
 * 扩展名是 `.ts` 掉进 components。
 */
export function classifyPath(path: string): ShapeTag | null {
  if (!CODE_EXT.test(path)) return null;
  if (PAGE_PATTERNS.some((re) => re.test(path))) return 'page';
  if (API_PATTERNS.some((re) => re.test(path))) return 'api';
  if (COMPONENT_PATTERNS.some((re) => re.test(path))) return 'component';
  if (COMPONENT_EXT.test(path)) return 'component';
  return null;
}

/**
 * 一个仓库的形状。失败（配置缺一块、ssh 连不上、仓库路径写错）原样返回中文失败——
 * 阶段一不该为了「读不到」写 try/catch。
 */
export async function repoShape(repoId: string): Promise<MirrorResult<RepoShape>> {
  const tree = await lsTree(repoId);
  if (!tree.ok) return tree;

  const pages: string[] = [];
  const api: string[] = [];
  const components: string[] = [];
  for (const path of tree.data) {
    const tag = classifyPath(path);
    if (tag === 'page') pages.push(path);
    else if (tag === 'api') api.push(path);
    else if (tag === 'component') components.push(path);
  }

  const pageList = pages.slice(0, SHAPE_CAPS.pages);
  const apiList = api.slice(0, SHAPE_CAPS.api);
  const componentList = components.slice(0, SHAPE_CAPS.components);

  return ok({
    pages: pageList,
    api: apiList,
    components: componentList,
    totalFiles: tree.data.length,
    caps: { ...SHAPE_CAPS },
    truncated: {
      pages: pages.length > pageList.length,
      api: api.length > apiList.length,
      components: components.length > componentList.length,
    },
  });
}

/** 给上层的一句人话（走查的第一屏）：列表被截断时必须说出来。 */
export function shapeSummary(shape: RepoShape): string {
  const parts = [
    `${shape.totalFiles} 个源码文件`,
    `${shape.pages.length}${shape.truncated.pages ? '+' : ''} 个页面`,
    `${shape.api.length}${shape.truncated.api ? '+' : ''} 个接口文件`,
    `${shape.components.length}${shape.truncated.components ? '+' : ''} 个组件`,
  ];
  const cut = shape.truncated.pages || shape.truncated.api || shape.truncated.components;
  return `${parts.join('、')}${cut ? '（带 + 的表已按上限截断）' : ''}`;
}

/** 空形状（仓库里一个源码文件都没有时用）。 */
export function emptyShape(): RepoShape {
  return {
    pages: [],
    api: [],
    components: [],
    totalFiles: 0,
    caps: { ...SHAPE_CAPS },
    truncated: { pages: false, api: false, components: false },
  };
}
