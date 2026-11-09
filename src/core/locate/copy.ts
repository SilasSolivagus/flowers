import type { CodeIndex } from '../codemirror/code-index.js';
import type { RecentFile } from './recency.js';
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

// ─── 同类先例：上次做类似的事动了几个文件 ──────────────────────────────────
//
// 评审读材料时总要问一句「上次做类似的事改了几个文件」。这一句现在没有数据支撑：
// `commit_history` 里躺着 657 次真实的合并（消息是中文需求标题、`files` 是改动文件
// 清单），而材料一个字都没用它。补上之后，材料能自己回答「规模大概是几个文件」，
// 而不是让评审拿一份完全无关的经验去估。
//
// 三条口径（改文案之前先读）：
//
// 1. **与「代码快照：…」同风格、同位置**：全角冒号、一行、放在横幅末尾那几句旁边。
//    它和快照是同一类东西——都是「这段话的依据是什么」，不是结论本身。
// 2. **没有命中就一个字都不写**（`similarLines` 返回空数组，`withSimilar` 原样返回）。
//    绝不写「上次类似改动的先例：无」：那句读起来是「我们查过了，确实没有先例」，
//    而真实情况往往是「我们手上没有可比的历史」。把「没数据」写成「查了没有」，
//    正是本仓修过两遍的同一种病（见 `CANDIDATES_LINE` 的空数组注释）。
// 3. **不写合计数**：一次一格（`date「标题」N 个文件`）。求和会造出一个没有单位的
//    「总改动量」，还把被两次合并都碰过的文件数两遍——它解释不了任何一次真实的改动。

/** 先例行的前缀。单独一个常量只为让「这一行以什么开头」也能被用例钉住。 */
export const SIMILAR_PREFIX = '同类先例：';

/**
 * 一行先例需要的三格。**故意不用 `SimilarMerge`**：文案层不需要 `sha`，也不该知道
 * 有 `sha`——它一旦知道，下一个人就会想在这里按 sha 去查点什么。
 */
export type SimilarPrecedent = { date: string; subject: string; files: number };

/**
 * 先例 → 材料里的那一行（没有先例时是空数组）。
 *
 * 分隔符用全角分号而不是顿号：每一格都是「日期 + 标题 + 文件数」的完整一句，顿号会把
 * 三次不同规模的改动连成一串，读者数不出哪几个文件属于哪一次。
 */
export function similarLines(items: readonly SimilarPrecedent[]): string[] {
  if (items.length === 0) return [];
  const parts = items.map((item) => `${item.date}「${item.subject}」${item.files} 个文件`);
  return [`${SIMILAR_PREFIX}${parts.join('；')}`];
}

/**
 * 结论（+ 快照）之后接上先例那一行；没有先例时**原样返回**，连一个空行都不加。
 *
 * 与 `withSnapshots` 同一个形状、同一个理由：文案层在这里唯一能做的错事，就是给
 * 「没有」编一句话。
 */
export function withSimilar(
  text: string,
  items: readonly SimilarPrecedent[],
): string {
  const extra = similarLines(items);
  return extra.length === 0 ? text : `${text}\n${extra.join('\n')}`;
}

