import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { assertTransition } from '../state-machine.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';
import { parseRequirementId, requirePlainObject } from '../validate.js';
import { lockRequirement, moveTo } from './lock.js';

const MISSING_DATES = '排期必须填版本、提测日和承诺完成日';
const BAD_DATE = '提测日和承诺完成日必须是有效日期';

/** 表单字段运行时可能是 undefined / null / 非字符串，先归一成去掉首尾空白的字符串。 */
function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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

  const testAt = parseDateOrThrow(commitTestAt);
  const dueAt = parseDateOrThrow(commitDueAt);
  if (testAt.getTime() > dueAt.getTime()) {
    throw new AppError('bad_dates', '承诺完成日不能早于提测日');
  }

  return db.transaction(async (tx) => {
    const row = await lockRequirement(tx, requirementId);

    // queue → ready 是唯一通向 ready 的迁移，所以只按 from/to 配对判断就够：
    // 没经过评审就排期（inbox / design / review）、或重复排期（已在 ready），
    // 都会在这里撞 illegal_transition。prd / type 两个标志只对 prd / type guard 有意义，
    // 而这条迁移的 guard 是 dates（日期已在事务之前校验完），给 true 只为满足签名。
    assertTransition(row.state, 'ready', { hasPrd: true, hasType: true });

    // releases.release_date 是 timestamptz，经 pg 的文本协议回来是**字符串**
    // （'2026-12-04 00:00:00+00'），不是 Date。必须先 new Date(...) 再比：
    // `new Date('2026-12-05') > '2026-12-04 00:00:00+00'` 这种 Date 与字符串的比较
    // 会退化成 NaN 比较、恒为 false，「晚于发版日」这条约束就会静默失效。
    const rel = await tx.execute<{ release_date: string }>(
      sql`select release_date from releases where id = ${releaseId}`);
    const release = rel.rows[0];
    if (!release) throw new AppError('not_found', '找不到这个版本');
    if (dueAt.getTime() > new Date(release.release_date).getTime()) {
      throw new AppError('bad_dates', '承诺完成日不能晚于版本发版日');
    }

    // 日期按 ISO 写回，避免把解析出来的本地时区偏移带进 timestamptz。
    await moveTo(tx, requirementId, 'ready', sql`
      release_id = ${releaseId},
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
