import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';
import { resolveDatabaseUrl } from './url.js';

/**
 * 连接串由 `resolveDatabaseUrl` 决定，本文件不再自己读 `DATABASE_URL`：
 *
 * - 生产 / 开发 / 脚本：`DATABASE_URL`（缺省本地 flowers）——行为与以前完全一致。
 * - 测试进程（`VITEST=true` 或 `NODE_ENV=test`）：`flowers_test`，可被
 *   `TEST_DATABASE_URL` 覆盖。
 *
 * 这一层是「跑测试不再清空演示库」的入口：所有拿 `db` 的代码（服务、脚本、用例）
 * 都从这里连库，没有第二条自己拼连接串的路。
 */
export const databaseUrl = resolveDatabaseUrl(process.env);

export const pool = new Pool({ connectionString: databaseUrl });
export const db = drizzle(pool, { schema });
export type Db = typeof db;
