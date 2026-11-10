import { Client } from 'pg';
import {
  databaseNameOf, isTestRun, missingDatabaseRefusal, resolveDatabaseUrl, type DbEnv,
} from './url.js';

/**
 * 开跑之前先敲一下门：这张库连得上吗？
 *
 * 为什么要有这一步（Item 4）：新克隆一份仓库、`npm run db:up` 之后直接 `npx vitest run`，
 * 会在第一个用例里拿到裸的 pg `3D000`：
 *
 *     error: database "flowers_test" does not exist
 *
 * 那句话既没说「这不是代码坏了」，也没说该怎么办，于是一整屏红色看起来像 30 个用例
 * 同时出问题。真实原因只有一个——还没跑 `npm run db:test:setup`。这一层把那句话换成
 * 一条带下一步指令的中文，且**只换这一种错误**：连接被拒、密码错、主机不可达一律原样
 * 抛（那些不是「忘了 setup」，伪造一句话只会误导）。
 *
 * 谁来调：`tests/global-setup.ts`（vitest 的 globalSetup，全量只跑一次）。
 * 为什么放在 globalSetup 而不是 client.ts：client.ts 是热路径，每个进程都会连库，
 * 在构造 pool 时多做一次连接是给生产加成本；而「漏了 setup」只发生在测试进程里。
 */
export async function assertDatabaseReachable(env: DbEnv = process.env): Promise<string> {
  const url = resolveDatabaseUrl(env);
  const database = databaseNameOf(url);
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '3D000' && isTestRun(env)) throw new Error(missingDatabaseRefusal(database));
    throw error;
  } finally {
    // 连接失败时 end() 在某些 pg 版本里会 reject；这里只是收尾，不覆盖上面那条真错误。
    await client.end().catch(() => undefined);
  }
  return database;
}
