import { readdir } from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { attachFromForm } from '../app/attach-form.js';
import { GET } from '../app/uemaster/[...path]/route.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { ARTIFACT_ROOT, MAX_UPLOAD_BYTES } from '../src/core/uemaster/store.js';
import { AppError } from '../src/core/errors.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { cleanArtifacts, writeArtifact } from './helpers/files.js';

/**
 * 抽屉「交回材料」那张表单的两条路：**贴链接**与**传文件**。
 *
 * 为什么测 `attachFromForm` 而不是 `attachAction`：后者最后一步是 `revalidatePath`，
 * 那一步只在请求上下文里有意义（用例里调它抛的是 Next 的内部 invariant）。把表单那
 * 一段翻译拆出去之后，这里能用**真的 FormData + 真的 File** 把 multipart 那条路走完
 * ——那正是浏览器之外最难验、也最容易悄悄坏的一截（扩展名白名单、5 MB、写到哪里、
 * 交回来的路径能不能被路由服务）。
 *
 * 浏览器里那一半（真的点按钮、真的选文件）记在
 * `docs/superpowers/plans/p2-5-close-gaps.md`：本会话的浏览器没有配置上传目录，
 * 所以「选文件」那一下没有在真浏览器里按过，其余每一层都在这里有断言。
 */

const HTML = '<!doctype html><meta charset="utf-8"><title>上传</title>';

function form(fields: Record<string, string>, file?: File): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  if (file !== undefined) fd.set('file', file);
  return fd;
}

function html(name = 'walk.html'): File {
  return new File([HTML], name, { type: 'text/html' });
}

beforeEach(async () => {
  await resetDb();
  await seedPeople();
  await cleanArtifacts();
});

afterAll(async () => {
  await cleanArtifacts();
  await pool.end();
});

async function newRequirement(): Promise<{ id: string; number: number }> {
  const r = await createRequirement(db, '吕品', {
    title: 'S3 协议支持', type: 'feature', requester: '孙建宏',
  });
  return { id: r.id, number: r.number };
}

async function urls(): Promise<string[]> {
  const res = await db.execute<{ url: string }>(sql`select url from uemaster_artifacts order by id`);
  return res.rows.map((row) => row.url);
}

/**
 * `data/uemaster/` 下现在有哪些文件（相对路径，排过序）。
 *
 * 用来问「失败的提交在磁盘上留下了什么」：只查库不够，孤儿文件恰恰是库里查不到的那半。
 * 目录整个不存在时返回空数组——那正是「一次都没写成功」的形状。
 */
