import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { STATE_LABEL, type State } from '../state-machine.js';
import { shanghaiDayOf } from '../clock/tick.js';
import { currentMember } from './member.js';

/**
 * 看板的 10 列，顺序就是 spec §3 的流程顺序（从左到右走一遍流程）。
 *
 * 单独列一遍而不是从 STATE_LABEL 的键派生：JS 对象的键序是**声明序**，
 * 今天恰好也是流程序，但那是一份没人维护的巧合。这一行是界面唯一的列序来源，
 * 用例独立把它钉住（tests/read.test.ts 抄的是 spec 里的十个数）。
 */
export const BOARD_STATES: readonly State[] = [
  'inbox', 'design', 'review', 'queue', 'ready', 'dev', 'test', 'live', 'rejected', 'shelved',
];

/** 卡片上「等谁」等的到底是什么：人、时钟、还是什么都不等（终态 / 已上线）。 */
export type WaitingOn = 'person' | 'clock' | 'none';

export type BoardCard = {
  id: string;
  number: number;
  title: string;
  owner: string | null;
  /** 「等谁」那一行：同一列里每张卡都可以不同（这就是看板的设计前提）。 */
  waiting: string;
  waitingOn: WaitingOn;
  /** 正在等的那个日期已经过去了（界面把它标红：等的东西已经过期）。 */
  late: boolean;
  /** 停在当前状态几个上海日历天。 */
  days: number;
  /** 这条需求现在要不要你动手：你是负责人，或你是被派单的评审人。 */
  mine: boolean;
};

export type BoardColumn = { state: State; label: string; cards: BoardCard[] };

const DAY_MS = 24 * 60 * 60 * 1000;

/** 一个时刻的「上海第几天」，时间不合法就抛——静默返回 0 会让整块看板显示「停了 0 天」。 */
export function shanghaiToday(now: Date = new Date()): number {
  const day = shanghaiDayOf(now.toISOString());
  if (day === null) throw new AppError('invalid', '系统时钟不合法，看板无法计算停留天数');
  return day;
}

/**
 * 库里那个时刻落在上海的哪一天 → 'MM-DD'。
 *
 * 不自己算 +08:00：先走 shanghaiDayOf 把它折成整数天，再把那个整数天还原成日期。
 * `new Date(day * DAY_MS)` 这个瞬间的**上海日历日**正好是 day（它是 UTC 零点，
 * 上海是同一天的 08:00），所以 toISOString() 切出来就是上海那天的 MM-DD。
 * 于是「哪一天」这个规则仍然只写在 clock/tick.ts 里一份。
 */
export function formatMonthDay(raw: string | null): string | null {
  if (raw === null) return null;
  const day = shanghaiDayOf(raw);
  if (day === null) return null;
  return new Date(day * DAY_MS).toISOString().slice(5, 10);
}

/** 同一套折算：raw 那天相对「今天」过去几天。raw 不合法或没到今天就返回 0（不显示负数）。 */
export function daysSinceShanghai(raw: string, today: number): number {
  const day = shanghaiDayOf(raw);
  if (day === null) return 0;
  return Math.max(0, today - day);
}

/**
 * 「时间已用 %」：now 在 [from, to] 区间里的位置，夹到 0..100 的整数。
 *
 * 还没开始是 0%，过点是 100%——不输出 -40% 或 137% 这种要读者自己解读的数字。
 * 两端缺失、解析不出来、或区间退化（to <= from）都返回 null：那是「算不出来」，
 * 页面该整段不显示（spec §4：没排期则不显示），而不是显示 0%。
 */
export function percentBetween(
  from: string | null, to: string | null, nowMs: number = Date.now(),
): number | null {
  if (!from || !to) return null;
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  const percent = Math.round(((nowMs - start) / (end - start)) * 100);
  return Math.min(100, Math.max(0, percent));
}

/** raw 那一天是不是已经过去了（严格小于今天：今天到点还没跑 tick 不算逾期）。 */
function isPastDay(raw: string | null, today: number): boolean {
  if (raw === null) return false;
  const day = shanghaiDayOf(raw);
  return day !== null && day < today;
}

/** 一行需求的原始形状（SQL 出来什么样就是什么样）。 */
type Row = {
  id: string;
  number: number;
  title: string;
  state: State;
  requester: string;
  owner: string | null;
  state_entered_at: string;
  window_start: string | null;
  commit_test_at: string | null;
  commit_due_at: string | null;
  reviewer: string | null;
};

/**
 * 「等谁」：当前状态卡在哪一步、挂在谁或哪个日期上。
 *
 * 这是整块看板的重点，不是装饰：同一列里等的东西不一样才是真的信息
 * （两条都在待评审，一条等功能线、一条等商业线；两条都在测试中，一条等承诺日
 * 自动上线、一条承诺日已经过了、在等负责人决定打回）。
 *
 * 缺席的日期不静默成空字符串：那是越过服务直接写库才会有的数据损坏，
 * 卡片上写「缺提测日」比写一个空标签诚实。
 */