// ─── 最近改动：这条路上次有人动它是什么时候 ────────────────────────────────
//
// 评审读材料时还会问一句「这块代码是不是早就没人管了」。与「同类先例」不同的是，这一句
// **不涉及任何相似度判断**：它是一次日期查询（`recency.ts` 的 `recencyOf`），查得到就写，
// 查不到就不写。所以这一段的纪律只有两条：
//
// 1. **查不到 = 一个字都不写**（空数组、`withRecency` 原样返回）。绝不写「最近改动：未知」
//    或「无记录」：读者看到那句会认为「他们查过了，确实没有」——而真实情况往往是
//    「这个文件没有合并记录」（日常小提交从不进 `commit_history`，见 `recency.ts` 注释）。
//    把「我们手上没有这条记录」写成「查了没有」，是本仓修过两遍的同一种假话。
// 2. **一行一个文件，文件必须写出来**。brief 给的单条格式只有日期与天数
//    （`最近改动：<YYYY-MM-DD>（<N> 天前）`），但材料里一次列 5 条、而且这 5 条与上面的
//    候选清单**顺序不同**（这里按天数降序）。不带文件的 5 行同一句话，读者无法把日期
//    对回任何一个文件，也无法核实——那正好毁掉这一行存在的唯一理由。所以日期与天数
//    照 brief 的格式原样保留，只在前面补「仓:路径」这一格（形状照 `SNAPSHOT_LINE` 的
//    `<名字> @ <日期>`，读者两行并排看得出是同一类东西）。
//
// 3. **超龄那一句单独一个常量**：180 天是产品阈值（半年没人动 ≈ 遗留区），改它是产品决定。

/** 最近改动那一行的前缀。单独一个常量只为让「这一行以什么开头」也能被用例钉住。 */
export const RECENCY_PREFIX = '最近改动：';

/**
 * 多少天算「很久没人动过」：**180 天**。
 *
 * 这个数没有理论依据，只有一个用途：把「隔了一两个迭代」与「半年没人碰」分开。改它是
 * 产品决定，改完记得同步 `tests/locate-recency.test.ts` 的边界用例（180 不追加、181 追加）。
 */
export const RECENCY_OLD_DAYS = 180;

/** 超龄时追加的那半句。 */
export const RECENCY_OLD_TAIL = '，已经很久没人动过';

/**
 * ISO 时刻 → 北京时间的日历日（`YYYY-MM-DD`）。
 *
 * 为什么要单独写而不是用 `dayOf`：`dayOf` 直接截 ISO 的前 10 个字符，那是 **UTC** 的那一天。
 * 这里的 `days` 是按 `Asia/Shanghai` 算的（`recencyOf`），若日期用 UTC、天数用北京时间，
 * 一份材料里就会出现「2026-11-08（1 天前）」这种自相矛盾的一行——同一句话里的两个值必须
 * 出自同一套口径。解析不出来返回 `null`（不编日期）。
 */
