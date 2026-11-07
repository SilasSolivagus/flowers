import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 20000,
    /**
     * 开跑前敲一次门：库连不上 / 库不存在时给一句能照着做的话（`npm run db:test:setup`），
     * 而不是让 40 多个文件各自吐一条裸 pg 3D000。见 `tests/global-setup.ts`。
     */
    globalSetup: ['./tests/global-setup.ts'],
  },
});
