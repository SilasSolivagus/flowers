import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { updateRequirement } from '../src/core/requirements/manage.js';
import { getRequirementDetail } from '../src/core/read/detail.js';
import { getBoard } from '../src/core/read/board.js';
import { fingerprintOfRow } from '../src/core/requirements/fingerprint.js';
import {
  PRIORITIES, PRIORITY_UNSET, normalizePriority, priorityLabel,
} from '../src/core/requirements/priority.js';
import { resetDb, seedPeople } from './helpers/db.js';

/**
 * 优先级（P4-09）：单值、可空、参与指纹。
 *
 * 钉四件事：
 * 1. **词表**：`p0|p1|p2|p3|green` ↔ P0/P1/P2/P3/绿色通道（生产数据里 800/803 有值）；
 * 2. **往返**：新建 / 改描述 → 落库 → 抽屉那一行；
 * 3. **空值**：null 是合法状态（3 条线上需求没有优先级），不是「未填的必填项」；
 * 4. **指纹**：优先级参与「这份材料是照着什么生成的」，改它 → 老产物变旧。
 */

let people: Awaited<ReturnType<typeof seedPeople>> = [];

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

async function stored(id: string): Promise<string | null> {
  const row = await db.execute<{ priority: string | null }>(
    sql`select priority from requirements where id = ${id}`);
  return row.rows[0]!.priority;
}

describe('词表', () => {
  it('五个取值，顺序即严重程度；标签是 P0..P3 / 绿色通道', () => {
    expect(PRIORITIES.map((p) => p.key)).toEqual(['p0', 'p1', 'p2', 'p3', 'green']);
    expect(PRIORITIES.map((p) => p.label)).toEqual(['P0', 'P1', 'P2', 'P3', '绿色通道']);
    expect(priorityLabel('green')).toBe('绿色通道');
    expect(priorityLabel(null)).toBe(PRIORITY_UNSET);
    // 认不出的历史值原样返回（读侧不编造）。
    expect(priorityLabel('p9')).toBe('p9');
  });

  it('归一：大小写/空白、空值、认不出的值', () => {
    expect(normalizePriority(' P1 ')).toBe('p1');
    expect(normalizePriority('GREEN')).toBe('green');
    expect(normalizePriority('')).toBeNull();
    expect(normalizePriority(null)).toBeNull();
    expect(normalizePriority('p9')).toBeNull();
    expect(normalizePriority(3)).toBeNull();
  });
});

