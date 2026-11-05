import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { AppError } from '../src/core/errors.js';
import { recordEvent } from '../src/core/events.js';
import { assertTransition, isClockTransition, TRANSITIONS } from '../src/core/state-machine.js';
import { resetDb } from './helpers/db.js';

describe('AppError', () => {
  it('带上 code 和中文消息', () => {
    const e = new AppError('illegal_transition', '这个状态不能直接到那里');
    expect(e.code).toBe('illegal_transition');
    expect(e.message).toBe('这个状态不能直接到那里');
  });
});

type EventRow = {
  seq: number;
  requirement_id: string | null;
  actor: string;
  type: string;
  payload: string;
  at: string | Date;
};

describe('recordEvent', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('在事务里写入一条事件，六个字段全部落库', async () => {
    await db.transaction(async (tx) => {
      await recordEvent(tx, {
        requirementId: null,
        actor: '房超',
        type: 'requirement_created',
        payload: { state: 'inbox', number: 1 },
      });
    });

    const res = await db.execute<EventRow>(
      sql`select seq, requirement_id, actor, type, payload, at from events`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({
      seq: 1,
      requirement_id: null,
      actor: '房超',
      type: 'requirement_created',
      payload: JSON.stringify({ state: 'inbox', number: 1 }),
    });
    // 原始 execute 走 pg 的文本协议，timestamptz 回来是字符串，这里只断言默认值已写入
    expect(String(res.rows[0]!.at)).toMatch(/^\d{4}-\d{2}-\d{2}[ T]/);
  });

  it('seq 单调递增，且 payload 按 JSON 字符串保存', async () => {
    await db.transaction(async (tx) => {
      await recordEvent(tx, { requirementId: null, actor: '王妍', type: 'a', payload: { n: 1 } });
      await recordEvent(tx, { requirementId: null, actor: '王妍', type: 'b', payload: { n: 2 } });
    });

    const res = await db.execute<EventRow>(
      sql`select seq, requirement_id, actor, type, payload, at from events order by seq`,
    );
    expect(res.rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(res.rows.map((r) => r.type)).toEqual(['a', 'b']);
    expect(res.rows.map((r) => r.payload)).toEqual([
      JSON.stringify({ n: 1 }),
      JSON.stringify({ n: 2 }),
    ]);
  });
});

describe('state machine', () => {
  it('13 条合法转移都能过', () => {
    expect(TRANSITIONS).toHaveLength(13);
    for (const t of TRANSITIONS) {
      expect(() => assertTransition(t.from, t.to, { hasPrd: true, hasType: true })).not.toThrow();
    }
  });

  it('转移表与规格逐条一致', () => {
    expect(TRANSITIONS).toEqual([
      { from: 'inbox', to: 'design', trigger: 'evaluate', guard: 'type' },
      { from: 'inbox', to: 'review', trigger: 'submit_review', guard: 'prd' },
      { from: 'inbox', to: 'rejected', trigger: 'reject' },
      { from: 'inbox', to: 'shelved', trigger: 'shelve' },
      { from: 'design', to: 'review', trigger: 'submit_review', guard: 'prd' },
      { from: 'review', to: 'queue', trigger: 'review_pass' },
      { from: 'review', to: 'design', trigger: 'review_reject' },
      { from: 'queue', to: 'ready', trigger: 'schedule', guard: 'dates' },
      { from: 'ready', to: 'dev', trigger: 'clock', clock: true },
      { from: 'dev', to: 'test', trigger: 'clock', clock: true },
      { from: 'test', to: 'live', trigger: 'clock', clock: true },
      { from: 'test', to: 'dev', trigger: 'bounce', guard: 'new_due' },
      { from: 'shelved', to: 'inbox', trigger: 'restore' },
    ]);
  });

  it('inbox 不能直接到 开发中', () => {
    expect(() => assertTransition('inbox', 'dev', { hasPrd: true, hasType: true }))
      .toThrowError(AppError);
  });

  it('inbox → review 必须有 PRD', () => {
    expect(() => assertTransition('inbox', 'review', { hasPrd: false, hasType: true }))
      .toThrowError(new AppError('missing_prd', '直接提交评审必须有正式 PRD 链接'));
  });

  it('inbox → design 必须有类型', () => {
    expect(() => assertTransition('inbox', 'design', { hasPrd: true, hasType: false }))
      .toThrowError(new AppError('missing_type', '需求必须有类型（商业 / 功能）才能进入下一步'));
  });

  it('isClockTransition 只认 3 条时钟转移', () => {
    expect(TRANSITIONS.filter((t) => isClockTransition(t.from, t.to)).map((t) => `${t.from}>${t.to}`))
      .toEqual(['ready>dev', 'dev>test', 'test>live']);
    expect(isClockTransition('inbox', 'design')).toBe(false);
  });
});
