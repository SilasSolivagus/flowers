import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { updateRequirement } from '../src/core/requirements/manage.js';
import { getRequirementDetail } from '../src/core/read/detail.js';
import { getBoard } from '../src/core/read/board.js';
import { attachArtifact } from '../src/core/uemaster/attach.js';
import {
  PLATFORMS, PLATFORM_UNSET, normalizePlatforms, platformLabel, platformsLabel,
} from '../src/core/requirements/platforms.js';
import { resetDb, seedPeople } from './helpers/db.js';

/**
 * 平台（P4-08）：多值、词表固定、参与指纹。
 *
 * 这一组钉四件事：
 * 1. **归一**（小写、去重、按词表顺序、丢掉词表外的键）——它是「勾选顺序不该改变
 *    『描述』」这件事的实现，也是指纹稳定的前提；
 * 2. **往返**（界面多选 → 服务层 → `text[]` → 抽屉那一行）；
 * 3. **指纹**（加一个平台 = 描述变了 = 老产物变旧；这是**正确**的，不是 bug）；
 * 4. **不上看板**（卡片只有两行，平台只在抽屉里）。
 */

let people: Awaited<ReturnType<typeof seedPeople>> = [];

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

async function make(title = 'PAN-6 分享页搜索'): Promise<string> {
  const created = await createRequirement(db, '吕品', {
    title, type: 'feature', requester: '王妍',
    context: '访问者在分享页里找文件',
    problem: '现在只能一层层翻目录',
    outcome: 'H5 能按目录层级定位',
    surfaces: 'H5 分享页 · App 分享页',
    edgeCases: '目录失效时不跳转',
    outOfScope: 'App 端这次不做',
  });
  return created.id;
}

async function stored(id: string): Promise<string[]> {
  const row = await db.execute<{ platforms: string[] }>(
    sql`select platforms from requirements where id = ${id}`);
  return row.rows[0]!.platforms;
}

describe('平台词表与归一', () => {
  it('词表就是生产数据里那十二个端，顺序固定（写入顺序 = 指纹顺序）', () => {
    expect(PLATFORMS.map((p) => p.key)).toEqual([
      'web', 'mobile', 'pc', 'mini', 'backend', 'admin',
      'manager', 'frontend', 'h5', 'open', 'harmony', 'tv',
    ]);
    expect(platformLabel('h5')).toBe('H5');
    expect(platformLabel('admin')).toBe('管理后台');
    expect(platformLabel('mobile')).toBe('移动端');
    // 认不出的键原样返回：读侧不丢东西。
    expect(platformLabel('wat')).toBe('wat');
  });

  it('空数组的界面写法是「未标注」', () => {
    expect(platformsLabel([])).toBe(PLATFORM_UNSET);
    expect(platformsLabel(['h5', 'mobile'])).toBe('H5 · 移动端');
  });

  it('归一：折小写、旧键折新键、去重、丢词表外、按词表排序', () => {
    expect(normalizePlatforms(['android', 'H5', 'h5', 'APP', '  pc ']))
      .toEqual(['mobile', 'pc', 'h5']);
    // 非数组一律当空：「一个平台」在库里也是长度 1 的数组。
    expect(normalizePlatforms(null)).toEqual([]);
    expect(normalizePlatforms('h5')).toEqual([]);
    expect(normalizePlatforms([1, null, 'h5'])).toEqual(['h5']);
  });

  it('旧词表：ios + android 折成同一个 mobile（映射之后去重）', () => {
    expect(normalizePlatforms(['ios', 'android'])).toEqual(['mobile']);
    expect(normalizePlatforms(['api'])).toEqual(['backend']);
    // 迁移与写入端共用同一张映射表：`pc / web / h5 / admin / mini` 原地不动。
    expect(normalizePlatforms(['pc', 'web', 'h5', 'admin', 'mini']))
      .toEqual(['web', 'pc', 'mini', 'admin', 'h5']);
  });
});

