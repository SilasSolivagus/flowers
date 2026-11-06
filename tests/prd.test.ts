import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { resetDb } from './helpers/db.js';
import {
  DEFAULT_BIN, argvOf, classifyUrl, firstHeading, parseResponse, readDoc, redact,
  resolveCli, stripWrappers,
} from '../src/core/prd/wecom.js';
import {
  hashMarkdown, latestSnapshot, saveSnapshot, snapshotById, snapshotCount,
} from '../src/core/prd/snapshots.js';
import { readPrd } from '../src/core/prd/read.js';

/**
 * P3.2：PRD 快照层。**对着 v1.3.4 的真实读口写**（`doc contents get --docid`，
 * 同步、一个 JSON、`errcode` 是成功信号；没有 task_id，没有轮询）。
 *
 * **一条真请求都不发、一个真 CLI 都不调。** 夹具是一个当场写出来的可执行脚本
 * （`fake-wecom-cli.cjs`，`chmod 755`，`FLOWERS_WECOM_CLI` 指向它）——它按 URL 里
 * 的标记词决定回什么：包装字段、未授权、errcode、空正文、永远不回、非 JSON。
 * 测的是真实的 `execFile`、真实的 argv、真实的退出码、真实的 kill。
 *
 * 要钉住的七件事：
 * 1. argv 就是 `doc contents get --docid <url> --content-type markdown`（一条命令，
 *    一次调用——**没有轮询**）；
 * 2. 品类路由先说：`/smartsheet/` 与 `/smartpage/` 在拼 argv 之前就各自说明；
 * 3. 包装字段（`security_notice` / `extra_identity_context`）永远不进正文；
 * 4. 三种失败各有各的话：没装、没授权（`Status: unauthorized`）、errcode（errmsg 原样）；
 * 5. 永远不回的那条链接在 `timeoutMs` 之后**准时**返回，不挂住用例；
 * 6. 同一个正文连着存两次只有一行；`latestSnapshot` 按 `fetched_at` 取最新；
 * 7. `readPrd` 在 `prd_url` 为空时给一句点明缺什么的中文，不抛。
 */

// ─── 假 CLI（说的是 v1.3.4 那套接口） ────────────────────────────────────────

/**
 * 假 CLI 的源码。刻意写成 CommonJS + 只用单引号：它是一段**被测的真实脚本**，
 * 不是模板字符串里的花活。
 *
 * 每次调用先往 `calls.log` 追加一行 argv——「跑了几次、参数长什么样」由此判定。
 */
