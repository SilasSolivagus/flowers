import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';

// required_error / invalid_type_error 显式给中文：缺字段时 zod 默认抛 'Required'，
// 而对外错误只暴露 issues[0].message，前端会看到英文。
const NOT_BLANK = (message: string) => ({
  required_error: message,
  invalid_type_error: message,
});

export const CreateInput = z.object({
  title: z.string(NOT_BLANK('标题不能为空')).trim().min(1, '标题不能为空'),
  type: z.enum(['commercial', 'feature'], { message: '必须选择类型：商业或功能' }),
  requester: z.string(NOT_BLANK('提出人不能为空')).trim().min(1, '提出人不能为空'),
  ownerMemberId: z.string().uuid().nullish(),
});

export type CreateInput = z.infer<typeof CreateInput>;

export async function createRequirement(db: Db, actor: string, raw: unknown) {
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
