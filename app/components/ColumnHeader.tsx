import type { BoardColumn } from '../../src/core/read/board';
import { ExportQueueButton } from './ExportQueueButton';

/**
 * 列头：`<b>` 状态名 + 计数，外加**待排期**那一列多出来的「导出」（P1b）。
 *
 * 单独一个组件的理由只有一条：那个「导出」什么时候出现，是一个必须被用例钉住的
 * 判断。留在 `Board` 里就得为了测它渲染整块看板（而卡片是 `next/link`，在用例里
 * 起不来）；抽出来之后，用例渲染的就是这一格，断言的也正是页面上那一格。
 *
 * 出现的条件是**这一列真的有卡片**（`queue` 且 `cards.length > 0`），不是「列存在」：
 * 待排期每天都会被清空一次，而一个点下去只会说「没有可导出的行」的按钮，比没有按钮
 * 更糟——它把「这里现在没事可做」伪装成一个可以做的事。
 *
 * 其余部分与 P4 时一致：列头只有状态名与计数两样。同一列里的卡片等的东西并不相同
 * （「等 赵越 评审」和「等 吕正豪 评审」同列），任何一行写死在这一列上的说明都会说谎。
 */
export function ColumnHeader({ column }: { column: BoardColumn }) {
  return (
    <div className="colhd">
      <b>{column.label}</b>
      {column.state === 'queue' && column.cards.length > 0 && <ExportQueueButton />}
      <span className="pill2">{column.cards.length}</span>
    </div>
  );
}

export default ColumnHeader;
