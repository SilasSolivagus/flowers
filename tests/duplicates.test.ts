import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { looksSimilar, normalizeTitle } from '../src/core/requirements/duplicates.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { BRIEF } from './helpers/brief.js';

/**
 * 查重（2026-11-11）：**提示**，不是门。
 * 建完返回「像它的那几条」，人自己决定搁置新的还是改旧的。
 */
describe('相似判定', () => {
  it('归一：去括号注记与标点', () => {
    expect(normalizeTitle('S3 协议支持（上迭代遗留）')).toBe('s3协议支持');
  });
  it('完全相同才算（短标题不做包含匹配）', () => {
    expect(looksSimilar('S3 协议支持', 'S3 协议支持（上迭代遗留）')).toBe(true);
    expect(looksSimilar('AI 搜索', 'AI 搜索做分享页入口改造')).toBe(false);
    expect(looksSimilar('直链升级二期-直链多域名接入与生命周期管理', '直链升级二期')).toBe(true);
  });
});

beforeEach(async () => {
  process.env.FLOWERS_DUPLICATE_CHECK = 'on';
  await resetDb(); await seedPeople();
});
afterEach(() => { process.env.FLOWERS_DUPLICATE_CHECK = 'off'; });
afterAll(async () => { await pool.end(); });

describe('建需求：重复就不让建', () => {
  it('有相似需求 → duplicate_suspected，并点名那几条', async () => {
    await createRequirement(db, '吕品', { ...BRIEF, title: 'S3 协议支持', type: 'feature', requester: 'x' });
    await expect(createRequirement(db, '吕品', {
      ...BRIEF, title: 'S3 协议支持（上迭代遗留）', type: 'feature', requester: 'x',
    })).rejects.toMatchObject({ code: 'duplicate_suspected' });
  });

  it('勾了「确认不是重复」→ 照建', async () => {
    await createRequirement(db, '吕品', { ...BRIEF, title: 'S3 协议支持', type: 'feature', requester: 'x' });
    const created = await createRequirement(db, '吕品', {
      ...BRIEF, title: 'S3 协议支持（上迭代遗留）', type: 'feature', requester: 'x',
      allowDuplicate: true,
    });
    expect(created.state).toBe('inbox');
  });

  it('没有相似的 → 直接建', async () => {
    const created = await createRequirement(db, '吕品', {
      ...BRIEF, title: '完全不同的需求名', type: 'feature', requester: 'x',
    });
    expect(created.number).toBeGreaterThan(0);
  });
});
