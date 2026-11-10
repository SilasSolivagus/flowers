import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { asText, parseRequirementId, requirePlainObject } from '../validate.js';
import type { State } from '../state-machine.js';
import { resolveMirrorConfig } from '../codemirror/mirror.js';
import { fingerprintOfRow } from '../requirements/fingerprint.js';
import { attachArtifact } from './attach.js';
import { readAttempts } from './attempts.js';
import type { AttemptPhase, AttemptView } from './trace.js';
import { composeEvaluation } from './compose.js';
import { evaluateLock } from '../requirements/brief.js';
import { evaluateStageLock } from './gate.js';
import {
  HEARTBEAT_INTERVAL_MS, healStaleJobs, stallReasonOf,
} from './liveness.js';
import { loadKnownSurfaces } from './surfaces.js';
import { REVIEW_NEEDS_PRD, reviewRequirement } from './review.js';
import { inspect as inspectMaterial } from './inspect.js';
import { artifactUrlIn, credentialFor, resolveGenerator, runGenerator } from './generator.js';
import { isStage, packFor, type Stage } from './packs.js';
import { resolveProviderConfig, type ProviderConfig } from './provider.js';
import { generatorCommand } from './settings.js';
import { adoptLegacyArtifact, artifactFile } from './store.js';
import { nextArtifactVersion } from './versions.js';

/**
 * 生成作业的**起点**（服务层）与**执行体**（worker 里跑的那一段）。
 *
 * 两段刻意放在一个文件、却不放在一个进程里：
 * - `startGeneration` 在请求里跑，只做四件事：校验、防重、落一行 running、把 worker
 *   甩出去。它必须很快返回——界面拿到的不是结果，而是 `jobId`。
 * - `runJob` 在 detached 的 `scripts/gen-worker.ts` 里跑：它要活过这次 HTTP 往返
 *   （CLI 可能跑几分钟），所以不能挂在请求的生命周期上。
 *
 * 这样切的好处是**可测**：worker 的那一段是普通异步函数，用例可以直接用 stub 命令
 * 跑它，不必真的起一个 detached 进程；而「甩进程」那一步只有几行，失败时也有中文出口。
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** 默认硬超时：十分钟。够一个 agent 画完流程图 + 线框页，又短到用户等得起。 */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 一条 running 作业超过「超时 + 一分钟」还没回来，就当它死了。
 *
 * worker 自己会在超时那一刻把作业收成 failed（`runJob` 的硬超时）；这一条守的是
 * **进程被 kill / 机器重启**那种连 worker 都不在的情况。不设它，一条僵死的 running
 * 行会把那个阶段永久锁住——用户看到「正在生成中」，而其实什么都没在跑。
 *
 * 2026-11-10 起这一条**不再是唯一的判据**，也不再只在 `startGeneration` 里生效：
 * 死亡判据搬到了 `liveness.ts`（pid 不在 / 心跳过期 / 15 分钟年龄上限），并且挂在
 * 读侧——一次打开抽屉就会把死行收掉，不必等下一次按按钮。这里保留这个常量只为
 * 「年龄」那一档还认得它（`STALE_RUNNING_MS` 是 11 分钟，比 `MAX_JOB_AGE_MS` 的
 * 15 分钟更早；两档都保留是因为前者是「超时之后一分钟」，后者是「怎么都该结束了」）。
 */
export const STALE_RUNNING_MS = DEFAULT_TIMEOUT_MS + 60 * 1000;

/**
 * 工作目录与产物根都从**模块位置**推，不认 `process.cwd()`：worker 的 cwd 是我们
 * 自己设的，但 Next 的 server action 跑在任意被起起来的进程里；同一条规矩与
 * `store.ts` 一致，产物路径只能有一个答案。
 */
export function repoRoot(): string {
  return REPO_ROOT;
}

const BAD_STAGE = '阶段只能是 evaluate、review、inspect 之一';