const FAKE_SOURCE = [
  '#!/usr/bin/env node',
  "'use strict';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const dir = __dirname;',
  'const argv = process.argv.slice(2);',
  "fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(argv) + '\\n');",
  'let url = "";',
  'let body = {};',
  'for (let i = 0; i < argv.length; i += 1) {',
  '  const a = argv[i];',
  '  if (a === "--docid") url = String(argv[i + 1] || "");',
  '  if (a === "--json") { try { body = JSON.parse(argv[i + 1]); } catch (e) { body = {}; } }',
  '}',
  'if (!url) url = String(body.docid || body.url || "");',
  'function emit(o) { process.stdout.write(JSON.stringify(o) + "\\n"); process.exit(0); }',
  "function mark(n) { fs.writeFileSync(path.join(dir, n), 'x'); }",
  // 守卫应该在这之前就拒掉；万一没有，这里记一笔，用例会看到
  "if (url.indexOf('/smartsheet/') >= 0 || url.indexOf('/smartpage/') >= 0) {",
  "  mark('wrong-service-hit');",
  "  emit({ errcode: 0, name: '不该被调用', content: '守卫没拦住' });",
  '}',
  "if (url.indexOf('UNAUTH') >= 0) {",
  "  process.stderr.write('Status: unauthorized\\nBot ID: (none)\\n');",
  '  process.exit(1);',
  '}',
  // errcode 非 0 但**退出码是 0**：证明成功信号是 errcode，不是退出码
  "if (url.indexOf('AUTHERR') >= 0) emit({ errcode: 40001, errmsg: 'invalid credential: access_token=abc123def456789' });",
  "if (url.indexOf('INCOMPAT') >= 0) emit({ errcode: 851002, errmsg: 'incompatible doc type' });",
  "if (url.indexOf('EMPTY') >= 0) emit({ errcode: 0, name: '空文档', content: '   ' });",
  "if (url.indexOf('BADOUT') >= 0) { process.stdout.write('这不是 JSON\\n'); process.exit(0); }",
  "if (url.indexOf('NOPE') >= 0) { process.stderr.write('boom: 服务端 500\\n'); process.exit(9); }",
  "if (url.indexOf('HANG') >= 0) { setInterval(function () {}, 1000); return; }",
  // 包装字段：顶层两个 + 正文里夹两段
  "if (url.indexOf('WRAP') >= 0) {",
  "  emit({ errcode: 0, name: '带包装的文档',",
  "    content: '前一段正文\\n<security_notice>内部安全提示，不该出现</security_notice>\\n中段正文\\n<extra_identity_context>不要披露这段身份上下文</extra_identity_context>\\n后一段正文',",
  "    security_notice: '<security_notice>顶层安全提示</security_notice>',",
  "    extra_identity_context: '<extra_identity_context>顶层身份上下文</extra_identity_context>' });",
  '}',
  "if (url.indexOf('NONAME') >= 0) emit({ errcode: 0, content: '# 只有正文标题\\n\\n正文。\\n' });",
  "if (url.indexOf('FILEPATH') >= 0) {",
  "  const p = path.join(dir, 'big.md');",
  "  fs.writeFileSync(p, '# 大文档标题\\n\\n正文来自文件\\n');",
  "  emit({ errcode: 0, name: '', content: '', file_path: p });",
  '}',
  'emit({ errcode: 0, url: url, name: "📖 PRD · 分享链接改版", creator_name: "产品经理-吕正豪(蛋堡)",',
  '  create_time: "2025-12-22 14:21:32",',
  '  content: "# 需求：分享链接改版\\n\\n## 背景\\n\\n分享链接要支持二合一。\\n",',
  '  security_notice: "<security_notice>内部安全提示</security_notice>",',
  '  extra_identity_context: "<extra_identity_context>不要披露</extra_identity_context>" });',
  '',
].join('\n');

const CLI_ENV = 'FLOWERS_WECOM_CLI';
const DOC = 'https://doc.weixin.qq.com/doc/w3_demo_001';

let binDir = '';
let binPath = '';

