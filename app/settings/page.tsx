import Link from 'next/link';
import { headers } from 'next/headers';

import { db } from '../../src/db/client';
import { listTokens } from '../../mcp/tokens';
import { BOARD_STATES } from '../../src/core/read/board';
import { currentMember, listMembers, type Member } from '../../src/core/read/member';
import { STATE_LABEL, type State } from '../../src/core/state-machine';
import type { GeneratorView, MemberKeyView } from '../../src/core/uemaster/candidates';
import {
  memberKeyView, memberProviderParts, type MemberProviderParts,
} from '../../src/core/uemaster/member-provider';
import { resolveProvider } from '../../src/core/uemaster/provider';
import { generatorView } from '../../src/core/uemaster/settings';
import { GeneratorRow } from './GeneratorRow';
import { McpRow, type McpTokenRow } from './McpRow';
import { MemberKeyRow } from './MemberKeyRow';
import { endpointFromHeaders } from './mcp-endpoint';
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
 * - `BOARD_STATES`（src/core/read/board.ts）——十个状态**谁在前**的唯一契约；
 *   中文名仍取自 `STATE_LABEL`（src/core/state-machine.ts），全仓库只有那一份。
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
 * 顺序取自 `BOARD_STATES`（src/core/read/board.ts）：那是仓库里唯一一处把「十个状态谁在前」
 * 写成显式契约的地方，看板的列序也用它，用例独立钉住了它（tests/read.test.ts 抄的是
 * spec 里的十个数）。那份常量自己的注释已经拒绝了「从 `STATE_LABEL` 的键派生」这条路：
 * JS 对象的键序是**声明序**，今天恰好也是流程序，但那是没人维护的巧合。
 *
 * 所以这里一行顺序都不抄：顺序问 `BOARD_STATES`，中文名问 `STATE_LABEL`。
 * 状态机改了它们跟着改，改错了会在同一次改动里暴露（而不是在这一页悄悄走样）。
 */
const WORKFLOW: ReadonlyArray<{ state: State; label: string }> =
  BOARD_STATES.map((state) => ({ state, label: STATE_LABEL[state] }));

/**
 * 一个时刻落在**上海**的哪一天（`YYYY-MM-DD`）。
 *
 * token 列表要的是「哪天生的」，而这一页没有理由让读者的时区参与决定——服务器在
 * 别的时区跑时，同一行会显示成前一天。日期格式化只在这一处，客户端组件拿到的就是
 * 成品字符串（`McpRow` 不再算时区）。
 */
function shanghaiDay(at: Date): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at);
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/** 名册里没有这个人时，他那三行的「原值」：全空（是「没填过」，不是错误）。 */
const EMPTY_PARTS: MemberProviderParts = { baseUrl: null, apiKey: null, model: null };

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] | undefined }>;
}) {
  const { tab } = await searchParams;
  // 没带参数、带了个手改出来的值，都落回「我的」：一个坏链接不该让设置页白屏。
  const active: TabId = tab === 'project' ? 'project' : 'me';

  const [members, actor] = await Promise.all([listMembers(), currentMember()]);

  // 名册里这个人（cookie 里的名字 → 那一行）。找不到就是 null：那时「我的模型 key」
  // 落「未配置」，也存不进去（`saveMemberKeyAction` 会说「不在名册上」）。
  const self = members.find((member) => member.name === actor) ?? null;

  // 「生成器」这一行在「项目」栏里，但这一页只有两个 server component 分支：
  // 顺手一起读，省得为一行再开一次请求。`app_settings` 是主键读，探测有进程缓存。
  //
  // P2.12：两者都问**当前成员**——他配了自己的 key，模型接口这条路就是他的那一份；
  // 「我的模型 key」那一行还要他自己那三行的原值（表单预填，三格不齐也要）。
  //
  // P4.1：顺手把「接你的 agent」那一格要的两样也读出来——端点从**这次请求**的头
  // 推出来（`mcp-endpoint.ts`），token 列表从 `mcp_tokens` 来（含已撤销的）。
  const [generator, parts, resolved, tokens, requestHeaders] = await Promise.all([
    generatorView(db, actor),
    self === null ? Promise.resolve(EMPTY_PARTS) : memberProviderParts(db, self.id),
    resolveProvider(actor),
    listTokens(db),
    headers(),
  ]);
  const memberKey = memberKeyView(parts, resolved);
  const endpoint = endpointFromHeaders(new Headers(requestHeaders));
  const tokenRows: McpTokenRow[] = tokens.map((token) => ({
    id: token.id,
    label: token.label,
    member: token.member,
    scope: token.scope,
    createdDay: shanghaiDay(token.createdAt),
    revokedDay: token.revokedAt === null ? null : shanghaiDay(token.revokedAt),
  }));

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
        {active === 'me'
          ? (
            <MePanel
              actor={actor}
              members={members}
              memberKey={memberKey}
              endpoint={endpoint}
              tokens={tokenRows}
            />
          )
          : <ProjectPanel members={members} generator={generator} />}
      </div>
    </main>
  );
}

