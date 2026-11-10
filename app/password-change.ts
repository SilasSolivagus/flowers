import { sql } from 'drizzle-orm';
import type { Db } from '../src/db/client.js';
import { AppError } from '../src/core/errors.js';
import { memberByName } from '../src/core/auth/members.js';
import { setPassword, verifyHash } from '../src/core/auth/password.js';

/**
 * 自改密码（P4-05，设置 · 我的）。
 *
 * 三段：**旧密码验一次、两次新密码相等、再交给 `setPassword`**。这里不新增任何
 * 密码规则——长度、hash、落库全在 `src/core/auth/password.ts`（`assertPassword` /
 * `setPassword`）；这一层只回答「是不是本人」与「两次输入一致」这两件界面才有的事。
 *
 * 为什么放在 `app/` 而不是 `src/core/members/manage.ts`：成员管理那一组是**超管对
 * 别人**的动作，而这一条是**本人对自己**的动作。混进同一个服务会让「谁能改谁的
 * 密码」出现第二种读法；分开之后，`manage.ts` 的 `manageMembers` 仍然只覆盖
 * 「超管改别人」，本人改自己走这一条。
 */
export type ChangePasswordInput = {
  oldPassword?: unknown;
  newPassword?: unknown;
  confirm?: unknown;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function changePassword(
  db: Db, actor: string, raw: ChangePasswordInput,
): Promise<{ member: string }> {
  const me = await memberByName(db, actor);
  if (me === null || me.deactivatedAt !== null) {
    throw new AppError('forbidden', '这个名字不在名册上（或已停用）');
  }

  const oldPassword = text(raw.oldPassword);
  const newPassword = text(raw.newPassword);
  const confirm = text(raw.confirm);
  if (newPassword !== confirm) throw new AppError('invalid', '两次输入的新密码不一致');

  const stored = await db.execute<{ password_hash: string | null }>(sql`
    select password_hash from members where id = ${me.id}`);
  const ok = await verifyHash(oldPassword, stored.rows[0]?.password_hash ?? null);
  // 「旧密码不对」与「这个账号还没有密码」是同一句：后者只出现在从没设过密码的
  // 老数据上，而他能做的下一步是一样的（找超管重置）。
  if (!ok) throw new AppError('invalid', '旧密码不对');

  // 长度校验在 `setPassword` 里（`密码至少 8 位`），这里不抄第二份。
  await setPassword(db, me.id, newPassword);
  return { member: me.name };
}
