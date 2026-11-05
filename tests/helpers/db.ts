import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';

/**
 * resetDb 现在住在 `src/db/reset.ts`：`scripts/demo.ts` 也要用它，而脚本不该反向
 * 依赖测试助手。这里 re-export 一次，测试里的 import 路径不用动。
 */
export { resetDb } from '../../src/db/reset.js';

export async function seedPeople() {
  const rows = await db.execute(sql`
    insert into members (name, role) values
      ('房超','pm'), ('王妍','pm'), ('吕品','pm'),
      ('赵越','commercial_reviewer'), ('吕正豪','feature_reviewer')
    returning id, name, role`);
  return rows.rows as Array<{ id: string; name: string; role: string }>;
}
