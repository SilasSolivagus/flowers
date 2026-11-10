import { db as appDb } from '../../db/client.js';
import { memberIdByName } from '../read/member.js';
import { memberProviderSettings } from './member-provider.js';
import { providerSettings } from './settings.js';

/**
 * 直连一个 OpenAI 兼容的 chat 接口——一个客户端，不要 SDK。
 *
 * 为什么要有这条路：在这之前，「生成」等于在本机跑一条 CLI（`FLOWERS_GEN_CMD` 或
 * `app_settings` 的 `generator.command`）。owner 的下一句要求是「我有一个 LLM 的 key
 * （用户配上来的）」：**一个 key 就该够产出材料**，不该先在他机器上装一个 agent CLI、
 * 再让它自己去认证。所以这一层只说一件事——把一段提示送给 `POST /chat/completions`，
 * 把回来的文字还给调用方。
 *
 * 三条硬规矩：
 *
 * 1. **不抛异常**。网络坏了、超时了、服务端 4xx，都走 `{ ok: false, error }`。调用方
 *    （生成流程、设置页的小测）不该为了「key 写错了」写 try/catch。
 * 2. **不记 key**。key 只出现在 `Authorization` 头里；错误文本里若被服务端回显，
 *    落在这里之前先被替换成 `***`。事件、日志、任务错误都从 `ProviderResult.error`
 *    取文案，所以只要这里洗干净，下游就干净。
 * 3. **不改写服务端的话**。`分组 auto 下模型 x 的可用渠道不存在` 必须原样到 owner
 *    眼前——那句话里有分组名、有模型名，是唯一能指向「哪里配错了」的线索。翻译成
 *    「请求失败」等于把线索扔了。
 *
 * 没有 SDK、没有新依赖：`fetch` 与 `AbortSignal.timeout` 都是 Node 22 自带的。
 */

export type ProviderConfig = { baseUrl: string; apiKey: string; model: string };

export type ProviderResult =
  | { ok: true; text: string; usage?: { prompt?: number; completion?: number } }
  /**
   * `reasoningChars` 只在「预算被思考吃光」这一支出现：它是**给调用方做判断用的证据**，
   * 不是给人看的文案（文案是 `error`）。真正的生成流程只看 `ok`/`error`，不受影响；
   * 设置页的小测靠它区分「没连上」与「连上了但模型光在思考」（见 `probeProvider`）。
   */
  | { ok: false; error: string; reasoningChars?: number };

/** 默认给一次生成 120 秒：够一个慢模型吐完一份需求文档，又不至于让人以为卡死。 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 默认 `max_tokens`。不设的话有的网关会按模型上限放行，一份 HTML 能吐出几万字，
 * 白白烧钱；4096 对「一份评估报告 / 一份 HTML」是够的，调用方可以按需放大。
 */
export const DEFAULT_MAX_TOKENS = 4096;

/** 环境变量：一个部署级覆盖，排在库之前（CI、临时换接口不必改库）。 */
const ENV_BASE_URL = 'FLOWERS_PROVIDER_BASE_URL';
const ENV_API_KEY = 'FLOWERS_PROVIDER_API_KEY';
const ENV_MODEL = 'FLOWERS_PROVIDER_MODEL';

// ─── 脱敏 ────────────────────────────────────────────────────────────────────

/**
 * 把 key 的每一处出现换成 `***`。
 *
 * 为什么必须有：有的网关把收到的 `Authorization` 原样回显在 `error.message` 里
 * （`Incorrect API key provided: sk-...`）。那条文案要登上界面、要进事件流，
 * 而它是**唯一**一条可能夹带 key 的字符串。用 `split/join` 而不是正则：key 里可能
 * 有 `.` `+` `/`，拼进正则就得转义，转义写错就是「看起来脱敏了，其实没有」。
 */
export function redactSecret(text: string, secret: string): string {
  const needle = secret.trim();
  if (needle === '') return text;
  return text.split(needle).join('***');
}

// ─── 小工具 ──────────────────────────────────────────────────────────────────

