import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';

/**
 * 孤儿作业的回收（2026-11-10）：**一条 `running` 行凭什么被判定为「已经死了」**。
 *
 * ── 事故的形状
 *
 * dev server 重启把 detached 的 worker 带走了，库里留下一条 `running`。抽屉那一行
 * 写着「正在生成页面片段 1:29:12 · 第 2 次尝试」，秒表按本地时钟一直跳——看起来像
 * 「还在动」。没有任何进程会再去写这一行，于是它永远不结束，用户也没有任何入口
 * 把它停掉。owner 只能手工 `UPDATE 1`。
 *
 * ── 三档判据，越靠前越确定（顺序不能换）
 *
 * 1. **pid 不在** → failed。这是「确定死」，不是「未知」：`uemaster_jobs` 一条行对应
 *    一个一次性 worker 进程，作业 id 不复用；那个 pid 不在了，就没有人能写这一行。
 *    把它读成「状态未知、继续等吧」是最坏的一种读法——它把一条永远不变的行包装成
 *    一件还在进行的事，用户等 90 分钟才敢怀疑。所以：死 pid = 死作业。
 *    （`process.kill(pid, 0)`：ESRCH = 不存在；EPERM = 存在但不是我们的，按活着算。）
 *
 * 2. **心跳过期**（> 90 秒没报到）→ failed。pid 可能为空（0035 之前的老行，或 spawn
 *    之后 pid 还没写回的那一瞬），那时 pid 什么都证明不了；也可能 pid 被操作系统
 *    回收给了别的进程（那时它「活着」，但活着的不再是我们的 worker）。心跳是唯一
 *    能说「这一条作业刚刚还在动」的证据。
 *
 * 3. **绝对年龄上限**（> 15 分钟）→ failed。worker 自己会在 10 分钟那一刻硬超时并写
 *    failed（`runJob` 的 `DEFAULT_TIMEOUT_MS`）；15 分钟还没收口的，要么它挂在一次
 *    读不回来的系统调用上（连自己的超时都跑不到），要么心跳根本没写成。无论如何，
 *    这一条不能继续占着那个阶段——**没有任何一条作业值得让界面永远转下去**。
 *
 * 三条都**只**作用于 `status = 'running'`：done / failed / canceled 是历史，一个字都不改。
 *
 * ── 为什么回收挂在读侧
 *
 * 写侧已经死了——这正是问题本身。能注意到这件事的只剩「有人来看」：抽屉每 2 秒问一次
 * `jobStatus`，进度卡每次渲染问一次 `listRunningJobs`，抽屉渲染问一次 `readDetail`。
 * 于是「打开看一眼」就等于「把它收掉」，不需要一个守护进程、不需要定时任务，也不会
 * 在没人看的深夜里空转。
 */

/**
 * 心跳间隔。15 秒是「一次网络请求的上限」量级：模型调用慢的是几分钟，但那是**一次**
 * 调用；15 秒内一次都没报到，只剩「进程没了」和「卡在系统调用里」两种解释。
 */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * 心跳过期阈值：**连续 6 拍没有报到**。
 *
 * 留 6 倍余量而不是 2 倍：worker 在两次 `await` 之间可能被 GC / 事件循环挤住，
 * 一个 15 秒的阈值会把「一次慢调用」误判成「死了」，而那会把一条**正在跑**的作业
 * 砍掉（产物白跑，模型白烧）。90 秒误判的概率足够低，而它挡住的那种坏（永远转）
 * 代价高得多。
 */
export const HEARTBEAT_STALE_MS = 6 * HEARTBEAT_INTERVAL_MS;

/**
 * 绝对年龄上限：15 分钟。
 *
 * 与 `start.ts` 的 `DEFAULT_TIMEOUT_MS`（10 分钟硬超时）之间留 5 分钟：正常路径上
 * 作业在 10 分钟那一刻被 worker 自己收成 failed，这一条守的是**连那一步都跑不到**
 * 的情况（进程挂在不可中断的调用里、心跳写不进去）。它不是超时策略，是兜底。
 */
export const MAX_JOB_AGE_MS = 15 * 60 * 1000;

/**
 * 死进程留下的那一句。**这是用户要读的话**：说清发生了什么（进程没了）、这次的结果
 * （没有产出）、下一步（直接重试）。不写「状态未知」「请稍后再看」：它们都在暗示
 * 「等一等会好」，而这一行永远不会自己好。
 */
export const ORPHAN_EXITED = '生成进程已退出（服务已重启或被终止），本次没有产出；可以直接重试';

/** 进程还在、心跳没了：卡住的那一种。措辞里带秒数，因为这是**我们**的判据。 */
export const ORPHAN_SILENT = '生成进程 90 秒没有回报（可能卡住了），本次没有产出；可以直接重试';