/**
 * 这次生成走哪条路。
 *
 * 规则只有一条，**只看「配没配」，不看「通不通」**：
 * - `resolveProviderConfig()` 给出完整三格（接口地址 + Key + 模型名）→ `provider`，
 *   由 `composeEvaluation` 自己问模型、自己排版、自己写 HTML；
 * - 否则 → `cli`，沿用 P2.6 的「甩一条 agent CLI」那条路（`packs.ts` 的任务包）。
 *
 * 为什么要「看配没配」而不是「先试 provider、失败再退 CLI」：两条路的产物形状不同
 * （provider 的图是**必须过引擎**的，CLI 的图是 agent 自己画的），静默降级会让同一条
 * 需求两次生成出两种质量的材料，而用户看不出是哪一种。走哪条路由配置决定，报错时
 * 也就能说清「你配了什么、我用了什么」。
 *
 * 为什么不问「通不通」：探测一次要发一次真实请求、烧一次 token。配置写错的代价由
 * 第一次生成来暴露，那时错误原文会原样进 `uemaster_jobs.error`——比在按钮上先卡 30 秒好。
 *
 * P2.12：`actor` 是**这次生成的归属人**。成员可以有自己的 key（`member.<id>.provider.*`），
 * 所以「走 provider 还是 CLI」因人而异：A 配了自己的 key、B 没配，同一条需求在 A 那里
 * 走 provider、在 B 那里走 CLI。这里必须问同一个人——与 `created_by` 写的那一个字符串
 * 同源，否则「谁按的按钮」与「用的是谁的 key」会是两个人。
 */
export type Strategy =
  | { kind: 'provider'; config: ProviderConfig }
  | { kind: 'cli' };

export async function resolveStrategy(actor?: string): Promise<Strategy> {
  const config = await resolveProviderConfig(actor);
  return config === null ? { kind: 'cli' } : { kind: 'provider', config };
}


/** 与 `attach.ts` 同一句话、同一个 code：阶段是用户给的，就该拿到中文。 */
function parseStage(value: unknown): Stage {
  const stage = asText(value);
  if (!isStage(stage)) throw new AppError('invalid_stage', BAD_STAGE);
  return stage;
}

/**
 * 作业的三种结局（2026-11-10 起多一档 `canceled`）。
 *
 * `canceled` 是**用户按了「停止」**，不是失败：界面上那句是「已手动停止」，不是
 * 「生成失败：…」。它必须是一个自己的状态，否则「失败率」这种数字从此说不清。
 */
export type JobStatus = 'running' | 'done' | 'failed' | 'canceled';

export type JobView = {
  id: string;
  stage: Stage;
  status: JobStatus;
  error: string | null;
  url: string | null;
  createdAt: string;
  finishedAt: string | null;
  /**
   * 现在跑到哪一段（2026-11-10）。
   *
   * 为什么它必须挂在**这一条**读取上：生成要跑 2–5 分钟，抽屉里原来只有一个「生成中」
   * 的字，读者分不出「在动」和「卡死」。`uemaster_job_attempts.phase` 本来就把这件事
   * 记着（进度卡 P4-02 一直在读），抽屉那一行只是没有拿它。
   *
   * 一次都没问模型时是 `null`（那会儿在读 PRD / 备输入），中文由 `phases.ts` 给。
   */
  phase: AttemptPhase | null;
  /**
   * 走到第几次尝试（1 基；`0` = 一次都还没有）。
   *
   * 只在 `> 1` 时上屏（「第 2 次尝试」）：第 1 次是常态，写上去只是噪音。
   */
  attempt: number;
  /**
   * 这一次作业留下的每一次尝试（P2.13），按发生顺序。
   *
   * 为什么挂在 `JobView` 上而不是另开一个 action：抽屉拿到「失败了」的那一刻，紧接着
   * 就要那块「详情」；分成两次往返，中间那一帧就是「有一句失败原因、点开详情是空的」。
   * 还在跑的作业给空数组（那**整张清单**在跑的时候没意义，每次轮询都为它多查一次不划算；
   * 而「跑到哪一步、第几次」是另外两格，见上面）。
   */
  attempts: AttemptView[];
};

/**
 * 记一条失败：status + error + finished_at。
 *
 * `where status = 'running'` 让这个写入是**幂等**的：超时定时器与 close 事件有可能
 * 都走到这里，先到的那个说了算，后到的不会把一条已经 done 的作业改回 failed。
 */
async function failJob(db: Db, jobId: string, error: string): Promise<void> {
  await db.execute(sql`
    update uemaster_jobs
       set status = 'failed', error = ${error.slice(0, 2000)}, finished_at = now()
     where id = ${jobId} and status = 'running'`);
}

/** 写生成结果：成功才有 artifact_id；同样只在 running 上生效。 */
async function doneJob(db: Db, jobId: string, artifactId: string): Promise<void> {
  await db.execute(sql`
    update uemaster_jobs
       set status = 'done', error = null, artifact_id = ${artifactId}, finished_at = now()
     where id = ${jobId} and status = 'running'`);
}

