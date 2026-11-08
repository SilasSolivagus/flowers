import { execFile, spawn } from 'node:child_process';
import { db as appDb } from '../../db/client.js';
import { readSetting, type Queryable } from '../uemaster/settings.js';

/**
 * 走查的第一层：**只读**地读一台远端服务器上的 git 镜像。
 *
 * 为什么是「镜像」而不是「仓库」：这台 flowers 不 checkout 123pan 的代码，也不
 * 拥有它。owner 在 `dogyun:/srv/123pan-mirror/` 下留了三个 bare 仓（`--git-dir`
 * 能读、`git show HEAD:path` 能出内容），走查要的正是「HEAD 上现在是什么样」。
 * 所以这一层只做四件事：列文件、搜字符串、读一个文件、读 HEAD 那一行提交——
 * 全部是 git 的**读命令**，没有工作区，也没有 index。
 *
 * 三条硬规矩：
 *
 * 1. **没有 shell。** 命令一律是 argv 数组交给 `execFile`（与 `uemaster/flow.ts`
 *    同一个理由）：路径、pattern 里可能有中文、引号、`$()`，走 shell 就等于把那
 *    段文本再解释一遍。本地是 `git --git-dir=<path> …`，远端是
 *    `ssh <host> git --git-dir=<path> …`——都是数组，没有人能拼进一条管道。
 * 2. **失败是数据，不是异常。** 超时、退出码非 0、ssh 连不上、配置缺一块，全部
 *    返回 `{ ok: false, code, message }`，message 是中文（stderr 的尾巴原样附在
 *    后面——`ssh: Could not resolve hostname` 比「读取失败」有用得多）。
 * 3. **读命令白名单。** 每一个 argv 都过 `isReadOnlyGitArgs()`：子命令只能是
 *    ls-tree / log / grep / show / cat-file / rev-parse / for-each-ref / symbolic-ref，
 *    且不许带 `--output`。写命令（更新 ref、checkout、gc、push）在到达进程之前
 *    就被拒了——「只读」是构造上的，不是靠调用方自觉。
 *
 * 为什么把 build 产物当成噪音：`git grep -l "分享链接" HEAD` 在 123pan-pc 上命中
 * 的是 `web-file/frontend/dist/web.asar`——那是**提交进仓库的构建产物**（817 个
 * 文件里有一大坨是 dist / asar / map / 锁文件）。不滤掉它们，走查阶段一拿到的
 * 「页面结构」会是打包后的文件名，模型只会照着猜。
 */

// ─── 形状 ────────────────────────────────────────────────────────────────────

export type RepoRef = { id: string; path: string };

export type Transport = 'local' | 'ssh';

/** 失败码：调用方按它分支，人读 `message`。 */
export type MirrorFailureCode =
  | 'bad_config'   // 配置缺一块 / 值不合法（含读不到设置）
  | 'unknown_repo' // repoId 不在配置里
  | 'bad_path'     // 路径/pattern 不合法（绝对路径、..、冒号注入）
  | 'timeout'      // 超过 20 秒没回来
  | 'git_failed'   // 退出码非 0（含 ssh 自己失败）
  | 'not_read_only'; // 白名单拒绝：这是内部 bug，不是用户输入

export type MirrorFailure = { ok: false; code: MirrorFailureCode; message: string };
export type MirrorOk<T> = { ok: true; data: T };
/** 每一次读都是一次「成了」或「一句中文」，从不抛。 */
export type MirrorResult<T> = MirrorOk<T> | MirrorFailure;

export function fail(code: MirrorFailureCode, message: string): MirrorFailure {
  return { ok: false, code, message };
}

export function ok<T>(data: T): MirrorOk<T> {
  return { ok: true, data };
}

// ─── 配置的键与默认 ──────────────────────────────────────────────────────────

export const MIRROR_TRANSPORT_KEY = 'code.mirror.transport';
export const MIRROR_REPOS_KEY = 'code.mirror.repos';
export const MIRROR_SSH_HOST_KEY = 'code.mirror.sshHost';

export const ENV_TRANSPORT = 'FLOWERS_MIRROR_TRANSPORT';
export const ENV_REPOS = 'FLOWERS_MIRROR_REPOS';
export const ENV_SSH_HOST = 'FLOWERS_MIRROR_SSH_HOST';

/** `dogyun` 是 owner 那台机器的 ssh 别名；写死成默认是因为它是当前唯一的部署。 */
export const DEFAULT_SSH_HOST = 'dogyun';

/** 环境里什么都没说时的传输方式。`local` 不隐含任何远端假设。 */
export const DEFAULT_TRANSPORT: Transport = 'local';

/** 一次 git 读最多等 20 秒：2.4G 的仓在局域网里 `git grep` 也是这个量级。 */
export const GIT_TIMEOUT_MS = 20_000;

/**
 * ssh 的固定参数。`BatchMode=yes` 是必须的：没有它，密钥不对时 ssh 会**停在
 * 密码提示**上，20 秒后被我们杀掉，而人看到的是一句「超时」——真正的原因
 * （密钥没配）反而被藏了。`ConnectTimeout=10` 让连不通的机器快速失败。
 */
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'] as const;

export type MirrorConfig = {
  transport: Transport;
  repos: RepoRef[];
  sshHost: string;
};

// ─── 环境 → 设置 → 默认 ──────────────────────────────────────────────────────

function envCell(name: string): string | null {
  const value = process.env[name]?.trim() ?? '';
  return value === '' ? null : value;
}

/** 设置那一格；读失败（库连不上）是**失败**，不是「没配」——两者的下一步不同。 */
async function settingCell(
  database: Queryable,
  key: string,
): Promise<{ ok: true; value: string | null } | MirrorFailure> {
  try {
    const value = (await readSetting(database, key))?.trim() ?? '';
    return { ok: true, value: value === '' ? null : value };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail('bad_config', `读不到设置「${key}」：数据库错误（${detail}）`);
  }
}

/**
 * `code.mirror.repos` 的解析。**整份作废，不拼半份**：一个 id 缺 path、path 不是
 * 绝对路径、两个 id 重名，都会让整份配置失败——半份仓库列表比没有更糟，因为
 * 调用方会以为自己读的是全部。
 *
 * 报错一定点名缺的是哪一格（`code.mirror.repos` 或 `FLOWERS_MIRROR_REPOS`）：
 * owner 看到「镜像没配」还得自己猜是哪个键。
 */
