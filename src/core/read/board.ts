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
  /**
   * 最新一份走查材料是哪一天（已折成 MM-DD），没有就是 null。
   *
   * 这是 `live` 那张卡唯一缺的一块数据：判断走查做没做过，靠的是
   * `uemaster_artifacts` 里有没有 `stage='inspect'` 的行。卡片上要显示的是
   * 「已走查 · 11-06」里那个日期，而**不能**由组件自己去查——一张卡一次查询就是
   * 一次 N+1，而且看板与抽屉会对同一件事给出两个答案。所以它跟着那条大 SQL 一起
   * 出来（同一个子查询、同一次排序口径，与 `listArtifacts` 一致：取最新一行）。
   *
   * 放的是**格式化后的**标签而不是原始时间戳：页面不再自己算日期（这条规矩
   * 在这一层已经用了三处：`waiting`、`days`、`atLabel`）。
   */
  inspectAtLabel: string | null;
  /**
   * 这条需求现在要不要你动手 = 「等谁」那一行现在是不是挂在**你**身上。
   *
   * 名字只有一个来源：`waitingFor` 的 `{text, on, who}`，`mine` 就是
   * `on === 'person' && who === me`（裁决 R-mine）。所以主色框与「等谁」那一行
   * 说的是同一件事——旧写法 `owner === me || reviewer === me` 会把「等 吕正豪 评审」
   * 的卡框给负责人王妍，一张卡同时说着两件事。
   *
   * `ready` / `dev` / `test` 的 `on` 是 `clock`（等的是某个日期，时钟会推它），
   * 没人欠谁一个动作；打回、走查、恢复都是可选的。所以「谁都不欠」= 这些卡对任何人
   * 都不是 mine，哪怕你是负责人。
   */
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
  /**
   * 提出人是不是花名册里的人（提出人是自由文本字段，不是外键，所以只能按名字比对）。
   * 收集列靠它决定「谁欠这个动作」：成员才有资格被框，外部提出人在本系统里没有账号。
   */
  requester_is_member: boolean;
  owner: string | null;
  state_entered_at: string;
  window_start: string | null;
  commit_test_at: string | null;
  commit_due_at: string | null;
  reviewer: string | null;
  /**
   * 最新一份走查材料的写入时刻（`stage='inspect'` 的 `created_at`），没有就是 null。
   *
   * 一个相关子查询而不是第二次查询：看板是一次 SQL 取全部需求（见 `getBoard`），
   * 每张卡再问一次「走查做没有」就是 10 列 × N 张卡的往返。子查询的排序口径与
   * `listArtifacts` 逐字一致（`created_at desc, id desc`）：抽屉说「最新那一份」
   * 与看板说「已走查 · 哪一天」必须是同一份，否则重做之后两处会各说各的日期。
   */
  inspect_at: string | null;
};

/**
 * 「等谁」：当前状态卡在哪一步、挂在谁或哪个日期上。
 *
 * 这是整块看板的重点，不是装饰：同一列里等的东西不一样才是真的信息
 * （两条都在待评审，一条等功能线、一条等商业线；两条都在测试中，等的是两个不同的承诺日）。
 *
 * 返回值刻意分成三件（文字 / 等的是人还是时钟 / 具体是谁），而不是只返回一句话：
 * 卡片的主色框（`mine`）**必须由同一个判断派生**（`on === 'person' && who === me`），
 * 否则会出现「等 吕正豪 评审」的卡被框成负责人王妍的——一张卡同时说着两件事。
 * 只要 `who` 是这里唯一的人名来源，文字与框就不可能对不上。
 *
 * 缺席的日期不静默成空字符串：那是越过服务直接写库才会有的数据损坏，
 * 卡片上写「缺提测日」比写一个空标签诚实。这种行 `on: 'none'`——没人欠动作，
 * 该修的是数据。
 */
type Waiting = { text: string; on: WaitingOn; who: string | null };

