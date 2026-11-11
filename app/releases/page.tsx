import Link from 'next/link';

import { db } from '../../src/db/client';
import { listReleases, releasableRequirements } from '../../src/core/read/version';
import { previousRelease } from '../../src/core/releases/manage';
import { Gantt } from '../components/Gantt';
import { ReleaseForm } from '../components/ReleaseForm';
import { ReleasePlan } from '../components/ReleasePlan';
import './releases.css';
import { Shell } from '../components/Shell';

/**
 * 版本页（spec §9 第 2 条）：时间窗 + 甘特 + 进度（时间口径）。
 *
 * 数据全部来自 `listReleases()`：两个版本、每个版本的时间窗、在途/已上线/延期条数、
 * 以及甘特要的每一条需求的日期都在里面。页面不重算任何一条口径——「哪些需求算在这个
 * 版本里」「哪条延期」「时间已用几 %」都在读模型里，这里只排版。
 *
 * 选中哪个版本走 `?release=<id>` 而不是本地 state：刷新、分享链接、点后退都还在同一版；
 * 参数不指向任何版本（手改的 URL）时回到第一个版本，但**不改写地址**——URL 是用户的。
 *
 * P4-02 起这一页也是版本的录入面：`?new=1` 开「新建版本」，`?edit=1` 开「编辑版本」。
 * 两个状态同样住在 URL 里（与 `?release=`、看板的 `?open=` 同一条规矩）。表单顶端
 * 那行策略（「上一个版本：v1.4 11-01 → 11-15」）由服务端算：它要问库，而客户端
 * 只负责把用户敲的日期与它比一次（见 `ReleaseForm`）。
 */
