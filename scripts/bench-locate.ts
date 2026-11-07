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
 *   npx tsx scripts/bench-locate.ts --only 776         # 面一只跑一条
 *   npx tsx scripts/bench-locate.ts --commits 60       # 面二只跑前 60 条
 *   npx tsx scripts/bench-locate.ts --surface 1        # 只跑面一（面二的 A/B 很慢）
 *   npx tsx scripts/bench-locate.ts --surface 2 --c-only  # 面二只跑 C/C'（513 条约 40 秒）
 *   npx tsx scripts/bench-locate.ts --json /tmp/x.json # 另存一份机器可读结果
 *
 * `--c-only` 是报告 §0.4 那条复现命令的一部分（A 每条约 30 秒，513 条跑不完，见
 * `armSet`）。用法块早先漏了它，照着报告复现的人会以为只能整面跑。
 */
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

import { head, lsTree, grep } from '../src/core/codemirror/mirror.js';
import { locateAcross } from '../src/core/codemirror/code-index.js';
import { repoIndex } from '../src/core/codemirror/index-store.js';
import { keywordsFrom, locateQuery } from '../src/core/uemaster/inspect.js';
import { locateFromHistory, rankMerges } from '../src/core/locate/history.js';
import { readHistory, type HistoryRow } from '../src/core/locate/history-store.js';
import { db, pool } from '../src/db/client.js';

const run = promisify(execFile);

const REPOS = ['123pan-pc', '123pan-uni-app'] as const;

/**
 * 人工核对过的配对：需求号 ↔ 分支名片段。
 *
 * 每条右边那句是本人才看过的理由——不写理由的配对不许进这张表，否则以后没人敢信评测结果。
 */
