import { AppError } from './errors.js';
import { evaluateLock, type SixAnswers } from './requirements/brief.js';

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

/**
 * 触发方式。同一对 from/to 可能被不同动作踩到，trigger 就是用来区分它们的。
 *
 * 2026-11-10 owner 的第二次纠正：`evaluate` → `approve`。
 *
 * 这条边的名字曾经叫 `evaluate`（评估），因为当时「生成评估材料」与「进待设计」是
 * 同一件事（材料落在库上，attach 顺手把需求推过去）。拆开之后它们不是一件事了：
 * **生成材料不再改状态**，`inbox → design` 只由人点「立项」触发。名字留着 `evaluate`
 * 会让下一个人以为「评估 = 立项」，而那条边已经与「评估材料」没有任何关系。
 *
 * 所以 trigger 叫 `approve`（立项 / 批准进入设计），`evaluate` 这个名字在状态机里
 * 不再存在；「评估」两个字只剩一个合法的去处：**评估材料**（`Stage` 里的 `evaluate`，
 * 那是产物槽位，不是状态迁移）。
 */
export type Trigger =
  | 'approve' | 'submit_review' | 'reject' | 'shelve'
  | 'review_pass' | 'review_reject' | 'schedule'
  | 'clock' | 'bounce' | 'restore'
  /** 回滚（2026-11-10）：已上线 → 待排期。发出去的东西有问题，退回去重排。 */
  | 'rollback'
  /** 退回待开发（2026-11-11）：开发中 → 待开发。接错了/方案变了，退回去重新排。 */
  | 'reopen';

/**
 * 状态机亲自执行的门禁。
 *
 * 只有「需求身上就能验证」的那两条：
 * - prd：进评审必须有正式 PRD 链接；
 * - brief：立项（收集 → 待设计）必须有核心三问（谁在什么情况下用 / 现在怎么做哪不好 /
 *   做成什么样算成功）。
 *
 * ## Ruling 2（2026-11-10）：`brief` 这道门挂在**变迁**上，不挂在生成器上
 *
 * owner 的裁决：「六问不齐不能立项。收集阶段必须填好核心三问才能点立项；立项就进
 * 待设计，所以『六问不齐』既不能生成材料、也不能进待设计。」（2026-11-10 的第二次
 * 纠正把「生成材料」与「立项」拆成两个动作，但这道门管的两件事没变：材料不能编，
 * 立项不能空。）实测收集 244 条里六问全齐
 * 只有 1 条（后三格在收集阶段本来就填不出来），卡「六问全齐」等于上线即空转，所以必填
 * 只取核心三条；判据与那句话在 `requirements/brief.ts`，一处定义、三处共用。
 *
 * 门为什么在这条边上：**立项是一个动作，材料是另一个动作的产物**（2026-11-10 之后
 * 两者彻底分开）。只把门装进生成器，挡住的是「不许出材料」，而「没有六问的需求照样
 * 能立项」会从别的入口漏过去——MCP 的 `requirement_start_design`、将来的批量导入。
 * 装在这条边上，所有入口一次覆盖：状态的每一次 `inbox → design` 都要过这道门。
 *
 * 反过来说，**这条路已经不是「attach 材料」的路**：材料落库不再改状态（见
 * `uemaster/attach.ts`），所以「没有六问 ⇒ 不能立项」不再依赖「attach 与迁移同事务」
 * 那套原子性——那条耦合正是 owner 第二次纠正要拆掉的东西。
 *
 * 这道门**只作用于 `inbox → design`**：已经过了评估的需求（review / queue / ready /
 * dev / test / live / rejected / shelved）的存量数据一个字不动——终态与进行中的位置是
 * 已经发生过的判断，不能用一条今天的规则去改写（同 0021 那条迁移的口径）。
 *
 * ## Ruling 1（2026-11-08）：`type` 那道门**摘掉了**
 *
 * 表里原本有第二条 `guard: 'type'`（`inbox → design`，需求必须有类型才能立项）。
 * owner 的裁决：负责人决定评审人（P4-06 之后派单锚在 `members.line`），**类型不再
 * 承载权限**，那么「没有类型的需求不该被卡住」。于是这条门连同 `hasType` 这个
 * 上下文键一起删掉——不是「改成恒真」，是真的不留：一张表里留着 `guard: 'type'`
 * 而 `assertGuards` 里没有对应分支，下一个人会以为它在生效。
 *
 * 这一条删得有代价，代价是**记录在案的**：`tests/type-optional.test.ts` 让一条
 * 没有类型的 inbox 需求走通立项（把 guard 加回去，那条用例变红）。
 *
 * 另外两种门不看状态表，由**拥有那道数据的服务**执行，写在这里只会变成装饰
 * （读它的人为零）：
 * - dates（queue → ready）：版本 + 提测日 + 承诺完成日的一致性在 schedule.ts 里校验
 *   （三个日期互相比较、还要和版本发版日比较，状态机拿不到这些列）；
 * - new_due（test → dev）：打回必须重填承诺完成日，在 bounce.ts 里校验（还要和
 *   「今天」比，见 R23）。
 *
 * 还有一道**读同一列、措辞不同**的门：规则 2（2026-11-08 裁定）「没有 PRD 的需求不能排期」
 * 也在 schedule.ts 里，判据同样是 `prd_url`。它**没有**挂成 `guard: 'prd'`：那道门的那句
 * 话是评审专用的（「直接提交评审必须有正式 PRD 链接」），挂着它去点「排期」会说错动作。
 * 表里因此仍然只有评审那两行带 `guard: 'prd'`，而「排期也要 PRD」这句话的唯一出处是
 * `schedule.ts` 与本段注释。
 */
