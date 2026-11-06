/**
 * 生成失败的两件「给人看」的东西：一句分类过的中文，和一条一条的尝试记录。
 *
 * 这个文件是**纯的**（不 import 库、不读环境、不看时钟），因为两个地方都要用它，
 * 而那两处的运行时完全不同：
 * - 服务端：`attempts.ts` 把尝试落库、`start.ts` 把它们读回来；
 * - 浏览器：抽屉里那一行把它渲染成「第 1 次 · flow · 2 个节点 1 条连线被拒」。
 *
 * 为什么分类与留痕分开：分类管「这一句话是什么意思」，留痕管「发生过几次」。
 * 一个 402 只有一次调用，一个「一直画不对」有三次——前者要一句诊断，后者要一张清单。
 * 混在一起写，两件事都会写歪。
 */

// ─── 失败分类 ────────────────────────────────────────────────────────────────

/** 分类的结果必须是有限几种：界面只按它决定「要不要说一句人话」。 */
export type FailureKind =
  | 'quota' | 'invalid_key' | 'no_access' | 'rate_limit' | 'timeout' | 'network' | 'unknown';

export type Failure = {
  kind: FailureKind;
  /** 那一行**标题**（短、中文、不是诊断就是原文）。 */
  title: string;
  /**
   * 服务端那一句原文，**只在它比标题多带信息时**才有。
   *
   * 为什么要有这一格而不是把原文拼进标题：`Incorrect API key provided: sk-***`
   * 里的「哪一把 key」对新旧两把 key 并存的人是关键信息；而 `insufficient_quota`
   * 这七个字母拼在「这个 key 余额不足」后面，只是把一句人话弄脏。
   */
  detail?: string;
};

/**
 * 分类表：顺序就是优先级。
 *
 * 为什么是**子串**匹配而不是正则里带边界：这些针（`insufficient_quota`、`402`、
 * `无可用渠道`）来自四类真实来源——OpenAI 官方形状、国内网关的中文形状、HTTP 状态行、
 * 以及我们自己的 `provider.ts`。它们拼进句子里的方式没有统一格式，给每一种写一条正则
 * 只会让「今天匹配、明天不匹配」跟着网关改版走。子串匹配窄到这些针本身，误判成本
 * 是「一句标题不准」，而原文永远在第二行。
 *
 * 顺序也不是随便排的：`402` 必须比 `401` 先看（同一个句子里既有「余额」又有状态码时，
 * 余额才是那个 actionable 的原因）；`请求超时` 要比 `fetch failed` 先看（超时是**我们**
 * 主动砍的，说成「连不上」会让人去查网络）。
 */
type Rule = { kind: FailureKind; title: string; needles: readonly string[] };

const RULES: readonly Rule[] = [
  {
    kind: 'quota',
    title: '这个 key 余额不足',
    needles: ['insufficient_quota', '余额', 'quota', '402', 'billing'],
  },
  {
    kind: 'invalid_key',
    title: '这个 key 无效',
    needles: ['401', 'incorrect api key', 'invalid_api_key', 'unauthorized'],
  },
  {
    kind: 'no_access',
    title: '没有权限，或这个模型不可用',
    // `可用渠道不存在` 是 owner 换模型那条线索的原话（`分组 auto 下模型 x 的可用渠道
    // 不存在`）；`无可用渠道` 是同一件事在别的网关里的说法。两个都收。
    needles: ['403', '可用渠道不存在', '无可用渠道', 'model not found', 'does not exist'],
  },
  {
    kind: 'rate_limit',
    title: '被限流了，过一会儿再试',
    needles: ['429', 'rate limit'],
  },
  {
    kind: 'timeout',
    title: '请求超时',
    needles: ['请求超时'],
  },
  {
    kind: 'network',
    title: '连不上模型接口',
    needles: ['fetch failed', 'econnrefused', 'enotfound'],
  },
];

/**
 * 比对残留用的「噪音词」：命中的针之外，这些词本身也不带信息。
 *
 * `HTTP 402` 去掉 402 之后只剩 `HTTP`，那不是「服务端说了什么」，是状态行的格式。
 * 不把它们剔掉，每条 402 都会多一行没用的第二行。
 */
const NOISE = ['http', 'https', 'status', 'code'];

