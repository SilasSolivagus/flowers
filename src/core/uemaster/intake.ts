import { z } from 'zod';
import { AppError } from '../errors.js';
import { normalizeQuote, quoteInPrd } from './review.js';
import {
  complete, extractJson, type ProviderConfig, type ProviderResult,
} from './provider.js';

/**
 * 旧 Flower 的 `description` → 我们的六问（P4-08）。
 *
 * ## 它解决的问题
 *
 * 旧系统里一条需求就是「标题 + 一段自由文本」。我们的六问（谁在什么情况下用 / 现在
 * 怎么做 / 做成什么样算成功 / 涉及哪些页面 / 失败空无权限怎么办 / 这次不做什么）
 * 是给**生成材料的 agent** 用的上下文——缺哪一问，生成就在那一处猜。所以老需求
 * 搬过来时，那段自由文本要被**拆**成六问，而不是复制进第一格、剩下五格空着。
 *
 * ## 它不是自动跑的东西
 *
 * owner 的裁决：**一次性工具 + 一个界面入口**，不做保存时的静默转换。理由：拆分是
 * 一次「材料生成式的猜测」，猜错了要人看得见并改；而静默转换会让一条老需求在我们
 * 系统里带着六段没人读过的文字，比空着更坏（它看起来像有内容——与六问可空的理由
 * 同源）。所以：`app/actions.ts` 的 `splitDescriptionAction` 只把结果**填进表单**，
 * 保不保存由人按那一下决定。
 *
 * ## 三条硬规矩（与评审那一关同源）
 *
 * 1. **必须有据**。六问里每一问的答案都要能落回原文的一整句（`span`）。原文没说，
 *    那一格就是**空的**，并列进 `missing` —— **不编**。这是这份工具的诚实性所在：
 *    一段「分享页搜索补齐 H5」的旧描述里没有「失败怎么办」，把那一格填成「失败时
 *    提示重试」是模型写的，不是需求里有的，而它会被下游当成需求。
 * 2. **引文逐字核对**。`span` 与原文两边都走 `review.ts` 的 `normalizeQuote`（压掉
 *    空白、去 markdown 强调符与引号、去中英文标点、折小写），再判子串。归一的方向是
 *    **格式**不是内容：改词、改语序、拼接两处，归一之后一定对不上——那正是要拦的。
 *    核对失败的字段：内容丢掉、写进 `missing`，`notes` 里留一条 `⨯` 记录。
 * 3. **人要看得到依据**。`notes` 是「这一格用了原文的哪一句」，一行一条，人拿眼睛
 *    就能核。没有 `notes` 的 `missing` 说明模型压根没说；有 `⨯` 的说明它说了但
 *    **引文对不上原文**——这两种「空」不是一回事，报告与界面都要分开说。
 *
 * ## `notes` 的两种记号
 *
 * - `context ← 「原文里的一整句」`：采用了，引文逐字在原文里（这一条被测钉着）；
 * - `surfaces ⨯ 「…」`：模型给了内容但引文在原文里找不到，**已丢弃**。
 *
 * 所以「每条 `←` 的引文都能在原文里找到」是这份输出的不变量，而 `⨯` 的存在本身就是
 * 「这次有东西被拒了」。
 */

/** 六个输出字段（与任务书的签名一致：snake_case，因为它们是「库里的列」）。 */
export const SPLIT_KEYS = [
  'context', 'problem', 'outcome', 'surfaces', 'edge_cases', 'out_of_scope',
] as const;

export type SplitKey = (typeof SPLIT_KEYS)[number];

/** 六问 + 缺哪几问 + 依据。 */
export type SplitResult = Record<SplitKey, string> & {
  /**
   * 回来是空的字段（按 `SPLIT_KEYS` 顺序）。**「模型没说」与「引文对不上」都在这里**，
   * 区别在 `notes`：前者没有记录，后者有一条 `⨯`。
   */
  missing: SplitKey[];
  /** 用了 / 拒了哪些原文片段，一行一条（含 `←` 与 `⨯` 两种记号）。 */
  notes: string[];
};

export type SplitInput = { title: string; description: string };

/**
 * 原文的上限：20 万字符。
 *
 * 这一格在旧系统里是「一段描述」，真实输入最多几千字；限到 20 万是为了让「有人把一份
 * 100 万字的文档粘进来」不至于把一次调用撑爆。截断时 `notes` 明说截了——
 * 「引文必须在原文里」这句话的准确说法是「必须在**模型看到的**那一段里」。
 */
export const DESCRIPTION_PROMPT_MAX = 200_000;

