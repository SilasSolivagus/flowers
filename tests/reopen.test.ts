import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { reopenRequirement } from '../src/core/requirements/reopen.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { BRIEF } from './helpers/brief.js';

/**
 * 退回待开发（2026-11-11，C1）：dev → ready，原因必填，写一条事件。
 * 规则边界：只有开发中能退；别人不能替你退。
 */
async function inDev(owner = '吕品'): Promise<string> {
  const r = await createRequirement(db, owner, { ...BRIEF, title: 'S3', type: 'feature', requester: 'x' });
  await db.execute(sql`update requirements set state = 'dev', state_entered_at = now() where id = ${r.id}`);
  return r.id;
}

beforeEach(async () => { await resetDb(); await seedPeople(); });
afterAll(async () => { await pool.end(); });

describe('退回待开发', () => {
  it('开发中 → 待开发，写 requirement.reopened（带原因）', async () => {
    const id = await inDev();
    await reopenRequirement(db, '吕品', { requirementId: id, reason: '方案改了' });
    const row = await db.execute<{ state: string }>(sql`select state from requirements where id = ${id}`);
    expect(row.rows[0]!.state).toBe('ready');
    const events = await db.execute<{ payload: string }>(sql`
      select payload from events where requirement_id = ${id} and type = 'requirement.reopened'`);
    expect(JSON.parse(events.rows[0]!.payload).reason).toBe('方案改了');
  });

  it('不写原因 → invalid', async () => {
    const id = await inDev();
    await expect(reopenRequirement(db, '吕品', { requirementId: id, reason: '  ' }))
      .rejects.toMatchObject({ code: 'invalid' });
  });

  it('别人不能退你的需求 → forbidden', async () => {
    const id = await inDev('吕品');
    await expect(reopenRequirement(db, '王妍', { requirementId: id, reason: 'x' }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('不在开发中 → illegal_transition', async () => {
    const r = await createRequirement(db, '吕品', { ...BRIEF, title: 'inbox', type: 'feature', requester: 'x' });
    await expect(reopenRequirement(db, '吕品', { requirementId: r.id, reason: 'x' }))
      .rejects.toMatchObject({ code: 'illegal_transition' });
  });
});