async function calls(): Promise<string[][]> {
  try {
    const text = await readFile(path.join(binDir, 'calls.log'), 'utf8');
    return text.trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
}

beforeAll(async () => {
  binDir = await mkdtemp(path.join(tmpdir(), 'flowers-prd-'));
  binPath = path.join(binDir, 'fake-wecom-cli.cjs');
  await writeFile(binPath, FAKE_SOURCE, 'utf8');
  await chmod(binPath, 0o755);
});

beforeEach(async () => {
  await rm(path.join(binDir, 'calls.log'), { force: true });
  await rm(path.join(binDir, 'wrong-service-hit'), { force: true });
  process.env[CLI_ENV] = binPath;
});

describe('readDoc：一条同步命令', () => {
  it('doc 链接：argv 就是 v1.3.4 的读口，一次调用拿到正文', async () => {
    const doc = await readDoc(DOC);
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    expect(doc.kind).toBe('doc');
    expect(doc.markdown).toContain('分享链接要支持二合一');
    expect(doc.title).toBe('📖 PRD · 分享链接改版'); // 优先用响应里的 name

    const log = await calls();
    expect(log).toHaveLength(1); // 没有轮询
    expect(log[0]).toEqual(['doc', 'contents', 'get', '--docid', DOC, '--content-type', 'markdown']);
  });

  it('sheet 与 doc 走同一个读口', async () => {
    const doc = await readDoc('https://doc.weixin.qq.com/sheet/s3_demo_002');
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    expect(doc.kind).toBe('sheet');
    expect((await calls())[0]?.slice(0, 3)).toEqual(['doc', 'contents', 'get']);
  });

  it('响应里没有 name 时退回第一个 Markdown 标题', async () => {
    const doc = await readDoc('https://doc.weixin.qq.com/doc/NONAME_1');
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    expect(doc.title).toBe('只有正文标题');
  });

  it('包装字段永远不进正文（顶层与夹带两种）', async () => {
    const plain = await readDoc(DOC);
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.markdown).not.toContain('security_notice');
    expect(plain.markdown).not.toContain('不要披露');

    const wrapped = await readDoc('https://doc.weixin.qq.com/doc/WRAP_1');
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    expect(wrapped.markdown).not.toContain('security_notice');
    expect(wrapped.markdown).not.toContain('extra_identity_context');
    expect(wrapped.markdown).not.toContain('内部安全提示');
    expect(wrapped.markdown).not.toContain('不要披露');
    // 真正的正文一段不少
    expect(wrapped.markdown).toContain('前一段正文');
    expect(wrapped.markdown).toContain('中段正文');
    expect(wrapped.markdown).toContain('后一段正文');
  });

  it('stripWrappers 是纯函数，可以单独钉', () => {
    expect(stripWrappers('A<security_notice>x</security_notice>B')).toBe('AB');
    expect(stripWrappers('<extra_identity_context>y</extra_identity_context>\n\n正文')).toBe('正文');
    expect(stripWrappers('没有包装')).toBe('没有包装');
  });

  it('/smartsheet/ 与 /smartpage/ 在拼 argv 之前各自说明，假 CLI 一次都没跑', async () => {
    await expect(readDoc('https://doc.weixin.qq.com/smartsheet/s3_abc123')).resolves.toEqual({
      ok: false, code: 'unsupported_kind', message: '智能表格（smartsheet）暂不支持读取',
    });
    await expect(readDoc('https://doc.weixin.qq.com/smartpage/p_abc123')).resolves.toEqual({
      ok: false, code: 'unsupported_kind', message: '智能文档（smartpage）暂不支持读取',
    });
    expect(await calls()).toHaveLength(0);
    await expect(stat(path.join(binDir, 'wrong-service-hit'))).rejects.toThrow();
  });

  it('不确定的链接给一句点名形状的中文', async () => {
    const doc = await readDoc('https://example.com/files/42');
    expect(doc.ok).toBe(false);
    if (doc.ok) return;
    expect(doc.code).toBe('unknown_kind');
    expect(doc.message).toContain('/sheet/');
    expect(doc.message).toContain('https://doc.weixin.qq.com/doc/');
    expect(await calls()).toHaveLength(0);
  });

  it('分类器认得四类路径（含老写法 smartmatrix）', () => {
    expect(classifyUrl('https://doc.weixin.qq.com/doc/a')).toBe('doc');
    expect(classifyUrl('https://doc.weixin.qq.com/sheet/a?scode=x')).toBe('sheet');
    expect(classifyUrl('https://doc.weixin.qq.com/smartsheet/a')).toBe('smartsheet');
    expect(classifyUrl('https://doc.weixin.qq.com/smartmatrix/a')).toBe('smartsheet');
    expect(classifyUrl('https://doc.weixin.qq.com/smartpage/a')).toBe('smartpage');
    expect(classifyUrl('not a url')).toBe('unknown');
    expect(classifyUrl('')).toBe('unknown');
  });

  it('argvOf 里 url 只是一个参数值', () => {
    expect(argvOf('doc', 'https://doc.weixin.qq.com/doc/a?scode=1&b=2')).toEqual([
      'doc', 'contents', 'get', '--docid', 'https://doc.weixin.qq.com/doc/a?scode=1&b=2', '--content-type', 'markdown',
    ]);
  });
});

