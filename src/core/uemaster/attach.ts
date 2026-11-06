import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';
import { asText, parseRequirementId, requirePlainObject } from '../validate.js';
import { isStage, type Stage } from './packs.js';

const BAD_STAGE = '阶段只能是 evaluate、review、inspect 之一';
const BAD_URL = '产物链接必须是以 http:// 或 https:// 开头的完整链接，或以 / 开头的站内路径';
const NO_REQUIREMENT = '需求不存在';

/**
 * stage 白名单。
 *
 * 库里有 CHECK，为什么还要在服务层先挡一次：CHECK 抛的是 23514，一个英文的
 * `new row ... violates check constraint`，控制器按 `e.code` 分支时只能当未知错误；
 * 而用户填错的 stage 是一件**平常的用户错误**，该拿到一句中文。
 */
function parseStage(value: unknown): Stage {
  const stage = asText(value);
  if (!isStage(stage)) throw new AppError('invalid_stage', BAD_STAGE);
  return stage;
}

/**
 * C0 控制字符（含 tab/换行）与空白，外加反斜杠。
 *
 * 为什么要在**解析之前**拒：WHATWG 的 URL 解析器会把 tab、LF、CR 从输入里直接
 * 剔掉，所以 `/<TAB>/evil.com/x.html` 落地就是 `//evil.com/x.html`；而在 http(s)
 * 这类特殊 scheme 下反斜杠等价于 `/`，`/\evil.com/x.html` 同样解析成
 * `//evil.com/x.html`。两个字符串都「以 / 开头」却都指向站外——只查前缀的守卫
 * 会被它们绕过去。合法产物路径里不含这些字符，直接拒掉最省事。
 */
const FORBIDDEN_IN_URL = /[\u0000-\u0020\u007f\\]/;

/**
 * 逐层解码（最多两层），用于识破 `/%2F/evil.com` 这种「解码后才变成协议相对」的形状。
 *
 * 非法百分号编码（`/%E0%A4%A`）解不开就按原文继续判：浏览器会把它当字面字符，
 * 而它仍然是站内路径；真正的「文件不存在」由后面的 stat 负责说。
 */
function decodedLayers(url: string): string {
  let out = url;
  for (let i = 0; i < 2; i += 1) {
    try {
      const next = decodeURIComponent(out);
      if (next === out) break;
      out = next;
    } catch {
      break;
    }
  }
  return out;
}

/**
 * 产物链接的两种合法形状：完整 http(s) 链接，或以 `/` 开头的站内路径。
 *
 * 为什么站内路径是必需的形状：agent 把文件写在 `public/uemaster/...`，交回来的
 * 就是 `/uemaster/PAN-7/evaluate.html`；要求它拼一个绝对域名只会拼错。
 *
 * 为什么连 `javascript:` / `data:` 一起收在 invalid_url 里：抽屉会把这个值直接
 * 渲染成 <a href>，那两种 scheme 一旦落库就是一个储存型脚本执行点。
 *
 * 归一化（控制字符、反斜杠、解码后的 `//`）见 `FORBIDDEN_IN_URL` 与
 * `decodedLayers`：判的是「浏览器最终会把它解析成什么」，不是「字符串长什么样」。
 */
