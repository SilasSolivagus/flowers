import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';
import {
  STATE_LABEL, assertTrigger, clockTransitions, type State,
} from '../state-machine.js';
import { moveTo } from '../requirements/lock.js';
import { notifySkipped, type SkipField, type Skipped } from './skips.js';

/** 跳过的那一行的形状（定义在 `skips.ts`，与那条提醒共用一份）。 */
export type { SkipField, Skipped } from './skips.js';
export { EVENT_CLOCK_SKIPPED } from './skips.js';

type Moved = { id: string; from: State; to: State };

const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 三个日期列在需求行上的列名，也是 tick 里唯一可能缺的字段。 */
export type DeadlineField = 'window_start' | 'commit_test_at' | 'commit_due_at';

/**
 * 三个日期列的中文名。
 *
 * 导出而不是留在这里私用：读模型（`read/board.ts`）要在卡片上写「缺开工日 / 缺提测日 /
 * 缺承诺完成日」，tick 要在报错里写「处于「开发中」但缺少提测日」。两处说的是**同一个
 * 日期**，各自抄一份词表迟早会出现「卡片说缺提测日、报错说缺测试日」这种对不上的话。
 */
export const DEADLINE_LABEL: Record<DeadlineField, string> = {
  window_start: '开工日',
  commit_test_at: '提测日',
  commit_due_at: '承诺完成日',
};

/**
 * 「哪一列决定哪一步」——tick 里唯一手写的东西。
 *
 * 边本身不在这里列：它们从 TRANSITIONS 的 clock 行派生（见 clockEdges），
 * 删掉表里的一行，tick 就少一条边——这正是「状态机是唯一口径」的可执行版本。
 */
const DEADLINE_FIELD: Partial<Record<State, DeadlineField>> = {
  ready: 'window_start',
  dev: 'commit_test_at',
  test: 'commit_due_at',
};

/**
 * 时钟推进的边（源状态 → 目标状态 + 判定用的那一列），全部来自 TRANSITIONS。
 *
 * 从表里派生而不是另写一份：这个文件曾经自己 re-list 了三条边，于是把
 * `ready → dev` 从状态机里删掉之后，时钟照跑、24 条时钟用例全绿——表失去了权威性
 * （被删行只让三条「逐行钉住表」的用例变红，没有一条用例说得出「时钟不认表」）。
 * test/state-machine.test.ts 里的等式用例把这一层关系钉住。
 *
 * 表里新增一条没有对应日期列的 clock 边会在这里抛错，而不是被静默跳过
 * （跳过 = 这条需求永远不推进，而没有任何人会被提醒）。
 */
export function clockEdges(): Array<{ from: State; to: State; field: DeadlineField }> {
  return clockTransitions().map((t) => {
    const field = DEADLINE_FIELD[t.from];
    if (!field) {
      throw new AppError(
        'clock_missing_deadline',
        `状态「${STATE_LABEL[t.from]}」没有对应的期限列，时钟无法推进它`,
      );
    }
    return { from: t.from, to: t.to, field };
  });
}

/**
 * 把任意时刻折算成「北京时间的第几天」（自 epoch 起的整数天）。
 *
 * 为什么不能直接比时刻：排期填的是日历日（'2026-12-01'），库里落成 UTC 零点，
 * 而 spec/plan 的口径是「天按 Asia/Shanghai 计算」——开工日、提测日、承诺完成日
 * 都是**那一天到了**就推进，不是那个 UTC 时刻到了才推进。直接比时刻会让北京
 * 12-01 00:00 的 tick 认为「开工日还没到」（差 8 小时），要到 12-01 08:00 才动。
 */
export function shanghaiDayOf(text: string): number | null {
  // db.execute 把 timestamptz 以**字符串**返回（'2026-12-04 00:00:00+00'），
  // 不是 Date。必须 new Date(...) 解析后再取 getTime()：
  // `new Date('2026-12-05') >= '2026-12-04 00:00:00+00'` 是 Date 与字符串比较，
  // 退化成 NaN 比较、恒为 false，到点的行会被静默跳过、永远不推进。
  const ms = new Date(text).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.floor((ms + SHANGHAI_OFFSET_MS) / DAY_MS);
}

