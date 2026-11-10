import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { STOPPED_REASON } from './liveness.js';
import { startGeneration } from './start.js';

/**
 * 两个人工动作：**停止** 与 **重试**（2026-11-10）。
 *
 * ── 为什么它必须是两个服务、而不是在界面里拼
 *
 * 事故里最疼的一句是「no way to stop or retry」：一次生成挂了 90 分钟，owner 既不能
 * 把它停掉，也不能再按一次生成（那句「这个阶段正在生成中」把门守着）。所以这两件事
 * 必须和「生成」一样是服务层的能力：权限、状态判断、写库、杀进程都只有一处。
 *
 * ── 权限沿用「谁能生成，谁就能停 / 重试」
 *
 * 生成那一条的授权在 `app/actions.ts` 的 `generateAction`：`currentMember()` 解出身份，
 * 之后由 `startGeneration` 自己判断「能不能开这一次」（阶段 / 防重 / 生成器 / 六问）。
 * 它**不做**更细的门——抽屉里把按钮藏在 `can('edit')` 后面（P4-05：别人的需求只读），
 * 而服务层只认「登录成员」这一条。
 *
 * 停 / 重试照抄这条线，一个字都不加严：能按下「生成」的人，就必须能把他自己按下去的
 * 那一次停掉、以及重来一次。加一道更严的门会让「点错了的人只能干等 15 分钟」这件事
 * 重新出现——而它正是这次要修的东西。
 */

/** 一份作业的身份：停 / 重试都只需要这两个格。 */
type JobRow = {
  id: string;
  requirement_id: string;
  stage: string;
  status: string;
  worker_pid: number | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 作业 id 只可能来自页面状态或手改的请求：形状不对就是「不存在」，不值得领域错误码分家。 */
function parseJobId(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!UUID.test(value)) throw new AppError('not_found', '生成任务不存在');
  return value;
}

async function loadJob(db: Db, jobId: string): Promise<JobRow | null> {
  const res = await db.execute<JobRow>(sql`
    select id, requirement_id, stage, status, worker_pid
      from uemaster_jobs
     where id = ${jobId}`);
  return res.rows[0] ?? null;
}

/**
 * 杀掉这条作业的 worker **整个进程组**。
 *
 * 为什么杀组而不是杀一个 pid：`spawn` 用的是 `node <tsx> gen-worker.ts`，而 tsx 自己
 * 还会拉子进程（它要把 TS 转成 JS 再跑）。只杀父进程会留下一个还在写产物的孤儿，
 * 而「停止」在用户心里等于「它不再动了」。
 *
 * 两个 pid 语义：
 * - `process.kill(-pid)`：负号 = 进程组，`detached: true` 让 worker 自成一个组，
 *   组号就是它的 pid（见 `start.ts` 的 `spawnWorker`）；
 * - `process.kill(pid)`：兜底。worker 不是组长时（比如被一个不是 detached 的方式起
 *   起来的旧路径）组号发不到它，单发还能命中。
 *
 * 三种「杀不到」都不算失败，也都不抛出：
 * - `ESRCH`：它已经自己退了（用户按停止的同一次心跳里，作业刚好跑完）；
 * - `EPERM`：不是我们能发信号的进程；
 * - pid 为空：0035 之前的老行。
 * 这三种情况下，作业行照样被收成 canceled——**行是真相**，进程早就没了只是更好的结局。
 */
function killWorkerGroup(pid: number | null): void {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return;
  // 自己的 pid / 自己的进程组：绝不能对着写。这在测试里会真的发生（`runJob` 在用例
  // 进程里跑，worker_pid 是测试进程自己）。
  if (pid === process.pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // 不是组长 / 已经退出：下一句兜底。
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // 同上：行已经在下面被收成 canceled 了。
  }
}

/**
 * 停止一次生成：作业收成 `canceled` + 那句话，然后把 worker 的进程组杀掉。
 *
 * **顺序是这一段的要点**：先改库，后杀进程。
 * 反过来的话，worker 在收到 SIGTERM 之前可能先写完 failed / done（它有自己的超时与
 * catch），于是用户按的是「停止」，看到的却是一句「生成失败：…」。而 `failJob` /
 * `doneJob` 都带着 `where status = 'running'`，所以先把行改成 canceled 之后，
 * worker 再写什么都是空转——**库只认第一个说话的人**。
 *
 * 返回 `canceled: false` 的两种情况都不抛错：
 * - 作业已经结束了（done / failed / canceled）：用户按晚了一步，界面刷新一下就好，
 *   为这个弹一条错误只是噪音；
 * - 作业不存在：`not_found` 是**抛**的（它不是「按晚了」，是 id 坏了）。
 */
export async function cancelJob(db: Db, raw: unknown): Promise<{ canceled: boolean }> {
  const jobId = parseJobId(raw);

  const res = await db.execute<{ id: string; worker_pid: number | null }>(sql`
    update uemaster_jobs
       set status = 'canceled', error = ${STOPPED_REASON}, finished_at = now()
     where id = ${jobId} and status = 'running'
    returning id, worker_pid`);

  const row = res.rows[0];
  if (!row) {
    // 一行都没改到：要么已经结束，要么根本不存在。两者一句话不同——不存在是坏 id。
    if (await loadJob(db, jobId) === null) throw new AppError('not_found', '生成任务不存在');
    return { canceled: false };
  }

  killWorkerGroup(row.worker_pid === null ? null : Number(row.worker_pid));
  return { canceled: true };
}

/**
 * 重试：为同一条需求的同一个阶段**新开**一次作业。
 *
 * 三条口径：
 * 1. **旧行一行都不动**。失败 / 被停止的那一次是历史：它带着自己那句原因留在
 *    `uemaster_jobs` 里（时间线与排查要看的就是它），新作业是另一行、另一个 id。
 * 2. **不复制任何状态**。走 `startGeneration`——也就是「按下生成」走的那同一条路。
 *    于是六问、PRD、生成器、防重这些判断一条都不少；重试不是一条绕过检查的后门。
 * 3. 需求或阶段从**库里**取，不从调用方取：界面只交一个作业 id，别的都不可信。
 */
export async function retryJob(db: Db, actor: string, raw: unknown): Promise<{ jobId: string }> {
  const jobId = parseJobId(raw);
  const job = await loadJob(db, jobId);
  if (job === null) throw new AppError('not_found', '生成任务不存在');
  return startGeneration(db, actor, { requirementId: job.requirement_id, stage: job.stage });
}