export default async function ReleasesPage({
  searchParams,
}: {
  searchParams: Promise<{
    release?: string | string[] | undefined;
    new?: string | string[] | undefined;
    edit?: string | string[] | undefined;
  }>;
}) {
  const releases = await listReleases();
  // 「加需求」下拉的候选：待排期 + 有 PRD（与 schedule 那道门同一条口径）。
  const releasable = await releasableRequirements();
  const { release, new: fresh, edit } = await searchParams;
  const wanted = typeof release === 'string' ? release : null;
  const current = releases.find((r) => r.id === wanted) ?? releases[0] ?? null;

  const creating = (typeof fresh === 'string' ? fresh : null) === '1';
  const editing = (typeof edit === 'string' ? edit : null) === '1' && current !== null;

  /**
   * 表单要的「上一个版本」。
   *
   * - 新建：按**默认窗口**算（今天 → 两周后）。空着日期时那一行也该有内容——它是
   *   上下文，不是校验结果；用户改了日期，行内重叠警告会跟着变（客户端算）。
   * - 编辑：按**这一版**的发版日算，并排除它自己（否则「把这一版往后挪」会立刻得到
   *   一条与自身重叠的警告）。
   */
  const today = new Date();
  /** 相对今天加 n 天（只取日期那一段）。 */
  const addDays = (from: Date, n: number) => new Date(from.getTime() + n * 86_400_000)
    .toISOString().slice(0, 10);

  /**
   * 默认窗口：**接着上一版往后排**，而不是从今天起排。
   *
   * 为什么：今天是 11-06、上一版是 10-29 → 11-13 时，「今天起两周」正好压在上一版
   * 身上，一打开表单就顶着一行重叠警告——那不是用户的问题，是我们给的默认值不对。
   * 有上一版就从它的发版日**次日**起算，两周后发；没有版本才从今天起。
   */
  const tentativeEnd = addDays(today, 14);
  const previous = creating
    ? await previousRelease(db, new Date(tentativeEnd).toISOString())
    : null;
  const defaultStart = creating && previous !== null
    ? addDays(new Date(previous.releaseDate), 1)
    : addDays(today, 0);
  const defaultEnd = addDays(new Date(`${defaultStart}T00:00:00Z`), 14);
  const previousForEdit = editing && current !== null
    ? await previousRelease(db, current.releaseDate, current.id)
    : null;

  /**
   * 重叠判定的候选集：**全部活着的版本**（`listReleases` 已经过滤掉软删除的那些）。
   * 传整份清单而不是「服务端先挑好一条」：用户改日期时要当场重算，而每敲一个键往返
   * 一次服务端是不划算的——挑哪一条由 `pickOverlapping` 决定，两边同一个函数。
   */
  const candidates = releases.map((r) => ({
    id: r.id,
    name: r.name,
    windowStart: r.windowStart,
    releaseDate: r.releaseDate,
  }));

  return (
    <Shell>
      <main className="view pad vpage">
      <div className="vbar">
        <h2>版本</h2>
        <div className="vsw">
          {releases.map((r) => {
            const on = r.id === current?.id;
            return (
              <Link
                key={r.id}
                href={`/releases?release=${r.id}`}
                className={on ? 'btn sm primary' : 'btn sm'}
                aria-current={on ? 'page' : undefined}
              >
                {r.name}
              </Link>
            );
          })}
        </div>
        {current !== null && (
          <Link className="btn sm vedit" href={`/releases?release=${current.id}&edit=1`}>编辑</Link>
        )}
      </div>
      {current !== null && (
        <ReleasePlan
          releaseId={current.id}
          windowStart={current.windowStart.slice(0, 10)}
          releaseDate={current.releaseDate.slice(0, 10)}
          items={current.requirements.map((item) => ({
            id: item.id,
            number: item.number,
            title: item.title,
            stateLabel: item.stateLabel,
            commitTestAt: item.commitTestAt,
            commitDueAt: item.commitDueAt,
          }))}
          candidates={releasable}
        />
      )}

      {current !== null && (
        <div className="vver">
          <section className="panel">
            <div className="ph">甘特</div>
            <Gantt release={current} />
          </section>
          <div className="vside">
            <section className="panel">
              <div className="ph">时间窗</div>
              <dl className="kv">
                <dt>开始</dt><dd>{current.windowStartLabel ?? '—'}</dd>
                <dt>发版</dt><dd>{current.releaseDateLabel ?? '—'}</dd>
                <dt>在途</dt><dd>{current.inFlight} 条</dd>
                {/* 目标 / 备注在录入面里填，就在这里读（否则那两个框写进去没有出口）。 */}
                {current.goal !== null && (
                  <>
                    <dt>目标</dt><dd className="long">{current.goal}</dd>
                  </>
                )}
                {current.note !== null && (
                  <>
                    <dt>备注</dt><dd className="long">{current.note}</dd>
                  </>
                )}
              </dl>
            </section>
            <section className="panel">
              <div className="ph">进度</div>
              <div className="kpi">
                <b>{current.timeUsed === null ? '—' : `${current.timeUsed}%`}</b>
                <span>已用时间</span>
              </div>
              <div className="k3">
                <div><b>{current.requirements.length}</b>需求</div>
                <div><b>{current.late}</b>延期</div>
                <div><b>{current.shipped}</b>已上线</div>
              </div>
            </section>
          </div>
        </div>
      )}

      {creating && (
        <ReleaseForm
          mode="create"
          closeHref="/releases"
          previous={previous}
          candidates={candidates}
          defaults={{ windowStart: defaultStart, releaseDate: defaultEnd }}
        />
      )}
      {editing && current !== null && (
        <ReleaseForm
          mode="edit"
          closeHref={`/releases?release=${current.id}`}
          previous={previousForEdit}
          candidates={candidates}
          selfId={current.id}
          initial={{
            id: current.id,
            name: current.name,
            windowStart: current.windowStart,
            releaseDate: current.releaseDate,
            goal: current.goal,
            note: current.note,
          }}
        />
      )}
      </main>
    </Shell>
  );
}
