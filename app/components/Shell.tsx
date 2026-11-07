import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { db } from '../../src/db/client';
import { AppError } from '../../src/core/errors';
import {
  currentMember, listMembers, NO_MEMBER, hasActiveSession,
} from '../../src/core/read/member';
import {
  notifyView, currentMemberRowOrNull, prefsOf, type NotifyView,
} from '../../src/core/read/notify';
import { NotifyBell } from './NotifyBell';
import { PageTitle } from './PageTitle';
import { TopbarActions } from './TopbarActions';
import { ProgressCard } from './ProgressCard';
import { listRunningJobs } from '../../src/core/read/progress';
import { RailFooter } from './RailFooter';
import { RailNav } from './RailNav';
import { RailToggle } from './RailToggle';
import { roleLabel } from '../settings/roles';
import { railFromCookie, RAIL_COOKIE } from './rail-pref';
import { cookies } from 'next/headers';

/**
 * 有身份的那一半应用：左轨 + 顶栏 + 主区。
 *
 * ── 它同时是这道门
 *
 * `requireSession()` 在**渲染任何东西之前**跑：没有验得过签名的会话 cookie 就直接
 * `redirect('/login')`。于是「哪些路由要求登录」这件事不需要有人在每个页面里记得写
 * 一遍——页面只要挂在这个外壳里，就已经在门里面了。今天挂在这里的是 `/`、`/releases`、
 * `/settings` 三个页面；`/mcp` 不走它（它用 Bearer token，不该依赖 cookie），
 * `/login` 也不走（它就是门外那一页）。
 *
 * 为什么不是 middleware：Next 16 的 `proxy.ts` 只验得了签名（它不该在代理里连库），
 * 而「这个人还在不在名册上、有没有被停用」要查一次库。所以门分两层：
 * `proxy.ts` 拦「没有会话 / 签名不对」（对所有路由一致，便宜），这一层拦「会话里的
 * 那个人已经不能用了」（要库，只有页面才需要）。
 *
 * ── 为什么要读 `currentMember()` 而不是直接用 cookie 里的名字
 *
 * 解析顺序写在 `src/core/read/member.ts`：会话 → `FLOWERS_ACTOR` → 第一个超管。
 * 左轨底部的身份块、通知铃铛、进度卡都从**同一个**解析结果出发，所以「我是谁」
 * 在这一页里不可能有两个答案。
 */
async function selfOrNull() {
  try {
    return await currentMemberRowOrNull();
  } catch (error) {
    if (error instanceof AppError && error.code === 'no_member') return null;
    throw error;
  }
}

export async function Shell({ children }: { children: ReactNode }) {
  /**
   * 第一件事：有没有会话。没有就整页换成登录页。
   *
   * `redirect` 抛的是一支特殊的异常（Next 用它中断渲染），所以它必须在任何数据读取
   * 之前——否则一次未登录的访问会先替一个没有身份的人查一遍库。
   */
  if (!(await hasActiveSession())) redirect('/login');

  const self = await selfOrNull();

  /**
   * 空名册：会话里有名字，但库里一个人都没有（或者那个名字已经不在名册上）。
   * 这不是「未登录」，而是「这个部署还没初始化」——把人送回登录页只会让他反复试，
   * 所以这里直接显示那句话（与登录页上那句同一个常量，`NO_MEMBER`）。
   */
  if (self === null) {
    return (
      <main className="view" style={{ padding: 24 }}>
        <h2>还没法开始</h2>
        <p>{NO_MEMBER}</p>
        <p>
          <a href="/login">回登录页</a>
        </p>
      </main>
    );
  }

  const [members, actor] = await Promise.all([listMembers(), currentMember()]);
  const me = members.find((member) => member.name === actor) ?? self;
  const role = roleLabel(me.role);

  const jar = await cookies();
  const rail = railFromCookie(jar.get(RAIL_COOKIE)?.value);

  /**
   * 正在跑的生成（P4-02）。放在外壳里、而不是某一页：生成是由抽屉发起的，但人往往
   * 在两分钟的等待里翻到版本页、设置页去干别的；进度卡跟着人走才对。
   */
  const jobs = await listRunningJobs();

  /**
   * 顶栏铃铛的**首帧**（P4-03）：列表 + 未读数来自同一个 `notifyView`，红点与列表
   * 因此不可能各说各的。
   */
  const notices: NotifyView = await notifyView(db, me);
  /**
   * 站内档位（P4-07）。只有一件事要它：`off` 时铃铛整个不渲染。列表与红点的口径
   * 仍然全在 `notifyView` 里（档位在同一处判），这里不重复过滤。
   */
  const siteLevel = prefsOf(me.notifyPrefs).site;

  return (
    <div className="shell" data-rail={rail}>
      <nav className="rail">
        {/* 收起时只剩首字母：56px 的左轨放不下「Flower」与那行副标题。
            两个标签都在 DOM 里，切哪个由 CSS 按实际宽度定（与 RailNav 同一套）。 */}
        <h1>
          <span className="lbl">Flower</span>
          <span className="abbr" aria-hidden="true">F</span>
        </h1>
        <div className="sub">123云盘 · 产品研发</div>
        <RailToggle initial={rail} />
        <RailNav />
        {/* 占位：把「设置 + 身份」压到左轨底部（`.rail .sp{flex:1}`）。 */}
        <span className="sp" aria-hidden="true" />
        <RailFooter name={me.name} role={role} />
      </nav>
      <div className="main">
        {/* 顶栏只放当前页的标题（需求 / 版本 / 设置）。字由路径推出来，见 PageTitle。 */}
        <header className="topbar">
          <PageTitle />
          {/* 铃铛在「新建需求」左边：先看发生过什么，再动手新建。
              P4-07：站内档位是 `off` 时整个不渲染——「关」的语义是「我不看」，
              留一个永远 0 的铃铛在顶栏上，等于每天提醒他一次「你关掉了通知」。 */}
          {siteLevel === 'off' ? null : <NotifyBell initial={notices} />}
          <TopbarActions />
        </header>
        {children}
        {/* 角落里的进度卡：固定右下角，可折叠，点一行进那条需求的抽屉。 */}
        <ProgressCard initial={jobs} />
      </div>
    </div>
  );
}

export default Shell;
