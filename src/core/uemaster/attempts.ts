import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { AttemptPhase, AttemptView } from './trace.js';

/**
 * `uemaster_job_attempts` 的读写口。
 *
 * 一张只增不改的诊断表：写进来的是「第几次、哪一阶段、问了多少字、答了多少字、
 * 为什么被拒、花了多久」，读出去的是抽屉里那几行。
 *
 * 两条口径：
 * 1. **留痕失败不能顶替真正的失败原因**。写入自己出错（作业行已不在、库抖一下）时
 *    吞掉异常：那段代码正在把「模型一直画不对」翻译成一句中文，把它换成一句
 *    `insert ... 违反外键` 是纯粹的降级。诊断是加分项，不是主路径。
 * 2. **没有作业就没有行**。`composeEvaluation` 在用例与脚本里也会被直接调用（不经过
 *    `uemaster_jobs`），那时 `jobId` 是 null，留痕整体跳过——不为了记录去编一个作业。
 */

/** 一次尝试要记的东西；`model` 由 `Trace` 补齐（同一个作业里通常不变）。 */
export type AttemptRecord = {
  attempt: number;
  phase: AttemptPhase;
  promptChars: number;
  outputChars: number;
  error: string | null;
  ms: number;
};

/** 图 / 页面 / 构建三条路共用的一支笔。`jobId === null` 时它什么也不做。 */
export type Trace = {
  jobId: string | null;
  model: string;
  write: (record: AttemptRecord) => Promise<void>;
};

/** 错误文本最多存这么长：它进的是界面上的一行，不是日志文件。 */
const ERROR_MAX = 2000;

/**
 * 造一支笔。
 *
 * 为什么 `model` 绑在笔上而不是每次传：一次作业里五次调用用的是**同一份**配置
 * （`resolveProviderConfig` 在 compose 开头解析一次），跟着每次调用传一遍只多一处
 * 可以写错的地方。
 */
export function makeTrace(db: Db, jobId: string | null, model: string): Trace {
  return {
    jobId,
    model,
    write: async (record) => {
      if (jobId === null) return;
      const error = record.error === null ? null : record.error.slice(0, ERROR_MAX);
      try {
        await db.execute(sql`
          insert into uemaster_job_attempts
            (job_id, attempt, phase, model, prompt_chars, output_chars, error, ms, created_at)
          values (${jobId}, ${record.attempt}, ${record.phase}, ${model},
                  ${record.promptChars}, ${record.outputChars}, ${error}, ${record.ms}, now())`);
      } catch {
        // 见文件头第 1 条：诊断写不进去，也不要把它变成用户的失败原因。
      }
    },
  };
}

type AttemptRow = {
  attempt: number;
  phase: string;
  model: string;
  prompt_chars: number;
  output_chars: number;
  error: string | null;
  ms: number;
};

/** 一条作业的全部尝试，按写入顺序（= 时间顺序，= 第几次）。 */
/**
 * 按 `created_at` 排序，不是 `id`。
 *
 * 高亮的原因不是洁癖：`id` 是 `gen_random_uuid()`，**无序**。按 id 排出来的清单会把
 * 「先被拒、后通过」写成「先通过、后被拒」——同一份数据，两种读法，而读者会按看到的
 * 顺序下结论。`created_at` 是微秒精度的插入时间，`attempt` 是同一毫秒内的兜底，
 * `id` 只是让完全相同的两行也有确定顺序。
 */
export async function readAttempts(db: Db, jobId: string): Promise<AttemptView[]> {
  const res = await db.execute<AttemptRow>(sql`
    select attempt, phase, model, prompt_chars, output_chars, error, ms
      from uemaster_job_attempts
     where job_id = ${jobId}
     order by created_at, attempt, id`);
  return res.rows.map((row) => ({
    attempt: Number(row.attempt),
    // phase 有 CHECK 守着三种值；读侧仍按字符串收，认不出的一行照样显示得出来。
    phase: row.phase as AttemptPhase,
    model: row.model,
    promptChars: Number(row.prompt_chars),
    outputChars: Number(row.output_chars),
    error: row.error,
    ms: Number(row.ms),
  }));
}