/**
 * 把 key 抹掉。
 *
 * 为什么分类器还要自己洗一遍：`provider.ts` 已经在**它**那条路上洗过了（`redactSecret`），
 * 但这一层要处理的是「任何一句可能带着 key 的文本」——包括将来别的调用方传进来的。
 * 一条会登上界面、还会被截图发出去的字符串，不能只有一处防线。
 *
 * 三条形状覆盖真实见过的回显：
 * 1. `sk-xxxx`：OpenAI 家族的 key 前缀；
 * 2. `Bearer xxxx`：反代把整个 Authorization 吐回来；
 * 3. 32 个字符以上的连续 token：没有前缀的 key（有的网关自己发随机串）。
 *    32 是「比任何单词、模型名、日期都长，比真实 key 都短」的分界：真实 key 一般
 *    32–64 位，而 `gpt-5.4-mini`、`2026-11-06T16:36:32+08:00` 都到不了。
 */
export function scrubSecret(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{4,}/gi, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '***');
}

/** 去掉所有非字母数字与非中文的字符：只用来回答「这句话还剩下什么意思」。 */
function residueOf(raw: string, needles: readonly string[]): string {
  let out = raw.toLowerCase();
  for (const needle of [...needles, ...NOISE]) out = out.split(needle).join(' ');
  return out.replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * 一句服务端的原文 → 一句中文标题（+ 需要时附上原文）。
 *
 * 四条硬规矩：
 * 1. **不发明诊断**。分类只根据针；针不在就返回 `kind:'unknown'`、`title` 就是原文——
 *    编一个「模型出错了」比什么都不说更坏，它会让人去查一个没坏的东西。
 * 2. **原文永远不丢**：分类成功且原文带信息时进 `detail`；分类失败时它就是标题。
 * 3. **空输入也要有话说**：`''` 是「作业没写原因」，界面上必须是一句可读的话。
 * 4. **不吐 key**：进来先 `scrubSecret`（见上）。
 */
export function classifyFailure(raw: string): Failure {
  const text = scrubSecret((raw ?? '').trim());
  if (text === '') return { kind: 'unknown', title: '生成失败，没有给出原因' };

  const lower = text.toLowerCase();
  for (const rule of RULES) {
    const hit = rule.needles.find((needle) => lower.includes(needle));
    if (hit === undefined) continue;
    // 原文比标题多带意思才作为第二行：只多出状态码 / 「HTTP」这类格式词就不带。
    const rest = residueOf(text, rule.needles);
    return rest.length >= 2
      ? { kind: rule.kind, title: rule.title, detail: text }
      : { kind: rule.kind, title: rule.title };
  }

  // 认不出来：原文就是标题，不造第二个名字。
  return { kind: 'unknown', title: text };
}

// ─── 一次尝试的那一行字 ──────────────────────────────────────────────────────

export type AttemptPhase = 'flow' | 'pages' | 'build';

/** 一次尝试（对应 `uemaster_job_attempts` 的一行，只取界面要的几格）。 */
export type AttemptView = {
  /** 阶段内的第几次（1 基）。 */
  attempt: number;
  phase: AttemptPhase;
  model: string;
  promptChars: number;
  outputChars: number;
  /** null = 这一次通过了。 */
  error: string | null;
  ms: number;
};

/** 一行最多这么长：抽屉是 560px 宽的一段，超过就换成一个省略号。 */
const LINE_MAX = 28;

/**
 * 把一句「为什么被拒」压成抽屉里那半行字。
 *
 * 只有一种情况值得专门翻译：形状判据（`上一版只有 2 个节点、1 条连线，而要求是 3–8 个
 * 节点、至少 2 条连线`）——那句话里真正要读的是两个数字，其余是给人看的解释。压成
 * `2 个节点 1 条连线被拒` 之后，三次尝试一眼就能横向比出来。
 *
 * 其余（引擎原文、校验器的句子、provider 的原文）压平、截断，**不改写**：它们是诊断，
 * 改写就等于替服务端说话。
 */
function brief(error: string): string {
  const shape = /只有 (\d+) 个节点、(\d+) 条连线/.exec(error);
  if (shape !== null) return `${shape[1]} 个节点 ${shape[2]} 条连线被拒`;

  const flat = error.replace(/\s+/g, ' ').trim();
  if (flat === '') return '被拒（没有给出原因）';
  return flat.length <= LINE_MAX ? flat : `${flat.slice(0, LINE_MAX)}…`;
}

/**
 * 抽屉「详情」里的一行：`第 1 次 · flow · 2 个节点 1 条连线被拒`。
 *
 * 通过的尝试也照样列出来（`第 2 次 · flow · 1203 字`）：一次失败里最有用的对照往往
 * 是「第一次被拒、第二次过了、第三次卡在别处」。只列失败的那些，读者会以为这一关
 * 从来没通过。
 */
export function attemptLine(view: AttemptView): string {
  const head = `第 ${view.attempt} 次 · ${view.phase}`;
  if (view.error === null) return `${head} · ${view.outputChars} 字`;
  return `${head} · ${brief(view.error)}`;
}
