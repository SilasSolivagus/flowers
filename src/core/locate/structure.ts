import { locateAcross, type CodeIndex, type Probe } from '../codemirror/code-index.js';
import type { Candidate, LocateResult } from './types.js';

/**
 * 评审阶段的定位：代码可能**还不存在**，所以问模型「这条需求在代码里会叫什么」，再去结构
 * 索引里搜那个名字。
 *
 * 为什么不能直接复用任务 5 那条历史路线：`locateFromHistory` 的前提是「这条需求以前被做过」。
 * 评审发生在开工之前，需求很可能压根没有对应实现——那时历史里什么都搜不到，而这并不等于
 * 「找不到」，它只是说明这条路线用错了。评审真正要回答的是「如果要改，最可能落在哪儿」，
 * 这是一个**命名猜测**问题，不是一个检索历史的问题。
 *
 * 于是这一层只做两件事，且两件事都不带判断：
 * 1. `expandedKeywords`：把「权益套餐」这种产品说法扩展成代码里可能出现的词
 *    （`权益`、`vip`、`member`……）。模型是**注入**的（`ExpandFn`），这一层不知道它怎么实现，
 *    也不知道提示词长什么样——测试因此不需要网，任务 9 换真调用时也不用改这里。
 * 2. `locateFromStructure`：把 `locateAcross` 的 `Probe[]` 翻成 `Candidate[]`。**不重新打分、
 *    不重新排序**，理由见 `locateFromStructure`。
 *
 * 有三件事是刻意没做的，都有理由，别「顺手补上」：
 * - **不重试模型**。回落值存在的唯一意义就是「这一轮模型不可用」，此时再要一次等于把一次
 *   失败当成可重试的抖动。评审必须照样出材料，所以失败的直接后果是「用原始关键词」，不是
 *   报错、也不是空清单。
 * - **不在这层过滤通用词**。「文件/目录/当前」这类词该不该用，是 `locate()` 的判断，
 *   而且它的口径是「全需求一个具体词都没命中时才允许通用词补位」（见 `locateAcross`）。
 *   这一层再筛一遍就有两套口径，同一个 PRD 在两个阶段的候选集就会分叉。
 * - **不跨仓重排**。不同仓的索引文件数不同、分数不可比，跨仓按分数排序等于拿两套尺子
 *   量同一批东西。仓的顺序就是调用方配置的顺序，这个选择留给调用方。
 */

// ─── 扩展词 ──────────────────────────────────────────────────────────────────

/**
 * 模型调用的形状：给它标题和描述，要它给一组「代码里可能出现的关键词」。
 *
 * 返回 `null` 是**约定的失败值**，与抛异常等价：任务 9 的真实现可能在模型拒答、超时、
 * 返回的不是 JSON 时选择 `null` 而不是抛。这一层两种情况都只做同一个动作——回落。
 */
export type ExpandFn = (title: string, description: string) => Promise<string[] | null>;

/**
 * 扩展词最多留几个。
 *
 * 12 与 `locate()` 的默认 `limit`、`inspect.ts` 的 `CANDIDATE_CAP` 同一个量级，但不是
 * 「凑数一致」：关键词个数会直接变成匹配趟数（`expandTerms` 每个词都要过一遍路径/路由/
 * 符号），12 个词已经能把一个 141 文件的仓扫到噪音区；再多，多出来的词只是把通用词
 * 更快地顶进结果里。模型很爱回 20 个以上的词，不截就是在让它替我们决定性能。
 */
export const EXPAND_CAP = 12;

/**
 * 清洗一组词：trim、去空、去重（保留首次出现的位置）、截前 `EXPAND_CAP` 个。
 *
 * **先去重再封顶，顺序不能倒**（`tests/locate-structure.test.ts` 有一条用例专门钉它）：
 * 上限的目的是「别让关键词个数把匹配趟数顶爆」，而重复词从来不增加趟数（`expandTerms`
 * 自己也去重）。先按位置砍，砍掉的是信息，省下的不是成本——前 8 个里有 4 个重复时，
 * 先封顶会交出一份 8 条、看起来像「模型这次给的词少」的清单。
 *
 * **不排序、不小写、不翻译。** 顺序是模型自己的判断（它把最像代码标识符的放前面），
 * 重排等于我们在猜它的意思；小写与翻译是 `expandTerms` 的事，那里只有一份口径。
 */
