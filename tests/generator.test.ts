import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { AppError } from '../src/core/errors.js';
import { CANDIDATES, commandReady, placeholderIn } from '../src/core/uemaster/candidates.js';
import { clearDetectionCache, detect } from '../src/core/uemaster/detect.js';
import {
  commandFor, htmlDocumentIn, quoteForShell, resolveGenerator, runGenerator, testGenerator,
} from '../src/core/uemaster/generator.js';
import { packFor } from '../src/core/uemaster/packs.js';
import {
  generatorCommand, generatorView, readTest, saveGeneratorCommand, writeTest,
} from '../src/core/uemaster/settings.js';
import { runJob, startGeneration } from '../src/core/uemaster/start.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { REPO_ROOT, artifactExists, cleanArtifacts } from './helpers/files.js';

/**
 * P2.7 的生成器选择：候选表、探测、解析顺序、两种命令形状、两种产物交法、
 * 设置页那 10 秒小测。
 *
 * 这一组用例要证明的**不是**「本机的 CLI 能跑」（它们都跑不了：claude 的 OAuth
 * 过期、codex 的 refresh token 已用、dsh 缺 DEEPSEEK_API_KEY、ollama 服务没起）。
 * 要证明的是这套判断本身成立：
 * - PATH 只决定「列不列出来」，不决定「能不能用」；
 * - 解析顺序是 env → 保存的命令 → 探测，且一条/多条/零条各有各的出口；
 * - `{prompt}` 与 stdin 两种形状都把任务包完整送到了命令手里；
 * - 写文件与打 stdout 两种交法都能变成产物；
 * - 小测跑的是**同一条**命令契约，失败时原文照登。
 */

const NODE = process.execPath;
const STUBS = path.join(REPO_ROOT, 'tests', 'stubs');
const stub = (name: string): string => `"${NODE}" "${path.join(STUBS, name)}"`;

/** 一个包：形状与 `packFor` 的输出一致（含产物路径），不依赖库。 */
const PACK = packFor('evaluate', {
  id: '11111111-1111-4111-8111-111111111111',
  number: 7,
  title: '生成器用例',
  type: 'feature',
  requester: '孙建宏',
  prdUrl: null,
});

const ARTIFACT_URL = '/uemaster/PAN-7/evaluate.html';

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'flowers-gen-test-'));
}