/**
 * 「北京时间某一天」的零点时刻。`day` 是 'YYYY-MM-DD' 这种日历日。
 *
 * 与 shanghaiDayOf 互逆：`shanghaiDayOf(startOfShanghaiDay(d).toISOString()) ===
 * shanghaiDayOf(d + 'T00:00:00+08:00')`。用它替换散落在脚本与用例里的
 * `new Date('2026-12-01T00:00:00+08:00')`：+08:00 这条常识只该在时钟模块里出现一次。
 *
 * 固定 +08:00 而不是 Asia/Shanghai 时区名：1991 年之后中国没有夏令时，
 * 本项目关心的日期区间里两者逐秒相同，而固定偏移不依赖运行环境的 tzdata。
 */
export function startOfShanghaiDay(day: string): Date {
  const ms = new Date(`${day}T00:00:00+08:00`).getTime();
  if (Number.isNaN(ms)) throw new AppError('invalid', `不是有效日期：${day}`);
  return new Date(ms);
}

/**
 * 读取一行上某个日期列对应的「天」，缺失或解析不出来就抛 AppError。
 *
 * 抛的是**这一行**的问题，不是这一轮的问题：`tick` 接住它、把这一行记进 `skipped`
 * 然后继续（见 `judgeRow` 与下方 tick 的注释）。缺 release_id、缺提测日、缺承诺
 * 完成日都只可能来自越过 schedule / bounce 的直接写库（或数据损坏），所以必须喊
 * 出来——但喊的方式是「记一行账 + 给超管一条提醒」，不是「整轮停摆」。
 */
export function deadlineDay(
  raw: string | null,
  ctx: { requirementId: string; state: State; field: DeadlineField },
): number {
  const label = DEADLINE_LABEL[ctx.field];
  const state = STATE_LABEL[ctx.state];
  if (raw === null) {
    throw new AppError(
      'clock_missing_deadline',
      `需求 ${ctx.requirementId} 处于「${state}」但缺少${label}，无法自动推进`,
    );
  }
  const day = shanghaiDayOf(raw);
  if (day === null) {
    throw new AppError(
      'clock_bad_deadline',
      `需求 ${ctx.requirementId} 的${label}不是有效时间：${raw}`,
    );
  }
  return day;
}

/**
 * 三个时钟状态都必须挂在版本上。
 *
 * 单看开工日会漏掉一格：`dev` / `test` 行不看 `window_start`，所以 `release_id = null`
 * 的 dev 行会一路被推到 test、再到 live —— 没有开工日就意味着没有版本，这一类行是
 * 损坏数据，不是「还不到点」。所以版本先查，三个状态一视同仁地报出来。
 *
 * 与 `deadlineDay` 一样，这里抛的是**这一行**的问题；由 tick 接住并记进 `skipped`。
 */
function assertHasRelease(
  releaseId: string | null,
  ctx: { requirementId: string; state: State },
): void {
  if (releaseId === null) {
    throw new AppError(
      'clock_missing_deadline',
      `需求 ${ctx.requirementId} 处于「${STATE_LABEL[ctx.state]}」但没有排期版本，无法自动推进`,
    );
  }
}

/**
 * 这两个 code 表示「**这一行的数据**坏了」，不是「这一轮跑不动」：
 * 缺版本 / 缺那一格日期 / 日期解析不出来。tick 接住它们之后只跳过这一行；
 * 其余任何错误（库连不上、SQL 写错、状态机配置错）照旧抛出、整轮回滚。
 *
 * 拿 code 判而不是拿 `instanceof` 判完就算：`clockEdges()` 也会抛
 * `clock_missing_deadline`（状态机表里多出一条没有日期列的 clock 边），那是**代码**
 * 问题、必须致命。它抛在取行之前、也不经过这里，所以两件事不会混。
 */
function isRowDataError(error: unknown): error is AppError {
  return error instanceof AppError
    && (error.code === 'clock_missing_deadline' || error.code === 'clock_bad_deadline');
}

/** 一行在这一次 tick 里的判定：推一步 / 还没到点 / 跳过。 */
type Verdict =
  | { kind: 'advance'; to: State }
  | { kind: 'wait' }
  | { kind: 'skip'; field: SkipField; reason: string };

