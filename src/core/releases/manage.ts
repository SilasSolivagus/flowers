import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { recordEvent } from '../events.js';
import { AppError, withPgErrors } from '../errors.js';
import { asText, parseReleaseId, requirePlainObject } from '../validate.js';

/**
 * 版本的增删改（P4-02 的录入面）。
 *
 * 这一层回答的问题不是「什么时候发版」（那是 `schedule.ts` 的排队/承诺日期），
 * 而是「有哪些版本、它们各自的时间窗和意图是什么」。owner 要的是**全量 CRUD**：
 * 建错的版本要能改、能删（软删），而不是只能去连库。
 *
 * 三条边界：
 * 1. **重叠只是警告，不是错误**。真实世界里「这一版拖到了下一版的开窗日」是常态，
 *    把重叠做成硬约束只会逼人把日期填错。所以 `createRelease` / `updateRelease`
 *    返回 `warning`，由界面就地显示一行——库里照存。
 * 2. **日期按 UTC 零点解析**（与 `schedule.ts` 同一条口径）：'2026-11-01' 是一件
 *    日历事实，不是某个时区的瞬间。
 * 3. **软删除**（`deleted_at`）：需求通过 `release_id` 指向版本，硬删要么被外键
 *    拦住、要么把需求的排期一起弄丢。删掉的版本从版本页、看板的版本标签、排期
 *    下拉里一起消失（读侧一律 `deleted_at is null`）。
 */

const BAD_DATE = '版本日期不合法';

/** 一个版本在录入面上的形状（对外全是 camelCase）。 */
export type ReleaseForm = {
  name: string;
  /** 'YYYY-MM-DD'。 */
  windowStart: string;
  releaseDate: string;
  goal: string | null;
  note: string | null;
};

/** 版本的摘要：策略行与重叠警告只需要这四个值。 */
export type ReleaseSummary = {
  id: string;
  name: string;
  windowStart: string;
  releaseDate: string;
};

/**
 * 'YYYY-MM-DD' → 那个 UTC 零点。解析不出来就报中文。
 *
 * 与 `schedule.ts` 的 `parseDateOrThrow` 是同一件事、同一句话：两个入口对「日期不合法」
 * 必须给同一种说法，否则用户在排期表单和版本表单上会看到两种错误。
 */
export function parseDayOrThrow(text: string): Date {
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new AppError('bad_dates', BAD_DATE);
  return date;
}

/**
 * 时间窗的纯函数（`overlapOf` / `dayLabel`）住在 `window.ts`，这里再导出一次：
 * 服务层与**客户端表单**用的是同一份实现，而客户端不能 import 这个文件（它 import
 * 了 drizzle 与 db/client）。测试从这一个入口拿，读起来仍然像「版本服务的一部分」。
 */
export { dayLabel, overlapOf } from './window.js';
import { overlapLine, pickOverlapping } from './window.js';

type ReleaseRow = {
  id: string;
  name: string;
  window_start: string;
  release_date: string;
};

/**
 * 「上一个版本」：发版日不晚于给定日期的、最近的那个活着的版本。
 *
 * 为什么按 `release_date` 而不是 `window_start` 取：owner 举的例子是「最近一个版本
 * 是几号到几号」——人记一版是记它**发版**的那天。按发版日排序，`desc limit 1`
 * 就是「离这一版最近的前一版」。
 *
 * `excludeId` 给编辑用：改一版的时候，「上一个版本」不该是它自己（那会得到一条
 * 永远成立的「与自身重叠」警告）。
 *
 * 返回 null 的两种情形在读侧合成同一句话（「还没有版本，这是第一个」）：库里一个
 * 活着的版本都没有，或者要建的这一版比所有现存版本都早。后者在这套日期口径下
 * 只可能是「补录一个历史版本」，那句话略有偏差——P4-02 的报告里记了这一条。
 */
export async function previousRelease(
  db: Db,
  releaseDate: string,
  excludeId: string | null = null,
): Promise<ReleaseSummary | null> {
  parseDayOrThrow(releaseDate);
  const res = await db.execute<ReleaseRow>(sql`
    select id, name, window_start, release_date
      from releases
     where deleted_at is null
       and release_date <= ${releaseDate}
       and (${excludeId}::uuid is null or id <> ${excludeId}::uuid)
     order by release_date desc, name
     limit 1`);
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    windowStart: new Date(row.window_start).toISOString(),
    releaseDate: new Date(row.release_date).toISOString(),
  };
}

