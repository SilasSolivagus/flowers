import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { AppError } from '../src/core/errors.js';
import { recordEvent } from '../src/core/events.js';
import {
  assertTransition, assertTrigger, clockTransitions,
  STATE_LABEL, TRANSITIONS, type State, type Transition,
} from '../src/core/state-machine.js';
import { clockEdges } from '../src/core/clock/tick.js';
import { resetDb } from './helpers/db.js';
import { BRIEF } from './helpers/brief.js';

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

/**
 * 抓取断言抛出的 AppError，让调用方同时断言 instance、code、message。
 *
 * 不要退回 `expect(fn).toThrowError(new AppError('code', '消息'))`：vitest 只在
 * 传构造器（`toThrowError(AppError)`）时走 instanceof 分支，传实例时只比较
 * `.message`。这样 `throw new Error('同样的消息')` 和
 * `new AppError('别的 code', '同样的消息')` 都会算通过，而下游服务是按
 * `e.code` 分支的，测试就失去了防线。
 */
function caught(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('expected AppError, nothing thrown');
}

describe('state machine', () => {
  it('13 条合法转移都能过', () => {
    expect(TRANSITIONS).toHaveLength(13);
    // ctx 把**两道门**都喂满（Ruling 2 之后 `inbox → design` 也要核心三问）：
    // 这条用例判的是「表里的边都走得通」，不是「门开不开」——门由下面几条各自的用例判。
    for (const t of TRANSITIONS) {
      expect(() => assertTransition(t.from, t.to, { hasPrd: true, brief: BRIEF })).not.toThrow();
    }
  });

  it('转移表与规格逐条一致', () => {
    expect(TRANSITIONS).toEqual([
      // Ruling 1：立项不再有 type 门（类型可空，且不承载权限）。
      // Ruling 2（2026-11-10）：换成 brief 门——核心三问不齐不能立项。
      { from: 'inbox', to: 'design', trigger: 'approve', guard: 'brief' },
      { from: 'inbox', to: 'review', trigger: 'submit_review', guard: 'prd' },
      { from: 'inbox', to: 'rejected', trigger: 'reject' },
      { from: 'inbox', to: 'shelved', trigger: 'shelve' },
      { from: 'design', to: 'review', trigger: 'submit_review', guard: 'prd' },
      { from: 'review', to: 'queue', trigger: 'review_pass' },
      { from: 'review', to: 'design', trigger: 'review_reject' },
      { from: 'queue', to: 'ready', trigger: 'schedule' },
      { from: 'ready', to: 'dev', trigger: 'clock', clock: true },
      { from: 'dev', to: 'test', trigger: 'clock', clock: true },
      { from: 'test', to: 'live', trigger: 'clock', clock: true },
      { from: 'test', to: 'dev', trigger: 'bounce' },
      { from: 'shelved', to: 'inbox', trigger: 'restore' },
    ]);
  });

  it('inbox 不能直接到 开发中', () => {
    expect(() => assertTransition('inbox', 'dev', { hasPrd: true }))
      .toThrowError(AppError);
  });

  it('inbox → review 必须有 PRD', () => {
    expect(caught(() => assertTransition('inbox', 'review', { hasPrd: false })))
      .toMatchObject({ code: 'missing_prd', message: '直接提交评审必须有正式 PRD 链接' });
  });

  it('inbox → design 不要求类型（Ruling 1），只要求核心三问（Ruling 2）', () => {
    // Ruling 1 的静态证据：表里那一条带的不是 `type` 门（加回去这里就红）。
    // Ruling 2 之后它带的是 `brief`：类型仍可空，六问不能空。
    // 跑得通的那两半在 tests/type-optional.test.ts（没有类型、但三问齐 → 真立项）。
    const edge = TRANSITIONS.find((t) => t.from === 'inbox' && t.to === 'design')!;
    expect(edge.guard).not.toBe('type');
    expect(edge.guard).toBe('brief');
    expect(() => assertTransition('inbox', 'design', { brief: BRIEF })).not.toThrow();
  });

  it('TRANSITIONS 在类型上是只读的（表就是口径，运行期不许往里写）', () => {
    // 类型层断言：@ts-expect-error 在没有报错时会自己变成错误，所以这行既是文档
    // 也是检查——`npx tsc --noEmit` 是它的执行者。
    // @ts-expect-error readonly 数组不能赋给可变数组
    const mutable: Transition[] = TRANSITIONS;
    expect(mutable).toBe(TRANSITIONS);
  });

  it('STATE_LABEL 覆盖全部 10 个状态', () => {
    expect(Object.keys(STATE_LABEL).sort()).toEqual([
      'design', 'dev', 'inbox', 'live', 'queue',
      'ready', 'rejected', 'review', 'shelved', 'test',
    ]);
    expect(STATE_LABEL.review).toBe('待评审');
  });
});

