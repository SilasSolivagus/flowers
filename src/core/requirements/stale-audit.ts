/**
 * 「没有负责人 + 很久没人动」的分桶口径（2026-11-08 的审计，与后续「批量拒绝」迁移的取数依据）。
 *
 * 这个模块**只读、纯函数**：喂它两串行（没有负责人的需求、全部未删需求），它返回三个桶的
 * 计数、B 桶的逐行清单、以及 owner 会追问的四组交叉统计。脚本 `scripts/stale-audit.ts`
 * 负责查库与打印，`tests/stale-audit.test.ts` 拿内存里的行钉住口径——所以「哪些算过期」
 * 只写在这一处，不散在 SQL 与文档里。
 *
 * ## 为什么不能照字面用 `max(events.at)`
 *
 * 任务书的初稿口径是「任何一条 `events` 行都算活动」。照字面实现的结果是**一条都判不出来**：
 *
 * - 库里 865 条事件，其中 **803 条是 `requirement.migrated`**，全部由 `migrate-flower`
 *   在 2026-11-07 那一天写入（`scripts/migrate-flower.ts` 的 `apply()`，每个搬来的需求
 *   一条，记它「从哪条搬来的」）；
 * - 于是 802 条迁移需求**每条都有一个「最后活动 = 2026-11-07」**，而那一天距今不到 180 天
 *   —— 195 条全部落进 A「真需要人领」，B 是空的，报告就是一张废纸。
 *
 * 一条「我从老系统搬进来」的记账事件不是活动：它记的是**搬运工的时间**，不是这条需求
 * 被人碰过的时间。所以 `IMPORT_EVENT_TYPE` 从活动里剔除。剔除之后 195 条里只有 1 条还有
 * 别的业务事件（一条演示数据在 2026-11-07 的 `requirement.created`），其余的活动信号
 * 全部来自 `state_entered_at` 这一列——它在迁移时装的是**老系统的 `state_changed_at`**
 * （`scripts/migrate-flower.ts` 的 insert 里 `${row.state_changed_at}`），2026-03-12 到
 * 2026-11-07 逐日分散，是真时间，不是搬运时间。
 *
 * 这就是口径的全部承重点：**活动 = max(业务事件的最新 at, state_entered_at)**，记账事件
 * 不算。删掉 `IMPORT_EVENT_TYPE` 那一条过滤，B 桶立刻从 41 掉到 0（用例钉住了这件事，
 * 见 `tests/stale-audit.test.ts` 的变异用例）。
 *
 * ## 为什么终态要单独数
 *
 * `rejected` / `shelved` / `live` 是**终态**（Ruling 2，见 `requirements/terminal.ts` 与
 * 迁移 0021 / 0023）：终态是结论，不是流程位置，没有负责人只说明「当年谁负责没记录」。
 * 它们确实「没有负责人」，也确实在该审计的范围里，但**不该被推进群里让人领、更不该被
 * 批量拒绝**（一个已经上线的东西「再拒绝一次」是数据事故）。所以桶照实分，另给一组
 * `actionable`（非终态）的计数：那才是「推群 / 批量拒绝」真正的候选集。
 */
import { shanghaiDayOf } from '../clock/tick.js';

/**
 * 时效线：**180 天**（半年）。
 *
 * 小于它算「可能还在等人领」（A），大于等于算「疑似过期」（B）。半年这个数不是算出来的，
 * 是 owner 的一句话：「三个月没动的需求，人已经不在了；半年没动的，业务也不是那个业务了」。
 * 改这个数只改这里，报告里的「停了几天」与边界都会跟着走。
 */
export const STALE_DAYS = 180;

/** 一天多少毫秒。与 `clock/tick.ts` 的 `DAY_MS` 同一个数，理由同上（只在这里用一次）。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 迁移记账事件：**不算活动**。
 *
 * 唯一一个被排除的事件类型，理由见文件头。它由 `scripts/migrate-flower.ts` 写入、
 * actor 恒为 `migrate-flower`；这里按 `type` 排除而不是按 actor，因为「搬运」是一个
 * 事件语义（`classes.ts` 把它归到 `change` 类），而 actor 只是谁按下了按钮。
 */
