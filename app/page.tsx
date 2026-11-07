import { db } from '../src/db/client';
import { getBoard } from '../src/core/read/board';
import { getRequirementDetail } from '../src/core/read/detail';
import { currentMember, listMembers } from '../src/core/read/member';
import { listReleases } from '../src/core/read/version';
import { generatorView } from '../src/core/uemaster/settings';
import { Board } from './components/Board';
import { Drawer } from './components/Drawer';
import { RequirementForm } from './components/RequirementForm';
import { Shell } from './components/Shell';

/**
 * 需求看板 + 抽屉。
 *
 * 数据一律走读模型（server component 直连 `src/core/read`，不经过 HTTP）：
 * `getBoard()` 不给 `me`，让它自己去 cookie 取当前成员——左轨底部的身份块与卡片的
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
}: {
  searchParams: Promise<{
    open?: string | string[] | undefined;
    edit?: string | string[] | undefined;
    new?: string | string[] | undefined;
  }>;
}) {
  const { open, edit, new: fresh } = await searchParams;
  const openId = typeof open === 'string' ? open : null;
  /**
   * 录入面的两个开合状态，与大抽屉同一条规矩：**住在 URL 里**（P4-02）。
   * - `?new=1`：从顶栏「新建需求」进来，看板背后还在；
   * - `?open=<id>&edit=1`：抽屉「描述」段的「编辑」。
   *
   * 刷新、发给别人、点后退都回到同一个状态；表单里的东西是服务端渲染的第一帧就有的
   * （编辑时是那条需求的当前描述），不是「先空后填」。
   */
  const creating = (typeof fresh === 'string' ? fresh : null) === '1';
  const editing = (typeof edit === 'string' ? edit : null) === '1';

  // 抽屉里那三行「生成」要知道**现在会跑哪条命令**（P2.7）：一条都没有时按钮禁用，
  // 多条时按下先开选择器。这件事只跟开着的抽屉有关，所以抽屉没开就不读——看板本身
  // 不需要知道生成器的存在。
  // `generator` 要问**当前成员**（P2.12）：他自己配了 key，抽屉里那三行「生成」的
  // 结论就得按他那一份算，而不是按平台的算。与 `getBoard()` 内部取的是同一个 cookie。
  const [columns, detail, actor] = await Promise.all([
    getBoard(),
    openId === null ? Promise.resolve(null) : getRequirementDetail(openId),
    currentMember(),
  ]);
  const generator = openId === null ? null : await generatorView(db, actor);

  // 名册只在需要开表单时查：负责人下拉是唯一需要它的地方（看板与抽屉都不需要）。
  const formOpen = creating || (openId !== null && editing);
  const members = formOpen ? await listMembers() : [];

  // 版本列表只给排期表单用：抽屉里没有「排期」这个动作时不查（版本页有自己的口径）。
  const releases = detail !== null && detail.actions.includes('schedule')
    ? (await listReleases()).map((release) => ({
      id: release.id,
      name: release.name,
      window: `${release.windowStartLabel ?? '—'} → ${release.releaseDateLabel ?? '—'}`,
    }))
    : [];

  return (
    <Shell>
      <main className="view">
      <Board columns={columns} />
      {/* key 是需求 id：从 A 的抽屉直接跳到 B 的抽屉（URL 导航）时，整块重新挂载，
          上一个动作留下的失败消息与表单值不会跟着漂到另一条需求上。 */}
      {detail !== null && generator !== null && (
        <Drawer key={detail.id} detail={detail} releases={releases} generator={generator} />
      )}
      {/* 新建：任何时候都能开（抽屉开着也开——它是一个独立的对话框，不是一个页面）。 */}
      {creating && (
        <RequirementForm
          mode="create"
          members={members}
          me={actor}
          closeHref="/"
        />
      )}
      {/* 编辑：抽屉的「编辑」，只改标题与六问（类型 / 提出人 / 负责人不在这张表上）。 */}
      {openId !== null && editing && detail !== null && (
        <RequirementForm
          mode="edit"
          members={members}
          me={actor}
          closeHref={`/?open=${detail.id}`}
          initial={{
            id: detail.id,
            number: detail.number,
            title: detail.title,
            type: detail.info.type,
            requester: detail.info.requester,
            ownerMemberId: null,
            description: detail.description,
          }}
        />
      )}
      </main>
    </Shell>
  );
}
