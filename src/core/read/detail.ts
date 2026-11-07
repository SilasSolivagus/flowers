import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  can, lineLabelOf, type Ability, type Member, type RequirementFacts,
} from '../auth/roles.js';
import { listArtifacts, type ArtifactRef } from '../uemaster/list.js';
import { STATE_LABEL, type State } from '../state-machine.js';
import { fingerprintOfRow, freshnessOf, type Freshness } from '../requirements/fingerprint.js';
import { normalizePlatforms, platformsLabel } from '../requirements/platforms.js';
import { normalizePriority, priorityLabel } from '../requirements/priority.js';
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

/**
 * 当前状态下合法的动作。名字与页面动作条、server action 一一对应。
 *
 * **`evaluate` 留在这个并集里，但没有任何状态会给出它**（P2 Task 4）：从动作条上
 * 拿掉它的理由不是「评估不需要发生」，而是它根本不是一个点一下就能完成的动作
 * （材料要生成）。P2.6 之后材料由「参考」段那一行的「生成」产出，类型里保留它，
 * 是因为 `inbox → design` 仍是领域里合法的迁移（`src/core/requirements/evaluate.ts`
 * 与 seed 都走它），`runAction` 也还接得住；删掉它等于让动作条与领域对不上账。
 */
export type DetailAction =
  | 'evaluate' | 'submitReview' | 'reject' | 'shelve'
  | 'reviewPass' | 'reviewReject' | 'schedule' | 'bounce' | 'restore';

/**
 * 动作 → 它要求的那一格能力（P4-05）。
 *
 * **不要在这里判断谁能做**：映射只回答「这个按钮属于哪一种写」，结论一律由
 * `can()`（`src/core/auth/roles.ts`）给。界面、服务层、MCP 因此共用同一份规则；
 * 以后往 `DetailAction` 加一个动作时，这张 `Record` 会编译失败，逼人先表态它要
 * 哪一格能力，而不是让它悄悄对所有角色可见。
 *
 * 评审那两个是唯一非 `edit` 的动作：`can('review')` 里有状态门与派单门，
 * 所以「待评审」「不是派给我」两件事都由它回答，这里不重复写。
 */
export const ACTION_ABILITY: Record<DetailAction, Ability> = {
  evaluate: 'edit',
  submitReview: 'edit',
  reject: 'edit',
  shelve: 'edit',
  schedule: 'edit',
  bounce: 'edit',
  restore: 'edit',
  reviewPass: 'review',
  reviewReject: 'review',
};

/** 抽屉要显不显示某几处控件（描述「编辑」、负责人「改」、参考段的两个写按钮）。 */
export type DetailPermissions = {
  edit: boolean;
  review: boolean;
  reassignOwner: boolean;
  /**
   * 认领（P4-06）：这条需求还没有负责人，而这个人可以把它认领下来。
   * 与 `reassignOwner` 分开：认领只发生在「无主」这一种状态上，而认领之后
   * 这条需求就落到认领人的条线下——它是「立项」，不是「转交」。
   */
  claim: boolean;
  manageMembers: boolean;
};

const NO_PERMISSIONS: DetailPermissions = {
  edit: false, review: false, reassignOwner: false, claim: false, manageMembers: false,
};