export function parseRepos(raw: string, from: 'env' | 'settings'): MirrorResult<RepoRef[]> {
  const where = from === 'env' ? `环境变量 ${ENV_REPOS}` : `设置项 ${MIRROR_REPOS_KEY}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail('bad_config', `${where} 不是合法的 JSON（${detail}）`);
  }
  if (!Array.isArray(parsed)) {
    return fail('bad_config', `${where} 必须是一个 JSON 数组，形如 [{"id":"123pan-pc","path":"/srv/x.git"}]`);
  }
  if (parsed.length === 0) {
    return fail('bad_config', `${where} 是空数组：至少要配一个镜像仓库（{"id","path"}）`);
  }
  const repos: RepoRef[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < parsed.length; i += 1) {
    const item: unknown = parsed[i];
    if (typeof item !== 'object' || item === null) {
      return fail('bad_config', `${where} 的第 ${i + 1} 项不是 { id, path }`);
    }
    const id = (item as { id?: unknown }).id;
    const path = (item as { path?: unknown }).path;
    if (typeof id !== 'string' || id.trim() === '') {
      return fail('bad_config', `${where} 的第 ${i + 1} 项缺 id`);
    }
    if (typeof path !== 'string' || path.trim() === '') {
      return fail('bad_config', `${where} 的第 ${i + 1} 项（${id}）缺 path`);
    }
    const clean = path.trim();
    if (!clean.startsWith('/')) {
      return fail('bad_config', `${where} 里 ${id} 的 path 必须是绝对路径（现在是「${clean}」）`);
    }
    if (seen.has(id.trim())) {
      return fail('bad_config', `${where} 里 id「${id.trim()}」出现了两次`);
    }
    seen.add(id.trim());
    repos.push({ id: id.trim(), path: clean });
  }
  return ok(repos);
}

function parseTransport(raw: string, from: 'env' | 'settings'): MirrorResult<Transport> {
  const where = from === 'env' ? `环境变量 ${ENV_TRANSPORT}` : `设置项 ${MIRROR_TRANSPORT_KEY}`;
  if (raw === 'local' || raw === 'ssh') return ok(raw);
  return fail('bad_config', `${where} 只能是 local 或 ssh（现在是「${raw}」）`);
}

/**
 * 三格按 **env → 设置 → 默认** 解析（与 provider 的三格同一个顺序）。
 *
 * 每一格各自回落、但**仓库列表不回落**：env 只覆盖一半（例如只给了 transport）时，
 * 其余照样从设置读；只有 `repos` 缺失会整份失败——没有仓库的 transport 是一个
 * 会「看起来配好了」的空壳。
 *
 * `database` 可注入：用例里没有库也能钉住「缺 repos」那句话。
 */
export async function resolveMirrorConfig(
  database: Queryable = appDb,
): Promise<MirrorResult<MirrorConfig>> {
  // transport
  const transportEnv = envCell(ENV_TRANSPORT);
  let transport: Transport | MirrorFailure;
  if (transportEnv !== null) {
    const parsed = parseTransport(transportEnv, 'env');
    if (!parsed.ok) return parsed;
    transport = parsed.data;
  } else {
    const cell = await settingCell(database, MIRROR_TRANSPORT_KEY);
    if (!cell.ok) return cell;
    if (cell.value === null) {
      transport = DEFAULT_TRANSPORT;
    } else {
      const parsed = parseTransport(cell.value, 'settings');
      if (!parsed.ok) return parsed;
      transport = parsed.data;
    }
  }

  // repos
  const reposEnv = envCell(ENV_REPOS);
  let repos: RepoRef[];
  if (reposEnv !== null) {
    const parsed = parseRepos(reposEnv, 'env');
    if (!parsed.ok) return parsed;
    repos = parsed.data;
  } else {
    const cell = await settingCell(database, MIRROR_REPOS_KEY);
    if (!cell.ok) return cell;
    if (cell.value === null) {
      return fail(
        'bad_config',
        `没有配置代码镜像仓库：在设置里填「${MIRROR_REPOS_KEY}」，或设环境变量 ${ENV_REPOS}，`
        + '形如 [{"id":"123pan-pc","path":"/srv/123pan-mirror/123pan-pc.git"}]',
      );
    }
    const parsed = parseRepos(cell.value, 'settings');
    if (!parsed.ok) return parsed;
    repos = parsed.data;
  }

  // sshHost：只有 ssh 才需要，但既然有默认值，就总是解析出一份完整配置。
  const hostEnv = envCell(ENV_SSH_HOST);
  let sshHost: string;
  if (hostEnv !== null) {
    sshHost = hostEnv;
  } else {
    const cell = await settingCell(database, MIRROR_SSH_HOST_KEY);
    if (!cell.ok) return cell;
    sshHost = cell.value ?? DEFAULT_SSH_HOST;
  }

  return ok({ transport, repos, sshHost });
}

// ─── 只读白名单 ──────────────────────────────────────────────────────────────

/**
 * 本文件允许跑的子命令。加一个之前先问：它会写 `.git` 或工作区吗？
 * `show` / `cat-file` / `rev-parse` 都可能被用来写文件（`--output`），所以另有一条
 * 「不许 `--output`」的规则兜着。
 */
export const READ_ONLY_SUBCOMMANDS: readonly string[] = [
  'ls-tree', 'log', 'grep', 'show', 'cat-file', 'rev-parse', 'for-each-ref', 'symbolic-ref',
];

/** 子命令之外，任何位置出现这些词都不放行（防御性：子命令已经够窄了）。 */
const WRITE_TOKENS: readonly string[] = [
  '--output', 'update-ref', 'update-index', 'write-tree', 'checkout', 'checkout-index',
  'commit-tree', 'hash-object', 'gc', 'prune', 'repack', 'push', 'fetch', 'clone',
  'worktree', 'stash', 'reset', 'clean', 'filter-branch',
];

/**
 * argv 是不是一次**纯读**。纯函数、可单测；`runGit` 每次调用前都过一遍，
 * 不通过就返回 `not_read_only`（那是本模块的 bug，不是用户输入的问题）。
 */
export function isReadOnlyGitArgs(args: readonly string[]): boolean {
  const sub = args[0];
  if (typeof sub !== 'string' || !READ_ONLY_SUBCOMMANDS.includes(sub)) return false;
  return !args.some((arg) => WRITE_TOKENS.some((token) => arg === token || arg.startsWith(`${token}=`)));
}

// ─── argv 构造（没有 shell） ─────────────────────────────────────────────────

export const HEAD_REF = 'HEAD';

/**
 * 一次读命令的完整 argv。
 *
 * 本地：`git --git-dir=<path> …`
 * 远端：`ssh -o BatchMode=yes -o ConnectTimeout=10 <host> git --git-dir=<path> …`
 *
 * 远端那一段**不是**把命令拼成字符串交给 ssh：ssh 会把 argv 从第二个参数起
 * 用空格拼成一条远程命令行，所以参数里的空格/引号仍会被远端 shell 重新解释。
 * 本模块传进去的参数是我们自己造的字面量（路径、`HEAD`、`--format=…`、pattern），
 * 唯一可能带空格的是 grep 的 pattern——它被放在 `-e` 之后，而远端 shell 对它的
 * 解释上限也就是「把一个 pattern 拆成两个词」，不会变成一条命令。
 * 要彻底消除这一层，得换成 `ssh <host> -- git …` 的协议式调用；当前部署里
 * pattern 来自我们自己的走查流程（中文短句），不做这一层。
 */
export function gitArgv(
  config: Pick<MirrorConfig, 'transport' | 'sshHost'>,
  repoPath: string,
  args: readonly string[],
): string[] {
  const gitPart = ['git', `--git-dir=${repoPath}`, ...args];
  if (config.transport === 'local') return gitPart;
  return ['ssh', ...SSH_OPTS, config.sshHost, ...gitPart];
}

// ─── 跑一次 ──────────────────────────────────────────────────────────────────

type GitRun = {
  exitCode: number | null;
  timedOut: boolean;
  /** 进程根本没起来（git 没装、ssh 没装）。 */
  spawnError: string | null;
  /** 被输出上限截断（只对 `show` 有意义）。 */
  outputLimited: boolean;
  stdout: Buffer;
  stderr: string;
};

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/** 跑一次 argv，**永远 resolve**；失败是一种数据。 */
function runGit(
  argv: string[],
  opts: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<GitRun> {
  const [bin, ...rest] = argv;
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  return new Promise((resolve) => {
    execFile(
      bin ?? 'git',
      rest,
      {
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        encoding: 'buffer',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''), 'utf8');
        const err = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');
        const e = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string }) | null;
        if (!e) {
          resolve({ exitCode: 0, timedOut: false, spawnError: null, outputLimited: false, stdout: out, stderr: err });
          return;
        }
        // maxBuffer 超限：Node 会杀掉子进程，但把已经收到的部分交回来。
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve({ exitCode: null, timedOut: false, spawnError: null, outputLimited: true, stdout: out, stderr: err });
          return;
        }
        if (typeof e.code === 'string') {
          resolve({ exitCode: null, timedOut: false, spawnError: `${e.code}: ${e.message}`, outputLimited: false, stdout: out, stderr: err });
          return;
        }
        const timedOut = Boolean(e.killed) && (e.signal === 'SIGTERM' || e.signal === 'SIGKILL');
        resolve({
          exitCode: typeof e.code === 'number' ? e.code : null,
          timedOut,
          spawnError: null,
          outputLimited: false,
          stdout: out,
          stderr: err,
        });
      },
    );
  });
}

/** stderr 的尾巴：整段可能是一屏 Python 式 traceback，报错那一行只要最后一段。 */
export function tail(text: string, max = 800): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

/** 把一次进程结果压成一句中文（或 null 表示成功）。 */
function runFailure(run: GitRun, timeoutMs: number, bin: string): MirrorFailure | null {
  if (run.spawnError !== null) {
    return fail('git_failed', `${bin} 起不来（${run.spawnError}）`);
  }
  if (run.timedOut) {
    const seconds = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000} 秒` : `${timeoutMs} 毫秒`;
    return fail('timeout', `${bin} 读取超时：${seconds}内没有返回`);
  }
  if (run.exitCode !== 0) {
    const detail = tail(run.stderr);
    const code = run.exitCode === null ? '被信号终止' : `退出码 ${run.exitCode}`;
    return fail('git_failed', `${bin} 读取失败（${code}）：${detail === '' ? '（stderr 是空的）' : detail}`);
  }
  return null;
}

