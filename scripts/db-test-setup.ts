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
import {
  databaseNameOf, missingDatabaseRefusal, resolveDatabaseUrl, testDatabaseShapeRefusal,
} from '../src/db/url.js';

/**
 * 库名要拼进 `create database` 的标识符位置（参数占位符不行），所以只放行
 * 「字母开头、字母数字下划线」的名字。测试库名由代码决定，这里是防手输的
 * `TEST_DATABASE_URL` 带出奇怪字符。
 */
const SAFE_DATABASE_NAME = /^[a-z_][a-z0-9_]*$/i;

async function main() {
  /**
   * `perRun: false`：这条命令建的是**基名**那张 `flowers_test`，不是 `flowers_test_<runId>`。
   *
   * 2026-11-08 起 `npx vitest run` 自带建库 + 跑迁移（每轮一张，跑完删，见
   * `tests/global-setup.ts`），所以这条命令不再是用例的前置条件，它现在的用处是两个：
   * 1. 给 `TEST_DATABASE_URL` 指过去当调试用的空库（逃生口需要一张现成的库）；
   * 2. 一张「基名」库在手，出问题时能拿 `\dt` 跟那一轮比。
   * 建一张一次性的 run 库对这条命令没有意义——建完就没人用了。
   */
  const url = resolveDatabaseUrl({ ...process.env, VITEST: 'true' }, { perRun: false });
  const database = databaseNameOf(url);
  /**
   * 两道检查，问的是两件不同的事：
   *
   * 1. **能不能拼进 SQL**（`SAFE_DATABASE_NAME`）：库名要进 `create database "…"` 的
   *    标识符位置，参数占位符不顶用，奇怪字符会变成语法错误甚至注入。
   * 2. **该不该在这里建表**（`testDatabaseShapeRefusal`，本轮新增）：`TEST_DATABASE_URL`
   *    指到 `flowers` 时，这条命令会**当着真数据的面跑迁移**。它不删行，所以没有任何
   *    守卫会响；但演示库里凭空多出一批测试用的表、迁移历史被写进去，比删数据更难发现
   *    ——等有人把演示数据灌进去，才发现这张库早被测试改过。所以名字形状不对就停。
   */
  if (!SAFE_DATABASE_NAME.test(database)) {
    throw new Error(`测试库名不合法：「${database}」（来自 ${url}）`);
  }
  const shapeRefusal = testDatabaseShapeRefusal(database);
  if (shapeRefusal !== null) throw new Error(shapeRefusal);

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
  } catch (error) {
    // 刚 `create database` 完不会缺库，所以 3D000 出现在这里只有一个原因：
    // 上面那次建库连的是维护库 postgres、这里连的是目标库本身，两者主机不一致
    // （TEST_DATABASE_URL 换了主机）。裸 pg 报错只说 "does not exist"，
    // 把「先跑 db:test:setup」这句给出来，比让人去猜主机/端口快得多。
    if ((error as { code?: string }).code === '3D000') {
      throw new Error(missingDatabaseRefusal(database));
    }
    throw error;
  } finally {
    await pool.end();
  }
}

await main();
