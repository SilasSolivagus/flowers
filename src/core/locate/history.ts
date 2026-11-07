import type { HistoryRow } from './history-store.js';
import type { Candidate, LocateResult } from './types.js';

/**
 * 用「需求标题」去历史合并里找最像的那几次，再把这些合并的文件聚合成候选。
 *
 * 为什么要单独一层、而且**一个中文字都不许翻成英文标识符**：这条链的输入是 PM 写的
 * 中文需求标题，落点却是 `src/pages/video/video.vue` 这种路径。中间任何一步「先把中文
 * 翻译成 video / equity / download」都会把判断押在翻译上——翻错一次，后面再准也没有意义，
 * 而且错得看不出来（候选照样有，只是全错）。所以这里的相似度直接在中文上算：
 * 两边都是中文，比的是「字面的词组有没有重合」，不需要谁先变成另一种语言。
 *
 * 打分形状（照 spec §5，加上「先剔掉发版/同步类合并」这一道）：
 * 0. **先剔掉「杂活合并」**（`isFeatureMerge`）：升级版本号、热备域名更换、嵌套 web
 *    同步、Revert/回滚这类合并**整条不参与打分**——它们没有「功能落在哪儿」可言，
 *    放进打分只能把真正的实现压下去（理由见 `isFeatureMerge`）；
 * 1. 切块：中文连续段切**二字组**，英文词小写；
 * 2. IDF：`log(1 + N / df)`，`N` = **传进来的这批**行数，`df` = 含该词的合并数。
 *    不读全局、不读库：同一份历史今天和明天给出同一个排名，否则没人敢拿它当线索；
 * 3. 相似度 = 命中的查询词 IDF 之和 ÷ 查询词 IDF 之和（0..1）；
 * 4. 取分数 > 0 的前 `TOP_MERGES` 次合并；
 * 5. 文件聚合：每条合并的相似度先按**合并宽度**打折（`mergeWeight`），同一个文件的
 *    得分取「碰过它的那些合并里最高的那个权重」；排序按 权重降序 → count 降序 → 路径
 *    升序（全序，两次运行必须一样）。`count` 只当同级兜底，不再主导排序——理由见
 *    `mergeWeight` 与 `compareFiles`；
 * 6. `reason` 写成 `出自 MM-DD「那次合并的第一句」`；
 * 7. 没有任何命中 / 查询切不出词 → `{ kind: 'none' }`，**绝不**回一个空 `candidates`
 *    （`copy.ts` 的 `CANDIDATES_LINE` 对空数组直接抛，那是刻意的）。
 *
 * 纯函数：不读库、不看时钟、不碰文件系统。代价是调用方要把 rows 传进来；换来的是
 * 「同一输入 → 同一输出」可以被测试钉死。
 */

/**
 * 只取**汉字**，不含中文标点。
 *
 * 这个区别是有用的：`「。！」` 全是标点，切出来零个词，结果必须是 `none`；若把标点也算
 * 进「中文」，它会切出 `。！` 这种谁都不存在的二字组，然后被当成「有词但没匹配上」——
 * 两种情形在结果上是同一句话，却是两种完全不同的原因，不该糊在一起。
 *
 * 区间取基本区 + 扩展 A：仓库里的提交信息是简体中文产品文案，这两段够；扩展 B 及以后
 * 是代理对（一个字占两个 UTF-16 码元），用 `slice` 切会切出半个字，不如不收。
 */
const CJK_RUNS = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;

/**
 * 英文词：首字符必须是字母，总长 >= 3。
 *
 * 为什么不用 `\b\w+\b`：那会把 `v2`、`a` 这种短词也收进来，而中文提交信息里夹杂的
 * `v2`、`a` 几乎不带信息，反倒让每条合并都跟查询「有点像」。`[a-z][a-z0-9_-]{2,}` 正好
 * 滤掉它们，又能收住 `userequity`、`proxy-webview`、`uniapp` 这类真标识符。
 */