/**
 * I1：时钟的边必须来自 TRANSITIONS。这个文件曾经自己 re-list 了三条 clock 边，
 * 于是把 `ready → dev` 从表里删掉之后时钟照跑、197 条用例全绿——表失去了权威性。
 * 下面的等式就是那个 diverged 版本的报警器：手抄一份、或者派生逻辑跑偏，都会红。
 */
describe('tick 的边与 TRANSITIONS 同源', () => {
  it('tick 的 clock 边 === TRANSITIONS 里 clock 的行（顺序与目标状态都一致）', () => {
    const fromTable = clockTransitions().map((t) => `${t.from}>${t.to}`);
    expect(fromTable).toEqual(['ready>dev', 'dev>test', 'test>live']);
    expect(clockEdges().map((e) => `${e.from}>${e.to}`)).toEqual(fromTable);
  });

  it('每条 clock 边都钉住「哪一列」是它的判定依据', () => {
    expect(clockEdges()).toEqual([
      { from: 'ready', to: 'dev', field: 'window_start' },
      { from: 'dev', to: 'test', field: 'commit_test_at' },
      { from: 'test', to: 'live', field: 'commit_due_at' },
    ]);
  });
});

/**
 * I2：同一对 from/to 可能有多条路，只有 trigger 能区分。
 *
 * 这里钉住的是**措辞**：配对存在、动作不对时，报的必须是「当前在某个状态，不能执行
 * 这一步」，不能报「不能从「收集」直接到「待设计」」——后者是合法迁移，用户会以为
 * 状态机坏了。
 */
describe('assertTrigger — 配对合法但动作不对', () => {
  it('inbox 上点打回（配对 inbox → design 合法）报动作，不报配对', () => {
    const e = caught(() => assertTrigger('inbox', 'design', 'review_reject'));
    expect(e).toMatchObject({
      code: 'illegal_transition',
      message: '这条需求当前在「收集」，不能执行这一步',
    });
  });

  it('待开发上点打回（配对 ready → dev 合法，但那是时钟）报动作', () => {
    expect(caught(() => assertTrigger('ready', 'dev', 'bounce'))).toMatchObject({
      code: 'illegal_transition',
      message: '这条需求当前在「待开发」，不能执行这一步',
    });
  });

  it('待评审上点通过 / 立项都报动作', () => {
    // review → queue 是 review_pass 的路，用 approve（立项）撞上去
    expect(caught(() => assertTrigger('review', 'queue', 'approve'))).toMatchObject({
      message: '这条需求当前在「待评审」，不能执行这一步',
    });
    // review → design 是 review_reject 的路，用 approve（立项）撞上去
    expect(caught(() => assertTrigger('review', 'design', 'approve'))).toMatchObject({
      message: '这条需求当前在「待评审」，不能执行这一步',
    });
  });

  it('动作对得上就放行，并返回那一行', () => {
    expect(assertTrigger('review', 'design', 'review_reject'))
      .toEqual({ from: 'review', to: 'design', trigger: 'review_reject' });
    expect(assertTrigger('test', 'dev', 'bounce'))
      .toEqual({ from: 'test', to: 'dev', trigger: 'bounce' });
    expect(assertTrigger('ready', 'dev', 'clock')).toEqual(TRANSITIONS[8]);
  });

  it('配对本身不存在时报的是配对（两条消息各管一件事）', () => {
    // R44：这条消息会渲染到界面上，所以两端都是 STATE_LABEL，不是 State 原值。
    expect(caught(() => assertTrigger('inbox' as State, 'dev' as State, 'approve')))
      .toMatchObject({
        code: 'illegal_transition', message: '不能从「收集」直接到「开发中」',
      });
  });
});

/**
 * I1：ctx 可选，且门禁 fail-closed。给一条带着门（prd / brief）的迁移不传 ctx，
 * 等于「没检查过」，必须拒绝——而不是安静放行。
 *
 * 两道门各有一条用例；type 门的删除有它自己的断言（见上一条 describe）。
 */
describe('assertTransition — ctx 可选，门禁 fail-closed', () => {
  it('prd 门不传 ctx 就拒绝', () => {
    expect(caught(() => assertTransition('inbox', 'review'))).toMatchObject({
      code: 'missing_prd', message: '直接提交评审必须有正式 PRD 链接',
    });
  });

  it('brief 门不传 ctx 就拒绝（fail-closed：三格全空也是「没检查过」）', () => {
    expect(caught(() => assertTransition('inbox', 'design'))).toMatchObject({
      code: 'missing_brief',
    });
  });

  it('type 门已经不存在（Ruling 1）：只给 brief、不给 hasPrd 也放行', () => {
    // 这两件事必须分开：不传 hasPrd 是「这条边没有 prd 门」，不是「跳过检查」——
    // 而 inbox → design 上唯一的门是 brief。
    expect(() => assertTransition('inbox', 'design', { brief: BRIEF })).not.toThrow();
  });

  it('没有 guard 的迁移不传 ctx 也放行', () => {
    for (const t of TRANSITIONS.filter((x) => !x.guard)) {
      expect(() => assertTransition(t.from, t.to)).not.toThrow();
    }
  });
});
