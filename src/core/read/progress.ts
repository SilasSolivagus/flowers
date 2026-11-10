import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Stage } from '../uemaster/packs.js';
import type { AttemptPhase } from '../uemaster/trace.js';
import { IDLE_PHASE_LABEL, PHASE_LABEL } from '../uemaster/phases.js';

/**
 * 生成进度（P4-02）：界面上那张角落卡片的数据源。
 *
 * 为什么需要它：一次生成要跑 2–3 分钟，而 owner 明确否决了「全局遮罩」——遮住整块
 * 界面是错的，那几分钟里人还要干别的。于是进度必须能从**别处**读到：右下角一张
 * 可折叠的卡片，写清「哪条需求、哪一段、跑了多久」，点一下进那条需求的抽屉。
 *
 * 数据全部已经存在库里（这是 P4-02 不新增任何作业表的原因）：
 * - `uemaster_jobs`：哪个阶段在跑、什么时候开始的；
 * - `uemaster_job_attempts`：跑到哪一步了（`phase`，六档）。
 * 「跑了多久」不存：它由 `createdAt` 与**客户端时钟**算，服务端每三秒才被问一次，
 * 秒数必须是本地跳的。
 *
 * 三条口径：
 * 1. **只给 running**。done / failed 是历史：成功会变成产物链接（抽屉已经显示），
 *    失败是行内的一次性提示（`GenerateButton`）。角落里只留「现在在跑什么」。
 * 2. **软删除的需求不出现**（`requirements.deleted_at is null`）：那张卡点进去会
 *    404，留着它只会让「进度」这件事看起来永远没结束。
 * 3. 最新一次尝试用 `distinct on` 的等价写法（相关子查询 + `order by created_at desc`）
 *    ——与 `listArtifacts` 取「每个 stage 最新一行」是同一种定序，两处不会各说各的。
 */
export type JobProgress = {
  jobId: string;
  requirementId: string;
  number: number;
  title: string;
  stage: Stage;
  /** `评估中` / `评审中` / `走查中`。 */
  stageLabel: string;
  /** 最新一次尝试属于哪一段；`null` = 还一次都没问模型（在读 PRD / 准备输入）。 */
  phase: AttemptPhase | null;
  /** 那一段的中文：`正在读 PRD` / `正在按六问拆流程` …（表在 `uemaster/phases.ts`） */
  phaseLabel: string;
  /** 作业开始的时刻（ISO）。客户端用它算「00:47」。 */
  startedAt: string;
};

/**
 * 阶段 → 卡片上那个词。
 *
 * 与抽屉「参考」段的三行同名同义（评估 / 评审 / 走查），只是多了进行时。写死成表
 * 而不是从 `attached` 的事件名推：事件名是过去式（「提交评估材料」），卡片要说的是
 * 「现在在干什么」。
 */
const STAGE_ZH: Record<Stage, string> = {
  evaluate: '评估中',
  review: '评审中',
  inspect: '走查中',
};

/**
 * 六档 phase → 一句人话。
 *
 * **这张表搬到了 `uemaster/phases.ts`**（2026-11-10）：抽屉里「生成中」那一行现在也要
 * 显示同一句话，而它是客户端组件——把表留在这里，那句映射会连着 `pg` 一起进浏览器包。
 * 这里只做转手：进度卡与抽屉说的必须是同一句，所以只有一个来源。
 */
const PHASE_ZH = PHASE_LABEL;

/** 还一次尝试都没有时的说法：PRD 快照 / 图之前的准备。 */
const IDLE_PHASE = IDLE_PHASE_LABEL;

type Row = {
  job_id: string;
  requirement_id: string;
  number: number;
  title: string;
  stage: string;
  created_at: string;
  phase: string | null;
};

/**
 * 全部在跑的作业，最新的在前。
 *
 * 为什么不分页 / 不限条数：同一个人同一个团队同时在跑三次生成已经是上限（每个阶段
 * 一条部分唯一索引还在挡着），卡片最多三行；给一张永远只有三行的表加 `limit` 只会
 * 让「还有一个在跑」这件事可能被藏起来。
 */
export async function listRunningJobs(): Promise<JobProgress[]> {
  const res = await db.execute<Row>(sql`
    select j.id as job_id, j.requirement_id, j.stage, j.created_at,
           r.number, r.title,
           (select a.phase
              from uemaster_job_attempts a
             where a.job_id = j.id
             order by a.created_at desc, a.attempt desc, a.id desc
             limit 1) as phase
      from uemaster_jobs j
      join requirements r on r.id = j.requirement_id
     where j.status = 'running' and r.deleted_at is null
     order by j.created_at desc, j.id desc`);

  return res.rows.map((row) => {
    const stage = row.stage as Stage;
    const phase = (row.phase ?? null) as AttemptPhase | null;
    return {
      jobId: row.job_id,
      requirementId: row.requirement_id,
      number: Number(row.number),
      title: row.title,
      stage,
      stageLabel: STAGE_ZH[stage] ?? '生成中',
      phase,
      phaseLabel: phase === null ? IDLE_PHASE : (PHASE_ZH[phase] ?? IDLE_PHASE),
      startedAt: new Date(row.created_at).toISOString(),
    };
  });
}

/**
 * 时间那一格（`00:47`）住在 `elapsed.ts`：它是**零依赖**的，客户端卡片直接 import
 * 它；这个文件连着 `db/client`，进不了浏览器包。这里再导出一次，服务端代码仍然能
 * 从一个入口拿到两样东西。
 */
export { elapsedLabel } from './elapsed.js';
