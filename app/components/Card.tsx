import Link from 'next/link';
import type { BoardCard } from '../../src/core/read/board';
import { V1_CLOSED_MARK } from '../../src/core/uemaster/features';
import { ClaimButton } from './ClaimButton';

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
 * - `mine` 是读模型判定的「现在需要你动手」，规则只写在 board.ts 一份：这里既不重算，
 *   也不假设它是 `owner === me`（负责人之外还有别的身份会被框），更不假设它的边界；
 *   读模型改口径时，本页零改动跟着走。
 *
 * 两个视觉信号都只用移植过来的类，不新增样式：
 * - `mine` → `.card.mine`（主色 0.5px 框 + 内侧 2px 主色条 + 4% 主色底）；
 * - `late` → `.w.neg`（正在等的那个日期已经过去了，用负向色，不是加红框——框已经属于 mine）。
 *
 * 卡片本身是一个链接（`/?open=<id>`），不是带 onClick 的 div：
 * - 抽屉的开合状态因此在 URL 里，刷新还在、能直接发给别人；
 * - 键盘和读屏用户拿到的是一个可聚焦的链接，名字就是卡片那三行文字。
 *   一个只挂了 onClick 的 div 对读屏用户等于不存在。
 * `data-id` 仍然留着：需求 id 是这张卡在页面上的身份，链接之外的用途（脚本、用例）也认它。
 *
 * `query` 是**当前筛选的查询串**（`q=…&owner=…`，不带 `?`，来自 `boardQuery`）。
 * 卡片链接把它原样带上：筛出 12 条之后点开第 3 条，抽屉里的事看完再关掉，回到的
 * 必须是那 12 条。不带的话「读一条需求」就等于把筛选丢掉——而「筛完再一条条读」
 * 正是这个功能唯一的使用姿势。
 */
export function Card({ card, query = '' }: { card: BoardCard; query?: string }) {
  const href = query === '' ? `/?open=${card.id}` : `/?open=${card.id}&${query}`;
  return (
    <Link className={card.mine ? 'card mine' : 'card'} href={href} data-id={card.id}>
      <span className="t">{card.title}</span>
      <div className={card.late ? 'w neg' : 'w'}>{card.waiting}</div>
      {/* v1 只承诺「收集」那一条链（进收集 → 点评估 → 出三栏材料）。别的状态照常显示、
          照常能点开，但必须让人先看见「这一版没开放」，否则他会以为功能坏了去查。
          文案只在 `features.ts` 一处（`V1_CLOSED_MARK`），抽屉里写的是同一句。 */}
      {card.v1Closed && <div className="v1">{V1_CLOSED_MARK}</div>}
      <div className="m">
        <span className="k">{requirementKey(card.number)}</span>
        {card.claimable
          // 无主的卡给一个「认领」：这一步原来只藏在抽屉里，而收集列正是最需要它的地方
          // （看到一条没人接的需求，第一反应是接，不是先打开再看）。
          ? <ClaimButton id={card.id} />
          : <span className="d">{card.days} 天</span>}
      </div>
    </Link>
  );
}

export default Card;