function cleanWords(words: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of words) {
    // 非字符串就跳过，不做 `String(raw)`：那会把 `null` 变成一个叫「null」的关键词，
    // 然后它真的会去匹配路径里的 `null`——一个模型侧的类型错会变成一批假候选。
    if (typeof raw !== 'string') continue;
    const word = raw.trim();
    if (word === '' || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= EXPAND_CAP) break;
  }
  return out;
}

/**
 * 让模型把需求扩展成关键词；**任何失败都回落 `fallback`，不重试、不抛**。
 *
 * 回落的判据只有一条：清洗之后一个词都不剩。它同时覆盖了 `null`、抛异常、`[]`、
 * 以及「回了一串空白」这四种情形——它们对这一层是同一件事：这次扩展没有产出可用的词。
 * 不用四个分支分别处理，是因为分开写就有四种「算不算失败」的判断，而其中任何一种写错
 * 都会让评审在模型抽风时拿到一个空关键词表。
 *
 * **一处它挡不住的缺口（终审 Minor 7，别当成已经防住了）**：回落值是调用方给的原始
 * 关键词，而它可能是**空的**（PRD 标题与正文都抽不出一个词——极短的需求、纯英文标识符、
 * 或者只有标点的标题）。那时 `locateFromStructure` 会拿零个词去检索，得到 `none`，
 * 材料上写「没能在代码里定位到这条需求的实现」。这句话在「我们拿着零个词去搜」这个
 * 意义上不算说谎，但它与「模型故障」这件事脱了钩：真正的病因是上游没有词可用。
 * 想做对，得在评审那一层给「零词」一个自己的出口（例如退回 `head` 失败那句之外的
 * 第四种说法），而那会动 `copy.ts` 的措辞契约——不在本次修复范围。
 * `tests/locate-structure.test.ts` 有一条用例把这个现状钉住，将来改这里它会红。
 *
 * 回落值是**调用方给的原始关键词**，原样交出去（只做一次浅拷贝，免得调用方之后再改
 * 自己的数组时影响到已经拿到的结果）。这里不给回落值也套一遍 `cleanWords`：它已经是
 * `expandTerms` 的输入，那边的 `trim`/去空/去重是权威口径，这一层再洗一遍就是第二套。
 */
export async function expandedKeywords(
  expand: ExpandFn,
  title: string,
  description: string,
  fallback: readonly string[],
): Promise<string[]> {
  let raw: string[] | null;
  try {
    raw = await expand(title, description);
  } catch {
    // 异常不上抛：评审这一段的产出是「材料」，不是「模型的健康状况」。原因由任务 9 的
    // 调用方自己记日志（它才知道超时还是 502），这一层只保证还有词可用。
    return [...fallback];
  }
  if (raw === null || raw === undefined || !Array.isArray(raw)) return [...fallback];
  const cleaned = cleanWords(raw);
  return cleaned.length === 0 ? [...fallback] : cleaned;
}

// ─── 结构检索 ────────────────────────────────────────────────────────────────

/**
 * 一条 `Probe` → 一条 `Candidate`。
 *
 * 三处都是刻意的：
 * - `reason` 用 `probe.why` 原样带出。`why` 已经是「路由 /search 的页面（命中「搜索」）」
 *   这种能读成一句中文的整句（见 `code-index.ts` 的 `Probe`），再加工一次只会把
 *   「哪条信号命中」这个唯一有价值的信息磨掉。
 * - **`reason` 兜一句非空**。`CANDIDATES_LINE` 把它渲染成 `` `path` ← reason ``，空字符串
 *   就是箭头后面空着——人工读材料时那是一个「渲染坏了」的形状，而不是一条弱证据。
 *   `locate()` 现在不会产出空 `why`（分数 > 0 就一定至少有一条信号），但这条保证住在这里，
 *   因为**材料的可读性不该依赖另一个模块的内部不变式**：那个模块以后加一条「分数可以有、
 *   理由可以不写」的信号，坏的是材料，不是一个测试。
 * - `score` 与 `source` 原样/固定，不重算：排序口径只有 `locate()` 一份。
 */
