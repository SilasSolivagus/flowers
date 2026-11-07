import { redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';

import { db } from '../../src/db/client';
import { BAD_CREDENTIALS, RATE_LIMITED } from '../../src/core/auth/login';
import { hasActiveSession, NO_MEMBER } from '../../src/core/read/member';
import { loginAction } from './actions';
import './login.css';

/**
 * 登录页：两个字段 + 一个按钮，中文。
 *
 * 三件事刻意写在这一页里：
 *
 * 1. **已在登录状态就直接回看板**。一个已经登录的人点回 `/login`（书签、后退）不该
 *    看到一个再登录一次的表单——那容易让人以为自己的会话掉了。
 * 2. **错误只有三句话**，而且「账号不存在」与「密码错」共用一句（`BAD_CREDENTIALS`）。
 *    文案从服务层 import，不在这里复制：一句话有两个来源，迟早变成两句不同的中文，
 *    而其中一句会把答案说出去。
 * 3. **名册空的时候说清原因**。空库上任何口令都不可能对；只说「账号或密码不对」会让
 *    人一遍遍试。这里查一次人数，空就给一句「先去跑种子」（`NO_MEMBER` 的同一个常量）。
 *
 * 这一页**不渲染 `Shell`**：左轨底部那块身份、顶栏铃铛、进度卡都属于「已经登录的人」，
 * 出现在这里等于告诉一个还没登录的人「你现在是谁」。根布局只剩 `<html>/<body>`，
 * 外壳在 `app/components/Shell.tsx`——这也是为什么登录页能是干净的一页。
 */

const ERROR_TEXT: Record<string, string> = {
  bad: BAD_CREDENTIALS,
  rate: RATE_LIMITED,
  missing: '请填写姓名和密码',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string | string[] | undefined }>;
}) {
  if (await hasActiveSession()) redirect('/');

  const { e } = await searchParams;
  const code = typeof e === 'string' ? e : null;
  const message = code === null ? null : (ERROR_TEXT[code] ?? BAD_CREDENTIALS);

  const counted = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from members where deactivated_at is null`);
  const empty = Number(counted.rows[0]?.n ?? 0) === 0;

  return (
    <main className="loginwrap">
      <div className="logincard">
        <h1>Flower</h1>
        <p className="sub">123云盘 · 产品研发需求门禁</p>

        {empty ? (
          <p className="err" role="alert">{NO_MEMBER}</p>
        ) : (
          <form action={loginAction} className="loginform">
            <label>
              <span>姓名</span>
              <input
                name="name"
                type="text"
                autoComplete="username"
                autoFocus
                required
                placeholder="例如：房超"
              />
            </label>
            <label>
              <span>密码</span>
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                placeholder="初始密码见种子输出"
              />
            </label>
            {message === null ? null : <p className="err" role="alert">{message}</p>}
            <button type="submit" className="btn primary">登录</button>
          </form>
        )}

        <p className="hint">
          忘记密码：找超管在「设置 · 成员」里重置。
        </p>
      </div>
    </main>
  );
}
