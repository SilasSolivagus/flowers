#!/usr/bin/env tsx
/**
 * 定位准确率评测：一条需求，三条路各找一遍，看谁找对了。
 *
 * ── 三条路（arm）
 *
 * | arm | 是什么 | 角色 |
 * |---|---|---|
 * | A | 冻结的老办法：ssh grep + 中英词表（`pathA`，与 compare-locate.ts 同源，不许动） | 基线 |
 * | B | 静态索引 `locateAcross`（路由/导入/符号；生产上只给评审用） | 参照 |
 * | C | **新生产路径**：`commit_history` → `locateFromHistory`（中文提交信息检索 → 前 5 次合并 → 文件聚合） | 这次重做的效果 |
 *
 * C 的检索式和线上完全一致：`locateQuery(title)`（只有标题、压平空白），见
 * `inspect.ts` 的 `queryOfRequirement`。为了证明「C 好不是因为它拿到了一句更短的话」，
 * 同时报一列 **C′**：C 的同一份实现、喂 A/B 那句「标题 + 描述」。C 与 C′ 差多少，
 * 就是「检索式」这一项的贡献，不是实现差异。
 *
 * ── 标准答案从哪来
 *
 * 不靠人肉标注。镜像里有**合并提交**，每条都能算出「这次合并带进来哪些文件」：
 *
 *     git diff --name-only <merge>^1 <merge>
 *
 * 一条特性分支（`feat-download-limit-yl`）合并进来的那些文件，就是**这个功能的位置**。
 * 需求「上传下载按量限速风控」对上的正是它。
 *
 * ── 两个面，分开报，绝不合并成一个百分比（spec §9）
 *
 * 面一：7 条人工配对的需求（`CASES`，每条带配对理由）。**说了算**的那把尺子。
 * 面二：657 条合并，用其自身的提交信息当查询。只用来抓「大面积崩塌」；**有泄漏**
 *      （查询来自答案那次合并），所以它的绝对值永远比真实现场乐观。
 *
 * 指标：第 1 名命中、前 3 名命中、噪音文件数（候选里不属于标准答案的个数），以及
 * 三档分布 `none`（一个候选都没交）/ `low`（有候选但没命中）/ `hit`（命中）。
 *
 * 用法：
 *   npx tsx scripts/bench-locate.ts                    # 面一全量 + 面二全量
 *   npx tsx scripts/bench-locate.ts --only 776         # 面一只跑一条（按**旧需求号**过滤，见 `CASES`）
 *   npx tsx scripts/bench-locate.ts --commits 60       # 面二只跑前 60 条
 *   npx tsx scripts/bench-locate.ts --surface 1        # 只跑面一（面二的 A/B 很慢）
 *   npx tsx scripts/bench-locate.ts --surface 2 --c-only  # 面二只跑 C/C'（513 条约 40 秒）
 *   npx tsx scripts/bench-locate.ts --json /tmp/x.json # 另存一份机器可读结果
 *   npx tsx scripts/bench-locate.ts --asof 2026-11-07T00:00:00Z   # 复现更早那一次的语料边界
 *   npx tsx scripts/bench-locate.ts --surface 1 --verify-only   # 只做「标准答案还在不在」那道控制
 *
 * `--c-only` 是报告 §0.4 那条复现命令的一部分（A 每条约 30 秒，513 条跑不完，见
 * `armSet`）。用法块早先漏了它，照着报告复现的人会以为只能整面跑。
 *
 * ── 2026-11-10：这一份脚本被搬过两处（都不改尺子）
 *
 * 1. **传输方式**。原来三个取数口都是 `ssh` 字面量：`ssh dogyun cd /srv/123pan-mirror/<repo>.git`
 *    （合并记录）与 `ssh dogyun docker exec … psql`（需求）。镜像在 2026-11-09 搬到本机盘后，
 *    这些命令连第一句 `cd` 都过不去——脚本整体不可运行。现在改成走 `mirror.ts` 的只读读口
 *    （`mergeHistory()` / `lsTreeEntries()` / `head()` / `grep()`），配置由
 *    `app_settings.code.mirror.repos` 解析，`local` 与 `ssh` 两种传输都认。git 命令本身
 *    **一条没变**：`rev-list --merges` → 每条 `log -1` + `log --no-merges m^1..m` +
 *    `diff --name-only m^1 m`，与 `HISTORY_SCRIPT` 逐条对应。需求也从「ssh 到远端 psql」
 *    改成同一个 `db`（`src/db/client.ts`）。
 * 2. **案例的主键**。`CASES` 原来按需求**号**配对，而那批号已经不在原位了（库按 PRD 重建过：
 *    旧 #776 = 上传下载按量限速风控，现在 #776 = 音乐收藏后底部操作栏收藏态未更新）。
 *    现在按**标题**解析、号只留作历史记号（`legacyNumber`）：C 的检索式本来就是
 *    `locateQuery(title)`（只喂标题），所以「同标题同分支」仍然是上一次那 7 条。
 *
 * ── 另一件必须写在明面上的事：标准答案会过期
 *
 * 标准答案来自「某次合并 diff 出来的文件清单」，而那个文件可能**后来被删了**。已删的文件
 * 再也不会出现在任何候选里，把它算成 locate 的 miss 是在拿一个不存在的东西扣分。所以这一版
 * 多了一道**控制**（`survivalOf`）：逐条核对标准答案里的每个文件**还在不在索引读的那棵树
 * （HEAD）上**。全部失踪的案例标 `invalidated`，不进任何分母；部分失踪的照算，但把失踪的
 * 文件逐个列出来（`gone`）。这道控制只**报告**，不参与打分——打分口径一个字都没动。
 */
import { sql } from 'drizzle-orm';
import { writeFileSync } from 'node:fs';

import {
  grep, head, isNoisePath, lsTree, lsTreeEntries, mergeHistory,
} from '../src/core/codemirror/mirror.js';
import { locateAcross } from '../src/core/codemirror/code-index.js';
import { repoIndex } from '../src/core/codemirror/index-store.js';
import { keywordsFrom, locateQuery } from '../src/core/uemaster/inspect.js';
import {
  CANDIDATE_LIMIT, TOP_MERGES, locateFromHistory, mergeWeight, rankMerges,
} from '../src/core/locate/history.js';
import { readHistory, type HistoryRow } from '../src/core/locate/history-store.js';
import { db, pool } from '../src/db/client.js';

/**
 * 被评的**两个仓**。评测口径不许跟着索引规模一起长。
 *
 * 2026-11-09 的 cutover 把镜像扩到 216 个仓（`repo_coverage`：216 个 ok、80,319 个文件、
 * 326 个页面），但这一份评测仍然只看这两个仓，原因不是懒：
 * 1. 面一的 7 条配对就是这两个仓里的分支；
 * 2. 定位的线上口径（`inspect.ts` → `locateFromHistory`）读的是 `commit_history`，而那张表
 *    只有这两个仓的行（546 + 125 = 671；其余 214 个仓**一行历史都没有**）。
 *
 * 也就是说：索引扩了 216 个仓，而定位能看的东西一个都没多。把这两个常量改成 216 个仓，
 * 只能让 A/B 两臂变成「拿更多不相关的文件去撞答案」，不是「定位变强了」——
 * 那是另一个实验，要先把历史补进库里。见 2026-11-10 的复测报告。
 */
