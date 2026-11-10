import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../errors.js';
import {
  commandReady, credentialEnvFor, placeholderIn, type Candidate,
} from './candidates.js';
import { detect } from './detect.js';
import { adoptLegacyArtifact } from './store.js';

/**
 * 「把一段任务包变成一份 HTML」的那一层：只认一条命令，别的都不认。
 *
 * P2.6 之前任务包是给人复制的（`复制任务包`），材料要靠用户自己的 agent 生成。
 * 裁决把它反过来：Flowers 自己把包喂给本机装着的 CLI，产物落回 `data/uemaster/`，
 * 抽屉里那一行直接变成链接。这个文件就是「喂」的那一步。
 *
 * P2.7 改掉了 P2.6 的一条策略：「claude，否则 codex」是**一台机器上的运气**被写成了
 * 产品规则。现在这里是三件事，各占一段：
 *
 * 1. **命令契约**（`commandFor` + `runRaw`）：模板里有 `{prompt}` 就把它当 argv 的
 *    一个元素传（`dsh headless {prompt}`），没有就走 stdin（`claude -p`、`codex exec -`、
 *    `ollama run x`）。这两条覆盖了本机这五个候选的全部形状。
 * 2. **产物契约**（`runGenerator`）：命令退出 0 之后，**先看文件、再看 stdout**——
 *    产物文件是新鲜的（mtime 变了）就用它；文件没动而 stdout 里有一个 HTML 文档，
 *    就由这一层自己写进产物路径；两者都没有才算失败。这一条是 `ollama` 或任何
 *    「管道式」生成器能成立的全部原因：它们不会写文件，只会把 HTML 打到 stdout。
 * 3. **解析顺序**（`resolveGenerator`）：`FLOWERS_GEN_CMD` → 库里存着的那条
 *    （`app_settings.generator.command`）→ 没配就 `choose`（界面问一次，选完落库）。
 *    一条可执行文件都没有才是 `none`。P2.8 起「只探到一条就自动用」这条被删掉：
 *    第一次没人答应过的事，不该由 PATH 代答。
 *
 * 刻意不做的事（越少越好）：
 * - 不引入任何 LLM SDK，也不解析模型输出。
 * - 不重试、不降级。失败了就把 stderr 的尾巴交给用户——他读到的应该是
 *   「OAuth session expired」或「MISSING_CREDENTIAL」，而不是一句「生成失败」。
 *
 * 契约（对 worker 而言只有这一个函数）：
 * ```
 * runGenerator(pack, { cwd, timeoutMs }): Promise<{ ok:true; url } | { ok:false; error }>
 * ```
 * `url` 不是模型给的，是从**包本身**里读出来的：包在「交付」那一段写死了
 * `data/uemaster/<PAN-n>/<stage>.html` 与站内路径 `/uemaster/<PAN-n>/<stage>.html`
 * （见 `packs.ts`）。包怎么写、文件就该在哪，这一条不靠调用方再猜一次。
 */

export type GenResult = { ok: true; url: string } | { ok: false; error: string };

export type GenOptions = {
  /** 命令的工作目录：任务包里的「本项目根目录」就是它。 */
  cwd: string;
  /** 硬超时。到点就杀掉整个进程组，返回失败——绝不让一次生成挂死在那里。 */
  timeoutMs: number;
  /** 这次用的命令。不传时按 env → 探测自己解析；解析不出唯一一条就失败。 */
  command?: string;
  /** 产物文件的绝对路径。有它才做「文件 / stdout」二选一。 */
  file?: string;
  /** 跑之前的 mtime（null = 之前不存在）。用来判断文件是不是这一次写的。 */
  before?: number | null;
  /** 这一次要给子进程补的模型凭据（见 `credentialFor`）；null / 不传 = 不补。 */
  credential?: Credential | null;
};

// ─── 凭据：把库里那把 key 交给 harness ──────────────────────────────────────

