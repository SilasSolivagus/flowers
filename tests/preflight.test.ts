import { describe, expect, it } from 'vitest';
import { assertDatabaseReachable } from '../src/db/preflight.js';
import { resolveDatabaseUrl, withDatabase } from '../src/db/url.js';

/**
 * Item 4：新克隆一份仓库、`npm run db:up`、直接 `npx vitest run`。
 *
 * 真实发生的是：第一个用例死在裸的 pg `3D000`（`database "flowers_test" does not exist`），
 * 一屏红色看起来像 30 个用例同时坏了，而唯一要做的就是跑一次 `db:test:setup`。
 * 这里连的是**真的不存在的库**（不是 mock），所以钉住的是真实错误的 code，
 * 而不是我以为的错误码。
 *
 * 变异：把 `preflight.ts` 里 `if (code === '3D000' ...)` 那段删掉 → 抛出来的会是
 * pg 原文 `database "…" does not exist`，两条 `toThrow(/…/)` 立刻红。
 */
describe('assertDatabaseReachable（3D000 → 一句能照做的话）', () => {
  const TEST_URL = resolveDatabaseUrl({ VITEST: 'true' });

  it('库不存在时抛中文并点名 db:test:setup', async () => {
    await expect(assertDatabaseReachable({
      VITEST: 'true',
      TEST_DATABASE_URL: withDatabase(TEST_URL, 'flowers_test_absent'),
    })).rejects.toThrow(/测试库 flowers_test_absent 不存在，先跑 npm run db:test:setup/);
  });

  it('库在的时候放行并交回库名（不误伤正常路径）', async () => {
    await expect(assertDatabaseReachable({ VITEST: 'true', TEST_DATABASE_URL: TEST_URL }))
      .resolves.toBe('flowers_test');
  });
});
