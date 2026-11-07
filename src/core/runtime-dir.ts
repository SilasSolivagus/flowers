import { chmodSync, closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 运行期数据的**唯一**位置来源：进程里所有「要落盘、但不属于源码」的东西都从这里取路径。
 *
 * ── 为什么必须住在仓库外
 *
 * 2026-11-08 的事故：`data/` 是仓库里的 git 忽略目录，一次 `git clean -fdx` 把它整个删掉，
 * 库里 `uemaster_artifacts` 的行全在、链接点开是 404，会话签名密钥也一起没了——所有人
 * 手里的 cookie 同时失效，看起来像「登录随机掉线」。删完 `git status` 还是干净的，
 * 当场没人发现。
 *
 * 根因不是「谁手滑敲了 -fdx」，而是**把不可重建的东西放在了可被「清理未跟踪文件」清掉的
 * 位置上**。清理未跟踪文件是正常操作（dev 里天天做），不可重建的数据（会话密钥、别人
 * 评审过的产物 HTML）不该住在会被清理的目录里。所以在仓库外给它们一个家：那里没有任何
 * git 命令会走到，`git clean` 再怎么 `-x` 都碰不到。
 *
 * 默认位置按平台惯例：
 * - macOS：`~/Library/Application Support/flowers`
 * - Linux（及其它）：`$XDG_DATA_HOME/flowers`，没有 `XDG_DATA_HOME` 时 `~/.local/share/flowers`
 * - 覆盖：`FLOWERS_DATA_DIR`（测试用它把产物写到临时目录，绝不在开发者的真目录里造文件）
 *
 * ── 为什么只有这一个模块
 *
 * 改之前有两份各自拼路径的代码（`session.ts` 拼密钥、`store.ts` 拼产物根）。两份路径
 * 逻辑的下场是「迁了一半」：密钥搬走了、产物还在仓库里，于是同一次 `git clean -fdx`
 * 仍然能删掉产物。路径这件事只允许有一个答案，所以连迁移、`mkdir`、以及仓库内那条
 * **指向仓库外的兼容软链**都放在这里，调用方只拿结果。
 */

/** 覆盖数据目录的环境变量。测试与「我就是想换个盘」都用它。 */
export const DATA_DIR_ENV = 'FLOWERS_DATA_DIR';

/** 只看这几个键；写成 Record 是为了让用例能凭空造一份 env，不必改 process.env。 */
export type DirEnv = Record<string, string | undefined>;

/**
 * 仓库根：按**模块位置**算，不认 `process.cwd()`。
 *
 * 有一条既有用例会把 cwd 换到 /tmp 去验「产物根跟着模块走」；MCP server 更是被别人
 * 的客户端起在任意目录里。按 cwd 找仓库根，等于「从 /tmp 启动就永远是空目录」。
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 旧位置：仓库里的 `data/`。只为迁移而存在，读它之前先想清楚「是不是在搬最后一份」。 */
export const LEGACY_DATA_DIR = path.join(REPO_ROOT, 'data');

/**
 * 默认数据目录（纯函数：平台与 home 可注入，用例不必真在 macOS 上跑）。
 *
 * `FLOWERS_DATA_DIR` 允许相对路径——按 cwd 解析一次，而不是留给后续每个 `path.join`
 * 各自去猜。设了就必须用它，空字符串等于没设（env 里 `FLOWERS_DATA_DIR=` 很常见）。
 */
/** 测试进程的临时数据目录前缀。`cleanArtifacts()` 与写入侧都靠它认「这是测试的盘」。 */
export const TEST_DATA_PREFIX = 'flowers-test-';

/** 测试数据目录的形状：`<tmpdir>/flowers-test-<runId>`。 */
export const TEST_DATA_SHAPE = /[\\/]flowers-test-[A-Za-z0-9_]+$/;

/**
 * 进程是不是测试跑（与 `src/db/url.ts` 的 `isTestRun` 同一条判据，两处不合并是因为
 * 这一层不 import `src/db/*`：运行期目录不该把数据库拖进来）。
 */
function isTestProcess(env: DirEnv): boolean {
  return env.VITEST === 'true' || env.NODE_ENV === 'test';
}

/**
 * 测试跑的 runId：与库名后缀同一个来源（`FLOWERS_TEST_RUN_ID`，由 `vitest.config.ts`
 * 生成），退化路径也一样（`VITEST_POOL_ID` → pid）。
 *
 * 为什么要和库用同一个 id：一次跑 = 一张库 + 一个产物目录。两者对不上时，出问题的人
 * 会在「这轮库里的行」和「这轮的临时目录」之间反复对不齐编号。
 */
export function testRunIdOf(env: DirEnv, pid: number = process.pid): string {
  const explicit = env.FLOWERS_TEST_RUN_ID?.trim();
  if (explicit !== undefined && explicit !== '') return explicit.replace(/[^\w]/g, '_');
  const pool = env.VITEST_POOL_ID?.trim();
  if (pool !== undefined && pool !== '') return `w${pool}`;
  return `p${pid}`;
}

export function defaultDataDir(
  env: DirEnv = process.env,
  platform: string = process.platform,
  home: string = homedir(),
  pid: number = process.pid,
): string {
  const override = env[DATA_DIR_ENV]?.trim();
  if (override !== undefined && override !== '') return path.resolve(override);
  /**
   * 测试进程**永远**落到临时目录，哪怕谁忘了设 `FLOWERS_DATA_DIR`。
   *
   * 这是一道防止「用测试删数据」的兜底，不是优化。事故的形状是：`tests/helpers/files.ts`
   * 直接 import 生产代码的 `ARTIFACT_ROOT`，`cleanArtifacts()` 里一句 `rm -rf`，
   * 于是一次全量测试把所有真产物删掉——库里的行还在，抽屉里那条链接 404。
   * 只要「测试进程的根」不可能等于「生产的根」，那种事就写不出来；靠人记得设环境变量
   * 不算保证（一个漏设的 `npx vitest` 就够）。
   */
  if (isTestProcess(env)) {
    return path.join(tmpdir(), `${TEST_DATA_PREFIX}${testRunIdOf(env, pid)}`);
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'flowers');
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg !== undefined && xdg !== '') return path.join(path.resolve(xdg), 'flowers');
  return path.join(home, '.local', 'share', 'flowers');
}