const CASES: ReadonlyArray<{ number: number; branch: string; why: string }> = [
  { number: 776, branch: 'download-limit', why: '标题「上传下载按量限速风控」= 分支 feat-download-limit' },
  { number: 782, branch: 'userEquity', why: '「权益套餐产品结构改造」= feat-userEquity' },
  { number: 775, branch: 'userEquity', why: '「用户部分权益缩减调整」= feat-userEquity' },
  { number: 758, branch: 'professional-space', why: '「专业空间」= release-professional-space' },
  { number: 788, branch: 'professional-space', why: '「商用空间：容量售卖与个人盘风控」= professional-space' },
  { number: 797, branch: 'direct-link', why: '「分享创建页改版-直链分享」= feat-direct-link-renovation' },
  { number: 795, branch: 'directLink-open', why: '「PC 端支持打开分享页」= feat-directLink-open' },
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

type Merged = { repo: string; branch: string; date: string; files: string[] };

/** 从镜像里读合并记录：分支名 + 日期 + 这次合并带进来的源码文件。 */
async function mergesOf(repo: string): Promise<Merged[]> {
  const script = `cd /srv/123pan-mirror/${repo}.git && git rev-list --merges HEAD | while read m; do `
    + `s=$(git log -1 --format="%s" $m); d=$(git log -1 --format="%ad" --date=short $m); `
    + `b=$(echo "$s" | sed -n "s/.*from \\([^ ]*\\).*/\\1/p"); `
    + `f=$(git diff --name-only $m^1 $m 2>/dev/null | grep -E "\\.(tsx?|jsx?|vue)$" | tr "\\n" " "); `
    + `echo "$b|$d|$f"; done`;
  const { stdout } = await run('ssh', ['dogyun', script], { maxBuffer: 16 * 1024 * 1024, timeout: 180_000 });
  const out: Merged[] = [];
  for (const line of stdout.split('\n')) {
    const [branch, date, files] = line.split('|');
    if (branch === undefined || branch === '') continue;
    out.push({ repo, branch, date: date ?? '', files: (files ?? '').split(/\s+/).filter((f) => f !== '') });
  }
  return out;
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
): { rank: number; files: number; score: number } | null {
  const ranked = rankMerges(rows, query, rows.length);
  for (let i = 0; i < ranked.length; i += 1) {
    const entry = ranked[i];
    if (entry === undefined) continue;
    const hit = entry.row.files.some((f) => expected.some((w) => f === w || f.endsWith(`/${w}`)));
    if (hit) return { rank: i + 1, files: entry.row.files.length, score: entry.score };
  }
  return null;
}

async function requirementsByNumber(): Promise<Map<number, { title: string; description: string }>> {
  const script = 'docker exec flower-postgres-1 psql -U flower_admin -d flower -tAc "'
    + "select json_agg(t) from (select number, title, coalesce(description,'') as description "
    + "from requirements where deleted_at is null) t;\"";
  const { stdout } = await run('ssh', ['dogyun', script], { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
  const rows = JSON.parse(stdout.trim()) as Array<{ number: number; title: string; description: string }>;
  return new Map(rows.map((r) => [Number(r.number), { title: r.title, description: r.description }]));
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
async function commitCases(repo: string): Promise<Array<{ label: string; query: string; expected: string[] }>> {
  const script = `cd /srv/123pan-mirror/${repo}.git && git rev-list --merges HEAD | while read m; do `
    + `subj=$(git log -1 --format=%s $m); `
    + `msgs=$(git log --no-merges --format=%s $m^1..$m 2>/dev/null | tr '\n' ' '); `
    + `f=$(git diff --name-only $m^1 $m 2>/dev/null | grep -E "\\.(tsx?|jsx?|vue)$" | tr "\\n" " "); `
    + `echo "$subj<<>>$msgs<<>>$f"; done`;
  const { stdout } = await run('ssh', ['dogyun', script], { maxBuffer: 16 * 1024 * 1024, timeout: 180_000 });
  const out: Array<{ label: string; query: string; expected: string[] }> = [];
  for (const line of stdout.split('\n')) {
    const [subj, msgs, files] = line.split('<<>>');
    if (subj === undefined) continue;
    // 查询词：分支自己的提交信息（去掉合并提交本身）。空的、纯「合并master」的跳过。
    const query = (msgs ?? '').replace(/合并master|Merge branch|升级版本号/g, '').trim();
    if (query.length < 4) continue;
    const expected = (files ?? '').split(/\s+/).filter((f) => f !== '' && SRC.test(f) && CODE_DIR.test(f));
    if (expected.length === 0) continue;
    out.push({ label: subj.replace(/^Merge \S+ into \S+ from /, ''), query, expected: [...new Set(expected)].sort() });
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
};

/**
 * 本次实际跑了哪些臂。
 *
 * A 每一条要 30 秒左右（每条查询都要在两仓各做一遍 `lsTree` + 每个关键词一次 `grep`，
 * 全是 ssh 往返），513 条目二意味着四小时以上。所以 `--c-only` 让 C/C' 单跑全量，
 * 而「三臂对照」只在能跑完的那批上做——**同批、同案**，绝不把两个分母混成一个百分比。
 */
function armSet(cOnly: boolean): ArmKey[] {
  return cOnly ? ['C', "C'"] : ['A', 'B', 'C', "C'"];
}

/** 一条案例的一句话结论（写进报告「逐案」那一节）：只在没命中时给出原因。 */
function noteOf(arms: Partial<Record<ArmKey, ArmHit>>, answer: { rank: number; files: number } | null): string {
  const parts: string[] = [];
  const c = arms.C;
  if (c !== undefined && c.tier === 'hit' && c.rank > 1) {
    const files = answer === null ? null : answer.files;
    parts.push(files === null
      ? `C 命中但只到第 ${c.rank} 名`
      : `C 命中第 ${c.rank} 名：真答案那次合并一次动了 ${files} 个文件，权重并列时按路径升序，真答案被挤到第 ${c.rank}`);
  }
  if (c !== undefined && c.tier === 'none') parts.push('C 落 none：历史里没有任何合并与这句查询有二字组重合');
  if (c !== undefined && c.tier === 'low') {
    if (answer === null) parts.push('C 有候选但落 low：历史里没有任何合并含标准答案文件（这条答案来自镜像 diff，库里那 657 行不含它）');
    else if (answer.rank <= 5) parts.push(`C 有候选但落 low：答案合并排第 ${answer.rank}，但它动了 ${answer.files} 个文件，权重并列按路径升序后真答案被挤出前 6`);
    else parts.push(`C 有候选但落 low：答案合并排第 ${answer.rank}（共 657 条），没进前 5`);
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
      + `  噪音 ${String(noise).padStart(4)} 文件  三档 hit ${String(hit).padStart(3)} / low ${String(low).padStart(3)} / none ${String(none).padStart(3)}`,
    );
  }
}

async function main(): Promise<void> {
  const onlyIdx = process.argv.indexOf('--only');
  const only = onlyIdx >= 0 ? Number(process.argv[onlyIdx + 1]) : null;
  const surfaceIdx = process.argv.indexOf('--surface');
  const surface = surfaceIdx >= 0 ? String(process.argv[surfaceIdx + 1]) : 'both';
  const cases = only === null ? CASES : CASES.filter((c) => c.number === only);
  const cOnly = process.argv.includes('--c-only');
  const armsToRun = armSet(cOnly);

  const [uni, pc, reqs] = await Promise.all([
    mergesOf('123pan-uni-app'),
    mergesOf('123pan-pc'),
    requirementsByNumber(),
  ]);
  const all = [...uni, ...pc];

  // C 的语料：库里那 657 行。两个仓并在一起（A/B 的口径也是两个仓），
  // 但报告里会写清「生产上 inspect 是按**单仓**检索的」这层差别。
  const history: HistoryRow[] = [...(await readHistory(db, '123pan-pc')), ...(await readHistory(db, '123pan-uni-app'))];

  console.log(`镜像合并：uni-app ${uni.length} 条 / pc ${pc.length} 条 · 需求库 ${reqs.size} 条`);
  console.log(`commit_history（C 的语料）：${history.length} 行`);
  console.log(`评测 ${cases.length} 条\n`);

  const report: Record<string, unknown> = { historyRows: history.length, surfaces: [] };

  // ── 面一：人工配对的 7 条 ──
  const oneRows: CaseRow[] = [];
  if (surface !== '2') {
    for (const c of cases) {
      const req = reqs.get(c.number);
      const expected = expectedOf(all, c.branch);
      if (req === undefined || expected.length === 0) {
        console.log(`  跳过 ${c.number}（缺需求或缺标准答案）`);
        continue;
      }
      const longQuery = `${req.title}\n\n${req.description}`.trim();
      const shortQuery = locateQuery(req.title);
      const arms: Partial<Record<ArmKey, ArmHit>> = {
        C: judge(pathC(history, shortQuery), expected),
        "C'": judge(pathC(history, longQuery), expected),
      };
      if (!cOnly) {
        arms.A = judge(await pathA(longQuery, req.title), expected);
        arms.B = judge(await pathB(longQuery, req.title), expected);
      }
      const answer = answerMerge(history, shortQuery, expected);
      const weak = expected.length > WEAK_ANSWER_FILES;
      const note = noteOf(arms, answer);
      oneRows.push({ label: `#${c.number} ${req.title}`, expected: expected.length, weak, arms, note });

      const show = (r: number): string => (r === 0 ? '未命中' : `第 ${r} 名`);
      console.log(`#${c.number} ${req.title}${weak ? '  ⚠ 弱标准答案' : ''}`);
      console.log(`  标准答案 ${expected.length} 个文件（${reposOf(all, c.branch).join('+')}）· `
        + armsToRun.map((k) => `${k} ${show(arms[k]?.rank ?? 0)}`).join(' · '));
      if (answer !== null) console.log(`  真答案合并：657 条里第 ${answer.rank}（动了 ${answer.files} 个文件）`);
      if (process.argv.includes('--verbose')) {
        console.log(`  检索式 C   ${shortQuery}`);
        console.log(`  关键词 A   ${frozenKeywords(longQuery, req.title).join(' / ')}（冻结词表）`);
        console.log(`  标准答案   ${expected.slice(0, 4).join(' , ')}${expected.length > 4 ? ' …' : ''}`);
        console.log(`  A 挑了     ${arms.A?.picked.slice(0, 4).join(' , ') || '（本批未跑）'}`);
        console.log(`  B 挑了     ${arms.B?.picked.slice(0, 4).join(' , ') || '（本批未跑）'}`);
        console.log(`  C 挑了     ${arms.C?.picked.slice(0, 4).join(' , ') || '（空）'}`);
      }
      if (note !== '') console.log(`  备注       ${note}`);
    }

    printSummary('面一：人工配对的真实需求（说了算）', oneRows, armsToRun);
    // 头条两个口径：含弱标准答案 / 排除弱标准答案。
    const strong = oneRows.filter((r) => !r.weak);
    if (strong.length !== oneRows.length) {
      console.log(`\n  （同上，排除 ${oneRows.length - strong.length} 条弱标准答案）`);
      printSummary('面一 · 排除弱标准答案', strong, armsToRun);
    }
    (report.surfaces as unknown[]).push({
      ...summarize('面一：人工配对的真实需求', oneRows, armsToRun),
      strong: summarize('面一 · 排除弱标准答案', strong, armsToRun),
      detail: oneRows.map((r) => ({
        label: r.label,
        expected: r.expected,
        weak: r.weak,
        arms: Object.fromEntries(Object.entries(r.arms)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, { rank: v!.rank, tier: v!.tier, picked: v!.picked }])),
        note: r.note,
      })),
    });
  }

  // ── 面二：提交信息当查询词 ──
  if (surface !== '1') {
    const capIdx = process.argv.indexOf('--commits');
    const cap = capIdx >= 0 ? Number(process.argv[capIdx + 1]) : 0;
    const allCommits = [...(await commitCases('123pan-pc')), ...(await commitCases('123pan-uni-app'))];
    const commits = cap > 0 ? allCommits.slice(0, cap) : allCommits;
    console.log(`\n── 面二取 ${commits.length}/${allCommits.length} 条 ──`);
    const twoRows: CaseRow[] = [];
    let i = 0;
    for (const c of commits) {
      i += 1;
      const arms: Partial<Record<ArmKey, ArmHit>> = {
        C: judge(pathC(history, c.query), c.expected),
        "C'": judge(pathC(history, c.query), c.expected),
      };
      if (!cOnly) {
        arms.A = judge(await pathA(c.query, c.query), c.expected);
        arms.B = judge(await pathB(c.query, c.query), c.expected);
      }
      const weak = c.expected.length > WEAK_ANSWER_FILES;
      const answer = answerMerge(history, c.query, c.expected);
      twoRows.push({ label: c.label, expected: c.expected.length, weak, arms, note: noteOf(arms, answer) });
      if (i % 10 === 0) console.log(`  …${i}/${commits.length}`);
      if (process.argv.includes('--verbose')) {
        console.log(`\n  ${armsToRun.map((k) => `${k} ${arms[k]?.rank ?? 0}`).join(' · ')}  查询：${c.query.slice(0, 40)}`);
        console.log(`     答案 ${c.expected.length} 个：${c.expected.slice(0, 3).join(' , ')}`);
        console.log(`     C  ${arms.C?.picked.slice(0, 3).join(' , ') || '（空）'}`);
      }
    }
    printSummary('面二：提交信息当查询（有泄漏，只看崩塌）', twoRows, armsToRun);
    const strong = twoRows.filter((r) => !r.weak);
    if (strong.length !== twoRows.length) {
      console.log(`\n  （同上，排除 ${twoRows.length - strong.length} 条弱标准答案）`);
      printSummary('面二 · 排除弱标准答案', strong, armsToRun);
    }
    (report.surfaces as unknown[]).push({
      ...summarize('面二：提交信息当查询', twoRows, armsToRun),
      sampled: twoRows.length,
      available: allCommits.length,
      strong: summarize('面二 · 排除弱标准答案', strong, armsToRun),
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
