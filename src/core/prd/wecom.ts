import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { db as appDb } from '../../db/client.js';
import { readSetting, type Queryable } from '../uemaster/settings.js';

/**
 * 走查的 PRD 层：**用企业微信自己的 CLI 读一份在线文档的正文**。
 *
 * 为什么不自己调开放平台接口：`wecom-cli` 是厂商自己的命令行（`@wecom/cli`），
 * 它已经处理了鉴权（`auth init` 扫码后本地留 token）与文档品类。我们这边只做
 * 一件事：**把一条链接交给它，拿回 Markdown**。
 *
 * ─── 这一层是对着 v1.3.4 那台机器写的，不是对着 skill 文档写的 ─────────────
 *
 * 厂商 skill 文档给的 `doc get_doc_content '{"url":…,"type":2}'` 在 v1.3.4 里
 * **不存在**（`error: unrecognized subcommand 'get_doc_content'`），而且这一版
 * **没有异步导出、没有 `task_id`、没有 `task_done`**。真实的读口只有一个，同步：
 *
 * ```bash
 * wecom-cli doc contents get --docid "<url 或 docid>"   # 默认就是 markdown
 * ```
 *
 * 它回**一个** JSON 对象：
 *
 * ```json
 * { "errcode": 0, "url": "…", "name": "📖 123云盘 · PRD导航中心（管理端）",
 *   "creator_name": "…", "create_time": "…", "content": "…Markdown…",
 *   "security_notice": "<security_notice>…</security_notice>",
 *   "extra_identity_context": "<extra_identity_context>…</extra_identity_context>" }
 * ```
 *
 * 所以这里没有轮询、没有 task_id、没有「换一套命令形状重试」：一次调用，一次答案。
 * 早先按 skill 文档写的那一版（两段轮询 + 命令形状回落）已经整段删掉——它描述的
 * 是另一个版本，留着只会让人以为轮询真的有用。
 *
 * 三条硬规矩，与前一层（`codemirror/mirror.ts`）同形：
 *
 * 1. **没有 shell。** argv 数组交给 `execFile`。链接里可能有 `?scode=…&…`、
 *    中文标题、甚至 `$(…)`——走 shell 就等于把这段文本再解释一遍。
 * 2. **失败是数据，不是异常。** 没装 CLI、没授权、errcode 非 0、超时、空正文，
 *    一律 `{ ok:false, code, message }`，message 是中文，且说得出口下一步做什么。
 * 3. **不碰凭证，也不收包装字段。** CLI 的 stderr/stdout 会进消息，所以先过
 *    `redact()`；而 `security_notice` / `extra_identity_context` 是 CLI 注入的
 *    样板（后者还明说不要外传），一律在 `contentOf()` 里剥掉——它们既不该进库，
 *    也不该进模型。
 */

// ─── 形状 ────────────────────────────────────────────────────────────────────

/** 链接是哪一类文档。`unknown` 是「这不是企业微信文档链接」。 */
export type DocKind = 'doc' | 'sheet' | 'smartsheet' | 'smartpage' | 'unknown';

/** 失败码：调用方按它分支，人读 `message`。 */
export type DocFailCode =
  | 'unknown_kind'      // 链接不是认得的品类
  | 'unsupported_kind'  // 智能表格 / 智能文档：本版不做（各自有自己的服务）
  | 'bad_config'        // 读不到设置（库错误）
  | 'missing_binary'    // CLI 没装
  | 'unauthorized'      // CLI 没授权
  | 'cli_failed'        // 进程失败（退出码非 0，且不是上面两种）
  | 'bad_output'        // stdout 不是 JSON
  | 'errcode'           // errcode 非 0（errmsg 原样带出）
  | 'empty_content'     // errcode 为 0 但正文是空的
  | 'timeout';          // 单次调用超过预算

export type DocRead =
  | { ok: true; markdown: string; title: string | null; kind: DocKind }
  | { ok: false; code: DocFailCode; message: string };