/** 一次调用的超时：60 秒。六句话，不是一份材料。 */
export const SPLIT_TIMEOUT_MS = 60_000;

/**
 * 输出预算：16000。
 *
 * 这个数字是**实测**出来的，不是拍的：第一次拿 4096 跑 PAN-6 那份 16,512 字的 PRD，
 * deepseek-flash 把 4096 全用在了思考上（`reasoning_content` 12668 字、`content` 0 字，
 * finish_reason=length），`provider.complete` 于是回了一句「模型把输出预算用在了思考上」。
 * 六段话本身只要几百 token，但**推理**是按输入规模涨的——16k 字的原文配 16k 的预算才
 * 够它想出答案再写出来。多给的预算不会变成多余输出（输出只到 JSON 结束）。
 */
const SPLIT_MAX_TOKENS = 16_000;

// ─── 提示词 ──────────────────────────────────────────────────────────────────

/**
 * 提示词：只做「拆」这一件事。
 *
 * 四个必须写进去的东西（少一个，输出就会变成散文或编造）：
 * 1. **六问各自问什么**——用产品里那六个标签，外加一句「这一格该放什么」；
 * 2. **每格必须带 `span`**，且 `span` 是原文里**逐字**的一整句（会被程序逐字核对）；
 * 3. **原文没写就留空**，不许推断、不许写「无」、不许把别处的句子挪过来；
 * 4. **只要 JSON**，不要解释、不要围栏（围栏能被剥掉，但开场白会浪费预算）。
 */
export function splitPrompt(input: SplitInput, description: string): string {
  const title = input.title.trim() === '' ? '（没有标题）' : input.title.trim();
  return [
    '你在把一段旧系统里的「需求描述」拆成六个结构化问题。',
    '',
    `需求标题：${title}`,
    '',
    '旧描述原文（就是你要拆的全部材料，你没有别的材料）：',
    '<<<',
    description,
    '>>>',
    '',
    '六个问题，逐个回答：',
    '1. context —— 谁在什么情况下用（角色 + 场景）。',
    '2. problem —— 现在怎么做 / 哪不好（现状与痛点）。',
    '3. outcome —— 做成什么样算成功（可验收的结果）。',
    '4. surfaces —— 涉及哪些页面 / 入口。',
    '5. edge_cases —— 失败 / 空 / 无权限怎么办。',
    '6. out_of_scope —— 这次不做什么。',
    '',
    '三条硬规矩：',
    'A. 每一格都必须有 span：**从上文原文里逐字复制的一整句**。程序会把 span 与原文',
    '   逐字比对，对不上这一格就作废。不要改写、不要拼接两处、不要自己加标点或省略号。',
    'B. 原文没有讲到的，那一格 value 就留空字符串、span 也留空。**不要推断、不要补全、',
    '   不要写「无」「暂无」「未提及」**——留空才是真话。',
    'C. 不要复述整段原文：value 是**这一格的答案**（一句话到三句话），不是原文摘抄。',
    '   只有当原文那句话本身就是答案时，value 才可以与 span 相同。',
    '',
    '只输出一个 JSON 对象，六个键各是一个 { "value": "...", "span": "..." }：',
    '{"context":{"value":"","span":""},"problem":{"value":"","span":""},',
    ' "outcome":{"value":"","span":""},"surfaces":{"value":"","span":""},',
    ' "edge_cases":{"value":"","span":""},"out_of_scope":{"value":"","span":""}}',
    '不要代码围栏，不要解释。',
  ].join('\n');
}

// ─── 回话的解析与核对 ────────────────────────────────────────────────────────

const CellSchema = z.object({
  value: z.string().default(''),
  span: z.string().default(''),
});

type Cell = z.infer<typeof CellSchema>;

/**
 * 读模型回话里的六格。
 *
 * 为什么这么松（`catchall` + 逐键取）：模型的回话常常多一个 `notes`、或者把六格
 * 包在 `{"fields": {...}}` 里。**多出来的东西不构成失败**——真正的事实约束是
 * 逐字核对那一关，不是形状。少一格才算错（那一格就是「没答」）。
 */
function cellsOf(raw: unknown): Record<SplitKey, Cell> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const bag = raw as Record<string, unknown>;
  const inner = typeof bag['fields'] === 'object' && bag['fields'] !== null
    ? (bag['fields'] as Record<string, unknown>)
    : bag;
  const out = {} as Record<SplitKey, Cell>;
  for (const key of SPLIT_KEYS) {
    const raw = inner[key];
    const parsed = CellSchema.safeParse(raw);
    if (parsed.success) {
      out[key] = parsed.data;
      continue;
    }
    // 有的模型把一格写成裸字符串（`"context": "运营在后台找分享链接"`）：value 有了，
    // span 没有 → 按「没有引文」处理（这一格会被判 missing，见主流程）。
    if (typeof raw === 'string') {
      out[key] = { value: raw, span: '' };
      continue;
    }
    out[key] = { value: '', span: '' };
  }
  return out;
}