// ─── 噪音过滤 ────────────────────────────────────────────────────────────────

/**
 * 目录级排除：出现在**任何**一段路径里都算噪音（最后一段除外，见下）。
 *
 * `vendor` / `third_party` / `testdata` 是 2026-11-09 为 Go 仓补的（接 79 个仓之前）：
 * - `vendor/`：Go 的依赖目录（`go mod vendor` 的产物，被提交进仓）。它里面的 `.go`
 *   文件是**别人的代码**，一仓能到几万条；索引进去之后，`apisrv` 的「产品能力」里
 *   会混着 gin、gorm、grpc 的实现，材料照着说「已有这个能力」——那一句是假话。
 *   它还有 `vendor/modules.txt`、各层子目录里的 `go.sum` 这类清单，`go.sum` 已在
 *   `NOISE_FILES` 里，但清单本身也不该进索引（只有 `pages.json` 那种路由表才进）。
 *   注意 Go 的 vendoring 是**按模块**的：多模块仓里 `cmd/x/vendor/` 也存在，所以按
 *   「任意一段目录名」判，而不是只看仓根。
 * - `third_party/`：Bazel 风格的第三方源码目录（不叫 vendor，装的东西一模一样）。
 * - `testdata/`：Go 工具链**约定**的测试数据目录——`go build` 与 `go vet` 都跳过它，
 *   里面是 `.json` / `.yaml` / `.go` 形态的夹具（很多还是故意写坏的用例输入）。
 *   把夹具当产品代码，正是 `_test.go` 那条排除想避免的同一件事。
 *
 * 这三条都**不是**「大概像噪音」：它们都有一句可核对的理由（依赖 / 第三方 / 夹具），
 * 而判断标准与 `_test.go` 一致——**这个文件是不是产品的一部分**。
 */
const NOISE_DIRS: ReadonlySet<string> = new Set([
  'dist', 'build', 'out', 'node_modules', 'coverage', '.next', '.nuxt', 'vendor_bundle',
  'vendor', 'third_party', 'testdata',
]);

/** 扩展名级排除：二进制、图片、字体、压缩包、源映射。 */
const NOISE_EXT: ReadonlySet<string> = new Set([
  // 打包产物 / 源映射
  'asar', 'map', 'min.js', 'min.css',
  // 图片
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tiff', 'avif',
  // 字体 / 音视频
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'wav', 'webm', 'mov',
  // 二进制 / 归档
  'exe', 'dll', 'so', 'dylib', 'bin', 'node', 'wasm', 'class', 'jar', 'pyc',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'pdf', 'dmg', 'iso',
  'sqlite', 'sqlite3', 'db', 'o', 'obj', 'a', 'lib',
]);

/** 文件名级排除：锁文件（几万行，且没有一个字是业务代码）。 */
const NOISE_FILES: ReadonlySet<string> = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'pnpm-lock.yml', 'bun.lockb', 'composer.lock', 'cargo.lock', 'gemfile.lock',
  'poetry.lock', 'go.sum', 'mix.lock', 'podfile.lock',
]);

/** 小写扩展名（多段扩展名按 `min.js` 这种整串查，见 `isNoisePath`）。 */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * 这个路径算不算噪音。
 *
 * 每条排除都有实据：
 * - `dist/ build/ out/`：三个仓都把打包产物提交进去了。`123pan-pc` 的
 *   `web-file/frontend/dist/web.asar` 就是一条 2.4M 的黑箱文件，`git grep` 一命中
 *   就顶掉一条真正有用的源码命中。
 * - `node_modules/`：就算被提交（有的老仓真的这么干），它也不是这个项目的代码。
 * - `*.asar`：Electron 包体，二进制；命中它等于命中了一份压缩过的私有副本。
 * - `*.min.js` / `*.map`：压缩产物与源映射。映射里的 `sourcesContent` 会让
 *   「这里有没有这个字符串」永远为真。
 * - 锁文件：几万行依赖坐标，检索时噪声占比最高，且没有一个字是业务代码。
 * - 图片/字体/音视频/二进制/归档：`git grep` 对二进制会直接跳（`-I`），但
 *   `lsTree` 会把它们全列出来；阶段一的「页面结构」里出现一堆 `.png` 只会误导。
 *
 * 目录判定只看**非最后一段**：`build/` 是目录，`build.js` 是文件（它可能是源码）。
 */
