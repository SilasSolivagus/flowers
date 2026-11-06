import { getBoard } from '../src/core/read/board';
import { getRequirementDetail } from '../src/core/read/detail';
import { listReleases } from '../src/core/read/version';
import { Board } from './components/Board';
import { Drawer } from './components/Drawer';

/**
 * 需求看板 + 抽屉。
 *
 * 数据一律走读模型（server component 直连 `src/core/read`，不经过 HTTP）：
 * `getBoard()` 不给 `me`，让它自己去 cookie 取当前成员——顶栏的成员切换与卡片的
 * 「需要你动」必须来自同一个 cookie、同一个解码函数，页面这里再传一次只会多一处可能分叉。
 *
 * `?open=<id>` 是抽屉的开合状态，所以它也必须走同一个读模型：抽屉里六段与动作条
 * 只能有一个数据源。刷新、分享链接、点浏览器后退都回到同一张抽屉；`?open=` 指向
 * 一条不存在的需求（手改的 URL / 点坏的链接）时读模型返回 null，页面只是一块看板。
 *
 * 外层 `.view` 是外壳（layout 的 `.main` 里唯一的滚动容器）；`.board` 需要它给的确定高度，
 * 否则 `height:100%` 会连顶栏的 56px 一起算进去、底部被裁掉一截。
 */
export default async function BoardPage({
  searchParams,
}: { searchParams: Promise<{ open?: string | string[] | undefined }> }) {
  const { open } = await searchParams;
  const openId = typeof open === 'string' ? open : null;

  const [columns, detail] = await Promise.all([
    getBoard(),
    openId === null ? Promise.resolve(null) : getRequirementDetail(openId),
  ]);

  // 版本列表只给排期表单用：抽屉里没有「排期」这个动作时不查（版本页有自己的口径）。
  const releases = detail !== null && detail.actions.includes('schedule')
    ? (await listReleases()).map((release) => ({
      id: release.id,
      name: release.name,
      window: `${release.windowStartLabel ?? '—'} → ${release.releaseDateLabel ?? '—'}`,
    }))
    : [];

  return (
    <main className="view">
      <Board columns={columns} />
      {detail !== null && <Drawer detail={detail} releases={releases} />}
    </main>
  );
}
