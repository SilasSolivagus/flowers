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
 * 产物链接的两种合法形状：完整 http(s) 链接，或以 `/` 开头的站内路径。
 *
 * 为什么站内路径是必需的形状：agent 把文件写在 `public/uemaster/...`，交回来的
 * 就是 `/uemaster/PAN-7/evaluate.html`；要求它拼一个绝对域名只会拼错。
 *
 * 为什么排除 `//host/x`：那在浏览器里是协议相对 URL，等于打开站外的 http(s) 页面。
 * 它虽然「以 / 开头」，却不是站内路径——放行它等于给抽屉里开一个去任意站点的跳板。
 *
 * 为什么连 `javascript:` 一起收在 invalid_url 里：抽屉会把这个值直接渲染成 <a href>，
 * `javascript:` / `data:` 一旦落库就是一个储存型脚本执行点。
 */
function parseUrl(value: unknown): string {
  const url = asText(value);
  const siteRelative = url.startsWith('/') && !url.startsWith('//');
  if (!/^https?:\/\//i.test(url) && !siteRelative) throw new AppError('invalid_url', BAD_URL);
  return url;
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