const REPOS = ['123pan-pc', '123pan-uni-app'] as const;

/**
 * 人工核对过的配对：需求标题 ↔ 分支名片段。
 *
 * 每条右边那句是本人才看过的理由——不写理由的配对不许进这张表，否则以后没人敢信评测结果。
 *
 * **锚是 `title`，不是 `legacyNumber`。** 上一次测量（2026-11-07）按号取需求行，那批号在
 * 库里重建之后已经指向别的需求了：旧 #776「上传下载按量限速风控」现在是 #545，而现在的
 * #776 是「音乐收藏后底部操作栏收藏态未更新」。按号跑会得到七条**看起来正常、配错对象**的
 * 结果（而且不会报错），所以号只留作历史记号：报告里要靠它跟旧表对齐。
 *
 * 标题在库里可能不止一行（同一句话被录了两次，例如「用户部分权益缩减调整」有 #338 / #742）：
 * 解析时取**号最小的那行**，并把它打出来。C 只吃标题，所以重复行不影响排名。
 */
const CASES: ReadonlyArray<{ legacyNumber: number; title: string; branch: string; why: string }> = [
  { legacyNumber: 776, title: '上传下载按量限速风控', branch: 'download-limit', why: '标题「上传下载按量限速风控」= 分支 feat-download-limit' },
  { legacyNumber: 782, title: '权益套餐产品结构改造', branch: 'userEquity', why: '「权益套餐产品结构改造」= feat-userEquity' },
  { legacyNumber: 775, title: '用户部分权益缩减调整', branch: 'userEquity', why: '「用户部分权益缩减调整」= feat-userEquity' },
  { legacyNumber: 758, title: '专业空间', branch: 'professional-space', why: '「专业空间」= release-professional-space' },
  { legacyNumber: 788, title: '商用空间：容量售卖与个人盘风控联动', branch: 'professional-space', why: '「商用空间：容量售卖与个人盘风控联动」= professional-space' },
  { legacyNumber: 797, title: '分享创建页改版-直链分享', branch: 'direct-link', why: '「分享创建页改版-直链分享」= feat-direct-link-renovation' },
  { legacyNumber: 795, title: 'PC 端支持打开分享页', branch: 'directLink-open', why: '「PC 端支持打开分享页」= feat-directLink-open' },
];

/** 只保留源码：合并里带的 docs/、package.json、图片不算「这个功能的位置」。 */
const SRC = /\.(tsx?|jsx?|vue)$/i;
const CODE_DIR = /(^|\/)(pages?|views?|screens?|components?|services?|api|store|hooks|utils)\//i;

/**
 * 标准答案「弱」的界线：大于这个文件数就认为它是一堆合并的并集，不是一个功能的落点。
 *
 * 10 不是算出来的，是可解释的：这个仓里一条正常功能合并改 2~6 个源码文件，10 以上
 * 必然是多条分支/多次发布的并集（`professional-space` 那种）。弱标准答案的案例
 * **不进头条数字**，另报一版「含弱案例」的数字，两版都写进报告——把一条「27 个文件的
 * 并集」算成命中/不命中，等于用一个谁都能蒙中的分母去算准确率。
 */
const WEAK_ANSWER_FILES = 10;

type Merged = { repo: string; branch: string; at: string; date: string; files: string[] };

/**
 * 从镜像里读合并记录：分支名 + 日期 + 这次合并带进来的源码文件。
 *
 * 走 `mergeHistory()`（`mirror.ts` 读口 7）而不是自己拼 git 命令：那个读口已经把
 * 「一次 shell 里跑完所有合并」的脚本写好了，且**只认配置里的仓库路径**——`local` 与
 * `ssh` 两种传输同一份实现。早先这里是一条字面量 `ssh dogyun cd /srv/123pan-mirror/…`，
 * 镜像搬走之后整条脚本连第一句都过不去。
 *
 * 与旧实现的**语义差别**只有一处：分支名由 `mergeBranch()`（`from <x>` 的**第一个**匹配）
 * 解析，旧 shell 用的是 `sed -n` 的贪婪写法（`s|.*from \([^ ]*\)|\1|p`，`.*` 贪婪所以取**最后**一个）。两者
 * 只在「标题里出现第二个 from」的提交上分歧。这一版不另写一份解析来对账（那等于在评测里
 * 再造一个实现），改用一次离线核对：把两个仓全部合并标题取出来，跑两种解析、逐条比。
 * 2026-11-10 的结果是**零分歧**（见报告的「口径核对」一节），所以标准答案没有被换过。
 */
async function mergesOf(repo: string): Promise<Merged[]> {
  const got = await mergeHistory(repo);
  if (!got.ok) throw new Error(`读不到镜像 ${repo} 的合并历史（${got.code}）：${got.message}`);
  return got.data.map((r) => ({
    repo,
    branch: r.branch ?? '',
    // `at` 是完整 ISO（`--asof` 要按它筛），`date` 只到日（展示用）。
    // 不要拿 `date` 跟别的源比大小：镜像给 `+08:00`、库给 `Z`（见 `history-store.readHistory`）。
    at: r.mergedAt,
    date: r.mergedAt.slice(0, 10),
    files: r.files,
  }));
}

/** 这条分支带进来的「功能文件」——评测里的标准答案。 */
function expectedOf(all: Merged[], token: string): string[] {
  const set = new Set<string>();
  for (const m of all) {
    if (!m.branch.includes(token)) continue;
    for (const f of m.files) if (SRC.test(f) && CODE_DIR.test(f)) set.add(f);
  }
  return [...set].sort();
}

/** 标准答案落在哪个仓（C 在生产上是**按单仓**检索的，这条会决定它看不看得到答案）。 */
function reposOf(all: Merged[], token: string): string[] {
  const set = new Set<string>();
  for (const m of all) if (m.branch.includes(token)) set.add(m.repo);
  return [...set].sort();
}

type Picked = string[];

// ═══════════════════════════════════════════════════════════════════════════
// A 臂：**冻结副本**——与本分支代码零共享（终审 Blocker 3）
// ═══════════════════════════════════════════════════════════════════════════
//
// 为什么整段抄一份，而不 `import { keywordsFrom } from '../src/core/uemaster/inspect.js'`：
// A 的定义是「重做**之前**线上跑的那一套」。`keywordsFrom` 在本分支被改过（`5d818ce`
// 加了虚词过滤：含 的/了/为/对… 的 n-gram 一律不成词）。import 生产版本，等于让 A 跟着
// 分支一起变形——「改前 vs 改后」就不再是同一个尺子量两次，而这条评测的全部意义就是
// 那个差值。抄一份之后，A 永远代表 `5d818ce` 之前的语义（**无虚词过滤**），
// 而这一份只随「要重测一个更早的基线」这类决定才改。`compare-locate.ts` 里的那一份
// 同样是抄的，两份一致是**碰巧一致**（都抄自 `5d818ce` 之前），不是 import 关系。
//
// 三样东西一起冻结，缺一不可：
// 1. 26 条中英词表（`PATH_TERMS`）——bench 早先的表是 31 条，多出来的
//    权益/空间/域名/实况图/风控 正是 7 条案例标题里的词，等于给 A 递答案；
// 2. 30 条停用词（`STOP_WORDS`，`compare-locate.ts` 的 A 用它滤关键词）；
// 3. `keywordsFrom` 的**副本**（下面那份，无虚词过滤）。