/**
 * 判定一行。**唯一会把「行的问题」翻译成「跳过」的地方。**
 *
 * 三种结果对应三种处置：
 * - `advance`：写状态 + 一条事件；
 * - `wait`：今天还没到点，什么也不做（这是绝大多数行的答案）；
 * - `skip`：这一行的数据坏了一格，记一行原因，**这一行原样不动**，其余行照常推进。
 *
 * 为什么不是「抛出去让整轮失败」：迁移 `0024` 之前 803 条迁入行没有 `release_id`，
 * 于是 tick 从迁移那天起一轮都没跑完过——状态不动、超时提醒不响、推送不发、自愈
 * 检查轮不到。一条坏数据停掉了全场的钟，而看板看起来只是「今天没活」。
 * 所以：坏行只影响它自己（裁定 2026-11-08）。
 *
 * 导出是给用例用的：`clock.test.ts` 要钉住「日期读不懂」那一格（列是 timestamptz，
 * 真库里写不进坏字符串，只能对着这个纯判定断言）。
 */
export function judgeRow(
  row: {
    id: string; state: State; release_id: string | null;
    window_start: string | null; commit_test_at: string | null; commit_due_at: string | null;
  },
  edge: { from: State; to: State; field: DeadlineField },
  today: number,
): Verdict {
  try {
    assertHasRelease(row.release_id, { requirementId: row.id, state: row.state });
  } catch (error) {
    if (!isRowDataError(error)) throw error;
    return { kind: 'skip', field: 'release_id', reason: '没有排期版本' };
  }

  let day: number;
  try {
    day = deadlineDay(row[edge.field], {
      requirementId: row.id, state: row.state, field: edge.field,
    });
  } catch (error) {
    if (!isRowDataError(error)) throw error;
    const label = DEADLINE_LABEL[edge.field];
    return {
      kind: 'skip',
      field: edge.field,
      // 「缺」与「填了但读不懂」是两种修法（补日期 / 改日期），所以分开说。
      reason: error.code === 'clock_bad_deadline' ? `${label}不是有效时间` : `缺少${label}`,
    };
  }

  return today < day ? { kind: 'wait' } : { kind: 'advance', to: edge.to };
}


/**
 * 时钟推进：把到了点的 ready / dev / test 各推进一步。
 *
 * 一次调用里每行**最多推进一步**：刚从 ready 推到 dev 的行，即使提测日也早就过了，
 * 也要等下一次 tick 才继续走。两步并一步会让事件流里少一条、state_entered_at 少一档，
 * 前端的时间轴就断了。
 *
 * 每一步都过 `assertTrigger(..., 'clock')`：边来自状态机，但「这条边确实该由时钟
 * 推进」仍要在写状态之前被状态机确认（顺序与各服务里 assert 先于写一致）。
 * 写状态走 moveTo，state_entered_at 的那条不变量因此也只在一个地方实现。
 *
 * 取行用 `for update`：两个 tick 并发时后来者会等前者提交，重新读到的就是**已更新**
 * 的行（READ COMMITTED 的 EPQ 语义），于是看到 dev 且提测日未到、什么也不推，
 * 而不是两个事务都按 ready 处理、各写一条事件、把状态推两步。
 * order by id 固定加锁顺序，避免多行时两个 tick 交叉加锁死等。
 *
 * ── 坏行只影响它自己（裁定 2026-11-08：一条坏数据不许停掉全场）
 *
 * 每一行先过 `judgeRow`：数据坏的行走 `skipped`（带中文原因、原样不动），其余行
 * 照常推进。理由不是「宽容」，是血：迁移 `0024` 之前 803 条迁入行没有 `release_id`，
 * 于是 tick 从迁移那天起**一轮都没跑完过**——状态不推进、超时提醒不响、推送不发、
 * 企微自检永远轮不到。全场停摆，而症状只是「看板不动」。迁移把 34 条缺日期的行退回
 * queue，顺手清掉了现场，但机制没动：下一行坏数据会再停一次。
 *
 * 跳过**不是静默**：一轮里有跳过就在最后给超管写一条提醒（`skips.ts`，每天最多一条，
 * 点名条数与需求编号），并且 `skipped` 作为返回值的一部分交给调用方（测试、脚本、
 * 报告都读它）。真正的**整轮**错误仍然致命：`now` 不合法、库连不上、取行 SQL 写错、
 * 状态机表多出一条没有日期列的 clock 边（`clockEdges`）、`assertTrigger` 不认这条边、
 * moveTo / recordEvent 失败——这些都不是「某一行数据坏了」，跳过它们等于把系统性的
 * 错误藏起来。
 */
