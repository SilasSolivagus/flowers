import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import { uploadArtifact } from '../src/core/uemaster/upload.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { artifactFile } from '../src/core/uemaster/store.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { BRIEF } from './helpers/brief.js';
import { cleanArtifacts } from './helpers/files.js';

/**
 * 上传产物（2026-11-11）：本地生成好的 HTML 直接交回来。
 *
 * 钉四件事：落盘路径带版本号、状态不变、文件真的在、形状不对时拒绝。
 */
const HTML = '<!doctype html><html><body><div>材料</div></body></html>';

async function seed(): Promise<{ id: string; number: number }> {
  const r = await createRequirement(db, '吕品', { ...BRIEF, title: '上传测试', type: 'feature', requester: 'x' });
  return { id: r.id, number: r.number };
}

beforeEach(async () => { await resetDb(); await seedPeople(); await cleanArtifacts(); });
afterAll(async () => { await cleanArtifacts(); await pool.end(); });

describe('上传产物', () => {
  it('写进 PAN-n 目录、带版本号、attach 之后状态不变', async () => {
    const { id, number } = await seed();
    const got = await uploadArtifact(db, '吕品', {
      requirementId: id, stage: 'evaluate', fileName: 'evaluate.html',
      bytes: new TextEncoder().encode(HTML),
    });
    expect(got.url).toMatch(new RegExp(`^/uemaster/PAN-${number}/evaluate-v\\d+\\.html$`));
    expect(existsSync(artifactFile(got.url))).toBe(true);
    const state = (await db.execute<{ state: string }>(sql`select state from requirements where id = ${id}`)).rows[0]!.state;
    expect(state).toBe('inbox');
  });

  it('第二次上传 → 版本号 +1，历史不覆盖', async () => {
    const { id } = await seed();
    const a = await uploadArtifact(db, '吕品', { requirementId: id, stage: 'evaluate', fileName: 'a.html', bytes: new TextEncoder().encode(HTML) });
    const b = await uploadArtifact(db, '吕品', { requirementId: id, stage: 'evaluate', fileName: 'b.html', bytes: new TextEncoder().encode(HTML) });
    expect(a.url).not.toBe(b.url);
    expect(existsSync(artifactFile(a.url))).toBe(true);
  });

  it('不是 html / 太大 / 空文件 → 各自报错', async () => {
    const { id } = await seed();
    await expect(uploadArtifact(db, '吕品', { requirementId: id, stage: 'evaluate', fileName: 'x.png', bytes: new Uint8Array([1]) }))
      .rejects.toMatchObject({ code: 'invalid_file' });
    await expect(uploadArtifact(db, '吕品', { requirementId: id, stage: 'evaluate', fileName: 'x.html', bytes: new TextEncoder().encode('hello') }))
      .rejects.toMatchObject({ code: 'invalid_file' });
    await expect(uploadArtifact(db, '吕品', { requirementId: id, stage: 'nope', fileName: 'x.html', bytes: new TextEncoder().encode(HTML) }))
      .rejects.toMatchObject({ code: 'invalid_stage' });
  });
});
