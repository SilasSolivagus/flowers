import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { AppError } from '../../../src/core/errors';
import { ARTIFACT_PREFIX, artifactFile } from '../../../src/core/uemaster/store';

/**
 * 产物的唯一出口：`/uemaster/<PAN-n>/<stage>.html`。
 *
 * 为什么产物不能继续躺在 `public/`：agent 生成的是**同源的第三方内容**。从静态根
 * 直接服务，那份 HTML 里的 `<script>` 会以本站的 origin 执行——一个交回来的文件里
 * 写 `fetch('/', {credentials:'include'})` 就是一条持久的储存型 XSS，而站点没有任何
 * 一层能说「不」。所以文件搬到 `public/` 之外（`data/uemaster/`，git 忽略），这条
 * 动态路由是唯一能读到它的地方，并且给每个响应挂上同一组头。
 *
 * `Content-Security-Policy: sandbox allow-scripts` 是关键那一行：文档被关进**不透明
 * 源**，但脚本照跑。这两件事必须一起看——R-P2-9 之前的 `sandbox`（不带
 * `allow-scripts`）把脚本整个关掉，走查页那种「点左边流程节点、右边切线框页」的
 * 交互是死的，材料读得到却全是死图。裁决是：**要活，但不要同源**。
 *
 * 为什么放开脚本仍然安全：`sandbox` 只要**不带 `allow-same-origin`**，文档就落在一个
 * 不透明源里——`document.cookie` 读不到本站的（空串或抛错）、`localStorage` 不可用、
 * 同源 `fetch` 带不上也读不到任何东西（本站没有 CORS 头，响应是 opaque 或被拦）。
 * 危险的那一种组合是 `allow-scripts allow-same-origin` 同时出现——脚本能自己把沙箱
 * 拆掉，等于没有沙箱。这一行里没有它，所以不放。
 *
 * 剩下三条头各有分工：
 * - `default-src 'none'` 把外部资源全关掉（产物本来就要求自足：不引 CDN），并且连
 *   `connect-src` 一起关：`fetch('/')` 在 CSP 这一层就被拒，不必等网络层。
 *   行内脚本、行内样式与 `data:`/`blob:` 图片单独放开，否则走查页的切换与线框图都死。
 * - `Content-Type: text/html; charset=utf-8` 固定成 HTML：路由收的就是 HTML，
 *   不让磁盘上的后缀决定响应类型（`.svg` 之类的名字不该改变这一层的行为）。
 * - `nosniff` 让浏览器别猜：即使将来有人往这个目录塞了别的文件，它也不会被当成
 *   可执行的脚本或样式。
 */
const CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:";

const HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'Content-Type': 'text/html; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};

/** 换行会插进日志、`..` 会往上爬：段内一律不允许这些形状。 */
function unsafe(segment: string): boolean {
  return (
    segment === ''
    || segment === '.'
    || segment === '..'
    || segment.includes('/')
    || segment.includes('\\')
    || segment.includes('\u0000')
    || path.isAbsolute(segment)
  );
}

/**
 * 路由段 → 站内路径，任何一段不像一个普通文件名就返回 null。
 *
 * 为什么要**逐段**判、并且逐层解码：Next 交来的段是解码过一次的，但
 * `/uemaster/PAN-7/..%2F..%2Fpackage.json` 解完是 `../../package.json` 这一整个
 * 字符串（含斜杠），折进路径就成了向上穿越；`%252e%252e` 更是要解两层才现形。
 * 这里判的是「这一段解完之后还是一个普通文件名吗」，而不是「原串里有没有 ..」。
 * 真正的围栏仍然在 `artifactFile` 里（折完再确认落在 `data/uemaster` 内）——
 * 两处各判一次，是因为这一处错一次就会把整个仓库读出去。
 */
function segmentsToUrl(raw: readonly string[]): string | null {
  const parts: string[] = [];
  for (const segment of raw) {
    let decoded = segment;
    for (let i = 0; i < 2; i += 1) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      } catch {
        break;
      }
    }
    if (unsafe(decoded)) return null;
    parts.push(decoded);
  }
  if (parts.length === 0) return null;
  return `${ARTIFACT_PREFIX}${parts.join('/')}`;
}

/** 找不到就是这个答案：不区分「没有这份材料」与「名字不合法」，两者对外都是 404。 */
function missing(): Response {
  return new Response('产物不存在', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  });
}

/**
 * `params` 在 Next 16 是 Promise；`await` 一个普通对象也不会坏，所以两种形状都吃。
 *
 * 不缓存（`force-dynamic`）：同名文件会被下一次交回**覆盖**（`<stage>-<ts>.html`
 * 只保证不同次不同名，但 `--keep` 的占位文件与手写的同名文件都会走到这里），
 * 而这是「我刚交上去的材料」，读到上一版是最难解释的一种错。
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path: raw } = await context.params;
  const url = segmentsToUrl(raw ?? []);
  if (url === null) return missing();

  let file: string;
  try {
    file = artifactFile(url);
  } catch (error) {
    // artifactFile 的越界是 invalid_url——对 HTTP 这一层它就是「没有这个资源」。
    if (error instanceof AppError) return missing();
    throw error;
  }

  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) return missing();
    size = info.size;
  } catch {
    return missing();
  }

  // 流式返回：产物是一份自足 HTML（可能带整张流程图），一次读进内存没有意义。
  const body = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 200,
    headers: { ...HEADERS, 'Content-Length': String(size) },
  });
}