export async function tick(db: Db, now: Date): Promise<{ moved: Moved[]; skipped: Skipped[] }> {
  // now 是 Invalid Date 时所有比较都是 false，表现为「什么都没到点」——最坏的一种
  // 静默失败（时钟停了但日志一片安静），所以在入口就拦掉。
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) throw new AppError('invalid', '时钟时间不合法');
  const at = new Date(nowMs).toISOString();
  // 同一个折算函数：tick 的「今天」与 bounce 的 R23 底线不可能对同一个时刻给出两个天。
  const today = shanghaiDayOf(at);
  if (today === null) throw new AppError('invalid', '时钟时间不合法');

  const edges = clockEdges();
  const edgeByFrom = new Map(edges.map((e) => [e.from, e]));
  // 状态列表走参数绑定（不是拼字符串）：`= any($1)` 在这里不成立，drizzle 把数组
  // 当普通参数发出、PG 推不出 text[] 类型；逐个参数 join 成 in (...) 才是确定的。
  const states = sql.join(edges.map((e) => sql`${e.from}`), sql`, `);

  const round = await db.transaction(async (tx) => {
    const moved: Moved[] = [];
    const skipped: Skipped[] = [];

    // 要看哪些状态，也由 clockEdges 决定：表里没有 clock 行的状态不该被取出来。
    // left join + 把 rel.id 也取出来：没有 release_id 的行（三个状态都一样）必须
    // 被取出来判定。inner join 会让它从结果里消失——正是「静默跳过」。
    // 只看 rel.window_start 不够：dev / test 行不读 window_start，release_id 为 null
    // 的 dev 行会被一路推到 live，连一声响都没有。
    // `r.number` 是给跳过提醒点名用的（「PAN-12 缺提测日」），不是判定依据。
    const due = await tx.execute<{
      id: string; number: number | null; state: State; release_id: string | null;
      window_start: string | null; commit_test_at: string | null; commit_due_at: string | null;
    }>(sql`
      select r.id, r.number, r.state, rel.id as release_id, rel.window_start,
             r.commit_test_at, r.commit_due_at
        from requirements r
        left join releases rel on rel.id = r.release_id
       -- 软删除的需求不再被时钟推进（P4-02）：它对外已经不存在，推进它只会往
       -- events 里写一行没人看得到、也无法解释的迁移。
       where r.state in (${states}) and r.deleted_at is null
       order by r.id
         for update of r`);

    for (const row of due.rows) {
      // 查询条件就是从 edgeByFrom 派生的，这里取不到只可能是并发改了 state——
      // 不推，交回状态机（下一次 tick 会按新状态重新判断）。
      const edge = edgeByFrom.get(row.state);
      if (!edge) continue;

      const verdict = judgeRow(row, edge, today);
      if (verdict.kind === 'wait') continue;
      if (verdict.kind === 'skip') {
        // 这一行原样不动：不写状态、不写事件。只记一笔账，最后统一报给超管。
        skipped.push({
          id: row.id,
          number: row.number === null ? null : Number(row.number),
          state: row.state,
          field: verdict.field,
          reason: verdict.reason,
        });
        continue;
      }

      // 先确认这条边由时钟负责，再写状态：顺序与各服务一致。
      assertTrigger(row.state, verdict.to, 'clock');

      // state_entered_at 落在注入的 at 上，而不是 now()：时间轴要与被 tick 的
      // 「今天」一致，否则排期甘特与事件时刻会差出一次 cron 的间隔。
      await moveTo(tx, row.id, verdict.to, undefined, at);
      await recordEvent(tx, {
        requirementId: row.id, actor: 'system', type: `requirement.auto_${verdict.to}`,
        payload: { from: row.state, to: verdict.to, at },
      });
      moved.push({ id: row.id, from: row.state, to: verdict.to });
    }

    return { moved, skipped };
  });

  // 报账排在状态提交**之后**、另起一个事务：提醒写失败不该把这一轮已经推进的行
  // 回滚——那等于让「报告跳过」变成新的全场停机点，只是绕了一圈。库真的挂了时
  // 这一步仍然抛（那时什么也做不了，静默才是更坏的选择）。
  await notifySkipped(db, { day: today, skipped: round.skipped });

  return round;
}
