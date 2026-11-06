import Link from 'next/link';
import type { Detail, DetailRef, DetailReview } from '../../src/core/read/detail';
import { formatMonthDay } from '../../src/core/read/board';
import { requirementKey } from './Card';
import { ActionBar, type ReleaseOption } from './ActionBar';
import { CopyPack } from './CopyPack';

/**
 * 需求抽屉：读模型那六段的直接渲染。
 *
 * 六段的顺序就是 `Detail` 里键的顺序（信息 / 承诺 / 参考 / 评审 / 记录 / 动作），
 * 页面不重排：谁先读哪一段是线稿评审时定的，而读模型已经按那个顺序返回。
 *
 * 三条来自评审的硬口径：
 * 1. **领域里没有的东西不画**。来源、影响面、业务线、描述这些字段在库里不存在，
 *    线稿那一版的 `dl` 里有它们，这里没有——不编、也不画一个空标签框。
 *    读模型的 `refs` 三处槽位（评估材料 / 评审材料 / 走查材料）**三行都渲染**：
 *    没有产物时那一行不是空槽位，而是一个「复制任务包」按钮——材料要靠用户自己的
 *    agent 生成（D1），所以「还没生成」这一态需要一个入口，而不是一行「—」。
 * 2. **没有承诺就不给承诺段**。没排期的需求 `commit` 全是 null，渲染一个只有
 *    「—」的承诺段等于告诉读者「这件事有个空承诺」。
 * 3. **一句解释性文案都没有**：段里只有字段名、值、和动作名。
 */

/** 事件的 actor：时钟写的是 `'system'`（见 clock/tick.ts），界面只有中文。 */
function actorLabel(actor: string): string {
  return actor === 'system' ? '系统' : actor;
}

/** 评审判决的 pill 颜色。待签是警告、通过是正向、打过回与作废是中性（那是记录，不是故障）。 */
const PILL: Record<string, string> = {
  handed: 'warn',
  passed: 'ok',
  rejected: 'no',
  voided: 'no',
};

function RefRow({ item, packId }: { item: DetailRef; packId: string }) {
  // 有产物：链接 + 那天的日期。没有产物：阶段名 + 「复制任务包」。
  // 两条分支都不带一句解释——行上的东西就是全部说明（见文件头的第 3 条口径）。
  return (
    <div className="row3">
      <div className="l">
        <b>{item.label}</b>
        {item.url !== null && (
          <span><a className="att" href={item.url} target="_blank" rel="noreferrer">{item.url}</a></span>
        )}
      </div>
      {item.present
        ? <span className="pill ok">{item.atLabel ?? '—'}</span>
        : <CopyPack packId={packId} />}
      {/* 任务包正文：服务端渲染好的那段中文，就在这里。按钮复制的是这个节点的
          textContent——没有第二个数据源，也没有客户端请求。hidden 只是不画出来，
          文本仍然是页面 DOM 的一部分（读屏也不会念这三十行）。放在 .row3 里面是为了
          不打断 CSS 的 `.row3:last-child`（参考段最后一行不该有下边框）。 */}
      <pre hidden id={packId}>{item.pack}</pre>
    </div>
  );
}

function ReviewRow({ review }: { review: DetailReview }) {
  return (
    <div className="row3">
      <div className="l">
        <b>{review.line} · {review.reviewer}</b>
        {review.reason !== null && <span>{review.reason}</span>}
      </div>
      <span className={`pill ${PILL[review.verdict] ?? 'no'}`}>
        {review.decidedAtLabel !== null ? `${review.decidedAtLabel} ` : ''}{review.verdictLabel}
      </span>
    </div>
  );
}