const ASCII_WORDS = /[a-z][a-z0-9_-]{2,}/g;

/**
 * 参与聚合的合并数（前 N 名）。
 *
 * 5 不是「大概差不多」，是这一版刻意的取舍：中文大改动的提交信息里常常只重合两三个
 * 二字组，前几名往后分数掉得很快，取到第 6 名之后基本是在拿噪音做投票。留成常量是因为
 * 它一定会被调（真数据两条例子里有一条排在 45/657），调的时候应当只有这一处要改。
 */
export const TOP_MERGES = 5;

/**
 * 一次最多回几条候选。
 *
 * 6 的理由：材料里这是一份**编号清单**，给人读的；到第 7 条开始 PM 就不再逐条看了，
 * 而这份清单的价值恰恰在于「他真的去看了」。下限要够装下前几名合并的文件（第一名常常
 * 就带 3~5 个文件），所以不能取 3。想多看几处时传 `{ limit }`，别改默认值。
 */
export const CANDIDATE_LIMIT = 6;

/**
 * `reason` 里那次合并的标题最多留几个字。
 *
 * 40 字是「一屏一行还能读完」的量级；超出的截断（带省略号），因为 `reason` 后面还跟着
 * 路径，长标题会把路径挤出视野。截断只影响展示：打分用的是整段 message。
 */
const MERGE_LABEL_MAX = 40;

/**
 * 中文切块 + 英文小写，返回**去重**后的词集合。
 *
 * 中文走二字组而不是分词，理由有三条：
 * - 没有词典也能跑。这个仓库不带中文分词依赖（约束里也写了不加依赖），而按词典分词
 *   一旦遇到产品黑话（「权益套餐」「按量限速」）就会切错，且错得很隐蔽；
 * - 二字组对「用户部分权益缩减调整」这种叠词句最稳：`权益`、`缩减` 一定在，`户部`、
 *   `分权` 这种跨词边界的组也在，但它们同时在语料里几乎不存在，IDF 会把它们筛掉；
 * - 可解释：「为什么是这次合并」能落成一句话（重合了 `权益`、`缩减`），分词器给不出
 *   这种能贴进材料的解释。
 *
 * 单字的连续段（如 `视频 A 页` 里的 `页`）切不出二字组，一个词都不产出：给单字当词会
 * 让「页」「的」「新」这类高频字把每条合并都拉成「有点像」，比漏掉它糟得多。
 */
export function grams(text: string): Set<string> {
  const out = new Set<string>();
  const lowered = text.toLowerCase();

  for (const run of lowered.matchAll(CJK_RUNS)) {
    const chars = run[0];
    for (let i = 0; i + 1 < chars.length; i += 1) {
      out.add(chars.slice(i, i + 2));
    }
  }
  for (const word of lowered.matchAll(ASCII_WORDS)) {
    out.add(word[0]);
  }
  return out;
}

/**
 * 发版/同步/回滚类的「杂活合并」——消息里出现这些词就说明那次提交不是在做功能。
 *
 * 为什么整条剔掉、而不是打个折：`mergeWeight` 的宽度打折在**奖励窄合并**，而发版杂活
 * 永远是窄的（「升级pc版本到327」动 1 个文件、「热备域名更换」动 10 个），同时它的消息
 * 又天然带着功能词（一句「feat: 专业空间回滚」把「专业空间」全命中了），相似度因此很高。
 * 任何固定倍率（0.5、0.2）都只是把门槛挪一格，换个仓、换个版本号就失效。正确的说法是
 * **语义**上的：一次版本号变更不是一次功能。它没有「功能落在哪儿」这个答案，让它参与
 * 打分只可能把真答案挤下去。
 *
 * 只按词面剔、不按词面留：这些词出现在消息任何一段都算（发版火车常常一段一个版本）。
 * 代价是可能误伤（比如「feat: 同步通讯录」里的「同步」）——所以第一优先看 `branch`。
 */
