import { Fragment } from 'react';
import Link from 'next/link';
import type { GeneratorView } from '../../src/core/uemaster/candidates';
import type { Detail, DetailRef, DetailReview } from '../../src/core/read/detail';
import { formatMonthDay } from '../../src/core/read/board';
import { DESCRIPTIVE_FIELDS } from '../../src/core/requirements/fields';
import { requirementKey } from './Card';
import { ActionBar, type ReleaseOption } from './ActionBar';
import { GenerateButton } from './GenerateButton';
import { AttachForm } from './AttachForm';

/**
 * 需求抽屉：读模型那六段的直接渲染。
 *
 * 六段的顺序就是 `Detail` 里键的顺序（信息 / 承诺 / 参考 / 评审 / 记录 / 动作），
 * 页面不重排：谁先读哪一段是线稿评审时定的，而读模型已经按那个顺序返回。
 *
 * 三条来自评审的硬口径：
 * 1. **领域里没有的东西不画**。来源、影响面、业务线、描述这些字段在库里不存在，
 *    线稿那一版的 `dl` 里有它们，这里没有——不编、也不画一个空标签框。
 *   *    读模型的 `refs` 三处槽位（评估材料 / 评审材料 / 走查材料）**三行都渲染**：
 *    没有产物时那一行不是空槽位，而是一个「生成」按钮——P2.6 起 Flowers 自己把
 *    任务包喂给本机的 agent CLI，产物落回来这一行就变成链接；「还没生成」是一个入口，
 *    不是一行「—」。
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

function RefRow({
  item, id, number, generator,
}: { item: DetailRef; id: string; number: number; generator: GeneratorView }) {
  // 有产物：链接 + 那天的日期。没有产物：阶段名 + 「生成」。
  // 两条分支都不带一句解释——行上的东西就是全部说明（见文件头的第 3 条口径）。
  //
  // 两种进法都摆在这一行上，而且**两行都有**：
  // - 「生成」= 让我们自己跑（P2.6 的主路：服务端把任务包喂给本机 agent CLI，产物落回来）；
  // - 「交回材料」= 人走的那条路：材料在别处跑完了，从这里贴链接或传文件进来。
  // 有产物那一行也留着它们：重做一版是常态（库里同一 stage 允许多行，读侧取最新）。
  // `item.generation` 是「这个阶段正在跑」的那个作业：有它就从「生成中」开始，
  // 刷新 / 换人打开都读到同一个状态。
  return (
    // data-stage 是给「这一行是哪一处材料」一个稳定名字：生成按钮是异步的，
    // 走查 / 截图 / 将来的端到端用例都要能点中「评估材料那一行」，而不是按位置数。
    <div className="row3" data-stage={item.stage}>
      <div className="l">
        <b>{item.label}</b>
        {item.url !== null && (
          <span><a className="att" href={item.url} target="_blank" rel="noreferrer">{item.url}</a></span>
        )}
      </div>
      <div className="acts">
        {item.present && <span className="pill ok">{item.atLabel ?? '—'}</span>}
        {/* 新鲜度：**只有两个标签**，没有一句话解释（P4-02 的「labels only」）。
            它是算出来的（当前描述的指纹 vs 产物存下来的那一个），不是存下来的——
            所以改完描述保存回来，这一行自己就变了，不需要任何一次额外写入。 */}
        {item.present && item.freshness === 'stale' && (
          <span className="pill warn">需求已更新</span>
        )}
        {item.present && item.freshness === 'unknown' && (
          <span className="pill no">版本未知</span>
        )}
        {/* 「这是第几版」：同一 (需求, 阶段) 存过几行就是几版。`1` 不显示——
            每一行都挂一个「第 1 版」只是噪音，只有重做过之后它才是信息。 */}
        {item.present && item.versions > 1 && (
          <span className="pill no">第 {item.versions} 版</span>
        )}
        <GenerateButton
          requirementId={id}
          stage={item.stage}
          runningJobId={item.generation?.id ?? null}
          generator={generator}
          present={item.present}
          fresh={item.freshness === 'fresh'}
          versions={item.versions}
        />
        <AttachForm id={id} number={number} stage={item.stage} />
      </div>
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

export function Drawer({
  detail, releases, generator,
}: { detail: Detail; releases: ReleaseOption[]; generator: GeneratorView }) {
  const { info, commit, review, description } = detail;
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

          {/* ② 描述：六个问题（P4-02）。整段固定渲染——六问是「这条需求要做什么」，
              空着也是一种信息（它等于「没人写过」），所以空的行写 '—' 而不是消失；
              一列一列地藏起来，读的人就无法判断「这一问是没写，还是这一问不存在」。
              「编辑」只改标题与这六问（类型 / 提出人 / 负责人不在这张表上）。 */}
          <section className="dsec">
            <div className="sechd">
              <h3>描述</h3>
              <Link className="btn sm ghost" href={`/?open=${detail.id}&edit=1`}>编辑</Link>
            </div>
            <dl className="fields">
              {DESCRIPTIVE_FIELDS.map((field) => (
                // dt/dd 是这一层网格的**直接子元素**（`.fields` 是 grid）：套一个 div
                // 会把整段变成两个格子里的两行，`grid-column: 1 / -1` 也就不再生效。
                <Fragment key={field.key}>
                  <dt className="full">{field.label}</dt>
                  {/* 空着就只是一个「—」，**不带** `.desc` 那块浅底：
                      六块空灰盒子会把这一段的标题淹没，而「没写」这件事一个破折号
                      就说清楚了。有内容时才有那块底（它是段落，与标签不同层）。 */}
                  <dd className={description[field.key] === null ? 'full' : 'full desc'}>
                    {description[field.key] ?? '—'}
                  </dd>
                </Fragment>
              ))}
            </dl>
          </section>

          {/* ③ 承诺：没排期就整段不显示（spec §4「没排期则不显示」） */}
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
              有产物那一行是链接 + 日期，没有产物那一行是「生成」——P2.6 起材料由
              服务端自己跑生成器产出，所以「还没生成」是一个入口，不是空槽位。
              三行形状相同，读的人不用记哪一行特殊。 */}
          <section className="dsec">
            <h3>参考</h3>
            {refs.map((item) => (
              <RefRow
                key={item.stage}
                item={item}
                id={detail.id}
                number={detail.number}
                generator={generator}
              />
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
