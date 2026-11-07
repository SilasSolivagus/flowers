import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  databaseNameOf, missingDatabaseRefusal, resolveDatabaseUrl, testDatabaseShapeRefusal,
} from '../src/db/url.js';

/**
 * vitest 的 globalSetup：整轮只跑一次，在任何一个用例之前。做三件事，收尾再做一件。
 *
 * ── 为什么这一轮要自己建库（2026-11-08）
 *
 * 以前所有跑测试的进程共用一张 `flowers_test`。两个 `npx vitest run` 同时跑时，
 * 它们在同一个 `resetDb()` 上互相截断：A 刚插入的 12 条需求被 B 的 truncate 清掉，
 * 于是 A 有 60 个用例集体变红——看上去像一次真回归，实际是两张跑撞在一张库上。
 * 一次误判的代价比「多建一张库」高得多，所以现在**每次跑一张**：
 * `flowers_test_<runId>`（`runId` 由 `vitest.config.ts` 在主进程生成，见那里的注释）。
 *
 * 建库 / 跑迁移放在这里而不是 `setupFiles`：一轮只该做一次，而且必须早于任何用例。
 * 收尾把库删掉：留着就是一堆 `flowers_test_*` 残骸，下一个人 `\l` 的时候不知道该信哪张。
 *
 * ── `TEST_DATABASE_URL` 的地位
 *
 * 它是**调试用的逃生口**：设了它就连它，不再替换库名（有人要看一张特定的库）。
 * 代价是那条连接可能指向「别人的、我不想删的」库，所以此时**跳过一切建库 / 迁移 / 删库**，
 * 只敲一下门确认连得上。要干净隔离就删掉这个变量。
 */

type SetupContext = { config?: { env?: Record<string, string | undefined> } };

/** 库名要进 `create database "…"` 的标识符位置，只放行这一种形状（与 `db-test-setup` 同口径）。 */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

/**
 * globalSetup 跑在**主进程**里，而 `test.env`（`vitest.config.ts` 里的
 * `FLOWERS_TEST_RUN_ID` / `FLOWERS_DATA_DIR`）是发给 **worker** 的，不进主进程的
 * `process.env`。所以这里把两份合起来——否则主进程会按自己的 pid 算库名、worker 按
 * runId 算，建的库和连的库不是一张。
 */
function setupEnv(ctx?: SetupContext): Record<string, string | undefined> {
  const fromConfig = ctx?.config?.env ?? {};
  return { ...process.env, ...fromConfig };
}

export default async function setup(ctx?: SetupContext): Promise<() => Promise<void>> {
  const env = setupEnv(ctx);
  const url = resolveDatabaseUrl(env);
  const database = databaseNameOf(url);
  const explicit = (env.TEST_DATABASE_URL ?? '').trim() !== '';

  // 连不上时报一句能照着做的话（`missingDatabaseRefusal`），而不是 40 多个文件各吐一条裸 3D000。
  // 只在这一步用 preflight，因为它只在「测试进程」这一侧需要翻译。
  if (explicit) {
    process.stdout.write(`测试库：${database}（TEST_DATABASE_URL 指定；不建、不迁移、跑完不删）\n`);
    await assertReachable(url, database);
    return async () => undefined;
  }

  const shapeRefusal = testDatabaseShapeRefusal(database);
  if (shapeRefusal !== null) throw new Error(shapeRefusal);
  if (!SAFE_IDENTIFIER.test(database)) throw new Error(`测试库名不合法：「${database}」（来自 ${url}）`);

  await createIfMissing(url, database);
  await runMigrations(url, database);
  process.stdout.write(`测试库：${database}（本轮专用，跑完删）\n`);

  return async () => {
    // 收尾**绝不**能让一轮测试变红：删不掉（连着、权限不足、库已经没了）就记一行。
    await dropDatabase(url, database).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`收尾：删库 ${database} 失败（${message}）——可以手动 drop database "${database}"\n`);
    });
    await cleanupDataDir(env);
  };
}

async function assertReachable(url: string, database: string): Promise<void> {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    if ((error as { code?: string }).code === '3D000') throw new Error(missingDatabaseRefusal(database));
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** 维护库 `postgres` 上建库：目标库还不存在时 `create database`。 */
async function createIfMissing(url: string, database: string): Promise<void> {
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const found = await admin.query('select 1 from pg_database where datname = $1', [database]);
    if (found.rowCount === 0) await admin.query(`create database "${database}"`);
  } finally {
    await admin.end();
  }
}

/**
 * 把迁移跑到这一轮的库里。
 *
 * 每次都跑（而不是「刚建的才跑」）：`migrate()` 先读 `__drizzle_migrations` 再决定做
 * 什么，没有待跑的迁移时只是一次查询。反过来，「跳过」这条快捷路径会在「上一轮同
 * runId 的库没删干净」时留下一张没有新迁移的库——一次难得要命的假绿。
 */
async function runMigrations(url: string, database: string): Promise<void> {
  const pool = new Pool({ connectionString: url });
  try {
    await migrate(drizzle(pool), { migrationsFolder: './src/db/migrations' });
  } catch (error) {
    if ((error as { code?: string }).code === '3D000') throw new Error(missingDatabaseRefusal(database));
    throw error;
  } finally {
    await pool.end();
  }
}

/** 删掉这一轮的库：先掐断残留连接（worker 被 kill 时它们会挂着，drop 会失败）。 */
async function dropDatabase(url: string, database: string): Promise<void> {
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(
      'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
      [database],
    );
    await admin.query(`drop database if exists "${database}"`);
  } finally {
    await admin.end();
  }
}

/**
 * 删掉这一轮的 `FLOWERS_DATA_DIR`（会话密钥 + 产物）。
 *
 * 只删临时目录下的：这个变量也可能被人指到一个真目录去调东西，那时删掉就是删别人的
 * 产物——一次收尾不该有这种权力。
 */
async function cleanupDataDir(env: Record<string, string | undefined>): Promise<void> {
  const dir = env.FLOWERS_DATA_DIR?.trim();
  if (dir === undefined || dir === '') return;
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep)) return;
  await rm(resolved, { recursive: true, force: true }).catch(() => undefined);
}
