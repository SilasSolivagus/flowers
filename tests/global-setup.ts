import { assertDatabaseReachable } from '../src/db/preflight.js';

/**
 * vitest 的 globalSetup：整轮只跑一次，在任何一个用例之前。
 *
 * 只做一件事——把「测试库不存在」翻译成人话（见 `src/db/preflight.ts`）。
 * 放在这里而不是每个文件的 beforeAll：全量 40 多个文件，每个都敲一次门没有意义，
 * 而「第一次接触库」恰恰就是这里。
 */
export default async function setup(): Promise<void> {
  const database = await assertDatabaseReachable(process.env);
  process.stdout.write(`测试库：${database}\n`);
}
