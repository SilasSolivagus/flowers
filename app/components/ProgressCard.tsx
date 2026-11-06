'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { elapsedLabel } from '../../src/core/read/elapsed';
// 只取类型：`import type` 在编译后消失，`progress.ts` 里的 `db/client` 不会进包。
import type { JobProgress } from '../../src/core/read/progress';
import { runningJobsAction } from '../actions';
import { requirementKey } from './Card';

/**
 * 右下角的生成进度卡（P4-02）。
 *
 * 为什么是角落里一张卡、而不是一个遮罩：一次生成 2–3 分钟，owner 明确否决了「挡住
 * 整个界面」。那几分钟里人要接着看板、改别的需求、开会；进度只需要**在**那里，
 * 不需要**占据**那里。
 *
 * 三条信息来源与各自的节奏：
 * - **作业清单**（哪几条需求、哪个阶段）每 3 秒问一次服务端（`runningJobsAction`）。
 *   3 秒是「人不会盯着数秒」与「server action 不该当日志刷」之间的取值。
 * - **秒数**每秒本地跳（`tick`）。等服务端给秒数就意味着秒针要跟着网络抖，而这一格
 *   恰恰是「它还在动」的唯一证据。
 * - **要点进哪条需求**：整行是一个 `Link`（`/?open=<id>`），与看板卡片同一个入口。
 *
 * 折叠状态是**本地** state，不住 URL：它是「我现在想不想看它」，不是一条可分享的
 * 位置。刷新之后回到展开——一张卡而已，恢复默认不丢任何东西。
 *
 * 没有作业时整张卡不渲染（`null`）：一个「0 个生成中」的常驻框只是家具。
 */
export function ProgressCard({ initial }: { initial: JobProgress[] }) {
  const [jobs, setJobs] = useState<JobProgress[]>(initial);
  const [open, setOpen] = useState(true);
  /** 每秒自增一次，纯粹为了让秒数重新算（没有它，React 不会重渲染）。 */
  const [, setBeat] = useState(0);

  useEffect(() => {
    const beat = setInterval(() => setBeat((n) => n + 1), 1000);
    const poll = setInterval(() => {
      void runningJobsAction().then((next) => setJobs(next));
    }, 3000);
    return () => {
      clearInterval(beat);
      clearInterval(poll);
    };
  }, []);

  if (jobs.length === 0) return null;

  const elapsed = (job: JobProgress) => elapsedLabel(Date.now() - new Date(job.startedAt).getTime());
  const head = jobs.length === 1
    ? `${jobs[0]!.stageLabel} · ${elapsed(jobs[0]!)}`
    : `生成中 ${jobs.length}`;

  return (
    <aside className={open ? 'jobcard' : 'jobcard folded'} aria-label="生成进度">
      <button
        type="button"
        className="hd"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
      >
        <span>{head}</span>
        <span className="cv" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="rows">
          {jobs.map((job) => (
            <Link className="row" key={job.jobId} href={`/?open=${job.requirementId}`}>
              <b>{job.stageLabel} · {job.phaseLabel} · {elapsed(job)}</b>
              <span>
                <i className="k">{requirementKey(job.number)}</i>
                {job.title}
              </span>
            </Link>
          ))}
        </div>
      )}
    </aside>
  );
}

export default ProgressCard;
