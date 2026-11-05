// @ts-nocheck — forward reference: src/core/requirements/* lands in tasks 5-7.
// Remove this line (and re-run typecheck) once those modules exist.
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
