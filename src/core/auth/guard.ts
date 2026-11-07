import { sql } from 'drizzle-orm';
import { AppError } from '../errors.js';
import { memberByName, type Exec } from './members.js';
import {
  can, PermissionDenied, type Ability, type Member, type RequirementFacts,
} from './roles.js';

/**
 * 服务层的权限闸门：**每个写动作在碰数据之前调用它**。
 *
 * 为什么闸门长这样（一个函数 + 一句中文）而不是一层中间件：这一层的调用方有四个
 * ——页面动作（`app/actions.ts`）、MCP 工具（`mcp/services.ts`）、脚本与种子、用例。
 * 中间件只拦得住 HTTP，拦不住 MCP 的 stdio，更拦不住一次 `tsx` 脚本。所以闸门必须
 * 长在**服务函数内部**：谁调用它，规则就跟到谁身上。
 *
 * 它做三件事，顺序不能换：
 * 1. 名字 → 成员行（`actor` 是自由文本，权限判断要 id / role / line）；
 * 2. `can()` 判一次；
 * 3. 不过就抛 `AppError('forbidden')`（评审那条是 `not_reviewer`，见 roles.ts 的注释）。
 *
 * 查无此人也是 `forbidden` 的同一句话：**不为「这个名字不存在」单开错误码**。分开说
 * 会变成一台花名册探测器（拿任意名字试，凭错误码枚举成员），而用户能做的事是一样的。
 */

const NOT_FOUND = '需求不存在';

/** 名字 → 一个一定存在的、活着的成员，否则 `forbidden`。 */
export async function requireActor(exec: Exec, actor: string): Promise<Member> {
  const member = await memberByName(exec, actor);
  if (member === null || member.deactivatedAt !== null) {
    throw new PermissionDenied('edit', '这个名字不在名册上（或已停用）');
  }
  return member;
}

/**
 * 判一次并返回那个成员（调用方常常还要用 id）。
 *
 * `message` 只在评审那条路上被用到（它要那句历史措辞），其余走 `FORBIDDEN_MESSAGE`。
 */
export async function assertCan(
  exec: Exec,
  actor: string,
  facts: RequirementFacts,
  ability: Ability,
  message?: string,
): Promise<Member> {
  const member = await memberByName(exec, actor);
  if (member === null || member.deactivatedAt !== null) throw new PermissionDenied(ability, message);
  if (!can(member, facts, ability)) throw new PermissionDenied(ability, message);
  return member;
}

/**
 * 从库里读一条需求的事实（负责人 + 负责人所在条线），给还没有锁行的调用方用
 * （改描述、删除、转交负责人）。
 *
 * 与 `lockRequirement` 的区别：那个是**先锁再判**（状态动作必须），这个只读一次
 * （它管的是「描述的字段」，不是状态迁移）。软删除的行视为不存在——与读侧同一条口径。
 * P4-06 起 `type` 不再是权限事实（锚点是负责人的条线），这一读也不再取它。
 */
export async function requirementFacts(exec: Exec, requirementId: string): Promise<RequirementFacts> {
  const res = await exec.execute<{
    owner_member_id: string | null; owner_line: string | null;
  }>(sql`
    select r.owner_member_id, m.line as owner_line
      from requirements r
      left join members m on m.id = r.owner_member_id
     where r.id = ${requirementId} and r.deleted_at is null`);
  const row = res.rows[0];
  // 「不存在」排在「你有没有权限」之前：一条没有的需求对**任何人**都是 404。
  // 反过来的话，这个错误码差异会变成一次存在性探测（拿任意 id 试）。
  if (row === undefined) throw new AppError('not_found', NOT_FOUND);
  // 状态由调用方补（这条读法只服务「改描述 / 删除 / 转交」那几条，它们不看状态）；
  // 条线必须在这里带出来——P4-06 之后 `can()` 只认 `ownerLine`。
  return { ownerMemberId: row.owner_member_id, ownerLine: row.owner_line };
}
