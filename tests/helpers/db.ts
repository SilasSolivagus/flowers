import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';

/**
 * resetDb 现在住在 `src/db/reset.ts`：`scripts/demo.ts` 也要用它，而脚本不该反向
 * 依赖测试助手。这里 re-export 一次，测试里的 import 路径不用动。
 */
export { resetDb } from '../../src/db/reset.js';

/**
 * 名册（P4-04 的真实花名册）。
 *
 * 七个人，两条线，一个超管。这份表就是产品里那张人表——**测试用它与生产同一个形状**，
 * 因为这一轮加的东西（角色 → 能力、条线 → 通知扇出、停用 → 不能登录）全都是
 * 「人和组织」的规则，一份虚构的测试名册会让这些规则在测试里成立、在产品里不成立。
 *
 * | 名字 | role | line |
 * |---|---|---|
 * | 房超 | product_owner | null |
 * | 吕正豪 | feature_reviewer | feature |
 * | 赵越 | commercial_reviewer | commercial |
 * | 吕品 | pm | feature |
 * | 李嘉 | pm | feature |
 * | 罗丹 | pm | commercial |
 * | 王妍 | pm | commercial |
 *
 * 口令**不在这里设**：绝大多数用例不需要它，而每次 scrypt（约 60ms）乘 7 乘 30 个
 * 测试文件是一笔白付的账。要登录的用例自己 `setPassword(db, id, '...')`。
 */
export const ROSTER = [
  { name: '房超', role: 'product_owner', line: null },
  { name: '吕正豪', role: 'feature_reviewer', line: 'feature' },
  { name: '赵越', role: 'commercial_reviewer', line: 'commercial' },
  { name: '吕品', role: 'pm', line: 'feature' },
  { name: '李嘉', role: 'pm', line: 'feature' },
  { name: '罗丹', role: 'pm', line: 'commercial' },
  { name: '王妍', role: 'pm', line: 'commercial' },
] as const;

export type SeededPerson = { id: string; name: string; role: string; line: string | null };

export async function seedPeople(): Promise<SeededPerson[]> {
  const rows = await db.execute<SeededPerson>(sql`
    insert into members (name, role, line) values
      ('房超','product_owner',null),
      ('吕正豪','feature_reviewer','feature'),
      ('赵越','commercial_reviewer','commercial'),
      ('吕品','pm','feature'),
      ('李嘉','pm','feature'),
      ('罗丹','pm','commercial'),
      ('王妍','pm','commercial')
    returning id, name, role, line`);
  return rows.rows;
}

/** 名字 → id（用例里到处要用，省一次查询的样板）。 */
export function idOf(people: SeededPerson[], name: string): string {
  const found = people.find((person) => person.name === name);
  if (found === undefined) throw new Error(`名册里没有 ${name}`);
  return found.id;
}
