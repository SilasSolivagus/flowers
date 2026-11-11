import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { db } from '../../src/db/client';
import { listTokens } from '../../mcp/tokens';
import { BOARD_STATES } from '../../src/core/read/board';
import { currentMember, listMembers, type Member } from '../../src/core/read/member';
import { can, NO_REQUIREMENT } from '../../src/core/auth/roles';
import { DEFAULT_MEMBER_PASSWORD } from '../../src/core/auth/password';
import { DEFAULT_PREFS, prefsOf } from '../../src/core/read/notify';
import { memberAdminView } from '../../src/core/read/member-admin';
import { wecomBindingView, type WecomBindingView } from '../../src/core/read/wecom-binding';
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
import { WecomBinding } from './WecomBinding';
import { endpointFromHeaders } from './mcp-endpoint';
import './settings.css';
import { Shell } from '../components/Shell';
import { roleLabel } from './roles';

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
// 只有「我的」常驻；「成员」只给超管（见下）。
//
// 原有一个「项目」栏（生成器 / 条线负责人 / 工作流），owner 的判断是**不需要**：
// 工作流那十行就是看板十列的另一种写法；条线负责人那张表在「成员」里已经按人列过；
// 而唯一有写操作的那一格（平台模型）本来就该在管理员那一页。三块并成一块之后，
// 设置页只剩「我对我自己」和「超管对全平台」，不再有一个谁都能点进去看的杂物间。
const TABS: ReadonlyArray<{ id: TabId; href: string; label: string }> = [
  { id: 'me', href: '/settings?tab=me', label: '我的' },
];

const MEMBERS_TAB: { id: TabId; href: string; label: string } = {
  id: 'members', href: '/settings?tab=members', label: '成员',
};

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

/** 名册里没有这个人时的绑定视图：全空（是「还没绑」，不是错误）。 */
const EMPTY_BINDING: WecomBindingView = {
  state: 'unbound', stateLabel: '未绑定', hint: null, userid: null,
  webhook: null, webhookSet: false, lastLookupDay: null,
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] | undefined }>;
}) {
  const { tab } = await searchParams;
  // 没带参数、带了个手改出来的值，都落回「我的」：一个坏链接不该让设置页白屏。
  const active: TabId = tab === 'members' ? 'members' : 'me';

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
  // 企微那两行（绑定状态 + 自己的机器人）要从 `wecom_lookup_at` 与 `wecom_webhook` 算，
  // 而 `Member` 上没有那两列（它们是通知的事实，不是权限的事实）。名册里没有这个人时
  // 给一张「未绑定」的空视图：页面不该为一行不存在的成员白屏。
  const wecomBinding = self === null
    ? EMPTY_BINDING
    : await wecomBindingView(self.id);
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
              wecomBinding={wecomBinding}
              endpoint={endpoint}
              tokens={tokenRows}
            />
          )
          : (
            <>
              {/* 平台模型：超管那一页唯一一个可写的平台级配置。它原来在「项目」栏里，
                  「项目」删掉之后并到这里——同一个页面里既管人、也管这台机器用什么模型。 */}
              <GeneratorRow view={generator} />
              {/* 初始密码从服务端读一次、作为值传下去：客户端组件不许 import
                  `auth/password.ts`（它带 node:crypto），而「统一的那一条」只该有一个来源。 */}
              <MemberAdmin rows={memberRows ?? []} defaultPassword={DEFAULT_MEMBER_PASSWORD} />
            </>
          )}
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
 * P4-05 起多两格：**通知**（`notify_prefs`）与**自改密码**。两者都是「我对我自己」
 * 的写，入口只在这一栏。P4-07 把那个开关换成了**两个频道 × 三档**：站内、企微各
 * 一行，各一个分段控件（全部 / 只关键 / 关）。这一页只把库里那一格解析成两个档位
 * （`prefsOf`）交给客户端组件显示——默认值、校验、谁该收到哪一类，全在
 * `src/core/notify/` 里，这一层不复制任何一条。
 */
function MePanel({
  actor, self, members, memberKey, wecomBinding, endpoint, tokens,
}: {
  actor: string;
  self: Member | null;
  members: Member[];
  memberKey: MemberKeyView;
  wecomBinding: WecomBindingView;
  endpoint: string;
  tokens: McpTokenRow[];
}) {
  // 名册里找不到这个人（cookie 里是个离职的人、或者库里还没 seed）：角色行如实说
  // 「未在名册」，不猜、也不给他安一个默认角色。
  const mine = self ?? members.find((member) => member.name === actor) ?? null;
  // 两个频道的档位。`prefsOf` 对 null / 老形状 / 认不出的值一律回落 `key`
  // （见 src/core/notify/prefs.ts），所以这里不需要再判默认值——默认值的唯一一份在那里。
  const notifyPrefs = mine === null ? DEFAULT_PREFS : prefsOf(mine.notifyPrefs);

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
        {/* 自改密码与身份同一张卡：它们都是「我是谁」这件事的一部分，而屏上不该出现
            第二个叫「密码」的标题。 */}
        {mine !== null && <PasswordRow />}
      </section>

      {mine !== null && (
        <section className="sg" id="notify">
          <div className="h">通知</div>
          {/* 两件事分开：上面两行是「要不要被打断」（档位），下面两行是「发给谁」
              （绑定 / 机器人）。合成一块会让人以为关掉档位就是把账号解绑了。 */}
          <NotifyChannels prefs={notifyPrefs} />
          <WecomBinding view={wecomBinding} />
        </section>
      )}
    </>
  );
}