/** 到处都有的词，拿它们定位等于随机挑文件（冻结自 `compare-locate.ts` 的 A 半边）。 */
const STOP_WORDS = new Set([
  '文件', '当前', '返回', '结果', '目录', '上一级', '支持', '需要', '可以', '进行',
  '展示', '操作', '页面', '功能', '设置', '进入', '点击', '选择', '内容', '数据',
  '新增', '增加', '优化', '调整', '统一', '确认', '记录', '显示', '以下', '上述',
]);

/** 中文业务词 → 代码里的英文片段。**26 条**，与 `compare-locate.ts` 的冻结版逐条相同。 */
const PATH_TERMS: Array<[string, string[]]> = [
  ['搜索', ['search']], ['分享', ['share']], ['目录', ['directory', 'dir']],
  ['面包屑', ['breadcrumb', 'crumbs']], ['排序', ['sort', 'order']],
  ['文件', ['file']], ['文件夹', ['folder', 'dir']], ['列表', ['list']],
  ['详情', ['detail']], ['登录', ['login', 'auth']], ['会员', ['vip', 'member']],
  ['短信', ['sms', 'message']], ['通知', ['notify', 'notification']],
  ['订单', ['order']], ['支付', ['pay', 'payment']], ['剪贴板', ['clipboard']],
  ['直链', ['direct', 'link']], ['限速', ['limit', 'rate']], ['上传', ['upload']],
  ['下载', ['download']], ['历史', ['history']], ['设置', ['setting', 'config']],
  ['多选', ['select', 'checkbox']], ['导航', ['nav', 'navigation']],
  ['移动端', ['mobile', 'h5', 'app']], ['首页', ['home', 'index']],
];

// ─── `keywordsFrom` 的冻结副本（语义取 `5d818ce` 之前：**无虚词过滤**）────────
//
// 与 `src/core/uemaster/inspect.ts` 的同名函数**逐行对应**，只有一处不同：切 n-gram 时
// 不挡含虚词的碎片（`FUNCTION_CHARS` / `hasFunctionChar` 在本分支 `5d818ce` 才加）。
// 这不是「旧代码更对」——`5d818ce` 的改动是对的，生产就该用新的；冻结只是为了让 A 臂
// 保持「改之前」的身份。两处一旦被谁「顺手合并」，A 臂的差值就会失真，而且**不会报错**。

const CJK_RUN = /[\u4e00-\u9fa5]+/g;
const ANY_RUN = /[\u4e00-\u9fa5A-Za-z0-9]+/g;
const QUOTED = /[「“"']([^「」“”"'\n]{2,12})[」”"']/g;
const FROZEN_MAX_KEYWORDS = 8;

const FROZEN_STOPWORDS: ReadonlySet<string> = new Set([
  '进行', '可以', '需要', '如果', '所有', '以及', '同时', '必须', '就是', '这个', '那个',
  '我们', '他们', '以下', '如下', '上述', '相关', '对应', '情况', '场景', '问题', '内容',
  '方式', '时间', '数据', '能够', '一个', '本期', '产品', '研发', '确认', '按照', '通过',
  '复用', '现有', '已经', '不再', '不得', '不能', '保留', '统一', '具体', '包括', '例如',
]);

const FROZEN_STOP_CHARS: ReadonlySet<string> = new Set(['的', '了', '和', '与', '在', '为', '是', '中', '上', '下', '不']);

function frozenBump(map: Map<string, number>, word: string, weight: number): void {
  const clean = word.trim();
  if (clean.length < 2 || FROZEN_STOPWORDS.has(clean) || FROZEN_STOP_CHARS.has(clean)) return;
  map.set(clean, (map.get(clean) ?? 0) + weight);
}

function frozenNgrams(run: string, map: Map<string, number>, weight: number): void {
  for (let len = 2; len <= 6; len += 1) {
    for (let i = 0; i + len <= run.length; i += 1) frozenBump(map, run.slice(i, i + len), weight);
  }
}

/** 冻结版关键词抽取（`5d818ce` 之前的语义）。改它之前先读上面那段注释。 */
function frozenKeywordsFrom(markdown: string, title: string, max = FROZEN_MAX_KEYWORDS): string[] {
  const counts = new Map<string, number>();

  QUOTED.lastIndex = 0;
  for (let m = QUOTED.exec(markdown); m !== null; m = QUOTED.exec(markdown)) {
    const text = (m[1] ?? '').trim();
    if (/[\u4e00-\u9fa5]/.test(text)) frozenBump(counts, text, 3);
  }

  for (const run of title.match(ANY_RUN) ?? []) {
    frozenBump(counts, run, 2);
    if (/[\u4e00-\u9fa5]/.test(run)) frozenNgrams(run, counts, 2);
  }

  for (const run of markdown.match(CJK_RUN) ?? []) frozenNgrams(run, counts, 1);

  const ranked = [...counts.entries()]
    .map(([word, count]) => ({ word, score: count * word.length }))
    .sort((a, b) => b.score - a.score || b.word.length - a.word.length || a.word.localeCompare(b.word));

  const picked: string[] = [];
  for (const item of ranked) {
    if (picked.length >= max) break;
    const redundant = picked.some((word) => word.includes(item.word) || item.word.includes(word));
    if (redundant) continue;
    picked.push(item.word);
  }
  return picked;
}

/** A 用的关键词：冻结词表 + 停用词过滤（与 `compare-locate.ts` 的 `runA` 同一口径）。 */
function frozenKeywords(query: string, title: string): string[] {
  return frozenKeywordsFrom(query, title).filter((word) => !STOP_WORDS.has(word) && word.length >= 2);
}

function pathTokens(word: string): string[] {
  const hit = PATH_TERMS.find(([cn]) => word.includes(cn) || cn.includes(word));
  return hit === undefined ? [] : hit[1];
}

/**
 * A：改之前线上那套（`ssh grep` + 26 条中英词表）。
 *
 * 打分口径也照冻结版（路径命中 ×10 + 正文命中、只留路径命中过的文件、每仓取 6 个）——
 * 早先这里用的是「命中次数相加」，与 `compare-locate.ts` 的 A 不是同一个算法，
 * 那样 A 臂就不是「改之前线上那一套」，而是「本分支顺手写的一个近似」。
 */
