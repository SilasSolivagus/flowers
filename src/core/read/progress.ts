import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Stage } from '../uemaster/packs.js';
import type { AttemptPhase } from '../uemaster/trace.js';

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
  /** 那一段的中文：`正在读 PRD` / `正在画流程图` … */
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
 * 这一串是 `uemaster_job_attempts.phase` 的**唯一**中文出口（库里存的是英文标识符，
 * 界面上不能出现）。漏一档的表现是卡片上冒出 `locate` 这种串，一眼睛就能看出来。
 */
const PHASE_ZH: Record<AttemptPhase, string> = {
  flow: '正在画流程图',
  pages: '正在画线框页',
  build: '正在装配材料',
  locate: '正在找页面',
  verify: '正在复核',
  findings: '正在写问题清单',
};

/** 还一次尝试都没有时的说法：PRD 快照 / 图之前的准备。 */
const IDLE_PHASE = '正在读 PRD';

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
 * 卡片上那两格显示的时间：`00:47`。
 *
 * 超过一小时就写 `1:02:03`（一次生成被杀之前最多十分钟，这一支只是兜底）。
 * 负数（客户端时钟比服务端慢）夹到 0：显示 `-00:03` 只会让人以为系统坏了。
 */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}