export type Guard = 'prd' | 'brief';

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
  // Ruling 1：立项不再要求类型（`guard: 'type'` 已摘掉，见上面 `Guard` 的注释）。
  // Ruling 2：立项要求核心三问（`guard: 'brief'`，判据在 `requirements/brief.ts`）。
  // 2026-11-10：trigger 从 `evaluate` 改名 `approve`——生成材料不再走这条边，
  // 这条边只剩「立项」一个含义（见 `Trigger` 的注释）。
  { from: 'inbox',  to: 'design',  trigger: 'approve', guard: 'brief' },
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
  // 退回待开发（2026-11-11）：开发中发现自己接错了/方案变了，退回去重新排期。
  // 与 bounce（测试→开发）方向相同、语义不同：那是「测试没过」，这是「开发还没真正开始」。
  { from: 'dev',    to: 'ready',   trigger: 'reopen' },
  { from: 'shelved', to: 'inbox',  trigger: 'restore' },
  // 回滚（2026-11-10）：唯一一条倒着走的边。落到 queue 而不是 dev 的理由写在
  // requirements/rollback.ts 的文件头——dev 的时钟会立刻把它推回测试与已上线。
  { from: 'live',   to: 'queue',   trigger: 'rollback' },
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
 *
 * `brief` 是**整行六问**（只需要前三格，但传整行最省事，也避免了调用方重新挑字段）：
 * 门要逐条点名缺哪几格，只给一个布尔就说不出来「还差哪一条」。
 * 省略它 = 三格全空 = 拒绝（同样 fail-closed：忘记传 ctx 会立刻炸在开发机上）。
 *
 * `hasType` 在 Ruling 1 之后不存在了：类型不再是门（`type` 列可空，且不承载权限）。
 * 删掉这个键而不是留着不用，是为了让「谁还在读类型」在类型检查里就暴露出来。
 */
export type TransitionContext = { hasPrd?: boolean; brief?: SixAnswers };

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
 * fail-closed：guard 需要 hasPrd / brief 而调用方没给，就是没通过——不是「跳过检查」。
 * 这样「忘记传 ctx」会立刻炸在开发机上，而不是安静地放行。
 *
 * 两句中文的形状不同，因为两件事不同：
 * - prd 是一道「有 / 没有」的门，没有可点的东西可说，所以只把要求说清；
 * - brief 是**能逐条点名**的门（缺哪几格是可知的，而且补它就在同一个页面的 `?edit=1`
 *   后面），所以给出缺项与下一步。这句话不承诺做不到的事：状态机里没有
 *   「待设计 → 收集」这条边，所以它一个字都不提「退回收集」。
 */
function assertGuards(t: Transition, ctx: TransitionContext): void {
  if (t.guard === 'prd' && ctx.hasPrd !== true) {
    throw new AppError('missing_prd', '直接提交评审必须有正式 PRD 链接');
  }
  if (t.guard === 'brief') {
    // `?? {}`：三格全空 → 三格全点名（fail-closed）。判断与那句话都在 brief.ts，
    // 生成前与抽屉读的是同一个函数、同一个字符串。
    const refusal = evaluateLock(ctx.brief ?? {});
    if (refusal !== null) throw new AppError('missing_brief', refusal);
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
 * 顺序：先查配对、再查动作、最后查门。动作不对时**不许**先报门——一个走错门的动作
 * 骑着一条合法的配对到达带门的迁移时，用户看到的会是「直接提交评审必须有正式 PRD
 * 链接」/「还差两条没填：…」，而他其实只是点错了按钮。（Ruling 1 之前这里举的例子是
 * type 门，那道门已经摘掉；这条顺序规则本身不因为少了一道门而改变。）
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
