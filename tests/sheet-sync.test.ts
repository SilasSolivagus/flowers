import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { reviewPass } from '../src/core/requirements/review.js';
import {
  QUEUE_SHEET_COLUMNS, queueSheetCells, queueSheetValues,
} from '../src/core/sheet/queue-sheet.js';
import { sweepQueueSheet } from '../src/core/sheet/sync.js';
import type { Runner, RunResult } from '../src/core/notify/wecom.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { BRIEF } from './helpers/brief.js';

/**
 * 进待排期 → 企微汇总表（2026-11-10）。
 *
 * 三层，全部对着真库或真 argv 断言：
 * 1. **行形状**：一条需求摊成那 11 格（纯函数，不碰 CLI、不碰库）；
 * 2. **去重与失败**：注入一个假 runner，钉住 argv 与台账状态；
 * 3. **触发**：`reviewPass` 之后台账里必须有那一行 pending（与状态迁移同一个事务）。
 *
 * 为什么第 2 层要用 argv 断言而不是「调用了 append」：真正会写错的是那一行 JSON
 * 的形状（空列要 `{}`、`#` 要 `PAN-n`、11 格顺序不能乱）。只断言「调用了一次」
 * 的话，把列顺序写反仍然全绿。
 */

let people: Array<{ id: string; name: string; role: string; line: string | null }> = [];

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

const PM = '吕品';
const FEATURE_REVIEWER = '吕正豪';
const COMMERCIAL_REVIEWER = '赵越';

function signerFor(owner: string): string {
  const found = people.find((item) => item.name === owner);
  if (!found) throw new Error(`种子里没有成员 ${owner}`);
  if (found.line === 'feature') return FEATURE_REVIEWER;
  if (found.line === 'commercial') return COMMERCIAL_REVIEWER;
  return owner;
}

/** 一条走到待排期的需求（走真实动作，不直接 UPDATE 状态）。 */
async function toQueue(owner: string, title: string, extra: Record<string, unknown> = {}) {
  const created = await createRequirement(db, owner, {
    ...BRIEF, title, type: 'feature', requester: PM, ...extra,
  });
  await evaluate(db, owner, { requirementId: created.id });
  await submitReview(db, owner, { requirementId: created.id, prdUrl: 'https://doc.example/prd' });
  await reviewPass(db, signerFor(owner), { requirementId: created.id });
  return created;
}

function ok(stdout: unknown): RunResult {
  return { exitCode: 0, timedOut: false, spawnError: null, stdout: JSON.stringify(stdout), stderr: '' };
}

describe('行形状：11 格', () => {
  it('列名固定为汇总表那 11 列', () => {
    expect(QUEUE_SHEET_COLUMNS).toEqual([
      '#', '需求名称', '负责人', '优先级', '迭代情况', '涉及端',
      '涉及研发人员', '需求描述', '预评审', 'PRD链接', '备注',
    ]);
  });

  it('编号写 PAN-n，优先级写中文，平台换成表里的词，空列留空', () => {
    const cells = queueSheetCells({
      number: 742,
      title: '用户部分权益缩减调整',
      owner: '罗丹',
      priority: 'p1',
      platforms: ['h5', 'mobile', 'admin'],
      outcome: '缩减后用户在个人中心能看到差额说明',
      problem: '现在没有说明',
      prdUrl: 'https://doc.example/prd/742',
      remark: '涉及商户号安全',
    });

    expect(cells).toHaveLength(11);
    expect(cells[0]).toBe('PAN-742');
    expect(cells[1]).toBe('用户部分权益缩减调整');
    expect(cells[2]).toBe('罗丹');
    expect(cells[3]).toBe('P1');
    // 迭代情况 / 涉及研发人员 / 预评审：没有数据源，机器不猜。
    expect(cells[4]).toBe('');
    expect(cells[5]).toBe('H5、APP、管理后台');
    expect(cells[6]).toBe('');
    // 描述取 outcome，不取 problem。
    expect(cells[7]).toBe('缩减后用户在个人中心能看到差额说明');
    expect(cells[8]).toBe('');
    expect(cells[9]).toBe('[PRD](https://doc.example/prd/742)');
    expect(cells[10]).toBe('涉及商户号安全');
  });

  it('outcome 空时退到 problem；两问都空就留空', () => {
    const base = {
      number: 1, title: 't', owner: null, priority: null, platforms: [], prdUrl: null, remark: null,
    };
    expect(queueSheetCells({ ...base, outcome: null, problem: '现状哪不好' })[7]).toBe('现状哪不好');
    expect(queueSheetCells({ ...base, outcome: null, problem: null })[7]).toBe('');
    // 未定优先级 / 未标注平台 / 没有 PRD：三格都空，而不是「—」这种填充字符——
    // 单元格里的破折号会被下游当成内容。
    const empty = queueSheetCells({ ...base, outcome: null, problem: null });
    expect([empty[2], empty[3], empty[5], empty[9]]).toEqual(['', '', '', '']);
  });

  it('换行折成空格：一行必须是一行', () => {
    const cells = queueSheetCells({
      number: 9, title: 'a\nb', owner: 'x', priority: null, platforms: [],
      outcome: '第一段\n第二段', problem: null, prdUrl: null, remark: 'r\r\ns',
    });
    expect(cells[1]).toBe('a b');
    expect(cells[7]).toBe('第一段 第二段');
    expect(cells[10]).toBe('r s');
  });

  it('空串写成 {}，有值才是 TEXT 单元格', () => {
    const values = queueSheetValues(['PAN-1', '', '吕品']);
    expect(values[0]).toEqual({ cell_value: { text: 'PAN-1' }, data_type: 'TEXT' });
    expect(values[1]).toEqual({});
    expect(values[2]).toEqual({ cell_value: { text: '吕品' }, data_type: 'TEXT' });
  });
});