/**
 * 这个根是不是「测试的盘」：在临时目录下、且目录名是 `flowers-test-*`。
 *
 * 破坏性操作（`cleanArtifacts`）与写入侧的守卫都用它。判据刻意是**两条同时成立**：
 * 只看前缀，一个叫 `/data/flowers-test` 的真目录就能骗过它；只看「在 tmpdir 下」，
 * 又会把 `/tmp` 里别人放的东西当成自己的。
 */
export function isTestDataRoot(root: string, temp: string = tmpdir()): boolean {
  const resolved = path.resolve(root);
  const base = path.basename(resolved);
  if (!base.startsWith(TEST_DATA_PREFIX)) return false;
  const parent = path.resolve(temp) + path.sep;
  return resolved.startsWith(parent);
}

/** 数据目录里那几件东西的位置。调用方只该用这个结构体，不许自己 `path.join(root, ...)`。 */
export type DataLayout = {
  /** 根目录（仓库外）。 */
  root: string;
  /** 会话签名密钥文件。 */
  secretFile: string;
  /** 产物根：`uemaster/` 下是每份评估 / 评审 / 走查的 HTML。 */
  artifactRoot: string;
};

/** 密钥文件名（放在根下，与原 `data/.flowers-session-secret` 同名，便于人工辨认）。 */
export const SECRET_FILE_NAME = '.flowers-session-secret';

/** 产物子目录名。 */
export const ARTIFACT_DIR_NAME = 'uemaster';

/** 只算路径，不碰磁盘：`resolveDataDir` 的完整版。 */
export function dataLayout(env: DirEnv = process.env): DataLayout {
  const root = defaultDataDir(env);
  return {
    root,
    secretFile: path.join(root, SECRET_FILE_NAME),
    artifactRoot: path.join(root, ARTIFACT_DIR_NAME),
  };
}

/**
 * 最佳努力的 `fsync`。
 *
 * 迁移必须做到「任何时刻崩溃，文件要么在旧的、要么在新的，且内容是完整的」。
 * 只 `copy` 不 `fsync` 时，rename 可能先于数据落盘被提交——崩溃后新位置会出现一个
 * 长度对、内容空的密钥文件，那比「没搬」更坏：它看起来成功，实际把所有会话作废。
 * 目录也 fsync 一次，让「rename 生效」这件事本身落盘。
 */