/**
 * 与这一版**时间窗相交**的、发版日最近的那一个版本；没有就 null。
 *
 * 为什么它和 `previousRelease` 是两个函数（owner 的裁决，2026-11-07）：
 * - **「上一个版本」是上下文**（帮我补日期）：永远是发版日最近的那一个，与这一版
 *   撞不撞车无关。
 * - **重叠检测是防撞车**：必须扫**全部**活着的版本。只看「上一个」会漏报——现网
 *   2026.13（11-14 → 11-28）与 2026.12（11-14 → 12-07）真的重叠着，而 2026.12 的
 *   发版日在这一版之后，按「上一个」的定义根本看不见它。这条漏报就是两个定义必须
 *   分开的证据。
 *
 * 命中多条时取**发版日离这一版最近**的那一条（`|release_date - 本版发版日|` 最小；
 * 打平时取更晚的那一条——「前面已经有一版要发」比「上一版还没收尾」更值得先说）。
 *
 * 相交判据与 `window.ts` 的 `overlapOf` 逐字一致（半开区间：首尾相接不算）：
 * `window_start < 本版发版日 and release_date > 本版开窗日`。
 */
export async function overlappingRelease(
  db: Db,
  entered: { windowStart: string; releaseDate: string },
  excludeId: string | null = null,
): Promise<ReleaseSummary | null> {
  const start = parseDayOrThrow(entered.windowStart);
  const end = parseDayOrThrow(entered.releaseDate);

  const res = await db.execute<ReleaseRow>(sql`
    select id, name, window_start, release_date
      from releases
     where deleted_at is null
       and (${excludeId}::uuid is null or id <> ${excludeId}::uuid)
       and window_start < ${end.toISOString()}
       and release_date > ${start.toISOString()}
     order by release_date, name`);
  if (res.rows.length === 0) return null;

  // 「谁最近」只写在 `window.ts` 的 `pickOverlapping` 里：界面在用户敲日期时也要算
  // 同一件事，而客户端组件 import 不了这个文件（它连着 db）。SQL 只负责把相交的
  // 那几行取出来，挑哪一条由那个纯函数决定——两处共用一份判定。
  const picked = pickOverlapping(entered, res.rows.map((row) => ({
    id: row.id,
    name: row.name,
    windowStart: new Date(row.window_start).toISOString(),
    releaseDate: new Date(row.release_date).toISOString(),
  })));
  return picked === null ? null : picked as ReleaseSummary;
}

/**
 * 重叠警告的那一句话：点名版本与重叠的那一段。没有重叠就是 null。
 *
 * 文案本身在 `window.ts`（`overlapLine`）：界面上那行**行内提示**与服务返回的
 * `warning` 必须是同一句话，否则「敲日期时看到的那句」与「保存后看到的那句」会长得
 * 不一样——同一件事的两种说法是最容易让人怀疑数据的一种坏。
 *
 * 入参是**相交的那一版**（`overlappingRelease` 的结果），不是「上一个版本」。
 */
export function overlapWarning(
  entered: { windowStart: string; releaseDate: string },
  overlapping: ReleaseSummary | null,
): string | null {
  return overlapLine(entered, overlapping);
}

/** 入参里的一个描述值 → 落库写法：字符串去空白、空串归 null。 */
function toStored(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new AppError('invalid', `${label}必须是文本`);
  const text = value.trim();
  return text === '' ? null : text;
}

/** 两个必填日期：缺一个就报同一句话（缺字段与格式不对是两回事，说法也不同）。 */
function requiredDates(input: Record<string, unknown>): { windowStart: string; releaseDate: string } {
  const windowStart = asText(input.windowStart);
  const releaseDate = asText(input.releaseDate);
  if (windowStart === '' || releaseDate === '') {
    throw new AppError('missing_dates', '版本要有开始日和发版日');
  }
  if (parseDayOrThrow(windowStart).getTime() > parseDayOrThrow(releaseDate).getTime()) {
    throw new AppError('bad_dates', '发版日不能早于版本开始日');
  }
  // 落库前统一成 UTC 零点（'2026-11-01' 与 '2026-11-01T00:00:00Z' 是同一个窗口）。
  return {
    windowStart: parseDayOrThrow(windowStart).toISOString(),
    releaseDate: parseDayOrThrow(releaseDate).toISOString(),
  };
}

/** 版本名称：非空。 */
function requiredName(input: Record<string, unknown>): string {
  const name = asText(input.name);
  if (name === '') throw new AppError('invalid', '版本名称不能为空');
  return name;
}

export type ReleaseWriteResult = {
  id: string;
  /** 重叠警告（不是错误）：界面就地显示一行，库里照存。 */
  warning: string | null;
  /** 用来算这条警告的那个「上一个版本」，界面那行策略文案也用它。 */
  previous: ReleaseSummary | null;
  /**
   * 与这一版时间窗相交、发版日最近的那一个版本（`null` = 没撞上任何版本）。
   *
   * 与 `previous` **不一定相同**：相交的可能是更晚的那一版。两个值都回给调用方，
   * 界面那行策略用 `previous`、它自己的行内提示用 `overlapLine(entered, overlapping)`
   * ——同一个判定、同一句话，两处不会各说各的。
   */
  overlapping: ReleaseSummary | null;
};