async function artifactTree(): Promise<string[]> {
  try {
    const entries = await readdir(ARTIFACT_ROOT, { recursive: true, withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => `${pathRelative(e.parentPath, e.name)}`)
      .sort();
  } catch {
    return [];
  }
}

function pathRelative(dir: string, name: string): string {
  return `${dir.slice(ARTIFACT_ROOT.length + 1)}/${name}`.replace(/^\//, '');
}

async function caught(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('expected AppError, nothing thrown');
}

describe('传文件', () => {
  it('写到 data/uemaster/PAN-<n>/<stage>-<ts>.html，落一行，并且路由能带着 CSP 服务它', async () => {
    const { id, number } = await newRequirement();
    const got = await attachFromForm(db, '吕品', form({
      id, stage: 'inspect', number: String(number),
    }, html()));

    // 名字只由 stage + 毫秒时间戳拼：原文件名不进路径（它是调用方给的）。
    expect(got.url).toMatch(new RegExp(`^/uemaster/PAN-${number}/inspect-\\d{13}\\.html$`));
    expect(await urls()).toEqual([got.url]);

    const segments = got.url.replace(/^\/uemaster\//, '').split('/');
    const res = await GET(new Request('http://localhost/x'), {
      params: Promise.resolve({ path: segments }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(await res.text()).toBe(HTML);

    // 事件也写了：时间轴要能说出「这份材料是谁交的」。
    const events = await db.execute<{ type: string; actor: string }>(
      sql`select type, actor from events where type = 'uemaster.attached'`);
    expect(events.rows).toEqual([{ type: 'uemaster.attached', actor: '吕品' }]);
  });

  it('原文件名不进路径：../../ 之类的名字只能决定扩展名', async () => {
    const { id, number } = await newRequirement();
    const got = await attachFromForm(db, '吕品', form({
      id, stage: 'review', number: String(number),
    }, html('../../evil.html')));
    expect(got.url).toMatch(new RegExp(`^/uemaster/PAN-${number}/review-\\d{13}\\.html$`));
    expect(got.url).not.toContain('..');
  });

  it('只收 .html：别的扩展名一句中文，且一行都不落', async () => {
    const { id, number } = await newRequirement();
    const e = await caught(attachFromForm(db, '吕品', form({
      id, stage: 'review', number: String(number),
    }, html('material.zip'))));
    expect(e).toMatchObject({ code: 'invalid_upload', message: '只收 .html 文件' });
    expect(await urls()).toEqual([]);
  });

  it('超过 5 MB 一句中文，且一行都不落', async () => {
    const { id, number } = await newRequirement();
    const big = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'big.html');
    const e = await caught(attachFromForm(db, '吕品', form({
      id, stage: 'review', number: String(number),
    }, big)));
    expect(e).toMatchObject({ code: 'invalid_upload', message: '文件不能超过 5 MB' });
    expect(await urls()).toEqual([]);
    expect(await artifactTree()).toEqual([]);
  });

  it('attach 说不的时候，刚写的文件被收回去：磁盘上不留孤儿', async () => {
    // 一个不存在的需求编号：文件已经写下了，attach 才说「需求不存在」——
    // 这正是 R-P2-9 之前会留一份永远没人指向的 HTML 的那条路。
    const ghost = '00000000-0000-4000-8000-000000000000';
    expect(await artifactTree()).toEqual([]);

    const e = await caught(attachFromForm(db, '吕品', form({
      id: ghost, stage: 'evaluate', number: '7',
    }, html())));

    expect(e).toMatchObject({ code: 'not_found', message: '需求不存在' });
    expect(await urls()).toEqual([]);
    // 目录回到提交之前的样子：连空目录都不留（失败不该改磁盘）。
    expect(await artifactTree()).toEqual([]);
  });

  it('回收只碰这一次写的文件：同一目录里已有的产物还在', async () => {
    const { id, number } = await newRequirement();
    const good = await attachFromForm(db, '吕品', form({
      id, stage: 'inspect', number: String(number),
    }, html()));
    const before = await artifactTree();
    expect(before).toHaveLength(1);

    // 同一个 PAN 目录、换个 stage，attach 失败（需求编号现在改成不存在的那个）。
    const ghost = '00000000-0000-4000-8000-000000000000';
    await caught(attachFromForm(db, '吕品', form({
      id: ghost, stage: 'evaluate', number: String(number),
    }, html())));

    // 目录内容一字不差：失败那次写的文件没了，成功那次写的文件还在。
    expect(await artifactTree()).toEqual(before);
    expect(await urls()).toEqual([good.url]);
  });
});

describe('粘贴链接', () => {
  it('站内路径：文件先在，attach 就收', async () => {
    const { id } = await newRequirement();
    await writeArtifact('/uemaster/PAN-1/evaluate.html', HTML);
    const got = await attachFromForm(db, '吕品', form({
      id, stage: 'evaluate', number: '1', url: '/uemaster/PAN-1/evaluate.html',
    }));
    expect(got.url).toBe('/uemaster/PAN-1/evaluate.html');
    expect(await urls()).toEqual(['/uemaster/PAN-1/evaluate.html']);
  });

  it('文件优先：两条都填时交回的是文件那一份', async () => {
    const { id, number } = await newRequirement();
    await writeArtifact('/uemaster/PAN-1/evaluate.html', HTML);
    const got = await attachFromForm(db, '吕品', form({
      id, stage: 'evaluate', number: String(number), url: '/uemaster/PAN-1/evaluate.html',
    }, html()));
    expect(got.url).toMatch(/evaluate-\d{13}\.html$/);
  });

  it('两条都空：一句自己的话，不是 invalid_url', async () => {
    const { id, number } = await newRequirement();
    const e = await caught(attachFromForm(db, '吕品', form({
      id, stage: 'evaluate', number: String(number), url: '   ',
    })));
    expect(e).toMatchObject({ code: 'invalid', message: '请粘贴链接或选择文件' });
    expect(await urls()).toEqual([]);
  });

  it('领域错误原样上来：需求不存在、链接非法、文件缺失各是它自己那句', async () => {
    const { id, number } = await newRequirement();
    const ghost = '00000000-0000-4000-8000-000000000000';

    expect(await caught(attachFromForm(db, '吕品', form({
      id: ghost, stage: 'evaluate', number: '1', url: 'https://x/y.html',
    })))).toMatchObject({ code: 'not_found', message: '需求不存在' });

    expect(await caught(attachFromForm(db, '吕品', form({
      id, stage: 'evaluate', number: String(number), url: 'javascript:alert(1)',
    })))).toMatchObject({ code: 'invalid_url' });

    const missing = await caught(attachFromForm(db, '吕品', form({
      id, stage: 'evaluate', number: String(number), url: '/uemaster/PAN-1/evaluate.html',
    })));
    expect(missing.code).toBe('artifact_missing');
    expect(missing.message).toContain('data/uemaster/PAN-1/evaluate.html');
  });
});
