import { describe, expect, it } from 'vitest';
import {
  DEMO_DATABASE,
  TEST_DATABASE,
  databaseNameOf,
  resolveDatabaseUrl,
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
