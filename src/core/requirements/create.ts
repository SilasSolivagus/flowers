import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';
import { isPlainObject } from '../validate.js';

// required_error / invalid_type_error 显式给中文：缺字段时 zod 默认抛 'Required'，
// 而对外错误只暴露 issues[0].message，前端会看到英文。
const NOT_BLANK = (message: string) => ({
  required_error: message,
  invalid_type_error: message,
});

const BAD_OWNER = '负责人 ID 格式不正确';

export const CreateInput = z.object({
  title: z.string(NOT_BLANK('标题不能为空')).trim().min(1, '标题不能为空'),
  type: z.enum(['commercial', 'feature'], { message: '必须选择类型：商业或功能' }),
  requester: z.string(NOT_BLANK('提出人不能为空')).trim().min(1, '提出人不能为空'),
  ownerMemberId: z.string(NOT_BLANK(BAD_OWNER)).uuid(BAD_OWNER).nullish(),
});

export type CreateInput = z.infer<typeof CreateInput>;

export async function createRequirement(db: Db, actor: string, raw: unknown) {
  // 非对象 body（null / 数组 / 字符串）zod 只给英文 'Expected object, received …'，
  // 这里的错误消息是唯一对外出口，统一换成本项目的中文文案。
  if (!isPlainObject(raw)) throw new AppError('invalid', '参数不合法');

  const parsed = CreateInput.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('invalid', parsed.error.issues[0]?.message ?? '参数不合法');
  }
  const input = parsed.data;

  return db.transaction(async (tx) => {
    const next = await tx.execute<{ n: number }>(sql`select coalesce(max(number),0)+1 as n from requirements`);
    const number = Number(next.rows[0]!.n);
    const inserted = await tx.execute<{ id: string; state: string }>(sql`
      insert into requirements (number, title, type, state, requester, owner_member_id)
      values (${number}, ${input.title}, ${input.type}, 'inbox', ${input.requester}, ${input.ownerMemberId ?? null})
      returning id, state`);
    const row = inserted.rows[0]!;
    await recordEvent(tx, {
      requirementId: row.id, actor, type: 'requirement.created',
      payload: { number, title: input.title, type: input.type },
    });
    return { id: row.id, number, state: row.state as 'inbox' };
  });
}
