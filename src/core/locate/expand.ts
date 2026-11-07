import { extractJson, type ProviderConfig, type ProviderResult } from '../uemaster/provider.js';
import type { ExpandFn } from './structure.js';

/**
 * 真的那个 `expand`：把「这条需求在代码里会叫什么」问一次模型，**失败一律 `null`**。
 *
 * 为什么这个文件必须存在（而不是塞进 `structure.ts`）：那一层刻意对模型一无所知
 * （`ExpandFn` 是注入的，测试因此不需要网）。真实现要碰三件那一层不该碰的东西——
 * provider 配置、HTTP、留痕——所以它们只能住在这里。
 *
 * 这一段是**尽力而为**的：评审阶段的产出是材料，不是模型健康状况。任何失败（没配模型、
 * 超时、非 2xx、回的不是 JSON 数组）都只做一件事——`null`，让 `expandedKeywords` 拿
 * 原始关键词继续跑。**不重试**：`expandedKeywords` 已经钉了 `calls === 1`，而且评审是
 * 批处理，一个需求多等 4 秒，整轮走查就往下拖。
 *
 * 这一层**不清洗、不去重、不截断、不翻译**：清洗与上限在 `structure.ts` 的 `cleanWords`，
 * 同义词表与中英对照在 `code-index.ts` 的 `expandTerms`。做第二遍就是第二套口径。
 */

/**
 * 超时 4 秒（简报要求 3–5 s）。
 *
 * 这不只是「省时间」：猜十个词是一个不需要推理的小任务，4 秒回不来通常是网关在排队，
 * 再等下去它也不会变快。上限交给 `complete()` 的 `AbortSignal.timeout`——**只有一条
 * 中止路径**，不在这里再套一个 `AbortController`：两条 abort 同时生效时，先喊停的那个
 * 决定错误文案，而两处写的中文早晚会不一致。
 */
export const EXPAND_TIMEOUT_MS = 4_000;

/** 一个字符串数组用不了多少 token；给多了模型会开始写解释（实测它很爱写）。 */
export const EXPAND_MAX_TOKENS = 400;

/**
 * 提示词里「最多 10 个」。
 *
 * 与 `structure.ts` 的 `EXPAND_CAP = 12` **不是同一个数**，这是有意的：12 是保险丝
 * （超过就砍），10 是要求。要求数字小于保险丝数字，截断才不会发生——被砍掉的词，
 * 模型以为用上了，而评审那条路上没人会回头看它少了什么。
 */
export const EXPAND_ASK = 10;

/**
 * 一次扩展的结果，交给调用方留痕（评审那一侧写 `uemaster_job_attempts` 的 `locate` 行）。
 *
 * 为什么不把失败原因塞进 `ExpandFn` 的返回值：那个签名是 `structure.ts` 定的
 * `string[] | null`，多一个字段就是给「扩展词」这一层加第二个出口；而失败原因只对
 * **运维**有用，对定位结论没有影响。
 */
export type ExpandAttempt = {
  promptChars: number;
  outputChars: number;
  /** 成功给出的词数；失败是 `null`（与错误文案一起看才知道是哪一种失败）。 */
  words: number | null;
  /** `null` = 这次成功。非空 = 一句中文，点名是超时、502 还是「回的不是数组」。 */
  error: string | null;
  ms: number;
};

/** 这一层要的两件事 + 一个可选的留痕口。测试注入前两个，评审注入第三个。 */
export type ExpandDeps = {
  complete: (
    cfg: ProviderConfig,
    prompt: string,
    opts?: { maxTokens?: number; timeoutMs?: number },
  ) => Promise<ProviderResult>;
  resolveConfig: () => Promise<ProviderConfig | null>;
  onAttempt?: (record: ExpandAttempt) => void | Promise<void>;
};

/** 标题里可能出现换行；提示词是一行一格，压平再发。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 提示词：只发标题与描述，只要一个 JSON 字符串数组。
 *
 * 三件事是刻意的：
 * - **描述为空就整行不写**。写成「描述：」后面空着，模型会替我们把那一段补出来
 *   （通常是开始解释需求），而我们要的是词。
 * - **不把 PRD 正文塞进来**。PRD 全文（实测 19k 字）既不是「描述」，也会把一次 4 秒的
 *   小调用变成一次长调用；PRD 的位置在 `keywordsFrom`（回落值）与评审那边。
 * - **把「最多 10 个」写在提示词里**，而不是只靠 `EXPAND_CAP` 砍：截断是保险丝，不是
 *   要求模型的方式（见 `EXPAND_ASK`）。
 *
 * 给一个形状示例 `["搜索","search","Share"]`：模型对「字符串数组」的理解会漂成
 * `{"keywords": [...]}`，一句示例比一句「不要对象」管用。
 */
