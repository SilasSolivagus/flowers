import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';
import type { State } from '../state-machine.js';

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

const STATE_LABEL: Partial<Record<State, string>> = {
  ready: '待开发', dev: '开发中', test: '测试中',
};

/** 三条 clock 转移：源状态 → 目标状态 + 判定用的那一列。 */
const NEXT: Record<'ready' | 'dev' | 'test', { to: State; field: DeadlineField }> = {
  ready: { to: 'dev', field: 'window_start' },
  dev: { to: 'test', field: 'commit_test_at' },
  test: { to: 'live', field: 'commit_due_at' },
};

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
  const state = STATE_LABEL[ctx.state] ?? ctx.state;
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
 * 时钟推进：把到了点的 ready / dev / test 各推进一步。
 *
 * 一次调用里每行**最多推进一步**：刚从 ready 推到 dev 的行，即使提测日也早就过了，
 * 也要等下一次 tick 才继续走。两步并一步会让事件流里少一条、state_entered_at 少一档，
 * 前端的时间轴就断了。
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
  const today = Math.floor((nowMs + SHANGHAI_OFFSET_MS) / DAY_MS);
  const at = new Date(nowMs).toISOString();

  return db.transaction(async (tx) => {
    const moved: Moved[] = [];

    // left join：没有 release_id 的 ready 行也要被取出来报错，
    // inner join 会让它从结果里消失——正是「静默跳过」。
    const due = await tx.execute<{
      id: string; state: State;
      window_start: string | null; commit_test_at: string | null; commit_due_at: string | null;
    }>(sql`
      select r.id, r.state, rel.window_start, r.commit_test_at, r.commit_due_at
        from requirements r
        left join releases rel on rel.id = r.release_id
       where r.state in ('ready','dev','test')
       order by r.id
         for update of r`);

    for (const row of due.rows) {
      const next = NEXT[row.state as 'ready' | 'dev' | 'test'];
      const day = deadlineDay(row[next.field], {
        requirementId: row.id, state: row.state, field: next.field,
      });
      if (today < day) continue;

      await tx.execute(sql`
        update requirements set state = ${next.to}, state_entered_at = ${at} where id = ${row.id}`);
      await recordEvent(tx, {
        requirementId: row.id, actor: 'system', type: `requirement.auto_${next.to}`,
        payload: { from: row.state, to: next.to, at },
      });
      moved.push({ id: row.id, from: row.state, to: next.to });
    }

    return { moved };
  });
}
