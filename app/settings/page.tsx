import Link from 'next/link';

import { currentMember, listMembers, type Member } from '../../src/core/read/member';
import { STATE_LABEL, type State } from '../../src/core/state-machine';
import { REVIEW_LINE, memberNamesOfRole, roleLabel } from './roles';
import './settings.css';

/**
 * 设置页：`/settings` 一个路由，两个 tab。
 *
 * tab 的选中态是**查询参数**（`?tab=me|project`），不是客户端 state。理由和看板的 `?open=`
 * 一样：刷新、分享链接、浏览器后退都回到同一屏，而且这一页因此可以是一个纯 server
 * component——没有一行 JS 参与导航，也就没有「首帧先渲染错的那一栏」。`<Link>` 是
 * 前置导航，不是 `<a>` 的整页跳转：换 tab 仍走 RSC，左轨不动。
 *
 * 数据只有两个来源，都从读模型来，页面不自己连库也不自己算：
 * - `listMembers()` / `currentMember()`（src/core/read/member.ts）；
 * - `STATE_LABEL`（src/core/state-machine.ts）——十个状态的中文名在整个仓库里只有这一份。
 *
 * 两条来自评审的硬口径：
 * - **屏上不出现解释性文案**：没有「配置说明」「暂无更多设置」，只有行标签与值。
 *   所以这一页没有任何开关：P3 才有通知偏好，P4 造一个点了不生效的控件就是骗人；
 *   「我的」只显示查询得出的事实。
 * - **空要诚实地空**：某个评审角色没有成员时显示「未配置」，而不是编一个名字出来。
 */

type TabId = 'me' | 'project';

/** tab 的地址就是选中态本身（服务端链接，不是按钮）。 */
const TABS: ReadonlyArray<{ id: TabId; href: string; label: string }> = [
  { id: 'me', href: '/settings?tab=me', label: '我的' },
  { id: 'project', href: '/settings?tab=project', label: '项目' },
];

/**
 * 工作流的十行，按状态机顺序。
 *
 * 顺序取自 `STATE_LABEL` 的**字面量书写顺序**（`inbox…shelved`，与 `State` 联合类型的
 * 顺序一致；JS 保证非数字字符串键按插入序枚举）。这样这一页既不抄第二份中文名，
 * 也不抄第二份顺序——状态机改了，这里跟着改，改错了会在同一次改动里暴露。
 * 反过来若在这里写死 `['inbox', 'design', …]`，它就是一张会慢慢走样的副本。
 * （P5 候选：core 导出 `STATE_ORDER`，把「顺序」也变成显式契约，别依赖对象键序。）
 */
const WORKFLOW: ReadonlyArray<{ state: State; label: string }> =
  (Object.keys(STATE_LABEL) as State[]).map((state) => ({ state, label: STATE_LABEL[state] }));

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] | undefined }>;
}) {
  const { tab } = await searchParams;
  // 没带参数、带了个手改出来的值，都落回「我的」：一个坏链接不该让设置页白屏。
  const active: TabId = tab === 'project' ? 'project' : 'me';

  const [members, actor] = await Promise.all([listMembers(), currentMember()]);

  return (
    <main className="view">
      <div className="setwrap">
        <nav className="stabs" aria-label="设置分栏">
          {TABS.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              className="stab"
              aria-current={item.id === active ? 'page' : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        {active === 'me' ? <MePanel actor={actor} members={members} /> : <ProjectPanel members={members} />}
      </div>
    </main>
  );
}

/**
 * 我的。
 *
 * 「当前成员」这一行与顶栏的那个下拉框是**同一个值**：两者都来自 `currentMember()`
 * （读 `flowers_actor` cookie），layout 把同一个返回值交给 MemberSwitch，这里再取一次
 * 同一个函数。所以它们是同一份事实的两次读取，不可能一个显示 A、一个显示 B——这也是
 * 为什么不在这里再放一行「顶栏当前选中」：那会是同一个字符串写两遍。
 *
 * 角色是本页唯一能给出、且真的来自数据库的第二条事实（`members.role`）。
 * 通知偏好属于 P3：库里没有通知相关的表，所以这一页没有那一行——一行点了不生效的
 * 「站内 / 企微」不是只读展示，是假数据。
 */
function MePanel({ actor, members }: { actor: string; members: Member[] }) {
  // 名册里找不到这个人（cookie 里是个离职的人、或者库里还没 seed）：角色行如实说
  // 「未在名册」，不猜、也不给他安一个默认角色。
  const self = members.find((member) => member.name === actor) ?? null;

  return (
    <section className="sg">
      <div className="h">身份</div>
      <div className="i">
        <div className="l"><b>当前成员</b></div>
        <div className="v">{actor}</div>
      </div>
      <div className="i">
        <div className="l"><b>角色</b></div>
        <div className="v">{self === null ? '未在名册' : roleLabel(self.role)}</div>
      </div>
    </section>
  );
}

/**
 * 项目。
 *
 * 两段：成员与评审线、工作流。都是只读——P4 不交付工作流编辑，也没有「改成员角色」的动作
 * （那要走领域层，而领域层这一版没有对应服务）。所以这里一行可点的控件都没有：
 * 一个点不动的按钮，比它不在更糟。
 */
function ProjectPanel({ members }: { members: Member[] }) {
  return (
    <>
      <section className="sg">
        <div className="h">成员</div>
        {members.length === 0 ? (
          // 空名册：一行「未配置」，不编人。角色行同理（见下面的评审线）。
          <div className="i"><div className="l"><b>未配置</b></div></div>
        ) : (
          members.map((member) => (
            <div className="i" key={member.id}>
              <div className="l"><b>{member.name}</b></div>
              <div className="v">{roleLabel(member.role)}</div>
            </div>
          ))
        )}
      </section>

      {/* 「评审人由类型决定」（spec §2）在界面上的那一半：
          类型 → 覆盖它的角色 → 那个角色现在是谁。界面上不做派单，只把这条规则摊开。 */}
      <section className="sg">
        <div className="h">评审线</div>
        {REVIEW_LINE.map((line) => {
          const names = memberNamesOfRole(members, line.role);
          return (
            <div className="i" key={line.type}>
              <div className="l"><b>{line.label}</b></div>
              <div className="v">{names.length === 0 ? '未配置' : names.join('、')}</div>
            </div>
          );
        })}
      </section>

      {/* 十个状态，按状态机顺序，只读。序号（01–10）就是顺序本身——它不来自数据库，
          来自 STATE_LABEL 的书写顺序；这一列存在的理由只是让「这是有序的」看得见。 */}
      <section className="sg">
        <div className="h">工作流</div>
        <ol className="wf">
          {WORKFLOW.map((item, index) => (
            <li className="i" key={item.state}>
              <span className="n">{String(index + 1).padStart(2, '0')}</span>
              <div className="l"><b>{item.label}</b></div>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
