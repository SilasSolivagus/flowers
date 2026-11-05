import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';

export async function resetDb() {
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