function waitingFor(row: Row, today: number): { waiting: string; waitingOn: WaitingOn } {
  const owner = row.owner ?? '负责人';
  switch (row.state) {
    case 'inbox':
      return { waiting: `${row.requester} 补必填`, waitingOn: 'person' };
    case 'design':
      return { waiting: `${owner} 出正式 PRD`, waitingOn: 'person' };
    case 'review':
      return row.reviewer
        ? { waiting: `等 ${row.reviewer} 评审`, waitingOn: 'person' }
        : { waiting: '等派单评审人', waitingOn: 'person' };
    case 'queue':
      return { waiting: `${owner} 排期`, waitingOn: 'person' };
    case 'ready': {
      const day = formatMonthDay(row.window_start);
      return day
        ? { waiting: `等开工日 ${day}`, waitingOn: 'clock' }
        : { waiting: '缺开工日', waitingOn: 'none' };
    }
    case 'dev': {
      const day = formatMonthDay(row.commit_test_at);
      if (!day) return { waiting: '缺提测日', waitingOn: 'none' };
      return isPastDay(row.commit_test_at, today)
        ? { waiting: `提测日已过 ${day}，等提测`, waitingOn: 'person' }
        : { waiting: `${day} 提测`, waitingOn: 'clock' };
    }
    case 'test': {
      const day = formatMonthDay(row.commit_due_at);
      if (!day) return { waiting: '缺承诺完成日', waitingOn: 'none' };
      // 承诺日过了还没上线，只有两种可能：时钟没跑到，或者这条该被打了回。
      // 两种都落在人身上，所以这里等的是人，不是时钟。
      return isPastDay(row.commit_due_at, today)
        ? { waiting: `承诺日已过 ${day}，等 ${owner} 打回`, waitingOn: 'person' }
        : { waiting: `${day} 自动上线`, waitingOn: 'clock' };
    }
    case 'live':
      // 「可发起走查」不是有人在等，是「你可以动」：走查不改状态（spec §3 末行）。
      return { waiting: '可发起走查', waitingOn: 'none' };
    case 'rejected':
    case 'shelved':
      return { waiting: '—', waitingOn: 'none' };
  }
}

/**
 * 逾期：这个状态正在等的那个日期已经过去了（开工日 / 提测日 / 承诺完成日）。
 *
 * 只对会被时钟推进的三个状态有意义——它们的「等谁」本来就是某个日期，
 * 「日期已过还停在这里」就是这块看板唯一诚实的风险信号：时钟没跑到，或者这条
 * 该被人打回了。其它状态没有「等到期」这回事（终态、待评审等的是人）。
 *
 * 导出给版本页复用：两页对「延期」必须给同一个答案，否则同一条需求在看板上标红、
 * 在版本页上却是「在期」。strictly 小于今天：今天到点、tick 还没跑满一轮不算逾期。
 */
export function lateDeadline(
  row: { state: State; windowStart: string | null; testAt: string | null; dueAt: string | null },
  today: number,
): boolean {
  switch (row.state) {
    case 'ready':
      return isPastDay(row.windowStart, today);
    case 'dev':
      return isPastDay(row.testAt, today);
    case 'test':
      return isPastDay(row.dueAt, today);
    default:
      return false;
  }
}

/**
 * 看板：一条 SQL 取全部需求，按状态分组在 JS 里做。
 *
 * 一条 SQL 的理由：10 列 × 每列一次查询 = 11 次往返，而且列之间的排序口径会分叉。
 * 分组、排序、算天数都是纯内存，行数只有几十到几百（这是「一个团队的需求」，
 * 不是日志表）；真涨到需要分页时，改的是这一条 SQL 的 where。
 *
 * left join（不是 inner join）：没有负责人、没有版本、没有派单的需求必须出现在看板上
 * ——它们是「还卡在收集 / 等排期」的常态，不是脏数据。
 *
 * `me` 不给就向 cookie 要（页面用）；给了就按它算 `mine`（用例与脚本用这个口子，
 * 免得为了测一行标签去伪造一个请求上下文）。
 */
export async function getBoard(me?: string): Promise<BoardColumn[]> {
  const who = me ?? (await currentMember());
  const today = shanghaiToday();

  const res = await db.execute<Row>(sql`
    select r.id,
           r.number,
           r.title,
           r.state,
           r.requester,
           r.state_entered_at,
           r.commit_test_at,
           r.commit_due_at,
           rel.window_start,
           m.name as owner,
           (select m2.name
              from review_assignments ra
              join members m2 on m2.id = ra.reviewer_member_id
             where ra.requirement_id = r.id and ra.verdict = 'handed'
             order by ra.id
             limit 1) as reviewer
      from requirements r
      left join members m on m.id = r.owner_member_id
      left join releases rel on rel.id = r.release_id
     order by r.number`);

  const byState = new Map<State, BoardCard[]>(BOARD_STATES.map((s) => [s, []]));
  for (const row of res.rows) {
    const { waiting, waitingOn } = waitingFor(row, today);
    byState.get(row.state)?.push({
      id: row.id,
      number: Number(row.number),
      title: row.title,
      owner: row.owner,
      waiting,
      waitingOn,
      late: lateDeadline({
        state: row.state,
        windowStart: row.window_start,
        testAt: row.commit_test_at,
        dueAt: row.commit_due_at,
      }, today),
      days: daysSinceShanghai(row.state_entered_at, today),
      // 需要你动手的两种身份：这条需求的负责人，或它派单到的评审人。
      // 只比姓名，不比 id：actor 在全链路都是姓名（events.actor、服务入参都是）。
      mine: who.length > 0 && (row.owner === who || row.reviewer === who),
    });
  }

  return BOARD_STATES.map((state) => ({
    state,
    label: STATE_LABEL[state],
    cards: byState.get(state) ?? [],
  }));
}
