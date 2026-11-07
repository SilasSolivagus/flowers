'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

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
  const params = useSearchParams();

  /**
   * 打开表单时**保住正在看的那条**：原来这两个链接是裸的 `/?new=1`，点「新建需求」
   * 会把 `?open=<id>` 一起丢掉，背后那张抽屉跟着关——你正在看的需求就这么没了，
   * 而本意只是要建一条新的。表单是弹在看板之上的，背后的东西不该动。
   */
  const open = params.get('open');
  const release = params.get('release');

  if (pathname === '/') {
    const href = open === null || open === '' ? '/?new=1' : `/?open=${open}&new=1`;
    return <Link className="btn primary sm newentry" href={href}>新建需求</Link>;
  }
  if (pathname === '/releases') {
    const href = release === null || release === ''
      ? '/releases?new=1'
      : `/releases?release=${release}&new=1`;
    return <Link className="btn primary sm newentry" href={href}>新建版本</Link>;
  }
  return null;
}

export default TopbarActions;
