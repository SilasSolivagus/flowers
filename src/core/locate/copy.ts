import type { CodeIndex } from '../codemirror/code-index.js';
import type { Candidate } from './types.js';

/**
 * 材料里唯一允许出现的几句话（**四种**结论 + 一句「接下来怎么办」）。
 *
 * 「四种」是 2026-11-07 终审定下的：`absent` 原来只有一句，于是「代码没读到」与
 * 「代码读到了、合并历史没读到」共用同一句话，PM 分不出该催运维还是该催库。
 * 现在它们各有一句（`ABSENT_HEADLINE` / `ABSENT_HISTORY_HEADLINE`），其余两种
 * （`NOT_FOUND_HEADLINE` / `LOW_CONFIDENCE_HEADLINE`）不变。
 *
 * 为什么单独一个文件、而且全仓只此一份：这些字符串会被渲染进 PM 读的生成材料，
 * 「怎么措辞」是产品决定，不是调用点的心情。散在各处的后果不是风格问题，是**语义
 * 漂移**——一处写「代码里没有」、另一处写「没找到」，PM 就没法区分「没看到代码」和
 * 「看到了但确实没有」。而这两者要的动作完全相反：前者去催研发把镜像接通，后者去
 * 更新 PRD。
 *
 * 改字之前先读这三条硬约束：
 * 1. 不许出现「代码里没有」这种说法——它把「没读到」也一并说成了「没有」；
 * 2. 候选一律标「待研发确认」：第一版检索只到 `low`，说成结论就是在赌；
 * 3. 收尾永远把人推向「与研发确认 + 更新 PRD」（`CONFIRM_WITH_DEV`），不是让他去
 *    填六问——六问是 PRD 里已有的结构性提问，与「定位没成功」无关。
 */

/**
 * 没读到**代码本身**时的第一句。
 *
 * 「这一轮不含任何现状判断」这半句不是客套：材料里还有很多别的段落（差异、追问），
 * 若只说「没读到」，读的人会默认其余部分仍然成立；把「不含现状判断」写死在第一句，
 * 才是真的把那一段一起作废。
 */
export const ABSENT_HEADLINE = '代码没读到，这一轮不含任何现状判断。';

/**
 * `absent` 的第二种来源：**代码读到了，合并历史（或库）没读到**。
 *
 * 为什么必须单开一句、而不是复用 `ABSENT_HEADLINE`：2026-11-07 终审发现，走查里
 * 「两仓的合并历史都读失败」这条路径抛的是 `ABSENT_HEADLINE`，而这条路径上 HEAD /
 * lsTree / repoShape **都已经读到了**。事实是「代码读到了、历史没读到」，
 * 却说成「代码没读到」——PM 因此被指向去催镜像（运维那条线），而真正坏的是历史库，
 * 而且那份本来能出的材料整份消失。两种缺口的动作方向完全不同，措辞必须分开。
 *
 * 后半句仍然写「这一轮不含现状判断」：这一轮的候选只能来自合并历史，历史没读到就没有
 * 任何一条定位结论；材料顶部还有机器写死的横幅（`banner.ts`）把这句话放在第一眼，
 * 提示词里也照旧有那条「不要给这些仓下判断」的禁令（`absentRule`）。
 */
export const ABSENT_HISTORY_HEADLINE = '代码读到了，但合并历史没读到，因此这一轮不含现状判断。';

/**
 * 读到了、但没有时的第一句。
 *
 * 刻意与 `ABSENT_HEADLINE` 不共用任何关键词：两句一旦开始互相接近，迟早并成一句，
 * 那正是本次改造要消灭的那种合并。用「没能」而不是「没有」，是因为它描述的是一次
 * 检索的落空，不是对代码下判断。
 */
export const NOT_FOUND_HEADLINE = '没能在代码里定位到这条需求的实现。';

/** 有候选时的引导句。括号里的「待研发确认」是这句话存在的理由，不要当成修饰删掉。 */
export const LOW_CONFIDENCE_HEADLINE = '最可能的位置（待研发确认）：';

/**
 * 结论之后的唯一出口。
 *
 * 为什么指向「更新 PRD」而不是「重跑定位」：定位给的是线索，真正的现状只有研发知道。
 * 「材料会标记为旧版并重新生成」是给 PM 的确定性——他改完不用记着回来手动刷新。
 */
export const CONFIRM_WITH_DEV =
  '请与研发确认现在实际是怎么做的，确认后更新 PRD 文档，材料会标记为旧版并重新生成。';

