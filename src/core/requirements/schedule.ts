import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { assertTransition } from '../state-machine.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';
import {
  asText, parseReleaseId, parseRequirementId, requirePlainObject,
} from '../validate.js';
import { assertCan } from '../auth/guard.js';
import { lockRequirement, moveTo } from './lock.js';

const MISSING_DATES = '排期必须填版本、提测日和承诺完成日';
const BAD_DATE = '提测日和承诺完成日必须是有效日期';
/** 规则 2 的那句中文（2026-11-08 裁定，见下）。 */
const MISSING_PRD = '没有正式 PRD 链接的需求不能排期';

/**
 * 「有没有 PRD」的判据：`prd_url` 非空、且不是一串空白。
 *
 * 与 `submit-review.ts` 的 `if (!url)`、0027 的 `prd_url is null or btrim(prd_url) = ''`、
 * 0025 / 0026 的 `btrim(url) <> ''` 是同一条口径：**空白链接不是链接**。写成一个函数
 * 而不是内联的 `!row.prd_url`，是为了让「空串算不算」这个问题只有一个答案。
 */
function hasPrd(prdUrl: string | null): boolean {
  return (prdUrl ?? '').trim() !== '';
}

/**
 * 'YYYY-MM-DD' 按 UTC 零点解析（与 releases.window_start / release_date 的写入方式一致）。
 * 解析不出来就报 bad_dates：否则 Invalid Date 会一路走到 `toISOString()`，
 * 抛的是 RangeError，控制器按 `e.code` 分支时只能当未知错误。
 */
function parseDateOrThrow(text: string): Date {
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new AppError('bad_dates', BAD_DATE);
  return date;
}

/**
 * 排期：queue → ready，落版本和三个日期里的另外两个（提测日、承诺完成日）。
 *
 * 全部校验都在开事务之前做完，与 evaluate / submitReview / reviewPass 一致：
 * 三个日期缺失或自相矛盾是最常见的用户错误，没必要占一条连接、开一个事务再回滚；
 * 也让「校验先于查行」可以被单独测试（需求不存在时也先报 missing_dates / bad_dates）。
 *
 * 锁行语义见 lock.ts：并发双排期时后来者会等前者提交，看到 state 已变成 ready，
 * 于是撞 illegal_transition，而不是后一次静默覆盖前一次的排期。
 *
 * ## 规则 2（2026-11-08 裁定）：没有 PRD 的需求不能排期
 *
 * owner 的裁定：**有负责人但没有 PRD 的需求回「待设计」**（0027 那条迁移装的就是它），
 * 也就是说「没有正式文档」的需求真实位置在**待设计**，不在排期队列里。迁移只在跑的那
 * 一刻把位置摆正；**要让这条规则长期成立，得拦在写入口上**——否则下一个人照样能把一条
 * 没 PRD 的需求从待排期推进待开发，然后 0027 再跑一次把它拉回来，来回拉锯。
 *
 * 所以这里加一道门，判据与迁移逐字同源：`prd_url` 为空（含空白串）就不许排期。
 *
 * 三个刻意的取舍：
 *
 * 1. **不往状态机表里加 `guard: 'prd'`**。`queue → ready` 这一行确实可以挂同一道门，
 *    但 `assertGuards` 为 prd 准备的那句话是**评审专用的**——「直接提交评审必须有正式
 *    PRD 链接」。挂着它去点「排期」，用户看到的是「直接提交评审…」，而他没有提交评审。
 *    要修就得让那句文案按 trigger 分叉，等于改 `submit_review` 共用的那个门对象——那会
 *    动到评审的措辞与 fail-closed 语义（`tests/state-machine.test.ts` 逐字钉着它）。
 *    所以那道门原样留给评审，排期这道读**同一列**、用**自己的**措辞，写在服务里
 *    （与 `dates` 门同一个位置、同一个理由：状态机只看得到 from/to，看不到这行的内容）。
 * 2. **位置在 `assertTransition` 之后**：先配对、再动作、最后判门——与状态机自己的顺序
 *    一致（`assertTrigger` 就是 find → trigger → guard）。于是一条停在「待设计」的需求
 *    被点「排期」时，报的是「不能从「待设计」直接到「待开发」」，而不是「没有 PRD」：
 *    后者会让用户以为补个链接就能排期，而这一步根本不属于那个状态。
 * 3. **在事务里、锁行之后**：`prd_url` 是这一行的内容，只能从库里读（入参里没有它），
 *    而锁住这一行再读，才不会读到「判的时候没 PRD、写的时候已经有了」的半旧值。
 *    报错时不写事件、不改状态——事务整体回滚，与 dates 的两条拒绝路径同一个形状。
 */