export const IMPORT_EVENT_TYPE = 'requirement.migrated';

/**
 * 终态：结论，不是流程位置。
 *
 * 与迁移 0021（`ownerless_to_inbox`）/ 0023（`restore_ownerless_terminal_states`）同一份
 * 词表：那两次迁移把「没有负责人的行」拉回收集，**只拉非终态**。抄成常量而不是每次
 * `state !== 'rejected' && …`，是为了让「终态是哪几个」在这里能被一眼看到。
 */
export const TERMINAL_STATES: readonly string[] = ['rejected', 'shelved', 'live'];

/** 一条没有负责人的需求（脚本查出来的形状）。时间一律是 `db.execute` 返回的字符串。 */
export type AuditRow = {
  id: string;
  number: number;
  title: string;
  state: string;
  /** 进这个状态的时刻（迁移行装的是老系统的 `state_changed_at`）。 */
  stateEnteredAt: string;
  prdUrl: string | null;
  source: string | null;
  platforms: string[];
  /** 业务事件（已剔除 `IMPORT_EVENT_TYPE`）里最新的一条；一条都没有时为 null。 */
  lastEventAt: string | null;
};

/** 判定「同题」「是否撞上已上线」要看的全量未删需求（只需要这四列）。 */
export type LiveRow = {
  id: string;
  number: number;
  title: string;
  state: string;
};

export type Bucket = 'A' | 'B';

/** B 桶的一行：报告里那张表的全部字段，也是「批量拒绝」迁移要吃掉的那份清单。 */
export type StaleRow = {
  id: string;
  number: number;
  title: string;
  state: string;
  /** 终态行：分桶照实算，但它不在批量拒绝的候选集里。 */
  terminal: boolean;
  /** 最后活动的日历日（Asia/Shanghai），'YYYY-MM-DD'。 */
  lastActivityAt: string;
  /** 最后活动来自哪儿：`event`（业务事件）或 `state`（进状态的时刻）。 */
  lastActivityFrom: 'event' | 'state';
  /** 停了几天：按北京时间日历日相减，与界面上「停留 N 天」同口径。 */
  idleDays: number;
  /** 一条业务事件都没有——B 桶里最强的那档信号（任务书里的 C）。 */
  hasEvents: boolean;
  prdUrl: string | null;
  source: string | null;
  platforms: string[];
};

/** 同题组：同一份标题下有多条未删需求（可能是重复录入）。 */
export type DuplicateGroup = {
  /** 归一后的标题（trim + 连续空白压成一个空格）。 */
  title: string;
  /** 组内每条：编号 + 状态 + 有没有负责人。 */
  rows: Array<{ number: number; state: string; ownerless: boolean }>;
  /** 组内有几条是没负责人的（只有 ≥1 才有意义，0 的组不进结果）。 */
  ownerlessCount: number;
  /** 组内全部行都没负责人——「拒绝其中一条」最干净的候选。 */
  allOwnerless: boolean;
};

export type CountRow = { key: string; count: number; stale: number };

