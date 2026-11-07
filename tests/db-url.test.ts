import { describe, expect, it } from 'vitest';
import {
  DEMO_DATABASE,
  TEST_DATABASE,
  databaseNameOf,
  missingDatabaseRefusal,
  resolveDatabaseUrl,
  testDatabaseShapeRefusal,
  withDatabase,
} from '../src/db/url.js';

/**
 * 这条纯函数是「跑测试不再清空演示库」的唯一开关，所以四件事各钉一条：
 * 测试进程落到 flowers_test、`TEST_DATABASE_URL` 能整条覆盖、非测试进程一个字都
 * 不许变、`TEST_DATABASE_URL` 不许漏进非测试进程。
 *
 * 不碰数据库：这里只解析字符串，没有 pool，也没有 import client.ts。
 */
describe('resolveDatabaseUrl', () => {
  const PROD = 'postgres://postgres:flowers@localhost:54330/flowers';

  it('VITEST 下默认换成 flowers_test，主机与账号不动', () => {
    expect(resolveDatabaseUrl({ VITEST: 'true' })).toBe(
      'postgres://postgres:flowers@localhost:54330/flowers_test',
    );
    expect(databaseNameOf(resolveDatabaseUrl({ VITEST: 'true' }))).toBe(TEST_DATABASE);
  });

  it('NODE_ENV=test 也算测试进程', () => {
    expect(databaseNameOf(resolveDatabaseUrl({ NODE_ENV: 'test', DATABASE_URL: PROD }))).toBe(
      TEST_DATABASE,
    );
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
  it('点名库名与 npm run db:test:setup', () => {
    const message = missingDatabaseRefusal(TEST_DATABASE);
    expect(message).toContain(`测试库 ${TEST_DATABASE} 不存在，先跑 npm run db:test:setup`);
    expect(message).toContain('TEST_DATABASE_URL');
  });
});