/**
 * 一次跑要补的一个环境变量。
 *
 * **只存变量名与值，不进日志、不进界面、不进返回值。** 它唯一的作用域是 `runRaw` 的
 * `spawn(env)`——用完即弃。
 */
export type Credential = { env: string; value: string };

/**
 * 库里那把 key → 这一次该补的变量（`{env:'DEEPSEEK_API_KEY', value:'sk-…'}`）。
 *
 * 2026-11-10 的接线修正，起因是 owner 在设置页看到的那一行：
 *
 * ```
 * 失败：dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route
 * "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service,
 * or export DEEPSEEK_API_KEY in the launching environment
 * ```
 *
 * 同一台机器上 `provider.apiKey` 存着一把能用的 key（评估流水线一直在用）。所以这里
 * 做一件事：**按候选表约定的变量名，把 key 交给子进程的环境**。dsh 的文档把「启动环境」
 * 列为合法的凭据来源之一，而我们的 `spawn` 就是它的启动环境——不需要用户去 shell 里
 * `export`，也不需要我们写别人的凭据存储。
 *
 * 三条边界：
 * - 命令不是需要凭据的候选（`credentialEnvFor` 返回 null）→ 不补。自建命令的凭据由
 *   用户自己负责：替他猜一个变量名比不猜更糟。
 * - 没有 key（空串 / null）→ 不补，也**不覆盖**父进程的环境。这时若 shell 里本来有
 *   `DEEPSEEK_API_KEY`，CLI 照旧能用它——那是用户的兜底，不该被我们抹掉。
 * - **不转发 `provider.baseUrl`**：dsh 的 `DEEPSEEK_BASE_URL` 要的是 Messages 兼容根
 *   （`https://api.deepseek.com/anthropic`），而我们的三格是 OpenAI 兼容根
 *   （`https://api.deepseek.com/v1`）。把后者塞过去会把它**从一个能用的默认地址改成
 *   一个不兼容的地址**——那是拿一次修 bug 换一个新 bug。
 */
export function credentialFor(
  command: string,
  apiKey: string | null | undefined,
): Credential | null {
  const value = apiKey?.trim() ?? '';
  if (value === '') return null;
  const env = credentialEnvFor(command);
  return env === null ? null : { env, value };
}

/**
 * 子进程的环境：父进程那一份打底，补上这一条。
 *
 * 为什么必须继承：PATH、HOME 这些是 CLI 找自己配置（`~/.dsh`、`~/.codex`）的依据，
 * 只给一条 `DEEPSEEK_API_KEY` 会让它变成一个「装了也找不到自己」的进程。
 */
function childEnv(credential: Credential | null | undefined): NodeJS.ProcessEnv {
  if (credential === null || credential === undefined) return process.env;
  return { ...process.env, [credential.env]: credential.value };
}

/**
 * 任务包里那行站内路径。三份包各写一次，形状固定。
 *
 * 2026-11-10 起带可选的版本段（`evaluate-v003.html`）：新包一定带（`packs.ts` 的
 * `versionedName`），老包 / 存量示例没有。两种都要认——这个正则解析的是**包**，
 * 而包是可能从别处粘贴进来的（`uemaster_plan` 的返回值、文档里的示例）。
 *
 * `\d+` 而不是 `\d{3}`：三位是今天写出去的形状，读回来的口径不该比写出去的更窄
 * （第 1000 版会是 `v1000`）。
 */
const SITE_PATH = /\/uemaster\/PAN-\d+\/(?:evaluate|review|inspect)(?:-v\d+)?\.html/;

/**
 * 从任务包里取出这次要交回的站内路径。
 *
 * 抛错也只是内部用：`runGenerator` 会把它折成 `{ ok:false }`，因为对用户来说
 * 「包坏了」和「命令失败了」是同一件事——这一次生成没成，原因写在 error 里。
 */
