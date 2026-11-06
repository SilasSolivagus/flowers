import { AppError } from './errors.js';

export type State =
  | 'inbox' | 'design' | 'review' | 'queue' | 'ready'
  | 'dev' | 'test' | 'live' | 'rejected' | 'shelved';

/** 十个状态的中文名。tick 的报错、触发不符的报错都从这里取，避免出现第二份映射。 */
export const STATE_LABEL: Record<State, string> = {
  inbox: '收集',
  design: '待设计',
  review: '待评审',
  queue: '待排期',
  ready: '待开发',
  dev: '开发中',
  test: '测试中',
  live: '已上线',
  rejected: '已拒绝',
  shelved: '已搁置',
};

/** 触发方式。同一对 from/to 可能被不同动作踩到，trigger 就是用来区分它们的。 */
export type Trigger =
  | 'evaluate' | 'submit_review' | 'reject' | 'shelve'
  | 'review_pass' | 'review_reject' | 'schedule'
  | 'clock' | 'bounce' | 'restore';

/**
 * 状态机亲自执行的门禁。
 *
 * 只有「需求身上就能验证」的两条留在这里：
 * - prd：进评审必须有正式 PRD 链接；
 * - type：需求必须有类型（商业 / 功能）。
 *
 * 另外两种门不看状态表，由**拥有那道数据的服务**执行，写在这里只会变成装饰
 * （读它的人为零）：
 * - dates（queue → ready）：版本 + 提测日 + 承诺完成日的一致性在 schedule.ts 里校验
 *   （三个日期互相比较、还要和版本发版日比较，状态机拿不到这些列）；
 * - new_due（test → dev）：打回必须重填承诺完成日，在 bounce.ts 里校验（还要和
 *   「今天」比，见 R23）。
 */
export type Guard = 'prd' | 'type';

export type Transition = {
  from: State; to: State; trigger: Trigger;
  clock?: boolean;
  guard?: Guard;
};

/**
 * 全部合法单步迁移。`readonly` 是刻意的：这张表是口径本身，运行期不该有人往里写。
 *
 * `clock: true` 的三条由 tick 执行，其余由服务执行。tick 的边**从这张表派生**
 * （见 clock/tick.ts 的 clockEdges），不允许另抄一份。
 */
export const TRANSITIONS: readonly Transition[] = [
  { from: 'inbox',  to: 'design',  trigger: 'evaluate',      guard: 'type' },
  { from: 'inbox',  to: 'review',  trigger: 'submit_review', guard: 'prd'  },
  { from: 'inbox',  to: 'rejected', trigger: 'reject' },
  { from: 'inbox',  to: 'shelved', trigger: 'shelve' },
  { from: 'design', to: 'review',  trigger: 'submit_review', guard: 'prd'  },
  { from: 'review', to: 'queue',   trigger: 'review_pass' },
  { from: 'review', to: 'design',  trigger: 'review_reject' },
  { from: 'queue',  to: 'ready',   trigger: 'schedule' },
  { from: 'ready',  to: 'dev',     trigger: 'clock',         clock: true },
  { from: 'dev',    to: 'test',    trigger: 'clock',         clock: true },
  { from: 'test',   to: 'live',    trigger: 'clock',         clock: true },
  { from: 'test',   to: 'dev',     trigger: 'bounce' },
  { from: 'shelved', to: 'inbox',  trigger: 'restore' },
];

/** 表里登记为时钟推进的迁移。tick 用它决定「哪些状态会被自动推进」。 */
export function clockTransitions(): readonly Transition[] {
  return TRANSITIONS.filter((t) => t.clock);
}

/**
 * 状态机执行门禁时需要的上下文。
 *
 * 可选是刻意的：只有真正会读它的迁移才该被传值。给一条 guard 为 prd 的迁移
 * 传 `hasPrd: true` 而没有真的检查过任何东西，就是在注释里撒谎；反过来，
 * 省略它不会「跳过门禁」——门禁是 fail-closed（见下面 assertTransition）。
 */
export type TransitionContext = { hasPrd?: boolean; hasType?: boolean };

/**
 * 按 from/to 取那一行迁移；没有这一对就是状态机的边界。
 *
 * 报错的两个人名用 `STATE_LABEL` 而不是 `State` 原值（R44）：这句话会被渲染到界面
 * 上（抽屉的动作失败消息），而 `State` 是库里/代码里的英文枚举，用户看到的会变成
 * 「不能从「queue」直接到「queue」」——同一条消息在 `assertTrigger` 里一直是中文的，
 * 两处措辞不一致只是因为 `find()` 先抛。措辞沿用 `assertTrigger` 的形状：
 * 「不能从「x」直接到「y」」，两端都取标签。
 */
export function find(from: State, to: State): Transition {
  const t = TRANSITIONS.find((x) => x.from === from && x.to === to);
  if (!t) {
    throw new AppError(
      'illegal_transition',
      `不能从「${STATE_LABEL[from]}」直接到「${STATE_LABEL[to]}」`,
    );
  }
  return t;
}

/**
 * 执行一条迁移自己的 guard。
 *
 * fail-closed：guard 需要 hasPrd / hasType 而调用方没给，就是没通过——不是「跳过检查」。
 * 这样「忘记传 ctx」会立刻炸在开发机上，而不是安静地放行。
 */
function assertGuards(t: Transition, ctx: TransitionContext): void {
  if (t.guard === 'prd' && ctx.hasPrd !== true) {
    throw new AppError('missing_prd', '直接提交评审必须有正式 PRD 链接');
  }
  if (t.guard === 'type' && ctx.hasType !== true) {
    throw new AppError('missing_type', '需求必须有类型（商业 / 功能）才能进入下一步');
  }
}

/** 校验一对 from/to 是否合法，并执行这条迁移自己的 guard。 */
export function assertTransition(
  from: State, to: State, ctx: TransitionContext = {},
): Transition {
  const t = find(from, to);
  assertGuards(t, ctx);
  return t;
}

/**
 * 校验「这一对迁移 + 是这个动作踩的」。
 *
 * 只按 from/to 配对是不够的：同一对状态可能有多条路。`inbox → design` 既可能是
 * 评估，也可能是一次走错门的打回；`ready → dev` 既可能是时钟，也可能是打回。
 * 光看配对，走错门的动作会被当成合法迁移执行，静默顶掉别人那一步。
 *
 * 出错时的措辞分开：
 * - 配对本身不存在 → 「不能从「待评审」直接到「待排期」」（这是状态机的边界，用户看得懂；
 *   两端都是中文名，R44 见 find）；
 * - 配对存在但动作不对 → 「这条需求当前在「待评审」，不能执行这一步」。
 *   不能报配对：`inbox → design` 是**合法**的一对，说「不能从「收集」直接到「待设计」」
 *   等于告诉用户状态机坏了。
 *
 * 顺序：先查配对、再查动作、最后查门。动作不对时**不许**先报门——对一条 inbox 的
 * 需求点打回，会骑着合法的 `inbox → design` 走到 type 门上，于是用户看到「需求必须
 * 有类型」，而他其实只是点错了按钮。
 */
export function assertTrigger(
  from: State, to: State, trigger: Trigger, ctx: TransitionContext = {},
): Transition {
  const t = find(from, to);
  if (t.trigger !== trigger) {
    throw new AppError(
      'illegal_transition',
      `这条需求当前在「${STATE_LABEL[from]}」，不能执行这一步`,
    );
  }
  assertGuards(t, ctx);
  return t;
}
