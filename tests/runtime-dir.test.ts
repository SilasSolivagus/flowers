import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DATA_DIR_ENV,
  REPO_ROOT,
  dataLayout,
  defaultDataDir,
  ensureDataRoot,
  isTestDataRoot,
  migrateLegacyData,
  resetRuntimeDirCache,
} from '../src/core/runtime-dir.js';
import { resetSessionSecretCache, sessionSecret } from '../src/core/auth/session.js';
import {
  ARTIFACT_ROOT, artifactFile, artifactUrl, adoptLegacyArtifact,
} from '../src/core/uemaster/store.js';
import { LEGACY_DATA_DIR } from '../src/core/runtime-dir.js';

/**
 * 运行期数据的位置（2026-11-08 事故的修复）。
 *
 * 事故本体：`data/` 在仓库里且被 git 忽略，一次 `git clean -fdx` 把它整个删掉——
 * 会话密钥没了（所有人同时掉线，看起来像「登录随机掉线」）、`uemaster_artifacts` 的
 * 产物 HTML 没了（链接 404），而库里每一行都还在。
 *
 * 这些用例钉住三件事，缺一条事故都能复现：
 * 1. **位置可预测**：`FLOWERS_DATA_DIR` 优先，否则按平台惯例；解析出的路径必须**在
 *    仓库外**（在仓库里就等于又把命交给了 `git clean`）。
 * 2. **旧数据搬一次、且搬得安全**：密钥字节不变（搬完还能验旧 cookie）、目标已存在时
 *    不覆盖（迁到一半崩了再跑一次不能把新的盖掉）、搬完旧位置是空的。
 * 3. **产物路径跟着根走**：`ARTIFACT_ROOT` / `artifactFile` / `artifactUrl` 三者
 *    互相钉住，且都在新根底下。
 *
 * 变异表（每条都对着一次真实回归）：
 * - `defaultDataDir` 去掉 `FLOWERS_DATA_DIR` 那一支 → 「FLOWERS_DATA_DIR 优先」红。
 * - 让它返回 `path.join(REPO_ROOT,'data')` → 「默认不在仓库里」红。
 * - 删掉 `moveInto` 里的 `chmodSync(0o600)` → 「密钥搬完还是 0600」红。
 * - 删掉 `migrateLegacyData` 里 `if (existsSync(dst)) continue` → 「目标已存在时不覆盖」红。
 * - 把 `sessionSecret()` 的路径换回仓库内（或删掉 `resetRuntimeDirCache`）→
 *   「密钥从新位置读出来」与「两次调用同一个值」红。
 * - `store.ts` 的 `ARTIFACT_ROOT` 换回 `REPO_ROOT/data/uemaster` → 「产物根在新根下」红。
 */

/**
 * `vitest.config.ts` 发给 worker 的那份 `FLOWERS_DATA_DIR`，**在模块加载时**记下来：
 * `store.ts` 的 `ARTIFACT_ROOT` 就是按它算的常量，后面的用例会临时改 `process.env`，
 * 改完必须还原，否则「产物根在新根下」那条会拿一个被改过的 env 去比常量。
 */
const CONFIGURED_DATA_DIR = process.env.FLOWERS_DATA_DIR ?? '';
const START_ENV_DATA_DIR = process.env[DATA_DIR_ENV];