async function pathA(query: string, title: string): Promise<Picked> {
  const keywords = frozenKeywords(query, title);
  const picked: string[] = [];
  for (const repo of REPOS) {
    const tree = await lsTree(repo);
    if (!tree.ok) continue;
    const pool = new Set(tree.data.filter((p) => CODE_DIR.test(p) && SRC.test(p)));

    const hits = new Map<string, { content: number; path: number }>();
    const bumpHit = (path: string, field: 'content' | 'path'): void => {
      const cur = hits.get(path) ?? { content: 0, path: 0 };
      cur[field] += 1;
      hits.set(path, cur);
    };
    for (const path of pool) {
      const low = path.toLowerCase();
      for (const word of keywords) {
        if (low.includes(word.toLowerCase())) bumpHit(path, 'path');
        else if (pathTokens(word).some((t) => low.includes(t))) bumpHit(path, 'path');
      }
    }
    for (const word of keywords) {
      const found = await grep(repo, word, { max: 60 });
      if (!found.ok) continue;
      for (const hit of found.data) if (pool.has(hit.path)) bumpHit(hit.path, 'content');
    }

    const ranked = [...hits.entries()]
      .filter(([, v]) => v.path > 0)
      .sort((a, b) => (b[1].path * 10 + b[1].content) - (a[1].path * 10 + a[1].content)
        || a[0].localeCompare(b[0]))
      .slice(0, 6)
      .map(([p]) => p);
    for (const p of ranked) picked.push(p);
  }
  return picked;
}

/** B：静态索引 + locateAcross（评审那条路）。 */
async function pathB(query: string, title: string): Promise<Picked> {
  const keywords = keywordsFrom(query, title);
  const entries: Array<{ repo: string; index: unknown }> = [];
  for (const repo of REPOS) {
    const h = await head(repo);
    if (!h.ok || h.data === null) continue;
    const built = await repoIndex(db, repo, h.data.sha, {});
    if (!built.ok) continue;
    entries.push({ repo, index: built.data.index });
  }
  const decision = locateAcross(entries as never, keywords, { limit: 6 });
  const picked: string[] = [];
  for (const [, choice] of decision) {
    for (const probe of (choice as { probes: Array<{ path: string }> }).probes) picked.push(probe.path);
  }
  return picked;
}

/** C：新生产路径 `locateFromHistory`（纯函数，不碰网络/库）。 */
function pathC(rows: readonly HistoryRow[], query: string): Picked {
  const result = locateFromHistory(rows, query);
  if (result.kind !== 'candidates') return [];
  return result.items.map((item) => item.path);
}

/** 命中第几名（1 起）。没命中 = 0。 */
function rank(picked: Picked, expected: string[]): number {
  for (let i = 0; i < picked.length; i += 1) {
    if (expected.some((want) => picked[i] === want || picked[i]!.endsWith(`/${want}`))) return i + 1;
  }
  return 0;
}

/** 三档：`none` 一个都没交 / `low` 交了但没命中 / `hit` 命中。 */
function tier(picked: Picked, pickedRank: number): 'none' | 'low' | 'hit' {
  if (picked.length === 0) return 'none';
  return pickedRank === 0 ? 'low' : 'hit';
}

/**
 * 「真答案那次合并」在整份历史里排第几、它有多大。
 *
 * 这条诊断是给报告用的：C 没命中分两种完全不同的原因——**根本没检索到那次合并**
 * （落 `none`，要改检索）与**检索到了但被同合并并列挤出前 6**（要改聚合）。只看
 * 「未命中」两个字，这两种会被糊成一件，然后按错的那一件去动手。
 */
function answerMerge(
  rows: readonly HistoryRow[],
  query: string,
  expected: string[],
): AnswerMerge | null {
  const ranked = rankMerges(rows, query, rows.length);
  for (let i = 0; i < ranked.length; i += 1) {
    const entry = ranked[i];
    if (entry === undefined) continue;
    const hit = entry.row.files.some((f) => expected.some((w) => f === w || f.endsWith(`/${w}`)));
    if (hit) {
      return {
        rank: i + 1,
        files: entry.row.files.length,
        score: entry.score,
        repo: entry.row.repo,
        sha: entry.row.commitSha,
        date: entry.row.mergedAt.slice(0, 10),
      };
    }
  }
  return null;
}

/**
 * 「真答案那次合并」的四格 + 它落在哪个仓。
 *
 * 多出来的 `repo` 是给「错仓」这条原因用的：候选清单是两仓并集，一个候选排在前面可能
 * 只是因为**另一个仓**里有个同名的公用件——那种 miss 的原因不是「没找到」，而是「找错了仓」，
 * 两者的下一步完全不同（前者改检索，后者改聚合的跨仓权重）。
 */
type AnswerMerge = {
  rank: number;
  files: number;
  score: number;
  repo: string;
  sha: string;
  date: string;
};

// ═══════════════════════════════════════════════════════════════════════════
// 控制项：标准答案还在不在（`survivalOf`）——**只报告，不参与打分**
// ═══════════════════════════════════════════════════════════════════════════
//
// 标准答案是「某次合并 diff 出来的文件清单」，它是一份**历史快照**。文件后来被删掉时，
// 那条案例就再也不可能命中：任何候选集里都不会出现一个已不存在的路径。把它算成 miss，
// 等于拿一个不存在的目标扣 locate 的分——而且这种 miss 长得跟真 miss 一模一样（落 `low`），
// 从数字上看不出来，只能靠这道控制挡住。
//
// 判据只能看**索引读的那棵树**（`repoIndex` → `lsTreeEntries(ref=sha)`），因为候选只可能
// 来自那棵树。另外两种「找不到」要分开，别混进「已删」：
// - `filtered`：路径落在索引**故意排除**的目录/扩展名里（`dist/`、`node_modules/`、图片……）。
//   它可能还在仓里，但索引从来不看它，所以这条案例对 C 一直是不公平的（不是今天才失效）。
// - `gone`：路径既不在树里、也不是被过滤掉的——那就是真删了。

type Survival = { total: number; kept: string[]; gone: string[]; filtered: string[] };

/** 一个文件在「索引看见的这棵树」里是否存在。纯函数，可单测。 */
function survivalOf(expected: readonly string[], present: ReadonlySet<string>): Survival {
  const kept: string[] = [];
  const gone: string[] = [];
  const filtered: string[] = [];
  for (const path of expected) {
    if (present.has(path)) kept.push(path);
    else if (isNoisePath(path)) filtered.push(path);
    else gone.push(path);
  }
  return { total: expected.length, kept, gone, filtered };
}

/**
 * 一条案例算不算「还是一场公平的考试」。
 *
 * 采用的口径：**标准答案的全部文件都不在了**才失效（`invalidated`）——那时确实没有任何
 * 东西可找。部分文件被删的案例照算，因为剩下的那些仍然是「这个功能在哪」的真答案，而
 * 报告会把删掉的那几个逐一列出来，让读的人自己判断这条案例还剩多少成色。
 *
 * 严格口径（任一文件缺失即失效）也一并算出来（`strictlyInvalid`），因为它是同一份数据的
 * 另一种读法；两个数都进报告，但**头条只采用前一个**，并且分母写清楚。
 */
function invalidation(survival: Survival): { invalidated: boolean; strictlyInvalid: boolean } {
  return {
    invalidated: survival.kept.length === 0,
    strictlyInvalid: survival.gone.length > 0 || survival.filtered.length > 0,
  };
}