describe('写入与读取（往返）', () => {
  it('新建时带平台：落库是词表顺序的数组', async () => {
    const created = await createRequirement(db, '吕品', {
      title: 'PAN-6 分享页搜索', type: 'feature', requester: '王妍',
      platforms: ['android', 'h5'],
    });
    expect(await stored(created.id)).toEqual(['mobile', 'h5']);
  });

  it('新建时不带平台：落库是空数组（未标注），不是 null', async () => {
    const id = await make();
    expect(await stored(id)).toEqual([]);
    const row = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from requirements where id = ${id} and platforms is null`);
    expect(Number(row.rows[0]!.n)).toBe(0);
  });

  it('改描述时能加平台：算一次改动，事件里写「未标注 → H5 · Android」', async () => {
    const id = await make();
    const result = await updateRequirement(db, '吕品', {
      requirementId: id, platforms: ['h5', 'android'],
    });
    expect(result.changed).toEqual(['platforms']);
    expect(await stored(id)).toEqual(['mobile', 'h5']);

    const event = await db.execute<{ payload: string }>(sql`
      select payload from events where requirement_id = ${id} and type = 'requirement.updated'
       order by seq desc limit 1`);
    const payload = JSON.parse(event.rows[0]!.payload) as {
      fields: { field: string; label: string; from: string | null; to: string | null }[];
    };
    expect(payload.fields).toEqual([
      { field: 'platforms', label: '平台', from: '未标注', to: '移动端 · H5' },
    ]);
  });

  it('换成同一组平台、只是顺序不同：不算改动（没有事件）', async () => {
    const id = await make();
    await updateRequirement(db, '吕品', { requirementId: id, platforms: ['h5', 'android'] });
    const again = await updateRequirement(db, '吕品', {
      requirementId: id, platforms: ['android', 'h5', 'h5'],
    });
    expect(again.changed).toEqual([]);
  });

  it('词表外的键被丢掉，不会让这一格变成一个认不出的值', async () => {
    const id = await make();
    // `app` / `机顶盒` 不在词表里（`TV` 现在**在**词表里，键是 tv）。
    await updateRequirement(db, '吕品', { requirementId: id, platforms: ['h5', 'app', '机顶盒'] });
    expect(await stored(id)).toEqual(['h5']);
  });

  it('清空 = 未标注（传 [] 与传 null 都算「改成空」）', async () => {
    const id = await make();
    await updateRequirement(db, '吕品', { requirementId: id, platforms: ['h5'] });
    expect((await updateRequirement(db, '吕品', { requirementId: id, platforms: [] })).changed)
      .toEqual(['platforms']);
    expect(await stored(id)).toEqual([]);
    await updateRequirement(db, '吕品', { requirementId: id, platforms: ['pc'] });
    expect((await updateRequirement(db, '吕品', { requirementId: id, platforms: null })).changed)
      .toEqual(['platforms']);
    expect(await stored(id)).toEqual([]);
  });

  it('单个字符串也收（MCP 的 agent 常常只写一个）', async () => {
    const id = await make();
    await updateRequirement(db, '吕品', { requirementId: id, platforms: 'mini' });
    expect(await stored(id)).toEqual(['mini']);
  });

  it('不是数组也不是字符串：报中文错误，而不是悄悄忽略', async () => {
    const id = await make();
    await expect(updateRequirement(db, '吕品', {
      requirementId: id, platforms: { h5: true },
    })).rejects.toThrow(/必须是数组/);
  });
});

describe('读模型：抽屉里有一行，看板卡上没有', () => {
  it('抽屉的信息段给键与一行中文', async () => {
    const id = await make();
    await updateRequirement(db, '吕品', { requirementId: id, platforms: ['h5', 'android'] });
    const detail = await getRequirementDetail(id);
    expect(detail!.info.platforms).toEqual(['mobile', 'h5']);
    expect(detail!.info.platformsLabel).toBe('移动端 · H5');
  });

  it('未标注就是空数组 + 「未标注」', async () => {
    const id = await make();
    const detail = await getRequirementDetail(id);
    expect(detail!.info.platforms).toEqual([]);
    expect(detail!.info.platformsLabel).toBe('未标注');
  });

  it('看板卡**没有**平台这一格（两行放不下第三个标签，九列的板更放不下）', async () => {
    const id = await make('PAN-6 分享页搜索');
    await updateRequirement(db, '吕品', { requirementId: id, platforms: ['h5', 'mobile'] });
    const board = await getBoard('吕品');
    const card = board.flatMap((column) => column.cards).find((item) => item.id === id)!;
    expect(card).toBeDefined();
    expect(Object.keys(card)).not.toContain('platforms');
    expect(Object.keys(card)).not.toContain('platformsLabel');
  });
});

describe('指纹：加平台 → 老产物变旧（这是对的）', () => {
  it('先交一份材料、再补平台：那一行从 fresh 变成 stale', async () => {
    const id = await make();
    const before = (await getRequirementDetail(id))!;
    // 人直接 attach（不带指纹）→ 版本未知；这里改成「按当前描述生成」的写法：
    // 用生成入口同一个函数算一份，再落库，才能观察到 fresh → stale。
    const { fingerprintOfRow } = await import('../src/core/requirements/fingerprint.js');
    const row = await db.execute<Parameters<typeof fingerprintOfRow>[0]>(
      sql`select title, context, problem, outcome, surfaces, edge_cases, out_of_scope,
                 prd_url, platforms
            from requirements where id = ${id}`);
    const hash = fingerprintOfRow(row.rows[0]!);
    expect(before.refs.find((ref) => ref.stage === 'evaluate')!.freshness).toBe('unknown');

    await db.execute(sql`
      insert into uemaster_artifacts (requirement_id, stage, url, created_by, input_hash)
      values (${id}, 'evaluate', 'https://example.com/a.html', 'agent', ${hash})`);
    expect((await getRequirementDetail(id))!.refs.find((r) => r.stage === 'evaluate')!.freshness)
      .toBe('fresh');

    await updateRequirement(db, '吕品', { requirementId: id, platforms: ['h5'] });
    expect((await getRequirementDetail(id))!.refs.find((r) => r.stage === 'evaluate')!.freshness)
      .toBe('stale');
  });

  it('attachArtifact 不传指纹时是「版本未知」，不猜', async () => {
    const id = await make();
    await attachArtifact(db, '吕品', {
      requirementId: id, stage: 'evaluate', url: 'https://example.com/b.html',
    });
    const detail = await getRequirementDetail(id);
    expect(detail!.refs.find((r) => r.stage === 'evaluate')!.freshness).toBe('unknown');
  });
});