export function isNoisePath(input: string): boolean {
  const path = input.replace(/^\.?\//, '').trim();
  if (path === '') return true;
  const segments = path.split('/');
  const name = segments[segments.length - 1] ?? '';
  // 目录段（不含文件名本身）
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (NOISE_DIRS.has((segments[i] ?? '').toLowerCase())) return true;
  }
  const lower = name.toLowerCase();
  if (NOISE_FILES.has(lower)) return true;
  if (lower.endsWith('.min.js') || lower.endsWith('.min.css') || lower.endsWith('.d.ts.map')) return true;
  const ext = extensionOf(lower);
  if (ext !== '' && NOISE_EXT.has(ext)) return true;
  return false;
}

// ─── 路径合法性 ──────────────────────────────────────────────────────────────

/**
 * 仓库内的相对路径。拒绝：空、绝对路径、`..`、NUL、`show` 用的冒号（`<rev>:<path>`
 * 里冒号是分隔符，路径里再有一个就会读到别的东西）。
 *
 * 注意这**不是**安全边界（argv 里没有 shell），是「别让我们自己造出一个会读错对象
 * 的 revision」。
 */
export function cleanRepoPath(input: string, opts: { allowColon?: boolean } = {}): string | null {
  const path = input.trim();
  if (path === '' || path.startsWith('/') || path.includes('\0')) return null;
  if (!opts.allowColon && path.includes(':')) return null;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.')) return null;
  return path;
}

// ─── 解析一份配置 + 找仓库 ──────────────────────────────────────────────────

type ResolvedRepo = { config: MirrorConfig; repo: RepoRef };

async function resolveRepo(repoId: string): Promise<ResolvedRepo | MirrorFailure> {
  const resolved = await resolveMirrorConfig();
  if (!resolved.ok) return resolved;
  const repo = resolved.data.repos.find((item) => item.id === repoId);
  if (repo === undefined) {
    const known = resolved.data.repos.map((item) => item.id).join('、');
    return fail('unknown_repo', `未知的镜像仓库 id「${repoId}」；已配置的是：${known}`);
  }
  return { config: resolved.data, repo };
}

/** 跑一次**经过只读校验**的读命令。所有公开函数都从这里过。 */
async function read(
  resolved: ResolvedRepo,
  args: string[],
  opts: { maxBuffer?: number; timeoutMs?: number; allowExit?: number[] } = {},
): Promise<MirrorResult<GitRun>> {
  if (!isReadOnlyGitArgs(args)) {
    return fail('not_read_only', `内部错误：只读校验拒绝了一条命令（${args.join(' ')}）`);
  }
  const argv = gitArgv(resolved.config, resolved.repo.path, args);
  const bin = argv[0] ?? 'git';
  const run = await runGit(argv, opts);
  if (run.outputLimited) return ok(run); // 由调用方决定要不要当截断
  // `git grep` 没命中时退出 1：那是答案，不是失败。
  if (run.exitCode !== null && (opts.allowExit ?? []).includes(run.exitCode)) return ok(run);
  const failure = runFailure(run, opts.timeoutMs ?? GIT_TIMEOUT_MS, bin);
  if (failure !== null) return failure;
  return ok(run);
}

// ─── 四个读口 ────────────────────────────────────────────────────────────────

/** 配置里的仓库列表（不存在的仓库在这里不出现——它是配置，不是探测）。 */
export async function listRepos(
  database: Queryable = appDb,
): Promise<MirrorResult<RepoRef[]>> {
  const resolved = await resolveMirrorConfig(database);
  return resolved.ok ? ok(resolved.data.repos) : resolved;
}

/**
 * HEAD 那一行：完整 sha、提交时间（ISO 8601）、标题。
 *
 * 空仓（一个提交都没有）返回 `data: null`——那不是错误，是「还没开始」。其余失败
 * （仓库路径写错、ssh 连不上）照旧是中文失败。
 */
export async function head(
  repoId: string,
): Promise<MirrorResult<{ sha: string; date: string; subject: string } | null>> {
  const resolved = await resolveRepo(repoId);
  if ('ok' in resolved) return resolved;
  const run = await read(resolved, ['log', '-1', '--format=%H%x1f%cI%x1f%s', HEAD_REF]);
  if (!run.ok) {
    // 空仓：git log 在没有任何提交时退出 128，stderr 是「does not have any commits yet」。
    if (run.code === 'git_failed' && /does not have any commits|bad revision|unknown revision/i.test(run.message)) {
      return ok(null);
    }
    return run;
  }
  const text = run.data.stdout.toString('utf8').replace(/\n+$/, '');
  if (text === '') return ok(null);
  const [sha, date, subject] = text.split('\x1f');
  if (typeof sha !== 'string' || typeof date !== 'string') return ok(null);
  return ok({ sha, date, subject: subject ?? '' });
}

/**
 * HEAD 上的全部文件（已去噪音）。
 *
 * `-z` 而不是按行切：git 的路径可以含空格与中文，`--name-only` 的换行输出在这种
 * 仓里是能读歪的。排序是 ls-tree 自己的（树序 = 路径字典序）。
 */
export async function lsTree(
  repoId: string,
  opts: { prefix?: string } = {},
): Promise<MirrorResult<string[]>> {
  const resolved = await resolveRepo(repoId);
  if ('ok' in resolved) return resolved;
  const args = ['ls-tree', '-r', '--name-only', '-z', HEAD_REF];
  const prefix = opts.prefix?.trim() ?? '';
  if (prefix !== '') {
    const clean = cleanRepoPath(prefix, { allowColon: true });
    if (clean === null) {
      return fail('bad_path', `前缀不合法：「${prefix}」（只能是仓库内的相对路径）`);
    }
    args.push('--', clean);
  }
  const run = await read(resolved, args);
  if (!run.ok) return run;
  const names = run.data.stdout
    .toString('utf8')
    .split('\0')
    .filter((name) => name !== '')
    .filter((name) => !isNoisePath(name));
  return ok(names);
}

/** grep 默认最多回 200 条：一次命中几千条对「走查」没有增量。 */
export const GREP_DEFAULT_MAX = 200;

/**
 * 在 HEAD 上按**字面量**搜（`-F`）。正则模式会让 `(` `?` 这类字符在中文串里偶发
 * 报错，而走查要搜的都是业务词/接口名，字面量才是它需要的语义。
 *
 * 输出形状是 `HEAD:<path>:<line>:<text>`；路径本身可能带冒号，所以从**行尾方向**
 * 用「数字 + 冒号」锚定切分。噪音路径在切分之后才丢——否则预算会被 dist 里的
 * 命中吃掉。
 */
