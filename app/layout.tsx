import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { currentMember, listMembers } from '../src/core/read/member';
import { MemberSwitch } from './components/MemberSwitch';
import { RailNav } from './components/RailNav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Flower · 需求门禁',
  description: '123云盘 · 产品研发需求门禁',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // D2：身份就是一个 cookie，没有登录。名册与当前成员都从读模型来（一个来源），
  // 布局不再自己解码 cookie——解码规则只该写在 src/core/read/member.ts 里一份。
  const [members, actor] = await Promise.all([listMembers(), currentMember()]);

  return (
    <html lang="zh-CN">
      <body>
        <div className="shell">
          <nav className="rail">
            <h1>Flower</h1>
            <div className="sub">123云盘 · 产品研发</div>
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
