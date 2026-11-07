import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../../src/db/client.js';
import { members } from '../../src/db/schema.js';

beforeAll(async () => {
  await db.execute(sql`truncate members restart identity cascade`);
});

afterAll(async () => {
  await pool.end();
});

it('schema is real: all 5 tables exist', async () => {
  const res = await db.execute<{ table_name: string }>(sql`
    select table_name from information_schema.tables
    where table_schema = 'public'
      and table_name in ('requirements','members','releases','events','review_assignments')
    order by table_name`);
  expect(res.rows.map((r) => r.table_name)).toEqual([
    'events',
    'members',
    'releases',
    'requirements',
    'review_assignments',
  ]);
});

it('insert one member and read it back', async () => {
  const [inserted] = await db
    .insert(members)
    .values({ name: '房超', email: 'fangchao@123pan.com', role: 'pm' })
    .returning();
  expect(inserted).toBeDefined();
  expect(inserted!.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(inserted!.createdAt).toBeInstanceOf(Date);

  const found = await db.select().from(members).where(sql`id = ${inserted!.id}`);
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({
    id: inserted!.id, name: '房超', email: 'fangchao@123pan.com', role: 'pm',
  });
});

it('requirements.number is unique', async () => {
  const idx = await db.execute<{ indexname: string }>(sql`
    select indexname from pg_indexes
    where tablename = 'requirements' and indexname = 'requirements_number_unique'`);
  expect(idx.rows).toHaveLength(1);
});