/** 一个值写进结果前：去首尾空白、把内部的连续空行压成一行（六问是 textarea 里的段落）。 */
function tidy(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

export type SplitDeps = {
  /** 测试注入用：一次补全。默认是 `provider.complete`。 */
  complete: (
    cfg: ProviderConfig, prompt: string, opts?: { maxTokens?: number; timeoutMs?: number },
  ) => Promise<ProviderResult>;
};

function empty(): SplitResult {
  return {
    context: '', problem: '', outcome: '', surfaces: '', edge_cases: '', out_of_scope: '',
    missing: [...SPLIT_KEYS],
    notes: [],
  };
}

/**
 * `splitDescription(cfg, { title, description })` —— 拆一次，**不落库**。
 *
 * 失败口径：
 * - 模型配置不全：`complete()` 回一句中文（`接口地址是空的`……），这里原样抛成
 *   `AppError('provider_error', 那句话)`；
 * - 模型没给 JSON：`AppError('split_failed', '模型的回话里没有六问的 JSON…')`；
 * - 模型给的东西一格都对不上原文：**不抛**，六个字段全空、`missing` 满六格、
 *   `notes` 里六条 `⨯`。这比抛错有用得多——它说的是「这段原文真的没写这些」，而
 *   抛错会让用户以为工具坏了。
 */
export async function splitDescription(
  cfg: ProviderConfig,
  input: SplitInput,
  deps: Partial<SplitDeps> = {},
): Promise<SplitResult> {
  const description = (input.description ?? '').replace(/\r\n?/g, '\n').trim();
  const out = empty();

  // 原文是空的：六格全空，说清为什么（不是「模型没用」，是没东西可拆）。
  if (description === '') {
    out.notes.push('原文是空的：六个问题都没有依据');
    return out;
  }

  const truncated = description.length > DESCRIPTION_PROMPT_MAX;
  const body = truncated ? description.slice(0, DESCRIPTION_PROMPT_MAX) : description;

  const ask = deps.complete ?? complete;
  const result = await ask(cfg, splitPrompt(input, body), {
    maxTokens: SPLIT_MAX_TOKENS,
    timeoutMs: SPLIT_TIMEOUT_MS,
  });
  if (!result.ok) throw new AppError('provider_error', result.error);

  const raw = extractJson<unknown>(result.text);
  const cells = raw === null ? null : cellsOf(raw);
  if (cells === null) {
    throw new AppError(
      'split_failed',
      '模型的回话里没有六问的 JSON：让它重跑一次，或换一个更听话的模型',
    );
  }

  if (truncated) {
    out.notes.push(`原文 ${description.length} 字，只有前 ${DESCRIPTION_PROMPT_MAX} 字交给了模型`);
  }

  for (const key of SPLIT_KEYS) {
    const cell = cells[key];
    const value = tidy(cell.value);
    const span = tidy(cell.span);

    // 模型什么都没说：这一格没有依据，进 missing，不留 notes（与「引文被拒」分开）。
    if (value === '' && span === '') continue;

    // 有内容但没有引文：直接判没有依据。`quoteInPrd('')` 永远是 false，这里显式写明
    // 是为了让 notes 里那句话是人话（「模型没给引文」而不是一个空引号）。
    if (span === '') {
      out.notes.push(`${key} ⨯ （模型没给引文）`);
      continue;
    }

    // 逐字核对：与评审那一关同一套归一（格式放宽、内容不放宽）。
    if (!quoteInPrd(span, body)) {
      out.notes.push(`${key} ⨯ 「${span}」`);
      continue;
    }

    out[key] = value === '' ? span : value;
    out.notes.push(`${key} ← 「${span}」`);
  }

  // missing 按 SPLIT_KEYS 顺序重建：空串就是缺。
  out.missing = SPLIT_KEYS.filter((key) => out[key] === '');
  return out;
}

/** 只给报告与排查用：一份结果里有没有被拒的引文（`⨯` 条数）。 */
export function rejectedCount(result: SplitResult): number {
  return result.notes.filter((note) => note.includes('⨯')).length;
}

/** 引文归一函数的一个薄出口：报告里要展示「我们是怎么比的」时用它。 */
export { normalizeQuote };
