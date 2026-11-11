import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { STATE_LABEL, type State } from '../state-machine.js';
import {
  daysSinceShanghai, formatMonthDay, lateDeadline, percentBetween, shanghaiToday,
} from './board.js';

/**
 * 版本页（计划 Task 5）要的全部数据：两个版本、每个版本的时间窗、在途/延期条数、
 * 以及甘特要的每一条需求的日期。
 *
 * 为什么把需求一起带出来：甘特是「每条需求一行」的图，页面若按版本再查一次需求，
 * 就成了 N+1；而且「哪些需求算在一个版本里」这条口径会散到页面里。口径留在这里，
 * 页面只画。
 */

/** 甘特上的一行。`late` 只对还没上线的行有意义。 */
export type ReleaseItem = {
  id: string;
  number: number;
  title: string;
  state: State;
  stateLabel: string;
  commitTestAt: string | null;
  testAtLabel: string | null;
  commitDueAt: string | null;
  dueAtLabel: string | null;
  /** 停在这个状态几天（甘特上的「拖了多久」）。 */
  days: number;
  late: boolean;
};

export type Release = {
  id: string;
  name: string;
  windowStart: string;
  windowStartLabel: string | null;
  releaseDate: string;
  releaseDateLabel: string | null;
  /** 时间口径的进度：今天在这个版本时间窗里的位置（wireframe 的「已用时间」）。 */
  timeUsed: number | null;
  /** 在途 = 已排期还没上线（ready / dev / test）。 */
  inFlight: number;
  /** 已上线条数：甘特上它们仍是历史，但不占「在途」。 */
  shipped: number;
  /** 延期 = 这个版本里「等的日期已过、还没上线」的条数（与看板同一个判定）。 */
  late: number;
  /** 这一版要做什么 / 备注（P4-02 录入的，可空）。 */
  goal: string | null;
  note: string | null;
  requirements: ReleaseItem[];
};

/** 甘特上要画的状态：排过期的都算，已上线留着当历史；已拒绝 / 已搁置不画。 */
const SCHEDULED_STATES: readonly State[] = ['ready', 'dev', 'test', 'live'];

type ReleaseRow = {
  id: string;
  name: string;
  window_start: string;
  release_date: string;
  goal: string | null;
  note: string | null;
};

type ItemRow = {
  release_id: string;
  id: string;
  number: number;
  title: string;
  state: State;
  state_entered_at: string;
  commit_test_at: string | null;
  commit_due_at: string | null;
};

/**
 * 全部版本，按发版日排序。
 *
 * 两条 SQL（版本、需求）而不是一条 join：版本表只有几行，join 出来要为每条需求
 * 重复版本字段，还得在 JS 里去重；两条平铺查询反而更短、也更好读。
 *
 * `late` 的口径与看板共用 lateDeadline：等的那个日期**已经过去**（严格小于今天）
 * 且还没上线。上线之后日期过期是正常的，不算延期。
 *
 * 为什么不写成「commit_due_at < now 且未上线」：那会让一条错过了**提测日**仍在
 * 开发中的需求算成「在期」——它恰恰是最该被标红的那种。看板已经被迫回答过这个问题，
 * 版本页复用同一个答案，两个页面对同一条需求不会各说各话。
 */
export async function listReleases(): Promise<Release[]> {
  const today = shanghaiToday();

  const releaseRes = await db.execute<ReleaseRow>(sql`
    select id, name, window_start, release_date, goal, note
      from releases
     where deleted_at is null
     order by release_date, name`);

  // 状态列表走参数绑定（不是拼字符串）：'ready' 这些是 State 的字面量，但只有一份
  // 来源（SCHEDULED_STATES），SQL 与 JS 的口径不可能分叉。
  const states = sql.join(SCHEDULED_STATES.map((s) => sql`${s}`), sql`, `);

  const itemRes = await db.execute<ItemRow>(sql`
    select r.release_id, r.id, r.number, r.title, r.state,
           r.state_entered_at, r.commit_test_at, r.commit_due_at
      from requirements r
     where r.release_id is not null
       and r.deleted_at is null
       and r.state in (${states})
     order by r.commit_due_at nulls last, r.number`);

  const releaseRows = new Map(releaseRes.rows.map((r) => [r.id, r]));

  const itemsByRelease = new Map<string, ReleaseItem[]>();
  for (const row of itemRes.rows) {
    const late = row.state !== 'live' && lateDeadline({
      state: row.state,
      windowStart: releaseRows.get(row.release_id)?.window_start ?? null,
      testAt: row.commit_test_at,
      dueAt: row.commit_due_at,
    }, today);
    const list = itemsByRelease.get(row.release_id) ?? [];
    list.push({
      id: row.id,
      number: Number(row.number),
      title: row.title,
      state: row.state,
      stateLabel: STATE_LABEL[row.state],
      commitTestAt: row.commit_test_at,
      testAtLabel: formatMonthDay(row.commit_test_at),
      commitDueAt: row.commit_due_at,
      dueAtLabel: formatMonthDay(row.commit_due_at),
      days: daysSinceShanghai(row.state_entered_at, today),
      late,
    });
    itemsByRelease.set(row.release_id, list);
  }

  return releaseRes.rows.map((row) => {
    const requirements = itemsByRelease.get(row.id) ?? [];
    return {
      id: row.id,
      name: row.name,
      windowStart: row.window_start,
      windowStartLabel: formatMonthDay(row.window_start),
      releaseDate: row.release_date,
      releaseDateLabel: formatMonthDay(row.release_date),
      timeUsed: percentBetween(row.window_start, row.release_date),
      inFlight: requirements.filter((r) => r.state !== 'live').length,
      shipped: requirements.filter((r) => r.state === 'live').length,
      late: requirements.filter((r) => r.late).length,
      goal: row.goal,
      note: row.note,
      requirements,
    };
  });
}

/**
 * 「还能加进版本的需求」：待排期、且已经有正式 PRD（对齐 schedule 的那道门）。
 *
 * 版本页的「添加需求」下拉用这一份。放在读模型里而不是页面里：那条口径（哪些需求
 * 有资格进版本）与 schedule 的拒绝理由必须指向同一件事，页面不该自己拼 WHERE。
 */
export async function releasableRequirements(): Promise<Array<{
  id: string; number: number; title: string; owner: string | null;
}>> {
  const res = await db.execute<{
    id: string; number: number; title: string; owner: string | null;
  }>(sql`
    select r.id, r.number, r.title, m.name as owner
      from requirements r
      left join members m on m.id = r.owner_member_id
     where r.deleted_at is null
       and r.state = 'queue'
       and r.prd_url is not null and btrim(r.prd_url) <> ''
     order by r.number`);
  return res.rows.map((row) => ({
    id: row.id, number: Number(row.number), title: row.title, owner: row.owner,
  }));
}
