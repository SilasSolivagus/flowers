import { db } from '../src/db/client';
import { readBoard } from '../src/core/read/board';
import { boardQuery, parseBoardFilter } from '../src/core/read/board-filter';
import { getRequirementDetail } from '../src/core/read/detail';
import { requireSession, withSession } from './session-guard';
import { currentMemberRow, listMembers, ownerCandidates } from '../src/core/read/member';
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
 *
 * `?q=` / `?owner=` 是看板的筛选（P4-13），和 `?open=` 同一条规矩：**URL 就是状态**。
 * 解析交给 `parseBoardFilter`（纯函数，认不出的一律退回「不筛」，手改的 URL 不会 500），
 * 过滤本身在 `readBoard` 那条 SQL 的 where 里做——页面这一层既不数卡片也不过一遍行。
 */
export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{
    open?: string | string[] | undefined;
    edit?: string | string[] | undefined;
    new?: string | string[] | undefined;
    q?: string | string[] | undefined;
    owner?: string | string[] | undefined;
  }>;
}) {
  const { open, edit, new: fresh, q, owner } = await searchParams;
  const openId = typeof open === 'string' ? open : null;
  /**
   * 筛选：两个查询参数 → 一份纯值。`parseBoardFilter` 对同名参数取第一个、
   * 认不出的 owner 退回 `all`（见 `src/core/read/board-filter.ts`）。
   */
  const filter = parseBoardFilter({ q, owner });
  /** 卡片链接与抽屉关闭地址共用的那串筛选（空串 = 没筛，URL 保持干净的 `/`）。 */
  const query = boardQuery(filter);
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
  // 先过门再取数：page 与 layout 并行渲染，Shell 那道 redirect 拦不住这里的取数。
  await requireSession();
  // 名册与看板一起取：工具条的负责人下拉**常驻**（不再是「只在开表单时查」），
  // 它列的就是这张名册，与录入表单里的那个下拉是同一份数据。
  const [view, viewer, members] = await withSession(
    () => Promise.all([readBoard(undefined, filter), currentMemberRow(), listMembers()]),
  );
  /**
   * 抽屉的动作条要**这个人**的权限（P4-05）：`detail.actions` 是
   * `actionsFor(state) ∩ can(actor, …)`，`permissions` 是描述「编辑」、负责人「改」、
   * 参考段两个写按钮的可见性。所以这里不能只传 id——身份必须一起交进去。
   */
  const detail = openId === null ? null : await getRequirementDetail(openId, viewer);
  const actor = viewer.name;
  const generator = openId === null ? null : await generatorView(db, actor);

  // 「改负责人」的候选：只在抽屉给出转交权时才查（超管全名册 / 条线负责人本线）。
  // P4-06：候选按**转交人自己的条线**筛，不按需求类型——类型不再是锚点。
  const owners = detail !== null && detail.permissions.reassignOwner
    ? await ownerCandidates(viewer)
    : [];

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
      <Board view={view} filter={filter} members={members} />
      {/* key 是需求 id：从 A 的抽屉直接跳到 B 的抽屉（URL 导航）时，整块重新挂载，
          上一个动作留下的失败消息与表单值不会跟着漂到另一条需求上。 */}
      {detail !== null && generator !== null && (
        <Drawer
          key={detail.id}
          detail={detail}
          releases={releases}
          generator={generator}
          owners={owners}
          closeHref={query === '' ? '/' : `/?${query}`}
        />
      )}
      {/* 新建：任何时候都能开（抽屉开着也开——它是一个独立的对话框，不是一个页面）。 */}
      {creating && (
        <RequirementForm
          mode="create"
          members={members}
          me={actor}
          closeHref={query === '' ? '/' : `/?${query}`}
        />
      )}
      {/* 编辑：抽屉的「编辑」，只改标题与六问（类型 / 提出人 / 负责人不在这张表上）。 */}
      {openId !== null && editing && detail !== null && (
        <RequirementForm
          mode="edit"
          members={members}
          me={actor}
          closeHref={query === '' ? `/?open=${detail.id}` : `/?open=${detail.id}&${query}`}
          initial={{
            id: detail.id,
            number: detail.number,
            title: detail.title,
            type: detail.info.type,
            requester: detail.info.requester,
            ownerMemberId: null,
            description: detail.description,
            // 平台（P4-08）：编辑表单的 chips 初值。新建时是空数组（未标注）。
            platforms: detail.info.platforms,
            // 优先级（P4-09）：单选初值。null = 未定（新建时也是 null）。
            priority: detail.info.priority,
          }}
        />
      )}
      </main>
    </Shell>
  );
}
