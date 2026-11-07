import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { db } from '../../src/db/client';
import { listTokens } from '../../mcp/tokens';
import { BOARD_STATES } from '../../src/core/read/board';
import { currentMember, listMembers, type Member } from '../../src/core/read/member';
import { can, NO_REQUIREMENT } from '../../src/core/auth/roles';
import { DEFAULT_PREFS, prefsOf } from '../../src/core/read/notify';
import { memberAdminView } from '../../src/core/read/member-admin';
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
import { MemberAdmin } from './MemberAdmin';
import { NotifyChannels, PasswordRow } from './MeSecurity';
import { endpointFromHeaders } from './mcp-endpoint';
import { LINE_LEAD, memberNamesOfRole, roleLabel } from './roles';
import './settings.css';
import { Shell } from '../components/Shell';

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

type TabId = 'me' | 'project' | 'members';

/**
 * tab 的地址就是选中态本身（服务端链接，不是按钮）。
 *
 * 「成员」这一格只给超管（P4-05）：没有 `manageMembers` 的人既看不到这个入口，
 * 手改 `?tab=members` 也只会拿到 404（见下面 `notFound()`）。不是把他领回「我的」——
 * 一个被悄悄改写的 URL 会让人以为自己看到的就是他要的那一页。
 */
const TABS: ReadonlyArray<{ id: TabId; href: string; label: string }> = [
  { id: 'me', href: '/settings?tab=me', label: '我的' },
  { id: 'project', href: '/settings?tab=project', label: '项目' },
];

const MEMBERS_TAB: { id: TabId; href: string; label: string } = {
  id: 'members', href: '/settings?tab=members', label: '成员',
};

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
  const active: TabId = tab === 'project'
    ? 'project'
    : (tab === 'members' ? 'members' : 'me');

  const [members, actor] = await Promise.all([listMembers(), currentMember()]);

  // 名册里这个人（cookie 里的名字 → 那一行）。找不到就是 null：那时「我的模型 key」
  // 落「未配置」，也存不进去（`saveMemberKeyAction` 会说「不在名册上」）。
  const self = members.find((member) => member.name === actor) ?? null;

  // 「成员管理」的入口判据就是 `can('manageMembers')`——不在这里写 role === '...'，
  // 否则「谁能管成员」会长出第二份答案（服务层那一份才是权威）。
  const admin = self !== null && can(self, NO_REQUIREMENT, 'manageMembers');
  const tabs = admin ? [...TABS, MEMBERS_TAB] : TABS;
  // 没有入口，也没有路由：手改 URL 的人拿到的是一张 404，而不是一张只读的名册。
  if (active === 'members' && !admin) notFound();
  const memberRows = active === 'members' ? await memberAdminView(self) : null;

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
    <Shell>
      <main className="view">
      <div className="setwrap">
        <nav className="stabs" aria-label="设置分栏">
          {tabs.map((item) => (
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
              self={self}
              members={members}
              memberKey={memberKey}
              endpoint={endpoint}
              tokens={tokenRows}
            />
          )
          : (active === 'members'
            ? <><MemberAdmin rows={memberRows ?? []} /></>
            : <ProjectPanel members={members} generator={generator} />)}
      </div>
      </main>
    </Shell>
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
 *
 * P4-05 起多两格：**通知**（`notify_prefs`）与**自改口令**。两者都是「我对我自己」
 * 的写，入口只在这一栏。P4-07 把那个开关换成了**两个频道 × 三档**：站内、企微各
 * 一行，各一个分段控件（全部 / 只关键 / 关）。这一页只把库里那一格解析成两个档位
 * （`prefsOf`）交给客户端组件显示——默认值、校验、谁该收到哪一类，全在
 * `src/core/notify/` 里，这一层不复制任何一条。
 */
function MePanel({
  actor, self, members, memberKey, endpoint, tokens,
}: {
  actor: string;
  self: Member | null;
  members: Member[];
  memberKey: MemberKeyView;
  endpoint: string;
  tokens: McpTokenRow[];
}) {
  // 名册里找不到这个人（cookie 里是个离职的人、或者库里还没 seed）：角色行如实说
  // 「未在名册」，不猜、也不给他安一个默认角色。
  const mine = self ?? members.find((member) => member.name === actor) ?? null;
  // 两个频道的档位。`prefsOf` 对 null / 老形状 / 认不出的值一律回落 `key`
  // （见 src/core/notify/prefs.ts），所以这里不需要再判默认值——默认值的唯一一份在那里。
  const notifyPrefs = mine === null ? DEFAULT_PREFS : prefsOf(mine.notifyPrefs);
  // 「还没对上企微账号」那一行的判据就是这一格。
  const wecomUserId = mine?.wecomUserId ?? null;

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
          <div className="v">{mine === null ? '未在名册' : roleLabel(mine.role)}</div>
        </div>
        {/* 自改口令与身份同一张卡：它们都是「我是谁」这件事的一部分，而屏上不该出现
            第二个叫「口令」的标题。 */}
        {mine !== null && <PasswordRow />}
      </section>

      {mine !== null && (
        <section className="sg" id="notify">
          <div className="h">通知</div>
          <NotifyChannels prefs={notifyPrefs} wecomUserId={wecomUserId} />
        </section>
      )}
    </>
  );
}

/**
 * 项目。
 *
 * 两段：评审线、工作流，加上生成器那一格。都不涉及「人怎么管」——成员管理在
 * 「成员」那一栏（只给超管），这里不再放一份只读的名册：同一份事实两个入口，
 * 改完一处另一处就会看起来没变。
 */
function ProjectPanel({
  members, generator,
}: { members: Member[]; generator: GeneratorView }) {
  return (
    <>
      {/* 生成器：这一页上唯一一个可写的格子。它必须可写——「谁在跑」是这台机器的
          事实，不是代码里的常量；而写不写对只有「测试」能回答（见 settings.ts）。 */}
      <GeneratorRow view={generator} />

      {/* 「谁能改一条需求由负责人的条线决定」（P4-06）在界面上的那一半：
          条线 → 那条线的负责人 → 他管的是这条线上所有人名下的需求。界面上不派单，
          只把这条规则摊开。

          P4-06 之前这里写的是「哪个类型配哪条线」。那种说法现在会误导：一条商业类
          需求由功能线 PM 负责时，签它的是功能线负责人——类型与评审人已经没有关系。

          值里带上**角色名**：只写「赵越」的话，读者得滚回上面的成员表才能知道他是
          哪条线的负责人。角色名在前、人名在后；同一角色多人时仍全部列出
          （见 memberNamesOfRole）。没人配这个角色时只说「未配置」——
          那时角色名也一样是空话，而「未配置」恰好是这一条线谁都不能动。 */}
      <section className="sg">
        <div className="h">条线负责人</div>
        {LINE_LEAD.map((line) => {
          const names = memberNamesOfRole(members, line.role);
          return (
            <div className="i" key={line.line}>
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