function waitingFor(row: Row, today: number, inspectAtLabel: string | null): Waiting {
  switch (row.state) {
    case 'inbox':
      // 补必填是提出人的事（提出人是字段，不是账号）。但字段里可以是一个**不在花名册里**的
      // 外部提出人（裁决 R39）：他没有账号，在这个系统里动不了手，卡片框给谁都是假的。
      // 于是收集列分两种：成员提出人 → 「<提出人> 补必填」并框他；非成员 → 「待接单」，
      // on 仍是 'person'（确实在等人，不是等时钟），who 为 null（还没人认领，谁都不框）。
      return row.requester_is_member
        ? { text: `${row.requester} 补必填`, on: 'person', who: row.requester }
        : { text: '待接单', on: 'person', who: null };
    case 'design':
      return row.owner === null
        ? { text: '负责人出正式 PRD', on: 'none', who: null }
        : { text: `${row.owner} 出正式 PRD`, on: 'person', who: row.owner };
    case 'review':
      // 评审人由类型派单决定（spec §2），不是负责人：所以待评审的卡框评审人，不框负责人。
      return row.reviewer === null
        ? { text: '等派单评审人', on: 'none', who: null }
        : { text: `等 ${row.reviewer} 评审`, on: 'person', who: row.reviewer };
    case 'queue':
      return row.owner === null
        ? { text: '等排期', on: 'none', who: null }
        : { text: `${row.owner} 排期`, on: 'person', who: row.owner };
    case 'ready': {
      const day = formatMonthDay(row.window_start);
      return day
        ? { text: `等开工日 ${day}`, on: 'clock', who: null }
        : { text: '缺开工日', on: 'none', who: null };
    }
    case 'dev': {
      const day = formatMonthDay(row.commit_test_at);
      if (!day) return { text: '缺提测日', on: 'none', who: null };
      // 提测日过了还停在开发中：卡片该标红（lateDeadline），但**不欠任何人一个动作**。
      // 时钟会继续推它，打回是可选的；可选动作不产生「你的卡」（裁决 R-mine）。
      return isPastDay(row.commit_test_at, today)
        ? { text: `提测日已过 ${day}`, on: 'clock', who: null }
        : { text: `${day} 提测`, on: 'clock', who: null };
    }
    case 'test': {
      const day = formatMonthDay(row.commit_due_at);
      if (!day) return { text: '缺承诺完成日', on: 'none', who: null };
      // 同上：承诺日过了也只是「等的东西过期了」，不是「负责人欠一个动作」。
      return isPastDay(row.commit_due_at, today)
        ? { text: `承诺日已过 ${day}`, on: 'clock', who: null }
        : { text: `${day} 自动上线`, on: 'clock', who: null };
    }
    case 'live':
      // 走查不改状态（spec §3 末行），也不框任何人，所以 on 一直是 'none'——
      // 但**说什么**是有事实的：材料交回之前是「待走查」，之后是「已走查 · 那天的日期」。
      //
      // 旧写法是一句固定的「可发起走查」：它说的是「你可以动」，不是「这件事做没做」，
      // 于是同一列里做过与没做过的卡长得一模一样，那句话读到最后等于什么都没说。
      return inspectAtLabel === null
        ? { text: '待走查', on: 'none', who: null }
        : { text: `已走查 · ${inspectAtLabel}`, on: 'none', who: null };
    case 'rejected':
    case 'shelved':
      // 恢复 / 无可做：都可选，都不框。
      return { text: '—', on: 'none', who: null };
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
           exists (select 1 from members mr where mr.name = r.requester) as requester_is_member,
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
             limit 1) as reviewer,
           (select ua.created_at
              from uemaster_artifacts ua
             where ua.requirement_id = r.id and ua.stage = 'inspect'
             order by ua.created_at desc, ua.id desc
             limit 1) as inspect_at
      from requirements r
      left join members m on m.id = r.owner_member_id
      left join releases rel on rel.id = r.release_id
     order by r.number`);

  // 列直接建出来，byState 只是它的索引：卡片推进 Map 里的数组，就是推进要返回的那个
  // 数组本身。所以最后一步不必再按 state 查一次，也就不存在「取不到」这条分支。
  const columns: BoardColumn[] = BOARD_STATES.map((state) => ({
    state,
    label: STATE_LABEL[state],
    cards: [],
  }));
  const byState = new Map<State, BoardCard[]>(
    columns.map((c): [State, BoardCard[]] => [c.state, c.cards]),
  );
  for (const row of res.rows) {
    const cards = byState.get(row.state);
    // 不写 `byState.get(...)?.push`：状态加进 State 却忘了加进 BOARD_STATES 时，
    // 那张卡会**静默消失**——一条需求从看板上凭空不见，比一次 500 难查得多。
    if (!cards) {
      throw new AppError(
        'invalid',
        `看板没有「${row.state}」这一列：读模型的列清单与状态机不同步`,
      );
    }
    const inspectAtLabel = formatMonthDay(row.inspect_at);
    const waiting = waitingFor(row, today, inspectAtLabel);
    cards.push({
      id: row.id,
      number: Number(row.number),
      title: row.title,
      owner: row.owner,
      waiting: waiting.text,
      waitingOn: waiting.on,
      late: lateDeadline({
        state: row.state,
        windowStart: row.window_start,
        testAt: row.commit_test_at,
        dueAt: row.commit_due_at,
      }, today),
      days: daysSinceShanghai(row.state_entered_at, today),
      inspectAtLabel,
      // 「现在需要你动手」= 这张卡等的那个人就是你。名字只从 waiting.who 来，
      // 所以主色框与「等谁」那一行说的是同一件事（旧写法 owner||reviewer 会让
      // 「等 吕正豪 评审」的卡被框给负责人）。
      mine: waiting.on === 'person' && waiting.who !== null && waiting.who === who,
    });
  }

  return columns;
}