function fsyncPath(target: string): void {
  try {
    const fd = openSync(target, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // 某些文件系统（网络盘、容器 overlay）不支持对目录 fsync；这不是失败路径。
  }
}

/**
 * 把一份文件/一棵目录搬进 `dst`，崩溃安全。
 *
 * 顺序是刻意的：
 * 1. 先 `cp` 到**目标目录内**的临时名（`<dst>.migrating-<pid>`）：临时名与最终名在同一
 *    个文件系统上，`rename` 才是原子的；也顺带解决了「仓库盘与数据盘不是同一块」的
 *    `EXDEV`——跨设备复制是 cp 的事，rename 永远发生在目标那一侧。
 * 2. `fsync` 临时文件与其父目录：数据真的落盘了。
 * 3. `rename` 到最终名：0 字节窗口不存在，读者要么看到没有，要么看到完整文件。
 * 4. 最后才删旧的。删之前新的一定已经就位——所以崩溃点只有两种结果：旧的还在（下次
 *    再搬一次），或者新的完整存在（旧的残留，下次因为「目标已存在」被跳过）。
 */
/** 覆盖式搬运时旧目标先挪到这个后缀上，再一起删——目标位置不会出现「空档」。 */
const REPLACED_SUFFIX = '.replaced';

/**
 * 覆盖式搬运：`dst` 已存在时也搬过去。
 *
 * 用途只有一个——产物「重做覆盖同一份」的语义：仓库里那份（新写的）比仓库外那份新时，
 * 仓库外的旧版本要被替换掉。先 `rename` 到 `.replaced`、再把新的 `rename` 进来、
 * 最后删旧的：任何时刻 `dst` 要么是完整的旧版本、要么是完整的新版本。
 */
export function moveOnto(src: string, dst: string): void {
  let backup: string | null = null;
  if (existsSync(dst)) {
    backup = `${dst}${REPLACED_SUFFIX}-${process.pid}`;
    renameSync(dst, backup);
  }
  moveInto(src, dst);
  if (backup !== null) rmSync(backup, { recursive: true, force: true });
}

/** 尽力删掉一个空目录（不是空、不存在、被占用都当成「不用管」）。 */
export function pruneEmptyDir(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // 不存在 / 非空 / 权限：都不是错误。
  }
}