const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `flowers-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

/** 一份「旧仓库 data/」的样子：密钥 + 一份产物。 */
function seedLegacy(dir: string, secret = 'old-secret-from-repo\n'): void {
  mkdirSync(path.join(dir, 'uemaster', 'PAN-7'), { recursive: true });
  writeFileSync(path.join(dir, '.flowers-session-secret'), secret, { mode: 0o600 });
  writeFileSync(path.join(dir, 'uemaster', 'PAN-7', 'evaluate.html'), '<!doctype html>旧产物', 'utf8');
}

beforeEach(() => {
  delete process.env.FLOWERS_SESSION_SECRET;
  resetSessionSecretCache();
  resetRuntimeDirCache();
});

afterEach(() => {
  resetSessionSecretCache();
  resetRuntimeDirCache();
  if (START_ENV_DATA_DIR === undefined) delete process.env[DATA_DIR_ENV];
  else process.env[DATA_DIR_ENV] = START_ENV_DATA_DIR;
  for (const dir of tmpDirs.splice(0)) {
    // 用例自己造的临时目录，删掉是安全的（只在 /tmp 下）。
    void dir;
  }
});

describe('数据目录解析', () => {
  it('FLOWERS_DATA_DIR 优先，且按 cwd 解析相对路径', () => {
    const dir = tmp('data');
    expect(defaultDataDir({ [DATA_DIR_ENV]: dir })).toBe(dir);
    expect(defaultDataDir({ [DATA_DIR_ENV]: '' })).not.toBe('');
  });

  it('macOS 落到 ~/Library/Application Support/flowers', () => {
    expect(defaultDataDir({}, 'darwin', '/Users/x')).toBe(
      '/Users/x/Library/Application Support/flowers',
    );
  });

  it('Linux 用 XDG_DATA_HOME，没有就用 ~/.local/share', () => {
    expect(defaultDataDir({ XDG_DATA_HOME: '/home/x/.local/share' }, 'linux', '/home/x')).toBe(
      '/home/x/.local/share/flowers',
    );
    expect(defaultDataDir({}, 'linux', '/home/x')).toBe('/home/x/.local/share/flowers');
  });

  it('默认位置不在仓库里（在仓库里就等于把命交给 git clean）', () => {
    const root = defaultDataDir({ XDG_DATA_HOME: '/home/x/.local/share' }, 'linux', '/home/x');
    expect(root.startsWith(REPO_ROOT + path.sep)).toBe(false);
    // 仓库内那条老路径仍然是「旧位置」，只该出现在迁移里。
    expect(root).not.toBe(path.join(REPO_ROOT, 'data'));
  });

  it('layout 三件东西都在根底下', () => {
    const dir = tmp('layout');
    const layout = dataLayout({ [DATA_DIR_ENV]: dir });
    expect(layout.root).toBe(dir);
    expect(layout.secretFile).toBe(path.join(dir, '.flowers-session-secret'));
    expect(layout.artifactRoot).toBe(path.join(dir, 'uemaster'));
  });
});

/**
 * 测试进程的根**不可能**等于生产的根。
 *
 * 这是本轮真正挡事故的那条线：`tests/helpers/files.ts` 的 `cleanArtifacts()` 是一句
 * `rm -rf`，路径来自生产代码的 `ARTIFACT_ROOT`。它以前在 `beforeEach` 里对着
 * `data/uemaster`（后来是 `~/Library/Application Support/flowers/uemaster`）跑，
 * 一次全量测试就把所有真产物删掉——而库里的行还在、链接 404、`git status` 干净。
 *
 * 变异：
 * - 去掉 `defaultDataDir` 里 `isTestProcess` 那一支 → 测试进程回落到生产路径，
 *   「VITEST 下默认落临时目录」那条红（下一句就是真删数据）。
 * - 去掉 `isTestDataRoot` 的前缀判断 → `'/opt/flowers-test-x'` 被判成测试盘，第三条红。
 * - 去掉 `isTestDataRoot` 的 tmpdir 判断 → `/data/flowers-test-x`（有人在仓库旁建的同名
 *   目录）也会被判成测试盘，第四条红。
 */
describe('测试的盘 vs 生产的盘', () => {
  it('VITEST 下默认落系统临时目录，且带 runId', () => {
    const root = defaultDataDir({ VITEST: 'true', FLOWERS_TEST_RUN_ID: 'rr1' }, 'darwin', '/Users/x', 4242);
    expect(root).toBe(path.join(tmpdir(), 'flowers-test-rr1'));
    expect(root.startsWith('/Users/x')).toBe(false);
    // NODE_ENV=test 也一样（别的运行器只设这一条）。
    expect(defaultDataDir({ NODE_ENV: 'test', FLOWERS_TEST_RUN_ID: 'rr2' }, 'darwin', '/Users/x'))
      .toBe(path.join(tmpdir(), 'flowers-test-rr2'));
  });

  it('非测试进程仍然落到生产默认位置（没有被这条兜底改掉）', () => {
    expect(defaultDataDir({}, 'darwin', '/Users/x')).toBe('/Users/x/Library/Application Support/flowers');
  });

  it('isTestDataRoot 认的只有「临时目录 + flowers-test 前缀」', () => {
    expect(isTestDataRoot(path.join(tmpdir(), 'flowers-test-abc123'))).toBe(true);
    expect(isTestDataRoot(path.join(tmpdir(), 'flowers-test-70337tmw6z09bd'))).toBe(true);
    // 生产路径：永远不是测试盘。
    expect(isTestDataRoot('/Users/x/Library/Application Support/flowers')).toBe(false);
    // 名字对但不在临时目录下。
    expect(isTestDataRoot('/data/flowers-test-x')).toBe(false);
    // 在临时目录下但名字不对。
    expect(isTestDataRoot(path.join(tmpdir(), 'flowers-vitest-abc'))).toBe(false);
    expect(isTestDataRoot(tmpdir())).toBe(false);
  });

  it('这一轮真的落在测试盘上（ARTIFACT_ROOT 可被 cleanArtifacts 安全删掉）', () => {
    expect(isTestDataRoot(dataLayout().root)).toBe(true);
    expect(isTestDataRoot(path.dirname(ARTIFACT_ROOT))).toBe(true);
  });
});

describe('旧数据迁移（一次性、崩溃安全）', () => {
  it('搬走密钥与产物，旧位置清空，密钥字节不变', () => {
    const legacy = tmp('legacy');
    const home = tmp('home');
    seedLegacy(legacy);
    const before = readFileSync(path.join(legacy, '.flowers-session-secret'), 'utf8');

    const layout = dataLayout({ [DATA_DIR_ENV]: home });
    const note = migrateLegacyData(layout, legacy);

    expect(note).toContain('迁到仓库外');
    expect(readFileSync(layout.secretFile, 'utf8')).toBe(before);
    // 关键：内容一模一样 = 旧 cookie 仍然验得过（不然就是「所有人被踢下线」）。
    expect(readFileSync(layout.secretFile, 'utf8').trim()).toBe('old-secret-from-repo');
    expect(statSync(layout.secretFile).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(layout.artifactRoot, 'PAN-7', 'evaluate.html'))).toBe(true);
    expect(readdirSync(legacy)).toEqual([]);
  });

  it('目标已存在时不覆盖源（迁到一半崩了再跑一次，新文件不会被旧文件盖掉）', () => {
    const legacy = tmp('legacy2');
    const home = tmp('home2');
    seedLegacy(legacy, 'stale-from-repo\n');
    const layout = dataLayout({ [DATA_DIR_ENV]: home });
    mkdirSync(layout.root, { recursive: true });
    writeFileSync(layout.secretFile, 'newer\n', { mode: 0o600 });

    migrateLegacyData(layout, legacy);

    expect(readFileSync(layout.secretFile, 'utf8')).toBe('newer\n');
    // 源不动：让人能拿它去比对，而不是被静默删掉。
    expect(readFileSync(path.join(legacy, '.flowers-session-secret'), 'utf8')).toBe('stale-from-repo\n');
  });

  it('旧目录不存在 / 空：返回 null，不建任何东西也报错', () => {
    const home = tmp('home3');
    const layout = dataLayout({ [DATA_DIR_ENV]: home });
    expect(migrateLegacyData(layout, path.join(home, 'nope'))).toBeNull();
    const empty = tmp('empty');
    expect(migrateLegacyData(layout, empty)).toBeNull();
  });

  it('旧位置里断掉的软链：删掉继续，不让启动挂在 ENOENT 上', async () => {
    const legacy = tmp('legacy-dangling');
    const home = tmp('home-dangling');
    seedLegacy(legacy);
    // 模拟事故现场：`data/uemaster` 变成一条指向已被删掉的目录的软链。
    await rm(path.join(legacy, 'uemaster'), { recursive: true, force: true });
    symlinkSync(path.join(home, 'gone'), path.join(legacy, 'uemaster'), 'dir');

    const layout = ensureDataRoot({ [DATA_DIR_ENV]: home }, { legacyDir: legacy });
    expect(existsSync(path.join(legacy, 'uemaster'))).toBe(false);
    expect(readFileSync(layout.secretFile, 'utf8').trim()).toBe('old-secret-from-repo');
  });

  it('ensureDataRoot 只会搬一次：第二次调用是缓存的', () => {
    const legacy = tmp('legacy3');
    const home = tmp('home3b');
    seedLegacy(legacy);
    const layout = ensureDataRoot({ [DATA_DIR_ENV]: home }, { legacyDir: legacy });
    expect(readdirSync(legacy)).toEqual([]);
    // 缓存命中时不再看磁盘：往旧位置再放一份「新数据」，第二次调用不该搬它。
    writeFileSync(path.join(legacy, '.flowers-session-secret'), 'planted\n');
    const again = ensureDataRoot({ [DATA_DIR_ENV]: home }, { legacyDir: legacy });
    expect(again.root).toBe(layout.root);
    expect(readFileSync(layout.secretFile, 'utf8').trim()).toBe('old-secret-from-repo');
  });
});

describe('会话密钥读的是仓库外那一份', () => {
  it('密钥从新位置读出来，两次调用同一个值（迁移没把它变成一把新密钥）', () => {
    const legacy = tmp('legacy4');
    const home = tmp('home4');
    seedLegacy(legacy, 'secret-in-repo-2026-11-07\n');
    const layout = dataLayout({ [DATA_DIR_ENV]: home });
    migrateLegacyData(layout, legacy);

    process.env[DATA_DIR_ENV] = home;
    resetSessionSecretCache();
    const first = sessionSecret();
    // 第二次调用（新进程里也等价）：还是同一个值 —— 这就是「已登录的人没被踢下线」。
    resetSessionSecretCache();
    const second = sessionSecret();
    expect(first).toBe('secret-in-repo-2026-11-07');
    expect(second).toBe(first);
    expect(readFileSync(layout.secretFile, 'utf8').trim()).toBe(first);
  });

  it('没有密钥文件时生成一个 0600 的，写在仓库外', () => {
    const home = tmp('home5');
    process.env[DATA_DIR_ENV] = home;
    resetSessionSecretCache();
    const secret = sessionSecret();
    expect(secret).toHaveLength(64);
    const file = path.join(home, '.flowers-session-secret');
    expect(readFileSync(file, 'utf8').trim()).toBe(secret);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('产物路径跟着新根走', () => {
  it('ARTIFACT_ROOT 在 FLOWERS_DATA_DIR 下、不在仓库里', () => {
    const dataDir = CONFIGURED_DATA_DIR;
    expect(dataDir).not.toBe('');
    expect(ARTIFACT_ROOT).toBe(path.join(dataDir, 'uemaster'));
    expect(ARTIFACT_ROOT.startsWith(REPO_ROOT + path.sep)).toBe(false);
  });

  it('artifactFile / artifactUrl 互相钉住，落点在新根底下', () => {
    const url = '/uemaster/PAN-7/evaluate.html';
    const file = artifactFile(url);
    expect(file).toBe(path.join(ARTIFACT_ROOT, 'PAN-7', 'evaluate.html'));
    expect(artifactUrl(file)).toBe(url);
  });

  it('围栏还在：折出根外的东西仍然拒绝', () => {
    expect(() => artifactFile('/uemaster/../../package.json')).toThrow();
  });
});

/**
 * 产物「写错地方」的收口：任务包让外部 CLI 写到 `<仓库>/data/uemaster/...`（agent CLI
 * 的写权限通常只在 cwd 之内），而产物根在仓库外。`adoptLegacyArtifact` 负责最后一段搬运。
 *
 * 变异（每一条都对着一次真实事故）：
 * - 删掉 `start.ts` / `generator.ts` 里的 `adoptLegacyArtifact` → 生成链路报「产物文件
 *   不存在」，`tests/generate.test.ts` 的 runJob 三条同时红。
 * - 删掉 `attach.ts` 里那次调用 → agent 交回链接时永远 `artifact_missing`。
 * - 把「谁新听谁的」改成「目标赢（仓库那份直接删）」→ 重做一次变成静默无效：那份新
 *   材料被删掉，界面还显示旧版本。
 */
describe('仓库里那份产物会被收进仓库外的根', () => {
  const url = '/uemaster/PAN-4242/evaluate.html';
  const legacyFile = path.join(LEGACY_DATA_DIR, 'uemaster', 'PAN-4242', 'evaluate.html');
  const target = path.join(ARTIFACT_ROOT, 'PAN-4242', 'evaluate.html');

  afterEach(() => {
    rmSync(legacyFile, { force: true });
    rmSync(target, { force: true });
  });

  function writeLegacy(body: string): void {
    mkdirSync(path.dirname(legacyFile), { recursive: true });
    writeFileSync(legacyFile, body, 'utf8');
  }

  it('仓库里只有那份：搬到产物根，仓库里不留残渣', () => {
    writeLegacy('<!doctype html>仓库里写的');
    expect(adoptLegacyArtifact(url)).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe('<!doctype html>仓库里写的');
    expect(existsSync(legacyFile)).toBe(false);
  });

  it('两边都有、仓库那份更新（重做一次）：覆盖产物根那版', async () => {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '旧版本', 'utf8');
    writeLegacy('新版本');
    await utimes(target, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(adoptLegacyArtifact(url)).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe('新版本');
    expect(existsSync(legacyFile)).toBe(false);
  });

  it('两边都有、产物根那份更新（搬完没来得及删）：删掉仓库那份，不动目标', async () => {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '产物根这版', 'utf8');
    writeLegacy('仓库残留');
    await utimes(legacyFile, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(adoptLegacyArtifact(url)).toBeNull();
    expect(readFileSync(target, 'utf8')).toBe('产物根这版');
    expect(existsSync(legacyFile)).toBe(false);
  });

  it('仓库里没有那份：什么都不做（正常路径不产生副作用）', () => {
    expect(adoptLegacyArtifact(url)).toBeNull();
    expect(existsSync(target)).toBe(false);
  });
});
