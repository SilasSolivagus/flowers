import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:flowers@localhost:54329/flowers',
});
export const db = drizzle(pool, { schema });
export type Db = typeof db;
