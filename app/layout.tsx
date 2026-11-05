import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

import { MemberSwitch } from './components/MemberSwitch';
import { RailNav } from './components/RailNav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Flower · 需求门禁',
  description: '123云盘 · 产品研发需求门禁',
};

/** cookie 里写的是 encodeURIComponent 后的值，读回来要解码；坏值退回 undefined。 */
function readActor(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // D2：身份就是一个 cookie，没有登录。布局读一次，MemberSwitch 用它做初始值。
  const actor = readActor((await cookies()).get('flowers_actor')?.value);

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
              <MemberSwitch current={actor} />
            </header>
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}
