import { getBoard } from '../src/core/read/board';
import { Board } from './components/Board';

/**
 * 需求看板。
 *
 * 数据一律走读模型（server component 直连 `src/core/read`，不经过 HTTP）：
 * `getBoard()` 不给 `me`，让它自己去 cookie 取当前成员——顶栏的成员切换与卡片的
 * 「需要你动」必须来自同一个 cookie、同一个解码函数，页面这里再传一次只会多一处可能分叉。
 *
 * 外层 `.view` 是外壳（layout 的 `.main` 里唯一的滚动容器）；`.board` 需要它给的确定高度，
 * 否则 `height:100%` 会连顶栏的 56px 一起算进去、底部被裁掉一截。
 */
export default async function BoardPage() {
  const columns = await getBoard();

  return (
    <main className="view">
      <Board columns={columns} />
    </main>
  );
}
