import { describe, expect, it } from 'vitest';
import {
  DEMO_DATABASE,
  TEST_DATABASE,
  databaseNameOf,
  missingDatabaseRefusal,
  resolveDatabaseUrl,
  testDatabaseName,
  testDatabaseShapeRefusal,
  testRunId,
  withDatabase,
} from '../src/db/url.js';

/**
 * 这条纯函数是「跑测试不再清空演示库」的唯一开关，所以五件事各钉一条：
 * 测试进程落到 `flowers_test_<runId>`（**每一轮一张**，两个并发跑不互相截断）、
 * `TEST_DATABASE_URL` 能整条覆盖、非测试进程一个字都不许变、
 * `TEST_DATABASE_URL` 不许漏进非测试进程、`db:test:setup` 建的是基名那张。
 *
 * 不碰数据库：这里只解析字符串，没有 pool，也没有 import client.ts。
 *
 * 变异（下面每条都对着一次真实回归）：
 * - 把 `testDatabaseName` 里的 `_${runId}` 去掉 → 两个并发 vitest 又共用一张库，
 *   `测试进程默认落到 <基名>_<runId>` 那条红。
 * - 把 `testRunId` 里 `FLOWERS_TEST_RUN_ID` 那一段删掉 → worker 落到 `w<poolId>`，
 *   `runId 优先用 FLOWERS_TEST_RUN_ID` 那条红（这一条正是「一轮里每个文件一张库」的坑）。
 * - 把 `resolveDatabaseUrl` 的 `perRun === false` 分支删掉 → `db:test:setup` 建的是
 *   一次性库，`perRun:false 时回到基名` 那条红。
 */
describe('resolveDatabaseUrl', () => {
  const PROD = 'postgres://postgres:flowers@localhost:54330/flowers';

  it('测试进程默认落到 <基名>_<runId>，主机与账号不动', () => {
    expect(resolveDatabaseUrl({ VITEST: 'true', FLOWERS_TEST_RUN_ID: 'a1b2' })).toBe(
      `postgres://postgres:flowers@localhost:54330/flowers_test_a1b2`,
    );
    expect(databaseNameOf(resolveDatabaseUrl({ VITEST: 'true', FLOWERS_TEST_RUN_ID: 'a1b2' })))
      .toBe(`${TEST_DATABASE}_a1b2`);
    // 形状够 `reset.ts` 那道守卫（`_test` 开头）放行，也够 `db:test:setup` 的建库检查。
    expect(testDatabaseShapeRefusal(testDatabaseName({ VITEST: 'true', FLOWERS_TEST_RUN_ID: 'x7' })))
      .toBeNull();
  });

  it('两次「跑」拿到两张库：不同 runId 不共用', () => {
    const a = databaseNameOf(resolveDatabaseUrl({ VITEST: 'true', FLOWERS_TEST_RUN_ID: 'runA' }));
    const b = databaseNameOf(resolveDatabaseUrl({ VITEST: 'true', FLOWERS_TEST_RUN_ID: 'runB' }));
    expect(a).not.toBe(b);
  });

  it('runId 优先用 FLOWERS_TEST_RUN_ID，它比 VITEST_POOL_ID / pid 都稳', () => {
    // 一轮里每个 worker 的 VITEST_POOL_ID 都不同，所以它不能当主路：否则同一轮的
    // 文件会各拿一张库，而 globalSetup 只建了一张。
    expect(testRunId({ FLOWERS_TEST_RUN_ID: 'run', VITEST_POOL_ID: '3' }, 999)).toBe('run');
    expect(testRunId({ VITEST_POOL_ID: '3' }, 999)).toBe('w3');
    expect(testRunId({}, 4242)).toBe('p4242');
    // 非法字符换成下划线：库名要拼进 create database "…"，只能是标识符。
    expect(testRunId({ FLOWERS_TEST_RUN_ID: 'a-b.c' })).toBe('a_b_c');
  });

  it('NODE_ENV=test 也算测试进程', () => {
    expect(databaseNameOf(resolveDatabaseUrl({ NODE_ENV: 'test', DATABASE_URL: PROD, FLOWERS_TEST_RUN_ID: 'zz' })))
      .toBe(`${TEST_DATABASE}_zz`);
  });

  it('perRun:false 时回到基名（db:test:setup 建的那张）', () => {
    expect(databaseNameOf(resolveDatabaseUrl({ VITEST: 'true', FLOWERS_TEST_RUN_ID: 'zz' }, { perRun: false })))
      .toBe(TEST_DATABASE);
  });

  it('TEST_DATABASE_URL 整条覆盖（换主机、换库名都听它的）', () => {
    const remote = 'postgres://ci:pw@db.internal:5432/flowers_test_ci?sslmode=disable';
    expect(resolveDatabaseUrl({ VITEST: 'true', TEST_DATABASE_URL: remote })).toBe(remote);
    // 覆盖优先于 DATABASE_URL：测试不该被演示库地址带偏。
    expect(resolveDatabaseUrl({ VITEST: 'true', DATABASE_URL: PROD, TEST_DATABASE_URL: remote })).toBe(remote);
  });

  it('非测试进程行为完全不变：DATABASE_URL 原样返回，缺省还是演示库', () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: PROD })).toBe(PROD);
    expect(resolveDatabaseUrl({})).toBe(PROD);
    expect(databaseNameOf(resolveDatabaseUrl({ DATABASE_URL: PROD }))).toBe(DEMO_DATABASE);
    // VITEST 只是字符串 'true' 才算；别的值不能把生产切到测试库。
    expect(resolveDatabaseUrl({ VITEST: '1', DATABASE_URL: PROD })).toBe(PROD);
  });

  it('TEST_DATABASE_URL 在非测试进程里不生效', () => {
    const remote = 'postgres://ci:pw@db.internal:5432/flowers_test_ci';
    expect(resolveDatabaseUrl({ DATABASE_URL: PROD, TEST_DATABASE_URL: remote })).toBe(PROD);
  });

  it('withDatabase 只换库名，保住 query 与端口', () => {
    expect(withDatabase('postgres://u:p@h:5432/app?sslmode=require', 'flowers_test')).toBe(
      'postgres://u:p@h:5432/flowers_test?sslmode=require',
    );
  });
});

