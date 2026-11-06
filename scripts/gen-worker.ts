import { db, pool } from '../src/db/client.js';
import { runJob } from '../src/core/uemaster/start.js';

/**
 * 后台生成 worker 的唯一入口。
 *
 * 由 `startGeneration` 以 detached 方式甩出去：`node <tsx> scripts/gen-worker.ts <jobId> <actor>`。
 * 它不读参数以外的任何请求状态，只认库里的那一行作业——所以它在请求结束之后
 * 仍然知道该做什么。
 *
 * 三段收口：
 * - 参数不全是**编程错误**（不是用户错误）：写 stderr、退出码 2，作业留在那里等
 *   下一次 `startGeneration` 的陈旧回收。
 * - `runJob` 自己负责把作业写成 done / failed；它抛出来只可能是「作业不存在」或
 *   数据库挂了——前者没有可写的东西，后者写不进去。
 * - 最后一定要 `pool.end()`：worker 是一次性的，连接不还回去它就一直挂着。
 *
 * stdio 是 'ignore'（见 `start.ts` 的 spawnWorker），所以 console.error 在正常部署里
 * 不会有人看到；它不是给用户的消息，用户读的是 `uemaster_jobs.error`。
 */
const jobId = process.argv[2];
const actor = process.argv[3] ?? '生成器';

if (!jobId) {
  console.error('usage: gen-worker <jobId> [actor]');
  process.exit(2);
}

try {
  await runJob(db, jobId, { actor });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
