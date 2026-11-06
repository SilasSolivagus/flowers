import Link from 'next/link';
import type { CSSProperties } from 'react';

import { formatMonthDay } from '../../src/core/read/board';
import type { Release, ReleaseItem } from '../../src/core/read/version';
import { shanghaiDayOf } from '../../src/core/clock/tick';
import { requirementKey } from './Card';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 一个上海日号 → 那一日的「日」（'28' / '06'）。
 *
 * 「哪天」这条换算只在领域层写一遍（clock/tick.ts 的 shanghaiDayOf 给日号），这里
 * 只做它的逆：`day * DAY_MS` 那一瞬间是上海当天 08:00，所以读模型那个
 * formatMonthDay 折出来的日历日正是 day 本身——不另写一份 +08:00 的算术。
 */
function dayOfMonth(day: number): string {
  return formatMonthDay(new Date(day * DAY_MS).toISOString())?.slice(3) ?? '';
}

/**
 * 条的色档：延期 > 状态。
 *
 * 只返回**一个**类名，不叠 `pool neg`：globals.css 的 `.barx` 四档是按 dev/tst/neg/pool
 * 的顺序声明的，`.pool` 在最后——`class="barx pool neg"` 会渲染成灰色「在期」，
 * 延期条反而看不见。一个类名就从结构上没有这个排序陷阱。
 */
function barTone(item: ReleaseItem): string {
  if (item.late) return 'neg';
  switch (item.state) {
    case 'dev':
      return 'dev';
    case 'test':
      return 'tst';
    // ready（还没到开工日）与 live（已上线）都不是「在途」，用中性档。
    default:
      return 'pool';
  }
}

/**
 * 版本页的甘特：一行一条需求，一条一块。
 *
 * 横轴 = 版本时间窗里的**每一天**（`window_start` 到 `release_date`，两头都占一列），
 * 所以每条日期都落到某一列上，不需要「按周取整」那种会挪位的近似。列的日号来自
 * 读模型带来的两个边界（`windowStart` / `releaseDate`），页面不判断哪些需求算在这个
 * 版本里、哪条算延期——那些口径在 `listReleases()` 里。
 *
 * 条的几何（唯一的规则，写在这里也只写在这里）：
 * - 起点 = 开工日；提测日比开工日**晚**就用提测日（早于开工日没有意义：版本还没开）。
 *   缺提测日则退回开工日。
 * - 终点 = 承诺完成日，**含那一天**（占满整列）；同一天开始与完成 = 一列宽。
 * - 缺承诺完成日就没有条（不画一个不知道长度的东西），这一行仍然在，因为需求在版本里。
 * - 两个日期都夹到轴上：轴是被版本时间窗定义的，条不该把轴撑出去。
 *
 * 发版日的竖虚线画在**发版日那一列的左沿**：`release_date` 这个时刻就是发版日的
 * 00:00（库里是当天 08:00 上海），所以线左边是「发版前」，线右边是发版日当天。
 * 承诺完成日等于发版日的那条会压着线往右伸一列——那是真的：它的承诺就在发版日当天。
 *
 * 整个网格宽度 = 左栏 + 天数 × 最小日宽，窄屏进横向滚动（由 releases.css 的
 * `.gscroll` 负责），不压扁日期。日宽用 `minmax(日宽, 1fr)` 且容器有 min-width，
 * 两者一起保证「列永远等宽」——`.grel` 的 x 是按比例算的，列不等宽线就会歪。
 */
export function Gantt({ release }: { release: Release }) {
  const startDay = shanghaiDayOf(release.windowStart);
  const releaseDay = shanghaiDayOf(release.releaseDate);
  // 时间窗不合法（缺日期 / 发版早于开工）就没有轴可画。不抛错、不写一句说明：
  // 这是「这块显示不出来」，不是一条需求出了问题，页面其余两块照常。
  if (startDay === null || releaseDay === null || releaseDay < startDay) return null;

  const days = releaseDay - startDay + 1;
  const relIndex = releaseDay - startDay;
  const axis = Array.from({ length: days }, (_, i) => startDay + i);

  const rows = release.requirements.map((item) => {
    const test = item.commitTestAt === null ? null : shanghaiDayOf(item.commitTestAt);
    const due = item.commitDueAt === null ? null : shanghaiDayOf(item.commitDueAt);
    const from = Math.min(Math.max(test !== null && test > startDay ? test : startDay, startDay), releaseDay);
    const to = due === null ? null : Math.min(Math.max(due, startDay), releaseDay);
    // `from` 是**日号**，落格子要换成轴上的列偏移（第 0 列 = 开工日），再 +2 跳过左栏那一列。
    return { item, col: from - startDay, span: to === null ? 0 : Math.max(1, to - from + 1) };
  });

  return (
    <div className="gscroll" style={{ '--g-days': days } as CSSProperties}>
      <div className="ghead">
        <div className="lbl">需求</div>
        {axis.map((day) => (
          <div key={day} className={day === releaseDay ? 'wk rel' : 'wk'}>{dayOfMonth(day)}</div>
        ))}
      </div>
      <div className="gbody">
        <div className="glines" aria-hidden="true">
          {axis.map((day) => <span key={day} />)}
        </div>
        <div
          className="grel"
          aria-hidden="true"
          style={{ left: `calc(var(--g-gut) + (100% - var(--g-gut)) * ${relIndex / days})` }}
        />
        {rows.map(({ item, col, span }) => (
          <Link
            key={item.id}
            className="grow"
            href={`/?open=${item.id}`}
            title={`${item.stateLabel} · 提测 ${item.testAtLabel ?? '—'} · 承诺 ${item.dueAtLabel ?? '—'}`}
          >
            <span className="glbl">
              <span className="k">{requirementKey(item.number)}</span>
              <span className="t">{item.title}</span>
            </span>
            {span > 0 && (
              <div className={`barx ${barTone(item)}`} style={{ gridColumn: `${col + 2} / span ${span}` }}>
                {span >= 4 && <span>{item.dueAtLabel}</span>}
              </div>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}

export default Gantt;
