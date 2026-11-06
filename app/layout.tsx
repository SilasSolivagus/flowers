import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

import { currentMember, listMembers } from '../src/core/read/member';
import { MemberSwitch } from './components/MemberSwitch';
import { RAIL_COOKIE, railFromCookie } from './components/rail-pref';
import { RailNav } from './components/RailNav';
import { RailToggle } from './components/RailToggle';
import './globals.css';

export const metadata: Metadata = {
  title: 'Flower · 需求门禁',
  description: '123云盘 · 产品研发需求门禁',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // D2：身份就是一个 cookie，没有登录。名册与当前成员都从读模型来（一个来源），
  // 布局不再自己解码 cookie——解码规则只该写在 src/core/read/member.ts 里一份。
  const [members, actor] = await Promise.all([listMembers(), currentMember()]);

  // 左轨的宽度也是 cookie，但解码只写在 rail-pref.ts 一份。放在 `<html>` 上而不是
  // `.shell` 上：CSS 的折叠档要从根元素切（`html[data-rail="collapsed"] .shell`），
  // 而且 `RailToggle` 点下去要能立刻改一个现成的属性、不必等 RSC 往返。
  // 没有 cookie 时是 'auto'：桌面 184px、手机 56px，由 CSS 的断点决定。
  const jar = await cookies();
  const rail = railFromCookie(jar.get(RAIL_COOKIE)?.value);

  return (
    <html lang="zh-CN" data-rail={rail}>
      <body>
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
          </nav>
          <div className="main">
            <header className="topbar">
              <span className="sp" />
              <MemberSwitch current={actor} members={members.map((m) => m.name)} />
            </header>
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}
