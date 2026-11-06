import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { listArtifacts, type ArtifactRef } from '../uemaster/list.js';
import { STATE_LABEL, type State } from '../state-machine.js';
import {
  daysSinceShanghai, formatMonthDay, percentBetween, shanghaiToday,
} from './board.js';

/**
 * 抽屉里的六段：信息 / 承诺 / 参考 / 评审 / 记录 / 动作。
 *
 * 六段一次查完，不是为了快，是为了**页面不再有第二个数据源**：抽屉里任何一格要
 * 再发一次查询，就说明读模型漏了东西，而这六段是线稿评审时定下的全部内容
 * （~/Flower/docs/ux/gate-console/wire.html 的 #s-drawer）。
 */

/** 当前状态下合法的动作。名字与页面动作条、server action 一一对应。 */
export type DetailAction =
  | 'evaluate' | 'submitReview' | 'reject' | 'shelve'
  | 'reviewPass' | 'reviewReject' | 'schedule' | 'bounce' | 'restore';

export type DetailRef = {
  stage: 'evaluate' | 'review' | 'inspect';
  label: string;
  url: string | null;
  at: string | null;
  /** 已格式化成 MM-DD 的那一天（页面不再自己算日期）。 */
  atLabel: string | null;
  present: boolean;
};

export type DetailReview = {
  reviewer: string;
  role: string;
  /** 用户看得懂的那条线：功能线 / 商业线。 */
  line: string;
  verdict: string;
  verdictLabel: string;
  reason: string | null;
  decidedAt: string | null;
  decidedAtLabel: string | null;
};

export type DetailEvent = {
  seq: number;
  type: string;
  /** 中文动作名（'评审通过'），不是事件类型串。 */
  label: string;
  /** 事件里的细节（原因、日期、PRD 链接），没有就 null。 */
  note: string | null;
  actor: string;
  at: string;
  /** 时间轴左边那一列的 MM-DD。 */
  dateLabel: string;
};

export type Detail = {
  id: string;
  number: number;
  title: string;
  state: State;
  stateLabel: string;
  days: number;
  info: {
    type: string;
    typeLabel: string;
    requester: string;
    owner: string | null;
    prdUrl: string | null;
    skipReason: string | null;
    stateLabel: string;
    stateEnteredAt: string;
    createdAt: string;
    days: number;
  };
  commit: {
    release: { id: string; name: string; windowStart: string; releaseDate: string } | null;
    testAt: string | null;
    testAtLabel: string | null;
    dueAt: string | null;
    dueAtLabel: string | null;
    /** 「时间已用 %」：今天在 [版本开工日, 承诺完成日] 区间里的位置（spec §4）。 */
    timeUsed: { percent: number; from: string; to: string } | null;
  };
  refs: DetailRef[];
  review: DetailReview | null;
  events: DetailEvent[];
  actions: DetailAction[];
};

const TYPE_LABEL: Record<string, string> = { commercial: '商业', feature: '功能' };

const ROLE_LINE: Record<string, string> = {
  pm: 'PM',
  commercial_reviewer: '商业线',
  feature_reviewer: '功能线',
};

const VERDICT_LABEL: Record<string, string> = {
  handed: '待签',
  passed: '通过',
  rejected: '打回',
  voided: '作废',
};

/** `uemaster.attached` 在时间轴上的中文名：按 payload 里的 stage 分词。 */
const ATTACH_LABEL: Record<string, string> = {
  evaluate: '提交评估材料',
  review: '提交评审材料',
  inspect: '提交走查材料',
};

/**
 * 状态 → 当前合法的动作。
 *
 * 与 `src/core/requirements/terminal.ts` 的口径对齐：**任何非终态都能搁置**
 * （那条规则由 isShelvable 承载，不在 TRANSITIONS 里——表只登记单步迁移），
 * 已搁置只能恢复，已拒绝到顶。
 *
 * 写成穷举 switch 而不是查表：给 State 加成员时这里编译失败，逼人重新表态；
 * 页面拿到的动作列表因此不可能悄悄漏掉一个状态。
 */
