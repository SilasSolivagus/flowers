import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { recordEvent } from '../events.js';
import { assertCan } from '../auth/guard.js';
import { parseRequirementId, requirePlainObject, asText } from '../validate.js';
import { parseDateOrThrow } from './schedule.js';
import { lockRequirement } from './lock.js';

/**
 * 改排期（2026-11-11，版本页「管理进度」与 MCP 共用）。
 *
 * ── 它解决的是什么
 *
 * `schedule` 只管**第一次**排期（待排期 → 待开发）。一旦排进去，版本页就只能看、
 * 不能动：提测日往后挪一天、把这条从 v1.4 挪到 v1.5、承诺完成日改一下，界面上没有
 * 任何入口，只能去库里改。于是「版本进度」是只读的报表，不是能维护的东西。
 *
 * ── 与 schedule 的分工
 *
 * - `schedule`：queue → ready，**状态迁移**，走状态机（`assertTransition`）。
 * - `reschedule`：**不动状态**，只改 `release_id / commit_test_at / commit_due_at`，
 *   允许的状态是已经在版本里的那三个：ready / dev / test。
 *
 * 为什么不复用 `moveTo` 走一次状态机：这里没有状态变化，而状态机里也没有
 * 「ready → ready」这条边。硬塞一条自环边会让「哪些边是真实流转」这张表变脏。
 *
 * ── 规则与 schedule 一致（不另立一套）
 *
 * 1. 日期先后：提测日 ≤ 承诺完成日；承诺完成日 ≤ 版本发版日。
 * 2. 要有正式 PRD：没有 PRD 的需求本来就不该在版本里（见 schedule 的规则 2）。
 * 3. 权限：`edit`（负责人 / 条线负责人 / 超管），与排期同一个判据。
 *
 * 每次改动写一条 `requirement.rescheduled`，payload 里带**改前改后**两套值：
 * 「这条为什么从 v1.4 挪到了 v1.5」在时间线上要能回答，否则版本日报的「延期」
 * 就变成一串没有来由的数字。
 */

const STATES_IN_RELEASE = ['ready', 'dev', 'test'] as const;

const MISSING = '要改排期，请把版本、提测日、承诺完成日都填上';

export async function reschedule(db: Db, actor: string, raw: unknown): Promise<{
  state: string;
  releaseId: string;
  commitTestAt: string;
  commitDueAt: string;
}> {
  const input = requirePlainObject(raw);
  const requirementId = parseRequirementId(input);

  const releaseId = asText(input.releaseId);
  const commitTestAt = asText(input.commitTestAt);
  const commitDueAt = asText(input.commitDueAt);
  if (!releaseId || !commitTestAt || !commitDueAt) {
    throw new AppError('missing_dates', MISSING);
  }

  const testAt = parseDateOrThrow(commitTestAt);
  const dueAt = parseDateOrThrow(commitDueAt);
  if (testAt.getTime() > dueAt.getTime()) {
    throw new AppError('bad_dates', '承诺完成日不能早于提测日');
  }

  return db.transaction(async (tx) => {
    const row = await lockRequirement(tx, requirementId);
    await assertCan(tx, actor, {
      ownerMemberId: row.owner_member_id, ownerLine: row.owner_line, state: row.state,
    }, 'edit');

    if (!(STATES_IN_RELEASE as readonly string[]).includes(row.state)) {
      // 明确说「什么状态能改」：从收集里改排期不是「改」，是第一次排期。
      throw new AppError(
        'illegal_transition',
        `只有${STATES_IN_RELEASE.map((s) => `「${s === 'ready' ? '待开发' : s === 'dev' ? '开发中' : '测试中'}」`).join('、')}`
          + `的需求能改排期；这条现在在「${row.state}」`,
      );
    }

    if (row.prd_url === null || row.prd_url.trim() === '') {
      throw new AppError('missing_prd', '没有正式 PRD 的需求不能排期，先补 PRD 链接');
    }

    const rel = await tx.execute<{ release_date: string }>(
      sql`select release_date from releases where id = ${releaseId}`);
    const releaseRow = rel.rows[0];
    if (!releaseRow) throw new AppError('not_found', '找不到这个版本');
    if (dueAt.getTime() > new Date(releaseRow.release_date).getTime()) {
      throw new AppError('bad_dates', '承诺完成日不能晚于版本发版日');
    }

    const before = await tx.execute<{
      release_id: string | null; commit_test_at: string | null; commit_due_at: string | null;
    }>(sql`select release_id, commit_test_at, commit_due_at
             from requirements where id = ${requirementId}`);

    await tx.execute(sql`
      update requirements
         set release_id = ${releaseId},
             commit_test_at = ${testAt.toISOString()},
             commit_due_at = ${dueAt.toISOString()}
       where id = ${requirementId}`);

    const was = before.rows[0];
    await recordEvent(tx, {
      requirementId,
      actor,
      type: 'requirement.rescheduled',
      payload: {
        from: row.state,
        to: row.state,
        before: {
          releaseId: was?.release_id ?? null,
          commitTestAt: was?.commit_test_at ?? null,
          commitDueAt: was?.commit_due_at ?? null,
        },
        after: { releaseId, commitTestAt, commitDueAt },
      },
    });

    return {
      state: row.state,
      releaseId,
      commitTestAt,
      commitDueAt,
    };
  });
}
