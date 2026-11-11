import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { reviewPass } from '../src/core/requirements/review.js';
import { schedule } from '../src/core/requirements/schedule.js';
import { reschedule } from '../src/core/requirements/reschedule.js';
import { createRelease } from '../src/core/releases/manage.js';
import { AppError } from '../src/core/errors.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { BRIEF } from './helpers/brief.js';

/**
 * 改排期（2026-11-11）：版本页「管理进度」那条路。
 *
 * 它和 `schedule` 的分工是这一组用例的主题：schedule 是**状态迁移**（queue → ready），
 * reschedule **不动状态**，只改版本与两个承诺日；改之前/改之后都要留在时间线上。
 */

const OWNER = '吕品';
const REVIEWER = '吕正豪';

async function makeRelease(name: string, start: string, end: string): Promise<string> {
  const r = await createRelease(db, '房超', {
    name, windowStart: start, releaseDate: end, goal: null, note: null,
  });
  return (r as { id: string }).id;
}

async function scheduled(): Promise<{ id: string; releaseId: string }> {
  const releaseId = await makeRelease('R-2026-12', '2026-12-01', '2026-12-20');
  const created = await createRequirement(db, OWNER, {
    ...BRIEF, title: 'S3 协议支持', type: 'feature', requester: '孙建宏',
    prdUrl: 'https://doc.example.com/prd',
  });
  await evaluate(db, OWNER, { requirementId: created.id });
  await submitReview(db, OWNER, { requirementId: created.id, prdUrl: 'https://doc.example.com/prd' });
  await reviewPass(db, REVIEWER, { requirementId: created.id });
  await schedule(db, OWNER, {
    requirementId: created.id, releaseId,
    commitTestAt: '2026-12-05', commitDueAt: '2026-12-10',
  });
  return { id: created.id, releaseId };
}

async function rowOf(id: string) {
  const res = await db.execute<{
    state: string; release_id: string | null; commit_test_at: string | null; commit_due_at: string | null;
  }>(sql`select state, release_id, commit_test_at, commit_due_at from requirements where id = ${id}`);
  return res.rows[0]!;
}

beforeEach(async () => {
  await resetDb();
  await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

describe('改排期不动状态', () => {
  it('已在版本里的需求：改日期 + 换版本，状态仍是待开发，并留一条 rescheduled', async () => {
    const { id, releaseId } = await scheduled();
    const other = await makeRelease('R-2027-01', '2027-01-01', '2027-01-20');

    await reschedule(db, OWNER, {
      requirementId: id, releaseId: other,
      commitTestAt: '2027-01-05', commitDueAt: '2027-01-12',
    });

    const row = await rowOf(id);
    expect(row.state).toBe('ready');
    expect(row.release_id).toBe(other);
    expect(row.commit_test_at?.slice(0, 10)).toBe('2027-01-05');

    const events = await db.execute<{ payload: string }>(sql`
      select payload from events where requirement_id = ${id} and type = 'requirement.rescheduled'`);
    expect(events.rows).toHaveLength(1);
    const payload = JSON.parse(events.rows[0]!.payload);
    expect(payload.before.releaseId).toBe(releaseId);
    expect(payload.after.releaseId).toBe(other);
  });

  it('承诺完成日早于提测日 → bad_dates，什么都不改', async () => {
    const { id, releaseId } = await scheduled();
    const before = await rowOf(id);
    await expect(reschedule(db, OWNER, {
      requirementId: id, releaseId, commitTestAt: '2026-12-10', commitDueAt: '2026-12-05',
    })).rejects.toMatchObject({ code: 'bad_dates' });
    expect(await rowOf(id)).toEqual(before);
  });

  it('承诺完成日晚于版本发版日 → bad_dates', async () => {
    const { id, releaseId } = await scheduled();
    await expect(reschedule(db, OWNER, {
      requirementId: id, releaseId, commitTestAt: '2026-12-05', commitDueAt: '2026-12-25',
    })).rejects.toBeInstanceOf(AppError);
  });

  it('要改排期，三个字段一个都不能少', async () => {
    const { id, releaseId } = await scheduled();
    await expect(reschedule(db, OWNER, { requirementId: id, releaseId }))
      .rejects.toMatchObject({ code: 'missing_dates' });
  });

  it('还没进版本（待设计）的需求改不了排期：那不是「改」，是第一次排期', async () => {
    const created = await createRequirement(db, OWNER, {
      ...BRIEF, title: '还没排期', type: 'feature', requester: '孙建宏',
      prdUrl: 'https://doc.example.com/prd',
    });
    const releaseId = await makeRelease('R-2026-12', '2026-12-01', '2026-12-20');
    await expect(reschedule(db, OWNER, {
      requirementId: created.id, releaseId, commitTestAt: '2026-12-05', commitDueAt: '2026-12-10',
    })).rejects.toMatchObject({ code: 'illegal_transition' });
  });
});