function actionsFor(state: State): DetailAction[] {
  switch (state) {
    case 'inbox':
      return ['evaluate', 'submitReview', 'reject', 'shelve'];
    case 'design':
      return ['submitReview', 'shelve'];
    case 'review':
      return ['reviewPass', 'reviewReject', 'shelve'];
    case 'queue':
      return ['schedule', 'shelve'];
    case 'ready':
    case 'dev':
      return ['shelve'];
    case 'test':
      return ['bounce', 'shelve'];
    case 'live':
      // 走查在 P4 范围外（plan「不在 P4 范围」），所以这里只有搁置；
      // 参考段的「走查材料」留着槽位，等 P2 的 uemaster_artifacts 接上。
      return ['shelve'];
    case 'rejected':
      return [];
    case 'shelved':
      return ['restore'];
  }
}

type Payload = Record<string, unknown>;

function text(payload: Payload, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 事件类型 → 抽屉里那一行中文。
 *
 * 事件类型是库里的字符串（`requirement.auto_test` 这种也算），直接显示会把
 * 表名漏到界面上。这里的映射同时是「这十三种事件都有中文」的一份清单：
 * 新增事件类型时它会退回显示原始 type，一眼睛就能看出漏了谁。
 */
function describe(type: string, payload: Payload): { label: string; note: string | null } {
  switch (type) {
    case 'requirement.created':
      return { label: '提出需求', note: text(payload, 'title') };
    case 'requirement.evaluated':
      return { label: '评估完成，进入待设计', note: null };
    case 'requirement.review_requested': {
      const skipped = payload.skippedEvaluation === true;
      return {
        label: skipped ? '跳过评估，直接提交评审' : '提交评审',
        note: text(payload, 'prdUrl'),
      };
    }
    case 'requirement.review_passed':
      return { label: '评审通过', note: null };
    case 'requirement.review_rejected':
      return { label: '评审打回', note: text(payload, 'reason') };
    case 'requirement.scheduled': {
      const test = text(payload, 'commitTestAt');
      const due = text(payload, 'commitDueAt');
      return {
        label: '排进版本',
        note: test && due ? `提测 ${test} · 承诺 ${due}` : null,
      };
    }
    case 'requirement.auto_dev':
      return { label: '到开工日，自动进入开发中', note: null };
    case 'requirement.auto_test':
      return { label: '到提测日，自动进入测试中', note: null };
    case 'requirement.auto_live':
      return { label: '到承诺完成日，自动上线', note: null };
    case 'requirement.bounced': {
      const due = text(payload, 'newCommitDueAt');
      const reason = text(payload, 'reason');
      return {
        label: '打回开发中',
        note: [reason, due ? `新承诺 ${due}` : null].filter(Boolean).join(' · ') || null,
      };
    }
    case 'requirement.rejected':
      return { label: '拒绝', note: text(payload, 'reason') };
    case 'requirement.shelved':
      return { label: '搁置', note: text(payload, 'reason') };
    case 'requirement.restored':
      return { label: '恢复，回到收集', note: null };
    case 'uemaster.attached': {
      // 时间轴上不能出现 `uemaster.attached` 这种库里的串（见上面这条函数的用意）。
      // 三种 stage 各有各的中文名；认不出的 stage 退回「提交材料」，仍然不显示原始类型。
      const label = ATTACH_LABEL[text(payload, 'stage') ?? ''] ?? '提交材料';
      return { label, note: text(payload, 'url') };
    }
    default:
      return { label: type, note: null };
  }
}

/** payload 列是 text，存的是 JSON 串；解析失败不该让抽屉整页挂掉。 */
function parsePayload(raw: string): Payload {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Payload)
      : {};
  } catch {
    return {};
  }
}

