/**
 * `npm run db:test:setup`：把测试库准备好（建库 + 跑迁移）。
 *
 * 为什么要有这条命令：测试进程连的是 `flowers_test`（见 `src/db/url.ts`），而
 * docker-compose 只建了 `flowers`。新克隆一份仓库、`npm run db:up` 之后直接
 * `npx vitest run`，会全部死在「库不存在」——一条命令把这件事补上，并写进 README。
 *
 * 做法只用 `pg` + drizzle 现有依赖：
 * 1. 用维护库 `postgres` 连上去，`pg_database` 里没有就 `create database`；
 * 2. 再连测试库，跑 `src/db/migrations` 里那批迁移（与 `npm run db:migrate` 同一批）。
 *
 * 目标库由 `resolveDatabaseUrl` 决定，输入是「强制按测试进程算」的 env：所以它
 * 尊重 `TEST_DATABASE_URL`，与真正跑用例时连的完全是同一张库，不会出现「setup
 * 建的库和测试连的库不是一张」。
 */
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { databaseNameOf, resolveDatabaseUrl } from '../src/db/url.js';

/**
 * 库名要拼进 `create database` 的标识符位置（参数占位符不行），所以只放行
 * 「字母开头、字母数字下划线」的名字。测试库名由代码决定，这里是防手输的
 * `TEST_DATABASE_URL` 带出奇怪字符。
 */
const SAFE_DATABASE_NAME = /^[a-z_][a-z0-9_]*$/i;

async function main() {
  const url = resolveDatabaseUrl({ ...process.env, VITEST: 'true' });
  const database = databaseNameOf(url);
  if (!SAFE_DATABASE_NAME.test(database)) {
    throw new Error(`测试库名不合法：「${database}」（来自 ${url}）`);
  }

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const existing = await admin.query('select 1 from pg_database where datname = $1', [database]);
    if (existing.rowCount === 0) {
      await admin.query(`create database "${database}"`);
      process.stdout.write(`建库：${database}\n`);
    } else {
      process.stdout.write(`库已存在：${database}\n`);
    }
  } finally {
    await admin.end();
  }

  const pool = new Pool({ connectionString: url });
  try {
    await migrate(drizzle(pool), { migrationsFolder: './src/db/migrations' });
    process.stdout.write(`迁移完成：${database}\n`);
  } finally {
    await pool.end();
  }
}

await main();
