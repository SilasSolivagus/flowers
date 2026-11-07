import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * 这一轮测试的 runId：**主进程**（也就是 `npx vitest run` 那个进程）生成一次，
 * 通过 `test.env` 发给每个 worker。
 *
 * 为什么不能在 worker 里现算：一轮测试的文件会被分给不同 worker 进程（`VITEST_POOL_ID`
 * 会变），而库名必须整轮只有一个——`tests/global-setup.ts` 只建一张库、只跑一次迁移。
 * 主进程的 pid + 启动时刻（36 进制）足够唯一：两个同时启动的 vitest 一定拿到两个不同的
 * 值（不同 pid），同一个 vitest 的所有 worker 拿到同一个值（同一个 config 实例）。
 *
 * 字符集只留 `[A-Za-z0-9_]`：库名要拼进 `create database "…"`，`src/db/url.ts` 的
 * `SAFE_DATABASE_NAME` 也只放行这些字符。
 */
const runId = `${process.pid}t${Date.now().toString(36)}`;

/**
 * 测试进程的运行期数据目录（会话密钥、产物 HTML）。
 *
 * 指到临时目录，两个目的：
 * 1. **绝不污染开发机的真目录**（`~/Library/Application Support/flowers`）——那里是
 *    「我自己在用」的数据，用例没有资格往里写，更没资格删（`cleanArtifacts()` 会 rm -rf
 *    整棵产物树）。
 * 2. 与库一样按轮隔离：两个并发测试跑不共用同一个产物目录。
 *
 * 名字用 `flowers-test-<runId>`（`src/core/runtime-dir.ts` 的 `TEST_DATA_PREFIX`）：
 * `tests/helpers/files.ts` 的 `cleanArtifacts()` 会先验「这个根确实是测试的盘」才敢
 * `rm -rf`——前缀是那条守卫的判据之一。runId 与库名后缀同一个值：一次跑 = 一张库 +
 * 一个产物目录，出问题时两边编号对得上。
 */
const dataDir = path.join(tmpdir(), `flowers-test-${runId}`);

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 20000,
    /**
     * 开跑前敲一次门：库连不上 / 库不存在时给一句能照着做的话（`npm run db:test:setup`），
     * 而不是让 40 多个文件各自吐一条裸 pg 3D000。见 `tests/global-setup.ts`。
     *
     * 现在它还会**建库 + 跑迁移 + 收尾删库**（每次跑一张 `flowers_test_<runId>`）：
     * 共用 `flowers_test` 时两个并发的 vitest 会互相 truncate，60 个用例集体变红，
     * 看上去像一次真回归。
     */
    globalSetup: ['./tests/global-setup.ts'],
    env: {
      FLOWERS_TEST_RUN_ID: runId,
      FLOWERS_DATA_DIR: dataDir,
    },
  },
});
