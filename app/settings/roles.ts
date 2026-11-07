/**
 * 角色与评审线的中文标签 —— 只有设置页用到的**视图侧**映射。
 *
 * 为什么放在这里（而不是 core 或读模型）：
 *
 * 1. `members.role` 存的是英文枚举（`pm` / `commercial_reviewer` / `feature_reviewer`，
 *    见 src/db/schema.ts 的注释），而界面只出中文。领域层里已经有权威的那一份
 *    （`src/core/auth/roles.ts` 的 `ROLE_LABEL` / `ROLE_OF_LINE`），但它同时是权限模块，
 *    设置页只需要两个中文名：把视图侧的措辞关在这一个文件里，比让页面去 import 权限
 *    模块的常量更不容易长出第三份规则（P4-06 删掉了「类型 → 角色」那张表，这里的那份
 *    也一起删了，见下面的 `LINE_LEAD`）。
 * 2. 因此这份映射是**第三份**，也是唯一一份在视图侧的。它的存在本身是一条待办：
 *    P5 应该由 core 导出一张角色注册表（英文值 + 中文名 + 它覆盖的需求类型），
 *    detail.ts / review.ts / 本文件三处合成一处。在那之前，把重复关在一个页面目录里，
 *    比让设置页去 import 一份私有常量现实（那需要先解冻 core）。
 * 3. **中文名逐字对齐 detail.ts 的 `ROLE_LINE`**（评审 M2）：同一个角色在整个 App 里
 *    只能有一个中文名，否则「产品经理」与抽屉里的「PM」会被读成两个人。抽屉那一份是
 *    详情页评审行既有的措辞（`pm: 'PM'` / `commercial_reviewer: '商业线'`），改它要动
 *    core（本题冻结），所以由这里向它对齐：`PM` / `商业线` / `功能线`。名字短，但它落在
 *    「角色」「评审线」这种已经把语境说清楚的列里，再写成「产品经理 / 商业线评审人」
 *    就是同一句话的第二个版本——那正是这条评审意见要去掉的东西。
 *
 * 键是数据库里的原始字符串，不做归一化：认不出的角色一律原样显示（见 roleLabel），
 * 而不是悄悄归到「其他」——那会把「库里多了一个角色」这件事藏起来。
 */

/** 角色 → 中文名。值为英文原文只作兜底，正常路径都在这里命中。 */
const ROLE_LABEL: Record<string, string> = {
  // 三个值与 src/core/read/detail.ts 的 ROLE_LINE 逐字相同（见文件头第 3 条）：
  // 抽屉、成员表、评审线、我的·角色，四处说的是同一个名字。
  pm: 'PM',
  commercial_reviewer: '商业线',
  feature_reviewer: '功能线',
  // P4-04 加的那一个。四个字，是因为「超管」在同一条左轨里要能一眼看出它是那个
  // 「能改任何东西」的人，而正文里的完整叫法是「产品总负责人」（见 roles.ts）。
  product_owner: '超管',
};

/** 条线 → 中文名。`line` 是人的属性（PM 也有条线），不是权限。 */
export const LINE_LABEL: Record<string, string> = {
  feature: '功能线',
  commercial: '商业线',
};

export function lineLabel(line: string | null | undefined): string {
  if (line === null || line === undefined) return '';
  return Object.hasOwn(LINE_LABEL, line) ? (LINE_LABEL[line] ?? line) : line;
}

/**
 * 条线 → 那条线的负责人角色（P4-06）。
 *
 * 这是「谁能改一条需求由**负责人的条线**决定」在界面上的那一半：界面上不做派单，
 * 只把「哪条线 → 谁是这条线的负责人」摆出来。P4-06 之前这里是「类型 → 角色」——
 * 那张表就是被删掉的旧锚点，留着它会让设置页说一套、`can()` 说另一套。
 *
 * `role` 一定要渲染到屏上（评审 M1）：只写人名，读者得滚回上面的成员表才知道「赵越」
 * 是什么身份；角色名一出一条行就把「哪条线 → 谁」讲完了。
 */
export const LINE_LEAD = [
  { line: 'feature', label: '功能线', role: 'feature_reviewer' },
  { line: 'commercial', label: '商业线', role: 'commercial_reviewer' },
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
