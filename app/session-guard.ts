import { redirect } from 'next/navigation';

import { AppError } from '../src/core/errors';
import { hasActiveSession } from '../src/core/read/member';

/**
 * 页面级会话门。
 *
 * 为什么 `Shell` 里那道门不够：Next 的 page 与 layout **并行渲染**，page 里的
 * `getBoard()` 不会等 Shell 的 `redirect` 生效就会先跑。于是「会话失效」时
 * `currentMemberRow()` 抛的 `session_invalid` 直接变成一个 500——用户看到的是
 * 报错页，而正确结果是回登录页。
 *
 * 两层合起来：`hasActiveSession()` 先判（正常情况下直接走这里），`withSession()`
 * 兜住「判完到取数之间刚好被改了权限」那一瞬——两个都指向同一件事：回登录页。
 */
export async function requireSession(): Promise<void> {
  if (!(await hasActiveSession())) redirect('/login');
}

/** 把会话类错误翻成「回登录页」，其余错误原样抛（不吞）。 */
export async function withSession<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError && (error.code === 'session_invalid' || error.code === 'no_member')) {
      redirect('/login');
    }
    throw error;
  }
}