/** 超过绝对年龄上限：连心跳都没写成的那些。 */
export const ORPHAN_TOO_OLD = '生成超过 15 分钟没有结果，本次已作废；可以直接重试';

/**
 * 用户按「停止」时写进 `error` 的那一句。
 *
 * 它同时是状态（`canceled`）的人话版本：界面上「已手动停止」不是失败原因，是一个
 * 结果。折成 `failed` 会让「失败率」这类数字从此说不清——人停的和程序坏的不是一件事。
 */
export const STOPPED_REASON = '已手动停止';

/**
 * 这个 pid 现在还在不在。
 *
 * 三种回答必须折叠成两种（在 / 不在），因为调用方要的是一个**判据**，不是一份诊断：
 * - `ESRCH`：没有这个进程 → false；
 * - `EPERM`：进程在，但不是我们能发信号的（别的用户 / 已经换了主人）→ true。
 *   这正是「pid 被回收给别的进程」的形状：作业其实死了，而 pid 还「活着」——
 *   这一档由心跳与年龄上限兜住，见文件头第 2 档。
 * - 其它 errno（理论上只有 EINVAL，pid 非法）：按**活着**算。判死是要动手改库的，
 *   一个说不清的错不该换来一次误杀。
 */
export function pidAlive(pid: number | null | undefined): boolean {
  if (pid === null || pid === undefined) return false;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

/** 判据要的三格：谁在跑、最后一次报到、什么时候开的。全用 epoch 毫秒。 */
export type JobLiveness = {
  workerPid: number | null;
  heartbeatAt: number | null;
  createdAt: number;
};

/**
 * 这一条 running 作业该死吗？死 → 返回那句中文；活着 → null。
 *
 * 纯函数，`alive` 可注入：用例要能说「pid 42 不在了」而不必真的去杀一个进程。
 * 顺序就是文件头的三档（pid → 心跳 → 年龄），换顺序会让「dead pid 立刻收掉」
 * 退化成「等 15 分钟」。
 */
export function stallReasonOf(
  job: JobLiveness,
  now: number,
  alive: (pid: number) => boolean = pidAlive,
): string | null {
  if (job.workerPid !== null && !alive(job.workerPid)) return ORPHAN_EXITED;
  if (job.heartbeatAt !== null && now - job.heartbeatAt > HEARTBEAT_STALE_MS) return ORPHAN_SILENT;
  if (now - job.createdAt > MAX_JOB_AGE_MS) return ORPHAN_TOO_OLD;
  return null;
}

type RunningRow = {
  id: string;
  worker_pid: number | null;
  heartbeat_at: Date | null;
  created_at: Date | string;
};

/**
 * 把符合判据的 running 行收成 failed。返回被收掉的作业 id（调用方基本不用，
 * 用例与手工排查要看它）。
 *
 * 三处调用点（读侧）：
 * - `jobStatus`：抽屉的轮询，**这是修这次事故的那一处** —— 用户盯着的那一行，
 *   下一次轮询回来就是「生成进程已退出…」+ 重试；
 * - `readDetail`：有人打开抽屉时先收一次，免得服务端渲染出一个已经不存在的「生成中」；
 * - `listRunningJobs`：右下角进度卡，否则一条死作业会永远挂在「现在在跑什么」里。
 *
 * `where status = 'running'` 让写入是幂等的（与 `failJob` 同一条规矩）：两个请求同时
 * 回收同一行时，后到的什么也不改。
 *
 * 单行的 update 失败**吞掉**：读模型不能因为「顺手做的好事」失败而整页报错——那条
 * 作业下一轮还会被再收一次。
 */
export async function healStaleJobs(
  db: Db,
  opts: { requirementId?: string; jobId?: string; now?: number; alive?: (pid: number) => boolean } = {},
): Promise<string[]> {
  const now = opts.now ?? Date.now();
  const filter = opts.jobId !== undefined
    ? sql`and id = ${opts.jobId}`
    : (opts.requirementId !== undefined ? sql`and requirement_id = ${opts.requirementId}` : sql``);

  const res = await db.execute<RunningRow>(sql`
    select id, worker_pid, heartbeat_at, created_at
      from uemaster_jobs
     where status = 'running' ${filter}`);

  const healed: string[] = [];
  for (const row of res.rows) {
    const reason = stallReasonOf({
      workerPid: row.worker_pid === null ? null : Number(row.worker_pid),
      heartbeatAt: row.heartbeat_at === null ? null : new Date(row.heartbeat_at).getTime(),
      createdAt: new Date(row.created_at).getTime(),
    }, now, opts.alive);
    if (reason === null) continue;
    try {
      await db.execute(sql`
        update uemaster_jobs
           set status = 'failed', error = ${reason}, finished_at = now()
         where id = ${row.id} and status = 'running'`);
      healed.push(row.id);
    } catch {
      // 见上：读侧顺手做的好事，失败不该变成用户看到的错误。
    }
  }
  return healed;
}