export function moveInto(src: string, dst: string): void {
  const staging = `${dst}.migrating-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(src, staging, { recursive: true, preserveTimestamps: true, force: false, errorOnExist: false });
  if (path.basename(dst) === SECRET_FILE_NAME) {
    // 密钥文件在旧位置是 0600；cp 会带 mode，这里再钉一次，免得某个 umask 组合把它放宽。
    try {
      chmodSync(staging, 0o600);
    } catch {
      // 非 POSIX 文件系统（或不支持 chmod 的挂载）跳过：内容已经对了。
    }
  }
  fsyncPath(staging);
  fsyncPath(path.dirname(dst));
  renameSync(staging, dst);
  fsyncPath(path.dirname(dst));
  rmSync(src, { recursive: true, force: true });
}

/**
 * 首次使用时把仓库里旧 `data/` 的内容搬出去（只搬一次，搬完旧位置就空了）。
 *
 * 几条规矩：
 * - **目标已存在时目标赢**：说明上一次已经搬过了（或者新位置本来就有更新的文件），
 *   此时不动旧文件——「迁到一半崩了，第二次跑」不能把新位置里更新的产物覆盖掉。
 * - 一次失败只抛一条带路径的错误，不吞：密钥搬不动必须让人看见，否则下一个请求会
 *   生成一把新密钥，静默把所有人踢下线。
 * - 返回值是一行给日志的说明（`null` = 没搬任何东西）。调用方负责打印——放在这里打印
 *   会让「用用例调它」变成一堆噪音。
 */
/** 是不是一个空目录（不存在、是文件、非空 → false）。 */
function isEmptyDir(target: string): boolean {
  try {
    return lstatSync(target).isDirectory() && readdirSync(target).length === 0;
  } catch {
    return false;
  }
}

export function migrateLegacyData(
  layout: DataLayout,
  legacyDir: string = LEGACY_DATA_DIR,
): string | null {
  if (!existsSync(legacyDir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(legacyDir);
  } catch {
    return null;
  }
  if (entries.length === 0) return null;

  mkdirSync(layout.root, { recursive: true });
  const moved: string[] = [];
  const dropped: string[] = [];
  for (const name of entries) {
    const src = path.join(legacyDir, name);
    const dst = path.join(layout.root, name);
    /**
     * 断掉的软链（旧 `data/uemaster` 曾经是指向仓库外的链，目标被删过）：没有可搬的
     * 内容，`cpSync`/`lstat` 会对它抛 ENOENT——而这条路径在进程启动的第一刻，抛出去
     * 等于整个服务起不来。删掉这条链、记一笔，继续走。
     */
    try {
      if (lstatSync(src).isSymbolicLink() && !existsSync(src)) {
        rmSync(src, { force: true });
        dropped.push(name);
        continue;
      }
    } catch {
      continue;
    }
    // 目标已存在 → 目标赢（可能是更晚的一份，也可能上一次搬过）。唯一的例外是
    // 「目标是个**空**目录」：那不是数据，是某一步先 `mkdir` 出来的壳，
    // 里面没有可丢的东西，直接让位给真正的内容。
    if (existsSync(dst)) {
      if (!isEmptyDir(dst)) continue;
      rmSync(dst, { recursive: true, force: true });
    }
    moveInto(src, dst);
    moved.push(name);
  }
  if (moved.length === 0 && dropped.length === 0) return null;
  const parts: string[] = [];
  if (moved.length > 0) {
    parts.push(`运行期数据已从仓库内 ${legacyDir}/ 迁到仓库外 ${layout.root}/（${moved.join('、')}）；`
      + '此后 git clean 不再影响它们。');
  }
  if (dropped.length > 0) {
    parts.push(`旧位置里断掉的软链已删除：${dropped.join('、')}（目标早就不在了，没有内容可搬）。`);
  }
  return parts.join(' ');
}

/** 每个进程只做一次（mkdir + 迁移）；命中缓存后是纯内存操作。 */
const ready = new Set<string>();

/**
 * 拿到数据目录，并保证它可用：建目录、必要时迁移旧数据、修好仓库内那条软链。
 *
 * 这是所有调用方唯一该调的入口。**每次进程启动只会真正执行一次**：`sessionSecret()`
 * 在每个请求的热路径上，不能每次都 `readdir` 一遍旧目录。
 */
export function ensureDataRoot(
  env: DirEnv = process.env,
  options: { legacyDir?: string } = {},
): DataLayout {
  const layout = dataLayout(env);
  if (ready.has(layout.root)) return layout;
  mkdirSync(layout.root, { recursive: true });
  // 顺序有讲究：**先迁移，再建 `uemaster/`**。反过来的话目标目录先被建出来，
  // 迁移那一步会看到一个「目标已存在」的 `uemaster`，于是整棵产物树被跳过——
  // 库里每一条链接都指向仓库外一个空目录（正是这次要修的症状）。
  /**
   * 迁移**只在没设 `FLOWERS_DATA_DIR` 时**做。
   *
   * 这不是优化，是隔离：测试把 `FLOWERS_DATA_DIR` 指到临时目录（见 `vitest.config.ts`），
   * 若那时也去搬旧目录，一次 `npx vitest run` 就会把开发机**真的**会话密钥搬进 /tmp，
   * 等于用测试替所有人注销；两个并发测试跑还会互相把仓库里那条软链改指到各自的临时目录。
   * 设了这个变量就是「这个目录我自己管」——那就只管它，不动别人的家。
   */
  // `options.legacyDir` 只给用例：它要在一个临时目录里演一遍「仓库里还有旧数据」，
  // 而不是拿真仓库的 `data/` 做实验（那里面装着开发机上唯一一份真密钥）。
  if (!hasDataDirOverride(env) || options.legacyDir !== undefined) {
    const migration = migrateLegacyData(layout, options.legacyDir);
    if (migration !== null) process.stdout.write(`${migration}\n`);
  }
  mkdirSync(layout.artifactRoot, { recursive: true });
  ready.add(layout.root);
  return layout;
}

/** 有没有用 `FLOWERS_DATA_DIR` 显式接管数据目录（空值等于没设）。 */
export function hasDataDirOverride(env: DirEnv = process.env): boolean {
  const override = env[DATA_DIR_ENV]?.trim();
  return override !== undefined && override !== '';
}

/**
 * 只用测：让下一次 `ensureDataRoot` 重新走一遍磁盘（改了 `FLOWERS_DATA_DIR` 之后必须调，
 * 否则拿到的还是上一个目录）。与 `resetSessionSecretCache` 是一对。
 */
export function resetRuntimeDirCache(): void {
  ready.clear();
}