async function status(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/** 把 PATH 换成一个只含指定可执行名的临时目录。 */
async function pathWith(names: string[]): Promise<string> {
  const dir = await tempDir();
  for (const name of names) {
    const file = path.join(dir, name);
    await writeFile(file, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(file, 0o755);
  }
  clearDetectionCache();
  return dir;
}

const REAL_PATH = process.env.PATH;

beforeEach(async () => {
  process.env.PATH = REAL_PATH;
  delete process.env.FLOWERS_GEN_CMD;
  clearDetectionCache();
});

afterAll(async () => {
  process.env.PATH = REAL_PATH;
  delete process.env.FLOWERS_GEN_CMD;
  clearDetectionCache();
  await pool.end();
});

describe('候选表', () => {
  it('五个候选、顺序固定、命令与文档一致', () => {
    expect(CANDIDATES.map((c) => c.id)).toEqual(['claude', 'codex', 'dsh', 'ollama', 'custom']);
    const byId = Object.fromEntries(CANDIDATES.map((c) => [c.id, c]));
    expect(byId.claude!.command).toBe('claude -p --permission-mode acceptEdits');
    expect(byId.codex!.command).toBe('codex exec --sandbox workspace-write --skip-git-repo-check -');
    expect(byId.dsh!.command).toBe('dsh headless {prompt}');
    expect(byId.ollama!.command).toBe('ollama run <模型名>');
    expect(byId.custom!.binary).toBeNull();
    // 每个候选都有一句说明；显示名不能是英文 id 本身。
    for (const candidate of CANDIDATES) {
      expect(candidate.note.length).toBeGreaterThan(0);
      expect(candidate.label).not.toBe(candidate.id);
    }
  });

  it('{prompt} 与 <模型名> 是两种不同的槽位：前者是契约，后者是待填', () => {
    expect(placeholderIn('dsh headless {prompt}')).toBeNull();
    expect(placeholderIn('ollama run <模型名>')).toBe('<模型名>');
    expect(commandReady('ollama run <模型名>')).toBe(false);
    // shell 的重定向有一个空格，不该被当成占位符。
    expect(placeholderIn('codex exec - < task.txt')).toBeNull();
    expect(commandReady('')).toBe(false);
  });
});

describe('探测（只看 PATH）', () => {
  it('PATH 里有谁就返回谁，顺序按候选表', async () => {
    process.env.PATH = await pathWith(['dsh', 'claude', 'codex']);
    const found = await detect();
    expect(found.map((item) => item.candidate.id)).toEqual(['claude', 'codex', 'dsh']);
  });

  it('空 PATH：一个都没有，不抛错', async () => {
    process.env.PATH = await pathWith([]);
    expect(await detect()).toEqual([]);
  });

  it('缓存跟着 PATH 走：换了目录立刻失效', async () => {
    process.env.PATH = await pathWith(['claude']);
    expect((await detect()).length).toBe(1);
    process.env.PATH = await pathWith(['claude', 'dsh', 'ollama']);
    const found = await detect();
    expect(found.map((item) => item.candidate.id)).toEqual(['claude', 'dsh', 'ollama']);
    // ollama 探到了，但命令里还有 <模型名>：它不能被当成「可以直接跑」。
    expect(found.find((item) => item.candidate.id === 'ollama')!.ready).toBe(false);
  });

  it('只探测文件系统，不执行任何东西（因此不会有「状态探针在说谎」这条路）', async () => {
    // 一个 `--version` 会立刻退出的脚本也无所谓：detect 从不执行它。
    // 这里用一个「执行就会留下痕迹」的脚本来证明这一点。
    const dir = await tempDir();
    const marker = path.join(dir, 'executed');
    const fake = path.join(dir, 'claude');
    await writeFile(fake, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`, 'utf8');
    await chmod(fake, 0o755);
    process.env.PATH = dir;
    clearDetectionCache();
    expect((await detect()).length).toBe(1);
    await expect(stat(marker)).rejects.toThrow();
  });
});

describe('解析顺序：env → 保存的命令 → 探测', () => {
  it('FLOWERS_GEN_CMD 最优先', async () => {
    process.env.PATH = await pathWith(['claude']);
    process.env.FLOWERS_GEN_CMD = stub('gen-ok.mjs');
    const resolution = await resolveGenerator('dsh headless {prompt}');
    expect(resolution).toMatchObject({ kind: 'ready', source: 'env', command: stub('gen-ok.mjs') });
  });

  it('其次是保存的命令', async () => {
    process.env.PATH = await pathWith(['claude', 'dsh']);
    const resolution = await resolveGenerator('dsh headless {prompt}');
    expect(resolution).toMatchObject({ kind: 'ready', source: 'settings', command: 'dsh headless {prompt}' });
  });

  it('探测到一条：直接用，但标成 detected（未验证）', async () => {
    process.env.PATH = await pathWith(['dsh']);
    const resolution = await resolveGenerator(null);
    expect(resolution.kind).toBe('ready');
    expect(resolution).toMatchObject({ source: 'detected', command: 'dsh headless {prompt}' });
  });

  it('探测到多条：choose，交给人挑', async () => {
    process.env.PATH = await pathWith(['claude', 'codex', 'dsh', 'ollama']);
    const resolution = await resolveGenerator(null);
    expect(resolution.kind).toBe('choose');
    if (resolution.kind !== 'choose') return;
    expect(resolution.candidates.map((c) => c.id)).toEqual(['claude', 'codex', 'dsh', 'ollama']);
  });

  it('只探到一条「还不能跑」的（ollama 没填模型名）：也是 choose', async () => {
    process.env.PATH = await pathWith(['ollama']);
    expect((await resolveGenerator(null)).kind).toBe('choose');
  });

  it('一条都没有：none', async () => {
    process.env.PATH = await pathWith([]);
    expect(await resolveGenerator(null)).toEqual({ kind: 'none' });
  });
});

describe('两种命令形状', () => {
  it('有 {prompt}：任务包是 argv 的一个元素，不走 stdin', () => {
    const { line, stdin } = commandFor('dsh headless {prompt}', PACK);
    expect(stdin).toBe(false);
    expect(line.startsWith('dsh headless ')).toBe(true);
    expect(line).toContain('PAN-7');
  });

  it('没有 {prompt}：任务包走 stdin，命令行原样', () => {
    const { line, stdin } = commandFor('claude -p --permission-mode acceptEdits', PACK);
    expect(stdin).toBe(true);
    expect(line).toBe('claude -p --permission-mode acceptEdits');
  });

  it('任务包里的引号/换行/反引号不会把命令撕开（shell 引号）', () => {
    const nasty = "他说的 '原样' 与 $(rm -rf /) 与 `id` 与\n第二行";
    const quoted = quoteForShell(nasty);
    expect(quoted.startsWith("'")).toBe(true);
    // 单引号被拼成 '\''：任何位置都不留下一个未闭合的引号。
    expect(quoted).toContain(`'\\''`);
    const { line } = commandFor('cmd {prompt}', nasty);
    expect(line.startsWith('cmd ')).toBe(true);
  });
});

describe('runGenerator：文件模式与 stdout 模式', () => {
  it('文件模式：命令自己写文件（env 指定 stub）', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'data/uemaster/PAN-7/evaluate.html');
    process.env.FLOWERS_GEN_CMD = stub('gen-ok.mjs');

    const result = await runGenerator(PACK, { cwd: dir, timeoutMs: 10000, file, before: null });
    expect(result).toEqual({ ok: true, url: ARTIFACT_URL });
    expect(await readFile(file, 'utf8')).toContain('data-stub="ok"');
    await rm(dir, { recursive: true, force: true });
  });

  it('stdout 模式：命令只打 stdout、不写文件，产物由我们落盘（ollama 那条路）', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'data/uemaster/PAN-7/evaluate.html');
    process.env.FLOWERS_GEN_CMD = stub('gen-stdout.mjs');

    const result = await runGenerator(PACK, { cwd: dir, timeoutMs: 10000, file, before: null });
    expect(result).toEqual({ ok: true, url: ARTIFACT_URL });
    const html = await readFile(file, 'utf8');
    // stdout 前面那两句人话被丢掉，文件从文档开头开始。
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>stub stdout</title>');
    await rm(dir, { recursive: true, force: true });
  });

  it('{prompt} 模式：任务包进 argv，stdin 是空的', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'data/uemaster/PAN-7/evaluate.html');
    process.env.FLOWERS_GEN_CMD = `${stub('gen-prompt.mjs')} {prompt}`;

    const result = await runGenerator(PACK, { cwd: dir, timeoutMs: 10000, file, before: null });
    expect(result).toEqual({ ok: true, url: ARTIFACT_URL });
    expect(await readFile(file, 'utf8')).toContain('data-stdin="0"');
    await rm(dir, { recursive: true, force: true });
  });

  it('退出 0、没文件、stdout 也没有 HTML：失败，说清楚缺的是文件', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'data/uemaster/PAN-7/evaluate.html');
    process.env.FLOWERS_GEN_CMD = stub('gen-silent.mjs');

    const result = await runGenerator(PACK, { cwd: dir, timeoutMs: 10000, file, before: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('产物文件不存在');
    await rm(dir, { recursive: true, force: true });
  });

  it('上一版还在、这一版没重写：不算成功（不把旧材料当新结果）', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'data/uemaster/PAN-7/evaluate.html');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '<!doctype html><title>上一版</title>', 'utf8');
    const before = await status(file);
    process.env.FLOWERS_GEN_CMD = stub('gen-silent.mjs');

    const result = await runGenerator(PACK, { cwd: dir, timeoutMs: 10000, file, before });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('产物文件没有更新');
    await rm(dir, { recursive: true, force: true });
  });

  it('占位符没填的命令在跑之前就被拦下（不会变成 shell 重定向）', async () => {
    const result = await runGenerator(PACK, {
      cwd: REPO_ROOT, timeoutMs: 1000, command: 'ollama run <模型名>',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('<模型名>');
  });

  it('失败时把 stderr 原文交出来，不压成「生成失败」', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'data/uemaster/PAN-7/evaluate.html');
    process.env.FLOWERS_GEN_CMD = stub('gen-fail.mjs');

    const result = await runGenerator(PACK, { cwd: dir, timeoutMs: 10000, file, before: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Failed to authenticate: OAuth session expired');
    await rm(dir, { recursive: true, force: true });
  });

  it('htmlDocumentIn：从第一段文档标记截到结尾，认 doctype 也认裸 <html>', () => {
    expect(htmlDocumentIn('前言\n<!doctype html>\n<p>x</p>\n')).toBe('<!doctype html>\n<p>x</p>');
    expect(htmlDocumentIn('前言 <html lang="zh">x</html>')).toBe('<html lang="zh">x</html>');
    expect(htmlDocumentIn('只有一句话')).toBeNull();
  });
});