export type DetailRef = {
  stage: 'evaluate' | 'review' | 'inspect';
  label: string;
  url: string | null;
  at: string | null;
  /** 已格式化成 MM-DD 的那一天（页面不再自己算日期）。 */
  atLabel: string | null;
  present: boolean;
  /**
   * 这份产物与**当前**描述是否对得上（P4-02）。
   *
   * 三态而不是一个布尔：`unknown`（产物上没有指纹：P4-02 之前落库的行，或人/agent
   * 直接 attach 的行）与 `stale`（指纹不等）是两件不同的事，界面上也是两句不同的话
   * （「版本未知」/「需求已更新」）。把它算在读模型里、而不是让抽屉自己比一遍，
   * 是因为「当前指纹」要那一行需求的描述，只有这里取得到。
   */
  freshness: Freshness;
  /** 这个阶段存过几版（0 = 还没生成过）。按钮上的「第 N 版」用它。 */
  versions: number;
  /**
   * 这个阶段**正在跑**的那次生成（null = 没有）。
   *
   * P2.6 起参考段那一行的按钮是「生成」——服务器自己跑生成器，产物落回
   * `data/uemaster/`，这一行随即变成链接。「生成中」这个状态因此必须从库里读：
   * 页面刷新、换一个人打开同一条需求，看到的都得是同一件事；一个只活在客户端
   * state 里的「生成中」在刷新之后就变成了「生成」，按下去只会撞一句「正在生成中」。
   *
   * 只给 id：页面需要的动作是「继续轮询这条作业」，其余细节由 `jobStatus` 回答。
   * 失败不在这里——失败是一次性的提示（行内那句话），刷新之后行就回到「生成」，
   * 让用户可以重试；把上一次的失败永久挂在那一行会让这条需求看起来永远坏着。
   */
  generation: { id: string } | null;
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
    /**
     * 负责人所在条线（P4-06）：权限的锚点。抽屉把它显示在负责人后面，因为
     * 「谁能改这条需求」从这一行就能读出来——不写出来，读者会以为锚点仍是类型。
     * null = 没有负责人，或负责人没有条线（超管）。
     */
    ownerLine: string | null;
    ownerLineLabel: string | null;
    prdUrl: string | null;
    /**
     * 平台（P4-08）：这条需求落在哪几个端上。空数组 = 未标注。
     *
     * 放在 `info` 而不是 `description`：它是「这条需求是什么」的分类属性（跟类型、
     * 提出人同一层），不是六个结构化问题之一。抽屉把它渲染成信息段里的一行；
     * **看板卡上没有它**——那张卡只有两行，一个九列的板放不下第三个标签。
     */
    platforms: string[];
    /** 上面那组键的一行中文（`H5 · 移动端`），空数组时是「未标注」。 */
    platformsLabel: string;
    /**
     * 优先级（P4-09）：`p0|p1|p2|p3|green`，null = 未定。
     *
     * 放在 `info` 的理由与平台相同：它是「这条需求是什么」的分类属性，
     * 不是六个结构化问题之一。看板卡上也没有它（两行放不下第三个标签）。
     */
    priority: string | null;
    /** 上面那个键的中文（`P0` / `绿色通道`），null 时是「未定」。 */
    priorityLabel: string;
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
  /**
   * 六个描述性问题（P4-02）：抽屉只读展示 + 编辑表单的初始值。
   *
   * 与 `info` 分开，因为它们的读者不同：`info` 是「这条需求是谁提的、停在哪」，
   * 六问是「它要做什么」。混在一起会让抽屉的「信息」段变成一张什么都有的表，
   * 而编辑表单只需要这六个字段（标题在 `title` 上，PRD 链接在 `info` 里）。
   */
  description: {
    context: string | null;
    problem: string | null;
    outcome: string | null;
    surfaces: string | null;
    edgeCases: string | null;
    outOfScope: string | null;
  };
  refs: DetailRef[];
  review: DetailReview | null;
  events: DetailEvent[];
  /**
   * 动作条：**状态合法 ∩ 这个人能做**（P4-05）。
   *
   * 服务层拒绝的是「做不成」，这里过滤的是「看不看得见」。两件事必须同时成立：
   * 只过滤服务层会让 owner 那句「别人连按钮都不出现」不成立；只过滤界面会让
   * 一个手写的请求仍然成功（那才是安全洞）。所以交集在这里算，规则从 `can()` 来。
   *
   * 没有身份（`actor === undefined`）时退回「这个状态合法的全部」：那是这个字段在
   * P4-05 之前就有的口径，现在只剩漂移探测器在用（它要的是 `actionsFor` 本身）。
   * 明确「没有身份」（`null`）则是空数组——没有身份的人不该看见任何动作，
   * MCP 里查不到成员行（停用 / 已删）时就落这一格。
   */
  actions: DetailAction[];
  /** 上面那几处控件各自要不要渲染。同样只来自 `can()`，页面不自己推导。 */
  permissions: DetailPermissions;
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
export function actionsFor(state: State): DetailAction[] {
  switch (state) {
    case 'inbox':
      // 「立项」= inbox → 待设计，触发是 `evaluate`（状态机里那条边就叫这个名字）。
      //
      // 它一度被拿掉，理由是「评估材料要生成，一个点一下就能完成的按钮是假的」。
      // 认领进来之后这个理由不成立了：认领只给了负责人，**状态没动**，而收集状态的
      // 唯一出口就是立项——不把它放回来，认领完就卡死在收集列，只能直接提交 PRD
      // 跳过设计。评估材料仍然是可选的（参考段那一行照旧）。
      //
      // 谁能点由 `can('edit')` 过滤：无主时谁都不行（先认领），有主时只有负责人 /
      // 条线负责人 / 超管。
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

/**
 * 动作条的真值：`actionsFor(state)` ∩ `can(actor, facts, ability)`。
 *
 * 这是这一层唯一的过滤点——页面拿到的就是结果，它不再做一次 `can()`（那样会出现
 * 第二份判断，而两份判断一定会分叉）。测试表直接调它，不复制它的实现。
 */
export function visibleActions(
  state: State, actor: Member, facts: RequirementFacts,
): DetailAction[] {
  return actionsFor(state).filter((action) => can(actor, facts, ACTION_ABILITY[action]));
}

/** 抽屉里那几处控件的能力结论。`can()` 是唯一来源，页面只读结果。 */
export function permissionsFor(actor: Member, facts: RequirementFacts): DetailPermissions {
  return {
    edit: can(actor, facts, 'edit'),
    review: can(actor, facts, 'review'),
    reassignOwner: can(actor, facts, 'reassignOwner'),
    claim: can(actor, facts, 'claim'),
    manageMembers: can(actor, facts, 'manageMembers'),
  };
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
    case 'requirement.updated': {
      // 事件里记的是「改了哪几问」（`fields: [{field,label,from,to}]`，见 manage.ts）。
      // 时间轴上只写字段名：一整段新描述不该在这里出现第二遍（正文在 ① 描述段）。
      const fields = Array.isArray(payload.fields) ? payload.fields : [];
      const labels = fields
        .map((item) => (typeof item === 'object' && item !== null
          ? (item as Payload).label
          : null))
        .filter((label): label is string => typeof label === 'string' && label !== '');
      return { label: '更新描述', note: labels.length > 0 ? labels.join(' · ') : null };
    }
    case 'requirement.deleted':
      return { label: '删除需求', note: text(payload, 'title') };
    case 'requirement.owner_assigned': {
      // 认领（from 为 null，P4-06）与转交共用一条事件：读侧要回答的是同一件事——
      // 「负责人是谁、什么时候换的」。时间轴上分开写，因为「他认领的」与「别人交给他的」
      // 是两句不同的话，混成一句会让认领看起来像一次人事安排。
      const from = text(payload, 'from');
      const to = text(payload, 'to') ?? '';
      return from === null
        ? { label: '认领，成为负责人', note: to }
        : { label: '转交负责人', note: `${from} → ${to}` };
    }
    case 'requirement.rejected':
      return { label: '拒绝', note: text(payload, 'reason') };
    case 'requirement.shelved':
      return { label: '搁置', note: text(payload, 'reason') };
    case 'requirement.restored':
      return { label: '恢复，回到收集', note: null };
    case 'requirement.migrated': {
      // 从 Flower 搬进来的行（P4-09）。时间轴上要说清「这是迁入的」，并给出原编号——
      // 想回旧系统对账时，PAN 编号对不上，原编号是唯一的锚。
      const number = payload.sourceNumber;
      return {
        label: '从 Flower 迁入',
        note: typeof number === 'number' ? `Flower #${number}` : null,
      };
    }
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
 * 参考段里「一处 UEmaster 材料」那一行：有产物就是链接 + 那天的日期，没有就是
 * 「还没生成」（`present: false`）。
 *
 * 没有产物时这一行**仍然渲染**（P2 Task 4 起）：它不是空槽位，而是这一阶段的
 * 入口——行上写着阶段名，右侧一个「生成」按钮（P2.6：由服务端跑生成器），
 * 另外还留着「交回材料」这条人走的路。所以 `present` 只决定**渲染链接还是「还没
 * 生成」**，不决定渲染还是不渲染。
 *
 * `generation` 是「这个阶段正在跑的那次作业」，由调用方传入。三行同一种形状，
 * 包括 review（P2 之前它在没有产物时显示「PRD 快照」）：PRD 链接不靠这一行承载——
 * 信息段的「PRD 链接」一直在，抽屉里点得到。
 */
function artifactRef(
  stage: DetailRef['stage'],
  label: string,
  artifact: ArtifactRef | undefined,
  runningJobId: string | null,
  currentHash: string,
): DetailRef {
  const generation = runningJobId === null ? null : { id: runningJobId };
  if (!artifact) {
    // 没有产物：新鲜度这一格没有意义（界面上那一行是「生成」入口，不是链接）。
    // 给 'unknown' 而不是留空：类型只有三态，而这一格只在 `present` 时被读。
    return {
      stage, label, url: null, at: null, atLabel: null, present: false,
      freshness: 'unknown', versions: 0, generation,
    };
  }
  const at = artifact.at.toISOString();
  return {
    stage, label, url: artifact.url, at, atLabel: formatMonthDay(at), present: true,
    freshness: freshnessOf(artifact.inputHash, currentHash),
    versions: artifact.versions,
    generation,
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
  owner_member_id: string | null;
  owner_line: string | null;
  release_id: string | null;
  release_name: string | null;
  window_start: string | null;
  release_date: string | null;
  context: string | null;
  problem: string | null;
  outcome: string | null;
  surfaces: string | null;
  edge_cases: string | null;
  out_of_scope: string | null;
  /** `text[]`（P4-08）：pg 驱动给的是字符串数组；空数组 = 未标注。 */
  platforms: string[] | null;
  /** `text` 可空（P4-09）：`p0|p1|p2|p3|green`；null = 未定。 */
  priority: string | null;
};

type ReviewRow = {
  name: string;
  role: string;
  reviewer_id: string;
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
 *
 * `actor` 是 P4-05 加的那一半：给了人，`actions` 就是「状态合法 ∩ 他能做」，
 * `permissions` 也按同一次 `can()` 算。页面**必须**给（Shell 已经保证有会话）。
 *
 * P2 起 **MCP 的 requirement_show 也给**（身份来自 token 的那个成员）：不给的后果是
 * agent 被告知了一堆「它的主人做不到」的动作，然后靠一次写工具的失败去猜。今天唯一
 * 还走「不给身份」这条路的只有 `tests/mcp-legal-from.test.ts`——它的对象是
 * `actionsFor(state)` 本身（状态机 → MCP 声明的那张镜像表），与「谁在看」无关。
 */
export async function getRequirementDetail(
  id: string, actor?: Member | null,
): Promise<Detail | null> {
  if (!UUID.test(id)) return null;

  // 三处过滤都带 `deleted_at is null`：软删除的行对外等于不存在（P4-02）。
  // 版本的 join 也带：版本被删之后，那条需求的排期字段仍在，但**版本名不该再显示**
  // （`rel.id` 会因为 join 不成立变成 null，`commit.release` 随之整段消失）。
  const found = await db.execute<Row>(sql`
    select r.id, r.number, r.title, r.type, r.state, r.requester, r.prd_url, r.skip_reason,
           r.state_entered_at, r.commit_test_at, r.commit_due_at, r.created_at,
           r.context, r.problem, r.outcome, r.surfaces, r.edge_cases, r.out_of_scope,
           r.platforms, r.priority,
           r.owner_member_id, m.name as owner, m.line as owner_line,
           rel.id as release_id, rel.name as release_name,
           rel.window_start, rel.release_date
      from requirements r
      left join members m on m.id = r.owner_member_id
      left join releases rel on rel.id = r.release_id and rel.deleted_at is null
     where r.id = ${id} and r.deleted_at is null`);
  const row = found.rows[0];
  if (!row) return null;

  // 评审：优先「还挂着的派单」（handed 就是这条需求现在归谁），否则取最近一次判决。
  // 一条需求可能有多行（打回后重新提交会再派一次单），抽屉只显示最近的那一行。
  const reviewRes = await db.execute<ReviewRow>(sql`
    select m.name, m.role, m.id as reviewer_id, ra.verdict, ra.reason, ra.decided_at
      from review_assignments ra
      join members m on m.id = ra.reviewer_member_id
     where ra.requirement_id = ${id}
     order by (ra.verdict = 'handed') desc, ra.decided_at desc nulls last, ra.id desc
     limit 1`);
  const reviewRow = reviewRes.rows[0] ?? null;

  /**
   * 权限事实：全部来自**这一行**（不是调用方口述）。派单只认 `handed` 那一行——
   * 一份已收口的旧派单（passed / rejected）不该继续回答「现在谁签字」。
   */
  const facts: RequirementFacts = {
    ownerMemberId: row.owner_member_id,
    ownerLine: row.owner_line,
    state: row.state,
    reviewerMemberId: reviewRow !== null && reviewRow.verdict === 'handed'
      ? reviewRow.reviewer_id
      : null,
  };
  const permissions = actor === undefined || actor === null
    ? NO_PERMISSIONS
    : permissionsFor(actor, facts);
  const actions = actor === undefined
    ? actionsFor(row.state)
    : (actor === null ? [] : visibleActions(row.state, actor, facts));

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

  // 参考段的产物：每 stage 只取最新一份（重做会留下历史行，读侧只认当前有效的）。
  // 走 `listArtifacts` 而不是在这里再写一遍 `distinct on`：两个读侧各写一份 SQL，
  // 迟早在「同毫秒写入怎么定序」这种细节上分叉。
  const artifacts = new Map((await listArtifacts(db, id)).map((a) => [a.stage, a]));

  /**
   * 当前描述的指纹：产物那三行把它与各自存下来的 `input_hash` 比一次，得出
   * 「新的 / 需求已更新 / 版本未知」。用的是写侧同一个函数（`fingerprintOfRow`），
   * 所以「编辑保存后产物自己变旧」不需要任何额外写入——它是算出来的，不是存下来的。
   */
  const currentHash = fingerprintOfRow(row);

  /**
   * 正在跑的生成作业，按 stage 取最新一条。
   *
   * 只查 running：done / failed 是历史，抽屉那一行不需要它们的「当前状态」——
   * 成功会变成产物链接（`listArtifacts` 已经给了），失败是行内一次性的提示。
   * `distinct on (stage)` 与 `listArtifacts` 同一个口径：一个 stage 只认最近一次。
   */
  const runningJobs = await db.execute<{ id: string; stage: string }>(sql`
    select distinct on (stage) id, stage
      from uemaster_jobs
     where requirement_id = ${id} and status = 'running'
     order by stage, created_at desc, id desc`);
  const running = new Map(runningJobs.rows.map((job) => [job.stage, job.id]));

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
      ownerLine: row.owner_line,
      ownerLineLabel: lineLabelOf(row.owner_line),
      prdUrl: row.prd_url,
      platforms: normalizePlatforms(row.platforms),
      platformsLabel: platformsLabel(normalizePlatforms(row.platforms)),
      priority: normalizePriority(row.priority),
      priorityLabel: priorityLabel(normalizePriority(row.priority)),
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
    description: {
      context: row.context,
      problem: row.problem,
      outcome: row.outcome,
      surfaces: row.surfaces,
      edgeCases: row.edge_cases,
      outOfScope: row.out_of_scope,
    },
    refs: [
      artifactRef('evaluate', '评估材料', artifacts.get('evaluate'), running.get('evaluate') ?? null, currentHash),
      artifactRef('review', '评审材料', artifacts.get('review'), running.get('review') ?? null, currentHash),
      artifactRef('inspect', '走查材料', artifacts.get('inspect'), running.get('inspect') ?? null, currentHash),
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
    actions,
    permissions,
  };
}