export function fail(code: DocFailCode, message: string): DocRead {
  return { ok: false, code, message };
}

// ─── 配置：一个可执行文件的路径 ──────────────────────────────────────────────

/** 二进制的三级解析：环境变量 → `app_settings` → PATH 上的名字。 */
export const ENV_CLI = 'FLOWERS_WECOM_CLI';
export const SETTING_CLI = 'wecom.cliPath';
export const DEFAULT_BIN = 'wecom-cli';

export type CliPath =
  | { ok: true; bin: string }
  | { ok: false; code: DocFailCode; message: string };

/**
 * 解析可执行文件路径。
 *
 * 环境变量优先：用例里换的是它（一个临时目录里的假 CLI），那条路因此**不碰库**，
 * 也就不需要为「读设置失败」编一个假库。设置那一格是给设置页用的：换了一台装了
 * 另一个版本 CLI 的机器，不想改部署的环境变量。
 */
export async function resolveCli(database: Queryable = appDb): Promise<CliPath> {
  const env = process.env[ENV_CLI]?.trim() ?? '';
  if (env !== '') return { ok: true, bin: env };
  try {
    const value = (await readSetting(database, SETTING_CLI))?.trim() ?? '';
    return { ok: true, bin: value === '' ? DEFAULT_BIN : value };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: 'bad_config',
      message: `读不到设置「${SETTING_CLI}」：数据库错误（${detail}）`,
    };
  }
}

// ─── URL 路由 ────────────────────────────────────────────────────────────────

/** 认得的路径段。顺序无关：只取第一段。 */
const KIND_BY_SEGMENT: Record<string, DocKind> = {
  doc: 'doc',
  sheet: 'sheet',
  smartsheet: 'smartsheet',
  // 老链接里出现过 smartmatrix 这个写法；与 smartsheet 是同一类东西（智能表格）。
  smartmatrix: 'smartsheet',
  smartpage: 'smartpage',
};

/**
 * 只认 http(s) 的企业微信文档链接，按**路径第一段**分品类。
 *
 * 为什么按路径而不是按 host：`doc.weixin.qq.com`、`docs.qq.com` 都出现过，而品类
 * 信息在路径里（`/doc/<docid>`）。host 只在 `new URL` 那一关看，而且只是
 * 「是不是一个能解析的 URL」。
 */
export function classifyUrl(input: string): DocKind {
  const raw = input.trim();
  if (raw === '') return 'unknown';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'unknown';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'unknown';
  const first = url.pathname.split('/').filter((segment) => segment !== '')[0]?.toLowerCase();
  if (first === undefined) return 'unknown';
  return KIND_BY_SEGMENT[first] ?? 'unknown';
}

/** `unknown` 的那句话要把「期望的形状」写出来，否则用户只知道错了。 */
const UNKNOWN_HINT = '只认企业微信文档链接：https://doc.weixin.qq.com/doc/<docid> 或 /sheet/<docid>；'
  + '智能表格（/smartsheet/）与智能文档（/smartpage/）各自是另一个服务，本版不读';

// ─── 命令形状 ────────────────────────────────────────────────────────────────

/**
 * 一次读的 argv（v1.3.4 实测形状）。
 *
 * `--docid` 既收 docid 也收整条 url；`--content-type markdown` 写出来只是因为
 * 「默认值不写」这件事在两个版本之间并不保证。整条命令是 argv 数组——url 里的
 * `&`、`$(…)`、中文都只当一个参数值。
 */
export function argvOf(kind: 'doc' | 'sheet', url: string): string[] {
  void kind; // doc 与 sheet 走同一个读口，品类只影响标题/记录的语义
  return ['doc', 'contents', 'get', '--docid', url, '--content-type', 'markdown'];
}

// ─── 脱敏与包装字段 ──────────────────────────────────────────────────────────

