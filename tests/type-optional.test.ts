import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { getRequirementDetail } from '../src/core/read/detail.js';
import { requirementFingerprint, fingerprintOfRow } from '../src/core/requirements/fingerprint.js';
import { TRANSITIONS } from '../src/core/state-machine.js';
import { TYPES, TYPE_UNSET, typeLabel, typeSuffix } from '../src/core/requirements/type.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { BRIEF } from './helpers/brief.js';

/**
 * Ruling 1（2026-11-08）：`requirements.type` 可空，立项不再要求类型。
 *
 * 这一组钉四件事：
 * 1. **立项放行**：没有类型的需求真的能 `收集 → 待设计`。这条用例就是那个 mutation
 *    的锚点——把 `guard: 'type'` 加回 `TRANSITIONS`、或把 `hasType` 加回
 *    `evaluateInTx` 的 ctx，它会立刻变红（见报告里的 mutation 表）。
 * 2. **既有值不受影响**：`commercial` / `feature` 照旧读写，标签照旧。
 * 3. **指纹不变**：`type` 不参与指纹（它不是「描述」）。所以把这一列放宽成可空
 *    不会让任何历史 `input_hash` 失效——「打开表单、什么都不改、保存」仍然不会把
 *    产物打成「需求已更新」。
 * 4. **界面不编值**：空值时抽屉写「未指定」，抬头那段（`· 功能类`）整段不渲染。
 */

let people: Awaited<ReturnType<typeof seedPeople>> = [];

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

async function make(extra: Record<string, unknown> = {}): Promise<string> {
  const created = await createRequirement(db, '吕品', { ...BRIEF,
    title: '分享页搜索', requester: '王妍', ...extra,
  });
  return created.id;
}

describe('Ruling 1：类型可空', () => {
  it('没有类型也能立项：inbox → design（mutation：加回 type 门就变红）', async () => {
    // 建的时候**根本不传** type——这正是「录入不该被类型卡住」的形状。
    const id = await make();
    const stored = await db.execute<{ type: string | null; state: string }>(
      sql`select type, state from requirements where id = ${id}`);
    expect(stored.rows[0]).toEqual({ type: null, state: 'inbox' });

    await evaluate(db, '吕品', { requirementId: id });

    const after = await db.execute<{ state: string }>(
      sql`select state from requirements where id = ${id}`);
    expect(after.rows[0]!.state).toBe('design');
  });

  /**
   * Ruling 2（2026-11-10）之后这条边上**有**门了，但不是 type：是 `brief`（核心三问）。
   * 这条断言钉住 Ruling 1 本身没被推翻——`type` 仍然不是门的一种；而「六问不齐不能
   * 立项」是另一条规则（`tests/brief-guard.test.ts` 判它）。
   */
  it('转移表里 inbox → design 那条边没有 type 门（现在是 brief）', () => {
    const edge = TRANSITIONS.find((t) => t.from === 'inbox' && t.to === 'design')!;
    expect(edge.guard).not.toBe('type');
    expect(edge.guard).toBe('brief');
    expect(edge.trigger).toBe('evaluate');
  });

  it('显式空串（表单里那个「未指定」）落成 null，不是空串', async () => {
    const id = await make({ type: '   ' });
    const stored = await db.execute<{ type: string | null }>(
      sql`select type from requirements where id = ${id}`);
    expect(stored.rows[0]!.type).toBeNull();
  });

  it('有类型的需求照旧：存的就是键，标签照旧', async () => {
    const feature = await make({ type: 'feature' });
    const commercial = await make({ type: 'commercial' });

    const detailFeature = (await getRequirementDetail(feature))!;
    const detailCommercial = (await getRequirementDetail(commercial))!;
    expect(detailFeature.info.type).toBe('feature');
    expect(detailFeature.info.typeLabel).toBe('功能');
    expect(detailFeature.info.typeSuffix).toBe('功能类');
    expect(detailCommercial.info.typeLabel).toBe('商业');
  });

  it('认不出的类型仍然报错（单选不该被静默丢掉）', async () => {
    await expect(createRequirement(db, '吕品', { ...BRIEF,
      title: 'x', type: 'other', requester: 'y',
    })).rejects.toMatchObject({
      code: 'invalid', message: '类型只能是 commercial / feature（或留空 = 未指定）',
    });
  });

  it('type 不参与指纹：补上或清掉类型，指纹一个字都不变', async () => {
    // 只留场景那一格：这条用例比的是「指纹认得哪十格」，不是六问齐不齐。
    const id = await make({ context: '访问者在分享页里找文件', problem: null, outcome: null });
    const row = await db.execute<{
      title: string; context: string | null; problem: string | null; outcome: string | null;
      surfaces: string | null; edge_cases: string | null; out_of_scope: string | null;
      prd_url: string | null; platforms: string[] | null; priority: string | null;
    }>(sql`select title, context, problem, outcome, surfaces, edge_cases, out_of_scope,
                  prd_url, platforms, priority
             from requirements where id = ${id}`);
    const before = fingerprintOfRow(row.rows[0]!);

    await db.execute(sql`update requirements set type = 'commercial' where id = ${id}`);

    const row2 = await db.execute<typeof row.rows[0]>(sql`
      select title, context, problem, outcome, surfaces, edge_cases, out_of_scope,
             prd_url, platforms, priority
        from requirements where id = ${id}`);
    expect(fingerprintOfRow(row2.rows[0]!)).toBe(before);

    // 反面证据：指纹函数本身认得这十格——它只是没有 type 这一格。
    expect(requirementFingerprint({ title: '分享页搜索', context: '访问者在分享页里找文件' }))
      .toBe(before);
  });

  it('抽屉：空类型写「未指定」，抬头那段整段不渲染', async () => {
    const id = await make();
    const detail = (await getRequirementDetail(id))!;
    expect(detail.info.type).toBeNull();
    expect(detail.info.typeLabel).toBe(TYPE_UNSET);
    expect(detail.info.typeLabel).toBe('未指定');
    expect(detail.info.typeSuffix).toBeNull();
    // 原值也给一份：MCP 拿到的是 null 而不是编出来的 'feature'。
    expect(detail.info).toHaveProperty('type', null);
  });

  it('词表只有一个来源：表单从 TYPES / TYPE_UNSET 派生，不硬编码选项', async () => {
    const file = await readFile(
      path.join(process.cwd(), 'app/components/RequirementForm.tsx'), 'utf8',
    );
    // 派生：两份列表都从模块里来。
    expect(file).toContain("from '../../src/core/requirements/type'");
    expect(file).toContain('TYPES.map');
    expect(file).toContain('TYPE_UNSET');
    // 不重复：界面上那两个字面量不该再出现一次（它们只在 `type.ts` 里）。
    expect(file).not.toContain('<option value="commercial">');
    expect(file).not.toContain('<option value="feature">');
    expect(file).not.toContain('>商业</option>');
    expect(file).not.toContain('>功能</option>');
    // 词表自己的形状（加一类只要改这里）。
    expect(TYPES.map((t) => t.key)).toEqual(['feature', 'commercial']);
    expect(typeLabel(null)).toBe('未指定');
    expect(typeSuffix('')).toBeNull();
  });
});