describe('reviewPass 之后登记 pending', () => {
  it('状态进待排期的同一次事务里，台账多一行 pending', async () => {
    const created = await toQueue(PM, '权益套餐产品结构改造', {
      remark: '先合这版',
      platforms: ['h5'],
      priority: 'p0',
    });

    const found = await db.execute<{ state: string; target: string }>(sql`
      select state, target from sheet_sync where requirement_id = ${created.id}`);
    expect(found.rows).toEqual([{ state: 'pending', target: 'queue-sheet' }]);
  });

  it('被软删的需求不会进台账的待写队列（sweep 跳过它）', async () => {
    const created = await toQueue(PM, '被删掉的那条');
    await db.execute(sql`update requirements set deleted_at = now() where id = ${created.id}`);

    const run: Runner = async () => {
      throw new Error('软删的需求不该触发任何 CLI 调用');
    };
    const result = await sweepQueueSheet(db, { run });
    expect(result.ok && result.summary.scanned).toBe(0);
  });
});

describe('扫一轮：写一次、跳过已有的、失败留痕', () => {
  it('表里没有 PAN-n → append 一次，台账 ok', async () => {
    const created = await toQueue(PM, '积分商城展示优化', {
      remark: '等运营确认', platforms: ['admin'], priority: 'p2',
    });

    const calls: string[][] = [];
    const run: Runner = async (_bin, argv) => {
      calls.push(argv);
      if (argv.includes('ranges')) return ok({ errcode: 0, content: '#\n1\nPAN-2\n' });
      return ok({ errcode: 0, errmsg: 'ok' });
    };

    const result = await sweepQueueSheet(db, { run });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.written).toBe(1);
    expect(result.summary.failed).toBe(0);

    const append = calls.find((argv) => argv.includes('append'));
    expect(append).toBeDefined();
    expect(append).toContain('kvf2dh');
    const rowJson = append![append!.indexOf('--row') + 1]!;
    const parsed = JSON.parse(rowJson) as { values: unknown[] };
    expect(parsed.values).toHaveLength(11);
    expect(parsed.values[0]).toEqual({
      cell_value: { text: `PAN-${created.number}` }, data_type: 'TEXT',
    });

    const after = await db.execute<{ state: string; attempts: number }>(sql`
      select state, attempts from sheet_sync where requirement_id = ${created.id}`);
    expect(after.rows[0]?.state).toBe('ok');
    expect(Number(after.rows[0]?.attempts)).toBe(1);
  });

  it('表里已经有 PAN-n → 不 append，台账标 ok 且写明「表里已有」', async () => {
    const created = await toQueue(PM, '埋点第二轮');

    let appended = 0;
    const run: Runner = async (_bin, argv) => {
      if (argv.includes('ranges')) {
        return ok({ errcode: 0, content: `#\n1\nPAN-${created.number}\n` });
      }
      appended += 1;
      return ok({ errcode: 0 });
    };

    const result = await sweepQueueSheet(db, { run });
    expect(result.ok && result.summary.skipped).toBe(1);
    expect(appended).toBe(0);

    const after = await db.execute<{ state: string; last_error: string | null }>(sql`
      select state, last_error from sheet_sync where requirement_id = ${created.id}`);
    expect(after.rows[0]?.state).toBe('ok');
    expect(after.rows[0]?.last_error).toContain('表里已有');
  });

  it('append 返回 errcode → 台账 failed，原因原样留着（含 errcode）', async () => {
    const created = await toQueue(PM, '写不进去的那条');

    const run: Runner = async (_bin, argv) => {
      if (argv.includes('ranges')) return ok({ errcode: 0, content: '#\n' });
      return ok({ errcode: 40001, errmsg: 'invalid sheet_id' });
    };

    const result = await sweepQueueSheet(db, { run });
    expect(result.ok && result.summary.failed).toBe(1);

    const after = await db.execute<{ state: string; last_error: string | null; attempts: number }>(sql`
      select state, last_error, attempts from sheet_sync where requirement_id = ${created.id}`);
    expect(after.rows[0]?.state).toBe('failed');
    expect(after.rows[0]?.last_error).toContain('invalid sheet_id');
    expect(Number(after.rows[0]?.attempts)).toBe(1);
  });

  it('读不到 A 列就整轮不写（没有去重信息时不许硬写）', async () => {
    await toQueue(PM, '这条也不许写');

    let appended = 0;
    const run: Runner = async (_bin, argv) => {
      if (argv.includes('ranges')) {
        return { exitCode: 1, timedOut: false, spawnError: null, stdout: '', stderr: 'boom' };
      }
      appended += 1;
      return ok({ errcode: 0 });
    };

    const result = await sweepQueueSheet(db, { run });
    expect(result.ok).toBe(false);
    expect(appended).toBe(0);
  });
});
