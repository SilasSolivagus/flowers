import type { BoardCard } from '../../src/core/read/board';

/**
 * 需求编号在界面上的写法：`PAN-` + 库里的 `number` 原值（`PAN-8`、`PAN-12`）。
 *
 * 不补零：`scripts/seed.ts` 的看板日志与 `prdUrl` 都用同一写法，抽屉（Task 4）、版本页
 * （Task 5）也要显示同一个 key，界面单独补成 `PAN-008` 只会让同一条需求在三个地方长得不一样。
 * 线稿的 `PAN-798` 是三位序列的形状，位数跟着真实数据走。
 */
export function requirementKey(number: number): string {
  return `PAN-${number}`;
}

/**
 * 看板卡片：标题 / 等谁 / 编号 + 停留天数。
 *
 * 三样东西全部来自读模型，卡片不再算任何东西：
 * - `waiting` 是 board.ts 逐状态（同状态里还逐人）给出的「卡在谁身上」，不在这里推；
 * - `days` 是上海日历天，已经取过整；
 * - `mine` 是「你是负责人，或你是被派单的评审人」，不是 `owner === me`（评审人不是负责人）。
 *
 * 两个视觉信号都只用移植过来的类，不新增样式：
 * - `mine` → `.card.mine`（主色 0.5px 框 + 内侧 2px 主色条 + 4% 主色底）；
 * - `late` → `.w.neg`（正在等的那个日期已经过去了，用负向色，不是加红框——框已经属于 mine）。
 *
 * `data-id` 是需求 id：Task 4 的抽屉要按它取详情，卡片是唯一的点击入口。
 */
export function Card({ card }: { card: BoardCard }) {
  return (
    <div className={card.mine ? 'card mine' : 'card'} data-id={card.id}>
      <span className="t">{card.title}</span>
      <div className={card.late ? 'w neg' : 'w'}>{card.waiting}</div>
      <div className="m">
        <span className="k">{requirementKey(card.number)}</span>
        <span className="d">{card.days} 天</span>
      </div>
    </div>
  );
}

export default Card;