/**
 * 把 CLI 输出里**看起来是凭证**的东西打码。
 *
 * 为什么做在出口而不是「指望 CLI 不打印」：`errcode` 的消息有时会把出错的请求
 * 回显一段（`access_token=…`、`Authorization: Bearer …`），而我们的 message 会进
 * 界面、进事件、进报告。打码是最便宜的一道闸。
 */
export function redact(text: string): string {
  return text.replace(
    // 键名 + 分隔符 +（可选的 Bearer/Basic 方案）+ 值，一次吃掉：先吃 `Authorization:
    // Bearer xxx` 里的 `Bearer` 会留下没人认领的 token，分两遍反而更难写对。
    /\b(access[_-]?token|refresh[_-]?token|authorization|bearer|api[_-]?key|secret|password|token)\b(\s*[:=]\s*)(?:(?:bearer|basic)\s+)?([^\s,;"'&）)]+)/gi,
    (_match, key: string, sep: string) => `${key}${sep}***`,
  );
}

/** stderr 的尾巴：整段可能是几十行 warning，报错那一行只要最后一段。 */
export function tail(text: string, max = 600): string {
  const trimmed = text.trim();
  const cut = trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
  return redact(cut);
}

/**
 * 包装字段：CLI 在正文之外塞进来的两段样板。
 *
 * `extra_identity_context` 里明写着「不要对外披露」，`security_notice` 是一段安全
 * 提示——两者都不是文档内容。它们**既不该进快照**（快照存在的意义是「PRD 这一版
 * 长什么样」，样板会让每一版的 hash 都不同，去重永远失效），也不该进模型（模型会
 * 把其中的指令当成需求的一部分）。
 *
 * 顶层的那两个字段我们本来就不读；这里额外处理「被拼进 content 里」的情形——
 * 版本之间不保证它们只出现一次、只出现在顶层。
 */
export function stripWrappers(markdown: string): string {
  return markdown
    .replace(/<security_notice>[\s\S]*?<\/security_notice>/gi, '')
    .replace(/<extra_identity_context>[\s\S]*?<\/extra_identity_context>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── 跑一次 ──────────────────────────────────────────────────────────────────

type Run = {
  exitCode: number | null;
  timedOut: boolean;
  /** 进程根本没起来（ENOENT / EACCES）。 */
  spawnError: NodeJS.ErrnoException | null;
  stdout: string;
  stderr: string;
};

const MAX_BUFFER = 32 * 1024 * 1024;

/** 跑一次 argv，**永远 resolve**；失败是一种数据。 */
function runOnce(bin: string, argv: string[], timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      bin,
      argv,
      {
        timeout: Math.max(1, Math.floor(timeoutMs)),
        killSignal: 'SIGTERM',
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
        const err = typeof stderr === 'string' ? stderr : String(stderr ?? '');
        if (error === null) {
          resolve({ exitCode: 0, timedOut: false, spawnError: null, stdout: out, stderr: err });
          return;
        }
        const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string };
        if (typeof e.code === 'string') {
          resolve({ exitCode: null, timedOut: false, spawnError: e, stdout: out, stderr: err });
          return;
        }
        const timedOut = Boolean(e.killed) && (e.signal === 'SIGTERM' || e.signal === 'SIGKILL');
        resolve({
          exitCode: typeof e.code === 'number' ? e.code : null,
          timedOut,
          spawnError: null,
          stdout: out,
          stderr: err,
        });
      },
    );
  });
}

// ─── 响应解析 ────────────────────────────────────────────────────────────────

/** `doc contents get` 的响应。字段全可选：不同文档类型回的字段不完全一样。 */
export type CliResponse = {
  errcode?: unknown;
  errmsg?: unknown;
  url?: unknown;
  /** 文档标题（**优先用它**，不是从 Markdown 里猜）。 */
  name?: unknown;
  creator_name?: unknown;
  create_time?: unknown;
  content?: unknown;
  /** 正文太大时可能只回一个本地路径。 */
  file_path?: unknown;
  security_notice?: unknown;
  extra_identity_context?: unknown;
};

