import Link from 'next/link';

import { listReleases } from '../../src/core/read/version';
import { Gantt } from '../components/Gantt';
import './releases.css';

/**
 * 版本页（spec §9 第 2 条）：时间窗 + 甘特 + 进度（时间口径）。
 *
 * 数据全部来自 `listReleases()`：两个版本、每个版本的时间窗、在途/已上线/延期条数、
 * 以及甘特要的每一条需求的日期都在里面。页面不重算任何一条口径——「哪些需求算在这个
 * 版本里」「哪条延期」「时间已用几 %」都在读模型里，这里只排版。
 *
 * 选中哪个版本走 `?release=<id>` 而不是本地 state：刷新、分享链接、点后退都还在同一版；
 * 参数不指向任何版本（手改的 URL）时回到第一个版本，但**不改写地址**——URL 是用户的。
 */
export default async function ReleasesPage({
  searchParams,
}: { searchParams: Promise<{ release?: string | string[] | undefined }> }) {
  const releases = await listReleases();
  const { release } = await searchParams;
  const wanted = typeof release === 'string' ? release : null;
  const current = releases.find((r) => r.id === wanted) ?? releases[0] ?? null;

  return (
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
      </div>
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
    </main>
  );
}