/** `https://x/v1` → `https://x/v1/chat/completions`；已经被写成完整路径的就不重复拼。 */
function endpointOf(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

/** 超时那句：既说「超时」，也说清超的是几秒——不然短超时的用例读起来像玄学。 */
function timeoutText(ms: number): string {
  const limit = ms % 1000 === 0 ? `${ms / 1000} 秒` : `${ms} 毫秒`;
  return `请求超时：${limit}内没有响应`;
}

/** 三格都非空才算一个配置；缺哪一格说哪一格（这几句不会带出值本身）。 */
function missingField(cfg: ProviderConfig): string | null {
  if (cfg.baseUrl.trim() === '') return '接口地址是空的';
  if (cfg.apiKey.trim() === '') return 'API Key 是空的';
  if (cfg.model.trim() === '') return '模型名是空的';
  return null;
}

/** 从响应体里抠 `error.message`；拿不到就返回 null，交给调用方退回状态码。 */
function messageIn(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed === '') return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const error = (parsed as { error: unknown }).error;
      if (typeof error === 'object' && error !== null && 'message' in error) {
        const message = (error as { message: unknown }).message;
        if (typeof message === 'string' && message.trim() !== '') return message.trim();
      }
      if (typeof error === 'string' && error.trim() !== '') return error.trim();
    }
  } catch {
    // 不是 JSON：下面按纯文本带出。有的反代直接回一行 "Bad Gateway"。
  }
  // 非 JSON 的正文原样带出，但截个长度：它进的是界面上一行字，不是日志文件。
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/** 传输层的失败：超时与其余（DNS、连接被拒、TLS）分开说，前者是我们自己喊停的。 */
function transportText(error: unknown, timeoutMs: number): string {
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name)
    : '';
  if (name === 'TimeoutError' || name === 'AbortError') return timeoutText(timeoutMs);
  const message = error instanceof Error && error.message !== '' ? error.message : String(error);
  // undici 把真正的原因（`connect ECONNREFUSED 127.0.0.1:3000`）挂在 cause 上，
  // 只看 message 会是一条没有信息量的 "fetch failed"。
  const cause = error instanceof Error && error.cause instanceof Error && error.cause.message !== ''
    ? `（${error.cause.message}）`
    : '';
  return `请求失败：${message}${cause}`;
}

/** `choices[0].message.content`；形状不对返回 null（交给调用方报「不是 chat 补全」）。 */
function contentOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return null;
  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null) return null;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : null;
}

/**
 * 这次回答「思考」了多久（字符数）。推理模型把思考放在 `reasoning_content`，
 * 普通模型没有这个字段 → 0。只在 content 为空时用来区分两种「空」。
 */
function reasoningCharsOf(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null) return 0;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return 0;
  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null) return 0;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return 0;
  const reasoned = (message as { reasoning_content?: unknown }).reasoning_content;
  return typeof reasoned === 'string' ? reasoned.length : 0;
}

/** `usage.prompt_tokens` / `completion_tokens` → 我们的两个字段；一个都没有就不带 usage。 */
function usageOf(payload: unknown): { prompt?: number; completion?: number } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const prompt = (usage as { prompt_tokens?: unknown }).prompt_tokens;
  const completion = (usage as { completion_tokens?: unknown }).completion_tokens;
  const out: { prompt?: number; completion?: number } = {};
  if (typeof prompt === 'number') out.prompt = prompt;
  if (typeof completion === 'number') out.completion = completion;
  return out.prompt === undefined && out.completion === undefined ? undefined : out;
}

// ─── 发一次 ──────────────────────────────────────────────────────────────────

/**
 * 把 `prompt` 送给 `{baseUrl}/chat/completions`，拿回一段文字。
 *
 * 返回值的 `error` 一律是中文、一律已脱敏：
 * - 配置不全：`接口地址是空的` / `API Key 是空的` / `模型名是空的`
 * - 超时：`请求超时：120 秒内没有响应`（放进了几秒，短超时的用例也一样读得懂）
 * - 非 2xx：服务端的 `error.message` **原文**（已脱敏）；没有就从 `HTTP 401` + 状态短语
 * - 响应不是 chat 形状：`响应不是 chat 补全的格式`
 * - 正文是 JSON 之外的东西：`模型接口返回的内容不是 JSON`
 * - 内容为空串：`模型返回了空内容`（空格也算空——那不是一份材料）
 * - 传输层：`请求失败：<原因>（<cause>）`
 */