function parseUrl(value: unknown): string {
  const url = asText(value);
  if (FORBIDDEN_IN_URL.test(url)) throw new AppError('invalid_url', BAD_URL);

  const decoded = decodedLayers(url);
  if (FORBIDDEN_IN_URL.test(decoded)) throw new AppError('invalid_url', BAD_URL);
  // 解码后以 `//` 开头：浏览器会当协议相对 URL，等于打开站外页面。
  const siteRelative = url.startsWith('/') && !decoded.startsWith('//');

  if (!/^https?:\/\//i.test(url) && !siteRelative) throw new AppError('invalid_url', BAD_URL);
  return url;
}

/**
 * 仓库根：**从本模块自己的位置**往上数，不认 `process.cwd()`。
 *
 * 本文件住在 `<仓库>/src/core/uemaster/attach.ts`，所以 `../../../` 就是仓库根。
 * 为什么不能用 cwd：这个模块的第二个调用方是 MCP server（`mcp/server.ts`），而
 * MCP server 是被**别人的客户端**起的——Claude Code 在哪个目录里开会话，那个目录
 * 就是 cwd。按 cwd 找 `public/` 就等于「从 /tmp 启动的 server 永远报产物文件不存在」，
 * 而文件明明在仓库里；文档里那句 `bash -lc 'cd <仓库> && exec …'` 就是在给这个 bug
 * 打补丁，补丁的代价是「必须从仓库根启动」这条隐形约束。
 *
 * 为什么是「模块位置」而不是某个环境变量：交付链接是站内路径，它描述的本来就是
 * **这个仓库**的 public/，与调用方站在哪里无关。写成模块相对，MCP server、测试、
 * 页面三处自动一致，不需要谁记得配一个 `FLOWERS_ROOT`。
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** 站内路径的解析基准。`public/` 是 Next 的静态根，也是产物唯一允许落地的位置。 */
const PUBLIC_ROOT = path.join(REPO_ROOT, 'public');

/**
 * 站内链接 → 磁盘路径。
 *
 * 站内路径的解析基准是**仓库根目录下的 public/**（`REPO_ROOT`，见上）：`/uemaster/PAN-7/evaluate.html`
 * 对应 `public/uemaster/PAN-7/evaluate.html`。`path.resolve` 会把 `..` 折叠掉，所以
 * 折完还要回头确认仍落在 public 里——否则 `/uemaster/../../.env` 能读到仓库任意文件。
 */
function siteFile(url: string): string {
  const abs = path.resolve(PUBLIC_ROOT, `.${url}`);
  const rel = path.relative(PUBLIC_ROOT, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AppError('invalid_url', BAD_URL);
  }
  return abs;
}

/**
 * 站内链接必须有文件在后面。
 *
 * 为什么在服务层验：attach 说成功、抽屉里出现一行链接、点开 404——这是最难查的
 * 一种坏，因为每一层都「没错」。产物是 agent 写出来的文件，写没写是**可验的事实**，
 * 就该在交回来的时候验掉。http(s) 链接不验：那种产物在别人的服务器上，够不着。
 */
async function assertSiteFileExists(url: string): Promise<void> {
  const file = siteFile(url);
  const rel = `public${url}`;
  try {
    const info = await stat(file);
    if (info.isFile()) return;
  } catch {
    // 落到下面统一报错：不存在与「存在但不是文件」对调用方是同一件事。
  }
  throw new AppError(
    'artifact_missing',
    `产物文件不存在：${rel} —— 先把文件写到项目根目录下的 ${rel}，再把链接交回来`,
  );
}

/**
 * 记一份 UEmaster 产物：校验 + 落库 + 事件。
 *
 * 只存链接、不存正文（spec §5）：正文是 HTML，进库就成了「谁负责渲染、谁负责清理」
 * 的新问题；而 agent 写文件的位置是确定的 `public/uemaster/`，链接已经够用。
 *
 * 同一 (requirement, stage) 允许多行：重做一次就是一条新版本，读侧取最新。
 * 不 update 旧行——历史版本是「当初评审看的什么」的证据。
 *
 * 存在性检查放在事务里、并且用一次 `select` 而不是直接 insert：外键冲突抛的是英文的
 * 23503，而「这条需求不存在」是调用方（MCP agent）最常撞上的错误，得给它中文 code。
 * 不加行锁——本次不改需求状态，没有需要串行化的写。
 *
 * 顺序是「需求存在」→「站内文件存在」→ insert：需求 id 打错时该报「需求不存在」，
 * 而不是报一个跟这条需求毫无关系的文件缺失。
 */
export async function attachArtifact(
  db: Db,
  actor: string,
  raw: unknown,
): Promise<{ id: string; stage: Stage; url: string }> {
  // 入口守卫全部在开事务之前：参数错了不值得占一条连接再回滚。
  const input = requirePlainObject(raw);
  const requirementId = parseRequirementId(input);
  const stage = parseStage(input.stage);
  const url = parseUrl(input.url);

  return db.transaction(async (tx) => {
    const found = await tx.execute<{ id: string }>(
      sql`select id from requirements where id = ${requirementId}`,
    );
    if (found.rows.length === 0) throw new AppError('not_found', NO_REQUIREMENT);

    // 只验站内路径：http(s) 的产物在别人服务器上，这里够不着。
    if (url.startsWith('/')) await assertSiteFileExists(url);

    const inserted = await tx.execute<{ id: string }>(sql`
      insert into uemaster_artifacts (requirement_id, stage, url, created_by)
      values (${requirementId}, ${stage}, ${url}, ${actor})
      returning id`);

    await recordEvent(tx, {
      requirementId,
      actor,
      type: 'uemaster.attached',
      payload: { stage, url },
    });

    return { id: inserted.rows[0]!.id, stage, url };
  });
}
