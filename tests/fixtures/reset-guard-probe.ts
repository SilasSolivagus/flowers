/**
 * 探针：把 `TEST_DATABASE_URL` 指到演示库，然后在**动任何 SQL 之前**问守卫同不同意。
 *
 * 由 `tests/reset.test.ts` 以子进程方式启动（因为 `src/db/client.ts` 在 import 时就把
 * 连接串定死了，进程内改 env 不会生效）。它只调 `assertSafeToReset()`——那个函数只做
 * 一句 `select current_database()`，**不会 truncate 任何东西**。这正是它能被安全地拿去做
 * 变异测试的原因：把守卫拆掉，这个探针只会打印 ALLOWED，而不会真的删掉演示数据。
 */
import { assertSafeToReset } from '../../src/db/reset.js';
import { pool } from '../../src/db/client.js';

try {
  const database = await assertSafeToReset();
  process.stdout.write(`ALLOWED ${database}\n`);
  process.exitCode = 1;
} catch (error) {
  process.stdout.write(`REFUSED ${(error as Error).message}\n`);
  process.exitCode = 2;
} finally {
  await pool.end();
}