const PLUMBING_WORDS = [
  'revert',
  '回滚',
  '合并master',
  '升级pc版本',
  '升级版本号',
  '同步',
  '热备',
  '重新打包',
  '发版',
  '上线准备',
] as const;

/**
 * 功能分支前缀。
 *
 * 认 `feat-` / `feature-` / `feat/` / `feature/` 四种写法，**不是**只认横杠：
 * 这个仓的真历史里 `feat/architectural-transformation`（46 条）、`feat/remould-dll`（8 条）
 * 用的是斜杠，`feat-direct-link-renovation-tw` 用的是横杠，两种并存。只认横杠会把 54 条
 * 「明摆着的功能分支」整条扔掉——那是判据没写全，不是口径问题。
 */
const FEATURE_BRANCH = /^(feat|feature)[-/]/;

/**
 * 这条合并是不是「一次真的功能合并」。
 *
 * `branch` 是最强的信号，优先于措辞：
 * - 分支以 `feat-` / `feature-` 开头 → 是功能合并，**不再看消息**（有人在 feat 分支里
 *   写了「同步xx」也不影响它就是那次功能）；
 * - 分支存在但不是这个前缀（`master-1103`、`release-download-limit-yl`）→ 不是。
 *   发布分支上的一次提交说的是「这次发什么」，不是「功能怎么实现」；
 * - 分支为空（pc 仓有大量这种行）时退到消息：首段以 `feat` 开头、且消息里没有杂活词。
 *
 * 消息里的空白先压掉再匹配：清单里的写法是「合并 master」「合并master」并存。
 */
export function isFeatureMerge(row: HistoryRow): boolean {
  const branch = (row.branch ?? '').trim().toLowerCase();
  if (FEATURE_BRANCH.test(branch)) return true;
  if (branch !== '') return false;

  const head = (row.message.split(' / ')[0] ?? '').trim().toLowerCase();
  if (!head.startsWith('feat')) return false;

  const haystack = row.message.toLowerCase().replace(/\s+/g, '');
  return !PLUMBING_WORDS.some((word) => haystack.includes(word));
}

/** 一次合并与查询的匹配结果。`score` 只用于排序，绝对值没有意义。 */
export type RankedMerge = { row: HistoryRow; score: number };

/**
 * 全序比较：分数降序 → 时间降序（新的先看）→ `commit_sha` 升序 → `repo` 升序。
 *
 * 为什么必须有后两把尺子：分数相同的合并一点都不少见（同一天里两条都是「用户权益缩减」
 * 之类的提交信息）。只按 score 排，顺序就取决于 `Array.prototype.sort` 在等值时的行为
 * ——实现是稳定的，但**输入顺序**会漏出来，而输入顺序取决于 `read_history` 的
 * `order by` 和时间戳的精度（`%cI` 只到秒，同一秒可以有两次合并）。有了 sha 和 repo，
 * 这一层就是全序：同一份历史，怎么打乱传进来都得到同一个排名。
 *
 * 时间比较用字符串比是因为 `readHistory` / `validateMerges` 都把它折成了 UTC ISO
 * （`…Z`），同格式的 ISO 字典序 = 时间序。即便有人塞进来一个没折过的值，最后仍由
 * sha 兜到全序，最坏只是「新的不一定排前面」，不会变成不确定。
 */
function compareRanked(a: RankedMerge, b: RankedMerge): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.row.mergedAt !== b.row.mergedAt) return a.row.mergedAt < b.row.mergedAt ? 1 : -1;
  if (a.row.commitSha !== b.row.commitSha) return a.row.commitSha < b.row.commitSha ? -1 : 1;
  if (a.row.repo !== b.row.repo) return a.row.repo < b.row.repo ? -1 : 1;
  return 0;
}