/** 一个仓在**索引真正读的那棵树**上的文件清单（用于 `survivalOf`）。 */
async function treeAt(repo: string): Promise<{ sha: string | null; files: Set<string> }> {
  const h = await head(repo);
  if (!h.ok || h.data === null) return { sha: null, files: new Set() };
  const entries = await lsTreeEntries(repo, { ref: h.data.sha });
  if (!entries.ok) return { sha: h.data.sha, files: new Set() };
  return { sha: h.data.sha, files: new Set(entries.data.map((entry) => entry.path)) };
}

/**
 * 需求行（这一版只取查询式真正用到的那几格）。
 *
 * `description` 已经不存在了：库在 PRD 那一轮重建时把「描述」拆成了
 * `context / problem / outcome`，而且内容是**重写过的 PRD 句式**，不是原来那段文本。
 * 所以长检索式（A 与 C′ 用的那句）没法逐字复刻，只能拼成
 * `标题 + 上下文 + 痛点 + 期望结果`——形状一样，文字不一样。**C 不受影响**：线上口径是
 * `locateQuery(title)`，只喂标题（见 `inspect.ts` 的 `queryOfRequirement`），而标题是原样还在的。
 */
type RequirementRow = { number: number; title: string; context: string; problem: string; outcome: string };

/**
 * 按标题取需求行（标题 → 号最小的那一行）。
 *
 * 走同一个 `db`（`src/db/client.ts`），不再 `ssh` 到远端 `docker exec psql`：那一句跟镜像
 * 一样是旧部署的假设，本机 cutover 之后连不上，而且远端那张库的 schema 与这份代码已经不是
 * 同一套（它有 `description`、没有 `context`）。
 */
async function requirementsByTitle(): Promise<Map<string, RequirementRow>> {
  const res = await db.execute<{
    number: number; title: string; context: string | null; problem: string | null; outcome: string | null;
  }>(sql`
    select number, title, context, problem, outcome
      from requirements
     where deleted_at is null
     order by number`);
  const out = new Map<string, RequirementRow>();
  for (const row of res.rows) {
    // `order by number` + 只写第一次见到的：同一句标题录了两行时，稳定地取号最小那行。
    if (out.has(row.title)) continue;
    out.set(row.title, {
      number: Number(row.number),
      title: row.title,
      context: row.context ?? '',
      problem: row.problem ?? '',
      outcome: row.outcome ?? '',
    });
  }
  return out;
}

/** A / C′ 用的那句长检索式：标题 + 三格 PRD 正文（空的格不占位）。 */
function longQueryOf(req: RequirementRow): string {
  const body = [req.context, req.problem, req.outcome].map((part) => part.trim()).filter((part) => part !== '');
  return [`${req.title}`.trim(), ...body].join('\n\n').trim();
}

/**
 * 第二个评测面：**用合并提交里的中文提交信息当查询词**。
 *
 * 为什么这个面比人工配对的那 7 条可信：
 * - 量：657 条合并，每条都有中文提交信息（「用户权益缩减」「下载限速风控开发」
 *   「动态域名入口切换至123panapi.com」）——那是开发者当时写的，不是事后编的。
 * - 标准答案精确：`git diff <merge>^1 <merge>` 就是这次合并动过的文件，不用猜。
 * - 零人工：不需要我先判断「这个分支对应哪条需求」。
 *
 * 代价有两层，都写在这里免得以后误用它的绝对值：
 * 1. 泄漏：查询就是答案那次合并的提交信息，C 的最优解就是「把这条自己检索回来」；
 * 2. 一条合并可能混了多个小改动（`feat: 合并master`），答案集会偏大、偏杂。
 *
 * 所以两个面分开报，不合并成一个百分比；面二只看「有没有大面积崩塌」。
 */
async function commitCases(
  repo: string,
  asofMs: number | null,
): Promise<Array<{ label: string; query: string; expected: string[]; sha: string; repo: string }>> {
  const got = await mergeHistory(repo);
  if (!got.ok) throw new Error(`读不到镜像 ${repo} 的合并历史（${got.code}）：${got.message}`);
  const out: Array<{ label: string; query: string; expected: string[]; sha: string; repo: string }> = [];
  for (const row of got.data) {
    // `--asof`：只留这一刻之前的合并，用来自造「上一次那批 40 条」的抽屉。
    if (asofMs !== null && Date.parse(row.mergedAt) > asofMs) continue;
    // 查询词：分支自己的提交信息（去掉合并提交本身）。空的、纯「合并master」的跳过。
    //
    // `mergeHistory` 把多行提交信息用 ` / ` 连起来（旧 shell 是 `tr '\n' ' '`）。这里连回
    // 空格再判长度，是为了让「这条算不算有效查询」的边界（`length < 4`）与上一次同一口径：
    // 切词只看中文二字组与英文词，` / ` 和空格对 `grams()` 是同一件事，但长度差两个字符
    // 足以让边界上的那一条进/出样本。
    const query = row.message.split(' / ').join(' ')
      .replace(/合并master|Merge branch|升级版本号/g, '').trim();
    if (query.length < 4) continue;
    const expected = row.files.filter((f) => SRC.test(f) && CODE_DIR.test(f));
    if (expected.length === 0) continue;
    // 标签只用于展示：旧版是合并标题去掉 `Merge … from ` 前缀，读口不给标题，改用分支名。
    out.push({
      label: row.branch ?? row.sha.slice(0, 8),
      query,
      expected: [...new Set(expected)].sort(),
      sha: row.sha,
      repo,
    });
  }
  return out;
}

/** 一条案例上四个「臂」的结果。`C'` 是同一实现 + A/B 那句检索式（只用来量检索式的贡献）。 */
type ArmKey = 'A' | 'B' | 'C' | "C'";
type ArmHit = { picked: Picked; rank: number; tier: 'none' | 'low' | 'hit'; hits: number };

function judge(picked: Picked, expected: string[]): ArmHit {
  const r = rank(picked, expected);
  const hits = picked.filter((p) => expected.some((w) => p === w || p.endsWith(`/${w}`))).length;
  return { picked, rank: r, tier: tier(picked, r), hits };
}

type CaseRow = {
  label: string;
  expected: number;
  weak: boolean;
  arms: Partial<Record<ArmKey, ArmHit>>;
  note: string;
  /** 标准答案在这棵树上还剩几个（`null` = 没做这道控制，例如 `--verify-only` 之外的老路径）。 */
  survival: Survival | null;
  /** 全部文件都不在了：本条不进任何分母。 */
  invalidated: boolean;
  /** 严格口径（任一文件缺失/被过滤）——只报告，不改分母。 */
  strictlyInvalid: boolean;
  answer: AnswerMerge | null;
  /** 档案字段（面一写进报告，面二只进 JSON）。 */
  extra?: Record<string, unknown>;
};

/**
 * 本次实际跑了哪些臂。
 *
 * A 每一条在两仓各做一遍 `lsTree` + 每个关键词一次 `grep`。2026-11-07 那次是 ssh 往返，
 * 一条 30 秒，513 条跑不完；搬到本机盘之后一条约 1 秒级，但「三臂同案」仍然只在 40 条上做
 * （与上一次同一个分母，不改），C 是纯函数、全量跑。
 */