/**
 * 「时间已用 %」。
 *
 * 区间左端取版本开工日（`window_start`）；没有版本（没排期）时整段不显示——spec §4
 * 明确「没排期则不显示」。右端是承诺完成日。用毫秒算再夹到 0..100：还没开工是 0%，
 * 过点是 100%，不算出 -40% 或 137% 这种读者要自己解读的数字。
 */
function timeUsed(
  windowStart: string | null, dueAt: string | null,
): { percent: number; from: string; to: string } | null {
  const percent = percentBetween(windowStart, dueAt);
  if (percent === null || !windowStart || !dueAt) return null;
  return { percent, from: windowStart, to: dueAt };
}

/**
 * 参考段里「一处 UEmaster 产物」那一行：有产物就是链接 + 那天的日期，没有就是空槽位。
 *
 * 没有产物时这一行仍留在数组里（`present: false`）：抽屉按 `present` 过滤渲染，行在
 * 数据里存在、在页面上不出现；三处槽位是对外的固定次序，删行会让另外两行搬家。
 */
function artifactRef(
  stage: DetailRef['stage'], label: string, artifact: ArtifactRef | undefined,
): DetailRef {
  if (!artifact) return { stage, label, url: null, at: null, atLabel: null, present: false };
  const at = artifact.at.toISOString();
  return { stage, label, url: artifact.url, at, atLabel: formatMonthDay(at), present: true };
}

/**
 * review 槽位：语义是「PRD 快照」——它是这次评审的依据，不是 UEmaster 产物，所以
 * 有了产物也不能让 PRD 消失。
 *
 * 有评审产物时这一行显示产物、阶段名跟着变成「评审材料」，理由是参考段一行只放一个
 * 链接（`DetailRef` 只有一个 url），而产物才是这次评审实际看的那份材料；PRD 链接不靠
 * 这一行承载——信息段的「PRD 链接」一直在，抽屉里两个链接都点得到，参考段也没多出一行。
 * 没有产物时保持原样：PRD 快照 + 评审那次的时间。
 */
