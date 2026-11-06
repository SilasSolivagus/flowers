import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { recordEvent } from '../events.js';
import { AppError, withPgErrors } from '../errors.js';
import { requirePlainObject } from '../validate.js';

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
        ${input.title}, ${input.type}, 'inbox', ${input.requester}, ${input.ownerMemberId ?? null},
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