/**
 * 「没读到**代码**」的完整一段：结论 + 原因 + 出口。
 *
 * `why` 必须原样带出去（例如「镜像连不上」）：那是 PM 唯一能拿去催人的线索，被概括成
 * 「读取失败」就没人能行动了。
 */
export const ABSENT_LINE = (why: string): string =>
  `${ABSENT_HEADLINE}（原因：${why}）${CONFIRM_WITH_DEV}`;

/**
 * 「代码读到了、合并历史没读到」的完整一段：结论 + 原因 + 出口。
 *
 * 与 `ABSENT_LINE` **结构相同、第一句不同**——同一条链路上两种缺口的唯一区别是
 * 「缺的是哪一半」，而这一点必须一眼看出来（第一句就是它）。原因同样原样带出：
 * 「读 commit_history 失败：connection terminated」指向的是库，不是镜像。
 */
export const ABSENT_HISTORY_LINE = (why: string): string =>
  `${ABSENT_HISTORY_HEADLINE}（原因：${why}）${CONFIRM_WITH_DEV}`;

/**
 * 「有候选」的完整一段：引导句 + 编号清单 + 「这不是结论」+ 出口。
 *
 * 编号与顺序都照 `items` 来，不重排：排序是检索层的判断（`score`），文案层再排一次
 * 等于有了两套口径。末尾那句「以上是线索，不是结论」承担的是`low` 的语义——类型上
 * 是 `confidence: 'low'`，PM 看不到类型，只看到这句话。
 *
 * **空数组直接抛，不渲染。** 理由不是洁癖：「最可能的位置（待研发确认）：」后面跟着
 * 零条目，本身就是一句假话——它宣称我们找到了位置，而实际上一条都没有。这种材料不
 * 会报错、不会缺块，只有一个真人逐字读才会发现，等于把一次失败伪装成一次干净的输出。
 * 这正是本仓已经修过两遍的同一个形状（`mergeHistory` 把提交 0 条吞成成功、
 * `ensureHistory` 写坏一批只留下半段历史）：**失败必须响亮**。
 *
 * 空 `items` 是调用方的 bug 而不是一种渲染状态：它说明检索层把一个失败当成空结果返回
 * 了（`LocateResult` 的 `none` 就是为「读了但没有」准备的）。所以这里既不兜底成
 * 「没找到」（那就把 bug 埋进文案层，谁也追不到了），也不渲染成空清单——直接抛，
 * 让错误停在能追责的那一层。
 */
export function CANDIDATES_LINE(items: readonly Candidate[]): string {
  if (items.length === 0) {
    throw new Error('CANDIDATES_LINE 不接受空数组：没有候选必须走 { kind: "none" }');
  }
  const lines = items.map((c, i) => `${i + 1}. \`${c.path}\` ← ${c.reason}`);
  return `${LOW_CONFIDENCE_HEADLINE}\n${lines.join('\n')}\n以上是线索，不是结论。${CONFIRM_WITH_DEV}`;
}

// ─── 代码快照：这份材料是对着**哪一版代码**说的 ──────────────────────────────
//
// 2026-11-08 的裁决（评审意见：「代码没读到」是同一种纪律的另一半）：
// 材料不许把**旧代码**当成**现在的代码**。定位已经知道每个仓的 HEAD 是哪一天
// （`head()` 返回 `{sha, date, subject}`），但材料里一个字都没写——于是 PM 读到
// 「最可能的位置」，以为那是今天的代码，而镜像的 HEAD 可能已经落后十几天。
//
// 所以这三句与上面那几句放在同一个文件：**措辞只有一个来源**。规则有两条：
//
// 1. 用了几个仓就写几行「代码快照：<仓> @ <日期>」，一行都不许省——省掉哪个仓，
//    读者就会把那个仓的结论当成「没参考代码」；
// 2. 某个仓的 HEAD 离今天超过 `SNAPSHOT_STALE_DAYS` 天，紧跟它那一行再写一句
//    「代码快照较旧（N 天前）」。这就是「我看的是旧代码」的诚实版本：不藏、不解释、
//    也不因此扣下材料——那会退回「整份不出」的老毛病（见 `types.ts` 的 `absent`）。

/** 快照行的前缀。单独一个常量只为让「这一行以什么开头」也能被用例钉住。 */
export const SNAPSHOT_PREFIX = '代码快照：';

/** 快照过旧那一行的前缀。 */
export const SNAPSHOT_STALE_PREFIX = '代码快照较旧（';