describe('readDoc：错误分类', () => {
  it('未授权（Status: unauthorized）→ 扫码那句话', async () => {
    const doc = await readDoc('https://doc.weixin.qq.com/doc/UNAUTH_1');
    expect(doc.ok).toBe(false);
    if (doc.ok) return;
    expect(doc.code).toBe('unauthorized');
    expect(doc.message).toContain('wecom-cli auth init');
    expect(doc.message).toContain('扫码');
  });

  it('errcode 40001（退出码 0）也归到未授权，且回显的 token 被打码', async () => {
    const doc = await readDoc('https://doc.weixin.qq.com/doc/AUTHERR_1');
    expect(doc.ok).toBe(false);
    if (doc.ok) return;
    expect(doc.code).toBe('unauthorized');
    expect(doc.message).toBe('wecom-cli 未授权，先在企业微信里扫码（wecom-cli auth init）');
  });

  it('别的 errcode → errmsg 原样 + errcode（证明成功信号是 errcode，不是退出码）', async () => {
    const doc = await readDoc('https://doc.weixin.qq.com/doc/INCOMPAT_1');
    expect(doc.ok).toBe(false);
    if (doc.ok) return;
    expect(doc.code).toBe('errcode');
    expect(doc.message).toContain('851002');
    expect(doc.message).toContain('incompatible doc type');
    expect((await calls()).length).toBe(1); // 退出码 0，一次就结束
  });

  it('redact 把凭证形状打码', () => {
    expect(redact('access_token=abc123def456789&x=1')).toBe('access_token=***&x=1');
    expect(redact('Authorization: Bearer sk-abcdef123456')).toBe('Authorization: ***');
    expect(redact('普通的一句话')).toBe('普通的一句话');
  });

  it('没装 CLI → 装什么写清楚', async () => {
    process.env[CLI_ENV] = path.join(binDir, 'definitely-not-here');
    const doc = await readDoc(DOC);
    expect(doc).toEqual({ ok: false, code: 'missing_binary', message: '没装 wecom-cli，先 npm i -g @wecom/cli' });
  });

  it('永远不回 → 计时结束后准时给超时（不挂住用例）', async () => {
    const started = Date.now();
    const doc = await readDoc('https://doc.weixin.qq.com/doc/HANG_1', { timeoutMs: 400 });
    const elapsed = Date.now() - started;
    expect(doc.ok).toBe(false);
    if (doc.ok) return;
    expect(doc.code).toBe('timeout');
    expect(doc.message).toContain('400 毫秒');
    expect(elapsed).toBeLessThan(3_000);
  });

  it('退出码非 0 → 把 stderr 尾巴带上', async () => {
    const doc = await readDoc('https://doc.weixin.qq.com/doc/NOPE_1');
    expect(doc.ok).toBe(false);
    if (doc.ok) return;
    expect(doc.code).toBe('cli_failed');
    expect(doc.message).toContain('退出码 9');
    expect(doc.message).toContain('boom');
  });

  it('stdout 不是 JSON → bad_output', async () => {
    const doc = await readDoc('https://doc.weixin.qq.com/doc/BADOUT_1');
    expect(doc.ok).toBe(false);
    if (doc.ok) return;
    expect(doc.code).toBe('bad_output');
    expect(doc.message).toContain('不是 JSON');
  });

  it('空正文是失败，不是空字符串的成功', async () => {
    const doc = await readDoc('https://doc.weixin.qq.com/doc/EMPTY_1');
    expect(doc.ok).toBe(false);
    if (doc.ok) return;
    expect(doc.code).toBe('empty_content');
    expect(doc.message).toContain('空正文');
  });

  it('正文只在 file_path 里（大文档）也读得到', async () => {
    const doc = await readDoc('https://doc.weixin.qq.com/doc/FILEPATH_1');
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    expect(doc.markdown).toContain('正文来自文件');
    expect(doc.title).toBe('大文档标题');
  });

  it('链接里带 shell 语法也只是字面量（argv，没有 shell）', async () => {
    const url = 'https://doc.weixin.qq.com/doc/$(touch${IFS}pwned)_OK';
    const doc = await readDoc(url);
    expect(doc.ok).toBe(true);
    const log = await calls();
    expect(log[0]?.[4]).toBe(url);
    // 走 shell 的话 `$(touch pwned)` 会在 cwd 里留一个文件
    await expect(stat(path.join(process.cwd(), 'pwned'))).rejects.toThrow();
  });

  it('firstHeading 跳过代码块里的井号', () => {
    expect(firstHeading('## 二级\n\n正文')).toBe('二级');
    expect(firstHeading('```\n# 代码里的井号\n```\n\n# 真的标题\n')).toBe('真的标题');
    expect(firstHeading('正文没有标题')).toBeNull();
  });

  it('parseResponse 容忍前后有噪音行', () => {
    expect(parseResponse('warning: x\n{"errcode":0}')).toEqual({ errcode: 0 });
    expect(parseResponse('不是 JSON')).toBeNull();
  });

  it('设置里那一格只在没有环境变量时才读（env 优先，不碰库）', async () => {
    const env = process.env[CLI_ENV];
    delete process.env[CLI_ENV];
    await expect(resolveCli()).resolves.toEqual({ ok: true, bin: DEFAULT_BIN });
    process.env[CLI_ENV] = env;
    await expect(resolveCli()).resolves.toEqual({ ok: true, bin: binPath });
  });
});

