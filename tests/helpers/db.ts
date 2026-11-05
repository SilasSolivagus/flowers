import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';

export async function resetDb() {
  // 原子性用例会建这个触发器；进程被 kill 时它会留在库里，而 truncate 清不掉
  // 触发器，之后每个写事件的用例都会撞 'boom'。先 drop 再 truncate。
  await db.execute(sql`drop trigger if exists flowers_test_boom on events`);
  await db.execute(sql`truncate requirements, review_assignments, events, releases, members restart identity cascade`);
}

export async function seedPeople() {
  const rows = await db.execute(sql`
    insert into members (name, role) values
      ('房超','pm'), ('王妍','pm'), ('吕品','pm'),
      ('赵越','commercial_reviewer'), ('吕正豪','feature_reviewer')
    returning id, name, role`);
  return rows.rows as Array<{ id: string; name: string; role: string }>;
}
