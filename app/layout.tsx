import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

import { db } from '../src/db/client';
import { currentMember, listMembers } from '../src/core/read/member';
import { notifyView, type NotifyView } from '../src/core/read/notify';
import { NotifyBell } from './components/NotifyBell';
import { PageTitle } from './components/PageTitle';
import { TopbarActions } from './components/TopbarActions';
import { ProgressCard } from './components/ProgressCard';
import { listRunningJobs } from '../src/core/read/progress';
import { RAIL_COOKIE, railFromCookie } from './components/rail-pref';
import { RailFooter } from './components/RailFooter';
import { RailNav } from './components/RailNav';
import { RailToggle } from './components/RailToggle';
import { roleLabel } from './settings/roles';
import './globals.css';

export const metadata: Metadata = {
  title: 'Flower · 需求门禁',
  description: '123云盘 · 产品研发需求门禁',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // D2：身份就是一个 cookie，没有登录。名册与当前成员都从读模型来（一个来源），
  // 布局不再自己解码 cookie——解码规则只该写在 src/core/read/member.ts 里一份。
  //
  // 身份**只读**：界面没有任何一处写 `flowers_actor`（曾经的顶栏下拉框已删）。SSO 之前
  // 它就是配置，名册里查得到谁就是谁；查不到（cookie 里是个离职的人、或者库里还没 seed）
  // 时角色留空，不猜一个角色给屏上。
  const [members, actor] = await Promise.all([listMembers(), currentMember()]);
  const self = members.find((member) => member.name === actor) ?? null;
  const role = self === null ? '' : roleLabel(self.role);

  // 左轨的宽度也是 cookie，但解码只写在 rail-pref.ts 一份。放在 `<html>` 上而不是
  // `.shell` 上：CSS 的折叠档要从根元素切（`html[data-rail="collapsed"] .shell`），
  // 而且 `RailToggle` 点下去要能立刻改一个现成的属性、不必等 RSC 往返。
  // 没有 cookie 时是 'auto'：桌面 184px、手机 56px，由 CSS 的断点决定。
  const jar = await cookies();
  const rail = railFromCookie(jar.get(RAIL_COOKIE)?.value);

  /**
   * 正在跑的生成（P4-02）。放在布局里、而不是某一页：生成是由抽屉发起的，但人往往
   * 在两分钟的等待里翻到版本页、设置页去干别的；进度卡跟着人走才对。
   *
   * 没有作业时它渲染 null（`ProgressCard` 自己判断），所以这次查询的结果在多数时候
   * 只是一次空数组——一次索引命中换「切页时不知道还在不在生成」这个坑，值得。
   */
  const jobs = await listRunningJobs();

  /**
   * 顶栏铃铛的**首帧**（P4-03）。
   *
   * 放在布局里：铃铛在顶栏，而顶栏只由布局渲染（标题与入口也是）。数据一次读全
   * ——列表 + 未读数来自同一个 `notifyView`，红点与列表因此不可能各说各的。
   * 名册里查不到这个 cookie（离职的人 / 空库）时不发查询：通知是附加物，
   * 不该让整页 500；铃铛自己会显示空列表。
   */
  const notices: NotifyView = self === null
    ? { notices: [], unread: 0 }
    : await notifyView(db, self);

  return (
    <html lang="zh-CN" data-rail={rail}>
      {/*
        suppressHydrationWarning 是给**浏览器扩展**用的，不是给我们的标记用的：装着的
        扩展会往 <body> 上注入属性（线上那一例是 `data-atm-ext-installed`，
        报错原文在 dev 日志里指着这个属性），而
        React 19 的水合对比会在下面每一条属性上做严格比对，于是 Next 的「1 Issue」
        徽标亮起、报的是一处 hydration mismatch——错的不是这一棵树的任何一行代码。
        只压一层：它不会传到子节点，我们自己的组件里真有 mismatch 照样会报。 */}
      <body suppressHydrationWarning>
        <div className="shell">
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
            {/* 占位：把「设置 + 身份」压到左轨底部（`.rail .sp{flex:1}`）。
                导航在上面、配置与身份在下面，这是线稿的顺序。 */}
            <span className="sp" aria-hidden="true" />
            <RailFooter name={actor} role={role} />
          </nav>
          <div className="main">
            {/* 顶栏只放当前页的标题（需求 / 版本 / 设置）。字由路径推出来，见 PageTitle。 */}
            <header className="topbar">
              <PageTitle />
              {/* 铃铛在「新建需求」左边：先看发生过什么，再动手新建。 */}
              <NotifyBell initial={notices} />
              <TopbarActions />
            </header>
            {children}
            {/* 角落里的进度卡：固定右下角，可折叠，点一行进那条需求的抽屉。 */}
            <ProgressCard initial={jobs} />
          </div>
        </div>
      </body>
    </html>
  );
}