/**
 * 多少天算「旧」：**14 天**。
 *
 * 这个数没有理论依据，只有一个用途：把「隔了一个迭代周期」的代码与「昨天的代码」
 * 分开。改它是产品决定，改完记得同步 `tests/locate-snapshot.test.ts` 的边界用例。
 */
export const SNAPSHOT_STALE_DAYS = 14;

/** 一个仓的 HEAD 时间：`id` 是配置里的仓名，`date` 是 `%cI`（可带时分秒）。 */
export type CodeSnapshot = { id: string; date: string };

/** `%cI` → `YYYY-MM-DD`。格式不对时不编一个日期：写「日期未知」比写一个假日期诚实。 */
function dayOf(date: string): string {
  const day = date.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '日期未知';
}

/**
 * 「今天」按**Asia/Shanghai**算，与提交时间的时区一致（`%cI` 里是 `+08:00`）。
 *
 * 不按 UTC 算：北京时间 0–8 点之间，UTC 还是昨天，于是「14 天」的门槛会在一个
 * 白天里来回跳一天——同一份材料上午说「旧」、下午说「不旧」，比不写更糟。
 */
export function todayInShanghai(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** 两个日期之间差几天（`today - date`）。日期不可解析时返回 `null`（不猜）。 */
export function ageInDays(date: string, today: string): number | null {
  const day = dayOf(date);
  if (day === '日期未知' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const at = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  const to = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
  if (Number.isNaN(at) || Number.isNaN(to)) return null;
  return Math.round((to - at) / 86_400_000);
}

/** 「代码快照：123pan-uni-app @ 2026-11-03」。 */
export const SNAPSHOT_LINE = (repo: string, date: string): string =>
  `${SNAPSHOT_PREFIX}${repo} @ ${dayOf(date)}`;

/** 「代码快照较旧（16 天前）」。 */
export const STALE_LINE = (days: number): string => `${SNAPSHOT_STALE_PREFIX}${days} 天前）`;

/**
 * 每个仓一行快照；旧的那个仓紧跟一行「较旧」。
 *
 * 顺序 = 传入顺序（= 材料里结论的顺序），所以「较旧」说的是它上面那一行——不写仓名
 * 是因为这一行本来就属于上一行，重复仓名只会把一句短话读成一串。
 */
export function snapshotLines(
  repos: readonly CodeSnapshot[],
  today: string = todayInShanghai(),
): string[] {
  const lines: string[] = [];
  for (const repo of repos) {
    lines.push(SNAPSHOT_LINE(repo.id, repo.date));
    const age = ageInDays(repo.date, today);
    if (age !== null && age > SNAPSHOT_STALE_DAYS) lines.push(STALE_LINE(age));
  }
  return lines;
}

/**
 * 定位结论 + 快照 → 材料顶部横幅的全文。
 *
 * 没有仓（代码根本没读到）时**一行都不加**：那时材料的结论是「代码没读到」，再写
 * 「代码快照：…」就是在说一件我们并不知道的事。
 */
export function withSnapshots(
  text: string,
  repos: readonly CodeSnapshot[],
  today: string = todayInShanghai(),
): string {
  const extra = snapshotLines(repos, today);
  return extra.length === 0 ? text : `${text}\n${extra.join('\n')}`;
}

// ─── 现有页面清单：评估提示词里「这一步落在哪一页」的唯一依据 ──────────────────
//
// 为什么这一段住在这里、而不是 `compose.ts`：它是**给 PM 读的一句话的来源**，
// 和上面那几句同一条纪律——一处措辞、一处口径。它进的是提示词（模型照抄），
// 最终落到材料里「现有页面：/pages/share/index」那行字上；换句话说，材料里
// 「这页已经存在」这句话的真伪，完全由这个函数取哪些字段决定。
//
// 四条口径（都是被真实数据逼出来的，改之前先看报告里的数字）：
// 1. **只认视图文件**（`.vue` / `.tsx` / `.jsx`）。第一版按「路径里含 route」找文件，
//    结果 pc 的 `/login` 把 `src/apis/login.ts` 也算了进去，于是提示词里
//    「登录页已有组件」列的是 `fetchAccountLogin`、`fetchRegister` 这些接口函数——
//    模型据此说「这页有 X」就是在说假话。页面文件是视图，`.ts` 是同名工具/接口。
// 2. **页面目录下的子组件算这一页**（C2 的裁决）。`src/pages/Login/login.tsx` 之外，
//    `src/pages/Login/**` 才是登录页的组成：实测 8 个组件全在
//    `src/pages/Login/components/{InputPassword,VcodeInput,blacklistModal,…}` 里。
//    只看页面自己的那个视图文件，材料就会写「/login：没读到组件」——把「已有」说成
//    「没有」，而它正好是「其实早就存在却被标成新增」这个指标最大的燃料。
// 3. **组件只取 `component-use` 与 `symbol`**（`tag` 是 `.vue` 里小写标签的占位，
//    给模型看只会变成噪音），并且**去重**：同一页里 `<MfyIcon>` 用两次是一个组件。
// 4. **组件名只可能来自 `index.files` 里有的文件**（`outline` 的键就是它们）。
//    `importedBy` 的键可以不在 `files` 里（`static/storeSdk.ts` 那种），所以这里
//    遍历的是 `files` 而不是 `outline`——把 `static/` 当组件写进提示词，是同一类假话。
//    引用数（`importers`）同理只在 `files` 里的文件上数。
//
// 没有索引（`pages` 为空）时返回空清单，调用方据此**整段不写**：说「现有页面上
// 什么都没有」比不说更坏，它把「没读到索引」伪装成「读过了、确实没有」。

/** 一个已知页面：路由、标题（可能没有）、这一页里读到的组件名、被几处引用。 */
export type KnownSurface = {
  route: string;
  title: string | null;
  components: string[];
  /**
   * 这一页**一共读到几个**组件（去重后、封顶前）。
   *
   * 为什么要带：`components` 只列前 12 个（`SURFACE_COMPONENT_CAP`），而清单里那句
   * 「清单里的组件是这页已经有的」读起来像「这就是全部」——被砍掉的那些正好会被材料
   * 说成「要新建」。pc 的 `/login` 实测 24 个（8 个弹窗组件叠在一页上），只列 12 个
   * 而不说还有 12 个，就是 C1 那条「静音安全」的同一种坏法，只是规模小一点。
   */
  componentTotal: number;
  /**
   * 有多少个文件 import 了这一页的视图文件（I4：`importedBy` 的第一个生产消费方）。
   * `null` = 这一页没有视图文件，这个数无从谈起（不是 0）。
   */
  importers: number | null;
};

/**
 * 一份清单，带**覆盖率**（C1 的裁决）。
 *
 * 为什么必须带：`surfaces` 非空时提示词原本写死「不要假设清单之外还有页面」，而清单
 * 可能只覆盖一部分仓、可能被 `SURFACE_LIMIT` 截断、可能某个仓的组件轮廓一行都没读到——
 * 三种情况下那句话都在把「失明」说成「看得全」，模型于是把被漏掉的页面全标成新增。
 * `complete === false` 时提示词换成「本清单不完整：…」，并禁止模型断言未列出的页面不存在。
 */
export type KnownSurfaces = {
  /** 要进提示词的那些页（已按上限截断）。 */
  surfaces: KnownSurface[];
  /** 截断**之前**的真页面数——提示词里的「共 N 个」必须是这个数。 */
  total: number;
  /** 是否「所有仓都读到 + 所有页面都在清单里 + 轮廓都读到了」。 */
  complete: boolean;
  /** `complete === false` 时的一句话原因（进提示词，中文）。 */
  note: string | null;
};

/** 空清单：调用方据此整段不写（与「读失败」同一个出口）。 */
export const EMPTY_SURFACES: KnownSurfaces = { surfaces: [], total: 0, complete: false, note: null };

/** 提示词里一页最多列几个组件。再多就不是「这页有什么」，而是一份文件清单。 */
const SURFACE_COMPONENT_CAP = 12;

/** 页面文件只可能是这三种扩展名（见上面第 1 条）。 */
const VIEW_FILE = /\.(vue|tsx|jsx)$/i;

/** 目录（不含末段）。`src/pages/Login/login.tsx` → `src/pages/Login`。 */
function dirOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

/**
 * 路由 → 这一页的**构成文件**：页面自己的视图文件 ＋ 页面目录下的其它视图文件。
 *
 * 第二、三条命（`<pageDir>/*.vue|tsx` 与 `<pageDir>/components/**`）是 C2：登录页的 8 个
 * 组件全在 `components/` 下，只看页面自己那个 `login.tsx` 就会写成「没读到组件」。
 * 边界刻意收在**页面目录之内**，不放宽到整棵树：`src/components/share/share.vue` 是全局
 * 组件，把它算成 `/share` 的组成就是另一种假话（那是 M5 记下的坑）。
 */
function pageFiles(files: Readonly<Record<string, unknown>>, route: string): string[] {
  const want = route.replace(/^\/+/, '').toLowerCase();
  if (want === '') return [];
  const paths = Object.keys(files);
  const direct: string[] = [];
  for (const path of paths) {
    if (!VIEW_FILE.test(path)) continue;
    const noExt = path.replace(VIEW_FILE, '').toLowerCase();
    // `pages/share/index` ↔ `src/pages/share/index.vue`；`login` ↔ `src/pages/Login/login.tsx`；
    // `VideoPage` ↔ `src/pages/VideoPage/index.tsx`（目录名即路由）。
    if (noExt === want || noExt.endsWith(`/${want}`) || noExt.endsWith(`/${want}/index`)) {
      direct.push(path);
    }
  }
  const out = [...direct];
  for (const page of direct) {
    const dir = dirOf(page);
    const componentsPrefix = dir === '' ? 'components/' : `${dir}/components/`;
    for (const path of paths) {
      if (path === page || !VIEW_FILE.test(path) || out.includes(path)) continue;
      const parent = dirOf(path);
      // 同目录的其它视图文件（`src/pages/Login/BindPhoneModal.tsx`），或这一页自己的
      // `components/` 子树（任何深度）。两条都只在页面目录之内成立。
      if (parent === dir || parent.startsWith(componentsPrefix)) out.push(path);
    }
  }
  return out;
}

/**
 * 这一仓的页面**是不是真的一个组件都没读到**（C1 第 1 条 / I5）。
 *
 * 为什么需要它：`blob_index.outline` 是 0032 新加的可空列，`writeBlobRows` 用的是
 * `on conflict do nothing`、而 `blob_sha` 是内容地址——**内容不变就永远不会重写**。
 * 于是任何在 0032 之前同步过、之后没跑过 `--force-reparse` 的仓，`outline` 永远是
 * `null`，读侧按 `[]` 归一。那种仓的每一页都会显示「没读到组件」，读者分不出
 * 「扫过、确实没有」和「压根没扫」——说「没读到组件」比不说更坏，所以整仓按「没读到」
 * 处理（`surfaces.ts` 会把这一仓从清单里去掉，并在提示词里写明清单不完整）。
 */
export function pagesOutlineMissing(
  index: Pick<CodeIndex, 'pages' | 'outline' | 'files'>,
): boolean {
  if (index.pages.length === 0) return false;
  return index.pages.every((page) =>
    pageFiles(index.files, page.route).every((file) => (index.outline[file] ?? []).length === 0));
}

/**
 * 索引 → 提示词能吃的页面清单（带覆盖率）。
 *
 * `limit` 是**页面条数**上限（默认 40）：两仓加起来 29 页，40 不会截到任何真数据，
 * 但换一个大仓时它保证提示词不会因为索引变长而线性变长。**截断不是静默的**：
 * `total` 是截断前的真数、`complete` 记 false——否则提示词会写「共 40 个」并禁止
 * 模型假设还有别的页，被砍掉的那 160 页全部变成「新增页面」。
 */
export function knownSurfaces(
  index: Pick<CodeIndex, 'pages' | 'outline' | 'files' | 'importedBy'>,
  limit = 40,
): KnownSurfaces {
  const total = index.pages.length;
  const surfaces = index.pages.slice(0, limit).map((page) => {
    const seen: string[] = [];
    const files = pageFiles(index.files, page.route);
    for (const file of files) {
      for (const node of index.outline[file] ?? []) {
        if (node.kind === 'tag') continue;
        if (!seen.includes(node.name)) seen.push(node.name);
      }
    }
    // `importedBy` 的键可能不在 `files` 里（`static/storeSdk.ts` 那种），所以按 `files`
    // 过滤一次：提示词只该数「被索引里的文件引用了几处」，而这也是这一层唯一的出口。
    const importers = files.length === 0
      ? null
      : new Set(files.flatMap((file) =>
        (index.importedBy[file] ?? []).filter((from) => index.files[from] !== undefined))).size;
    return {
      route: page.route,
      title: page.title,
      components: seen.slice(0, SURFACE_COMPONENT_CAP),
      componentTotal: seen.length,
      importers,
    };
  });
  return {
    surfaces,
    total,
    complete: total <= limit,
    note: total <= limit ? null : `页面数超过上限，只列了前 ${limit} 个（共 ${total} 个）`,
  };
}