/**
 * 新建版本。
 *
 * 顺序：校验（不碰库）→ 取「上一个版本」→ insert → 事件。
 * 「上一个版本」要在 insert **之前**取：插进去之后它自己就会成为最近的那一版，
 * 再查一次拿到的就是它自己。
 */
export async function createRelease(
  db: Db,
  actor: string,
  raw: unknown,
): Promise<ReleaseWriteResult> {
  const input = requirePlainObject(raw);
  const name = requiredName(input);
  const dates = requiredDates(input);
  const goal = toStored(input.goal, '版本目标');
  const note = toStored(input.note, '备注');

  // 两件事各问各的：`previous` 是策略行的上下文，`overlapping` 是防撞车（见两者注释）。
  const previous = await previousRelease(db, dates.releaseDate);
  const overlapping = await overlappingRelease(db, dates);
  const warning = overlapWarning(dates, overlapping);

  return withPgErrors(() => db.transaction(async (tx) => {
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into releases (name, window_start, release_date, goal, note)
      values (${name}, ${dates.windowStart}, ${dates.releaseDate}, ${goal}, ${note})
      returning id`);
    const id = inserted.rows[0]!.id;

    await recordEvent(tx, {
      // 版本不是需求：`events.requirement_id` 可空，版本事件就是 null。
      requirementId: null,
      actor,
      type: 'release.created',
      payload: {
        id, name, windowStart: dates.windowStart, releaseDate: dates.releaseDate,
        ...(goal === null ? {} : { goal }),
      },
    });

    return { id, warning, previous, overlapping };
  }));
}

/**
 * 改一个版本。只写变了的字段（与 `updateRequirement` 同一条规矩：无操作不产生事件）。
 *
 * 「上一个版本」用**改完之后**的时间窗去算（`dates` 已经合并过），并把自身排除——
 * 否则「把这一版往后挪」会立刻得到一条与自身重叠的警告。
 */
export async function updateRelease(
  db: Db,
  actor: string,
  raw: unknown,
): Promise<ReleaseWriteResult> {
  const input = requirePlainObject(raw);
  const id = parseReleaseId(asText(input.id));
  const name = requiredName(input);
  const dates = requiredDates(input);
  const goal = toStored(input.goal, '版本目标');
  const note = toStored(input.note, '备注');

  const previous = await previousRelease(db, dates.releaseDate, id);
  const overlapping = await overlappingRelease(db, dates, id);
  const warning = overlapWarning(dates, overlapping);

  return withPgErrors(() => db.transaction(async (tx) => {
    const updated = await tx.execute<{ id: string }>(sql`
      update releases
         set name = ${name}, window_start = ${dates.windowStart},
             release_date = ${dates.releaseDate}, goal = ${goal}, note = ${note}
       where id = ${id} and deleted_at is null
      returning id`);
    if (!updated.rows[0]) throw new AppError('not_found', '找不到这个版本');

    await recordEvent(tx, {
      requirementId: null,
      actor,
      type: 'release.updated',
      payload: { id, name, windowStart: dates.windowStart, releaseDate: dates.releaseDate },
    });

    return { id, warning, previous, overlapping };
  }));
}

/**
 * 软删除一个版本。
 *
 * 需求仍然指向它（`requirements.release_id` 不动）：那条需求的排期是历史事实，
 * 不该因为版本行被删就变空。读侧靠 join 上 `rel.deleted_at is null` 让标签消失
 * （见 `read/board.ts` 与 `read/detail.ts`）。
 *
 * 没有「还有需求挂着」这道拦截：owner 要的是**兜底**的删除能力，而拦在中间会让
 * 「建错了一个版本」变成「先去把三条需求挪走」。删掉之后那些需求的排期字段仍在，
 * 只是版本名不再显示——这比不让人删更接近意图。
 */
export async function deleteRelease(
  db: Db,
  actor: string,
  raw: unknown,
): Promise<{ id: string }> {
  const input = requirePlainObject(raw);
  const id = parseReleaseId(asText(input.id));

  return db.transaction(async (tx) => {
    const deleted = await tx.execute<{ name: string }>(sql`
      update releases set deleted_at = now()
       where id = ${id} and deleted_at is null
       returning name`);
    const row = deleted.rows[0];
    if (!row) throw new AppError('not_found', '找不到这个版本');

    await recordEvent(tx, {
      requirementId: null,
      actor,
      type: 'release.deleted',
      payload: { id, name: row.name },
    });

    return { id };
  });
}
