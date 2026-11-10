/**
 * 产品团队名单（2026-11-10）：**谁在这个系统里**这条产品口径本身。
 *
 * 从 `scripts/import-members.ts` 搬出来的理由与 `flower-legacy.ts` 同一条：那个脚本
 * 顶层就连库、打印、写库，用例 import 它等于跑一次导入。名单要能被安静地钉住
 * （邮箱唯一、恰好一个超管、两个评审人各守一条线）。
 *
 * 名单不是从 Flower 全量搬的（那是多组织平台，几百号人，含已离职）：flowers 是
 * **产品团队的需求门禁**，只收这 7 个人。角色/条线按 P4-04 落位——Flower 的
 * `org_role` 只有 admin/member/guest，`function_tag` 是工单标签，都推不出「谁是
 * 商业线负责人」，所以这份映射是产品决定，写在代码里而不是运行时猜。
 */
export type RosterEntry = {
  name: string;
  email: string;
  role: 'product_owner' | 'feature_reviewer' | 'commercial_reviewer' | 'pm';
  line: 'feature' | 'commercial' | null;
};

/** 产品团队（7 人）。改这里 = 改「谁在 flowers 里」。 */
export const ROSTER: readonly RosterEntry[] = [
  { name: '房超', email: 'fangchao@123pan.com', role: 'product_owner', line: null },
  { name: '赵越', email: 'zhaoyue@123pan.com', role: 'commercial_reviewer', line: 'commercial' },
  { name: '吕正豪', email: 'lvzhenghao@123pan.com', role: 'feature_reviewer', line: 'feature' },
  { name: '吕品', email: 'lvpin@123pan.com', role: 'pm', line: 'feature' },
  { name: '李嘉', email: 'lijia@123pan.com', role: 'pm', line: 'commercial' },
  { name: '王妍', email: 'wangyan@123pan.com', role: 'pm', line: 'commercial' },
  { name: '罗丹', email: 'luodan@123pan.com', role: 'pm', line: 'commercial' },
];
