import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { createRequirement } from '../../src/core/requirements/create.js';
import { evaluate } from '../../src/core/requirements/evaluate.js';
import { submitReview } from '../../src/core/requirements/submit-review.js';
import { reviewPass } from '../../src/core/requirements/review.js';
import { schedule } from '../../src/core/requirements/schedule.js';

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