function armSet(cOnly: boolean): ArmKey[] {
  return cOnly ? ['C', "C'"] : ['A', 'B', 'C', "C'"];
}

/**
 * C 的候选，带上「这个路径是被哪个仓的那次合并推上来的」。
 *
 * **只用于写 miss 的原因，不参与打分**：`locateFromHistory` 返回 `path` 没有仓，而两仓并集
 * 里同一个路径可能两边都有。诊断「错仓」需要这一格，而改 `history.ts` 去回一个 repo 字段
 * 是改生产实现（这一轮不许动），所以在评测里按同一份聚合重算一遍。
 *
 * 重算必须与实现逐条一致，否则诊断是假的——所以调用方要拿它的 `path` 与 `pathC()` 的结果
 * 对比（`attributeC` 的返回值里带 `sameAsImpl`），不一致就整列作废，不许「差不多」。
 */
function attributeC(
  rows: readonly HistoryRow[],
  query: string,
): { list: Array<{ path: string; repo: string; weight: number }>; sameAsImpl: boolean } {
  const ranked = rankMerges(rows, query, TOP_MERGES);
  const byFile = new Map<string, { path: string; repo: string; weight: number }>();
  for (const hit of ranked) {
    const weight = mergeWeight(hit.score, hit.row.files.length);
    for (const file of hit.row.files) {
      const seen = byFile.get(file);
      if (seen === undefined) byFile.set(file, { path: file, repo: hit.row.repo, weight });
      else if (weight > seen.weight) {
        seen.weight = weight;
        seen.repo = hit.row.repo;
      }
    }
  }
  const list = [...byFile.values()]
    .sort((a, b) => (a.weight !== b.weight
      ? b.weight - a.weight
      : (a.path === b.path ? 0 : (a.path < b.path ? -1 : 1))))
    .slice(0, CANDIDATE_LIMIT);
  const impl = pathC(rows, query);
  const sameAsImpl = list.length === impl.length && list.every((item, i) => item.path === impl[i]);
  return { list, sameAsImpl };
}

/** 一条案例的一句话结论（写进报告「逐案」那一节）：只在没命中时给出原因。 */
function noteOf(
  arms: Partial<Record<ArmKey, ArmHit>>,
  answer: AnswerMerge | null,
  survival: Survival | null,
  cRepo: { path: string; repo: string } | null,
  mergeCount: number,
): string {
  const parts: string[] = [];
  if (survival !== null && survival.kept.length === 0 && survival.total > 0) {
    parts.push(`标准答案的 ${survival.total} 个文件全部不在索引读的这棵树上了（已删或被索引排除），本条失效`);
  }
  const c = arms.C;
  if (c !== undefined && c.tier === 'hit' && c.rank > 1) {
    parts.push(answer === null
      ? `候选在 top-6 里，但只到第 ${c.rank} 名`
      : `候选在 top-6 里，但只到第 ${c.rank} 名：真答案那次合并动了 ${answer.files} 个文件，权重与并列项按路径升序，真答案被排到第 ${c.rank}`);
  }
  if (c !== undefined && c.tier === 'none') parts.push('一个候选都没交：历史里没有任何合并与这句查询有二字组重合');
  if (c !== undefined && c.tier === 'low') {
    if (answer === null) {
      parts.push(`有候选但一个都没中：库里那 ${mergeCount} 行不含标准答案文件（答案来自镜像 diff，不在 C 的语料里）`);
    } else if (answer.rank > TOP_MERGES) {
      parts.push(`有候选但一个都没中：真答案那次合并在 ${mergeCount} 行里排第 ${answer.rank}，没进前 ${TOP_MERGES}`);
    } else {
      parts.push(`有候选但一个都没中：真答案那次合并排第 ${answer.rank}（进了前 ${TOP_MERGES}），但它动了 ${answer.files} 个文件，权重并列按路径升序后被挤出前 ${CANDIDATE_LIMIT}`);
    }
  }
  // 错仓：第一名来自另一个仓，而真答案在 answer.repo。
  if (cRepo !== null && answer !== null && cRepo.repo !== answer.repo && (c?.tier !== 'hit' || (c?.rank ?? 0) > 1)) {
    parts.push(`第一候选来自 ${cRepo.repo}（真答案在 ${answer.repo}）——这是跨仓并集的取舍得失，不是「没找到」`);
  }
  return parts.join('；');
}

function summarize(title: string, rows: CaseRow[], arms: ArmKey[]): Record<string, unknown> {
  const out: Record<string, unknown> = { surface: title, cases: rows.length };
  const table: Record<string, unknown> = {};
  for (const arm of arms) {
    const list = rows.map((r) => r.arms[arm]).filter((x): x is ArmHit => x !== undefined);
    const r1 = list.filter((x) => x.rank === 1).length;
    const r3 = list.filter((x) => x.rank > 0 && x.rank <= 3).length;
    const hit = list.filter((x) => x.tier === 'hit').length;
    const low = list.filter((x) => x.tier === 'low').length;
    const none = list.filter((x) => x.tier === 'none').length;
    const noise = list.reduce((acc, x) => acc + (x.picked.length - x.hits), 0);
    table[arm] = { rank1: r1, rank3: r3, hit, low, none, noise };
  }
  out.table = table;
  return out;
}

function printSummary(title: string, rows: CaseRow[], arms: ArmKey[]): void {
  const total = rows.length;
  console.log(`\n── ${title}（${total} 条）─────────────────────────────`);
  for (const arm of arms) {
    const list = rows.map((r) => r.arms[arm]).filter((x): x is ArmHit => x !== undefined);
    const r1 = list.filter((x) => x.rank === 1).length;
    const r3 = list.filter((x) => x.rank > 0 && x.rank <= 3).length;
    const hit = list.filter((x) => x.tier === 'hit').length;
    const low = list.filter((x) => x.tier === 'low').length;
    const none = list.filter((x) => x.tier === 'none').length;
    const noise = list.reduce((acc, x) => acc + (x.picked.length - x.hits), 0);
    console.log(
      `${arm.padEnd(3)} 第1名 ${String(r1).padStart(3)}/${total}  前3名 ${String(r3).padStart(3)}/${total}`
      + `  命中(前${CANDIDATE_LIMIT}) ${String(hit).padStart(3)}/${total}`
      + `  噪音 ${String(noise).padStart(4)} 文件  三档 hit ${String(hit).padStart(3)} / low ${String(low).padStart(3)} / none ${String(none).padStart(3)}`,
    );
  }
}

/**
 * 2026-11-07 那份报告 §2 / §1 抄下来的旧数字，**只用于打印「旧 → 新」对照**。
 *
 * 抄进来的理由：旧的那一次是 ssh 时代跑出来的，今天不可能重跑（镜像与库都搬过），而
 * 「旧 vs 新」正是这一轮要回答的东西。数字既然是抄的，就要在同一处标明它是抄的——
 * `files` 是当时的答案文件数，`answerRank`/`answerFiles` 是当时那次合并的名次与宽度。
 */
type LegacyCase = { files: number; A: number; B: number; C: number; c2: number; answerRank: number | null; answerFiles: number | null };