export type Audit = {
  /** 跑这一遍的时刻（ISO）。 */
  now: string;
  /** 时效线那一刻（ISO）：最后活动早于它就是 B。 */
  cutoff: string;
  /**
   * 时效线的**北京日历日**（'YYYY-MM-DD'）。
   *
   * 为什么要单独一个字段：报告里「停了几天」是北京日历日相减，而 `cutoff` 是 UTC 的
   * ISO 串——同一时刻在 UTC 与 +08:00 下可能差一天。两个日子摆在同一份报告里必须
   * 用同一个日历，否则「截止 05-11」与「停了 241 天」互相矛盾。
   */
  cutoffDay: string;
  staleDays: number;
  /** 范围：未删 + 没有负责人。 */
  total: number;
  buckets: {
    /** A：180 天内有活动。 */
    fresh: number;
    /** B：180 天（含）没有任何活动。 */
    stale: number;
    /** C ⊂ B：一条业务事件都没有。 */
    noEvents: number;
  };
  /** 终态行的分布（它们也在 total 里，但不该被推群 / 批量拒绝）。 */
  terminal: { total: number; byState: CountRow[] };
  /** 非终态：真正的候选集。 */
  actionable: { total: number; fresh: number; stale: number };
  /** B 桶逐行，最旧的排在前面。 */
  staleRows: StaleRow[];
  cross: {
    /** 有没有 PRD 链接（没有 PRD 的需求即使被领走也进不了评审——状态机的 prd 门禁）。 */
    prd: { withPrd: number; withoutPrd: number; actionableWithPrd: number };
    /**
     * 与另一条未删需求同题（可能的重复录入）。
     *
     * `totalGroups` 是**全库**的组数（含组内全部有负责人的组），`groups` 只留「组里有
     * 没负责人的行」的那些——后者才是这份审计能动的，前者回答「库里一共多少重复」。
     */
    duplicateTitles: { totalGroups: number; groups: DuplicateGroup[]; ownerlessRows: number };
    /** 来源分布（`null` 归到「未标注」）。 */
    source: CountRow[];
    /** 平台分布：**按勾选计次**，一条需求勾了 3 个端就算 3 次，所以各行相加 > total。 */
    platform: CountRow[];
    /** 标题撞上一条「已上线」的另一条需求（口径见 `shippedAdjacent`）。 */
    shippedAdjacent: { count: number; numbers: number[] };
    /** 本次审计里没有产出的交叉：留给 owner 的不是数字，是一句「没法算」。 */
    skipped: string[];
  };
};

/** 归一标题：trim + 连续空白压成一个空格。**不**做大小写 / 全半角 / 同义词归一。 */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ');
}

/** 字符串时间 → 毫秒；解析不出来返回 null（不猜）。 */
function ms(text: string | null): number | null {
  if (text === null) return null;
  const value = new Date(text).getTime();
  return Number.isNaN(value) ? null : value;
}