export async function grep(
  repoId: string,
  pattern: string,
  opts: { paths?: string[]; max?: number } = {},
): Promise<MirrorResult<Array<{ path: string; line: number; text: string }>>> {
  const resolved = await resolveRepo(repoId);
  if ('ok' in resolved) return resolved;

  const needle = pattern.trim();
  if (needle === '') return fail('bad_path', '要搜的内容是空的');

  const args = ['grep', '-n', '-I', '-F', '--no-color', '-e', pattern, HEAD_REF];
  const pathspecs: string[] = [];
  for (const raw of opts.paths ?? []) {
    const clean = cleanRepoPath(raw, { allowColon: true });
    if (clean === null) return fail('bad_path', `搜索范围不合法：「${raw}」（只能是仓库内的相对路径）`);
    pathspecs.push(clean);
  }
  if (pathspecs.length > 0) args.push('--', ...pathspecs);

  const max = Number.isFinite(opts.max) && (opts.max ?? 0) > 0 ? Math.floor(opts.max as number) : GREP_DEFAULT_MAX;
  const run = await read(resolved, args, { allowExit: [1] });
  if (!run.ok) return run;

  const out: Array<{ path: string; line: number; text: string }> = [];
  const lines = run.data.stdout.toString('utf8').split('\n');
  for (const line of lines) {
    if (out.length >= max) break;
    if (line === '') continue;
    const match = /^HEAD:(.+?):(\d+):(.*)$/.exec(line);
    if (match === null) continue;
    const path = match[1] ?? '';
    const lineNo = Number(match[2]);
    if (isNoisePath(path)) continue;
    out.push({ path, line: Number.isFinite(lineNo) ? lineNo : 0, text: match[3] ?? '' });
  }
  return ok(out);
}

export const DEFAULT_SHOW_MAX_BYTES = 200_000;

/** 截断标记。原文是全的；这行字只说明「你看到的不是全部」。 */
export function truncationMarker(shown: number, total: number): string {
  return `\n\n…（已截断：只显示前 ${shown} 字节，全文 ${total} 字节）`;
}

/**
 * 把一段字节按 UTF-8 边界切到 `max` 以内。切在半个汉字上会得到一个 `�`，
 * 而模型会把那个符号当成源码的一部分去抄。
 */