export function expandPrompt(title: string, description: string): string {
  const lines = [
    '一条需求要在前端代码库里找落点。请猜：这条需求落到代码里，会用哪些词命名（文件名 / 路由 / 组件 / 函数）？',
    '',
    `标题：${oneLine(title)}`,
  ];
  const desc = oneLine(description);
  // 空描述不是「描述为空」，是「没有描述」：那一行整个不出现。
  if (desc !== '') lines.push(`描述：${desc}`);
  lines.push(
    '',
    `只回一个 JSON 字符串数组，最多 ${EXPAND_ASK} 个词，例如：["搜索","search","Share"]`,
    '· 中文业务词与英文标识符混着给都行，按最可能出现在代码里的顺序给；',
    '· 不要重复、不要解释、不要 markdown 代码块、不要编号；',
    '· 第一个字符是 [，最后一个字符是 ]。',
  );
  return lines.join('\n');
}

/**
 * 从回话里取那个数组，**只做形状判定，不做清洗**。
 *
 * `extractJson` 已经认三种回话（裸 JSON、```json 围栏、散文后面接一段 JSON），所以
 * 围栏不是失败——**这是本层的一个明确取舍**：模型违反「不要代码围栏」时，词还是那个
 * 词，为了一句排版把十个词全丢掉，评审拿到的就是一份更差的材料。反过来，元素不是字符串
 * 就整条判失败，不在这里 `String(x)` 或过滤：`String(null)` 会造出一个叫「null」的关键词，
 * 而它真的会去匹配路径里的 `null`——一个模型侧的类型错会变成一批假候选。过滤则是在
 * 这一层做清洗，那是 `cleanWords` 的事。
 */
function wordsIn(text: string): string[] | null {
  const parsed = extractJson<unknown>(text);
  if (!Array.isArray(parsed)) return null;
  if (!parsed.every((word): word is string => typeof word === 'string')) return null;
  return parsed;
}

/**
 * 造一个 `ExpandFn`：成功给词，**任何失败给 `null` 且不抛**。
 *
 * 失败分四种，文案分开写（留痕里要能一眼看出是「没配模型」还是「网关 502」）：
 * 1. 配置解析失败 / 三格不齐 → `null`，理由「没有配置模型接口」；
 * 2. `complete` 的 `{ ok: false }`（超时、非 2xx、传输层、空内容）→ `null`，原文照抄；
 * 3. 回话里没有 JSON 数组、元素不是字符串 → `null`；
 * 4. 数组是空的 → `null`（一个词都没给，与失败等价；`expandedKeywords` 也是这么判的）。
 *
 * 留痕（`onAttempt`）在这四种里都要写一次，成功也写：评审留痕里那一行要能回答
 * 「这次定位用的词是模型给的还是原始关键词」，只记失败答不了这个问题。
 * 留痕自己出错一律吞掉——`makeTrace` 已经不抛，这里再兜一层是因为这一层的契约是
 * 「不许因为任何模型侧的事让评审失败」。
 */
export function createExpand(deps: ExpandDeps): ExpandFn {
  return async (title, description) => {
    const started = Date.now();
    const prompt = expandPrompt(title, description);
    const report = async (record: ExpandAttempt): Promise<void> => {
      try {
        await deps.onAttempt?.(record);
      } catch {
        // 见上：留痕是加分项，不是主路径。
      }
    };

    let cfg: ProviderConfig | null;
    try {
      cfg = await deps.resolveConfig();
    } catch {
      cfg = null;
    }
    if (cfg === null) {
      await report({
        promptChars: prompt.length, outputChars: 0, words: null,
        error: '没有配置模型接口（接口地址 / API Key / 模型名缺一格），扩展词跳过',
        ms: Date.now() - started,
      });
      return null;
    }

    let reply: ProviderResult;
    try {
      reply = await deps.complete(cfg, prompt, {
        maxTokens: EXPAND_MAX_TOKENS,
        timeoutMs: EXPAND_TIMEOUT_MS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await report({
        promptChars: prompt.length, outputChars: 0, words: null,
        error: `请求模型时抛错：${message}`, ms: Date.now() - started,
      });
      return null;
    }

    const ms = Date.now() - started;
    if (!reply.ok) {
      await report({
        promptChars: prompt.length, outputChars: 0, words: null, error: reply.error, ms,
      });
      return null;
    }

    const words = wordsIn(reply.text);
    if (words === null || words.length === 0) {
      await report({
        promptChars: prompt.length,
        outputChars: reply.text.length,
        words: null,
        error: words === null ? '回的不是一个 JSON 字符串数组' : '回了一个空数组（一个词都没给）',
        ms,
      });
      return null;
    }

    await report({
      promptChars: prompt.length, outputChars: reply.text.length, words: words.length, error: null, ms,
    });
    return words;
  };
}