/** 毫秒 → 北京时间的日历日标签 'YYYY-MM-DD'。与 `shanghaiDayOf` 同一套 +08:00 口径。 */
export function shanghaiDayLabel(value: number): string {
  return new Date(value + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * 一条需求的活动时刻。
 *
 * `state.entered.at` 一定有值（列 not null），业务事件可能一条都没有，所以「取大」只需要
 * 处理一边为空：为空即 -Infinity，让 state 那边赢。
 *
 * 返回 `{ at, from }`：`from` 要写进报告——「最后活动来自事件」与「最后活动来自进状态
 * 的那一刻」是两种证据，前者是人真的动过，后者只能说明流程在那一刻挪了一格。
 */
export function activityOf(row: AuditRow): { at: number; from: 'event' | 'state' } {
  const stateAt = ms(row.stateEnteredAt) ?? Number.NEGATIVE_INFINITY;
  const eventAt = ms(row.lastEventAt);
  if (eventAt !== null && eventAt > stateAt) return { at: eventAt, from: 'event' };
  return { at: stateAt, from: 'state' };
}

/** 活动是否在时效线之内（**边界归 A**：恰好 180 天算还活着）。 */
export function isFresh(activityAt: number, nowMs: number): boolean {
  return activityAt >= nowMs - STALE_DAYS * DAY_MS;
}

/** 停了多少天：北京时间日历日相减，负数夹到 0（时钟偏差不该显示成「未来」）。 */
export function idleDays(activityAt: number, nowMs: number): number {
  const from = shanghaiDayOf(new Date(activityAt).toISOString());
  const to = shanghaiDayOf(new Date(nowMs).toISOString());
  if (from === null || to === null) return 0;
  return Math.max(0, to - from);
}

function isTerminal(state: string): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * 主函数：两串行 + 一个「现在」，返回整份审计。
 *
 * `now` 由调用方传（不在这里 `Date.now()`）：报告要能复现——同一份数据、同一个 now，
 * 跑两遍必须逐字节一样，否则「停了几天」每次都不一样，diff 里全是噪音。
 */
export function buildAudit(input: {
  ownerless: AuditRow[];
  live: LiveRow[];
  now: Date;
}): Audit {
  const nowMs = input.now.getTime();
  const cutoffMs = nowMs - STALE_DAYS * DAY_MS;

  const ownerlessIds = new Set(input.ownerless.map((row) => row.id));

  // 标题 → 全部未删需求。写进 Map 是为了让「同题」与「撞上已上线」共用一次分组，
  // 也为了让两条交叉（重复录入 / 已上线）用同一份归一规则。
  const byTitle = new Map<string, LiveRow[]>();
  for (const row of input.live) {
    const key = normalizeTitle(row.title);
    const bucket = byTitle.get(key);
    if (bucket === undefined) byTitle.set(key, [row]);
    else bucket.push(row);
  }

  const staleRows: StaleRow[] = [];
  const terminalByState = new Map<string, number>();
  const sourceCounts = new Map<string, { count: number; stale: number }>();
  const platformCounts = new Map<string, { count: number; stale: number }>();
  let fresh = 0;
  let stale = 0;
  let noEvents = 0;
  let terminalTotal = 0;
  let actionableTotal = 0;
  let actionableFresh = 0;
  let actionableStale = 0;
  let withPrd = 0;
  let actionableWithPrd = 0;
  let duplicateOwnerless = 0;
  const duplicateGroups: DuplicateGroup[] = [];

  for (const row of input.ownerless) {
    const activity = activityOf(row);
    const rowFresh = isFresh(activity.at, nowMs);
    const terminal = isTerminal(row.state);
    const key = normalizeTitle(row.title);

    // 来源：null 是「未标注」（`requirements/source.ts` 的口径），不是「其他」。
    const sourceKey = row.source ?? '（未标注）';
    const sourceCell = sourceCounts.get(sourceKey) ?? { count: 0, stale: 0 };
    sourceCell.count += 1;
    if (!rowFresh) sourceCell.stale += 1;
    sourceCounts.set(sourceKey, sourceCell);

    // 平台：空数组是「未标注」；否则每个端各计一次（一条需求可以有多个端）。
    if (row.platforms.length === 0) {
      const cell = platformCounts.get('（未标注）') ?? { count: 0, stale: 0 };
      cell.count += 1;
      if (!rowFresh) cell.stale += 1;
      platformCounts.set('（未标注）', cell);
    } else {
      for (const platform of row.platforms) {
        const cell = platformCounts.get(platform) ?? { count: 0, stale: 0 };
        cell.count += 1;
        if (!rowFresh) cell.stale += 1;
        platformCounts.set(platform, cell);
      }
    }

    if (row.prdUrl !== null && row.prdUrl.trim() !== '') {
      withPrd += 1;
      if (!terminal) actionableWithPrd += 1;
    }

    if (terminal) {
      terminalTotal += 1;
      terminalByState.set(row.state, (terminalByState.get(row.state) ?? 0) + 1);
    } else {
      actionableTotal += 1;
      if (rowFresh) actionableFresh += 1;
      else actionableStale += 1;
    }

    // 同题：只数「组里至少还有另一条未删需求」的情况。`byTitle` 里必然包含自己，
    // 所以「同题」等价于该标题下 > 1 行。全都没负责人的组另算——那才是
    // 「拒绝其中一条」不需要任何裁决的候选。
    const sameTitle = byTitle.get(key) ?? [];
    if (sameTitle.length > 1) {
      duplicateOwnerless += 1;
      const group = duplicateGroups.find((item) => item.title === key);
      if (group === undefined) {
        const rows = sameTitle
          .slice()
          .sort((a, b) => a.number - b.number)
          .map((item) => ({
            number: item.number,
            state: item.state,
            ownerless: ownerlessIds.has(item.id),
          }));
        const ownerlessCount = rows.filter((item) => item.ownerless).length;
        duplicateGroups.push({
          title: key,
          rows,
          ownerlessCount,
          allOwnerless: ownerlessCount === rows.length,
        });
      }
    }

    if (rowFresh) {
      fresh += 1;
      continue;
    }

    stale += 1;
    // C：一条业务事件都没有，而进状态的时刻已经在时效线之外。这类是 B 里最强的一档
    // ——连「状态挪过一格」都没有，只有迁移那一条记账事件。
    if (row.lastEventAt === null) noEvents += 1;

    staleRows.push({
      id: row.id,
      number: row.number,
      title: row.title,
      state: row.state,
      terminal,
      lastActivityAt: shanghaiDayLabel(activity.at),
      lastActivityFrom: activity.from,
      idleDays: idleDays(activity.at, nowMs),
      hasEvents: row.lastEventAt !== null,
      prdUrl: row.prdUrl,
      source: row.source,
      platforms: row.platforms,
    });
  }

  // 最旧的排前面；同一天按编号，保证同一份数据两次跑出来的顺序一样。
  staleRows.sort((a, b) => (
    a.lastActivityAt === b.lastActivityAt
      ? a.number - b.number
      : a.lastActivityAt < b.lastActivityAt ? -1 : 1
  ));

  // 同题组只保留「组里有没负责人的行」的，并按「全都无主优先、组最小优先」排。
  const keptGroups = duplicateGroups
    .filter((group) => group.ownerlessCount > 0)
    .sort((a, b) => (
      Number(b.allOwnerless) - Number(a.allOwnerless)
      || a.rows.length - b.rows.length
      || (a.title < b.title ? -1 : 1)
    ));

  /**
   * 「撞上已上线」：标题与**另一条**已上线（`state === 'live'`）的需求完全相同。
   *
   * 这条只做全等（归一空白后），不做模糊匹配——「看起来像」不是证据。它回答的是
   * 「这条没负责人的收集项，是不是同一件事已经在跑了」；`s.id !== row.id` 是必须的，
   * 因为 6 条没有负责人的行**自己就是已上线**（终态），不加这一条它们会自己撞自己，
   * 数字变成 6 而真相是 0。
   */
  const shippedAdjacentNumbers: number[] = [];
  for (const row of input.ownerless) {
    const key = normalizeTitle(row.title);
    const hit = (byTitle.get(key) ?? []).some(
      (item) => item.state === 'live' && item.id !== row.id,
    );
    if (hit) shippedAdjacentNumbers.push(row.number);
  }

  const toCountRows = (map: Map<string, { count: number; stale: number }>): CountRow[] => (
    [...map.entries()]
      .map(([key, cell]) => ({ key, count: cell.count, stale: cell.stale }))
      .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1))
  );

  return {
    now: input.now.toISOString(),
    cutoff: new Date(cutoffMs).toISOString(),
    cutoffDay: shanghaiDayLabel(cutoffMs),
    staleDays: STALE_DAYS,
    total: input.ownerless.length,
    buckets: { fresh, stale, noEvents },
    terminal: {
      total: terminalTotal,
      byState: [...terminalByState.entries()]
        .map(([key, count]) => ({ key, count, stale: 0 }))
        .sort((a, b) => b.count - a.count),
    },
    actionable: {
      total: actionableTotal,
      fresh: actionableFresh,
      stale: actionableStale,
    },
    staleRows,
    cross: {
      prd: { withPrd, withoutPrd: input.ownerless.length - withPrd, actionableWithPrd },
      duplicateTitles: {
        totalGroups: [...byTitle.values()].filter((rows) => rows.length > 1).length,
        groups: keptGroups,
        ownerlessRows: duplicateOwnerless,
      },
      source: toCountRows(sourceCounts),
      platform: toCountRows(platformCounts),
      shippedAdjacent: {
        count: shippedAdjacentNumbers.length,
        numbers: shippedAdjacentNumbers.sort((a, b) => a - b),
      },
      skipped: [
        '「业务上已经过期」无法从库里算：没有需求的上线版本、业务窗口、竞品替代这些数据。'
        + '本轮只给「没人动」这一条可验证的判据，不替 owner 猜业务。',
      ],
    },
  };
}