/**
 * stdout → 对象。**从第一个 `{` 切到最后一个 `}`**：CLI 是 node 写的，偶尔会在
 * 前面/后面带一行 `(node:…) [UNDICI-EHPA] Warning: …`，严格 `JSON.parse(stdout)`
 * 会因为一行噪音把一次成功的读判成 bad_output。
 */
export function parseResponse(stdout: string): CliResponse | null {
  const text = stdout.trim();
  if (text === '') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as CliResponse;
  } catch {
    return null;
  }
}

/** 响应里的 errcode 归一成数字；不是数字就当没有（`undefined`）。 */
export function errcodeOf(response: CliResponse): number | null {
  const raw = response.errcode;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

function stringAt(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 正文在哪。
 *
 * `content` 是常态；`file_path` 是「正文太大、CLI 写进了本地文件」那一支——不读它
 * 就会把一份几万字的 PRD 判成空内容。**两路都要过 `stripWrappers()`**。
 */
async function contentOf(response: CliResponse): Promise<string | null> {
  const record = response as Record<string, unknown>;
  const direct = stringAt(record, 'content');
  if (direct !== null) return stripWrappers(direct);
  const file = stringAt(record, 'file_path');
  if (file !== null) {
    try {
      const text = await readFile(file, 'utf8');
      return text.trim() === '' ? null : stripWrappers(text);
    } catch {
      return null;
    }
  }
  return null;
}

/** 标题：优先响应里的 `name`，其次第一个 Markdown 标题；都没有就是 null。 */
export function titleOf(response: CliResponse, markdown: string): string | null {
  const name = stringAt(response as Record<string, unknown>, 'name')?.trim() ?? '';
  if (name !== '') return name;
  return firstHeading(markdown);
}

/** 第一行 Markdown 标题（`# …` ~ `###### …`），跳过代码块里的井号。 */
export function firstHeading(markdown: string): string | null {
  let fenced = false;
  for (const line of markdown.split('\n').slice(0, 200)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    const text = (match?.[2] ?? '').trim();
    if (text !== '') return text;
  }
  return null;
}

// ─── 错误映射 ────────────────────────────────────────────────────────────────

export const MSG_MISSING_BINARY = '没装 wecom-cli，先 npm i -g @wecom/cli';
export const MSG_UNAUTHORIZED = 'wecom-cli 未授权，先在企业微信里扫码（wecom-cli auth init）';

/**
 * 授权相关的 errcode：无效证件 / 无效 token / token 过期 / 缺 token / 接口未授权。
 * 它们与 `Status: unauthorized` 同一类——下一步都是去扫码，不是去改配置。
 */
const AUTH_ERRCODES: ReadonlySet<number> = new Set([40001, 40014, 42001, 41001, 48001]);

/**
 * 文本里有没有「没授权」这个意思。
 *
 * `Status: unauthorized` 是 `wecom-cli auth show` 打印的那一行（授权成功时是
 * `Status: authorized` + `Bot ID: …`），CLI 在未授权时也会把它打到 stderr 上。
 */
export function looksUnauthorized(text: string): boolean {
  return /status:\s*unauthor|unauthorized|not\s+authorized|未授权/i.test(text);
}

function chrono(ms: number): string {
  const seconds = ms / 1000;
  const text = Number.isInteger(seconds) ? `${seconds}` : seconds.toFixed(1);
  return `${ms} 毫秒（${text} 秒）`;
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

export const DEFAULT_TIMEOUT_MS = 60_000;

export type ReadDocOpts = { timeoutMs?: number };

/**
 * 读一份企业微信文档的正文（Markdown）。**一次调用，没有轮询。**
 *
 * 流程：分品类 → 拼 argv → 跑（60 秒预算）→ `errcode === 0` 才算成 → 取正文
 * （剥掉包装字段）→ 标题优先用响应里的 `name`。
 *
 * 品类路由：`doc` 与 `sheet` 都走 `doc contents get`；`smartsheet` / `smartpage`
 * 各自是**另一个服务**（`wecom-cli smartsheet …` / `wecom-cli smartpage …`），
 * 本版没有实现，就如实说「暂不支持读取」——不猜、不假装成功。
 */
export async function readDoc(url: string, opts: ReadDocOpts = {}): Promise<DocRead> {
  const raw = typeof url === 'string' ? url.trim() : '';
  const kind = classifyUrl(raw);

  if (kind === 'unknown') {
    return fail('unknown_kind', raw === ''
      ? `没有 PRD 链接。${UNKNOWN_HINT}`
      : `这条链接读不了：「${raw.slice(0, 200)}」。${UNKNOWN_HINT}`);
  }
  if (kind === 'smartsheet') {
    return fail('unsupported_kind', '智能表格（smartsheet）暂不支持读取');
  }
  if (kind === 'smartpage') {
    return fail('unsupported_kind', '智能文档（smartpage）暂不支持读取');
  }

  const timeoutMs = positive(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
  const resolved = await resolveCli();
  if (!resolved.ok) return fail(resolved.code, resolved.message);
  const bin = resolved.bin;

  const run = await runOnce(bin, argvOf(kind, raw), timeoutMs);

  // 1. 进程没起来
  if (run.spawnError !== null) {
    if (run.spawnError.code === 'ENOENT') return fail('missing_binary', MSG_MISSING_BINARY);
    return fail(
      'cli_failed',
      `${bin} 起不来（${redact(`${run.spawnError.code ?? '未知'}：${run.spawnError.message}`)}）`,
    );
  }
  // 2. 超时
  if (run.timedOut) {
    return fail('timeout', `wecom-cli 读取超时：等了 ${chrono(timeoutMs)} 还没返回（${urlForMessage(raw)}）`);
  }

  const combined = `${run.stderr}\n${run.stdout}`;
  // 3. 退出码非 0：授权那一类单独说，其余把 stderr 的尾巴带上
  if (run.exitCode !== 0) {
    if (looksUnauthorized(combined)) return fail('unauthorized', MSG_UNAUTHORIZED);
    const code = run.exitCode === null ? '被信号终止' : `退出码 ${run.exitCode}`;
    const text = tail(run.stderr) || tail(run.stdout) || '（stderr 与 stdout 都是空的）';
    return fail('cli_failed', `${bin} 读取失败（${code}）：${text}`);
  }

  // 4. 解析 JSON
  const response = parseResponse(run.stdout);
  if (response === null) {
    if (looksUnauthorized(combined)) return fail('unauthorized', MSG_UNAUTHORIZED);
    return fail('bad_output', `${bin} 的输出不是 JSON：${tail(combined) || '（什么都没打印）'}`);
  }

  // 5. **成功信号是 errcode，不是退出码**
  const errcode = errcodeOf(response);
  if (errcode !== 0) {
    const errmsg = stringAt(response as Record<string, unknown>, 'errmsg') ?? '';
    if ((errcode !== null && AUTH_ERRCODES.has(errcode)) || looksUnauthorized(`${errmsg}\n${combined}`)) {
      return fail('unauthorized', MSG_UNAUTHORIZED);
    }
    if (errcode === null) {
      return fail('bad_output', `${bin} 的响应里没有 errcode：${tail(run.stdout)}`);
    }
    return fail('errcode', `企业微信接口报错 ${errcode}：${redact(errmsg) || '（没有给 errmsg）'}`);
  }

  // 6. 正文
  const markdown = await contentOf(response);
  if (markdown === null || markdown.trim() === '') {
    return fail(
      'empty_content',
      `${bin} 返回了空正文：${urlForMessage(raw)}（可能是一份空文档，或正文只在另一个服务里）`,
    );
  }
  return { ok: true, markdown, title: titleOf(response, markdown), kind };
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function urlForMessage(url: string): string {
  return url.length <= 160 ? url : `${url.slice(0, 160)}…`;
}