function reviewRef(
  prdUrl: string | null, reviewAt: string | null, artifact: ArtifactRef | undefined,
): DetailRef {
  if (artifact) return artifactRef('review', '评审材料', artifact);
  return {
    stage: 'review',
    label: 'PRD 快照',
    url: prdUrl,
    at: reviewAt,
    atLabel: formatMonthDay(reviewAt),
    present: prdUrl !== null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = {
  id: string;
  number: number;
  title: string;
  type: string;
  state: State;
  requester: string;
  prd_url: string | null;
  skip_reason: string | null;
  state_entered_at: string;
  commit_test_at: string | null;
  commit_due_at: string | null;
  created_at: string;
  owner: string | null;
  release_id: string | null;
  release_name: string | null;
  window_start: string | null;
  release_date: string | null;
};

type ReviewRow = {
  name: string;
  role: string;
  verdict: string | null;
  reason: string | null;
  decided_at: string | null;
};

/**
 * 一条需求的抽屉数据；没有这条需求返回 null。
 *
 * 非 uuid 也返回 null 而不是抛 AppError：那个字符串只可能来自手改的 URL 或点坏的链接，
 * 让页面显示「找不到」比把 PG 的 22P02 抛到上层诚实得多（服务层的入口校验仍然按
 * AppError 走，那是写路径的口径，读路径不需要一个错误码）。
 */
export async function getRequirementDetail(id: string): Promise<Detail | null> {
  if (!UUID.test(id)) return null;

  const found = await db.execute<Row>(sql`
    select r.id, r.number, r.title, r.type, r.state, r.requester, r.prd_url, r.skip_reason,
           r.state_entered_at, r.commit_test_at, r.commit_due_at, r.created_at,
           m.name as owner,
           rel.id as release_id, rel.name as release_name,
           rel.window_start, rel.release_date
      from requirements r
      left join members m on m.id = r.owner_member_id
      left join releases rel on rel.id = r.release_id
     where r.id = ${id}`);
  const row = found.rows[0];
  if (!row) return null;

  // 评审：优先「还挂着的派单」（handed 就是这条需求现在归谁），否则取最近一次判决。
  // 一条需求可能有多行（打回后重新提交会再派一次单），抽屉只显示最近的那一行。
  const reviewRes = await db.execute<ReviewRow>(sql`
    select m.name, m.role, ra.verdict, ra.reason, ra.decided_at
      from review_assignments ra
      join members m on m.id = ra.reviewer_member_id
     where ra.requirement_id = ${id}
     order by (ra.verdict = 'handed') desc, ra.decided_at desc nulls last, ra.id desc
     limit 1`);
  const reviewRow = reviewRes.rows[0] ?? null;

  const eventRes = await db.execute<{
    seq: number; actor: string; type: string; payload: string; at: string;
  }>(sql`
    select seq, actor, type, payload, at
      from events
     where requirement_id = ${id}
     order by seq`);

  const today = shanghaiToday();
  const days = daysSinceShanghai(row.state_entered_at, today);

  const review: DetailReview | null = reviewRow
    ? {
      reviewer: reviewRow.name,
      role: reviewRow.role,
      line: ROLE_LINE[reviewRow.role] ?? reviewRow.role,
      verdict: reviewRow.verdict ?? 'handed',
      verdictLabel: VERDICT_LABEL[reviewRow.verdict ?? 'handed'] ?? '待签',
      reason: reviewRow.reason,
      decidedAt: reviewRow.decided_at,
      decidedAtLabel: formatMonthDay(reviewRow.decided_at),
    }
    : null;

  const reviewAskedAt = eventRes.rows
    .filter((e) => e.type === 'requirement.review_requested')
    .at(-1)?.at ?? null;

  // 参考段的产物：每 stage 只取最新一份（重做会留下历史行，读侧只认当前有效的）。
  // 走 `listArtifacts` 而不是在这里再写一遍 `distinct on`：两个读侧各写一份 SQL，
  // 迟早在「同毫秒写入怎么定序」这种细节上分叉。
  const artifacts = new Map((await listArtifacts(db, id)).map((a) => [a.stage, a]));

  return {
    id: row.id,
    number: Number(row.number),
    title: row.title,
    state: row.state,
    stateLabel: STATE_LABEL[row.state],
    days,
    info: {
      type: row.type,
      typeLabel: TYPE_LABEL[row.type] ?? row.type,
      requester: row.requester,
      owner: row.owner,
      prdUrl: row.prd_url,
      skipReason: row.skip_reason,
      stateLabel: STATE_LABEL[row.state],
      stateEnteredAt: row.state_entered_at,
      createdAt: row.created_at,
      days,
    },
    commit: {
      release: row.release_id === null
        ? null
        : {
          id: row.release_id,
          name: row.release_name ?? '',
          windowStart: row.window_start ?? '',
          releaseDate: row.release_date ?? '',
        },
      testAt: row.commit_test_at,
      testAtLabel: formatMonthDay(row.commit_test_at),
      dueAt: row.commit_due_at,
      dueAtLabel: formatMonthDay(row.commit_due_at),
      timeUsed: timeUsed(row.window_start, row.commit_due_at),
    },
    refs: [
      artifactRef('evaluate', '评估材料', artifacts.get('evaluate')),
      reviewRef(row.prd_url, reviewRow?.decided_at ?? reviewAskedAt, artifacts.get('review')),
      artifactRef('inspect', '走查材料', artifacts.get('inspect')),
    ],
    review,
    events: eventRes.rows.map((e) => ({
      seq: Number(e.seq),
      type: e.type,
      ...describe(e.type, parsePayload(e.payload)),
      actor: e.actor,
      at: e.at,
      dateLabel: formatMonthDay(e.at) ?? '—',
    })),
    actions: actionsFor(row.state),
  };
}