function shanghaiDateOf(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

/**
 * 最近改动 → 材料里的那几行（没有已知条目时是空数组，一个字都不写）。
 *
 * 单条：`最近改动：123pan-pc:src/pages/Share/Share.tsx @ 2026-09-12（57 天前）`；
 * 超过 `RECENCY_OLD_DAYS` 天再追加 `，已经很久没人动过`。
 *
 * 日期读不出来的条目**跳过**：`recencyOf` 已经挡过一层，这里再挡一次是因为文案层不能相信
 * 上游永远对——而渲染成 `最近改动：日期未知` 正是本节第 1 条禁止的那种占位。
 */
export function recencyLines(items: readonly RecentFile[]): string[] {
  const lines: string[] = [];
  for (const item of items) {
    const day = shanghaiDateOf(item.lastMergedAt);
    if (day === null) continue;
    const tail = item.days > RECENCY_OLD_DAYS ? RECENCY_OLD_TAIL : '';
    lines.push(`${RECENCY_PREFIX}${item.repo}:${item.path} @ ${day}（${item.days} 天前）${tail}`);
  }
  return lines;
}

/**
 * 快照那几行之后接上「最近改动」；没有已知条目时**原样返回**，连一个空行都不加。
 *
 * 与 `withSnapshots` / `withSimilar` 同一个形状、同一个理由：文案层在这里唯一能做的错事，
 * 就是给「没有」编一句话。
 */
export function withRecency(text: string, items: readonly RecentFile[]): string {
  const extra = recencyLines(items);
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

// ─── 正文与脚注：产品语言 vs 代码坐标（2026-11-09 的产品决定）────────────────
//
// owner 读了一份真实材料，把这句话退回来了：
//
//   「落点是 `service/cdn_link.go:382` 的 `(*cdnLink).getUserCustomDomainIsShortLink`
//    私有方法，改动面在 `service/cdn_link.go` 及其调用方，不在 `component/`」
//
// 他的原话是「这种好像也不对吧 得是产品语言吧」。读者是功能线/商业线负责人与 PM，
// 他们会**跳过**任何一句「文件路径 + Go 方法名」。这件事不是措辞偏好，是材料的读者变了：
// 同一句话对研发是信息，对 PM 是一段噪音——而他连噪音都读不到，因为他在第一行就翻页了。
//
// 所以材料改成**两层**，而且是**位置**上的两层（不是两个渠道）：
// 1. **正文** = 产品语言：说清「产品的哪一部分变了、用户会看到什么」，用需求自己的词；
// 2. **末尾** = 「研发参考」小节：坐标（`仓:路径:行号 符号`）与受影响文件数。
//
// 三条硬规矩（改字之前先读）：
// 1. **坐标是证据，不是结论**。正文里出现路径/函数名/行号 = 违规，由机器拦（见
//    `uemaster/body-language.ts`），不靠模型自觉——2026-11-09 那次正是「只写在提示词里」
//    所以没拦住。
// 2. **没有可引的坐标就整段不写**（`referenceLines` 返回空数组，`injectReference` 原样返回）。
//    绝不写「研发参考：无」——与「同类先例」「最近改动」同一个纪律：给「没有」编一句话，
//    读者会以为「查过了，确实没有」。
// 3. **这一节只放证据，不放判断**。它不解释影响面、不建议改法：一句话说清「哪个文件的
//    哪一行有这个东西」，其余留给要动手的人。

/** 「研发参考」小节的标题（材料里最后一个标题，字号最小）。 */
export const REFERENCE_TITLE = '研发参考';

/** 受影响文件数那一行的前缀。 */
export const REFERENCE_FILES_PREFIX = '受影响文件：';

/**
 * 提示词里那个**正例**：一条后端需求的产品语言写法。
 *
 * 为什么它必须进提示词而不是只留在报告里：模型没有「PM 会跳过什么」这个概念，它只知道
 * 「我读过代码，把结论说清楚」。给一个具体句子，它才知道目标长什么样——这比十条禁令有用。
 */
export const PRODUCT_BODY_EXAMPLE =
  '这条需求改的是「自定义域名备案失效」的判定规则：系统现在能判断某个自定义域名是否已备案，'
  + '缺的是失效后主动告警。不涉及界面，用户侧看不到变化。';

/**
 * 提示词里的**反例**：owner 退回来的那一句（逐字）。
 *
 * 反例比正例更能定住边界：模型很容易把「引用代码」写成这种形状，而它读起来完全像一条
 * 严谨的结论——所以它必须被点名说「这就是要删掉的东西」。
 */
export const PRODUCT_BODY_ANTI_EXAMPLE =
  '落点是 `service/cdn_link.go:382` 的 `(*cdnLink).getUserCustomDomainIsShortLink` 私有方法，'
  + '改动面在 `service/cdn_link.go` 及其调用方，不在 `component/`';

/**
 * 第二轮反例：owner 退回来的第二段话（逐字）。
 *
 * 它**通过了**第一版的机器检查——没有路径、没有反引号——却全是研发语言。这正是
 * 「按形状拦」的洞：拦的是坐标，而 owner 不要的是**词**。缺口 + 建议成对给出，
 * 因为这两格是同一件事的两面（缺什么 + 怎么补），模型也总是成对地写。
 */
export const GAP_WRONG_BLOCK = [
  '缺口：跳到 purchaseRecord 的哪个 tab 写了，但带不带定位参数没写。',
  '建议：跳 /purchaseRecord?tab=rights&focus=ORDER_ID，命中项高亮 2 秒。',
  '      旧路径 302 到新页并带 focus 参数。',
].join('\n');

/**
 * 第二轮正例：同一段话的产品语言版本（逐字，owner 认可的写法）。
 *
 * 信息量一点没少：定位到哪一条、高亮多久、旧入口怎么办，全在；少掉的只是
 * 「怎么实现」（参数名、状态码、页面内部的名字）。
 */
export const GAP_RIGHT_BLOCK = [
  '缺口：从「1TB 流量包」点进去，是直接定位到这一条并高亮，还是只停在列表顶部？原文没写清。',
  '',
  '建议：点「记录与权益」→ 打开新页面，自动切到「权益」标签，并定位到用户刚点的那一条（高亮两秒）。',
  '      旧入口继续可用，会自动跳到新页面，用户不会遇到打不开的情况。',
].join('\n');

/**
 * 两层的规矩（提示词片段，**每一份材料**的提示词都带它）。
 *
 * 为什么这段文字住在 `copy.ts` 而不是散在三个提示词里：这与 `ABSENT_LINE` 那几句同一个
 * 理由——一处措辞、一处口径。三个提示词各写一遍，改一次就漂一次，而漂的那一份恰好不会
 * 被用例发现（它只是「提示词里少了一句话」）。
 *
 * ── 第二轮（同一天，owner 第二次退货）：坐标拦住了，**词**没拦住
 *
 * 第一版只管「文件路径 + 函数名」。owner 退回的第二段话一个路径都没有，却全是研发语言：
 * 网址参数、裸驼峰命名、代码变量名、HTTP 状态码、实现类名词。所以这一段现在多了两样东西：
 * 1. **一对新的正例 / 反例**，逐字取自他退回来的那两句（缺口 + 建议），因为模型最容易
 *    写出的正是这个形状——它读起来甚至很严谨；
 * 2. **一条边界**：需求自己的领域词（「分页」「导出」「第三方接口」）允许出现在正文，
 *    但**缺口 / 建议 / 风险**这几格是 PM 拍板的地方，实现词在那里一律不许出现。
 *    机器按这个边界分两档查（`uemaster/body-language.ts` 的 `LeakMode`）。
 */
export const PRODUCT_BODY_RULE: readonly string[] = [
  '',
  '【正文必须是产品语言】这份材料的读者是功能线/商业线负责人与 PM，他们会跳过任何一句',
  '「文件路径 + 函数名」。所以分两层写：',
  '  · **正文**（结论、差异说明、标注、页面文案）用产品语言：说清「产品的哪一部分变了、',
  '    用户会看到什么」，用这条需求自己的词（功能名、页面名、状态名）。',
  '  · 正文里**不许**出现：文件路径（`service/x.go`、`src/pages/a.tsx`）、函数或方法名、',
  '    行号（`xxx.go:382`），也不许用反引号把这类标识符包起来。',
  '  · 代码坐标是**证据**，不是结论：它们由系统自动放进材料末尾的「研发参考」小节，',
  '    你不要在正文里写，写了会被机器删掉。',
  '  · 这条规则**不改变结论本身**：「代码没读到 / 没找到 / 最可能的位置（待确认）」这三种',
  '    说法照旧（它们说的是证据够不够，与坐标无关）。',
  '正例（照这个语气写）：',
  `  ${PRODUCT_BODY_EXAMPLE}`,
  '反例（这句话会被机器拦掉，别写）：',
  `  ${PRODUCT_BODY_ANTI_EXAMPLE}`,
  '',
  '【技术词汇同样算违规】没有路径也算：下面这些词读者一样读不懂，一样会让 PM 翻页。',
  '  · 网址参数：`?tab=rights&focus=ORDER_ID`（要写「自动切到「权益」标签并定位到刚点的那一条」）；',
  '  · HTTP 状态码当散文用：302 / 301 / 404 / 500（要写「自动跳到新页面」「打不开」「出错」）；',
  '  · 裸的英文标识符：purchaseRecord、fetchVipGoods、ORDER_ID（不加反引号也算）；',
  '  · 文件扩展名：.vue / .ts / .tsx / .json / .go（对读者是零信息，直接不写）；',
  '  · 实现类名词：字段 / 接口 / 埋点 / 参数 / 路由 / 组件 / 接口地址 / 入参 / 出参',
  '    （写成「信息项 / 系统对接 / 数据统计 / 设置项 / 页面跳转 / 页面模块」）。',
  '  · **边界**：如果那个词是这条需求自己的领域词（「分页」「导出」「第三方接口要备案」），',
  '    正文里可以出现；但**缺口 / 建议 / 风险**这几格是 PM 拍板的地方，那儿**一个实现词',
  '    都不许有**——那里出现实现词，等于这一条没写成结论。',
  '',
  '缺口 + 建议的正确写法（照这个写，逐字对照）：',
  `  ${GAP_WRONG_BLOCK}`,
  '同一个意思，产品语言的版本：',
  `  ${GAP_RIGHT_BLOCK}`,
  '注意上面那个「反例」里**没有**任何文件路径：它照样是研发语言。差别只有一条——',
  '一边在说「这边怎么实现」（参数、标签、状态码、页面名），一边在说「用户会看到什么、',
  '产品上还缺什么决定」。你要写的是后一种。',
];

/** 一行坐标：仓、仓内路径、可选的行号与符号。 */
export type CodeRef = {
  /** 配置里的仓名（`123pan-pc` / `apisrv`）。 */
  repo: string;
  /** 仓内相对路径（`service/cdn_link.go`）。 */
  path: string;
  /** 1 起算的行号。不知道就不给——不猜一个「大概在第几行」。 */
  line?: number | null;
  /** 符号名（`GetUserCustomDomainIsShortLink`）。不知道就不给。 */
  symbol?: string | null;
};

/** 坐标 → 材料里的一行（`apisrv:service/cdn_link.go:382 GetUserCustomDomainIsShortLink`）。 */
export function referenceLine(ref: CodeRef): string {
  const line = typeof ref.line === 'number' && Number.isFinite(ref.line) && ref.line > 0
    ? `:${ref.line}`
    : '';
  const symbol = (ref.symbol ?? '').trim();
  return `${ref.repo}:${ref.path}${line}${symbol === '' ? '' : ` ${symbol}`}`;
}

/**
 * 一批坐标 → 「研发参考」小节的正文行（**空数组 = 整节不写**）。
 *
 * 两条口径：
 * 1. **去重、保持首次出现的顺序**：同一个文件被两条结论引用时只写一次——这一节是证据
 *    清单，不是又一次论证；顺序跟着结论走，读者能对上。
 * 2. **受影响文件数只数路径**：同一个文件的三个符号是**一个**文件。这个数是
 *    「材料引用到了几个文件」，不是「这次改动要改几个文件」（后者只有研发知道，
 *    而我们没有资格替他估）。
 */
export function referenceLines(refs: readonly CodeRef[], extra: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  const paths = new Set<string>();
  for (const ref of refs) {
    const repo = ref.repo.trim();
    const path = ref.path.trim();
    if (repo === '' || path === '') continue;
    const line = typeof ref.line === 'number' && ref.line > 0 ? ref.line : null;
    const symbol = (ref.symbol ?? '').trim() === '' ? null : (ref.symbol ?? '').trim();
    const key = `${repo}\u0000${path}\u0000${line ?? ''}\u0000${symbol ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    paths.add(`${repo}\u0000${path}`);
    lines.push(referenceLine({ repo, path, line, symbol }));
  }
  // 从正文里搬过来的坐标（`body-language.ts` 删掉的那些子句）：它们可能不带仓名
  // （模型写的是 `service/cdn_link.go:382`），所以**不进「受影响文件」的计数**——
  // 拿一个缺了一半的坐标去数文件，会数出一个比真实值小的数，而那个数会被当成结论。
  for (const line of extra) {
    const text = line.trim();
    if (text === '' || lines.includes(text)) continue;
    lines.push(text);
  }
  if (lines.length === 0) return [];
  if (paths.size > 0) lines.push(`${REFERENCE_FILES_PREFIX}${paths.size} 个`);
  return lines;
}