export function artifactUrlIn(pack: string): string {
  const found = SITE_PATH.exec(pack);
  if (!found) throw new AppError('invalid_pack', '任务包里没有产物路径');
  return found[0];
}

// ─── 解析：这次跑什么 ────────────────────────────────────────────────────────

export type GenSource = 'env' | 'settings';

/**
 * 解析的结果。三种形状对应界面上的三件事：
 * - `ready`：有唯一一条命令，可以跑（`source` 说明它是从哪来的）；
 * - `choose`：还没选（第一次用）。界面弹**一次**那个小对话框，选完就再也不问；
 * - `none`：这台机器上一份可执行文件都没有，按钮禁用并指路。
 */
export type Resolution =
  | { kind: 'ready'; command: string; source: GenSource }
  | { kind: 'choose'; candidates: Candidate[] }
  | { kind: 'none' };

/**
 * 这次用哪条命令。
 *
 * 1. `FLOWERS_GEN_CMD`（非空）——唯一的口子，也是 stub 用例与「临时换一条」的入口。
 * 2. 库里存着的那条（用户在下拉里选过、并且按过「测试并使用」）。
 * 3. 都没配：**探测到几个都是 `choose`**。
 *
 * 第 3 条是 P2.8 改掉的：P2.7 在「只探到一条」时直接用它，理由是「只装了一个的人
 * 每次都被问一次是把配置问题变成日常税」。但那个理由只对**第二次以后**成立——
 * 第一次他什么都没答应过，自动选中等于替他做了决定，而下拉里另外六行（包括两个
 * 未安装的）他从没见过。现在第一次一律问一次（预选装了的第一个，一次确认），
 * 回答落库之后，这一支再也不会走到。
 *
 * 零条仍然是 `none`：那不是一次选择，是缺东西。
 */
export async function resolveGenerator(saved: string | null): Promise<Resolution> {
  const configured = process.env.FLOWERS_GEN_CMD?.trim();
  if (configured) {
    return { kind: 'ready', command: configured, source: 'env' };
  }
  const stored = saved?.trim();
  if (stored) {
    return { kind: 'ready', command: stored, source: 'settings' };
  }

  const found = await detect();
  if (found.length === 0) return { kind: 'none' };
  return { kind: 'choose', candidates: found.map((item) => item.candidate) };
}

// ─── 命令的形状：stdin 还是 {prompt} ─────────────────────────────────────────

/** 模板里的任务包槽位。 */
const PROMPT_SLOT = '{prompt}';

/**
 * 把一段任意文本变成 shell 里的**一个** argv 元素。
 *
 * 任务包里什么都有：换行、单引号、反引号、`$(...)`、中文。单引号包裹是 POSIX sh
 * 里唯一不用逐字符转义的形状，而单引号自己用 `'\''` 拼接——这是 shell 引号的标准
 * 做法，不是土办法。命令模板是用户给的、走 `shell: true`（`FLOWERS_GEN_CMD` 可能
 * 自带管道或 env 前缀），所以这一段必须在 shell 那一层就正确，而不是靠 spawn 的
 * argv 数组——那条路只对「命令本身就是数组」的情况成立。
 */