const LEGACY_FACE_ONE: Readonly<Record<number, LegacyCase>> = {
  776: { files: 8, A: 4, B: 0, C: 1, c2: 0, answerRank: 1, answerFiles: 11 },
  782: { files: 2, A: 0, B: 0, C: 0, c2: 0, answerRank: 1, answerFiles: 10 },
  775: { files: 2, A: 0, B: 0, C: 1, c2: 1, answerRank: 1, answerFiles: 11 },
  758: { files: 27, A: 0, B: 0, C: 1, c2: 1, answerRank: 1, answerFiles: 1 },
  788: { files: 27, A: 0, B: 0, C: 1, c2: 1, answerRank: 1, answerFiles: 1 },
  797: { files: 7, A: 0, B: 0, C: 6, c2: 6, answerRank: 1, answerFiles: 82 },
  795: { files: 1, A: 0, B: 0, C: 1, c2: 1, answerRank: 2, answerFiles: 7 },
};

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return null;
  return process.argv[idx + 1] ?? null;
}

async function main(): Promise<void> {
  const onlyRaw = argValue('--only');
  const only = onlyRaw === null ? null : Number(onlyRaw);
  const surface = argValue('--surface') ?? 'both';
  const cases = only === null ? CASES : CASES.filter((c) => c.legacyNumber === only);
  const cOnly = process.argv.includes('--c-only');
  const verifyOnly = process.argv.includes('--verify-only');
  const asof = argValue('--asof');
  const attribute = process.argv.includes('--attribute') || surface === '1';
  const armsToRun = verifyOnly ? [] : armSet(cOnly);

  /** `--asof` 的边界：把这一刻之后的合并剔掉（复现更早那一次的语料）。 */
  const asofMs = asof === null ? null : Date.parse(asof);
  if (asof !== null && Number.isNaN(asofMs)) throw new Error(`--asof 不是合法时间：「${asof}」`);

  const [uniRaw, pcRaw, reqs] = await Promise.all([
    mergesOf('123pan-uni-app'),
    mergesOf('123pan-pc'),
    requirementsByTitle(),
  ]);
  const cut = (list: Merged[]): Merged[] => (asofMs === null ? list : list.filter((m) => Date.parse(m.at) <= asofMs));
  const uni = cut(uniRaw);
  const pc = cut(pcRaw);
  const all = [...uni, ...pc];

  // C 的语料：库里那 671 行。两个仓并在一起（A/B 的口径也是两个仓），
  // 但报告里会写清「生产上 inspect 是按**单仓**检索的」这层差别。
  const historyAll: HistoryRow[] = [...(await readHistory(db, '123pan-pc')), ...(await readHistory(db, '123pan-uni-app'))];
  const history = asofMs === null
    ? historyAll
    : historyAll.filter((row) => Date.parse(row.mergedAt) <= asofMs);

  const trees = new Map<string, { sha: string | null; files: Set<string> }>();
  const present = new Set<string>();
  for (const repo of REPOS) {
    const tree = await treeAt(repo);
    trees.set(repo, tree);
    for (const path of tree.files) present.add(path);
  }

  console.log(`镜像合并：uni-app ${uni.length} 条 / pc ${pc.length} 条 · 需求库 ${reqs.size} 个标题`);
  console.log(`commit_history（C 的语料）：${history.length} 行${asofMs === null ? '' : `（--asof ${asof}，全量 ${historyAll.length}）`}`);
  console.log(`索引读的树：${[...trees.entries()].map(([repo, t]) => `${repo}@${(t.sha ?? '未知').slice(0, 8)}（${t.files.size} 文件）`).join(' · ')}`);
  console.log(`评测 ${cases.length} 条\n`);

  const report: Record<string, unknown> = {
    at: new Date().toISOString(),
    asof,
    historyRows: history.length,
    historyRowsAll: historyAll.length,
    merges: { uni: uni.length, pc: pc.length },
    trees: [...trees.entries()].map(([repo, t]) => ({ repo, sha: t.sha, files: t.files.size })),
    surfaces: [],
  };

  // ── 面一：人工配对的 7 条 ──
  const oneRows: CaseRow[] = [];
  if (surface !== '2') {
    for (const c of cases) {
      const req = reqs.get(c.title);
      if (req === undefined) {
        console.log(`  ⚠ 跳过 ${c.title}（库里没有这个标题，旧号 #${c.legacyNumber}）`);
        continue;
      }
      const expected = expectedOf(all, c.branch);
      if (expected.length === 0) {
        console.log(`  ⚠ 跳过 ${c.title}（分支片段「${c.branch}」在镜像里没有对应合并）`);
        continue;
      }
      const survival = survivalOf(expected, present);
      const { invalidated, strictlyInvalid } = invalidation(survival);
      const longQuery = longQueryOf(req);
      const shortQuery = locateQuery(req.title);
      const arms: Partial<Record<ArmKey, ArmHit>> = {};
      if (!verifyOnly) {
        arms.C = judge(pathC(history, shortQuery), expected);
        arms["C'"] = judge(pathC(history, longQuery), expected);
        if (!cOnly) {
          arms.A = judge(await pathA(longQuery, req.title), expected);
          arms.B = judge(await pathB(longQuery, req.title), expected);
        }
      }
      const answer = answerMerge(history, shortQuery, expected);
      const attr = attribute ? attributeC(history, shortQuery) : null;
      const weak = expected.length > WEAK_ANSWER_FILES;
      const note = noteOf(arms, answer, survival, attr?.list[0] ?? null, history.length);
      const legacy = LEGACY_FACE_ONE[c.legacyNumber] ?? null;
      oneRows.push({
        label: `#${req.number} ${req.title}`,
        expected: expected.length,
        weak,
        arms,
        note,
        survival,
        invalidated,
        strictlyInvalid,
        answer,
        extra: { legacyNumber: c.legacyNumber, number: req.number, branch: c.branch, query: shortQuery, longQuery, sameAsImpl: attr?.sameAsImpl ?? null, cRepos: attr?.list ?? null, pickedC: arms.C?.picked ?? [] },
      });

      const show = (r: number | undefined): string => (r === undefined ? '—' : r === 0 ? '未命中' : `第 ${r} 名`);
      console.log(`#${req.number} ${req.title}${weak ? '  ⚠ 弱标准答案' : ''}`
        + `${c.legacyNumber === req.number ? '' : `（旧号 #${c.legacyNumber}）`}${invalidated ? '  ✗ 本条失效' : ''}`);
      console.log(`  标准答案 ${expected.length} 个文件（${reposOf(all, c.branch).join('+')}）`
        + `${legacy === null ? '' : ` · 旧答案 ${legacy.files} 个`} · 还在 ${survival.kept.length} / 已删 ${survival.gone.length} / 被索引排除 ${survival.filtered.length}`);
      console.log(`  本次 ${armsToRun.length === 0 ? '（--verify-only，未跑臂）' : armsToRun.map((k) => `${k} ${show(arms[k]?.rank)}`).join(' · ')}`);
      if (legacy !== null && !verifyOnly) {
        console.log(`  旧值 A ${legacy.A === 0 ? '未命中' : `第 ${legacy.A} 名`} · B ${legacy.B === 0 ? '未命中' : `第 ${legacy.B} 名`} · C ${show(legacy.C)} · C′ ${show(legacy.c2)}`);
      }
      if (answer !== null) console.log(`  真答案合并：${history.length} 条里第 ${answer.rank}（动了 ${answer.files} 个文件，在 ${answer.repo}）`);
      if (process.argv.includes('--verbose')) {
        console.log(`  检索式 C   ${shortQuery}`);
        console.log(`  关键词 A   ${frozenKeywords(longQuery, req.title).join(' / ')}（冻结词表）`);
        console.log(`  标准答案   ${expected.slice(0, 4).join(' , ')}${expected.length > 4 ? ' …' : ''}`);
        if (survival.gone.length > 0) console.log(`  已删文件   ${survival.gone.slice(0, 6).join(' , ')}${survival.gone.length > 6 ? ' …' : ''}`);
        console.log(`  A 挑了     ${arms.A?.picked.slice(0, 4).join(' , ') || '（本批未跑）'}`);
        console.log(`  B 挑了     ${arms.B?.picked.slice(0, 4).join(' , ') || '（本批未跑）'}`);
        console.log(`  C 挑了     ${arms.C?.picked.slice(0, 4).join(' , ') || '（空）'}`);
        if (attr !== null) console.log(`  C 候选来自 ${attr.list.slice(0, 4).map((x) => `${x.path}（${x.repo}）`).join(' , ') || '（空）'}${attr.sameAsImpl ? '' : '  ⚠ 重算与实现不一致，仓归属作废'}`);
      }
      if (note !== '') console.log(`  备注       ${note}`);
    }

    const validRows = oneRows.filter((r) => !r.invalidated);
    printSummary('面一：人工配对的真实需求（说了算）· 排除失效案例', validRows, armsToRun);
    if (validRows.length !== oneRows.length) {
      printSummary('面一 · 含失效案例（对照用，不进头条）', oneRows, armsToRun);
    }
    // 头条两个口径：含弱标准答案 / 排除弱标准答案。
    const strong = validRows.filter((r) => !r.weak);
    if (strong.length !== validRows.length) {
      console.log(`\n  （同上，排除 ${validRows.length - strong.length} 条弱标准答案）`);
      printSummary('面一 · 排除弱标准答案', strong, armsToRun);
    }
    (report.surfaces as unknown[]).push({
      ...summarize('面一：人工配对的真实需求', validRows, armsToRun),
      casesAll: oneRows.length,
      invalidated: oneRows.filter((r) => r.invalidated).length,
      strictlyInvalid: oneRows.filter((r) => r.strictlyInvalid).length,
      strong: summarize('面一 · 排除弱标准答案', strong, armsToRun),
      detail: oneRows.map((r) => ({
        label: r.label,
        expected: r.expected,
        weak: r.weak,
        invalidated: r.invalidated,
        strictlyInvalid: r.strictlyInvalid,
        survival: r.survival,
        answer: r.answer,
        arms: Object.fromEntries(Object.entries(r.arms)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, { rank: v!.rank, tier: v!.tier, picked: v!.picked }])),
        note: r.note,
        ...r.extra,
      })),
    });
  }

  // ── 面二：提交信息当查询词 ──
  if (surface !== '1') {
    const capIdx = process.argv.indexOf('--commits');
    const cap = capIdx >= 0 ? Number(process.argv[capIdx + 1]) : 0;
    const allCommits = [...(await commitCases('123pan-pc', asofMs)), ...(await commitCases('123pan-uni-app', asofMs))];
    const commits = cap > 0 ? allCommits.slice(0, cap) : allCommits;
    console.log(`\n── 面二取 ${commits.length}/${allCommits.length} 条 ──`);
    const twoRows: CaseRow[] = [];
    let i = 0;
    for (const c of commits) {
      i += 1;
      const survival = survivalOf(c.expected, present);
      const { invalidated, strictlyInvalid } = invalidation(survival);
      const arms: Partial<Record<ArmKey, ArmHit>> = {};
      if (!verifyOnly) {
        arms.C = judge(pathC(history, c.query), c.expected);
        arms["C'"] = judge(pathC(history, c.query), c.expected);
        if (!cOnly) {
          arms.A = judge(await pathA(c.query, c.query), c.expected);
          arms.B = judge(await pathB(c.query, c.query), c.expected);
        }
      }
      const weak = c.expected.length > WEAK_ANSWER_FILES;
      const answer = verifyOnly ? null : answerMerge(history, c.query, c.expected);
      const attr = attribute && !verifyOnly ? attributeC(history, c.query) : null;
      twoRows.push({
        label: c.label,
        expected: c.expected.length,
        weak,
        arms,
        note: noteOf(arms, answer, survival, attr?.list[0] ?? null, history.length),
        survival,
        invalidated,
        strictlyInvalid,
        answer,
        extra: { sha: c.sha, repo: c.repo, query: c.query },
      });
      if (i % 10 === 0) console.log(`  …${i}/${commits.length}`);
      if (process.argv.includes('--verbose')) {
        console.log(`\n  ${armsToRun.map((k) => `${k} ${arms[k]?.rank ?? 0}`).join(' · ')}  查询：${c.query.slice(0, 40)}`);
        console.log(`     答案 ${c.expected.length} 个：${c.expected.slice(0, 3).join(' , ')}`);
        console.log(`     C  ${arms.C?.picked.slice(0, 3).join(' , ') || '（空）'}`);
      }
    }
    const validRows = twoRows.filter((r) => !r.invalidated);
    printSummary('面二：提交信息当查询（有泄漏，只看崩塌）· 排除失效案例', validRows, armsToRun);
    if (validRows.length !== twoRows.length) {
      printSummary('面二 · 含失效案例（对照用）', twoRows, armsToRun);
    }
    const strong = validRows.filter((r) => !r.weak);
    if (strong.length !== validRows.length) {
      console.log(`\n  （同上，排除 ${validRows.length - strong.length} 条弱标准答案）`);
      printSummary('面二 · 排除弱标准答案', strong, armsToRun);
    }
    (report.surfaces as unknown[]).push({
      ...summarize('面二：提交信息当查询', validRows, armsToRun),
      sampled: twoRows.length,
      available: allCommits.length,
      invalidated: twoRows.filter((r) => r.invalidated).length,
      strictlyInvalid: twoRows.filter((r) => r.strictlyInvalid).length,
      strong: summarize('面二 · 排除弱标准答案', strong, armsToRun),
      detail: twoRows.map((r) => ({
        label: r.label,
        ...r.extra,
        expected: r.expected,
        invalidated: r.invalidated,
        strictlyInvalid: r.strictlyInvalid,
        arms: Object.fromEntries(Object.entries(r.arms)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, { rank: v!.rank, tier: v!.tier }])),
        note: r.note,
      })),
    });
  }

  const jsonIdx = process.argv.indexOf('--json');
  if (jsonIdx >= 0) {
    const target = process.argv[jsonIdx + 1] ?? '/tmp/bench-locate.json';
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\n机器可读结果：${target}`);
  }
}

await main();
await pool.end();