/**
 * Item 3：`npm run db:test:setup` 会建库 + 跑迁移。`TEST_DATABASE_URL` 指到 `flowers`
 * 时它不删任何行，所以没有任何守卫会响——但演示库里会凭空长出一批测试用的表，迁移
 * 历史也被写进去。这是「比删数据更难发现」的那一类，所以按名字形状提前拒绝。
 *
 * 变异：把 `db-test-setup.ts` 里那句 `testDatabaseShapeRefusal` 判断删掉 → 脚本会在
 * `flowers` 上跑迁移。用例这一侧钉的是纯函数（不碰库）：把函数改成永远返回 null，
 * 下面三条断言立刻红。
 */
describe('db:test:setup 的库名形状（Item 3）', () => {
  it('flowers 被拒，理由点名 TEST_DATABASE_URL 与默认落点', () => {
    const reason = testDatabaseShapeRefusal(DEMO_DATABASE);
    expect(reason).not.toBeNull();
    expect(reason).toContain('_test');
    expect(reason).toContain('TEST_DATABASE_URL');
    expect(reason).toContain(TEST_DATABASE);
  });

  it('名字带 _test 的库放行（默认库与自建 CI 库都算）', () => {
    expect(testDatabaseShapeRefusal(TEST_DATABASE)).toBeNull();
    expect(testDatabaseShapeRefusal('flowers_test_ci')).toBeNull();
    expect(testDatabaseShapeRefusal('flowers_p410')).not.toBeNull();
  });
});

/** Item 4：3D000 的说明书必须能照着做（纯字符串，不碰库）。 */
describe('缺库时的报错文案（Item 4）', () => {
  /**
   * 「每轮一张库」之后，缺库基本只剩一个来源：`TEST_DATABASE_URL` 指到了一张不存在的库
   * （否则 `tests/global-setup.ts` 会自己建）。所以文案必须点两件事——库名，以及那个变量。
   */
  it('点名库名、TEST_DATABASE_URL 与两条出路', () => {
    const message = missingDatabaseRefusal(TEST_DATABASE);
    expect(message).toContain(`测试库 ${TEST_DATABASE} 不存在`);
    expect(message).toContain('TEST_DATABASE_URL');
    expect(message).toContain('npm run db:test:setup');
  });
});