/**
 * 起一次生成。
 *
 * 顺序是有讲究的：先锁需求行 → 看这个阶段有没有在跑的作业 → 落一行 running →
 * 提交 → 再甩 worker。锁需求行（`for update`）而不是只查一次 running：两个标签页
 * 同时点「生成」时，那句中文「正在生成中」必须由一个确定的顺序产生，而不是靠运气；
 * 库里那条 `uemaster_jobs_running_unique` 部分唯一索引是并发兜底（绕过服务层的人
 * 也撞得回来）。
 *
 * 陈旧回收放在「拒绝」之前：一条 running 是死进程留下的，把它收成 failed 再放行，
 * 用户不必等下一次重启。判据从 2026-11-10 起是 `liveness.ts` 那三档（pid 不在 /
 * 心跳过期 / 15 分钟年龄上限）——**同一条判据**也挂在读侧，所以这里碰到死行的机会
 * 已经很小；留着它是为了让「按生成」这条路自己也是自洽的（不依赖有没有人先看过抽屉）。
 */
export async function startGeneration(
  db: Db,
  actor: string,
  raw: unknown,
): Promise<{ jobId: string }> {
  const input = requirePlainObject(raw);
  const requirementId = parseRequirementId(input);
  const stage = parseStage(input.stage);

  const jobId = await db.transaction(async (tx) => {
    // 六问全部取回来：2026-11-11 起这道门判的是六格，只取前三格会让后三问永远
    // 「没填」（同一处踩过的坑见 `requirements/lock.ts` 的 `briefOf`）。
    const found = await tx.execute<{
      id: string; prd_url: string | null; state: State;
      context: string | null; problem: string | null; outcome: string | null;
      surfaces: string | null; edge_cases: string | null; out_of_scope: string | null;
    }>(sql`select id, prd_url, state, context, problem, outcome,
                  surfaces, edge_cases, out_of_scope
           from requirements
           where id = ${requirementId} and deleted_at is null for update`);
    if (!found.rows[0]) throw new AppError('not_found', '需求不存在');

    /**
     * 评审材料要先有 PRD（2026-11-08 裁定：**没有 PRD 直接拒绝，并说清怎么补**）。
     *
     * 位置是这一条的要点：拒绝发生在**落作业之前**，所以一次被拒的点击不会留下
     * `uemaster_jobs` 行、不会甩 worker、不会读 PRD（也就没有 `prd_snapshots` 行）、
     * 更不会有一份看起来「评过」的材料。用户拿到的就是那句点名修法的中文，
     * 由 `generateAction` 原样交回按钮那一行。
     *
     * 只在 `review` 上生效：评估材料的输入是六段描述，走查是另一条链（它缺 PRD 时
     * 由 `runJob` 自己那句拦下）——这一条裁定只说评审材料，不顺手扩大。
     */
    if (stage === 'review' && (found.rows[0].prd_url ?? '').trim() === '') {
      throw new AppError('prd_missing_url', REVIEW_NEEDS_PRD);
    }

    const running = await tx.execute<{
      id: string; created_at: Date; worker_pid: number | null; heartbeat_at: Date | null;
    }>(sql`
      select id, created_at, worker_pid, heartbeat_at
        from uemaster_jobs
       where requirement_id = ${requirementId} and stage = ${stage} and status = 'running'
       order by created_at desc, id desc
       limit 1`);
    const current = running.rows[0];

    if (current) {
      // 三档判据与读侧同一份（`liveness.ts`）：pid 不在立刻收、心跳过期收、太老收。
      const reason = stallReasonOf({
        workerPid: current.worker_pid === null ? null : Number(current.worker_pid),
        heartbeatAt: current.heartbeat_at === null ? null : new Date(current.heartbeat_at).getTime(),
        createdAt: new Date(current.created_at).getTime(),
      }, Date.now());
      if (reason === null) {
        throw new AppError('generation_running', '这个阶段正在生成中，等这次结束再试');
      }
      await tx.execute(sql`
        update uemaster_jobs
           set status = 'failed', error = ${reason}, finished_at = now()
         where id = ${current.id} and status = 'running'`);
    }

    /**
     * v1 阶段门：**评估材料只在「收集」阶段生成**（2026-11-10 owner 裁决 A）。
     * 判据在 `gate.ts` 的 `evaluateStageLock`，这一处是**唯一的真相**：界面把同一句话
     * 提前画在按钮旁边（按钮禁用），而一个绕过界面的 POST、以及「重试」那条路
     * （`control.ts` 的 `retryJob` 也走这个函数）仍然撞在这里。
     *
     * 位置三条理由，与六问门同一套：
     * - 放在防重之后：那个阶段已经在跑时，「正在生成中」才是这次点击的直接结果；
     * - 放在六问门**之前**：一句话只说一个理由。一条「待设计」的需求即使六问也空着，
     *   它现在的问题也是「阶段不对」——补完六问它还是不能生成，先说这句才有用；
     * - 放在落作业之前：一次被拒的点击不留作业行、不甩 worker、不烧一次模型调用。
     *
     * 只作用于 `evaluate`：评审的输入是 PRD、走查的输入是 PRD + 代码镜像，两条的
     * 阶段归属与评估不同（v1 里它们本来也由 `FEATURE_REVIEW_MATERIALS` 关着）。
     */
    if (stage === 'evaluate') {
      const closed = evaluateStageLock(found.rows[0].state);
      if (closed !== null) throw new AppError('stage_not_inbox', closed);
    }

    /**
     * 六问没填，不许生成（2026-11-10 owner 的裁定）。判据在
     * `requirements/brief.ts`，**这一处不是判据的首发地**——真正的门挂在状态变迁上
     * （`state-machine.ts` 的 `guard: 'brief'`，`inbox → design`，trigger `approve`）。
     * 生成前再问一次，是因为这件事本来就是「材料能不能出」：
     *
     * - 那三问是材料唯一的依据：没有角色与入口，图就是一张无主的框子；没有现状，
     *   问题清单只能凭空造。放行到 worker 里，等于先烧一次模型调用、跑完 2–5 分钟，
     *   再交回一份编出来的材料——而这句话在点下去的那一秒就已经成立；
     * - 界面把**同一个字符串**提前画在按钮旁边（按钮禁用），读模型与服务不会各说一句。
     *
     * 2026-11-10 的第二次纠正之后，这道门前后的世界变了：**生成不再改状态**，所以它
     * 不再是「立项的前置检查」，它就是**生成**这件事自己的门槛（立项那道门在
     * `brief.ts` 的 `guard: 'brief'` 上，同一份判据、同一句话）。两处各问一次不是
     * 重复：一处拦「材料能不能出」，一处拦「这件事能不能立项」。
     *
     * 位置三条理由：
     * - 放在防重之后：那个阶段已经在跑时，「正在生成中」才是这次点击的直接结果；
     * - 放在生成器探测之前：缺描述是**用户自己**能补的，缺生成器常常要管理员；
     *   先让他看见自己能做的那一步；
     * - 放在落作业之前：一次被拒的点击不留作业行、不甩 worker、不烧一次模型调用。
     *
     * 只作用于 `evaluate`：评审的输入是 PRD 本身、走查的输入是 PRD + 代码镜像，两条都
     * 不以六问为前提（v1 里这两条本来也还没开放）。
     */
    if (stage === 'evaluate') {
      const row = found.rows[0];
      const lock = evaluateLock({
        context: row.context, problem: row.problem, outcome: row.outcome,
        surfaces: row.surfaces, edgeCases: row.edge_cases, outOfScope: row.out_of_scope,
      });
      if (lock !== null) throw new AppError('description_incomplete', lock);
    }

    // 生成器在不在？放在**防重之后**：用户先要知道「这个阶段已经在跑了」，而不是
    // 先被问「用哪个生成器」。两句话同时成立时，前者是他这次点击的直接结果。
    //
    // 配了模型接口就**不需要**任何 CLI（见 `resolveStrategy` 的注释）：这时那句
    // 「未检测到生成器」是假的，必须跳过——否则一个只有 key 的部署永远点不动按钮。
    //
    // `choose` 与 `none` 都在这里拒绝，作业一行都不落——界面上它们本来就不该走到
    // 这一步（多条时按钮先开选择器，零条时按钮直接禁用），这里是绕过界面的兜底。
    const strategy = await resolveStrategy(actor);
    if (strategy.kind === 'cli') {
      const resolution = await resolveGenerator(await generatorCommand(tx));
      if (resolution.kind === 'none') {
        throw new AppError(
          'generator_unavailable',
          '未检测到生成器：到「设置 · 项目 · 生成器」配置一条，或在「设置」里配好模型接口',
        );
      }
      if (resolution.kind === 'choose') {
        throw new AppError(
          'generator_unconfigured',
          '还没选生成器：在「生成」里选一个，按「测试并使用」',
        );
      }
    }

    const inserted = await tx.execute<{ id: string }>(sql`
      insert into uemaster_jobs (requirement_id, stage, status)
      values (${requirementId}, ${stage}, 'running')
      returning id`);
    return inserted.rows[0]!.id;
  });

  try {
    const pid = spawnWorker(db, jobId, actor);
    // 把「谁在跑」记下来（2026-11-10）。`where status = 'running'` 是必须的：
    // worker 有可能在这个 update 之前就把自己收尾了（stub 生成器跑完只要几十毫秒），
    // 那时一行 done/failed 不该被改回一个 pid。
    //
    // 写不进去（库抖一下）也不抛出：worker 自己启动后会把 pid 再写一次，而且心跳
    // 从不依赖这一行——回收判据有两档后备（心跳、年龄上限）。
    await recordWorkerPid(db, jobId, pid);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failJob(db, jobId, message);
    throw new AppError('generator_unavailable', message);
  }

  return { jobId };
}

