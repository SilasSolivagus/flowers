'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * 顶栏右侧的录入入口（P4-02）：看板是「新建需求」，版本页是「新建版本」。
 *
 * 为什么在顶栏而不是页面里：任务书要求「顶部按钮，标题旁边」。标题由 `PageTitle`
 * 按路径给（同一个 `sections.ts` 表），入口也按路径给——两件事的唯一来源都是
 * 「你在哪一页」，所以它们是同一个客户端判断，不经过 props、不各页写一遍。
 *
 * 打开的方式是**链接**（`?new=1`），不是本地 state：与抽屉（`?open=`）、版本页
 * （`?release=`）同一条规矩——刷新还在、能直接发给别人、后退能回去。表单本身由页面
 * 按这个参数渲染（服务端先算出默认值与上下文）。
 */
export function TopbarActions() {
  const pathname = usePathname();
  if (pathname === '/') {
    return <Link className="btn primary sm newentry" href="/?new=1">新建需求</Link>;
  }
  if (pathname === '/releases') {
    return <Link className="btn primary sm newentry" href="/releases?new=1">新建版本</Link>;
  }
  return null;
}

export default TopbarActions;
