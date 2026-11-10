import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { STATE_LABEL, type State } from '../state-machine.js';
import { DEADLINE_LABEL, shanghaiDayOf, type DeadlineField } from '../clock/tick.js';
import { currentMember } from './member.js';
import { memberByName } from '../auth/members.js';
import { can } from '../auth/roles.js';
import { NO_FILTER, type BoardFilter } from './board-filter.js';

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
  /**
   * 这条需求**还差哪些日期**才能真正走完时钟（空数组 = 一天不缺）。
   *
   * 为什么要有这一格，而不是让界面去读 `waiting` 里的字符串：`waiting` 只说得出
   * 「这一行今天卡在哪天」（`ready` 卡开工日、`dev` 卡提测日、`test` 卡承诺完成日），
   * 而缺日期是一个**结构性**的问题——`ready` 缺提测日的行，开工日那天照样会推进到
   * `dev`，然后永远冻在那里。所以卡片要把「还差哪几天」说出来（见 `missingDeadlines`），
   * 界面也能拿这一格做样式（今天只用来拼 `waiting` 那句话）。
   */
  missingDates: DeadlineField[];
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
  /**
   * 这张卡现在能不能被你认领（P4-08）。
   *
   * 只有「无主 + 收集」的卡为 true，且**由服务层的 `can('claim')` 算**——看板不自己
   * 推这一段。把它放在读模型里而不是让组件去判断的理由与 `mine` 相同：同一个问题
   * 只能有一个答案，抽屉里那个「认领」按钮与卡片上这个必须同时出现、同时消失。
   */
  claimable: boolean;
  /**
   * 这条需求是不是**不在 v1 承诺里**（= 状态不是 `inbox`），卡片上因此要标一行
   * 「v1 暂未开放」（`features.ts` 的 `V1_CLOSED_MARK`）。
   *
   * 为什么是读模型算、而不是卡片拿 `state !== 'inbox'` 自己判：判据只有一条，但读的人
   * 有卡片、抽屉、以后的 MCP 三处。写在读模型里，三处说的是同一件事；写在组件里，
   * 下一个人加第四个读侧时就得再抄一遍那个比较，抄漏一处就是「卡片说没开放、抽屉说
   * 能用」。
   *
   * 为什么不是「藏起来」：owner 的裁决（`2026-11-10-v1-scope.md` §三）是全部照常显示、
   * 每条标一行——藏起来会让人以为数据丢了。
   */
  v1Closed: boolean;
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
 *
 * ## 缺日期：点名「还差哪几天」，不是「今天卡在哪天」
 *
 * 三个时钟状态的驱动日期只有一个（见 `missingDeadlines`），但**能不能走完**要的
 * 不止一个：`ready` 走一步就改读提测日。所以判定用的是「还差哪几天」这一组，
 * 而不是当前状态那一个空格——否则一条缺提测日的 ready 卡会显示「等开工日 11-14」，
 * 看起来完全正常，等到开工日到了、被推到开发中才第一次露出「缺提测日」。
 *
 * 这一格的代价是：`ready` 缺提测日时卡片不再显示「等开工日 几号」。这是**刻意的**——
 * 它此刻最该被看到的事实是「这条排期没填完」，而不是「它在等 11-14」。
 */
type Waiting = { text: string; on: WaitingOn; who: string | null };

/**
 * 三个时钟状态**各自需要哪些日期**才能一路被时钟推下去。
 *
 * 口径来自两处，缺一不可：
 *
 * - `clock/tick.ts` 的 `DEADLINE_FIELD`（当前状态读哪一列推进）；
 * - 裁定 6（2026-11-08）：一条 `ready` 行只差一步就会进 `dev`，而 `dev` 读提测日。
 *   所以「提测日为空的 ready 行」也是走不完的行——它只是把冻结推迟了一步。
 *   健康的 ready 行不会有这种形状：`schedule` 一次写三个日期，三个都不许空。
 *
 * `commit_due_at` 不在 `ready` 的清单里：从 ready 到 test 之间还有一次调度机会
 * （dev 里填/改日期），而提测日是 ready 一推进就要读的那一列。不多列，避免把
 * 「还远着的缺失」也标成红字——那种提示很快就没人看了。
 *
 * 只有 `deleted_at is null` 的行会出现在看板上，软删除的行不进这里。
 */