/**
 * 记下「这条作业由哪个进程在跑」。
 *
 * 为什么要单独一个函数、并且**两处都写**（这里 spawn 之后写一次，worker 启动后自己
 * 再写一次）：spawn 到 worker 真正跑起来之间有一段时间（tsx 冷启动，实测 200–800ms），
 * 这段时间里作业是 running 而「谁在跑」还空着。谁先写到就算谁的，`coalesce` 保证
 * 后写的不会把先写的抹成一个不同的值（两处写的是同一个 pid）。
 */
async function recordWorkerPid(db: Db, jobId: string, pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  try {
    await db.execute(sql`
      update uemaster_jobs
         set worker_pid = coalesce(worker_pid, ${pid}), heartbeat_at = now()
       where id = ${jobId} and status = 'running'`);
  } catch {
    // 见调用处：这一格不是主路径，写不进去有另外两档判据兜着。
  }
}

/**
 * 把 worker 甩出去：detached + 三路 ignore + unref。
 *
 * 三个 flag 各自解决一件事：
 * - `detached: true`：worker 自成一个会话/进程组，请求结束（甚至 Next 重启）不会把它带走。
 *   **它同时是「停止」能用的前提**：进程组长（pgid = 自己的 pid）才收得到
 *   `kill(-pid)`，那一条把 tsx 与它拉起的子进程一起杀掉（见 `control.ts`）。
 * - `stdio: 'ignore'`：它的输出没有读者。让管道连着父进程，父进程一退出就会 EPIPE。
 * - `unref()`：父进程的事件循环不再为它保活——请求该多快返回就多快返回。
 *
 * 为什么用 `node + tsx` 跑 `.ts` 而不是编译出一份 `.js`：仓库里没有「worker 单独构建」
 * 这一步（`next build` 只产出 Next 的 bundle），而 tsx 已经是 devDependency、被
 * `npm run seed` / `demo` 天天用。找不到 tsx 时**不静默**：抛中文错误，作业收成 failed。
 *
 * 返回子进程 pid（2026-11-10 起调用方要把它记进作业行）：没有它，回收判据只剩时间，
 * 而时间说不出「没有人在跑」。
 */