/**
 * 按相似度给合并排名，只留分数 > 0 的，取前 `top` 条。
 *
 * 打分前先过 `isFeatureMerge`：发版/同步/回滚类合并整条不参与（理由见那里的注释）。
 * 剔完一条不剩时返回空数组，调用方据此给 `{ kind: 'none' }`。
 *
 * `top` 用 `Number.isFinite` 兜一下：调用方从命令行/配置拿来的值可能是 `NaN`
 * （`slice(0, NaN)` 会静默返回空数组，看起来像「没有相近的合并」，其实是个配置错）。
 */
export function rankMerges(
  rows: readonly HistoryRow[],
  query: string,
  top: number = TOP_MERGES,
): RankedMerge[] {
  const limit = Number.isFinite(top) ? Math.max(0, Math.floor(top)) : TOP_MERGES;
  if (limit === 0 || rows.length === 0) return [];

  const wanted = [...grams(query)];
  if (wanted.length === 0) return [];

  // 先剔掉杂活合并，再算 df / IDF：**IDF 的语料就是这批可用的合并**。
  // 若先算 df 再剔，df 里会混进那些永远不参与打分的行，`log(1 + N/df)` 的 N 与 df 也
  // 不再对应同一批文档，「稀有权重」就名不副实了。
  const usable = rows.filter(isFeatureMerge);
  if (usable.length === 0) return [];

  // 文档侧只切 `message`，**不切 branch、不切文件路径**。
  // 理由：branch 是 `feat-userEquity-fjd` 这种英文标识符，把英文标识符也拿来比，等于
  // 偷偷引入了「中文需求 ↔ 英文命名」这一层猜测——本次改造要消灭的就是它。文件路径同理
  // （`src/pages/video/video.vue` 里的 `video` 会跟「视频」混不掉，只会让结果看起来对、
  // 理由说不清）。路径在这一层只作为**聚合的键**，不参与打分。
  const docs = usable.map((row) => grams(row.message));

  // df 只在**查询词**上算：算全量词的 df 是白干（657 条 × 每条约 30 个词），而打分只需要
  // 查询词的 IDF。
  const idf = new Map<string, number>();
  for (const gram of wanted) {
    let df = 0;
    for (const doc of docs) if (doc.has(gram)) df += 1;
    // df = 0 → 这个词在这批历史里不存在，IDF 记 0 并在下面**从分母里剔掉**。
    // 剔而不是取对数上限：中文二字组会跨词边界造出 `户部`（用户部分）、`分权`（部分权益）、
    // `益缩`（权益缩减）这类语料里根本不存在的组。若把它们按「极稀有 = 极大 IDF」算进分母，
    // 任何一句自然中文的查询都会被几个不存在的组打到接近 0 分，最终 `{ kind: 'none' }`
    // ——明明有相近的合并却报「没有」，这是最糟的失败形态。
    // 剔掉之后：分母 = 语料里真实存在的那部分查询词，score 仍是 0..1，且含义更好读
    // （「查询词里能在历史中对照上的部分，被这次合并覆盖了多少」）。
    if (df > 0) idf.set(gram, Math.log(1 + usable.length / df));
  }
  if (idf.size === 0) return [];

  let total = 0;
  for (const value of idf.values()) total += value;
  if (total <= 0) return [];

  const hits: RankedMerge[] = [];
  for (let i = 0; i < usable.length; i += 1) {
    const doc = docs[i];
    const row = usable[i];
    if (doc === undefined || row === undefined) continue;
    let matched = 0;
    for (const [gram, weight] of idf) if (doc.has(gram)) matched += weight;
    // `> 0` 而不是 `>= 0`：分数 0 的合并（信息为空、或一个词都没重合）参与聚合只会把
    // 文件摊薄——它们没提供任何「跟这条需求有关」的证据。
    if (matched > 0) hits.push({ row, score: matched / total });
  }

  hits.sort(compareRanked);
  return hits.slice(0, limit);
}

