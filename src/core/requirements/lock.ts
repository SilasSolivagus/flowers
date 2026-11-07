import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import type { State } from '../state-machine.js';

/** 事务句柄。与 events.ts / review.ts 里的同义类型一致。 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * 取出来的行。三个列就是所有调用方的并集，不是「以后可能有用」：
 * - state：每个调用方都要拿它做 assertTransition；
 * - type / prd_url：prd / type 两个 guard 的判定依据。
 *
 * 不提供 selectExtra 之类的参数：列名是拼接进 SQL 的字符串字面量，谁传谁就绕过了
 * 参数化；而目前没有任何调用方需要第四个列。
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
};

/**
 * 锁住一条需求并取回判态所需的三列。
 *
 * 取行用 `for update`：并发对同一条需求做状态动作时，后来者会等前者提交，再基于
 * **新状态**重新判断，于是第二次撞上 illegal_transition，而不是两个都通过、
 * 各写一条事件、把状态推两步。
 *
 * 行不存在就抛 not_found（消息各服务统一）：锁不到的行不能被假装推进一步。
 */
export async function lockRequirement(tx: Tx, requirementId: string): Promise<Locked> {
  const cur = await tx.execute<Locked>(
    sql`select state, type, prd_url, owner_member_id from requirements where id = ${requirementId} for update`);
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