export async function complete(
  cfg: ProviderConfig,
  prompt: string,
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<ProviderResult> {
  const missing = missingField(cfg);
  if (missing !== null) return { ok: false, error: missing };

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const hide = (text: string): string => redactSecret(text, cfg.apiKey);

  try {
    const response = await fetch(endpointOf(cfg.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: cfg.model.trim(),
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    // 非 2xx 时正文才是重点：网关的 `error.message` 有分组名与模型名。
    const body = await response.text();
    if (!response.ok) {
      const serverMessage = messageIn(body);
      if (serverMessage !== null) return { ok: false, error: hide(serverMessage) };
      const status = response.statusText === ''
        ? `HTTP ${response.status}`
        : `HTTP ${response.status} ${response.statusText}`;
      return { ok: false, error: hide(status) };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return { ok: false, error: '模型接口返回的内容不是 JSON' };
    }

    const content = contentOf(payload);
    if (content === null) return { ok: false, error: '响应不是 chat 补全的格式' };
    if (content.trim() === '') {
      // 推理模型（deepseek-flash、o 系、各种 reasoner）会把 max_tokens 先花在思考上：
      // 预算不够时 content 是空串、reasoning_content 却有一大段，finish_reason 为 length。
      // 这时「模型返回了空内容」是错的诊断——模型说了话，只是没轮到答案。
      // 实测 deepseek-flash max_tokens=60：reasoning 110 字、content 0 字。
      const reasoned = reasoningCharsOf(payload);
      if (reasoned > 0) {
        return {
          ok: false,
          error: `模型把输出预算用在了思考上（max_tokens=${String(maxTokens)}，思考 ${String(reasoned)} 字、答案 0 字）。把这个阶段的 max_tokens 调大`,
          reasoningChars: reasoned,
        };
      }
      return { ok: false, error: '模型返回了空内容' };
    }

    const usage = usageOf(payload);
    return usage === undefined ? { ok: true, text: content } : { ok: true, text: content, usage };
  } catch (error) {
    return { ok: false, error: hide(transportText(error, timeoutMs)) };
  }
}

// ─── 从模型的回话里抠 JSON ───────────────────────────────────────────────────

/**
 * 从 `start` 这个 `{` / `[` 起找到与它配对的收尾位置；找不到返回 -1。
 *
 * 要自己数括号而不是 `JSON.parse` 一个 `indexOf('}')` 切片：正文里常有嵌套对象，
 * 更常见的是模型在 JSON **后面**还接着写「以上就是配置」。字符串里的括号与转义
 * 引号不算数，否则 `{"a":"}"}` 会提前收尾。
 */
function matchEnd(text: string, start: number): number {
  const open = text.charAt(start);
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 在整段文本里按出现顺序找第一个能 `JSON.parse` 成功的对象/数组。 */
function firstJsonIn(text: string): unknown {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch !== '{' && ch !== '[') continue;
    const end = matchEnd(text, i);
    if (end < 0) continue;
    try {
      return JSON.parse(text.slice(i, end + 1));
    } catch {
      // 这个 `{` 不是 JSON 的开头（散文里的 `{占位符}`），继续往后找。
    }
  }
  return undefined;
}

const FENCE = /```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)```/g;

/**
 * 从模型的一整段回话里取出第一个 JSON 对象/数组；没有就 null。
 *
 * 模型的回话不会正好是 JSON：常见三种形状——裸 JSON、```json 围栏里包着的、以及
 * 「好的，我按这个格式给你：」之后接一段 JSON。围栏优先于裸扫描：围栏是模型
 * **明确标注**的代码块，而散文里随手写的 `{需求}` 也是花括号。都没有就 null——
 * 上层据此报「模型没给 JSON」，而不是拿一个半截对象去解析。返回类型由调用方声明，
 * 这里不校验字段：字段口径属于调用方（compose 步骤）的契约。
 */
export function extractJson<T>(text: string): T | null {
  FENCE.lastIndex = 0;
  for (let match = FENCE.exec(text); match !== null; match = FENCE.exec(text)) {
    const inner = (match[1] ?? '').trim();
    if (inner === '') continue;
    try {
      const parsed: unknown = JSON.parse(inner);
      if (typeof parsed === 'object' && parsed !== null) return parsed as T;
      continue;
    } catch {
      const found = firstJsonIn(inner);
      if (found !== undefined) return found as T;
    }
  }
  const found = firstJsonIn(text);
  return found === undefined ? null : (found as T);
}

// ─── 配置从哪来 ──────────────────────────────────────────────────────────────

/** 三格去空白；有一格空就当这一层没配（不与另一层拼半份）。 */
function normalizeConfig(
  baseUrl: string | undefined,
  apiKey: string | undefined,
  model: string | undefined,
): ProviderConfig | null {
  const resolved = {
    baseUrl: (baseUrl ?? '').trim(),
    apiKey: (apiKey ?? '').trim(),
    model: (model ?? '').trim(),
  };
  if (resolved.baseUrl === '' || resolved.apiKey === '' || resolved.model === '') return null;
  return resolved;
}

/** 这一份配置是从哪一层来的。界面要按它说「平台统一模型」还是「我的」。 */
export type ProviderScope = 'env' | 'member' | 'platform';

export type ProviderResolution = { config: ProviderConfig; scope: ProviderScope };

/** 环境变量那一层；三格不齐就是 null（不与其它层拼成半份）。 */
export function providerConfigFromEnv(): ProviderConfig | null {
  return normalizeConfig(
    process.env[ENV_BASE_URL],
    process.env[ENV_API_KEY],
    process.env[ENV_MODEL],
  );
}

/**
 * 解析顺序：**env → 当前成员自己的三格 → `app_settings` 的平台三格 → null**。
 *
 * 每一层都要求三格齐全，缺一格就整层作废、往下一层走——**不拼**。P2.12 之后这条
 * 规矩更重要了：成员只填了模型名、key 留空，如果与平台的地址 / key 拼起来，
 * 发出去的请求会带着**别人的 key**去一个他自己没填过的地址。宁可整层作废，
 * 让它如实退回「平台统一模型」。
 *
 * `actor` 是**本次动作的归属人**（`created_by` 写的就是这个字符串），不是全局默认值：
 * 同一个部署里两个人各自配了自己的 key，谁按的按钮就用谁的。不传 = 没有成员这一层
 * （脚本、worker 的兜底、以及「平台配置」那类问题），直接看 env 与平台三格。
 *
 * 成员名不在名册上（cookie 里是个离职的人）时**静默跳过这一层**：没有 id 就没有
 * 属于他的那三行，退到平台配置是唯一诚实的答案。
 *
 * 库读失败（连不上）不吞：那是基础设施坏了，把它说成「未配置」会让人去查设置页。
 */
export async function resolveProvider(actor?: string): Promise<ProviderResolution | null> {
  const fromEnv = providerConfigFromEnv();
  if (fromEnv !== null) return { config: fromEnv, scope: 'env' };

  if (actor !== undefined) {
    const memberId = await memberIdByName(actor);
    if (memberId !== null) {
      const own = await memberProviderSettings(appDb, memberId);
      if (own !== null) return { config: own, scope: 'member' };
    }
  }

  const platform = await providerSettings(appDb);
  return platform === null ? null : { config: platform, scope: 'platform' };
}

/** 只要配置的那一半（绝大多数调用方只关心「有没有一份能发请求的三格」）。 */
export async function resolveProviderConfig(actor?: string): Promise<ProviderConfig | null> {
  return (await resolveProvider(actor))?.config ?? null;
}

// ─── 就地小测：设置页那一行的「测试」 ────────────────────────────────────────

/**
 * 小测的超时：15 秒。
 *
 * P2.12 试过 10 秒——真实的网关（尤其带重试/排队的那种）在冷启动时常常 10 秒
 * 回不来第一句，于是「key 明明是好的」也会被判成超时，用户回去改一个没坏的 key。
 * 45 秒又不行：它是设置页一行上的按钮，人盯着那一行等三刻钟，只会以为界面卡住。
 * 15 秒覆盖了绝大多数首字节，也短到可以坐在那儿等。
 */
export const PROBE_TIMEOUT_MS = 15_000;

/**
 * 小测问的话与预算。
 *
 * 预算 512 是**量出来的**，不是拍的：同一个模型（deepseek-flash）对着这句「只回四个字」
 * 的小问题，`reasoning_content` 实测 27 / 42 / 47 / 85 字（对应 reasoning_tokens
 * 16 / 26 / 29 / 60）。原来的 16 连「想」都不够——思考吃掉全部 16 个 token，`content`
 * 是空串、`finish_reason=length`，于是 key 明明能用也会被判成失败。
 * 512 是实测最长思考（60 tokens）的 8 倍多，想完还剩三百多个 token 写那四个字；
 * 它同时也远低于任何网关的 `max_tokens` 下限。换成更爱想的模型也不会立刻撞墙。
 */
const PROBE_PROMPT = '只回四个字：接口可用';
export const PROBE_MAX_TOKENS = 512;

export type ProbeResult = {
  ok: boolean;
  /**
   * 那一行要显示的字：`通过 · 412ms · 21 tokens`，或者**服务端的原文**
   * （`分组 auto 下模型 x 的可用渠道不存在` / `Incorrect API key provided: ***`）。
   * 失败时不做任何改写——那句话就是下一步。
   *
   * 推理模型把预算全用在思考上时也算通过，但话说全（不假装答案写出来了）：
   * `通过 · 9206ms · 推理模型：思考 29 字、答案 0 字（连接与密钥有效）`。
   */
  label: string;
  /** 通过时是 null；失败时与 `label` 同值，给需要分支的调用方用。 */
  error: string | null;
  ms: number;
  /** 服务端给了 usage 才有：prompt + completion。 */
  tokens: number | null;
};

/**
 * 对着**一份已经拼好的配置**发一次极小的补全，把结果拼成那一行字。
 *
 * 不抛：`complete()` 自己就不抛（配置缺项、超时、4xx 都是 `{ok:false}`），这里只是
 * 加上耗时与 token 数。所以设置页的「测试」按钮没有失败态以外的分支，也不会因为
 * 一次网络抖动把整页打崩。
 *
 * 为什么不用 `maxTokens: 1`：有的网关在 `max_tokens` 太小时直接 400
 * （`max_tokens must be greater than 0` 之外还有自家的下限）。512 够便宜，也不会被拒。
 */
export async function probeProvider(
  cfg: ProviderConfig,
  opts: { timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const started = Date.now();
  const result = await complete(cfg, PROBE_PROMPT, {
    maxTokens: PROBE_MAX_TOKENS,
    timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS,
  });
  const ms = Date.now() - started;
  if (!result.ok) {
    // 小测只回答一件事：**连得上吗、这把钥匙对不对**。内容好不好、答案写没写出来，
    // 都不是它的事——它连的是「同一张嘴」，不是「同一份材料」。
    //
    // 推理模型（deepseek-flash、o 系、各种 reasoner）会把预算先花在思考上：预算不够时
    // `content` 是空串、`reasoning_content` 却有一大段。这时 `complete()` 说得没错
    // （对生成流程来说那就是一次失败的生成），但用在小测上就是**误判**：HTTP 200 拿到了、
    // 鉴权过了、模型确实回了话——只是答案还没轮到。把它报成失败，用户会拿着一个能用的
    // key 回去改一个没坏的东西，而真正该改的是那个阶段的 max_tokens。
    //
    // 所以这里按「有没有回话」而不是「答案有没有字」判通过，并且把实话说在那一行上；
    // 传输、鉴权、4xx、超时都没有 `reasoningChars`，一条都不会被这句放过。
    const reasoned = result.reasoningChars ?? 0;
    if (reasoned > 0) {
      return {
        ok: true,
        label: `通过 · ${ms}ms · 推理模型：思考 ${String(reasoned)} 字、答案 0 字（连接与密钥有效）`,
        error: null,
        ms,
        tokens: null,
      };
    }
    // 答案 0 字、思考 0 字：这不是「预算不够」，是模型真的没说话——继续算失败。
    return { ok: false, label: result.error, error: result.error, ms, tokens: null };
  }

  const usage = result.usage;
  if (usage === undefined) return { ok: true, label: `通过 · ${ms}ms`, error: null, ms, tokens: null };
  const tokens = (usage.prompt ?? 0) + (usage.completion ?? 0);
  return { ok: true, label: `通过 · ${ms}ms · ${tokens} tokens`, error: null, ms, tokens };
}
