import type { BoardColumn } from '../../src/core/read/board';
import { Card } from './Card';

/**
 * 看板：10 列 = 10 个状态，列序由读模型的 `BOARD_STATES` 决定，这里不再排。
 *
 * 结构照定稿线稿（gate-console/views.html 的看板区）：
 *   .board > .gcols > .col > (.colhd + .colbody > .card)
 *
 * `.gcols` 是那个 10 列网格（`.board` 本身是纵向 flex，只负责外边距与滚动）。
 * 唯一没有照搬的是 `.gband`（线稿里 11 个状态上方的「分析 / 开发 / 归档」分组带）：
 * 分组既不在读模型里，也不是状态机的概念，硬编一份会在下一版状态变更时变成谎言；
 * 而且列头只允许「状态名 + 数字」，多一行分组就是多一行解释。
 *
 * 列头也只有这两样：`<b>` 状态名 + `.pill2` 计数。没有副标题、没有提示行——
 * 同一列里的卡片等的东西并不相同（「等 赵越 评审」和「等 吕正豪 评审」同列），
 * 任何一行写死在这一列上的说明都会说谎。
 */
export function Board({ columns }: { columns: BoardColumn[] }) {
  return (
    <div className="board">
      <div className="gcols">
        {columns.map((column) => (
          <div className="col" key={column.state}>
            <div className="colhd">
              <b>{column.label}</b>
              <span className="pill2">{column.cards.length}</span>
            </div>
            <div className="colbody">
              {column.cards.map((card) => (
                <Card key={card.id} card={card} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default Board;
