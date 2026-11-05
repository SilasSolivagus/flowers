// @ts-nocheck — forward reference: src/core/requirements/* lands in tasks 5-7.
// Remove this line (and re-run typecheck) once those modules exist.
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { createRequirement } from '../../src/core/requirements/create.js';
import { evaluate } from '../../src/core/requirements/evaluate.js';
import { submitReview } from '../../src/core/requirements/submit-review.js';
import { reviewPass } from '../../src/core/requirements/review.js';

// schedule.ts 是 Task 7 的产物。这里不能静态 import：静态 import 在模块加载期就解析，
// Task 6 的用例只要 import 了本文件，整片就会因为找不到 schedule.js 而挂掉。
// makeReadyAt 里用动态 import，只有真正造 ready 数据时才需要它。

export async function makeRelease(name: string, windowStart: string, releaseDate: string) {
  const r = await db.execute<{ id: string }>(sql`
    insert into releases (name, window_start, release_date)
    values (${name}, ${windowStart}, ${releaseDate}) returning id`);
  return r.rows[0]!.id;
}

export async function makeQueued() {
  const r = await createRequirement(db, '吕品', { title: 'q', type: 'feature', requester: 'b' });
  await evaluate(db, '吕品', { requirementId: r.id });
  await submitReview(db, '吕品', { requirementId: r.id, prdUrl: 'https://x' });
  await reviewPass(db, '吕正豪', { requirementId: r.id });
  return r;
}

/** 造一条已排期的需求；返回 id */
export async function makeReadyAt(windowStart: string, commitTestAt: string, commitDueAt: string) {
  const { schedule } = await import('../../src/core/requirements/schedule.js');
  const releaseId = await makeRelease(`R-${windowStart}`, windowStart, commitDueAt);
  const r = await makeQueued();
  await schedule(db, '吕品', { requirementId: r.id, releaseId, commitTestAt, commitDueAt });
  return { id: r.id, releaseId };
}

/**
 * 当前 handed 派单上的评审人姓名，没有就返回 null。
 *
 * 只认 verdict='handed'：passed / rejected 是已收口的派单，不能再拿来回答
 * 「这条需求现在归谁看」。同一条需求同时只有一条 handed 派单（由状态机 +
 * assignReviewer 的 where not exists 保证，测试里也钉了条数）。
 */
export async function reviewerOf(requirementId: string): Promise<string | null> {
  const r = await db.execute<{ name: string }>(sql`
    select m.name
      from review_assignments ra
      join members m on m.id = ra.reviewer_member_id
     where ra.requirement_id = ${requirementId} and ra.verdict = 'handed'
     limit 1`);
  return r.rows[0]?.name ?? null;
}
