/**
 * 角色与评审线的中文标签 —— 只有设置页用到的**视图侧**映射。
 *
 * 为什么放在这里（而不是 core 或读模型）：
 *
 * 1. `members.role` 存的是英文枚举（`pm` / `commercial_reviewer` / `feature_reviewer`，
 *    见 src/db/schema.ts 的注释），而界面只出中文。领域层里已经有两份「角色 → 中文/角色 → 派单」
 *    的表，但都是**模块私有**的：`src/core/read/detail.ts` 的 `ROLE_LINE`
 *    （`commercial_reviewer: '商业线'`）与 `src/core/requirements/review.ts` 的
 *    `REVIEWER_ROLE`（`commercial → 'commercial_reviewer'`）。两份都不导出，而 P4 的读模型
 *    与领域层对本题是冻结的——派单口径（review.ts）尤其不该为了一个设置页去动。
 * 2. 因此这份映射是**第三份**，也是唯一一份在视图侧的。它的存在本身是一条待办：
 *    P5 应该由 core 导出一张角色注册表（英文值 + 中文名 + 它覆盖的需求类型），
 *    detail.ts / review.ts / 本文件三处合成一处。在那之前，把重复关在一个页面目录里，
 *    比让设置页去 import 一份私有常量现实（那需要先解冻 core）。
 *
 * 键是数据库里的原始字符串，不做归一化：认不出的角色一律原样显示（见 roleLabel），
 * 而不是悄悄归到「其他」——那会把「库里多了一个角色」这件事藏起来。
 */

/** 角色 → 中文名。值为英文原文只作兜底，正常路径都在这里命中。 */
const ROLE_LABEL: Record<string, string> = {
  pm: '产品经理',
  commercial_reviewer: '商业线评审人',
  feature_reviewer: '功能线评审人',
};

/**
 * 需求类型 → 覆盖它的评审角色（与 src/core/requirements/review.ts 的 REVIEWER_ROLE 同口径）。
 *
 * 这是「评审人由类型决定」这条规则在界面上的那一半：界面上不做任何派单，只把
 * 「哪个类型配哪个角色、那个角色现在是谁」摆出来。类型名用 core 里 guard 那句话的措辞
 * （`需求必须有类型（商业 / 功能）`），不再另造一套「商业需求 / 功能需求」。
 */
export const REVIEW_LINE = [
  { type: 'commercial', label: '商业', role: 'commercial_reviewer' },
  { type: 'feature', label: '功能', role: 'feature_reviewer' },
] as const;

/**
 * 角色值 → 中文名。
 *
 * `Object.hasOwn` 而不是裸查表：role 来自数据库的 text 列，`'toString'` / `'constructor'`
 * 会命中原型上的函数并渲染成一个函数的源码（review.ts 的 assignReviewer 上踩过同一颗雷）。
 * 认不出就原样返回：README 里没有的角色，界面上至少还看得见它是什么。
 */
export function roleLabel(role: string): string {
  // `?? role` 只是给 `noUncheckedIndexedAccess` 一个出口（hasOwn 已经保证了命中）：
  return Object.hasOwn(ROLE_LABEL, role) ? (ROLE_LABEL[role] ?? role) : role;
}

/**
 * 某个角色下的全部成员姓名。
 *
 * 为什么返回**全部**而不是第一个：派单（assignReviewer）按 `created_at, id` 取第一个人，
 * 而 `listMembers()` 是按姓名排的（见 src/core/read/member.ts 的注释），设置页从读模型
 * 里**拿不到**那个顺序——猜一个「就是他会签」出来，比列出全部更容易骗人。
 * 今天每种评审角色都只有一个人，两者结果相同；同角色配了两个人时，全部列出是唯一诚实的写法。
 */
export function memberNamesOfRole(
  members: ReadonlyArray<{ name: string; role: string }>,
  role: string,
): string[] {
  return members.filter((m) => m.role === role).map((m) => m.name);
}
