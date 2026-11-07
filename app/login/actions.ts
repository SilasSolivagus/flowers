'use server';

import { redirect } from 'next/navigation';
import { db } from '../../src/db/client';
import { AppError } from '../../src/core/errors';
import { login } from '../../src/core/auth/login';

/**
 * 登录表单的入口。
 *
 * 失败时**不**在这里渲染一句话，而是 `redirect('/login?e=<code>')`：这一层是
 * server action，它没有自己的界面；让浏览器回到登录页、由页面把 code 翻成中文，
 * 是唯一能把「刷新一次还是同一句话」这条做对的做法（action 的返回值在刷新后就没了）。
 *
 * 三个 code：
 * - `missing`：两个字段没填（空白也走这一条，不去问库）；
 * - `rate`：失败太多次，被锁 5 分钟；
 * - `bad`：账号或密码不对（未知用户与密码错**同一句**，停用账号也在这一句里——
 *   这一句的文案在 `src/core/auth/login.ts`，界面不复制它）。
 *
 * `login()` 自己会把会话 cookie 写上去；成功后 `redirect('/')`。
 */
export async function loginAction(formData: FormData): Promise<void> {
  // 凭证是邮箱（P4-08）。字段名与登录页的 `name="email"` 一一对应；`login()` 反过来
  // 解析出「这个人是谁」，失败一律 `bad`（未知邮箱与密码错同一句话）。
  const email = typeof formData.get('email') === 'string' ? String(formData.get('email')) : '';
  const password = typeof formData.get('password') === 'string'
    ? String(formData.get('password'))
    : '';

  if (email.trim() === '' || password === '') redirect('/login?e=missing');

  try {
    await login(db, email, password);
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === 'rate_limited') redirect('/login?e=rate');
      redirect('/login?e=bad');
    }
    throw error;
  }
  redirect('/');
}