export async function schedule(db: Db, actor: string, raw: unknown) {
  // 入口守卫：非对象 → '参数不合法'；非 uuid 会被 PG 以 22P02 拒绝，
  // 那不是 AppError，控制器按 code 分支时只能当未知错误。
  const input = requirePlainObject(raw);
  const requirementId = parseRequirementId(input);

  const releaseId = asText(input.releaseId);
  const commitTestAt = asText(input.commitTestAt);
  const commitDueAt = asText(input.commitDueAt);
  if (!releaseId || !commitTestAt || !commitDueAt) {
    throw new AppError('missing_dates', MISSING_DATES);
  }
  // 缺字段先报 missing_dates（上面的判断），**格式**不对才报 invalid：非 uuid 的
  // releaseId 会被 PG 以 22P02 拒绝，那不是 AppError，到控制器就是 500。
  const release = parseReleaseId(releaseId);

  const testAt = parseDateOrThrow(commitTestAt);
  const dueAt = parseDateOrThrow(commitDueAt);
  if (testAt.getTime() > dueAt.getTime()) {
    throw new AppError('bad_dates', '承诺完成日不能早于提测日');
  }

  return db.transaction(async (tx) => {
    const row = await lockRequirement(tx, requirementId);
    // 权限先于状态门（见 evaluate.ts 的同一段注释）。
    await assertCan(tx, actor, {
      ownerMemberId: row.owner_member_id, ownerLine: row.owner_line, state: row.state,
    }, 'edit');

    // queue → ready 是唯一通向 ready 的迁移，所以只按 from/to 配对判断就够：
    // 没经过评审就排期（inbox / design / review）、或重复排期（已在 ready），
    // 都会在这里撞 illegal_transition。
    // 不传 ctx：这条迁移没有 prd / type 门。日期那道门（dates）不归状态机管，
    // 上面已经逐条校验完了（顺序、发版日、可解析性）。
    assertTransition(row.state, 'ready');

    // 规则 2（见上面函数注释）：没有正式 PRD 就不许离开待排期。
    // 错误码复用 `missing_prd`（与评审那道门同一个码），于是界面上「缺 PRD」只有一种
    // 形状；措辞是**排期自己的**，不借用评审那句话（那是另一个动作）。
    if (!hasPrd(row.prd_url)) throw new AppError('missing_prd', MISSING_PRD);

    // releases.release_date 是 timestamptz，经 pg 的文本协议回来是**字符串**
    // （'2026-12-04 00:00:00+00'），不是 Date。必须先 new Date(...) 再比：
    // `new Date('2026-12-05') > '2026-12-04 00:00:00+00'` 这种 Date 与字符串的比较
    // 会退化成 NaN 比较、恒为 false，「晚于发版日」这条约束就会静默失效。
    const rel = await tx.execute<{ release_date: string }>(
      sql`select release_date from releases where id = ${release}`);
    const releaseRow = rel.rows[0];
    if (!releaseRow) throw new AppError('not_found', '找不到这个版本');
    if (dueAt.getTime() > new Date(releaseRow.release_date).getTime()) {
      throw new AppError('bad_dates', '承诺完成日不能晚于版本发版日');
    }

    // 日期按 ISO 写回，避免把解析出来的本地时区偏移带进 timestamptz。
    await moveTo(tx, requirementId, 'ready', sql`
      release_id = ${release},
      commit_test_at = ${testAt.toISOString()},
      commit_due_at = ${dueAt.toISOString()}`);

    // 事件里记用户填的那两个日期（'2026-12-01' 这种写法），报表要按天读，
    // 落库用的 ISO 串只在库里出现。
    await recordEvent(tx, {
      requirementId, actor, type: 'requirement.scheduled',
      payload: {
        from: row.state, to: 'ready',
        releaseId, commitTestAt, commitDueAt,
      },
    });

    return { state: 'ready' as const };
  });
}