// ─── 快照与 readPrd（这几条要库） ─────────────────────────────────────────────

async function makeRequirement(prdUrl: string | null): Promise<string> {
  const res = await db.execute<{ id: string }>(sql`
    insert into requirements (title, type, state, requester, prd_url)
    values ('分享链接改版', 'feature', 'review', '吕品', ${prdUrl})
    returning id`);
  return res.rows[0]!.id;
}

describe('快照', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('同一份正文连着存两次：第二次是空操作，只有一行', async () => {
    const id = await makeRequirement('https://doc.weixin.qq.com/doc/x');
    const first = await saveSnapshot(db, '吕品', { requirementId: id, url: 'u', markdown: '# A\n' });
    const second = await saveSnapshot(db, '吕品', { requirementId: id, url: 'u', markdown: '# A\n' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.snapshot.id).toBe(first.snapshot.id);
    expect(second.snapshot.hash).toBe(hashMarkdown('# A\n'));
    expect(await snapshotCount(db, id)).toBe(1);
  });

  it('正文变了就多一行，latestSnapshot 取最新；A→B→A 留三行', async () => {
    const id = await makeRequirement('https://doc.weixin.qq.com/doc/x');
    await saveSnapshot(db, '吕品', { requirementId: id, url: 'u', markdown: '# A\n' });
    await saveSnapshot(db, '吕品', { requirementId: id, url: 'u', markdown: '# B\n' });
    expect((await latestSnapshot(db, id))?.markdown).toBe('# B\n');

    await saveSnapshot(db, '吕品', { requirementId: id, url: 'u', markdown: '# A\n' });
    expect(await snapshotCount(db, id)).toBe(3);
    expect((await latestSnapshot(db, id))?.markdown).toBe('# A\n');
  });

  it('latestSnapshot 按 fetched_at 取，不按插入顺序；没读过是 null', async () => {
    const id = await makeRequirement('https://doc.weixin.qq.com/doc/x');
    expect(await latestSnapshot(db, id)).toBeNull();

    await db.execute(sql`
      insert into prd_snapshots (requirement_id, url, markdown, hash, fetched_at)
      values (${id}, 'u', '# 旧版\n', ${hashMarkdown('# 旧版\n')}, now() - interval '1 day')`);
    const newer = await saveSnapshot(db, '吕品', { requirementId: id, url: 'u', markdown: '# 新版\n' });
    expect((await latestSnapshot(db, id))?.id).toBe(newer.snapshot.id);
  });

  it('snapshotById 复现任意一版', async () => {
    const id = await makeRequirement('https://doc.weixin.qq.com/doc/x');
    const first = await saveSnapshot(db, '吕品', { requirementId: id, url: 'u', markdown: '# 第一版\n' });
    await saveSnapshot(db, '吕品', { requirementId: id, url: 'u', markdown: '# 第二版\n' });

    expect((await snapshotById(db, first.snapshot.id))?.markdown).toBe('# 第一版\n');
    await expect(snapshotById(db, '00000000-0000-4000-8000-000000000000')).resolves.toBeNull();
  });
});