export function quoteForShell(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * 模板 + 任务包 → 真会被执行的那一行，以及任务包走不走 stdin。
 *
 * 两种模式不是风格选择，是这五个 CLI 的既成事实：`claude -p` / `codex exec -` /
 * `ollama run x` 从 stdin 读；`dsh headless` 收位置参数，给 stdin 它会忽略。
 */
export function commandFor(template: string, pack: string): { line: string; stdin: boolean } {
  if (template.includes(PROMPT_SLOT)) {
    return { line: template.split(PROMPT_SLOT).join(quoteForShell(pack)), stdin: false };
  }
  return { line: template, stdin: true };
}

// ─── 跑一条命令 ──────────────────────────────────────────────────────────────

/**
 * 终端转义序列不该进到界面里，也不该进到「失败原因」那一行。
 *
 * 除了 CSI（`ESC [ … 字母`，彩色与光标控制），还要吃掉 OSC（`ESC ] … BEL`，窗口标题、
 * 超链接）与单字符转义——`ollama run` 在非 TTY 下吐的就是 CSI 加光标控制，
 * 而且它们**插在 token 内部**（`<!␛[?25lDOCTYPE`），只能在切 HTML 之前整段清掉。
 */
const ANSI = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/**
 * Node 自己打在 stderr 上的运行时告警。
 *
 * 本机的环境里每条 `node` 进程都会先吐一行 `(node:123) [UNDICI-EHPA] Warning: …`
 * 加一行 `(Use \`node --trace-warnings\` …)`，再说真正的事。它不是生成器的答案，
 * 但会排在「Failed to authenticate: OAuth session expired」前面——界面那一行
 * 因此变成一句关于代理实现的噪声。过滤掉它，用户读到的第一句就是他要修的那件事。
 * 只认这个形状（`(node:<pid>) …Warning:` / `(Use \`node --trace-warnings\``），
 * 不按「Warning」这个词泛过滤：CLI 自己的警告可能是原因的一部分。
 */
const NODE_NOISE = /^\(node:\d+\) .*Warning:|\(Use `node --trace-warnings/;

/** 累计缓冲的上限：只为了在失败时给一句话，不需要整段日志。 */
const BUFFER = 8000;

/** 输出尾巴：足够长到看得懂（一整条报错 + 它的上下文），足够短到塞得进一行。 */
const TAIL = 2000;

/** 失败原因：去转义、去 Node 噪声行、留最后 2000 字。 */
function reasonOf(text: string): string {
  const clean = text
    .replace(ANSI, '')
    .split('\n')
    .filter((line) => !NODE_NOISE.test(line.trim()))
    .join('\n')
    .trim();
  return clean.length <= TAIL ? clean : clean.slice(clean.length - TAIL);
}

/** 只留尾巴，避免一次生成刷出几十 MB 的日志把内存吃满。 */
function keepTail(text: string): string {
  return text.length <= BUFFER ? text : text.slice(text.length - BUFFER);
}

/** 杀掉整个进程组：`shell: true` 时 child 是 shell，真跑命令的是它的子进程。 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // 组已经没了（命令自己退出 / 被系统收回）：没有别的动作可做。
  }
}

type RawRun = {
  /** 命令自己退出 0。 */
  ok: boolean;
  /** 被硬超时杀掉。 */
  timedOut: boolean;
  out: string;
  err: string;
  ms: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** 连进程都没起来（工作目录不存在之类）。 */
  spawnError: string | null;
};

/**
 * 跑一行命令，收集 stdout / stderr 的尾巴，到点连进程组一起杀。
 *
 * 这一层只管「一条 shell 命令跑完了没有、说了什么」，不知道任务包、不知道产物。
 * 两件上层的事（真生成、设置页那 10 秒小测）都从它出发，于是超时、进程组、
 * 噪声过滤只有一份实现。
 */
function runRaw(line: string, opts: {
  cwd: string; timeoutMs: number; stdin: string | null;
  /** 这一次要补的凭据（见 `credentialFor`）；null / 不传 = 用父进程的环境。 */
  credential?: Credential | null;
}): Promise<RawRun> {
  return new Promise<RawRun>((resolve) => {
    const started = Date.now();
    let out = '';
    let err = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: Omit<RawRun, 'ms'>): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({ ...result, ms: Date.now() - started });
    };

    let child;
    try {
      child = spawn(line, {
        cwd: opts.cwd,
        // 环境是「dsh 的启动环境」：库里那把 key 从这一条进去，用户不必在 shell 里 export。
        env: childEnv(opts.credential),
        shell: true,
        // 自己一个进程组：超时的时候能把 shell 连同它拉起的 agent 一起杀掉，
        // 而不是留下一个还在写文件的孤儿。
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      // 工作目录不存在、shell 起不来：这是失败，不是拒绝。
      finish({
        ok: false, timedOut: false, out: '', err: '',
        code: null, signal: null,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    timer = setTimeout(() => {
      killTree(child.pid);
      finish({
        ok: false, timedOut: true, out, err: keepTail(err),
        code: null, signal: null, spawnError: null,
      });
    }, opts.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      out = keepTail(out + chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err = keepTail(err + chunk.toString('utf8'));
    });

    // 子进程不读 stdin 就退出（例如立刻认证失败）时，写入会 EPIPE——那已经由 close
    // 的退出码回答，不需要多一条未捕获异常。
    child.stdin?.on('error', () => undefined);
    if (opts.stdin === null) child.stdin?.end();
    else child.stdin?.end(opts.stdin, 'utf8');

    child.on('error', (error) => {
      finish({
        ok: false, timedOut: false, out, err: keepTail(err),
        code: null, signal: null, spawnError: error.message,
      });
    });

    child.on('close', (code, signal) => {
      finish({ ok: code === 0, timedOut: false, out, err: keepTail(err), code, signal, spawnError: null });
    });
  });
}

/** 失败的那一句：stderr 优先、stdout 次之、退出码兜底。绝不混成「生成失败」。 */
function failureText(raw: RawRun): string {
  if (raw.spawnError !== null) return raw.spawnError;
  if (raw.timedOut) return ''; // 超时由调用方写它自己的那一句（带秒数）
  const reason = reasonOf(raw.err) || reasonOf(raw.out);
  if (reason !== '') return reason;
  const how = raw.signal ?? `退出码 ${raw.code}`;
  return `生成命令失败（${how}），没有输出原因`;
}

// ─── 产物：文件模式 / stdout 模式 ───────────────────────────────────────────

/**
 * stdout 里那一段 HTML 文档，没有就 null。
 *
 * 「包含」而不是「以…开头」：agent CLI 在 stdout 里会先讲两句人话（「我来生成…」），
 * 再把文档贴出来；`ollama run` 更会带上自己的提示与统计。从第一个 `<!doctype html>`
 * 或 `<html` 开始截到结尾，是这几种输出都能成立的读法——后置的废话留在文件里也不会
 * 改变它是一份 HTML 这件事（浏览器照样渲染）。
 */
/**
 * 把终端控制符从文本里清掉。
 *
 * 为什么必须有这一步：`ollama run` 在非 TTY 之下仍然会吐进度桁架与光标控制码，
 * 而且它们**插在文档中间**——实测拿到的是 `<!␛[?25lDOCTYPE␛[?25h html>`。
 * 只按 `<!doctype` 切片是切不掉的：那些字节在 token 内部。不清干净，落盘的 HTML
 * 从 doctype 起就已经坏了（浏览器退回怪异模式，样式全变）。
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/\r(?!\n)/g, '');
}

export function htmlDocumentIn(raw: string): string | null {
  const text = stripAnsi(raw);
  const lower = text.toLowerCase();
  const doctype = lower.indexOf('<!doctype html');
  const root = lower.search(/<html[\s>]/);
  const starts = [doctype, root].filter((index) => index >= 0);
  if (starts.length === 0) return null;
  const from = Math.min(...starts);
  const doc = text.slice(from).trim();
  return doc === '' ? null : doc;
}

/** 文件在不在、什么时候写的。`null` = 不在。 */
async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

// ─── 真生成 ──────────────────────────────────────────────────────────────────

/**
 * 跑一次生成。
 *
 * 命令从 stdin（或 `{prompt}` 那个 argv 位）拿到完整的任务包，然后**自己**把 HTML
 * 交出来——两种交法都收，见文件头第 2 条：写文件，或者打到 stdout。
 *
 * 失败时返回 `{ ok:false, error }`，error 是 stderr 的**尾巴**：OAuth 过期、
 * 401、模型报错，用户要看到的就是那一句原文。只有 stderr 为空时才退到 stdout，
 * 再退到退出码。
 */
export async function runGenerator(pack: string, opts: GenOptions): Promise<GenResult> {
  let url: string;
  try {
    url = artifactUrlIn(pack);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  let command = opts.command;
  if (command === undefined) {
    const resolution = await resolveGenerator(null);
    if (resolution.kind !== 'ready') {
      return {
        ok: false,
        error: resolution.kind === 'choose'
          ? '还没选生成器：在「生成」里选一个，按「测试并使用」'
          : '未检测到生成器：到「设置 · 项目 · 生成器」配置一条',
      };
    }
    command = resolution.command;
  }

  // 未填的占位符（`ollama run <模型名>`）绝不能交给 shell：那是重定向，失败原因会
  // 与生成毫无关系。在这里说清楚要填什么。
  const placeholder = placeholderIn(command);
  if (placeholder !== null) {
    return { ok: false, error: `生成命令里还有占位符 ${placeholder}，先在设置里把它填上` };
  }
  if (!commandReady(command)) {
    return { ok: false, error: '生成命令是空的：到「设置 · 项目 · 生成器」配置一条' };
  }

  const { line, stdin } = commandFor(command, pack);
  const raw = await runRaw(line, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    stdin: stdin ? pack : null,
    credential: opts.credential ?? null,
  });

  if (raw.timedOut) {
    return {
      ok: false,
      error: `生成超时（${Math.round(opts.timeoutMs / 1000)} 秒）——命令没有在时限内结束，已终止`,
    };
  }
  if (!raw.ok) return { ok: false, error: failureText(raw) };

  // 没有产物路径可比对（调用方自己管文件）：退出 0 就是成功。
  if (opts.file === undefined) return { ok: true, url };

  /**
   * 命令跑完了，先把它写出来的文件**收到产物根**里再比 mtime。
   *
   * 任务包对外部 CLI 说的仍是「写到本项目根目录下的 `data/uemaster/…`」（agent CLI 的
   * 写权限通常被限制在 cwd 之内，改成一个家目录外的绝对路径只会换来拒绝写入），
   * 而产物根在仓库外（见 `store.ts` 的 `adoptLegacyArtifact`）。所以在「看文件」这一步
   * 之前必须搬一次——否则这里会看到「文件不存在」，而它其实就在仓库里躺着。
   *
   * 放在 `runGenerator` 里而不是调用方：文件模式的判断（新鲜 / 不存在 / stdout 兜底）
   * 全部发生在这一层，搬晚了就轮不到它了。
   */
  adoptLegacyArtifact(url);

  const after = await mtimeOf(opts.file);
  const before = opts.before ?? null;
  const fresh = after !== null && (before === null || after !== before);

  // 文件模式：命令自己写出来了，而且确实是这一次写的（mtime 变了）。
  if (fresh) return { ok: true, url };

  // stdout 模式：命令没写文件，但把文档打在 stdout 里——这一层替它落盘。
  // 这一条是 `ollama run x` 这类纯管道生成器唯一的活路。
  const html = htmlDocumentIn(raw.out);
  if (html !== null) {
    try {
      await mkdir(path.dirname(opts.file), { recursive: true });
      await writeFile(opts.file, html, 'utf8');
    } catch (error) {
      return {
        ok: false,
        error: `命令把 HTML 打到了 stdout，但写不进产物文件：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return { ok: true, url };
  }

  return {
    ok: false,
    error: after === null
      ? `生成命令已结束，但产物文件不存在：data${url}`
      : `生成命令已结束，但产物文件没有更新：data${url}`,
  };
}

// ─── 设置页那 10 秒小测 ──────────────────────────────────────────────────────

/**
 * 测试用的固定小包。
 *
 * 它**不是**任务包：没有 PAN 编号、没有产物路径，也不许携带任何需求内容。它只问
 * 一件事——这条命令会不会真的跑出一份 HTML。所以它写得极小、极具体，任何合格的
 * 生成器（agent CLI 或本地模型）都能完成，也不会因为「它不知道 UEmaster 是什么」
 * 而失败。
 */
export const TEST_PACK = '生成一个 HTML 文档，<title>flowers</title>，正文一行 hello';

/** 小测的硬超时：10 秒。等得起，又短到在一行里能说清「它没动」。 */
// 45 秒：10 秒对真实 agent CLI 太短——codex 在 10 秒内连 401 都说不完（实测 15 秒才吐
// refresh token 错误），而一个能用的小模型跑出几百字节 HTML 也要 20 秒上下。测试是用户
// 主动点的、可以等，宁可多等也不要给出「超时」这种假阴性。
export const TEST_TIMEOUT_MS = 45_000;

export type TestResult =
  | { ok: true; size: number; ms: number; mode: 'file' | 'stdout' }
  | { ok: false; error: string; ms: number };

/** 临时目录里任何一份 HTML（命令写文件的情况）。最多看两层，够用又不扫全盘。 */
async function firstHtml(dir: string, depth = 2): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && /\.html?$/i.test(entry.name)) return full;
  }
  if (depth <= 1) return null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await firstHtml(path.join(dir, entry.name), depth - 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * 就地测一条命令：真跑一次，10 秒，看它到底交不交得出 HTML。
 *
 * 这是全仓库**唯一**能回答「它能不能用」的地方。`--version` 不行（装了就有版本），
 * `login status` 不行（本机的 codex 在这一步说了谎），PATH 不行（只说明装了）。
 * 所以设置页的「测试」不是装饰：它与真生成走同一条 `commandFor` + `runRaw`，
 * 两种交法（写文件 / stdout）都认，成功时报出产物大小与耗时，失败时把 stderr
 * 原文照登。
 *
 * 跑在系统临时目录里：一次小测不该在仓库里留下任何文件，也不该被仓库里的旧产物
 * 骗成「通过」。
 */
export async function testGenerator(
  command: string,
  opts: { timeoutMs?: number; credential?: Credential | null } = {},
): Promise<TestResult> {
  const timeoutMs = opts.timeoutMs ?? TEST_TIMEOUT_MS;

  const placeholder = placeholderIn(command);
  if (placeholder !== null) {
    return { ok: false, error: `命令里还有占位符 ${placeholder}，先填上再测`, ms: 0 };
  }
  if (!commandReady(command)) {
    return { ok: false, error: '命令是空的', ms: 0 };
  }

  let dir: string;
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'flowers-gen-'));
  } catch (error) {
    return { ok: false, error: `建不了临时目录：${error instanceof Error ? error.message : String(error)}`, ms: 0 };
  }

  const { line, stdin } = commandFor(command, TEST_PACK);
  try {
    // 永远跑在临时目录里：小测不该在仓库里留下文件，也不该被仓库里的旧产物骗成「通过」。
    const raw = await runRaw(line, {
      cwd: dir, timeoutMs, stdin: stdin ? TEST_PACK : null, credential: opts.credential ?? null,
    });
    if (raw.timedOut) {
      return { ok: false, error: `超时（${Math.round(timeoutMs / 1000)} 秒）没有结束`, ms: raw.ms };
    }
    if (!raw.ok) return { ok: false, error: failureText(raw), ms: raw.ms };

    const file = await firstHtml(dir);
    if (file !== null) {
      const size = (await stat(file)).size;
      return { ok: true, size, ms: raw.ms, mode: 'file' };
    }
    const html = htmlDocumentIn(raw.out);
    if (html !== null) {
      return { ok: true, size: Buffer.byteLength(html, 'utf8'), ms: raw.ms, mode: 'stdout' };
    }
    return {
      ok: false,
      error: reasonOf(raw.err) || '命令退出 0，但没有写出 HTML，stdout 里也没有',
      ms: raw.ms,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
