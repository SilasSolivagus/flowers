import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GET } from '../app/uemaster/[...path]/route.js';
import { MAX_UPLOAD_BYTES, saveUploaded } from '../src/core/uemaster/store.js';
import { AppError } from '../src/core/errors.js';
import { cleanArtifacts, writeArtifact } from './helpers/files.js';

/**
 * `/uemaster/[...path]` 这一层：产物出去时**带着什么头**、什么名字会被拒。
 *
 * 为什么把路由的 GET 当普通函数调、而不是起一个服务器：这条路由的全部职责是
 * 「一段路径 → 一份文件 + 一组固定的头」，请求上下文只有 `params`。起 Next 只为
 * 了断言四个头，测到的是 Next 自己；直接调它，测到的是我们写的那几十行。
 * 真正只有浏览器能回答的那半（`sandbox` 生效之后 `document.cookie` 到底还不还读得到）
 * 记在 `docs/superpowers/plans/p2-5-close-gaps.md` 里，与这一条分开说。
 */

const CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:";

/** 一份「会偷 cookie」的产物：这就是从 public/ 直接服务时的那条储存型 XSS。 */
const XSS = '<!doctype html><meta charset="utf-8"><title>偷 cookie</title>'
  + '<script>document.title=document.cookie</script>';

async function get(segments: string[]): Promise<Response> {
  return GET(new Request('http://localhost/uemaster/x'), {
    params: Promise.resolve({ path: segments }),
  });
}

beforeEach(async () => {
  await cleanArtifacts();
});

afterAll(async () => {
  await cleanArtifacts();
});

describe('GET /uemaster/[...path]', () => {
  it('产物带着 sandbox CSP、固定 HTML 类型、nosniff 出去——脚本本身还在文档里', async () => {
    await writeArtifact('/uemaster/PAN-7/xss.html', XSS);
    const res = await get(['PAN-7', 'xss.html']);

    expect(res.status).toBe(200);
    // 三条头逐字钉住：少一条 `sandbox`，这份文件就又是一个同源脚本执行点。
    expect(res.headers.get('content-security-policy')).toBe(CSP);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    // 文件内容原样出去（服务端不做净化）：安全靠的是文档外面的那份 CSP，不是删脚本。
    expect(await res.text()).toContain('<script>document.title=document.cookie</script>');
  });

  it('名字带 ..、编码过的 ..、绝对路径、反斜杠一律 404，读不到仓库里的东西', async () => {
    await writeArtifact('/uemaster/PAN-7/xss.html', XSS);
    const cases: string[][] = [
      ['..', 'package.json'],
      ['PAN-7', '..', '..', 'package.json'],
      ['..%2F..%2Fpackage.json'],
      ['%2e%2e', '%2e%2e', 'package.json'],
      ['%252e%252e%252fpackage.json'],
      ['/etc/passwd'],
      ['PAN-7', ''],
      ['PAN-7', 'x.html\\..\\..\\package.json'],
    ];
    for (const segments of cases) {
      const res = await get(segments);
      expect(res.status, JSON.stringify(segments)).toBe(404);
      expect(await res.text()).toBe('产物不存在');
    }
  });

  it('没有这份文件就是 404，不是 500', async () => {
    const res = await get(['PAN-7', 'nope.html']);
    expect(res.status).toBe(404);
  });

  it('目录不是文件也是 404（不把目录当成可读的东西）', async () => {
    await writeArtifact('/uemaster/PAN-7/xss.html', XSS);
    expect((await get(['PAN-7'])).status).toBe(404);
  });

  it('文件只从 data/uemaster 里读：public/ 下的同名文件不会被服务', async () => {
    await writeArtifact('/uemaster/PAN-7/only-data.html', XSS);
    // 同一路径在 public/ 下再放一份，改掉内容：能读到它，就说明根还在静态树里。
    const { writeFile, mkdir } = await import('node:fs/promises');
    const path = await import('node:path');
    const { REPO_ROOT } = await import('./helpers/files.js');
    const decoy = path.join(REPO_ROOT, 'public', 'uemaster', 'PAN-7', 'only-data.html');
    await mkdir(path.dirname(decoy), { recursive: true });
    await writeFile(decoy, '<!doctype html><title>decoy</title>', 'utf8');
    try {
      const body = await (await get(['PAN-7', 'only-data.html'])).text();
      expect(body).toContain('偷 cookie');
      expect(body).not.toContain('decoy');
    } finally {
      const { rm } = await import('node:fs/promises');
      await rm(path.join(REPO_ROOT, 'public', 'uemaster'), { recursive: true, force: true });
    }
  });
});

/**
 * 抽屉「传文件」那条路要落地的那一份：`saveUploaded`。
 *
 * 这里只测它自己的四条守卫与命名规则；「写完之后 attach 认不认」由
 * `tests/uemaster.test.ts` 的 attach 用例覆盖（它走的是同一个 `artifactFile`）。
 */
describe('saveUploaded', () => {
  const html = new TextEncoder().encode('<!doctype html><title>上传</title>');

  it('写到 data/uemaster/PAN-<n>/<stage>-<ts>.html，返回站内路径', async () => {
    const at = new Date(1_800_000_000_000);
    const url = await saveUploaded(7, 'inspect', { name: '走查.HTML', size: html.byteLength, bytes: html }, at);
    expect(url).toBe('/uemaster/PAN-7/inspect-1800000000000.html');

    const res = await get(['PAN-7', 'inspect-1800000000000.html']);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(CSP);
    expect(await res.text()).toContain('上传');
  });

  it('只收 .html / .htm；大小与空文件各有一句中文', async () => {
    const cases: Array<[unknown, string]> = [
      [{ name: 'x.png', size: 10, bytes: html }, '只收 .html 文件'],
      [{ name: 'x.html.exe', size: 10, bytes: html }, '只收 .html 文件'],
      [{ name: 'x.html', size: 0, bytes: new Uint8Array() }, '文件是空的'],
      [{ name: 'x.html', size: MAX_UPLOAD_BYTES + 1, bytes: html }, '文件不能超过 5 MB'],
    ];
    for (const [upload, message] of cases) {
      let caught: unknown;
      try {
        await saveUploaded(7, 'review', upload as never);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect(caught).toMatchObject({ message });
    }
  });

  it('stage 与编号不合法的都在拼路径之前就拒掉', async () => {
    const upload = { name: 'x.html', size: html.byteLength, bytes: html };
    for (const stage of ['design', '', undefined]) {
      let caught: unknown;
      try {
        await saveUploaded(7, stage, upload);
      } catch (e) {
        caught = e;
      }
      expect(caught).toMatchObject({ code: 'invalid_stage' });
    }
    for (const number of ['PAN-7', '-1', '0', '', null]) {
      let caught: unknown;
      try {
        await saveUploaded(number, 'evaluate', upload);
      } catch (e) {
        caught = e;
      }
      expect(caught).toMatchObject({ message: '需求编号不合法' });
    }
  });
});
