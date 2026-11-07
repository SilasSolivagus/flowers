import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { recordEvent } from '../events.js';
import { AppError, withPgErrors } from '../errors.js';
import { requirePlainObject } from '../validate.js';
import { assertCan, requireActor } from '../auth/guard.js';
import { memberByName } from '../auth/members.js';
import { can, type Member } from '../auth/roles.js';

// required_error / invalid_type_error 显式给中文：缺字段时 zod 默认抛 'Required'，
// 而对外错误只暴露 issues[0].message，前端会看到英文。
const NOT_BLANK = (message: string) => ({
  required_error: message,
  invalid_type_error: message,
});

const BAD_OWNER = '负责人 ID 格式不正确';

/**
 * 六问的入参形状（P4-02）。
 *
 * 全部 `nullish`：**新建只要 title / type / requester**。六问是「鼓励写」，不是门槛
 * ——真实的需求常常先建一条再补描述，把六问做成必填只会逼人在每一格里填「无」，
 * 而这种「无」比空着更坏：它看起来像有内容。
 *
 * 空白串在 `createRequirement` 里归一成 null：库里 null 与 '' 是同一件事
 * （见 `fingerprint.ts` 文件头第 2 条），写入端只保留一种写法。
 */
export const DescriptiveInput = z.object({
  context: z.string().nullish(),
  problem: z.string().nullish(),
  outcome: z.string().nullish(),
  surfaces: z.string().nullish(),
  edgeCases: z.string().nullish(),
  outOfScope: z.string().nullish(),
});

export type DescriptiveInput = z.infer<typeof DescriptiveInput>;

export const CreateInput = z.object({
  title: z.string(NOT_BLANK('标题不能为空')).trim().min(1, '标题不能为空'),
  type: z.enum(['commercial', 'feature'], { message: '必须选择类型：商业或功能' }),
  requester: z.string(NOT_BLANK('提出人不能为空')).trim().min(1, '提出人不能为空'),
  ownerMemberId: z.string(NOT_BLANK(BAD_OWNER)).uuid(BAD_OWNER).nullish(),
}).merge(DescriptiveInput);

export type CreateInput = z.infer<typeof CreateInput>;

/**
 * 负责人的人选（规则 1 的实现，见 `createRequirement` 里那段注释）。
 *
 * `undefined`（字段根本没出现）与 `null`（显式「不指定」）在**超管**那里意义不同：
 * 前者 = 我自己，后者 = 留空等人认领。对其他人两者一样：都是自己。
 */
async function resolveOwner(
  db: Db, actor: Member, input: { type: string; ownerMemberId?: string | null },
): Promise<string | null> {
  const wanted = input.ownerMemberId;

  if (wanted === undefined) return actor.id;
  if (wanted === null) return can(actor, { type: input.type, ownerMemberId: null }, 'admin')
    ? null
    : actor.id;

  if (wanted === actor.id) return actor.id;

  // 想指定别人：必须有权转交，而且那个人得真的在名册上、还在职。
  await assertCan(db, actor.name, { type: input.type, ownerMemberId: actor.id }, 'reassignOwner');
  const target = await memberByName(db, await nameOf(db, wanted));
  if (target === null || target.deactivatedAt !== null) {
    throw new AppError('invalid', '负责人不在名册上（或已停用）');
  }
  // 条线负责人只能在本线内转交（超管不受限）。
  if (!can(actor, { type: input.type, ownerMemberId: actor.id }, 'admin')
    && target.line !== input.type) {
    throw new AppError('forbidden', '只能把需求交给本线的人');
  }
  return target.id;
}

/** id → 名字。只为把「查无此人」与「名字对不上 id」合成一句中文。 */
async function nameOf(db: Db, memberId: string): Promise<string> {
  const found = await db.execute<{ name: string }>(
    sql`select name from members where id = ${memberId} limit 1`);
  return found.rows[0]?.name ?? '';
}

/** 空白 → null。写库只保留一种「没写」。 */
function blankToNull(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
}

export async function createRequirement(db: Db, actor: string, raw: unknown) {
  // 非对象 body（null / 数组 / 字符串）zod 只给英文 'Expected object, received …'，
  // 这里的错误消息是唯一对外出口，统一走 validate.ts 的同一句中文。
  const parsed = CreateInput.safeParse(requirePlainObject(raw));
  if (!parsed.success) {
    throw new AppError('invalid', parsed.error.issues[0]?.message ?? '参数不合法');
  }
  const input = parsed.data;

  /**
   * 规则 1「录入即负责人」（P4-04）：**谁建谁负责**。
   *
   * 为什么把这条规则从「界面默认值」搬进服务层：界面把 `ownerMemberId` 预填成当前成员，
   * 于是从页面上看这条规则永远成立；而 API / MCP 的调用方不经过那个表单——一个 PM
   * 的 token 只要塞一个别人的 id，就能造出一条「归别人、但由我创建」的需求。默认值
   * 不是规则，服务层里的这一句才是。
   *
   * 四个分支，逐个说：
   * 1. 没传（或传 null）→ 负责人就是 actor；
   * 2. 传的是自己 → 照写；
   * 3. 传的是别人 → 需要 `reassignOwner`（超管、或本线的条线负责人）。条线负责人
   *    只能把本线的需求交给本线的人：跨线转交等于他能往别人的线上塞活；
   * 4. 超管显式传 null → 允许「没人认领」（演示里那条「待接单」的卡就是靠它，
   *    否则创建者总会变成负责人，看板上就再也画不出「等认领」这个真实状态）。
   */
  const actorMember = await requireActor(db, actor);
  const ownerMemberId = await resolveOwner(db, actorMember, input);

  // `number` 由 requirements_number_seq 分配（列上有 default），这里**不写**它，
  // 也不再扫 `max(number)+1`：并发建需求时两个事务会读到同一个 max，输的那个撞
  // requirements_number_unique。序列的 nextval 是原子的，且不参与事务。
  //
  // 六问与标题同一条 insert（P4-02）：分成「先建再 update」会让这条需求在两次提交
  // 之间处于「有标题、没描述」的状态，而它已经出现在看板上了。
  return withPgErrors(() => db.transaction(async (tx) => {
    const inserted = await tx.execute<{ id: string; number: number; state: string }>(sql`
      insert into requirements
        (title, type, state, requester, owner_member_id,
         context, problem, outcome, surfaces, edge_cases, out_of_scope)
      values (
        ${input.title}, ${input.type}, 'inbox', ${input.requester}, ${ownerMemberId},
        ${blankToNull(input.context)}, ${blankToNull(input.problem)}, ${blankToNull(input.outcome)},
        ${blankToNull(input.surfaces)}, ${blankToNull(input.edgeCases)}, ${blankToNull(input.outOfScope)}
      )
      returning id, number, state`);
    const row = inserted.rows[0]!;
    const number = Number(row.number);
    await recordEvent(tx, {
      requirementId: row.id, actor, type: 'requirement.created',
      payload: { number, title: input.title, type: input.type },
    });
    return { id: row.id, number, state: row.state as 'inbox' };
  }));
}
