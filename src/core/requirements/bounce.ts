import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { assertTrigger } from '../state-machine.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';
import { asText, parseRequirementId, requirePlainObject } from '../validate.js';
import { shanghaiDayOf } from '../clock/tick.js';
import { assertCan } from '../auth/guard.js';
import { lockRequirement, moveTo } from './lock.js';

const MISSING_NEW_DUE = '打回必须重填承诺完成日';
const MISSING_REASON = '打回必须写原因';
const BAD_NEW_DUE = '打回必须填有效的承诺完成日';
const BEFORE_TODAY = '承诺完成日不能早于今天';

/**
 * 新承诺完成日按 UTC 零点解析（与 schedule 的两个日期、releases 的写入方式一致）。
 * 解析不出来就报 bad_new_due：否则 Invalid Date 会一路走到 `toISOString()`，
 * 抛的是 RangeError，控制器按 `e.code` 分支时只能当未知错误。
 */
function parseNewDueOrThrow(text: string): Date {
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new AppError('bad_new_due', BAD_NEW_DUE);
  return date;
}

/**
 * R23：新承诺完成日不能落在「今天」之前（Asia/Shanghai 的日历日）。
 *
 * 按「天」比较，不按时刻：'2026-11-06' 是日历日，按时刻比会让「今天」取决于现在几点。
 * 折算天数复用时钟模块的 shanghaiDayOf：实现只有一处，调用方有两处（这里与 tick），
 * 所以打回与时钟对「今天」的理解不可能分叉（同一个 instant ⇒ 同一个整数天）。
 *
 * 今天本身合法：承诺「今天就上线」是真实的（虽然乐观）。
 *
 * 为什么这道闸必须在：commit_test_at 已经过去的需求，如果 due 也是过去时，下一次 tick
 * 会连推两步 dev → test → live，全程没有一个人工动作——日期打错一年（'2020-12-10'
 * 本该是 '2026-12-10'）就把「没做出来」直接写成「已上线」。
 */
function assertNotBeforeToday(dueAt: Date, now: Date): void {
  const dueDay = shanghaiDayOf(dueAt.toISOString());
  const today = shanghaiDayOf(now.toISOString());
  // today 为 null 只可能来自系统时钟本身非法；那时比较会静默放行，宁可拦。
  if (dueDay === null || today === null || dueDay < today) {
    throw new AppError('bad_new_due', BEFORE_TODAY);
  }
}

/**
 * 打回：test → dev，并且必须重填承诺完成日。
 *
 * 「必须填新完成日」不是状态机的 guard：状态机只执行 prd / type 两条门（见
 * state-machine.ts 的 Guard），日期类门由拥有这些列的服务自己保证——这里就是
 * 唯一执行它的地方，而且它还要和「今天」比较（R23），状态机拿不到注入的时钟。
 *
 * 校验顺序（全部在开事务之前）：对象 → 新完成日 → 原因 → 需求 ID → 日期可解析
 * → 日期不早于今天（R23）。
 * 两个字段都缺时先报 missing_new_due：日期是这条迁移的成立条件，原因只是记录。
 */
export async function bounce(
  db: Db, actor: string, raw: unknown,
  // R24：now 只为可测——这道底线要和「今天」比，而用例里的日期是固定的 2026-12 叙事，
  // 不注入时钟就会在 2026-12-10 之后逐条腐烂。生产调用方不传，默认取真实时钟；
  // 形状与 tick(db, now) 一致，两处对「今天」的口径因此可以直接对齐着测。
  now: Date = new Date(),
) {
  // 入参先挡住：非对象会抛 TypeError，非 uuid 会让 PG 抛 22P02，两者都不是 AppError。
  const input = requirePlainObject(raw);

  const newCommitDueAt = asText(input.newCommitDueAt);
  if (!newCommitDueAt) throw new AppError('missing_new_due', MISSING_NEW_DUE);

  const reason = asText(input.reason);
  if (!reason) throw new AppError('missing_reason', MISSING_REASON);

  const requirementId = parseRequirementId(input);
  const dueAt = parseNewDueOrThrow(newCommitDueAt);
  assertNotBeforeToday(dueAt, now);

  return db.transaction(async (tx) => {
    const row = await lockRequirement(tx, requirementId);
    // 权限先于状态门（见 evaluate.ts 的同一段注释）。
    await assertCan(tx, actor, {
      type: row.type ?? '', ownerMemberId: row.owner_member_id, state: row.state,
    }, 'edit');
    // 只按配对判断不够：ready → dev 也是合法配对（那是时钟的路子），光看配对
    // 会让「打回」替时钟推掉第一步、把 window_start 那段窗口静默跳过。
    assertTrigger(row.state, 'dev', 'bounce');

    // 只换承诺完成日：commit_test_at 不动（R17 —— 打回后的需求仍处在测试窗内，
    // 下一次 tick 会把它推回 test 是刻意的行为）。
    await moveTo(tx, requirementId, 'dev', sql`
      commit_due_at = ${dueAt.toISOString()}`);

    // 事件里记用户填的那天（'2026-12-10' 这种写法）：报表按天读，ISO 串只在库里出现。
    await recordEvent(tx, {
      requirementId, actor, type: 'requirement.bounced',
      payload: { from: row.state, to: 'dev', reason, newCommitDueAt },
    });

    return { state: 'dev' as const };
  });
}
