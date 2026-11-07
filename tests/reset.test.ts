import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { assertSafeToReset, resetDb, resetRefusal, shouldAllowReset } from '../src/db/reset.js';
import { TEST_DATABASE } from '../src/db/url.js';

afterAll(async () => {
  await pool.end();
});

/**
 * I8：`resetDb` 是 truncate 八张表的硬操作，而 `scripts/demo.ts` / `scripts/seed.ts`
 * 尊重 `DATABASE_URL`。守卫的两个条件就在这里钉死：库名是 flowers，或显式设了
 * `FLOWERS_ALLOW_RESET=1`。
 */
describe('resetDb 的守卫（脚本口径）', () => {
  it('库名不是 flowers 时必须显式放行', () => {
    expect(shouldAllowReset('flowers', undefined)).toBe(true);
    expect(shouldAllowReset('flowers', '0')).toBe(true);
    expect(shouldAllowReset('flowers_prod', undefined)).toBe(false);
    expect(shouldAllowReset('flowers_prod', '0')).toBe(false);
    expect(shouldAllowReset('flowers_prod', 'true')).toBe(false);
    // 只有字符串 '1' 才算放行：'true' / 'yes' / 空串都不该被当成同意。
    expect(shouldAllowReset('flowers_prod', '1')).toBe(true);
  });

  it('问的是库自己（current_database()），不是环境变量', async () => {
    // 用例跑在测试库上，守卫应当放行并把库名交回来给脚本打印。
    await expect(assertSafeToReset()).resolves.toBe(TEST_DATABASE);
  });
});

/**
 * P0 的另一半：**测试进程只许清测试库**。
 *
 * 这几条比脚本口径更严——不看 `FLOWERS_ALLOW_RESET`。理由写在 reset.ts 里：
 * 那个口子是给手工脚本清演示库用的，测试若能用它去清 `flowers`，
 * 「配置指错 → 演示数据被截断」这条事故就又回来了。
 */
describe('resetDb 的守卫（测试口径）', () => {
  const asTest = { VITEST: 'true' };

  it('flowers_test 放行，演示库不放行', () => {
    expect(shouldAllowReset('flowers_test', undefined, asTest)).toBe(true);
    // 同一个名字，非测试进程里当然也放行——差别只在下面的 flowers。
    expect(shouldAllowReset('flowers', undefined, asTest)).toBe(false);
    expect(shouldAllowReset('flowers', '1', asTest)).toBe(false);
    expect(shouldAllowReset('flowers', '1', { NODE_ENV: 'test' })).toBe(false);
    // 自建测试库（TEST_DATABASE_URL）只要名字带 _test 就放行。
    expect(shouldAllowReset('flowers_test_ci', '0', asTest)).toBe(true);
    expect(shouldAllowReset('flowers_p410', undefined, asTest)).toBe(false);
  });

  it('拒绝时点名 TEST_DATABASE_URL 与 db:test:setup', () => {
    const reason = resetRefusal('flowers', undefined, asTest);
    expect(reason).toContain('演示库');
    expect(reason).toContain(TEST_DATABASE);
    expect(reason).toContain('TEST_DATABASE_URL');
    expect(reason).toContain('npm run db:test:setup');
    expect(resetRefusal('flowers_test', undefined, asTest)).toBeNull();
    expect(resetRefusal('flowers', undefined, {})).toBeNull();
  });

  it('resetDb 自己就守：被拒绝时一张表都不清（演示库那套数据不受影响）', async () => {
    // 这行的价值：守卫从「只放在脚本里」挪进了 resetDb 本身。以前用例无条件重置
    // 是安全的（连的就是 flowers），现在用例换库了，若还有人不带守卫地重置一次，
    // 指错库就等于一次静默的数据销毁。
    await db.execute(sql`insert into members (name, email, role, line) values ('哨兵','sentinel@x.test','pm',null)`);
    await expect(resetDb({ guardDatabase: 'flowers', env: asTest })).rejects.toThrow(/TEST_DATABASE_URL/);
    const left = await db.execute<{ n: number }>(sql`select count(*)::int as n from members where name = '哨兵'`);
    expect(left.rows[0]?.n).toBe(1);
    await resetDb();
  });

  it('resetDb 清的是测试库，并把它自己的库名交回来', async () => {
    await db.execute(sql`insert into members (name, email, role, line) values ('待清','wipe@x.test','pm',null)`);
    await expect(resetDb()).resolves.toBe(TEST_DATABASE);
    const left = await db.execute<{ n: number }>(sql`select count(*)::int as n from members`);
    expect(left.rows[0]?.n).toBe(0);
  });
});