describe('testGenerator：设置页那 10 秒小测', () => {
  it('文件模式通过：报出大小与耗时', async () => {
    const result = await testGenerator(stub('gen-test.mjs'), { timeoutMs: 10000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe('file');
    expect(result.size).toBeGreaterThan(0);
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it('stdout 模式通过（ollama 那条路）', async () => {
    const result = await testGenerator(stub('gen-stdout.mjs'), { timeoutMs: 10000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe('stdout');
    expect(result.size).toBeGreaterThan(0);
  });

  it('失败：stderr 原文照登', async () => {
    const result = await testGenerator(stub('gen-fail.mjs'), { timeoutMs: 10000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('OAuth session expired');
  });

  it('超时：短时限也能干净地收口', async () => {
    const result = await testGenerator(stub('gen-hang.mjs'), { timeoutMs: 400 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('超时');
  });

  it('占位符没填：不打 shell，直接说清楚', async () => {
    const result = await testGenerator('ollama run <模型名>');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('<模型名>');
  });
});

describe('设置（app_settings）', () => {
  beforeEach(async () => {
    await resetDb();
    await seedPeople();
  });

  it('保存、读取、清空：空串等于没设', async () => {
    expect(await generatorCommand(db)).toBeNull();
    await saveGeneratorCommand(db, '  dsh headless {prompt}  ');
    expect(await generatorCommand(db)).toBe('dsh headless {prompt}');
    await saveGeneratorCommand(db, '   ');
    expect(await generatorCommand(db)).toBeNull();
  });

  it('不测通的命令也能存，但占位符没填的不行', async () => {
    await saveGeneratorCommand(db, stub('gen-test.mjs'));
    const error = await saveGeneratorCommand(db, 'ollama run <模型名>').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('invalid_command');
    // 失败的那一次没有改写已有的值。
    expect(await generatorCommand(db)).toBe(stub('gen-test.mjs'));
  });

  it('测试结果落库；换命令就作废', async () => {
    await saveGeneratorCommand(db, stub('gen-test.mjs'));
    await writeTest(db, {
      ok: true, command: stub('gen-test.mjs'), at: new Date().toISOString(), size: 74, ms: 120, error: null,
    });
    expect(await readTest(db)).toMatchObject({ ok: true, size: 74 });

    await saveGeneratorCommand(db, 'dsh headless {prompt}');
    expect(await readTest(db)).toBeNull();
  });

  it('generatorView：保存了就是 ready/settings，没保存就按探测给 choose / none', async () => {
    await saveGeneratorCommand(db, 'dsh headless {prompt}');
    process.env.PATH = await pathWith(['claude']);
    const savedView = await generatorView(db);
    expect(savedView).toMatchObject({ state: 'ready', source: 'settings', command: 'dsh headless {prompt}' });
    expect(savedView.candidates.map((c) => c.id)).toEqual(['claude']);
    // 五行完整表一直在：选择器要能给出「自建」。
    expect(savedView.known.map((c) => c.id)).toEqual(['claude', 'codex', 'dsh', 'ollama', 'custom']);

    await saveGeneratorCommand(db, '');
    process.env.PATH = await pathWith(['claude', 'dsh']);
    expect((await generatorView(db)).state).toBe('choose');

    process.env.PATH = await pathWith([]);
    const none = await generatorView(db);
    expect(none.state).toBe('none');
    expect(none.command).toBeNull();
    expect(none.candidates).toEqual([]);
  });
});

describe('整条路：stdout 生成器也走得通（runJob）', () => {
  beforeEach(async () => {
    await resetDb();
    await seedPeople();
    await cleanArtifacts();
  });

  it('不写文件、只打 stdout 的命令：作业 done，产物文件真有内容', async () => {
    process.env.FLOWERS_GEN_CMD = stub('gen-stdout.mjs');
    const r = await createRequirement(db, '吕品', {
      title: 'stdout 生成', type: 'feature', requester: '孙建宏',
    });
    const inserted = await db.execute<{ id: string }>(sql`
      insert into uemaster_jobs (requirement_id, stage, status)
      values (${r.id}, 'evaluate', 'running') returning id`);
    const jobId = inserted.rows[0]!.id;

    await runJob(db, jobId, { actor: '吕品', timeoutMs: 10000 });

    const job = await db.execute<{ status: string; error: string | null }>(sql`
      select status, error from uemaster_jobs where id = ${jobId}`);
    expect(job.rows[0]).toMatchObject({ status: 'done', error: null });

    const url = `/uemaster/PAN-${r.number}/evaluate.html`;
    expect(await artifactExists(url)).toBe(true);
    const body = await readFile(path.join(REPO_ROOT, 'data', url), 'utf8');
    expect(body).toContain('<title>stub stdout</title>');
  });

  it('一条生成器都没有：startGeneration 直接拒绝，作业一行都不落', async () => {
    process.env.PATH = await pathWith([]);
    const r = await createRequirement(db, '吕品', {
      title: '没有生成器', type: 'feature', requester: '孙建宏',
    });
    const error = await startGeneration(db, '吕品', {
      requirementId: r.id, stage: 'evaluate',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('generator_unavailable');
    expect((error as AppError).message).toContain('未检测到生成器');

    const rows = await db.execute<{ n: number }>(sql`select count(*)::int as n from uemaster_jobs`);
    expect(Number(rows.rows[0]!.n)).toBe(0);
  });

  it('探测到多条而没选：startGeneration 拒绝并指路设置页', async () => {
    process.env.PATH = await pathWith(['claude', 'dsh']);
    const r = await createRequirement(db, '吕品', {
      title: '没选生成器', type: 'feature', requester: '孙建宏',
    });
    const error = await startGeneration(db, '吕品', {
      requirementId: r.id, stage: 'evaluate',
    }).catch((e: unknown) => e);

    expect((error as AppError).code).toBe('generator_unconfigured');
    expect((error as AppError).message).toContain('设置');
  });
});
