import type { BoardView } from '../../src/core/read/board';
import { boardQuery, isFiltered, type BoardFilter } from '../../src/core/read/board-filter';
import { BoardFilterBar } from './BoardFilterBar';
import { BoardScroller } from './BoardScroller';
import { Card } from './Card';
import { ColumnHeader } from './ColumnHeader';

/**
 * 看板：10 列 = 10 个状态，列序由读模型的 `BOARD_STATES` 决定，这里不再排。
 *
 * 结构照定稿线稿（gate-console/views.html 的看板区）：
 *   .board > (.fbar + .gcols > .col > (.colhd + .colbody > .card))
 *
 * `.gcols` 是那个 10 列网格（`.board` 本身是纵向 flex，只负责外边距与滚动）。
 * 唯一没有照搬的是 `.gband`（线稿里 11 个状态上方的「分析 / 开发 / 归档」分组带）：
 * 分组既不在读模型里，也不是状态机的概念，硬编一份会在下一版状态变更时变成谎言；
 * 而且列头只允许「状态名 + 数字」，多一行分组就是多一行解释。
 *
 * 列头只有状态名 + `.pill2` 计数（待排期那一列在两者之间多一个「导出」，P1b）。
 * 没有副标题、没有提示行——同一列里的卡片等的东西并不相同（「等 赵越 评审」和
 * 「等 吕正豪 评审」同列），任何一行写死在这一列上的说明都会说谎。
 *
 * `.board` 是 `BoardScroller`（客户端组件）：横向滚动容器在它身上，而只有客户端
 * 才能挂一个 `{passive:false}` 的 wheel 监听器（鼠标纵向滚轮 → 板子横向滚）。
 *
 * ## 筛选工具条（`?q=` / `?owner=`）
 *
 * 它是 `.board` 的第一个子元素、在 `.gcols` 之上：板子横向滚 2272px 的时候工具条
 * 用 `position:sticky;left:0` 钉在左边（`.fbar` 的 CSS），不跟着卡片一起滚走。
 *
 * 十列**永远全部渲染**，哪怕筛完是 0 条：列头计数就是筛后的数，某列变成 0 时列还在、
 * 写着 0。按结果增删列会让看板每筛一次就换一个形状——「收集列还在，只是现在空的」
 * 本身就是信息。
 *
 * 每张卡的链接带上当前筛选（`?open=<id>&q=…&owner=…`）：筛出 12 条、点开一条、
 * 关掉抽屉，回到的必须是那 12 条，不是 815 条。所以这一层把 `boardQuery()` 交给
 * `Card`，抽屉的关闭地址在页面里按同一份 query 拼（见 `app/page.tsx`）。
 */
export function Board({
  view, filter, members,
}: {
  view: BoardView;
  filter: BoardFilter;
  members: ReadonlyArray<{ id: string; name: string }>;
}) {
  const query = boardQuery(filter);
  return (
    <BoardScroller>
      <BoardFilterBar
        q={filter.q}
        owner={filter.owner}
        scope={filter.scope}
        members={members}
        shown={view.shown}
        total={view.total}
        filtered={isFiltered(filter)}
      />
      <div className="gcols">
        {view.columns.map((column) => (
          <div className="col" key={column.state}>
            {/* 列头抽成组件（P1b）：待排期那一列的「导出」出现在哪里、什么条件下
                出现，只写在 `ColumnHeader` 里一处，用例渲染的也是那一处。 */}
            <ColumnHeader column={column} />
            <div className="colbody">
              {column.cards.map((card) => (
                <Card key={card.id} card={card} query={query} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </BoardScroller>
  );
}

export default Board;