const REQUIRED_DEADLINES: Partial<Record<State, readonly DeadlineField[]>> = {
  ready: ['window_start', 'commit_test_at'],
  dev: ['commit_test_at', 'commit_due_at'],
  test: ['commit_due_at'],
};

/**
 * 这条需求还差哪些日期（空数组 = 不缺）。日期列存在但解析不出来也算缺：
 * `shanghaiDayOf` 返回 null 的字符串在 tick 里同样会抛 `clock_bad_deadline`，
 * 那就等于「没有这个日期」。
 *
 * 导出给用例与别处复用：这条口径只能有一份，卡片、用例、以后的提醒都读它。
 */
export function missingDeadlines(row: {
  state: State;
  window_start: string | null;
  commit_test_at: string | null;
  commit_due_at: string | null;
}): DeadlineField[] {
  const required = REQUIRED_DEADLINES[row.state];
  if (!required) return [];
  return required.filter((field) => {
    const raw = row[field];
    return raw === null || shanghaiDayOf(raw) === null;
  });
}

/** 「缺开工日」「缺提测日、承诺完成日」——词表取自时钟模块，与 tick 的报错同一份。 */
function missingText(missing: readonly DeadlineField[]): string {
  return `缺${missing.map((field) => DEADLINE_LABEL[field]).join('、')}`;
}