export function probeToCandidate(probe: Probe): Candidate {
  const why = probe.why.trim();
  return {
    path: probe.path,
    reason: why === '' ? '结构索引命中（该信号未记录具体理由）' : probe.why,
    source: 'structure',
    score: probe.score,
  };
}

/**
 * 在**所有仓**的结构索引上找这条需求的落点。
 *
 * 返回 `none` 或 `candidates`，**永不 `absent`**：`absent` 的意思是「我们没看到代码」，
 * 而索引是任务 9 在调用这一层之前就取好的——没取到索引的仓不该被塞进 `entries`，那是
 * 调用方的判断（`locateAcross` 对 `index: null` 也是给 `grep` 而不是给 `absent`）。
 * 这一层能看到的只有「索引在，里面有什么」，所以它能说的也只有「有」和「没有」。
 *
 * 三种「一条候选都没有」都必须回到 `{ kind: 'none' }`，**不能交一个空的 `candidates`**：
 * 后端仓（索引为空，`CodeIndex` 里一个页面都没有）、还没建索引的仓、以及关键词一个都
 * 没命中。`CANDIDATES_LINE` 对空数组直接抛（那是刻意的：空清单会渲染成一句「我们找到了
 * 位置」而实际零条），所以这里没有「先给个空清单，下游自己处理」的余地。
 *
 * 空索引**不是**错误、也不是 `absent`：我们确实查了，只是那棵树里没有可查的东西。这个区别
 * 在材料里是一句话的差别——`none` 写「没能在代码里定位到」，`absent` 写「代码没读到，
 * 这一轮不含任何现状判断」。把空索引说成 `absent`，会让人跑去催研发「把镜像接通」，而
 * 镜像其实通着，只是那个仓真的没有前端代码。
 *
 * 顺序：`locateAcross` 返回的 `Map` 保持 `entries` 的插入顺序，所以清单是「第一个仓的候选
 * 全部在前，然后第二个仓」。**不跨仓按分数重排**的理由见文件头。仓内顺序更不动——那是
 * `locate()` 的全序（分数 → 类别 → 路径），这里再排一次就有了第二套口径。
 */
export function locateFromStructure(
  entries: readonly { repo: string; index: CodeIndex }[],
  keywords: readonly string[],
  opts: { limit?: number } = {},
): LocateResult {
  // `limit` 交给 `locateAcross` 一路传到 `locate()`：它是**每仓上限**（那个函数的既有口径），
  // 不是全局上限。这一层不做跨仓截断——跨仓截断要先回答「仓之间怎么比」，而那正是
  // `locateAcross` 刻意回避的问题（它只判「这个仓有没有线索」，不让仓互相比分）。
  const choices = locateAcross(entries, keywords, opts.limit === undefined ? {} : { limit: opts.limit });

  const items: Candidate[] = [];
  for (const choice of choices.values()) {
    // `grep` 分支不带探针（它是「这个仓没有索引，退回去文本搜吧」的说明文字），
    // 而这一层不跑 grep：评审阶段没有可搜的代码，正是本任务存在的理由。
    if (choice.source !== 'index') continue;
    for (const probe of choice.probes) items.push(probeToCandidate(probe));
  }

  if (items.length === 0) return { kind: 'none' };

  // 第一版一律 `low`：结构命中说的是「这里的命名像」，不是「这里就是」。升到 `high`
  // 要先有「改完之后还能回到同一处」的证据，那不是命名检索能给的。
  return { kind: 'candidates', confidence: 'low', items };
}