export function truncateUtf8(buffer: Buffer, max: number): string {
  if (buffer.length <= max) return buffer.toString('utf8');
  let end = max;
  while (end > 0) {
    const next = buffer[end] ?? 0;
    if ((next & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return buffer.subarray(0, end).toString('utf8');
}

/**
 * 读一个文件。`maxBytes` 之后截断并**在正文里写明**（调用方决定要不要把这句转述
 * 给模型）。
 *
 * 分两步：先 `cat-file -s` 问大小（顺便验证路径确实存在——`git show` 的报错
 * 是英文的，而「文件不存在」与「git 坏了」是两件事），再用一个只够装
 * `maxBytes + 64K` 的缓冲去读正文。文件比缓冲大时 Node 会把子进程杀掉并交回已经
 * 收到的部分，那正好是我们要的前缀。
 */
export async function show(
  repoId: string,
  path: string,
  opts: { maxBytes?: number } = {},
): Promise<MirrorResult<string>> {
  const resolved = await resolveRepo(repoId);
  if ('ok' in resolved) return resolved;

  const clean = cleanRepoPath(path);
  if (clean === null) {
    return fail('bad_path', `路径不合法：「${path}」（只能是仓库内的相对路径，不能以 / 开头、不能含 .. 或 :）`);
  }
  const ref = `${HEAD_REF}:${clean}`;

  const sized = await read(resolved, ['cat-file', '-s', ref]);
  if (!sized.ok) {
    if (sized.code === 'git_failed' && /does not exist|not a valid object|bad revision/i.test(sized.message)) {
      return fail('git_failed', `仓库里没有这个文件：${clean}（${HEAD_REF}）`);
    }
    return sized;
  }
  const sizeText = sized.data.stdout.toString('utf8').trim();
  const total = Number.parseInt(sizeText, 10);
  if (!Number.isFinite(total) || total < 0) {
    return fail('git_failed', `读不出 ${clean} 的大小（cat-file -s 回了「${sizeText}」）`);
  }

  const maxBytes = Number.isFinite(opts.maxBytes) && (opts.maxBytes ?? 0) > 0
    ? Math.floor(opts.maxBytes as number)
    : DEFAULT_SHOW_MAX_BYTES;

  const run = await read(resolved, ['show', ref], { maxBuffer: maxBytes + 64 * 1024 });
  if (!run.ok) return run;
  const bytes = run.data.stdout;
  const shown = Math.min(bytes.length, maxBytes);
  const text = truncateUtf8(bytes, maxBytes);
  if (total > shown || run.data.outputLimited) {
    return ok(text + truncationMarker(shown, Math.max(total, bytes.length)));
  }
  return ok(text);
}

// ─── 第五个读口：批量读「每个文件的前 N 行」 ──────────────────────────────────

/**
 * 静态索引要读的东西：**每个页面/组件/服务文件的开头几十行**（导入、导出、路由表）。
 *
 * 为什么不复用 `show`：`show` 一次只读一个文件，而且内部先 `cat-file -s` 再
 * `show`——两次往返。实测一个仓有 130–140 个候选文件，逐文件读 = 280 次 ssh
 * 往返，光是延迟就几十秒，而静态索引的全部价值就是「比 grep 快」。
 *
 * 所以这里加一个**批量**读口，形状只有两次往返：
 * 1. `ls-tree -r -l -z`：一次拿到全树的 `path / oid / size`（`-l` 带大小，省掉
 *    `cat-file -s` 那一趟）；
 * 2. `git show <oid> <oid> …`：一次读多块 blob。git 对多个 blob 参数是**按顺序原样
 *    拼接**，不加任何分隔符——所以切分靠第 1 步拿到的大小，切完再校验总长；对不上
 *    就退回逐文件 `show`（正确性优先，慢一点可以接受）。
 *
 * 为什么不是 `cat-file --batch`：那要往 stdin 写一串对象名，而 `runGit` 不接 stdin
 * （这一层的所有命令都是纯 argv，见文件头第 1 条）。`git show` 多参数是同一件事的
 * 只读等价物，且已经在白名单里。
 */

export type TreeEntry = {
  path: string;
  oid: string;
  size: number;
};

/** 一次 `git show` 最多带多少个 blob：够长（少往返），又不至于把 argv 撑爆。 */
export const SHOW_BATCH = 120;

/** 一次 `git show` 的输出上限：超过就拆成更小的批，不靠 Node 杀进程兜底。 */
const SHOW_BATCH_BYTES = 8 * 1024 * 1024;

/**
 * HEAD 上的全部**文件**（带 oid 与大小），已去噪音。
 *
 * `-l` 会在每个条目里加一列「对象大小」；`-z` 仍然用 NUL 分隔（路径可以有空格与
 * 中文）。`type` 不是 `blob` 的条目（子模块的 `commit`）直接跳过——它们不是文件。
 */
export async function lsTreeEntries(
  repoId: string,
  opts: { ref?: string } = {},
): Promise<MirrorResult<TreeEntry[]>> {
  const resolved = await resolveRepo(repoId);
  if ('ok' in resolved) return resolved;
  // `ref` 只收 sha：索引的键是 `(repo, sha)`，读一棵「跟着分支漂」的树等于给错了 sha。
  const ref = (opts.ref ?? HEAD_REF).trim();
  if (ref !== HEAD_REF && !/^[0-9a-f]{4,40}$/i.test(ref)) {
    return fail('bad_path', `ref 不合法：「${ref}」（只能是 HEAD 或一个提交 sha）`);
  }
  const run = await read(resolved, ['ls-tree', '-r', '-l', '-z', ref], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!run.ok) return run;

  const out: TreeEntry[] = [];
  for (const row of run.data.stdout.toString('utf8').split('\0')) {
    if (row === '') continue;
    // `100644 blob <oid> <size>\t<path>`：size 那一列是右对齐的，所以中间空格数量不定。
    const match = /^(\d+) (\w+) ([0-9a-f]+) +(\d+)\t(.+)$/.exec(row);
    if (match === null) continue;
    if ((match[2] ?? '') !== 'blob') continue;
    const path = match[5] ?? '';
    if (isNoisePath(path)) continue;
    const size = Number(match[4]);
    out.push({ path, oid: match[3] ?? '', size: Number.isFinite(size) ? size : 0 });
  }
  return ok(out);
}

/**
 * 批量读文件**开头**：返回 `path → 前 maxLines 行`。
 *
 * `maxLines` 在本地切（传输的是整块 blob）：git 没有「只给我前 80 行」的读命令，
 * 而索引真正要的是导入/导出/路由表——它们都在文件头部。多传的那点字节比多几十次
 * 往返便宜得多（实测两个仓各 0.7MB / 0.6MB 源码）。
 *
 * 任何一处对不上（git 退出码非 0、拼出来的总长与 `ls-tree -l` 的大小不合）都**不猜**：
 * 这一批退回逐文件 `show`。索引里少一个文件比错位解析整棵树好。
 */
export async function showHeads(
  repoId: string,
  entries: readonly TreeEntry[],
  opts: { maxLines?: number; maxBytes?: number } = {},
): Promise<MirrorResult<Map<string, string>>> {
  const maxLines = Number.isFinite(opts.maxLines) && (opts.maxLines ?? 0) > 0
    ? Math.floor(opts.maxLines as number)
    : 80;
  const maxBytes = opts.maxBytes ?? DEFAULT_SHOW_MAX_BYTES;
  const cut = (text: string): string => headLines(text, maxLines);

  const heads = new Map<string, string>();
  let index = 0;
  while (index < entries.length) {
    // 按字节预算切批：一个仓里既有 200 字节的 `index.ts`，也有 40KB 的页面。
    const batch: TreeEntry[] = [];
    let bytes = 0;
    while (index < entries.length) {
      const entry = entries[index]!;
      if (batch.length > 0 && (batch.length >= SHOW_BATCH || bytes + entry.size > SHOW_BATCH_BYTES)) break;
      batch.push(entry);
      bytes += entry.size;
      index += 1;
    }
    const got = await showBatch(repoId, batch, bytes, maxBytes);
    if (!got.ok) return got;
    for (const [path, text] of got.data) heads.set(path, cut(text));
  }
  return ok(heads);
}

/** 取一段文本的前 n 行（行尾的 `\r` 去掉：Windows 上提交的源码不少）。 */
export function headLines(text: string, max: number): string {
  const lines = text.split('\n');
  const shown = lines.slice(0, max).map((line) => line.replace(/\r$/, ''));
  return shown.join('\n');
}

/**
 * 一批 blob 的内容。先拼一次 `git show`，长度对得上就直接按大小切；对不上（或 git
 * 直接失败）就逐文件 `show`。
 *
 * 逐文件那条路用的是公开读口 `show`，它自带截断标记——索引只取前 80 行，标记会不会
 * 混进解析不影响：正则在前 80 行里就结束了。
 */
async function showBatch(
  repoId: string,
  batch: readonly TreeEntry[],
  bytes: number,
  maxBytes: number,
): Promise<MirrorResult<Map<string, string>>> {
  const out = new Map<string, string>();
  if (batch.length === 0) return ok(out);

  const resolved = await resolveRepo(repoId);
  if ('ok' in resolved) return resolved;
  const args = ['show', ...batch.map((entry) => entry.oid)];
  const run = await read(resolved, args, { maxBuffer: bytes + 2 * 1024 * 1024 });

  if (run.ok) {
    const buffer = run.data.stdout;
    const total = batch.reduce((sum, entry) => sum + entry.size, 0);
    if (buffer.length === total) {
      let offset = 0;
      for (const entry of batch) {
        const slice = buffer.subarray(offset, offset + entry.size);
        offset += entry.size;
        out.set(entry.path, truncateUtf8(slice, maxBytes));
      }
      return ok(out);
    }
  }

  // 兜底：一批一批地读，读到哪个算哪个（失败仍然是失败，不吞）。
  for (const entry of batch) {
    const one = await show(repoId, entry.path, { maxBytes });
    if (!one.ok) return one;
    out.set(entry.path, one.data);
  }
  return ok(out);
}

// ─── 第六个读口：按 blob id 批量读内容（P4-11） ──────────────────────────────

/**
 * 一块要读的 blob：**只有对象 id 与大小**，没有路径。
 *
 * 这就是 P4-11 的形状要求：索引按内容寻址，所以「要读什么」由 blob id 决定，
 * 同一块内容被 40 个路径引用也只读一次。
 */
export type BlobRequest = { blobSha: string; size: number };

/** `cat-file --batch` 一次最多塞多少个对象名：够长（一次往返），又不至于把 stdin 撑爆。 */
export const CAT_FILE_BATCH = 5000;

/**
 * 一次 `git cat-file --batch` 读回多块 blob 的内容。
 *
 * 为什么不是 `show` 多参数（`showHeads` 那条路）：`show <oid> <oid> …` 的输出是**原样
 * 拼接**的，切分只能靠外部给的大小，切错一位就整棵树错位。`cat-file --batch` 自带
 * 长度前缀（`<oid> blob <size>\n<content>\n`），协议里就有边界——而增量同步恰恰只读
 * 「库里没有的那几块」，大小不一定来自同一次 `ls-tree`。
 *
 * 为什么这一条带 stdin：`--batch` 的对象名从 stdin 进。本模块其它读口都是纯 argv
 * （见文件头第 1 条），所以这里单独用 `spawn`，**仍然**过 `isReadOnlyGitArgs()`——
 * 只读是构造上的，不是靠这条命令自己老实。
 *
 * 缺对象（镜像被 gc 过、oid 属于别的仓）**不当成空内容**：那一块会让索引里少一个文件
 * 而没人发现。所以直接失败，点名是哪个 oid。
 */
export async function readBlobHeads(
  repoId: string,
  blobs: readonly BlobRequest[],
  opts: { maxLines?: number; timeoutMs?: number } = {},
): Promise<MirrorResult<Map<string, string>>> {
  const maxLines = Number.isFinite(opts.maxLines) && (opts.maxLines ?? 0) > 0
    ? Math.floor(opts.maxLines as number)
    : 80;
  // 去重：同一块内容出现在 40 个路径上时，这里只请求一次。
  const unique = new Map<string, number>();
  for (const blob of blobs) {
    const sha = blob.blobSha.trim();
    if (sha === '') continue;
    if (!unique.has(sha)) unique.set(sha, Math.max(0, blob.size));
  }
  const out = new Map<string, string>();
  if (unique.size === 0) return ok(out);

  const resolved = await resolveRepo(repoId);
  if ('ok' in resolved) return resolved;
  const args = ['cat-file', '--batch'];
  if (!isReadOnlyGitArgs(args)) {
    return fail('not_read_only', `内部错误：只读校验拒绝了一条命令（${args.join(' ')}）`);
  }

  const oids = [...unique.keys()];
  const budget = 4 * 1024 * 1024 + [...unique.values()].reduce((sum, size) => sum + size, 0);
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  const run = await runGitStdin(gitArgv(resolved.config, resolved.repo.path, args), oids.join('\n') + '\n', {
    maxBytes: budget,
    timeoutMs,
  });
  const failure = runFailure(run, timeoutMs, 'git cat-file');
  if (failure !== null) return failure;

  const parsed = parseCatFileBatch(run.stdout);
  for (const sha of oids) {
    const content = parsed.get(sha);
    if (content === undefined) {
      return fail(
        'git_failed',
        `镜像里读不到对象 ${sha}（${repoId}）：cat-file --batch 没有回它，`
        + '可能是镜像被 gc 过或这个 oid 属于别的仓',
      );
    }
    out.set(sha, headLines(content.toString('utf8'), maxLines));
  }
  return ok(out);
}

/**
 * `git cat-file --batch` 的输出切分：每条是 `<oid> <type> <size>\n<content>\n`。
 *
 * 被请求但不存在时 git 回 `<oid> missing\n`（没有 size、没有正文）——这里跳过它，
 * 由调用方按「请求了却没拿到」判失败。二进制内容按**长度**切，不按行切：
 * 源码里可以有 `\n`、可以有非 UTF-8 字节，按行切会错位。
 */
export function parseCatFileBatch(buffer: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let offset = 0;
  while (offset < buffer.length) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline < 0) break;
    const header = buffer.subarray(offset, newline).toString('utf8');
    const match = /^([0-9a-f]{4,64}) (\w+)(?: (\d+))?$/.exec(header);
    offset = newline + 1;
    if (match === null) continue;
    const sha = match[1] ?? '';
    const sizeText = match[3];
    if (sizeText === undefined) continue; // `<oid> missing` / `<oid> ambiguous`
    const size = Number(sizeText);
    if (!Number.isFinite(size) || size < 0) continue;
    out.set(sha, buffer.subarray(offset, offset + size));
    offset += size + 1; // 正文之后 git 补一个换行
  }
  return out;
}

/**
 * 与 `runGit` 同形，但**往 stdin 写一段文本**（`cat-file --batch` 要这个）。
 *
 * 唯一的额外约束是输出预算：超过 `maxBytes` 就杀掉进程并标 `outputLimited`，
 * 让调用方拿到一句中文失败，而不是半份字节流。
 */
function runGitStdin(
  argv: string[],
  input: string,
  opts: { timeoutMs: number; maxBytes: number },
): Promise<GitRun> {
  const [bin, ...rest] = argv;
  return new Promise((resolve) => {
    const child = spawn(bin ?? 'git', rest, { windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    let timedOut = false;
    let limited = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > opts.maxBytes) {
        limited = true;
        child.kill('SIGTERM');
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        exitCode: null, timedOut: false, spawnError: `${error.code ?? 'error'}: ${error.message}`,
        outputLimited: false, stdout: Buffer.alloc(0), stderr,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code === null ? null : Number(code),
        timedOut,
        spawnError: null,
        outputLimited: limited,
        stdout: Buffer.concat(chunks),
        stderr,
      });
    });
    child.stdin.on('error', () => { /* 进程被杀时写 stdin 会 EPIPE：那是结果的一部分 */ });
    child.stdin.end(input);
  });
}

