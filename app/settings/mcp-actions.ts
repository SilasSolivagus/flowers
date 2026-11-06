'use server';

import { revalidatePath } from 'next/cache';
import { db } from '../../src/db/client';
import { AppError } from '../../src/core/errors';
import { currentMember, memberIdByName } from '../../src/core/read/member';
import { isScope, mintToken, revokeToken, type Scope } from '../../mcp/tokens';

/**
 * 设置页「接你的 agent」那两个动作：生成 token、撤销 token。
 *
 * 这一层只做三件 Next 专有的事：从 FormData 取字段、把 `AppError` 翻成一句话、
 * 失效页面。token 的形状、hash、入库、scope 词表全在 `mcp/tokens.ts` 里——那是
 * HTTP 端点也在用的同一份实现，界面不该有第二条生成路径。
 *
 * **原文只出现一次**：`mintMcpTokenAction` 的返回值里带着它，客户端把它放在一块
 * 用完即弃的状态里。库里只有 sha256；这一页刷新之后，「已生成」的那一块就空了，
 * 再也拿不回来——这不是没做完，是刻意的（见 tokens.ts 文件头）。
 */

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/** 生成结果。成功时 `raw` 是**唯一一次**能看到 token 原文的地方。 */
export type MintResult =
  | { ok: true; raw: string; label: string; scopes: Scope; createdAt: string }
  | { ok: false; message: string };

/**
 * 生成一个 token，绑定到**当前成员**。
 *
 * 为什么成员只能是当前成员：这一格是「我的」，没有「给谁生成」这个字段。要给别人
 * 生成得先有 SSO（P5），在那之前加一个「选成员」的下拉框，等于把身份这件事重新变成
 * 自由文本——而整套 token 的意义正是把身份钉死。
 *
 * `label` 与 `scopes` 由那一行的小表单给；`label` 空着时**不填默认值**：
 * 列表里三个都叫 `agent` 的 token 撤销时只能猜（`mintToken` 会回一句中文让人起个名字）。
 */
export async function mintMcpTokenAction(formData: FormData): Promise<MintResult> {
  try {
    const actor = await currentMember();
    const memberId = await memberIdByName(actor);
    if (memberId === null) throw new AppError('member_unknown', `当前成员「${actor}」不在名册上`);

    const scopes = field(formData, 'scopes');
    if (!isScope(scopes)) throw new AppError('invalid', '权限只能是 read、write、admin 之一');

    const minted = await mintToken(db, { memberId, label: field(formData, 'label'), scopes });
    return {
      ok: true,
      raw: minted.raw,
      label: minted.label,
      scopes: minted.scopes,
      createdAt: minted.createdAt.toISOString(),
    };
  } catch (error) {
    // AppError 的消息就是给用户看的那句话（「给这个 token 起个名字」「不在名册上」），
    // 原样显示，一个字都不改写。
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  } finally {
    revalidatePath('/settings');
  }
}

/** 撤销。成功之后那一行变成「已撤销」——**不删行**：它写过的事件还指着它。 */
export async function revokeMcpTokenAction(
  formData: FormData,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await revokeToken(db, field(formData, 'id'));
    return { ok: true };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    throw error;
  } finally {
    revalidatePath('/settings');
  }
}
