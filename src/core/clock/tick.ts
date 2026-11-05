import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';
import {
  STATE_LABEL, assertTrigger, clockTransitions, type State,
} from '../state-machine.js';
import { moveTo } from '../requirements/lock.js';

type Moved = { id: string; from: State; to: State };

const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 三个日期列在需求行上的列名，也是 tick 里唯一可能缺的字段。 */
export type DeadlineField = 'window_start' | 'commit_test_at' | 'commit_due_at';

const FIELD_LABEL: Record<DeadlineField, string> = {
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

const stateLabel = (state: State) => STATE_LABEL[state] ?? state;

/**
 * 时钟推进的边（源状态 → 目标状态 + 判定用的那一列），全部来自 TRANSITIONS。
 *
 * 从表里派生而不是另写一份：这个文件曾经自己 re-list 了三条边，于是把
 * `ready → dev` 从状态机里删掉之后，时钟照跑、测试全绿——表失去了权威性。
 * test/state-machine.test.ts 里有一条用例把这个等式钉住。
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
        `状态「${stateLabel(t.from)}」没有对应的期限列，时钟无法推进它`,
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
 * 不静默跳过：被跳过的行是**永远不推进**的需求——它停在「待开发/开发中/测试中」
 * 却没有任何人会被提醒。缺 release_id、缺提测日、缺承诺完成日都只可能来自
 * 越过了 schedule / bounce 的直接写库（或数据损坏），值得让 tick 整次失败、
 * 在日志里喊出来，而不是每 15 分钟安静地放过它。
 */
export function deadlineDay(
  raw: string | null,
  ctx: { requirementId: string; state: State; field: DeadlineField },
): number {
  const label = FIELD_LABEL[ctx.field];
  const state = stateLabel(ctx.state);
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
 */
function assertHasRelease(
  releaseId: string | null,
  ctx: { requirementId: string; state: State },
): void {
  if (releaseId === null) {
    throw new AppError(
      'clock_missing_deadline',
      `需求 ${ctx.requirementId} 处于「${stateLabel(ctx.state)}」但没有排期版本，无法自动推进`,
    );
  }
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
 */
export async function tick(db: Db, now: Date): Promise<{ moved: Moved[] }> {
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

  return db.transaction(async (tx) => {
    const moved: Moved[] = [];

    // 要看哪些状态，也由 clockEdges 决定：表里没有 clock 行的状态不该被取出来。
    // left join + 把 rel.id 也取出来：没有 release_id 的行（三个状态都一样）必须
    // 被取出来报错。inner join 会让它从结果里消失——正是「静默跳过」。
    // 只看 rel.window_start 不够：dev / test 行不读 window_start，release_id 为 null
    // 的 dev 行会被一路推到 live，连一声响都没有。
    const due = await tx.execute<{
      id: string; state: State; release_id: string | null;
      window_start: string | null; commit_test_at: string | null; commit_due_at: string | null;
    }>(sql`
      select r.id, r.state, rel.id as release_id, rel.window_start, r.commit_test_at, r.commit_due_at
        from requirements r
        left join releases rel on rel.id = r.release_id
       where r.state in (${states})
       order by r.id
         for update of r`);

    for (const row of due.rows) {
      assertHasRelease(row.release_id, { requirementId: row.id, state: row.state });
      // 查询条件就是从 edgeByFrom 派生的，这里取不到只可能是并发改了 state——
      // 不推，交回状态机（下一次 tick 会按新状态重新判断）。
      const edge = edgeByFrom.get(row.state);
      if (!edge) continue;
      const day = deadlineDay(row[edge.field], {
        requirementId: row.id, state: row.state, field: edge.field,
      });
      if (today < day) continue;

      // 先确认这条边由时钟负责，再写状态：顺序与各服务一致。
      assertTrigger(row.state, edge.to, 'clock');

      // state_entered_at 落在注入的 at 上，而不是 now()：时间轴要与被 tick 的
      // 「今天」一致，否则排期甘特与事件时刻会差出一次 cron 的间隔。
      await moveTo(tx, row.id, edge.to, undefined, at);
      await recordEvent(tx, {
        requirementId: row.id, actor: 'system', type: `requirement.auto_${edge.to}`,
        payload: { from: row.state, to: edge.to, at },
      });
      moved.push({ id: row.id, from: row.state, to: edge.to });
    }

    return { moved };
  });
}