// ─── 第七个读口：合并历史 ────────────────────────────────────────────────────

/** 一条合并记录。`files` 只含源码扩展名——docs/、png、package.json 不是「功能的位置」。 */
export type MergeRecord = {
  sha: string;
  /** 提交时间，ISO 8601（`%cI`：带时区偏移，与 `head()` 同一格式）。 */
  mergedAt: string;
  /** 合并标题里解析出的分支名；标题里没有来源分支（如手写的合并信息）时为 null。 */
  branch: string | null;
  /** 该分支自己的非合并提交信息，` / ` 拼接。 */
  message: string;
  files: string[];
};

const HISTORY_SRC = /\.(tsx?|jsx?|vue)$/i;
/** 记录之间用 \u0001 分隔，字段之间用 \u0002——提交信息里可能有换行与竖线。 */
const REC = '\u0001';
const FLD = '\u0002';

/**
 * 读一次合并历史最多等多久：两个仓合计 657 条合并，实测 uni-app 124 条 1.7 秒、
 * pc 533 条 16 秒。240 秒是给「机房网络抖一下」的余量，不是正常耗时。
 */
const HISTORY_TIMEOUT_MS = 240_000;

/**
 * POSIX 单引号字面量。
 *
 * `ssh <host> bash -lc <script>` 里 ssh 会把 argv 从主机名之后用**空格**拼成一条
 * 远端命令行（文件头第 1 条规矩的反面：这一层我们躲不掉），所以带空格与换行的
 * 脚本必须自己先变成「一个词」，否则远端 shell 会把它拆成几十个参数，`bash -lc`
 * 只拿到第一个词。单引号里除了 `'` 没有任何字符需要转义，所以只处理 `'`。
 */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/**
 * 一次合并的取数脚本：**一个 shell** 里跑完所有合并。
 *
 * 为什么把 git 脚本写在远端而不是每条合并来一次往返：123pan-uni-app 124 条、
 * 123pan-pc 533 条合并，逐条（每条要 4 次 git）就是两千多次 ssh 往返，几十秒到
 * 几分钟；这里一次把结果吐回来，实测 uni-app 1.7 秒、pc 16 秒。`git log` 拿不到
 * 「某次合并带进来的那些提交」，那是一个区间（`m^1..m`），只有循环能做到。
 *
 * 两个约束写在这里的原因：
 * - 仓库路径从 argv 进来（`$1`）、`--since` 从 argv 进来（`$2`）：脚本是**被 shell
 *   解释的文本**，把配置里的路径拼进去等于把它再解释一遍（路径里有引号就散了）。
 * - 提交信息**不**用 `|` 之类的分隔符拼接：`$msgs`、`$files` 原样保留换行（提交标题
 *   里可以有竖线），切分交给调用方——字段分隔符只有 \u0002。
 */
