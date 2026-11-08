import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { asText, parseRequirementId, requirePlainObject } from '../validate.js';
import { resolveMirrorConfig } from '../codemirror/mirror.js';
import { fingerprintOfRow } from '../requirements/fingerprint.js';
import { attachArtifact } from './attach.js';
import { readAttempts } from './attempts.js';
import { composeEvaluation } from './compose.js';
import { REVIEW_NEEDS_PRD, reviewRequirement } from './review.js';
import { inspect as inspectMaterial } from './inspect.js';
import { artifactUrlIn, resolveGenerator, runGenerator } from './generator.js';
import { isStage, packFor, type Stage } from './packs.js';
import { resolveProviderConfig, type ProviderConfig } from './provider.js';
import { generatorCommand } from './settings.js';
import { adoptLegacyArtifact, artifactFile } from './store.js';
import type { AttemptView } from './trace.js';

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

export type JobStatus = 'running' | 'done' | 'failed';

export type JobView = {
  id: string;
  stage: Stage;
  status: JobStatus;
  error: string | null;
  url: string | null;
  createdAt: string;
  finishedAt: string | null;
  /**
   * 这一次作业留下的每一次尝试（P2.13），按发生顺序。
   *
   * 为什么挂在 `JobView` 上而不是另开一个 action：抽屉拿到「失败了」的那一刻，紧接着
   * 就要那块「详情」；分成两次往返，中间那一帧就是「有一句失败原因、点开详情是空的」。
   * 还在跑的作业给空数组（那时留痕没意义，还会让每次轮询多一次查询）。
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
 * 陈旧回收放在「拒绝」之前：一条超过 `STALE_RUNNING_MS` 的 running 是死进程留下的，
 * 把它收成 failed 再放行，用户不必等下一次重启。
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
    const found = await tx.execute<{ id: string; prd_url: string | null }>(
      sql`select id, prd_url from requirements
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

    const running = await tx.execute<{ id: string; created_at: Date }>(sql`
      select id, created_at
        from uemaster_jobs
       where requirement_id = ${requirementId} and stage = ${stage} and status = 'running'
       order by created_at desc, id desc
       limit 1`);
    const current = running.rows[0];

    if (current) {
      const age = Date.now() - new Date(current.created_at).getTime();
      if (age < STALE_RUNNING_MS) {
        throw new AppError('generation_running', '这个阶段正在生成中，等这次结束再试');
      }
      await tx.execute(sql`
        update uemaster_jobs
           set status = 'failed', error = '生成超时：后台进程没有回报', finished_at = now()
         where id = ${current.id} and status = 'running'`);
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
    spawnWorker(db, jobId, actor);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failJob(db, jobId, message);
    throw new AppError('generator_unavailable', message);
  }

  return { jobId };
}

/**
 * 把 worker 甩出去：detached + 三路 ignore + unref。
 *
 * 三个 flag 各自解决一件事：
 * - `detached: true`：worker 自成一个会话/进程组，请求结束（甚至 Next 重启）不会把它带走。
 * - `stdio: 'ignore'`：它的输出没有读者。让管道连着父进程，父进程一退出就会 EPIPE。
 * - `unref()`：父进程的事件循环不再为它保活——请求该多快返回就多快返回。
 *
 * 为什么用 `node + tsx` 跑 `.ts` 而不是编译出一份 `.js`：仓库里没有「worker 单独构建」
 * 这一步（`next build` 只产出 Next 的 bundle），而 tsx 已经是 devDependency、被
 * `npm run seed` / `demo` 天天用。找不到 tsx 时**不静默**：抛中文错误，作业收成 failed。
 */
function spawnWorker(db: Db, jobId: string, actor: string): void {
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
      });
      await doneJob(db, jobId, composed.artifactId);
      return;
    }

    const pack = packFor(job.stage, {
      id: job.requirement_id,
      number: Number(job.number),
      title: job.title,
      type: job.type,
      requester: job.requester,
      prdUrl: job.prd_url,
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

    // attachArtifact 会自己 stat 站内链接（没有文件就是 artifact_missing），
    // 写库、记事件、必要时把 inbox 推到待设计——这里不重复第二套写入路径。
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
  const res = await db.execute<{
    id: string; stage: Stage; status: JobStatus; error: string | null;
    url: string | null; created_at: string; finished_at: string | null;
  }>(sql`
    select j.id, j.stage, j.status, j.error, j.created_at, j.finished_at, a.url
      from uemaster_jobs j
      left join uemaster_artifacts a on a.id = j.artifact_id
     where j.id = ${jobId}`);
  const row = res.rows[0];
  if (!row) return null;
  // 还在跑的作业没有「详情」可看，给空数组：这一条轮询每 1.5 秒一次，不为了一个
  // 不存在的答案多查一次。
  const attempts = row.status === 'running' ? [] : await readAttempts(db, jobId);
  return {
    id: row.id,
    stage: row.stage,
    status: row.status,
    error: row.error,
    url: row.url,
    createdAt: new Date(row.created_at).toISOString(),
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
    attempts,
  };
}