/**
 * 我的。
 *
 * 「当前成员」这一行与左轨底部的身份块是**同一个值**：两者都来自 `currentMember()`
 * （读 `flowers_actor` cookie），layout 把同一个返回值交给 RailFooter，这里再取一次
 * 同一个函数。所以它们是同一份事实的两次读取，不可能一个显示 A、一个显示 B——这也是
 * 为什么不在这里再放一行「左轨当前选中」：那会是同一个字符串写两遍。
 *
 * 界面里没有任何一处写这个 cookie（顶栏那个切换成员的下拉框已经删掉）：SSO 之前
 * 身份由配置决定，这一页只把它读到屏上。
 *
 * 角色是本页唯一能给出、且真的来自数据库的第二条事实（`members.role`）。
 * 通知偏好属于 P3：库里没有通知相关的表，所以这一页没有那一行——一行点了不生效的
 * 「站内 / 企微」不是只读展示，是假数据。
 */
function MePanel({
  actor, members, memberKey, endpoint, tokens,
}: {
  actor: string;
  members: Member[];
  memberKey: MemberKeyView;
  endpoint: string;
  tokens: McpTokenRow[];
}) {
  // 名册里找不到这个人（cookie 里是个离职的人、或者库里还没 seed）：角色行如实说
  // 「未在名册」，不猜、也不给他安一个默认角色。
  const self = members.find((member) => member.name === actor) ?? null;

  return (
    <>
      {/* 模型 key 在身份上面：一个是「我是谁」，一个是「我拿什么干活」，而后者是这一页
          唯一可写的东西。P2.12 的 owner 原话是「配 key 的时候给测试一下」——所以这一行
          自带测试，测的就是屏上这一份。 */}
      <MemberKeyRow view={memberKey} />

      {/* 「接你的 agent」紧跟着模型 key：一个是「我拿什么干活」，一个是「别人怎么把活
          交给我」。两者都只在「我」这一栏出现，都属于「这台部署 + 这个人」的配置，
          而不是项目本身的配置（生成器在项目栏）。 */}
      <McpRow endpoint={endpoint} tokens={tokens} />

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
    </>
  );
}

/**
 * 项目。
 *
 * 两段：成员与评审线、工作流。都是只读——P4 不交付工作流编辑，也没有「改成员角色」的动作
 * （那要走领域层，而领域层这一版没有对应服务）。所以这里一行可点的控件都没有：
 * 一个点不动的按钮，比它不在更糟。
 */
function ProjectPanel({
  members, generator,
}: { members: Member[]; generator: GeneratorView }) {
  return (
    <>
      {/* 生成器：这一页上唯一一个可写的格子。它必须可写——「谁在跑」是这台机器的
          事实，不是代码里的常量；而写不写对只有「测试」能回答（见 settings.ts）。 */}
      <GeneratorRow view={generator} />

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
          类型 → 覆盖它的角色 → 那个角色现在是谁。界面上不做派单，只把这条规则摊开。

          值里带上**角色名**（评审 M1，`REVIEW_LINE[].role` 之前是个只写不读的字段）：
          只写「赵越」的话，读者得滚回上面的成员表才能知道他是哪条线的评审人——
          而这一节要说的恰恰是「哪个类型配哪条线」。角色名在前、人名在后，
          顺序就是规则本身的顺序；同角色多人时仍全部列出（见 memberNamesOfRole）。
          没人配这个角色时只说「未配置」：那时角色名也一样是空话。
          `roleLabel` 与成员表共用同一份中文名（M2），两处不会说法不一。 */}
      <section className="sg">
        <div className="h">评审线</div>
        {REVIEW_LINE.map((line) => {
          const names = memberNamesOfRole(members, line.role);
          return (
            <div className="i" key={line.type}>
              <div className="l"><b>{line.label}</b></div>
              <div className="v">
                {names.length === 0 ? '未配置' : `${roleLabel(line.role)} · ${names.join('、')}`}
              </div>
            </div>
          );
        })}
      </section>

      {/* 十个状态，按状态机顺序，只读。序号（01–10）就是顺序本身——它不来自数据库，
          来自 BOARD_STATES；这一列存在的理由只是让「这是有序的」看得见。 */}
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