/**
 * 一次合并的出处，一句话、能直接进材料：`出自 11-03「用户权益缩减」`。
 *
 * 三处细节都是有原因的：
 * - 日期取 `mergedAt` 的**年-月-日**直接截出 `MM-DD`，不做本地时区换算。库里已经是
 *   UTC ISO（`readHistory` 统一折过），换成当地时间就要读运行环境的 TZ——那会让同一个
 *   输入在不同机器上给出不同日期，而这条字符串是要写进材料的。差半天可接受，不可复现
 *   不可接受。
 * - 只留第一段：`mergeHistory` 把提交信息的每一行用 ` / ` 连起来
 *   （`用户权益缩减 / 弹窗文案调整`），第二段之后是细节，塞进 `reason` 会把路径挤走。
 * - 信息为空（库里有 13 条这样的行）时也必须有话说：`（提交信息为空）`。空字符串让
 *   `reason` 变成 `出自 11-03「」`，读的人会以为我们读坏了。
 */
function mergeReason(row: HistoryRow): string {
  const day = dayOf(row.mergedAt);
  const label = firstSegment(row.message);
  return label === ''
    ? `出自 ${day} 那次合并（提交信息为空）`
    : `出自 ${day}「${label}」`;
}

/** `2026-11-03T00:00:00.000Z` → `11-03`。读不出日期时给一句话，不给 `NaN-NaN`。 */
function dayOf(mergedAt: string): string {
  const matched = /^\d{4}-(\d{2})-(\d{2})/.exec(mergedAt.trim());
  if (matched === null) return '某次合并';
  return `${matched[1]}-${matched[2]}`;
}

/** 提交信息的第一段（` / ` 之前），压平空白，过长截断。 */
function firstSegment(message: string): string {
  const head = (message.split(' / ')[0] ?? '').replace(/\s+/g, ' ').trim();
  return head.length > MERGE_LABEL_MAX ? `${head.slice(0, MERGE_LABEL_MAX)}…` : head;
}

/**
 * 一次合并对「它自己动的那些文件」的证据强度：相似度按合并宽度打折。
 *
 * 取 max 聚合（而不是 sum / avg）在仓库级代码检索里是更稳的做法：一次合并只要与需求
 * 高度相似，它动的文件就该算「强证据」，不该因为它在清单里排第几而被摊薄。
 *
 * `log2(2 + files.length)` 而不是 `files.length`：文件数 0 的合并不存在除零问题
 * （`log2(2) = 1`，权重正好等于相似度），1 个文件时是 1.58、50 个文件时是 5.70——
 * 单调、平滑、没有断崖。分母取 log 而不是直接乘：一条动了 106 个文件的巨型合并
 * （2023-10-10 那种 20+ 条提交拼起来的「打包合并」）与一条只动 1 个文件的精确合并，
 * 前者对其中任何**一个**文件的说明力都该弱得多，但不该弱到 1/106。
 */
export function mergeWeight(score: number, fileCount: number): number {
  return score / Math.log2(2 + fileCount);
}

/** 聚合出来的一个文件：被几次合并碰过、最高权重、以及那次合并本身（`reason` 的来源）。 */
type FileAgg = { path: string; count: number; weight: number; best: RankedMerge };

/**
 * 文件聚合后的排序：权重降序 → count 降序 → 路径升序。
 *
 * 为什么**权重**第一、`count` 只当兜底（这一版改的就是这里）：按 `count` 排会系统性
 * 地奖励「被很多次合并碰过」的文件，而被很多次合并碰过的通常是公用件——`request.ts`
 * 这种 HTTP 客户端、`global-component.vue` 这种全局壳——而不是这条需求的实现。真数据
 * 657 行上的实测：`上传下载按量限速风控` 按 count 排的第一名是 `src/services/request.ts`，
 * 正确答案 `src/services/download-risk-modal.ts` 被挤到第 6。原因很直白：一条动了 106 个
 * 文件的 2023 年老合并（20+ 条提交拼起来的打包合并）也在前 5 名里，它把 request.ts 的
 * count 顶到 4，而它对自己那 106 个文件里的任何一个都说明不了什么。
 *
 * 所以先按合并宽度打折（`mergeWeight`），再取「碰过这个文件的合并里最高的权重」——
 * 取 max 而不是求和/平均，是因为一个文件只要被**一次**高度相似的合并动过，它就是一条
 * 值得看的线索；求和会把「被十次不相关的合并顺手改过」的公用件顶上去。
 *
 * `count` 留在第二级不是装饰：权重完全相同时（同一个合并动的几个文件），被更多次合并
 * 碰过的那个更可能是落点。它只在同级内起作用，不会翻掉上面的判断。
 *
 * 路径用**码点**比（`<` / `>`）而不是 `localeCompare`：后者的大小写与重音顺序随运行
 * 环境的 locale 变，候选清单的顺序换台机器就换一次，等于没有排序。
 */
