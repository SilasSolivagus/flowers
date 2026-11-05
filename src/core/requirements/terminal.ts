import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { assertTransition, type State } from '../state-machine.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';
import { parseRequirementId, requirePlainObject } from '../validate.js';
import { lockRequirement, moveTo } from './lock.js';

const MISSING_REASON_REJECT = '拒绝必须写原因';
const MISSING_REASON_SHELVE = '搁置必须写原因';
const ONLY_INBOX_REJECT = '只有收集状态的需求可以拒绝';
const TERMINAL_SHELVE = '终态不能再搁置';

/** 表单字段运行时可能是 undefined / null / 非字符串，先归一成去掉首尾空白的字符串。 */
function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 搁置的口径：任何**非终态**都能搁置。
 *
 * 状态机的 TRANSITIONS 只登记了 `inbox → shelved` 一条——那是刻意的最小表：
 * 它记录的是「一步迁移」，而「除终态外都能搁置」是 8 条迁移的并集，写进表里
 * 会把表撑成噪音（也无法表达「以后新增的状态默认能不能搁置」）。所以这条规则
 * 由本函数承载，状态机继续负责单步迁移与 guard。
 *
 * 写成穷举 switch 而不是 `state !== 'rejected' && state !== 'shelved'`：给 State
 * 加成员时，这里会因为「函数末尾不可达的返回」而**编译失败**，逼人重新表态；
 * 反过来，写一个不在 State 里的字面量同样编译失败。denylist 写法两个都不会报。
 */
function isShelvable(state: State): boolean {
  switch (state) {
    case 'inbox':
    case 'design':
    case 'review':
    case 'queue':
    case 'ready':
    case 'dev':
    case 'test':
    case 'live':
      return true;
    case 'rejected':
    case 'shelved':
      return false;
  }
}

/**
 * 拒绝：inbox → rejected，必须写原因。
 *
 * 只有收集状态能拒绝：需求一旦评估过（design 起），毙掉它就已经是评审意见，
 * 走的是 reviewReject（review → design）而不是这里。状态机里通往 rejected 的
 * 迁移也**只有** `inbox → rejected` 一条，所以这道判定与表说的是同一件事；
 * 这里给出业务措辞（'只有收集状态的需求可以拒绝'），随后再调一次
 * `assertTransition`，把「表里确实登记了这一条」变成运行时可验证的事实——
 * 有人删掉那行迁移时，本函数会先炸，而不是静默放行。
 */
export async function rejectRequirement(db: Db, actor: string, raw: unknown) {
  // 入口守卫全部在事务之前：非对象 → '参数不合法'；原因空白没必要占连接、开事务再回滚；
  // 非 uuid 会被 PG 以 22P02 拒绝，那不是 AppError，控制器按 code 分支时只能当未知错误。
  const input = requirePlainObject(raw);
  const reason = asText(input.reason);
  if (!reason) throw new AppError('missing_reason', MISSING_REASON_REJECT);

  const requirementId = parseRequirementId(input);

  return db.transaction(async (tx) => {
    const row = await lockRequirement(tx, requirementId);
    if (row.state !== 'inbox') throw new AppError('illegal_transition', ONLY_INBOX_REJECT);

    // 这条迁移没有 guard（拒绝不需要 PRD / 类型），所以不传 ctx。
    assertTransition(row.state, 'rejected');

    await moveTo(tx, requirementId, 'rejected');

    await recordEvent(tx, {
      requirementId, actor, type: 'requirement.rejected',
      payload: { from: row.state, to: 'rejected', reason },
    });

    return { state: 'rejected' as const };
  });
}

/**
 * 搁置：任何非终态 → shelved，必须写原因。
 *
 * 为什么原因必填：搁置是「这件事先不做」，一年后翻事件流时唯一能回答「为什么」的
 * 就是这句话；和 reviewReject / bounce 一样，理由缺失视为用户错误，不落一条空原因。
 *
 * 不清理 commit_due_at / commit_test_at / release_id：搁置是暂停不是撤销，上一次
 * 承诺过的版本和日期是决策记录的一部分（谁在什么节点被叫停，报表要能还原）。
 * 恢复落到 inbox 之后这些列不会被误用——时钟只认 ready / dev / test，而重新排期
 * 必须再走 queue → ready → schedule，届时三列会被整体覆盖。
 */
export async function shelveRequirement(db: Db, actor: string, raw: unknown) {
  const input = requirePlainObject(raw);
  const reason = asText(input.reason);
  if (!reason) throw new AppError('missing_reason', MISSING_REASON_SHELVE);

  const requirementId = parseRequirementId(input);

  return db.transaction(async (tx) => {
    const row = await lockRequirement(tx, requirementId);

    if (!isShelvable(row.state)) throw new AppError('illegal_transition', TERMINAL_SHELVE);

    // 表里登记的那一条（inbox → shelved）仍然过一遍状态机：删掉它，实现会立刻炸。
    // 其余状态在表里没有对应行（刻意），只由上面的 isShelvable 判定。
    if (row.state === 'inbox') {
      assertTransition(row.state, 'shelved');
    }

    await moveTo(tx, requirementId, 'shelved');

    // 作废还挂着的派单：handed 的含义是「这条需求正在评审、归这个人」。留着它，
    // 恢复 → 重新提交评审时 assignReviewer 的 `where not exists (handed)` 会认为
    // 已经派过单，于是这条需求再也拿不到新派单，卡在待评审没人接。
    // 从评审以外的状态搁置时这条 update 命中 0 行，无副作用。
    await tx.execute(sql`
      update review_assignments set verdict = 'voided', reason = ${reason}, decided_at = now()
       where requirement_id = ${requirementId} and verdict = 'handed'`);

    await recordEvent(tx, {
      requirementId, actor, type: 'requirement.shelved',
      payload: { from: row.state, to: 'shelved', reason },
    });

    return { state: 'shelved' as const };
  });
}

/**
 * 恢复：shelved → inbox（只有这一条）。
 *
 * 刻意回 inbox 而不是回搁置前那一步：搁置可能持续几个版本，回来时原来那个版本、
 * 那套日期、那位评审人大概都已经不成立了。回到收集状态等于「重新走一遍流程」，
 * 编号 / PRD 链接这些身份信息保留，排期信息等重新排期时再覆盖。
 *
 * 迁移表里只有 `shelved → inbox` 这一对通向 inbox，所以只按 from/to 配对判断就够：
 * 对别的状态调恢复都会撞 illegal_transition（'不能从「dev」直接到「inbox」'）。
 */
export async function restoreRequirement(db: Db, actor: string, raw: unknown) {
  const input = requirePlainObject(raw);
  const requirementId = parseRequirementId(input);

  return db.transaction(async (tx) => {
    const row = await lockRequirement(tx, requirementId);
    assertTransition(row.state, 'inbox');

    // skip_reason 描述的是**这一轮**提交流程（报表按它统计「跳过评估」的捷径），
    // 恢复等于重新走一遍，旧标记必须清掉；当初跳过的事实留在
    // requirement.review_requested 的 payload 里，历史不丢。
    // prd_url / number 是身份信息，不跟着流程标记一起清。
    await moveTo(tx, requirementId, 'inbox', sql`skip_reason = null`);

    // 恢复不需要原因：搁置时写下的那句原因仍然在事件流里，恢复只是撤销那个暂停。
    await recordEvent(tx, {
      requirementId, actor, type: 'requirement.restored',
      payload: { from: row.state, to: 'inbox' },
    });

    return { state: 'inbox' as const };
  });
}