const HISTORY_SCRIPT = [
  // 管道的退出码默认是**最后一个命令**的：`git rev-list | while read` 里 rev-list 失败
  // 会被整个吞掉，于是「路径配错 / 镜像没建好」变成一份空历史。所以这里两道都上：
  // pipefail 兜住管道，rev-list 也不进管道——它的输出先落到变量里、单独查退出码。
  'set -o pipefail',
  'G="$1"',
  // `--git-dir` 而不是 `cd`：与 `gitArgv` 同一约定；而且「配置里的路径是某个仓库的
  // 子目录」时不会误读父仓（cd 进去再跑 git 会往上找到父仓的 .git）。
  'git --git-dir="$G" rev-parse --git-dir >/dev/null || exit 10',
  // $2 为空时 ${2:+...} 一个词都不展开；非空时**必须**整体引用成一个词，
  // 否则 `--since=2026-07-01 00:00:00` 会被拆成「日期 + 一个叫 00:00:00 的引用」。
  'mers=$(git --git-dir="$G" rev-list --merges ${2:+"--since=$2"} HEAD) || exit 11',
  '[ -n "$mers" ] || exit 0',
  'printf "%s\\n" "$mers" | while read -r m; do',
  '  at=$(git --git-dir="$G" log -1 --format=%cI "$m")',
  '  subj=$(git --git-dir="$G" log -1 --format=%s "$m")',
  '  msgs=$(git --git-dir="$G" log --no-merges --format=%s "$m^1..$m" 2>/dev/null)',
  // 相对**第一父提交**的差异 = 这次合并真正带进来的文件。
  '  files=$(git --git-dir="$G" diff --name-only "$m^1" "$m" 2>/dev/null | grep -E "\\.(tsx?|jsx?|vue)\\$")',
  '  printf "%s\\002%s\\002%s\\002%s\\002%s\\001" "$m" "$at" "$subj" "$msgs" "$files"',
  'done',
].join('\n');

/** 脚本自己的退出码 → 一句人话（其余退出码交给 `runFailure` 兜）。 */
const HISTORY_EXIT: Readonly<Record<number, string>> = {
  10: '这个路径不是 git 仓库（`--git-dir` 认不出它，镜像可能没建好或路径配错）',
  11: 'git rev-list 失败（引用不存在、镜像损坏或 --since 不被接受）',
};

/**
 * `since` 只收 ISO 8601 的日期/时间（我们的增量逻辑自己给的值）。
 *
 * 为什么要在本地校验：`--since=garbage-date` 在 git 里**不报错**——按 approxidate
 * 猜成一个日期、rev-list 退出 0、输出为空（实测 git 2.39）。也就是说「日期写错」
 * 与「这个仓没有合并」在 git 那一层长得一模一样，只能在进来之前挡住。
 */
const HISTORY_SINCE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * 脚本的 argv：本地是 `bash -lc <script> bash <path> [since]`，远端只是前面多一段
 * `ssh <opts> <host>`——与 `gitArgv` 完全同形的两条路（见文件头第 1 条），**不是**
 * 第三条 transport 判断。远端那一份额外做了 shell 引用（ssh 会重新拼一次命令行）。
 */
function historyArgv(
  config: Pick<MirrorConfig, 'transport' | 'sshHost'>,
  repoPath: string,
  since: string,
): string[] {
  // 位置参数：$0 = "bash"，$1 = 仓库路径，$2 = since（可选）。
  const locals = since === '' ? ['bash', repoPath] : ['bash', repoPath, since];
  if (config.transport === 'local') return ['bash', '-lc', HISTORY_SCRIPT, ...locals];
  return ['ssh', ...SSH_OPTS, config.sshHost, 'bash', '-lc', shellQuote(HISTORY_SCRIPT), ...locals.map(shellQuote)];
}

/**
 * 合并标题里的分支名。
 *
 * 这个仓的镜像来自 Gitea，标题形如 `Merge #12 into master from feat-userEquity-fjd`；
 * git 自己生成的则是 `Merge branch 'feat/x' into master`。两种都认，认不出来就是
 * null——**不猜**：`branch` 会进库给人看，编一个比空着更糟。
 */
function mergeBranch(subject: string): string | null {
  const from = /.*\bfrom\s+(\S+)/.exec(subject);
  if (from?.[1] !== undefined) return from[1];
  const quoted = /Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject);
  return quoted?.[1] ?? null;
}

/**
 * 一次取回**全部**合并记录（读口 7）。
 *
 * 省掉的往返见 `HISTORY_SCRIPT`；这里只强调两件事：
 * 1. 失败照旧是数据（超时、ssh 连不上、退出码非 0 都给中文 message）；
 * 2. 输出被缓冲上限截断时**报失败**，不交半份：调用方会把这些行当「全部合并」写库，
 *    一份看起来完整的半份历史比一次明确的失败更难发现。
 *
 * `since` 用于增量：只取比它新的合并（历史只增不改，所以「缺就补」永远安全）。
 */
export async function mergeHistory(
  repoId: string,
  opts: { since?: string } = {},
): Promise<MirrorResult<MergeRecord[]>> {
  const resolved = await resolveRepo(repoId);
  if ('ok' in resolved) return resolved;

  const since = opts.since?.trim() ?? '';
  // 日期在本地就挡住：git 对 `--since=garbage-date` 是**不报错**的（见 HISTORY_SINCE），
  // 放进去只会得到一份空历史，和「这个仓没有合并」分不开。
  if (since !== '' && !HISTORY_SINCE.test(since)) {
    return fail(
      'bad_config',
      `since 不合法：「${since}」（要 ISO 8601，例如 2026-07-01、2026-07-01T00:00:00+08:00）`,
    );
  }

  const argv = historyArgv(resolved.config, resolved.repo.path, since);
  // 这一条不走 `read()`：它是脚本不是 git argv，`isReadOnlyGitArgs()` 的
  // 「第一个词必须是只读子命令」对它不成立。脚本内部只有 rev-list / log / diff
  // 三条读命令（`--git-dir` 读、无工作区），只读是构造上的——见 HISTORY_SCRIPT。
  const run = await runGit(argv, { timeoutMs: HISTORY_TIMEOUT_MS });

  const bin = argv[0] ?? 'bash';
  // 报错必须点名是哪个仓：仓库路径配错是这里最常见的运维失误，一句「读取失败」
  // 让人根本不知道去看哪一条配置。
  const label = `${repoId}（${resolved.repo.path}）`;
  if (run.outputLimited) {
    return fail('git_failed', `合并历史的输出超出缓冲上限，已拒收半份：${label}`);
  }
  const failure = runFailure(run, HISTORY_TIMEOUT_MS, bin);
  if (failure !== null) {
    const hint = run.exitCode === null ? null : HISTORY_EXIT[run.exitCode] ?? null;
    const why = hint === null ? failure.message : `${hint}；${failure.message}`;
    return fail(failure.code, `读合并历史失败：${label}：${why}`);
  }

  const out: MergeRecord[] = [];
  for (const rec of run.stdout.toString('utf8').split(REC)) {
    if (rec.trim() === '') continue;
    const parts = rec.split(FLD);
    // 一条记录**恰好** 5 个字段；少一个就是被截断的残行，多一个说明提交标题里
    // 混进了字段分隔符——两种都不猜，直接丢。
    if (parts.length !== 5) continue;
    // 登录 shell 的 profile 可能往 stdout 吐一行东西（`bash -lc`）；sha 在字段 1 里
    // 用 40 位十六进制锚定，那一行就不会把第一条记录读歪。
    const sha = /[0-9a-f]{40}/.exec(parts[0] ?? '')?.[0];
    if (sha === undefined) continue;
    const [, at, subject, msgs, files] = parts;
    out.push({
      sha,
      mergedAt: (at ?? '').trim(),
      branch: mergeBranch(subject ?? ''),
      message: (msgs ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .join(' / '),
      files: (files ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && HISTORY_SRC.test(line)),
    });
  }
  return ok(out);
}
