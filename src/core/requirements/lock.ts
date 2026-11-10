import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import type { State } from '../state-machine.js';

/** 事务句柄。与 events.ts / review.ts 里的同义类型一致。 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * 取出来的行。这些列就是所有调用方的并集，不是「以后可能有用」：
 * - state：每个调用方都要拿它做 assertTransition；
 * - prd_url：prd guard 的判定依据；
 * - type：**不再是 guard 的依据**（Ruling 1 摘掉了 `guard: 'type'`），留着是因为
 *   `evaluateInTx` 的调用方拿同一行当返回值、而 `Locked` 是那几处的公共形状；
 *   它现在只是一条内容属性，读它不会改变任何判断；
 * - context / problem / outcome：核心三问（2026-11-10 的 `brief` 门判据，见
 *   `brief.ts`）。`inbox → design` 那道门要**逐条点名缺哪几格**，而它只能读这一行上
 *   真实的值——从调用方的口头断言里读，等于允许「我说填了」。既然已经 `for update`
 *   锁了这一行，顺手取回来比再查一次便宜，也不会读到半旧的行（attach 那条路就是
 *   这样把同一个 `Locked` 传给 `evaluateInTx` 的）。
 *
 * 不提供 selectExtra 之类的参数：列名是拼接进 SQL 的字符串字面量，谁传谁就绕过了
 * 参数化；而目前没有任何调用方需要这七列以外的列。
 */
export type Locked = {
  state: State;
  type: string | null;
  prd_url: string | null;
  /**
   * 负责人（P4-04）。加这一列不是为了状态机，是为了**权限判断**：`can()` 要回答
   * 「这条需求是不是你的」，而它只能读库里的那张 fact，不能听调用方的口头断言。
   * 既然已经 `for update` 锁了这一行，顺手取回来比再查一次便宜、也不会读到半旧的行。
   */
  owner_member_id: string | null;
  /**
   * 负责人所在条线（P4-06）。权限的锚点从「需求类型」换成「人的归属」之后，
   * **每一处判权限的地方都要它**，而它只能来自负责人那一行（`members.line`）。
   * 与负责人同一行、同一次锁里取回来：分两次查会出现「负责人已经换了、条线还是旧值」
   * 的半旧读法，而 `can()` 是一个布尔判断，它不会告诉你它读到了两个时刻。
   *
   * 左边 join：没有负责人（null）与负责人没有条线（null）都要能读出来——前者可认领，
   * 后者只有超管能动，两件事必须分开判断（见 roles.ts）。
   */
  owner_line: string | null;
  /**
   * 核心三问的三格（`null` = 没写；空白串在写入端已归一成 null）。判据在 `brief.ts`，
   * 与读模型、生成前那道门共用同一份——这里只是把库里的值取回来给它。
   */
  context: string | null;
  problem: string | null;
  outcome: string | null;
};

/**
 * 锁住一条需求并取回判态所需的三列。
 *
 * 取行用 `for update`：并发对同一条需求做状态动作时，后来者会等前者提交，再基于
 * **新状态**重新判断，于是第二次撞上 illegal_transition，而不是两个都通过、
 * 各写一条事件、把状态推两步。
 *
 * 行不存在就抛 not_found（消息各服务统一）：锁不到的行不能被假装推进一步。
 *
 * **软删（`deleted_at`）在这一层挡**：软删的意思是「从每一条读路径上消失，只为历史
 * 保留」，而状态动作是**写**路径上最要紧的一条读——不挡住它，一条已经不在板上的需求
 * 照样能被立项 / 提交评审 / 排期 / 打回 / 搁置，每一步都写一条事件。判据放这里而不是
 * 每个服务里各写一遍，是因为**每个状态动作都从这里过**（evaluate / submit-review /
 * review / assign / claim / schedule / bounce / terminal 全部），一处过滤覆盖全部调用方；
 * 散到 8 个地方写，漏一个就重新长回同一个洞。
 *
 * 不存在与已删除抛同一个 `not_found`、同一句中文：对着调用方它们是一件事——这一行
 * 没有可以被推进的状态。何况调用方本来就按 code 分支，多一个码只会多一条没人测的路径。
 * 走到这里时还没有任何写入（锁行是先手），所以「失败」与「什么都没发生」是同一件事。
 */
export async function lockRequirement(tx: Tx, requirementId: string): Promise<Locked> {
  // `for update of r`：join 进来的是 members（左侧是 r），不加 `of r` 的
  // `for update` 在 PG 里会撞上「FOR UPDATE cannot be applied to the nullable side
  // of an outer join」——而这里锁的本来也只是需求那一行。
  const cur = await tx.execute<Locked>(sql`
    select r.state, r.type, r.prd_url, r.owner_member_id, m.line as owner_line,
           r.context, r.problem, r.outcome
      from requirements r
      left join members m on m.id = r.owner_member_id
     where r.id = ${requirementId}
       and r.deleted_at is null
       for update of r`);
  const row = cur.rows[0];
  if (!row) throw new AppError('not_found', '找不到这条需求');
  return row;
}

/**
 * 把锁住的行推进到 `to`，并刷新 state_entered_at。
 *
 * `extraSet` 是调用方自己的 `列 = 值` 片段（多个用逗号连），用来写这一步独有的字段
 * （submit-review 的 prd_url / skip_reason、schedule 的三个日期、bounce 的
 * commit_due_at）。值仍然走参数绑定：调用方只提供片段，不提供列名以外的拼接。
 *
 * `at` 只给时钟用：tick 的 state_entered_at 必须落在它自己的 `now` 上（时间轴要对
 * 得上被注入的 tick 时刻），而不是事务提交时的 `now()`。其余调用方不传，走 now()。
 *
 * 状态列与 state_entered_at 由本函数写，调用方不必重复写 `state = ...`，也就不会
 * 漏掉那条不变量（「进当前状态的时刻」永远和状态一起变）。
 */
export async function moveTo(
  tx: Tx, requirementId: string, to: State, extraSet?: SQL, at?: string,
): Promise<void> {
  const entered = at === undefined
    ? sql`state_entered_at = now()`
    : sql`state_entered_at = ${at}::timestamptz`;
  const set = extraSet
    ? sql.join([sql`state = ${to}`, extraSet, entered], sql`, `)
    : sql.join([sql`state = ${to}`, entered], sql`, `);
  await tx.execute(sql`update requirements set ${set} where id = ${requirementId}`);
}
