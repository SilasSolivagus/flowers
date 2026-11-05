import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client.js';
import { assertSafeToReset, shouldAllowReset } from '../src/db/reset.js';

afterAll(async () => {
  await pool.end();
});

/**
 * I8：`resetDb` 是 truncate 五张表的硬操作，而 `scripts/demo.ts` 尊重 `DATABASE_URL`。
 * 守卫的两个条件就在这里钉死：库名是 flowers，或显式设了 FLOWERS_ALLOW_RESET=1。
 */
describe('resetDb 的守卫', () => {
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
    // 覆盖的是真实路径：用例连的就是 flowers，守卫应当放行并把库名交回来给脚本打印。
    await expect(assertSafeToReset()).resolves.toBe('flowers');
  });
});
