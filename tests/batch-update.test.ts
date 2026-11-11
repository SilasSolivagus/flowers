import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { batchUpdate } from '../src/core/requirements/batch.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { BRIEF } from './helpers/brief.js';

/**
 * 批量改（2026-11-11，H3）。
 *
 * 这一组钉三件事：**默认只预览**、**逐条报告**、**不绕权限**（别人的需求那条会 failed）。
 */
async function seed(count: number, owner = '吕品'): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const r = await createRequirement(db, owner, { ...BRIEF, title: `卡-${i}`, type: 'feature', requester: 'x' });
    ids.push(r.id);
  }
  return ids;
}

async function priorityOf(id: string): Promise<string | null> {
  const res = await db.execute<{ priority: string | null }>(sql`select priority from requirements where id = ${id}`);
  return res.rows[0]?.priority ?? null;
}

beforeEach(async () => { await resetDb(); await seedPeople(); });
afterAll(async () => { await pool.end(); });

describe('批量改', () => {
  it('默认 dryRun：给出每条会改成什么，一个字节都不写', async () => {
    const [a] = await seed(1);
    const result = await batchUpdate(db, '吕品', { ids: [a!], patch: { priority: 'p0' } });
    expect(result.dryRun).toBe(true);
    expect(result.items[0]!.changes[0]).toMatchObject({ field: '优先级', from: null, to: 'p0' });
    expect(await priorityOf(a!)).toBeNull();
  });

  it('真写：改了的那条 applied，没变化的 skipped', async () => {
    const [a, b] = await seed(2);
    await batchUpdate(db, '吕品', { ids: [a!], patch: { priority: 'p0' }, dryRun: false });
    const result = await batchUpdate(db, '吕品', {
      ids: [a!, b!], patch: { priority: 'p0' }, dryRun: false,
    });
    expect(result.summary).toEqual({ applied: 1, skipped: 1, failed: 0 });
    expect(await priorityOf(a!)).toBe('p0');
  });

  it('别人的需求逐条失败，不影响其它条', async () => {
    const [mine] = await seed(1, '吕品');
    const [other] = await seed(1, '王妍');
    const result = await batchUpdate(db, '吕品', {
      ids: [mine!, other!], patch: { priority: 'p1' }, dryRun: false,
    });
    expect(result.summary.applied).toBe(1);
    expect(result.summary.failed).toBe(1);
    expect(result.items.find((i) => i.id === other)?.error).toContain('只能改自己');
  });

  it('空 ids / 空 patch / 超过 50 条 → invalid', async () => {
    await expect(batchUpdate(db, '吕品', { ids: [], patch: { priority: 'p0' } }))
      .rejects.toMatchObject({ code: 'invalid' });
    await expect(batchUpdate(db, '吕品', { ids: ['x'], patch: {} }))
      .rejects.toMatchObject({ code: 'invalid' });
    await expect(batchUpdate(db, '吕品', { ids: Array.from({ length: 51 }, (_, i) => `id-${i}`), patch: { priority: 'p0' } }))
      .rejects.toMatchObject({ code: 'invalid' });
  });
});
