import { stat } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';
import { asText, parseRequirementId, requirePlainObject } from '../validate.js';
import type { Locked } from '../requirements/lock.js';
import { isStage, type Stage } from './packs.js';
import { ARTIFACT_PREFIX, BAD_URL, adoptLegacyArtifact, artifactFile } from './store.js';

const BAD_STAGE = '阶段只能是 evaluate、review、inspect 之一';

/**
 * 内容指纹的格式：sha256 的十六进制。
 *
 * 为什么要校验：`input_hash` 是**比对键**（读侧拿它与当前描述的指纹逐字相等比较），
 * 一个大小写不对、或者被截断的值不会让任何东西报错，只会让那份产物永远显示
 * 「需求已更新」。宁可在这里拒绝一个形状不对的值，也不要在库里留一个永远不等于
 * 任何东西的字符串。
 *
 * 不传就是 null（**不是**在这里现算）：attach 发生在生成**之后**，那时需求可能已经
 * 被改过；现算出来的指纹会声称这次生成是照着新版做的，而它其实是照着旧版做的。
 * 见 `src/db/schema.ts` 的 `inputHash` 注释与 `requirements/fingerprint.ts` 文件头。
 */
const BAD_HASH = '内容指纹格式不正确';

function parseInputHash(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return null;
  if (!/^[0-9a-f]{64}$/.test(text)) throw new AppError('invalid_hash', BAD_HASH);
  return text;
}
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
 * 产物链接的两种合法形状：完整 http(s) 链接，或以 `/uemaster/` 开头的站内路径。
 *
 * 为什么站内路径是必需的形状：文件写在项目里的 `data/uemaster/`，交回来的就是
 * `/uemaster/PAN-7/evaluate-v003.html`（由 `app/uemaster/[...path]/route.ts` 服务）；
 * 要求它拼一个绝对域名只会拼错。
 *
 * 为什么站内路径的口径从「以 / 开头」收紧成「以 /uemaster/ 开头」：静态根已经不是
 * 产物的家了，`/foo/bar.html` 这种名字在这个系统里不再指向任何可服务的文件——
 * 收下它只会造出一条「attach 说成功、点开 404」的链接，而那种坏每一层都「没错」。
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
  const siteRelative = url.startsWith(ARTIFACT_PREFIX) && !decoded.startsWith('//');

  if (!/^https?:\/\//i.test(url) && !siteRelative) throw new AppError('invalid_url', BAD_URL);
  return url;
}

/**
 * 站内链接 → 磁盘路径。
 *
 * 解析基准不再是 `public/`，而是 `data/uemaster/`（见 `store.ts` 的文件头）：产物
 * 从静态根搬出来的理由是安全——同源第三方 HTML 里的脚本会带着本站 cookie 执行。
 * 围栏（`..`、绝对路径、落在根外）在 `artifactFile` 里，与路由那一层共用一份实现：
 * 这个函数被两个入口调用（MCP 的 attach、抽屉的 attach），路径判据只能有一处。
 */
const siteFile = artifactFile;

/**
 * 站内链接必须有文件在后面。
 *
 * 为什么在服务层验：attach 说成功、抽屉里出现一行链接、点开 404——这是最难查的
 * 一种坏，因为每一层都「没错」。产物是 agent 写出来的文件，写没写是**可验的事实**，
 * 就该在交回来的时候验掉。http(s) 链接不验：那种产物在别人的服务器上，够不着。
 */
