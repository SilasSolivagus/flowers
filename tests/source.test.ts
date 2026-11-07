import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { getRequirementDetail } from '../src/core/read/detail.js';
import {
  SOURCES, SOURCE_OTHER, SOURCE_UNSET, isSourceKey, normalizeSource, sourceLabel,
  sourceNoteVisible,
} from '../src/core/requirements/source.js';
import { resetDb, seedPeople } from './helpers/db.js';

/**
 * Ruling 3（2026-11-08）：「来源」字段。
 *
 * 这一组钉四件事：
 * 1. **六类词表**（线上问题 / 客服反馈 / 领导需求 / 需求挖掘 / 技术反馈 / 其他）
 *    与「其他」那句自述；
 * 2. **往返**：表单 → 服务层 → 列 → 抽屉 / MCP；
 * 3. **单选不该被静默丢掉**：认不出的来源报错，而不是落成 null；
 * 4. **词表只有一个来源**：界面从 `SOURCES` 派生（这条用源码断言钉住——加一类来源
 *    只改 `source.ts` 一处，界面跟着变）。
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
  const created = await createRequirement(db, '吕品', {
    title: '分享页搜索', requester: '王妍', ...extra,
  });
  return created.id;
}

async function stored(id: string): Promise<{ source: string | null; source_note: string | null }> {
  const res = await db.execute<{ source: string | null; source_note: string | null }>(
    sql`select source, source_note from requirements where id = ${id}`);
  return res.rows[0]!;
}

describe('来源词表', () => {
  it('就是那六类，顺序固定（下拉的顺序 = 这张表的顺序）', () => {
    expect(SOURCES.map((s) => s.key)).toEqual([
      '线上问题', '客服反馈', '领导需求', '技术反馈', '需求挖掘', '其他',
    ]);
    expect(SOURCES.map((s) => s.label)).toEqual(SOURCES.map((s) => s.key));
    expect(SOURCE_OTHER).toBe('其他');
    expect(SOURCE_UNSET).toBe('未标注');
  });

  it('归一：空 / null → null（未标注），词表里的值原样，认不出的 → null 交给调用方报错', () => {
    expect(normalizeSource(null)).toBeNull();
    expect(normalizeSource(undefined)).toBeNull();
    expect(normalizeSource('  ')).toBeNull();
    expect(normalizeSource(' 线上问题 ')).toBe('线上问题');
    expect(normalizeSource('需求挖掘')).toBe('需求挖掘');
    expect(normalizeSource('自己想的')).toBeNull();
    expect(isSourceKey('其他')).toBe(true);
    expect(isSourceKey('原创')).toBe(false);
  });

  it('标签：null → 未标注；认不出的历史值原样返回（不折成空）', () => {
    expect(sourceLabel(null)).toBe('未标注');
    expect(sourceLabel('客服反馈')).toBe('客服反馈');
    expect(sourceLabel('原创')).toBe('原创');
  });

  it('自述只在「其他」且真有字时显示', () => {
    expect(sourceNoteVisible('其他', '老板在群里提的')).toBe(true);
    expect(sourceNoteVisible('其他', '   ')).toBe(false);
    expect(sourceNoteVisible('其他', null)).toBe(false);
    expect(sourceNoteVisible('线上问题', '一句话')).toBe(false);
  });
});

describe('来源的写入与读回', () => {
  it('六类都能落库，并在抽屉里显示', async () => {
    for (const item of SOURCES) {
      const id = await make({ source: item.key });
      expect(await stored(id)).toEqual({ source: item.key, source_note: null });
      const detail = (await getRequirementDetail(id))!;
      expect(detail.info.source).toBe(item.key);
      expect(detail.info.sourceLabel).toBe(item.label);
    }
  });

  it('「其他」带一句自述：source_note 落库，抽屉给 sourceNote', async () => {
    const id = await make({ source: '其他', sourceNote: '  老板在群里提的  ' });
    expect(await stored(id)).toEqual({ source: '其他', source_note: '老板在群里提的' });

    const detail = (await getRequirementDetail(id))!;
    expect(detail.info.source).toBe('其他');
    expect(detail.info.sourceNote).toBe('老板在群里提的');
    expect(sourceNoteVisible(detail.info.source, detail.info.sourceNote)).toBe(true);
  });

  it('不填来源就是 null（未标注），不是空串、也不编一个默认值', async () => {
    const id = await make();
    expect(await stored(id)).toEqual({ source: null, source_note: null });
    const detail = (await getRequirementDetail(id))!;
    expect(detail.info.source).toBeNull();
    expect(detail.info.sourceLabel).toBe('未标注');
  });

  it('认不出的来源报错，消息里列出全部六类', async () => {
    await expect(createRequirement(db, '吕品', {
      title: 'x', requester: 'y', source: '原创',
    })).rejects.toMatchObject({
      code: 'invalid',
      message: '来源只能是 线上问题 / 客服反馈 / 领导需求 / 技术反馈 / 需求挖掘 / 其他（或留空 = 未标注）',
    });
  });

  it('建需求的事件里也记下来源（时间轴要能回答「这条是哪来的」）', async () => {
    const id = await make({ source: '线上问题' });
    const res = await db.execute<{ payload: string }>(
      sql`select payload from events where requirement_id = ${id} and type = 'requirement.created'`);
    expect(JSON.parse(res.rows[0]!.payload)).toMatchObject({ source: '线上问题' });
  });
});

describe('来源词表只有一个来源（不硬编码在两处）', () => {
  it('表单从 SOURCES 派生选项，六个中文标签不在组件里再写一遍', async () => {
    const file = await readFile(
      path.join(process.cwd(), 'app/components/RequirementForm.tsx'), 'utf8',
    );
    expect(file).toContain("from '../../src/core/requirements/source'");
    expect(file).toContain('SOURCES.map');
    expect(file).toContain('SOURCE_OTHER');
    expect(file).toContain('SOURCE_UNSET');
    // 硬编码的反面：任何一个类别名都不该以选项字面量出现。
    for (const item of SOURCES) {
      expect(file).not.toContain(`>${item.label}</option>`);
    }
    // 服务层的报错也派生自词表（加一类不必改那句话）。
    const create = await readFile(
      path.join(process.cwd(), 'src/core/requirements/create.ts'), 'utf8',
    );
    expect(create).toContain('SOURCES.map');
    for (const item of SOURCES) {
      expect(create).not.toContain(`'${item.label}'`);
    }
  });

  it('抽屉那一行也走 sourceLabel / 读模型，不在组件里自己映射一遍', async () => {
    const file = await readFile(
      path.join(process.cwd(), 'app/components/Drawer.tsx'), 'utf8',
    );
    expect(file).toContain('info.sourceLabel');
    expect(file).toContain('SOURCE_OTHER');
    // 字面量检查：组件里不该出现任何一类的**字符串字面量**（注释里提到它们不算——
    // 那些字只在说明「这一行显示什么」，不是第二份词表）。
    for (const item of SOURCES) {
      expect(file).not.toContain(`'${item.label}'`);
    }
  });
});
