import { Fragment } from 'react';
import { SOURCE_OTHER } from '../../src/core/requirements/source';
import Link from 'next/link';
import type { GeneratorView } from '../../src/core/uemaster/candidates';
import type { Detail, DetailRef, DetailReview } from '../../src/core/read/detail';
import type { Member } from '../../src/core/read/member';
import { formatMonthDay } from '../../src/core/read/board';
import { DESCRIPTIVE_FIELDS } from '../../src/core/requirements/fields';
import { requirementKey } from './Card';
import { ActionBar, type ReleaseOption } from './ActionBar';
import { GenerateButton } from './GenerateButton';
import { AttachForm } from './AttachForm';
import { ClaimButton } from './ClaimButton';
import { OwnerPicker } from './OwnerPicker';

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

/**
 * 导出的理由只有一条：这一行「画链接还是画『文件已丢失』」是一个必须被用例钉住的
 * 判断（`tests/artifact-missing.test.tsx`），而整张抽屉带着 `next/link`，在用例进程里
 * 起不来。判据在这一格里，用例就渲染这一格。
 */
export function RefRow({
  item, id, number, generator, canEdit,
}: {
  item: DetailRef;
  id: string;
  number: number;
  generator: GeneratorView;
  /**
   * 这个人能不能在这条需求上写（P4-05）。生成与交回材料都是**写**：生成会落产物与
   * 事件，交回材料同样。owner 的规矩是「别人的需求只读」，所以没有 `edit` 时
   * 这两个按钮都不出现——不是禁用：一个灰掉的按钮仍然在说「这里有个能做的事」。
   */
  canEdit: boolean;
}) {
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
        {/* 链接只在**文件还在**时画。库里有行、磁盘上没文件（`filePresent: false`，
            2026-11-08 那次 `git clean -fdx` 就是这么把 `data/uemaster/` 整个删掉的）
            时画的是一个 404：链接看起来仍然可点，点开是「产物不存在」。
            `filePresent === null` 是站外链接——那不是我们的文件，照旧给链接。 */}
        {item.url !== null && item.filePresent !== false && (
          <span><a className="att" href={item.url} target="_blank" rel="noreferrer">{item.url}</a></span>
        )}
        {/* 「丢了」要连「怎么办」一起说：这一行右边的「生成」按钮就是那个办法，
            但没有 `edit` 的人看不到按钮，所以这句话里要带动作名。 */}
        {item.present && item.filePresent === false && (
          <span className="miss">文件已丢失，重新生成</span>
        )}
      </div>
      <div className="acts">
        {item.present && <span className="pill ok">{item.atLabel ?? '—'}</span>}
        {/* 新鲜度：**只有两个标签**，没有一句话解释（P4-02 的「labels only」）。
            它是算出来的（当前描述的指纹 vs 产物存下来的那一个），不是存下来的——
            所以改完描述保存回来，这一行自己就变了，不需要任何一次额外写入。 */}
        {/* 最新版也要有标记：只有「需求已更新」而反过来没有「最新」时，读者分不出
            「这份就是当前那版」和「这里少了一块」。两者是一对。 */}
        {item.present && item.freshness === 'fresh' && (
          <span className="pill ok">最新</span>
        )}
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
        {canEdit && (
          <>
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
          </>
        )}
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
  detail, releases, generator, owners,
}: {
  detail: Detail;
  releases: ReleaseOption[];
  generator: GeneratorView;
  /** 「改负责人」下拉的候选；没有转交权时是空数组。 */
  owners: Member[];
}) {
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
          {/* 抬头那一行：编号 · 类型类。Ruling 1 之后类型可能是空的，此时**整段不渲染**
              ——「PAN-7 · 未指定类」不是中文，而空值在信息表里还有一行（「类型：未指定」），
              抬头少一段不丢信息。 */}
          <div className="k">
            {requirementKey(detail.number)}
            {info.typeSuffix !== null && ` · ${info.typeSuffix}`}
          </div>
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
              {/* 负责人这一行是「改」的入口（P4-05），也是 P4-06 锚点的可见形态：
                  姓名后面跟着他的条线——谁能改这条需求，从这个括号就能读出来。
                  控件只在有转交权时挂出来，候选也由读模型筛过（超管全名册 / 条线负责人
                  只看本线）。没有负责人时这一行不是「—」：它写着「待接单」，并给出
                  「认领」——无主的需求必须有一个能变成有主的入口。 */}
              <dt>负责人</dt>
              <dd>
                {info.owner ?? '待接单'}
                {info.ownerLineLabel !== null && (
                  <span className="ownline">（{info.ownerLineLabel}）</span>
                )}
                {detail.permissions.reassignOwner && owners.length > 0 && (
                  <OwnerPicker id={detail.id} owner={info.owner} members={owners} />
                )}
                {info.owner === null && detail.permissions.claim && (
                  <ClaimButton id={detail.id} />
                )}
              </dd>
              {/* 类型（Ruling 1）：空值显示「未指定」。这一行**不隐藏**：与抬头相反，
                  信息表是一张字段表，「这一格没填」本身就是一条要说得清的事实。 */}
              <dt>类型</dt><dd>{info.typeLabel}</dd>
              {/* 来源（Ruling 3）：六类之一，空值「未标注」（与平台同字：这一格没标）。
                  「其他」的自述跟一条缩进的说明放在它下面，不占第二格字段。 */}
              <dt>来源</dt>
              <dd>
                {info.sourceLabel}
                {info.sourceNote !== null && info.source === SOURCE_OTHER && (
                  <span className="ownline">（{info.sourceNote}）</span>
                )}
              </dd>
              {/* 平台（P4-08）：信息段里的一行。**看板卡上没有它** —— 那张卡只有两行
                  （标题 / 等谁），一个九列的板再塞一行标签就把「一眼看出这段在等什么」
                  挤掉了；而平台是「这条需求是什么」的分类，打开抽屉才需要它。 */}
              <dt>平台</dt><dd>{info.platformsLabel}</dd>
              {/* 优先级（P4-09）：与平台同一层（分类属性），同一段。null 显示「未定」
                  而不是「—」：这一列的空值是一个真实的业务状态（还没定级），
                  而「—」在这个抽屉里表示「这条需求没有这一格」。 */}
              <dt>优先级</dt><dd>{info.priorityLabel}</dd>
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
              {/* 「编辑」与动作条同一个判据：`can('edit')`。没有它就没有这一格入口。 */}
              {detail.permissions.edit && (
                <Link className="btn sm ghost" href={`/?open=${detail.id}&edit=1`}>编辑</Link>
              )}
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
                canEdit={detail.permissions.edit}
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
