import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { calibrateState } from '../src/core/requirements/calibrate.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { BRIEF } from './helpers/brief.js';

/**
 * 状态校准（2026-11-11，C3）：超管把存量卡片摆到真实阶段，必须写原因。
 * 三条边界：只有超管、状态得合法、同状态不算校准。
 */
async function one(): Promise<string> {
  const r = await createRequirement(db, '吕品', { ...BRIEF, title: '存量卡', type: 'feature', requester: 'x' });
  return r.id;
}

beforeEach(async () => { await resetDb(); await seedPeople(); });
afterAll(async () => { await pool.end(); });

describe('状态校准', () => {
  it('超管可以把收集里的存量卡摆到待开发，并留一条事件', async () => {
    const id = await one();
    await calibrateState(db, '房超', { requirementId: id, to: 'ready', reason: '线下已做完设计' });
    const row = await db.execute<{ state: string }>(sql`select state from requirements where id = ${id}`);
    expect(row.rows[0]!.state).toBe('ready');
    const ev = await db.execute<{ payload: string }>(sql`
      select payload from events where requirement_id = ${id} and type = 'requirement.calibrated'`);
    expect(JSON.parse(ev.rows[0]!.payload)).toMatchObject({ from: 'inbox', to: 'ready' });
  });

  it('PM 不能校准（只有超管）', async () => {
    const id = await one();
    await expect(calibrateState(db, '吕品', { requirementId: id, to: 'ready', reason: 'x' }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('不写原因 / 目标状态不合法 / 原地不动 → 各自报错', async () => {
    const id = await one();
    await expect(calibrateState(db, '房超', { requirementId: id, to: 'ready', reason: ' ' }))
      .rejects.toMatchObject({ code: 'invalid' });
    await expect(calibrateState(db, '房超', { requirementId: id, to: 'doing', reason: 'x' }))
      .rejects.toMatchObject({ code: 'invalid' });
    await expect(calibrateState(db, '房超', { requirementId: id, to: 'inbox', reason: 'x' }))
      .rejects.toMatchObject({ code: 'invalid' });
  });
});