function compareFiles(a: FileAgg, b: FileAgg): number {
  if (a.weight !== b.weight) return b.weight - a.weight;
  if (a.count !== b.count) return b.count - a.count;
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

/**
 * 给定合并历史与一句中文需求，给出候选文件。
 *
 * 返回三种结果里的两种：`none`（看了，但没有相近的）或 `candidates`（线索，一律 `low`）。
 * `absent`（没看到代码）属于另一层——这里拿到了 rows 就说明历史是读到了的。
 *
 * 任何一步落到「零个候选」都必须回到 `{ kind: 'none' }`：命中了合并但文件列表全空、
 * `limit` 传了 0，都是这种情形。`CANDIDATES_LINE` 对空数组直接抛，所以这里没有
 * 「交一个空清单上去」的余地——那正是本仓修过的病：失败被渲染成一个看起来正常的空输出。
 */
export function locateFromHistory(
  rows: readonly HistoryRow[],
  query: string,
  opts: { top?: number; limit?: number } = {},
): LocateResult {
  const ranked = rankMerges(rows, query, opts.top ?? TOP_MERGES);
  if (ranked.length === 0) return { kind: 'none' };

  // 聚合：path → 被几次合并碰过 + 最高权重 + 那次合并（也是 `reason` 的来源）。
  // `best` 保留的是**权重最高**的合并，不是最近的那次，也不是相似度最高的那次：
  // `reason` 要解释「凭什么说这里」，而这个文件的得分就是按这个权重算出来的——
  // 出处和分数必须是同一件事，否则材料里的「出自 X」解释不了它为什么排在这。
  const byFile = new Map<string, FileAgg>();
  for (const hit of ranked) {
    // 每条合并的权重只算一次：`files.length` 在循环里不会变。
    const weight = mergeWeight(hit.score, hit.row.files.length);
    for (const file of hit.row.files) {
      const seen = byFile.get(file);
      if (seen === undefined) {
        byFile.set(file, { path: file, count: 1, weight, best: hit });
      } else {
        seen.count += 1;
        if (weight > seen.weight) {
          seen.weight = weight;
          seen.best = hit;
        }
      }
    }
  }

  const limit = Number.isFinite(opts.limit ?? CANDIDATE_LIMIT)
    ? Math.max(0, Math.floor(opts.limit ?? CANDIDATE_LIMIT))
    : CANDIDATE_LIMIT;

  const items: Candidate[] = [...byFile.values()]
    .sort(compareFiles)
    .slice(0, limit)
    .map((entry) => ({
      path: entry.path,
      reason: mergeReason(entry.best.row),
      source: 'history',
      // 候选分就是排序键本身（宽度打折后的权重），仍然落在 (0, 1]。
      // 为什么不把 count 掺进来（上一版是 `count + 分数`）：掺进去之后 score 就在说
      // 另一件事，而排序先看权重——两套口径分开写，早晚有一处忘了同步，那时清单的
      // 顺序和 score 自己说的就对不上了。`count` 只当同级兜底，不进步。
      score: entry.weight,
    }));

  if (items.length === 0) return { kind: 'none' };

  // 第一版一律 `low`：检索只到「可能是这里」，说成结论就是在赌。
  return { kind: 'candidates', confidence: 'low', items };
}