describe('写入与读取（往返）', () => {
  it('新建时带优先级：落库就是那个键，抽屉给键与中文', async () => {
    const created = await createRequirement(db, '吕品', {
      title: 'P0 的事', type: 'feature', requester: '王妍', priority: 'green',
    });
    expect(await stored(created.id)).toBe('green');
    const detail = await getRequirementDetail(created.id);
    expect(detail!.info.priority).toBe('green');
    expect(detail!.info.priorityLabel).toBe('绿色通道');
  });

  it('新建时不带优先级：落库是 null（未定），不是空串', async () => {
    const created = await createRequirement(db, '吕品', {
      title: '还没定级', type: 'feature', requester: '王妍',
    });
    expect(await stored(created.id)).toBeNull();
    const detail = await getRequirementDetail(created.id);
    expect(detail!.info.priority).toBeNull();
    expect(detail!.info.priorityLabel).toBe('未定');
  });

  it('改描述：p2 → p0 算一次改动，事件里写「P2 → P0」', async () => {
    const created = await createRequirement(db, '吕品', {
      title: '改优先级', type: 'feature', requester: '王妍', priority: 'p2',
    });
    const result = await updateRequirement(db, '吕品', {
      requirementId: created.id, priority: 'p0',
    });
    expect(result.changed).toEqual(['priority']);
    expect(await stored(created.id)).toBe('p0');

    const event = await db.execute<{ payload: string }>(sql`
      select payload from events where requirement_id = ${created.id}
        and type = 'requirement.updated' order by seq desc limit 1`);
    const payload = JSON.parse(event.rows[0]!.payload) as {
      fields: { field: string; label: string; from: string | null; to: string | null }[];
    };
    expect(payload.fields).toEqual([
      { field: 'priority', label: '优先级', from: 'P2', to: 'P0' },
    ]);
  });

  it('改成同一个值：不算改动（没有事件）', async () => {
    const created = await createRequirement(db, '吕品', {
      title: '同值', type: 'feature', requester: '王妍', priority: 'p1',
    });
    const again = await updateRequirement(db, '吕品', {
      requirementId: created.id, priority: 'P1',
    });
    expect(again.changed).toEqual([]);
  });

  it('清空 = 未定（传 null / 空串都算「改成空」）', async () => {
    const created = await createRequirement(db, '吕品', {
      title: '清空', type: 'feature', requester: '王妍', priority: 'p3',
    });
    expect((await updateRequirement(db, '吕品', {
      requirementId: created.id, priority: null,
    })).changed).toEqual(['priority']);
    expect(await stored(created.id)).toBeNull();

    await updateRequirement(db, '吕品', { requirementId: created.id, priority: 'p3' });
    expect((await updateRequirement(db, '吕品', {
      requirementId: created.id, priority: '',
    })).changed).toEqual(['priority']);
    expect(await stored(created.id)).toBeNull();
  });

  it('认不出的值报中文错误，而不是悄悄变成「未定」', async () => {
    const created = await createRequirement(db, '吕品', {
      title: '写错', type: 'feature', requester: '王妍',
    });
    await expect(updateRequirement(db, '吕品', {
      requirementId: created.id, priority: 'p9',
    })).rejects.toThrow(/优先级只能是 P0 \/ P1 \/ P2 \/ P3 \/ 绿色通道/);
    // 新建那条路同样不认。
    await expect(createRequirement(db, '吕品', {
      title: '写错 2', type: 'feature', requester: '王妍', priority: '急',
    })).rejects.toThrow(/优先级/);
  });
});

describe('指纹：优先级参与「材料是照着什么生成的」', () => {
  it('改优先级 → 存下来的指纹不再等于当前描述', async () => {
    const created = await createRequirement(db, '吕品', {
      title: '指纹', type: 'feature', requester: '王妍', priority: 'p2',
    });
    const row = await db.execute<Parameters<typeof fingerprintOfRow>[0]>(sql`
      select title, context, problem, outcome, surfaces, edge_cases, out_of_scope,
             prd_url, platforms, priority
        from requirements where id = ${created.id}`);
    const before = fingerprintOfRow(row.rows[0]!);

    await updateRequirement(db, '吕品', { requirementId: created.id, priority: 'p1' });
    const after = fingerprintOfRow((await db.execute<Parameters<typeof fingerprintOfRow>[0]>(sql`
      select title, context, problem, outcome, surfaces, edge_cases, out_of_scope,
             prd_url, platforms, priority
        from requirements where id = ${created.id}`)).rows[0]!);
    expect(after).not.toBe(before);
  });

  it('null 与「没传」同值（打开表单什么都不改再保存，产物不会假变旧）', async () => {
    const created = await createRequirement(db, '吕品', {
      title: '空优先级', type: 'feature', requester: '王妍',
    });
    const before = fingerprintOfRow((await db.execute<Parameters<typeof fingerprintOfRow>[0]>(sql`
      select title, context, problem, outcome, surfaces, edge_cases, out_of_scope,
             prd_url, platforms, priority
        from requirements where id = ${created.id}`)).rows[0]!);
    await updateRequirement(db, '吕品', { requirementId: created.id, priority: null });
    const after = fingerprintOfRow((await db.execute<Parameters<typeof fingerprintOfRow>[0]>(sql`
      select title, context, problem, outcome, surfaces, edge_cases, out_of_scope,
             prd_url, platforms, priority
        from requirements where id = ${created.id}`)).rows[0]!);
    expect(after).toBe(before);
  });
});

describe('看板', () => {
  it('卡片上没有优先级（与平台同一条口径：两行放不下第三个标签）', async () => {
    const created = await createRequirement(db, '吕品', {
      title: '看板卡', type: 'feature', requester: '王妍', priority: 'p0',
    });
    const board = await getBoard('吕品');
    const card = board.flatMap((column) => column.cards).find((item) => item.id === created.id)!;
    expect(Object.keys(card)).not.toContain('priority');
  });
});