function spawnWorker(db: Db, jobId: string, actor: string): number | undefined {
  const tsx = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!existsSync(tsx)) {
    throw new Error('后台执行器不可用：找不到 node_modules/tsx');
  }
  const script = path.join(REPO_ROOT, 'scripts', 'gen-worker.ts');
  const child = spawn(process.execPath, [tsx, script, jobId, actor], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.on('error', () => {
    // 异步的 spawn 失败（ENOENT 之类）不会抛到调用方；作业不能因此永远 running。
    void failJob(db, jobId, '生成进程没能启动');
  });
  child.unref();
  return child.pid;
}

/**
 * 一次「产物文件」的快照：在不在、什么时候写的。
 *
 * 为什么要它：产物路径是**固定的**（`data/uemaster/PAN-n/stage.html`，重做覆盖同一份）。
 * 如果上一版文件还在、这次 agent 什么都没写就退出 0，光看「文件存在」会把旧材料当成
 * 新生成的结果交回去——那是最坏的一种谎。所以跑之前记 mtime，跑之后要求它变了。
 */
async function snapshot(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

export type RunJobOptions = {
  /** 写进 `uemaster_artifacts.created_by`：按按钮的人，或 worker 的默认值。 */
  actor?: string;
  timeoutMs?: number;
  cwd?: string;
};

/**
 * worker 的全部逻辑：读作业 → 拼任务包 → 跑生成器 → 验文件 → attach → 收口。
 *
 * 三条不可协商的边界：
 * 1. **绝不把作业留在 running**。任何异常（生成器报错、attach 拒绝、代码 bug）都被
 *    这一层接住并写成 failed；`runGenerator` 自己还有硬超时。
 * 2. **只有真的写出来的文件才算成功**。文件不存在、或者 mtime 没变，都是失败，
 *    原因写给用户看。
 * 3. **重复进入是安全的**。作业不是 running 就直接返回；UPDATE 都带
 *    `status = 'running'` 条件。
 *
 * 没有 PRD 的评审 / 走查在这里就停：`packFor` 给出的是一段「停止：到此停止…」，
 * 交给 agent 只会浪费一次调用，还会让它交回一份猜的材料。直接用中文说清缺什么。
 */
export async function runJob(db: Db, jobId: string, opts: RunJobOptions = {}): Promise<void> {
  const actor = opts.actor?.trim() || '生成器';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const found = await db.execute<{
    id: string; stage: string; status: string;
    requirement_id: string; number: number; title: string;
    type: string | null; requester: string; prd_url: string | null;
    context: string | null; problem: string | null; outcome: string | null;
    surfaces: string | null; edge_cases: string | null; out_of_scope: string | null;
    platforms: string[] | null;
    priority: string | null;
  }>(sql`
    select j.id, j.stage, j.status,
           r.id as requirement_id, r.number, r.title, r.type, r.requester, r.prd_url,
           r.context, r.problem, r.outcome, r.surfaces, r.edge_cases, r.out_of_scope,
           r.platforms, r.priority
      from uemaster_jobs j
      join requirements r on r.id = j.requirement_id
     where j.id = ${jobId}`);
  const job = found.rows[0];
  if (!job) throw new AppError('not_found', '生成任务不存在');

  /**
   * 这次生成是照着哪一版描述做的（P4-02）。
   *
   * 取在这里、不在 attach 那一刻：worker 会跑 2–3 分钟，中途有人改描述是常态。
   * 所有 provider 分支（compose / review / inspect）各自在自己的 `loadRequirement`
   * 里算同一件事；CLI 那条路是**本函数**直接 attach，所以这里也算一份。
   */
  const inputHash = fingerprintOfRow(job);
  if (job.status !== 'running') return;
  if (!isStage(job.stage)) {
    await failJob(db, jobId, BAD_STAGE);
    return;
  }

  /**
   * 从这一刻起，这条作业有主人了（2026-11-10）：`worker_pid` 写上自己，`heartbeat_at`
   * 每 15 秒报到一次。
   *
   * 为什么 worker **自己**也写一次 pid：`startGeneration` 那一次写发生在 spawn 之后，
   * 而 tsx 冷启动要几百毫秒——这段时间里作业是 running 而「谁在跑」空着。谁先写到
   * 就是谁（`coalesce` 保证两处写同一个值时幂等）。
   *
   * 为什么心跳挂在 `setInterval` 而不是每次 await 之后打一下：这条函数里最长的一段
   * 是**一次**模型调用（几分钟），中间没有我们可以插入的位置；而「还在动」这件事只能
   * 由一个独立的定时器说。`unref()` 让它不拖着进程退出——作业结束就该走。
   *
   * 心跳失败**吞掉**：库抖一下不该让一次跑了两分钟的生成作废（下一次心跳会补上，
   * 而且即使全丢，读侧还有 pid 与年龄上限两档）。
   */
  await recordWorkerPid(db, jobId, process.pid);
  const beat = setInterval(() => {
    void db.execute(sql`
      update uemaster_jobs set heartbeat_at = now()
       where id = ${jobId} and status = 'running'`).catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);
  beat.unref?.();

  try {
    if (job.prd_url === null && job.stage !== 'evaluate') {
      const noun = job.stage === 'review' ? '评审材料' : '走查材料';
      await failJob(db, jobId, `缺少 PRD 链接，无法生成${noun}`);
      return;
    }

    // ── 路 A：配了模型接口 —— 自己问模型、自己排版、自己写 HTML ──
    //
    // 这一段没有「文件有没有变」的检查：`composeEvaluation` 的产物是它**刚刚**
    // 写出来的（写文件在 attach 之前），而且图已经过了引擎。作业的形状不变：
    // 成功 done + artifact_id，失败 failed + 那句中文。
    //
    // P2.12：配置要按**同一个人**再解析一次。worker 是另一个进程，不能信请求那一刻的
    // 结论（那个人可能刚在设置页里换了自己的 key）；而 compose 默认的 `resolveConfig`
    // 不带成员，会拿到平台那一份——同一个作业就会出现「路由按 A 的 key 判定、实际用
    // 平台的 key 发请求」这种两套配置。所以这里把 `actor` 显式传进去。
    const strategy = await resolveStrategy(actor);
    if (strategy.kind === 'provider') {
      /**
       * 走查是**另一条链路**：它的输入除了 PRD 还有「实现」，而实现只存在于代码镜像
       * （`codemirror/mirror.ts` 的只读层）里。所以它不能被 compose 那条路顶替——
       * 用评估管线生成一份「走查材料」，产物是对的、结论全是编的，那是最坏的一种坏。
       *
       * 没有镜像就在这里停下，并点名缺的那一格（`code.mirror.repos`）。检查放在
       * worker 里而不是 `startGeneration` 里：配置可能在按钮按下的那一刻之后被改，
       * 而 worker 是真正要用它的那个进程。
       */
      /**
       * 评审是**另一条链路**：输入是 PRD 本身（逐字读），产出是问题清单，第三段把清单
       * 写进每个节点的标注。把它交给 `composeEvaluation` 正是这一版要修的那个 bug——
       * 那时候 `stage=review` 只是换了个标题的评估材料，而它看起来像评审过。
       */
      if (job.stage === 'review') {
        const reviewed = await reviewRequirement(db, actor, {
          requirementId: job.requirement_id,
          jobId,
        }, {
          // 同 compose / inspect：worker 是另一个进程，配置要按**同一个人**再解析一次（P2.12）。
          resolveConfig: () => resolveProviderConfig(actor),
          // 现有页面清单（任务 4）：只有 worker 这一层同时拿得到 db 与镜像读口。
          loadSurfaces: () => loadKnownSurfaces(db),
        });
        await doneJob(db, jobId, reviewed.artifactId);
        return;
      }

      if (job.stage === 'inspect') {
        const mirror = await resolveMirrorConfig(db);
        if (!mirror.ok) {
          await failJob(db, jobId, `生成走查材料需要代码镜像：${mirror.message}`);
          return;
        }
        const inspected = await inspectMaterial(db, actor, {
          requirementId: job.requirement_id,
          jobId,
        }, {
          // 同 compose：worker 是另一个进程，配置要按**同一个人**再解析一次（P2.12）。
          resolveConfig: () => resolveProviderConfig(actor),
        });
        await doneJob(db, jobId, inspected.artifactId);
        return;
      }

      const composed = await composeEvaluation(db, actor, {
        requirementId: job.requirement_id,
        stage: job.stage,
        // 留痕按作业 id 落库：这一次生成的五次调用（图 3 + 页 2 + 构建 1）里，
        // 通过的和被拒的都要有名字，而 `uemaster_jobs.error` 只留得下最后一句。
        jobId,
      }, {
        resolveConfig: () => resolveProviderConfig(actor),
        // 现有页面清单（任务 4）：读不到就整段不写（`loadKnown` 吞成空数组）。
        loadSurfaces: () => loadKnownSurfaces(db),
      });
      await doneJob(db, jobId, composed.artifactId);
      return;
    }

    /**
     * 这一版是第几版（2026-11-10 owner 的第一次纠正）：CLI 那条路的**文件路径写在包里**，
     * 所以版本号必须在拼包之前算出来。以前包里写死 `evaluate.html`，agent 照做就是覆盖
     * 上一份材料，而库里照样多一行——库说「两版」、盘上只剩一份。
     *
     * 算在这里、不在请求里：worker 是另一个进程，包要在真正跑的那一刻才拼（用户可能在
     * 按下按钮之后又点了一次「重新生成」）。
     */
    const version = await nextArtifactVersion(
      db, job.requirement_id, Number(job.number), job.stage,
    );
    const pack = packFor(job.stage, {
      id: job.requirement_id,
      number: Number(job.number),
      title: job.title,
      type: job.type,
      requester: job.requester,
      prdUrl: job.prd_url,
      version,
    });

    // 命令按同一条解析顺序再取一次（worker 是另一个进程，不能信请求那一刻的结论）。
    // 走到这里还没有唯一一条命令，就不必花十分钟去试：直接说清楚缺什么。
    const resolution = await resolveGenerator(await generatorCommand(db));
    if (resolution.kind !== 'ready') {
      await failJob(db, jobId, resolution.kind === 'choose'
        ? '还没选生成器：在「生成」里选一个，按「测试并使用」'
        : '未检测到生成器：到「设置 · 项目 · 生成器」配置一条');
      return;
    }

    // 产物路径从包里来（包写死了它），跑之前先记一份快照。
    //
    // 两处 `adoptLegacyArtifact`：包让 agent 写到仓库内 `data/uemaster/...`，而产物根
    // 在仓库外（`store.ts` 的 `adoptLegacyArtifact` 解释为什么不能改包）。跑前收一次，
    // 是为了让 `before` 说的是「仓库外那份」的 mtime；跑后收一次，否则刚写好的文件
    // 还躺在仓库里，`snapshot` 会判定「文件没更新」——一次成功的生成被报成失败。
    const url = artifactUrlIn(pack);
    adoptLegacyArtifact(url);
    const file = artifactFile(url);
    const before = await snapshot(file);

    const result = await runGenerator(pack, {
      cwd: opts.cwd ?? REPO_ROOT,
      timeoutMs,
      command: resolution.command,
      file,
      before,
      // 同一个人的那把 key，交给 harness 的启动环境（见 `credentialFor`）。CLI 这条路上
      // 它通常已经是 null——配了三格就轮不到 CLI——但**不补**的代价是「有人撤掉三格之后
      // 生成突然开始要 shell 环境」，而那正是这次要修的那类「同一把 key 两条路两种答案」。
      credential: credentialFor(resolution.command, (await resolveProviderConfig(actor))?.apiKey ?? null),
    });

    if (!result.ok) {
      await failJob(db, jobId, result.error);
      return;
    }

    adoptLegacyArtifact(url);
    const after = await snapshot(file);
    if (after === null) {
      await failJob(db, jobId, `生成命令已结束，但产物文件不存在：data${result.url}`);
      return;
    }
    if (before !== null && after === before) {
      await failJob(db, jobId, `生成命令已结束，但产物文件没有更新：data${result.url}`);
      return;
    }

    // attachArtifact 会自己 stat 站内链接（没有文件就是 artifact_missing），写库、
    // 记事件——**不改需求状态**（2026-11-10 起：材料是产物，立项是另一个动作）。
    // 这里不重复第二套写入路径。
    const artifact = await attachArtifact(db, actor, {
      requirementId: job.requirement_id,
      stage: job.stage,
      url: result.url,
      inputHash,
    });
    await doneJob(db, jobId, artifact.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failJob(db, jobId, message);
  } finally {
    // 心跳必须在所有出口停掉（成功、失败、提前 return 都走 finally）：一个还在滴答的
    // 定时器会让「这条作业已经结束」与「它还在报到」同时为真——那正是回收判据最怕的
    // 自相矛盾。
    clearInterval(beat);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 界面要的那一次读取：这条作业现在怎么样了、成功了链接在哪。
 *
 * 非 uuid / 查不到都返回 null（与读模型对「不存在的需求」同一条口径）：这个字符串
 * 只可能来自页面状态或手改的请求，不值得为它抛一个领域错误。
 */
export async function jobStatus(db: Db, jobId: string): Promise<JobView | null> {
  if (!UUID.test(jobId)) return null;
  /**
   * 先收一次孤儿（2026-11-10）：**这一行就是修事故的那一处**。
   *
   * 抽屉每 2 秒问一次这条作业，而「问」是那条死行唯一的可疑之处——没有进程会替它
   * 写 done / failed。于是收回来的地方只能是读：这一句之后，一个 pid 已经不在的作业
   * 会以 `failed` + 「生成进程已退出（服务已重启或被终止），本次没有产出；可以直接重试」
   * 返回，抽屉那一行立刻从秒表变成一个失败 + 重试。
   *
   * 放在 `select` 之前而不是之后：下面那条查询（含两个子查询）只该读一次确定的行；
   * 先收再读，用户看到的就是收完之后的状态，不会出现「这一帧还在跑、下一帧失败了」
   * 这种两帧之间什么都没发生的跳变。
   */
  await healStaleJobs(db, { jobId });
  const res = await db.execute<{
    id: string; stage: Stage; status: JobStatus; error: string | null;
    url: string | null; created_at: string; finished_at: string | null;
    phase: string | null; attempt: number;
  }>(sql`
    select j.id, j.stage, j.status, j.error, j.created_at, j.finished_at, a.url,
           -- 最新一次尝试属于哪一段、走到第几次。两格子查询而不是再发一轮查询：
           -- 这条读取每 2 秒被抽屉问一次，往返次数比查询宽度贵。
           (select t.phase
              from uemaster_job_attempts t
             where t.job_id = j.id
             order by t.created_at desc, t.attempt desc, t.id desc
             limit 1) as phase,
           (select coalesce(max(t.attempt), 0)
              from uemaster_job_attempts t
             where t.job_id = j.id) as attempt
      from uemaster_jobs j
      left join uemaster_artifacts a on a.id = j.artifact_id
     where j.id = ${jobId}`);
  const row = res.rows[0];
  if (!row) return null;
  // 还在跑的作业**不**给整张清单（`readAttempts` 是一次额外查询）：那几分钟里抽屉要的
  // 是「现在在哪一步」，不是逐条历史——历史在失败之后才有地方显示。
  const attempts = row.status === 'running' ? [] : await readAttempts(db, jobId);
  return {
    id: row.id,
    stage: row.stage,
    status: row.status,
    error: row.error,
    url: row.url,
    createdAt: new Date(row.created_at).toISOString(),
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
    phase: (row.phase ?? null) as AttemptPhase | null,
    attempt: Number(row.attempt),
    attempts,
  };
}
