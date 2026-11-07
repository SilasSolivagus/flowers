import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { can, type Member } from '../auth/roles.js';

/**
 * 设置 · 成员（P4-05）的读模型。
 *
 * 只有一行判断：**谁能看这一页**。它不复制 `can()` 的任何分支，只调用它一次
 * （`manageMembers` = 超管）。页面拿到 null 就不渲染这一段；server action 那一侧
 * 仍然由 `src/core/members/manage.ts` 的 `assertCan` 再判一次——读侧负责「看不看得见」，
 * 写侧负责「做不做得成」，这是这一轮两条并行的门。
 *
 * 「负责需求数」是列表上的信息，不是权限：它回答「这个人现在占着几条」，
 * 也是「停用被挡住」时那句话里的 N（服务层自己再数一次，不拿这里的数当判据）。
 */
export type MemberAdminRow = {
  id: string;
  name: string;
  role: string;
  line: string | null;
  /** false = 已停用（列表里仍然要出现：历史行还指着他）。 */
  active: boolean;
  /** 还负责几条未删除的需求。 */
  owned: number;
};

/** 没有 `manageMembers` 的人拿到 null（页面据此不渲染、也不给入口）。 */
export async function memberAdminView(actor: Member | null): Promise<MemberAdminRow[] | null> {
  if (actor === null) return null;
  if (!can(actor, { type: '', ownerMemberId: null }, 'manageMembers')) return null;

  const res = await db.execute<{
    id: string; name: string; role: string; line: string | null;
    deactivated_at: Date | null; owned: number;
  }>(sql`
    select m.id, m.name, m.role, m.line, m.deactivated_at,
           (select count(*)::int
              from requirements r
             where r.owner_member_id = m.id and r.deleted_at is null) as owned
      from members m
     order by m.deactivated_at nulls first, m.name, m.id`);

  return res.rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    line: row.line,
    active: row.deactivated_at === null,
    owned: Number(row.owned),
  }));
}

export type OwnedRequirement = { id: string; number: number; title: string };

/**
 * 某个人还负责哪些需求（「转交」那一步要逐条调 `reassignOwner`）。
 *
 * 只给 id / 编号 / 标题：转交是一次写，界面不需要这些需求的其余字段；
 * 权限也不在这里判——`reassignOwner` 每一条都会自己判一次（超管全过）。
 */
export async function requirementsOwnedBy(memberId: string): Promise<OwnedRequirement[]> {
  const res = await db.execute<{ id: string; number: number; title: string }>(sql`
    select id, number, title
      from requirements
     where owner_member_id = ${memberId} and deleted_at is null
     order by number`);
  return res.rows.map((row) => ({
    id: row.id, number: Number(row.number), title: row.title,
  }));
}