describe('readPrd', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('prd_url 为空：一句点明缺什么的中文，不抛', async () => {
    const id = await makeRequirement(null);
    const result = await readPrd(db, '吕品', { requirementId: id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('missing_prd_url');
    expect(result.message).toContain('PRD 链接');
    expect(await snapshotCount(db, id)).toBe(0);
    expect(await calls()).toHaveLength(0); // 空链接不该把 CLI 拉起来
  });

  it('找不到需求 / 坏 id 都是失败而不是异常', async () => {
    await expect(readPrd(db, '吕品', { requirementId: '00000000-0000-4000-8000-000000000000' }))
      .resolves.toMatchObject({ ok: false, code: 'not_found' });
    await expect(readPrd(db, '吕品', { requirementId: 'not-a-uuid' }))
      .resolves.toMatchObject({ ok: false, code: 'bad_id' });
  });

  it('读到了：快照（包装字段已剥掉）+ 一条 prd.fetched 事件', async () => {
    const id = await makeRequirement(DOC);
    const first = await readPrd(db, '吕品', { requirementId: id });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.created).toBe(true);
    expect(first.data.title).toBe('📖 PRD · 分享链接改版');
    expect(first.data.kind).toBe('doc');
    expect(first.data.snapshot.requirementId).toBe(id);
    expect(first.data.snapshot.markdown).not.toContain('security_notice');

    const events = await db.execute<{ type: string; payload: string; actor: string }>(sql`
      select type, payload, actor from events where type = 'prd.fetched' order by seq`);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.actor).toBe('吕品');
    const payload = JSON.parse(events.rows[0]!.payload) as { url: string; hash: string; chars: number };
    expect(payload.url).toBe(DOC);
    expect(payload.hash).toBe(first.data.snapshot.hash);
    expect(payload.chars).toBe(first.data.snapshot.markdown.length);

    const second = await readPrd(db, '吕品', { requirementId: id });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.created).toBe(false);
    expect(second.data.snapshot.id).toBe(first.data.snapshot.id);
    expect(await snapshotCount(db, id)).toBe(1);
    // 事件记的是「读」，所以两次 fetch 就是两条
    const again = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from events where type = 'prd.fetched'`);
    expect(again.rows[0]?.n).toBe('2');
  });

  it('读失败（没授权）不落快照也不落事件', async () => {
    const id = await makeRequirement('https://doc.weixin.qq.com/doc/UNAUTH_2');
    await expect(readPrd(db, '吕品', { requirementId: id }))
      .resolves.toMatchObject({ ok: false, code: 'unauthorized' });
    expect(await snapshotCount(db, id)).toBe(0);
    const events = await db.execute<{ n: string }>(sql`select count(*)::text as n from events`);
    expect(events.rows[0]?.n).toBe('0');
  });
});

afterAll(async () => {
  delete process.env[CLI_ENV];
  await rm(binDir, { recursive: true, force: true });
  await pool.end();
});
