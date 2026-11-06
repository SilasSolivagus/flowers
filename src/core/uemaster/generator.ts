import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.js';

/**
 * 「把一段任务包变成一份 HTML」的那一层：只认一条命令，别的都不认。
 *
 * P2.6 之前任务包是给人复制的（`复制任务包`），材料要靠用户自己的 agent 生成。
 * 裁决把它反过来：Flowers 自己把包喂给本机装着的 agent CLI，产物落回
 * `data/uemaster/`，抽屉里那一行直接变成链接。这个文件就是「喂」的那一步。
 *
 * 刻意不做的事（越少越好）：
 * - 不引入任何 LLM SDK。跑的是一个已安装的 CLI（`claude` / `codex`），
 *   或者 `FLOWERS_GEN_CMD` 指定的任意命令——它读 stdin、自己写文件，退出码说话。
 * - 不解析模型输出。产物在文件系统里，不在 stdout 里；stdout 只用来在失败时
 *   补一句原因。这是 CLI 们的既有形状（`claude -p` / `codex exec` 都会自己写文件）。
 * - 不重试、不降级。失败了就把 stderr 的尾巴交给用户——他读到的应该是
 *   「OAuth session expired」，而不是一句「生成失败」。
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
};

/** 任务包里那行站内路径。三份包各写一次，形状固定。 */
const SITE_PATH = /\/uemaster\/PAN-\d+\/(?:evaluate|review|inspect)\.html/;

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

export type AgentKind = 'claude' | 'codex';

/**
 * 两种 CLI 的默认命令行。**这里的每个 flag 都是被验证过的**（`claude --help` /
 * `codex exec --help`，2026-11）。
 *
 * `claude -p`：print 模式，非交互；prompt 从 stdin 读（帮助里 prompt 是位置参数，
 * 不给就吃 stdin）。`--permission-mode acceptEdits` 让它在工作目录里**直接写文件**，
 * 不再逐次问人——没有它，一次后台生成会停在权限确认上，直到超时。
 *
 * 为什么是 `acceptEdits` 而不是 `--dangerously-skip-permissions`：这条命令只会收到
 * 一段**固定的任务包**（`packFor` 的输出，人写的模板 + 需求字段），模型要做的事是
 * 「画图、写一个 HTML 到 data/uemaster/」。`acceptEdits` 恰好把「改/写文件」这一格
 * 放开，同时仍不给任意 shell 的免确认执行；而 skip-permissions 连 bash、hook、
 * 网络工具一起放开，对一件事来说太宽。真实的写盘动作是 Write/Edit 工具，不是 bash，
 * 所以 acceptEdits 够用。
 *
 * `codex exec`：非交互。`-` 表示 prompt 从 stdin 读（帮助原文：“If not provided as
 * an argument (or if `-` is used), instructions are read from stdin”）。
 * `--sandbox workspace-write` 是让它能在仓库里写文件的那一格（read-only 会让它写不了
 * 产物）；`--skip-git-repo-check` 是因为部署副本 / 构建产物里不一定有 `.git`，
 * 而这条检查与生成无关。
 */
export const DEFAULT_COMMANDS: Record<AgentKind, string> = {
  claude: 'claude -p --permission-mode acceptEdits',
  codex: 'codex exec --sandbox workspace-write --skip-git-repo-check -',
};

/** 顺序即偏好：装了 claude 就用 claude，否则 codex。 */
const AGENTS: AgentKind[] = ['claude', 'codex'];

/** PATH 里有没有这个可执行文件（不执行它，只问文件系统）。 */
async function onPath(name: string): Promise<boolean> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    try {
      await access(path.join(dir, name), constants.X_OK);
      return true;
    } catch {
      // 继续找下一个目录：找不到是常态，不是错误。
    }
  }
  return false;
}

/**
 * 这次用哪条命令。
 *
 * 1. `FLOWERS_GEN_CMD`（非空）——唯一的口子，也是 stub 用例与「换一个生成器」的入口。
 * 2. 否则自动探测：`claude` → `codex`，用上面那两条默认命令行。
 * 3. 都没有：中文错误，说清楚缺什么。这一句会原样显示在抽屉那一行里。
 */
export async function resolveCommand(): Promise<string> {
  const configured = process.env.FLOWERS_GEN_CMD?.trim();
  if (configured) return configured;

  for (const kind of AGENTS) {
    if (await onPath(kind)) return DEFAULT_COMMANDS[kind];
  }
  throw new AppError(
    'generator_unavailable',
    '本机没有可用的生成器：装好 claude 或 codex 并登录，或设置 FLOWERS_GEN_CMD',
  );
}

/** 终端转义序列（CLI 的彩色输出）不该进到界面里，也不该进到「失败原因」那一行。 */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

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

/**
 * 跑一次生成。
 *
 * 命令从 stdin 拿到完整的任务包，然后**自己**把 HTML 写到包里指定的路径——
 * 这正是 `claude -p` 与 `codex exec` 的工作方式（让 agent 用 Write 工具落盘，
 * 而不是把几 MB 的 HTML 从 stdout 里捞出来）。
 *
 * 失败时返回 `{ ok:false, error }`，error 是 stderr 的**尾巴**：OAuth 过期、
 * 401、模型报错，用户要看到的就是那一句原文。只有 stderr 为空时才退到 stdout，
 * 再退到退出码——绝不把三者混成一句「生成失败」。
 */
export async function runGenerator(pack: string, opts: GenOptions): Promise<GenResult> {
  let url: string;
  try {
    url = artifactUrlIn(pack);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  let command: string;
  try {
    command = await resolveCommand();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  return new Promise<GenResult>((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: GenResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawn(command, {
        cwd: opts.cwd,
        shell: true,
        // 自己一个进程组：超时的时候能把 shell 连同它拉起的 agent 一起杀掉，
        // 而不是留下一个还在写文件的孤儿。
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      // 工作目录不存在、shell 起不来：这是失败，不是拒绝——契约只返回 GenResult。
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    timer = setTimeout(() => {
      killTree(child.pid);
      finish({
        ok: false,
        error: `生成超时（${Math.round(opts.timeoutMs / 1000)} 秒）——命令没有在时限内结束，已终止`,
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
    child.stdin?.end(pack, 'utf8');

    child.on('error', (error) => finish({ ok: false, error: error.message }));

    child.on('close', (code, signal) => {
      if (code === 0) {
        finish({ ok: true, url });
        return;
      }
      const reason = reasonOf(err) || reasonOf(out);
      finish({
        ok: false,
        error: reason === ''
          ? `生成命令失败（${signal ?? `退出码 ${code}`}），没有输出原因`
          : reason,
      });
    });
  });
}