export function Drawer({ detail, releases }: { detail: Detail; releases: ReleaseOption[] }) {
  const { info, commit, review } = detail;
  // 三行固定槽位，全部渲染（顺序由读模型给：评估 / 评审 / 走查）。
  const refs = detail.refs;
  const scheduled = commit.release !== null || commit.testAt !== null || commit.dueAt !== null;

  return (
    <>
      {/* 遮罩就是「点空白处关闭」（线稿的 scrim 行为）。它是一块盖住看板的区域，
          不做成可聚焦的链接：键盘用户的关闭入口只有右上角那个 ✕（tabIndex -1
          让它不进 tab 序列，避免同一个动作出现两个停靠点）。 */}
      <Link className="scrim on" href="/" aria-label="关闭" tabIndex={-1} />
      <aside className="drawer on" aria-label="需求详情">
        <div className="dh">
          <div className="k">{requirementKey(detail.number)} · {info.typeLabel}类</div>
          <h2>{detail.title}</h2>
          <div className="row">
            <span className="chip">{detail.stateLabel}</span>
            {info.owner !== null && <span className="chip">{info.owner}</span>}
            {commit.release !== null && <span className="chip">{commit.release.name}</span>}
            <span className="chip">停了 {detail.days} 天</span>
          </div>
          <Link className="x" href="/" aria-label="关闭">✕</Link>
        </div>

        <div className="dbody">
          {/* ① 信息 */}
          <section className="dsec">
            <h3>信息</h3>
            <dl className="fields">
              <dt>提出人</dt><dd>{info.requester ?? '—'}</dd>
              <dt>负责人</dt><dd>{info.owner ?? '—'}</dd>
              <dt>类型</dt><dd>{info.typeLabel}</dd>
              <dt>进入本状态</dt><dd>{formatMonthDay(info.stateEnteredAt) ?? '—'}</dd>
              {info.prdUrl !== null && (
                <>
                  <dt className="full">PRD 链接</dt>
                  <dd className="full">
                    <a className="att" href={info.prdUrl} target="_blank" rel="noreferrer">
                      {info.prdUrl}
                    </a>
                  </dd>
                </>
              )}
              {info.skipReason !== null && (
                <>
                  <dt className="full">跳过评估</dt>
                  <dd className="full">{info.skipReason}</dd>
                </>
              )}
            </dl>
          </section>

          {/* ② 承诺：没排期就整段不显示（spec §4「没排期则不显示」） */}
          {scheduled && (
            <section className="dsec">
              <h3>承诺</h3>
              <dl className="fields">
                <dt>版本</dt><dd>{commit.release?.name ?? '—'}</dd>
                <dt>提测日</dt><dd>{commit.testAtLabel ?? '—'}</dd>
                <dt>承诺完成日</dt><dd>{commit.dueAtLabel ?? '—'}</dd>
              </dl>
              {commit.timeUsed !== null && (
                <div className="timeline">
                  <span>{formatMonthDay(commit.timeUsed.from) ?? '—'}</span>
                  <div className="bar">
                    <i style={{ width: `${commit.timeUsed.percent}%` }} />
                  </div>
                  <span>{formatMonthDay(commit.timeUsed.to) ?? '—'}</span>
                  <b>时间已用 {commit.timeUsed.percent}%</b>
                </div>
              )}
            </section>
          )}

          {/* ③ 参考：三行固定槽位，三行都渲染（P2 Task 4 起）。
              有产物那一行是链接 + 日期，没有产物那一行是「复制任务包」——评估 / 评审 /
              走查三种材料现在都只能靠用户自己的 agent 生成（D1），所以「还没生成」不再
              是一个空槽位，而是这一阶段的入口。三行形状相同，读的人不用记哪一行特殊。 */}
          <section className="dsec">
            <h3>参考</h3>
            {refs.map((item) => (
              <RefRow key={item.stage} item={item} packId={`pack-${detail.id}-${item.stage}`} />
            ))}
          </section>

          {/* ④ 评审：还没派单（评审前）就没有这一段 */}
          {review !== null && (
            <section className="dsec">
              <h3>评审</h3>
              <ReviewRow review={review} />
            </section>
          )}

          {/* ⑤ 记录：事件流本身，最新的在最下面（seq 升序，读模型定的）。
              与其余几段同一条规矩：一次事件都没有就不画这一段的标题——
              一个空的「记录」框只是家具。 */}
          {detail.events.length > 0 && (
            <section className="dsec">
              <h3>记录</h3>
              {detail.events.map((event) => (
                <div className="rec" key={event.seq}>
                  <span className="t">{event.dateLabel}</span>
                  <span>
                    {actorLabel(event.actor)} {event.label}
                    {event.note !== null ? ` · ${event.note}` : ''}
                  </span>
                </div>
              ))}
            </section>
          )}
        </div>

        {/* ⑥ 动作：只显示当前状态合法的那些；已拒绝这种终态没有动作，就不渲染动作条 */}
        {detail.actions.length > 0 && (
          <ActionBar id={detail.id} actions={detail.actions} releases={releases} />
        )}
      </aside>
    </>
  );
}

export default Drawer;