async function assertSiteFileExists(url: string): Promise<void> {
  /**
   * 先把「写到仓库里了」那一份收过来（`store.ts` 的 `adoptLegacyArtifact`）：
   * 任务包让 agent 写到 `<仓库>/data/uemaster/...`，而产物根在仓库外。
   * 这一步放在 stat 之前，所以对调用方来说「包怎么写、文件就该在哪」仍然成立。
   */
  adoptLegacyArtifact(url);
  const file = siteFile(url);
  const rel = `data${url}`;
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
 * 记一份 UEmaster 产物：校验 + 落库 + 事件。**不改需求状态**（2026-11-10 起）。
 *
 * 只存链接、不存正文（spec §5）：正文是 HTML，进库就成了「谁负责渲染、谁负责清理」
 * 的新问题；而文件的位置是确定的（`data/uemaster/`，经 `/uemaster/...` 这条路由
 * 带着 sandbox CSP 出去），链接已经够用。
 *
 * 同一 (requirement, stage) 允许多行：重做一次就是一条新版本，读侧取最新一行，
 * 其余进「历史」。2026-11-10 起每份新材料的文件名带版本号（`evaluate-v003.html`，
 * 见 `versions.ts`），所以「多行」在磁盘上也真的是多份文件——在这之前它们指向
 * 同一个 `evaluate.html`，第二份把第一份覆盖掉了。
 *
 * ── 为什么这里**不再**推进状态（owner 的第二次纠正）
 *
 * R-P2-8 曾经让「接上一份评估材料」本身成为 `收集 → 待设计` 的扳机：材料落了库，需求
 * 就顺带被推到待设计。owner 看出来的问题是**把决定藏进了产物里**——「我生成一份材料
 * 看看」与「这条需求我接了、我立项」于是变成同一个点击，用户没有改主意的机会，而
 * 「材料出过几版」与「立没立项」在时间线上也分不开。
 *
 * 现在两件事分开：
 * - **生成 / 交回材料**：只是一个动作，落一行产物 + 一条 `uemaster.attached` 事件，
 *   状态一个字不动（收集里的需求可以反复重做材料，这正是它该有的自由）；
 * - **立项**：`收集 → 待设计`，由用户点「立项」触发（`requirements/evaluate.ts`，
 *   trigger `approve`，带 `guard: 'brief'`），或走 MCP 的 `requirement_start_design`。
 *
 * 理由一句话：**材料是产物，立项是决定**。决定该由一个明说的动作做，而不是「我看过
 * 材料」的副作用。
 *
 * 存在性检查放在事务里、并且用一次 `select ... for update` 而不是直接 insert：外键
 * 冲突抛的是英文的 23503，而「这条需求不存在」是调用方（MCP agent）最常撞上的错误，
 * 得给它中文 code。行锁仍然要：软删除可能正好发生在这次 attach 中间，而「需求还在
 * 不在」是这个事务唯一的判断——锁住的才是这次 insert 真正插进去的那一行。
 *
 * 顺序是「需求存在」→「站内文件存在」→ insert → 事件：需求 id 打错时该报「需求不存在」，
 * 而不是报一个跟这条需求毫无关系的文件缺失。
 *
 * P4-02 起多收一个可空的 `inputHash`：这份产物是照着哪一版描述生成的。它由**生成
 * 入口**在读需求那一刻算好带下来（见 `fingerprint.ts` 与 `start.ts` 的注释），这里
 * 只负责校验形状、原样落库；拿不到就存 null（`版本未知`），绝不现算。
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
  // 生成入口在读需求那一刻算好、一路带下来；人/agent 直接 attach 时不传 → null。
  const inputHash = parseInputHash(input.inputHash);

  return db.transaction(async (tx) => {
    // `deleted_at is null`：软删除的需求对外等于不存在（P4-02）。这条检查同时守住了
    // 一条更隐蔽的路——一次生成跑完时需求已经被删了，attach 会在这里说不，而不是
    // 往一条看不见的需求上再挂一份材料。
    //
    // 取回整行（`Locked`）而不是只判存在：下面的 insert 是这次唯一一处写入，行锁让
    // 「这条需求还在」这个判断读到的就是它将要写入的那一行。
    //
    // 列的清单仍是 `Locked` 那一整行：`evaluateInTx` 不再从这里调用了（见下），但那
    // 一行是「这条需求现在长什么样」的公共形状，删列会让下一次需要它的人再猜一遍。
    const found = await tx.execute<Locked>(
      sql`select state, type, prd_url, context, problem, outcome from requirements
           where id = ${requirementId} and deleted_at is null
           for update`);
    if (!found.rows[0]) throw new AppError('not_found', NO_REQUIREMENT);

    // 只验站内路径：http(s) 的产物在别人服务器上，这里够不着。
    if (url.startsWith('/')) await assertSiteFileExists(url);

    const inserted = await tx.execute<{ id: string }>(sql`
      insert into uemaster_artifacts (requirement_id, stage, url, created_by, input_hash)
      values (${requirementId}, ${stage}, ${url}, ${actor}, ${inputHash})
      returning id`);

    await recordEvent(tx, {
      requirementId,
      actor,
      type: 'uemaster.attached',
      payload: { stage, url },
    });

    /**
     * 这里**曾经**有一段 R-P2-8：`stage === 'evaluate' && row.state === 'inbox'` 时
     * 调 `evaluateInTx` 把需求推进到待设计（并在同一个事务里跑 `brief` 门）。
     *
     * 2026-11-10 owner 的第二次纠正把它删掉了：**评估 ≠ 立项**。生成材料只落产物，
     * 立项是一个单独的动作（trigger `approve`，见 `requirements/evaluate.ts`）。
     * 报告：`docs/superpowers/plans/2026-11-10-v1-cut-report.md` §16。
     *
     * 为什么不是「留着但默认关掉」：一条「材料落地会改状态」的路径只要还在，就还有
     * 一个入口把决定藏在产物里（人 / agent / 批量导入都踩得到它）。删掉它，状态只能由
     * `收集 → 待设计` 那条边改——那是唯一一处写着 `guard: 'brief'` 的地方。
     */

    return { id: inserted.rows[0]!.id, stage, url };
  });
}