function waitingFor(
  row: Row, today: number, inspectAtLabel: string | null, missing: readonly DeadlineField[],
): Waiting {
  // 三个时钟状态共用同一条前置判断：缺任何一天就先说缺，别说「在等哪天」。
  // 放在 switch 外面而不是每个 case 里抄一遍，是为了让「缺日期优先于等日期」这条
  // 顺序只写一次（三个 case 里各写一次，早晚有一个忘了）。
  if (missing.length > 0 && (row.state === 'ready' || row.state === 'dev' || row.state === 'test')) {
    return { text: missingText(missing), on: 'none', who: null };
  }
  switch (row.state) {
    case 'inbox':
      // 补必填是提出人的事（提出人是字段，不是账号）。但字段里可以是一个**不在花名册里**的
      // 外部提出人（裁决 R39）：他没有账号，在这个系统里动不了手，卡片框给谁都是假的。
      // 于是收集列分两种：成员提出人 → 「<提出人> 补必填」并框他；非成员 → 「待接单」，
      // on 仍是 'person'（确实在等人，不是等时钟），who 为 null（还没人认领，谁都不框）。
      return row.requester_is_member
        ? { text: `${row.requester} 补必填`, on: 'person', who: row.requester }
        // 有主就不再是「待接单」——认领之后它挂在负责人身上，下一步是立项。
        : (row.owner !== null
          ? { text: `${row.owner} 立项`, on: 'person', who: row.owner }
          : { text: '待接单', on: 'person', who: null });
    case 'design':
      return row.owner === null
        ? { text: '负责人出正式 PRD', on: 'none', who: null }
        : { text: `${row.owner} 出正式 PRD`, on: 'person', who: row.owner };
    case 'review':
      // 评审人由**负责人所在条线**派单决定（P4-06），不是需求类型：所以待评审的卡
      // 框评审人，不框负责人。
      if (row.reviewer !== null) {
        return { text: `等 ${row.reviewer} 评审`, on: 'person', who: row.reviewer };
      }
      // 没有派单行：P4-06 之后唯一合法的原因，是负责人自己**没有条线**（超管提的需求），
      // 而超管不受派单限制——签它的是超管。写「等派单评审人」会让人以为系统还会派一次。
      return row.owner === null
        ? { text: '等派单评审人', on: 'none', who: null }
        : { text: '等超管评审', on: 'none', who: null };
    case 'queue':
      return row.owner === null
        ? { text: '等排期', on: 'none', who: null }
        : { text: `${row.owner} 排期`, on: 'person', who: row.owner };
    case 'ready': {
      // 走到这里 missing 一定是空的（开工日与提测日都在，见上面的前置判断），
      // 所以 day 不会为 null；'未定' 只是给类型一个不撒谎的兜底，正常数据走不到。
      const day = formatMonthDay(row.window_start) ?? '未定';
      return { text: `等开工日 ${day}`, on: 'clock', who: null };
    }
    case 'dev': {
      const day = formatMonthDay(row.commit_test_at) ?? '未定';
      // 提测日过了还停在开发中：卡片该标红（lateDeadline），但**不欠任何人一个动作**。
      // 时钟会继续推它，打回是可选的；可选动作不产生「你的卡」（裁决 R-mine）。
      return isPastDay(row.commit_test_at, today)
        ? { text: `提测日已过 ${day}`, on: 'clock', who: null }
        : { text: `${day} 提测`, on: 'clock', who: null };
    }
    case 'test': {
      const day = formatMonthDay(row.commit_due_at) ?? '未定';
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
 * 一次看板读取的完整结果：十列 + 两个数字（工具条上那行「筛出 N / M」）。
 *
 * 为什么不只返回十列：`N` 可以数卡片得到，`M` 不行——它是**全库**未删需求数，
 * 与这次筛选无关，任何一列里都没有它的痕迹。所以它必须由读模型一起给出，
 * 页面不许自己再连库算一次（那会是第二份口径，筛完分母对不上分子时没人查得出来）。
 */
export type BoardView = {
  columns: BoardColumn[];
  /** 筛后还剩几条 = 十列卡片数之和。 */
  shown: number;
  /** 全库未删需求总数（分母）。筛选不影响它。 */
  total: number;
  /**
   * 这次 SQL **返回了多少行**。
   *
   * 与 `shown` 永远相等——除非哪天有人把过滤搬回 JS：那种实现下 `scanned` 仍是
   * 全库行数（815），而 `shown` 只有筛出来的十几条，于是两个数自己说了实话。
   * 它是留给「过滤到底在不在库里」这条用例的证词，页面不显示它。
   */
  scanned: number;
};

/**
 * 筛选条件 → SQL 的 where。
 *
 * 为什么要在 SQL 里做，而不是取回 815 行再 `.filter()`：**列头那个计数**就是被筛的
 * 那个数。JS 过滤只能改卡片，要改计数就得在页面里再数一遍，于是「这一列有几条」
 * 有两个来源；而筛选是全局的（筛「未指定负责人」时，收集列从 284 条变成十几条），
 * 那是一块板子的形状，不是一个列表的截断。
 *
 * 三个条件各占一个子句，`sql.join` 拼起来，参数全部走绑定：
 *
 * - `q`：只打在 `r.title` 上（`ilike`，ASCII 大小写不敏感、中文原样子串）。
 *   **不搜编号、不搜六问**——这是 owner 的裁决，理由写在 `board-filter.ts` 文件头。
 *   搜索词里的 `%` `_` `\` 先转义：用户输入的是**字面量**，一个 `%` 不该变成
 *   「匹配一切」。
 * - `owner=me`：用已经 join 上的 `m.name`（`m` 就是 `r.owner_member_id` 那一行）。
 *   **必须**走这个判断而不是 `r.owner_member_id = <我> and ...` 之类的重写：
 *   同一条口径写在两处，早晚一处改了另一处没改。
 * - `owner=<id>`：绑定成 `uuid`。解析器只放行 UUID 形状（`board-filter.ts`），
 *   所以这里的 `::uuid` 不会因为手改的 URL 而炸。
 */
function boardWhere(filter: BoardFilter, viewer: string): SQL {
  const clauses: SQL[] = [sql`r.deleted_at is null`];

  if (filter.q !== '') {
    // `%` `_` 是 LIKE 的通配符，`\` 是它的转义符（PG 默认）。三者都要转成字面量，
    // 否则搜「100%」会匹配到全部。反斜杠必须**先**转（顺序写反会把刚加上的 \ 再转一遍）。
    const literal = filter.q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    clauses.push(sql`r.title ilike ${`%${literal}%`}`);
  }

  switch (filter.owner.kind) {
    case 'me':
      clauses.push(sql`m.name = ${viewer}`);
      break;
    case 'none':
      clauses.push(sql`r.owner_member_id is null`);
      break;
    case 'member':
      clauses.push(sql`r.owner_member_id = ${filter.owner.id}::uuid`);
      break;
    case 'all':
      break;
  }

  return sql.join(clauses, sql` and `);
}

/**
 * 看板：一条 SQL 取（筛后的）全部需求，按状态分组在 JS 里做。
 *
 * 一条 SQL 的理由：10 列 × 每列一次查询 = 11 次往返，而且列之间的排序口径会分叉。
 * 分组、排序、算天数都是纯内存；筛选不进这一步——它在 where 里（见 `boardWhere`），
 * 所以到这里的时候，内存里**从来没有**过没筛的行。
 *
 * left join（不是 inner join）：没有负责人、没有版本、没有派单的需求必须出现在看板上
 * ——它们是「还卡在收集 / 等排期」的常态，不是脏数据。
 *
 * `me` 不给就向 cookie 要（页面用）；给了就按它算 `mine`（用例与脚本用这个口子，
 * 免得为了测一行标签去伪造一个请求上下文）。
 */
export async function readBoard(
  me?: string, filter: BoardFilter = NO_FILTER,
): Promise<BoardView> {
  const who = me ?? (await currentMember());
  const today = shanghaiToday();
  /**
   * 「我能不能认领无主需求」——一次算好，逐卡复用。
   *
   * 判据与抽屉里那个按钮同源（`can(..., 'claim')`），所以卡片上出现「认领」时，
   * 打开抽屉也一定有「认领」；反过来也一样。权限在别处再推一遍，就会长出两个答案。
   */
  const viewer = await memberByName(db, who);
  const canClaim = can(viewer, { ownerMemberId: null, ownerLine: null, state: 'inbox' }, 'claim');

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
      -- 软删除的版本 join 不上：那条需求的排期字段仍在（历史事实），但版本名与
      -- 开工日不该再出现在卡片上（P4-02 的「删掉的版本从看板标签里消失」）。
      left join releases rel on rel.id = r.release_id and rel.deleted_at is null
     where ${boardWhere(filter, who)}
     order by r.number`);

  /**
   * 分母：全库未删需求数。
   *
   * 单独一条而不是塞进上面那条 `count(*) over ()` 或一个相关子查询：窗口函数给的是
   * **筛后**的计数（那是分子），相关子查询在空结果时连一行都返回不出来——而
   * 「筛出 0 / 815」正是最需要分母的时刻。两个数本来就是两件事，两条查询各算各的。
   * where 复用 `boardWhere(NO_FILTER, …)`：两边对「什么算一条需求」只有一个来源，
   * 否则手改一次判断就会出现「筛出 12 / 814」这种没人说得清的分母。
   */
  const totalRes = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
      from requirements r
      left join members m on m.id = r.owner_member_id
     where ${boardWhere(NO_FILTER, who)}`);

  // 列直接建出来，byState 只是它的索引：卡片推进 Map 里的数组，就是推进要返回的那个
  // 数组本身。所以最后一步不必再按 state 查一次，也就不存在「取不到」这条分支。
  //
  // 十列**无论筛出几条都要全建**：某列筛完是 0 条时列仍然在（计数显示 0）。
  // 按结果动态删列会让看板每筛一次就换一个形状，而「收集列还在、只是空的」本身
  // 就是一条信息（那一步现在没事可做），比「列消失了」有用得多。
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
    // 缺日期先算一次，`waiting` 与卡片上那一格读同一份：两处各算一次就迟早会说
    // 两个不同的答案（「卡片说缺提测日、waiting 说等开工日」）。
    const missing = missingDeadlines(row);
    const waiting = waitingFor(row, today, inspectAtLabel, missing);
    cards.push({
      id: row.id,
      number: Number(row.number),
      title: row.title,
      owner: row.owner,
      waiting: waiting.text,
      waitingOn: waiting.on,
      missingDates: missing,
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
      // 认领：无主 + 收集 + 我确实有 claim 权限。**不在这里推权限**——直接问 `can()`，
      // 与抽屉里那个「认领」按钮问的是同一个函数（两个入口不可能一个有一个没有）。
      claimable: row.owner === null && row.state === 'inbox' && canClaim,
      // v1 只承诺「收集」那一条链（评估）。别的状态照常显示、照常可点开，
      // 只是多一行字说明这一版没开放——见 `BoardCard.v1Closed` 与 `features.ts`。
      v1Closed: row.state !== 'inbox',
    });
  }

  return {
    columns,
    shown: res.rows.length,
    total: Number(totalRes.rows[0]?.n ?? 0),
    scanned: res.rows.length,
  };
}

/**
 * 只看十列的旧签名（MCP 与用例都在用）。
 *
 * `filter` 是可选的第二参数：不传就是「不筛」，与这个文件以前的行为逐字一致。
 * 新代码要分母（工具条上那行「筛出 N / M」）时用 `readBoard`——它多给两个数字，
 * 别的没有区别。
 */
export async function getBoard(
  me?: string, filter: BoardFilter = NO_FILTER,
): Promise<BoardColumn[]> {
  return (await readBoard(me, filter)).columns;
}
