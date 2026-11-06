import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';

/**
 * 花名册。
 *
 * 读模型只读：这里没有任何写路径，也不做权限——`actor` 是一个自由文本字段
 * （spec §2：提出人是字段，不是账号），成员表只负责「有哪几个人、各是哪条线」。
 */
export type Member = { id: string; name: string; role: string };

/** 没带身份时的默认成员（计划 D2：缺省「吕品」并在顶栏提示）。 */
export const DEFAULT_MEMBER = '吕品';

/** 顶栏切换成员写的那个 cookie。读侧只在这一个文件里出现名字。 */
export const ACTOR_COOKIE = 'flowers_actor';

/**
 * 全部成员，按姓名排序。
 *
 * 为什么不按 created_at：种子是一次 insert 建完五个人的，created_at 全都一样，
 * 于是排序实际退化到 uuid —— 每次重灌种子，顶栏下拉框的顺序都会变一遍。
 * 姓名在同一张库里是稳定的（依赖 collation，但不依赖插入顺序）。
 *
 * 派单（review.ts 的 assignReviewer）仍然按 created_at, id 取第一个人：
 * 那是「同角色配了多个人」时的历史口径，不该被界面的展示顺序改掉。
 */
export async function listMembers(): Promise<Member[]> {
  const res = await db.execute<Member>(sql`
    select id, name, role from members order by name, id`);
  return res.rows;
}

/**
 * 名字 → id。找不到（cookie 里是个不在名册上的人）就是 null。
 *
 * 为什么身份层到处只有名字：P1 的 `actor` 是自由文本（spec §2：提出人是字段，不是
 * 账号），cookie 里存的、`created_by` 写的都是名字。但**给成员存东西**的键不能用名字：
 * 名字里可以有 `.`、空格、任意标点，而键的形状是 `member.<id>.provider.baseUrl`——
 * 一个带点的名字会让这个键读起来有两种切法。所以落库一律用 `members.id`，
 * 名字只在入口处查一次。
 */
export async function memberIdByName(name: string): Promise<string | null> {
  const trimmed = name.trim();
  if (trimmed === '') return null;
  const res = await db.execute<{ id: string }>(sql`
    select id from members where name = ${trimmed} order by id limit 1`);
  return res.rows[0]?.id ?? null;
}

/**
 * cookie → 当前成员名。
 *
 * 客户端写的是 `encodeURIComponent(名字)`，所以要先解码；解不出来（人手改过的坏值）
 * 就原样返回，而不是抛错——一个坏 cookie 不该让整个顶栏白屏，它顶多让「当前成员」
 * 显示成那串乱码，而用户随时可以再选一次。
 */
export function actorFromCookie(raw: string | undefined): string {
  if (!raw) return DEFAULT_MEMBER;
  try {
    const decoded = decodeURIComponent(raw);
    return decoded.trim().length > 0 ? decoded.trim() : DEFAULT_MEMBER;
  } catch {
    return raw;
  }
}

/**
 * 当前成员：读 `flowers_actor` cookie，没有就落 DEFAULT_MEMBER。
 *
 * `next/headers` 是**动态** import 的，两个原因：
 * 1. `next/headers` 只能在请求上下文里 import（它引 server-only）。静态 import 会让
 *    `tests/read.test.ts` 连模块都加载不了，而读模型的 SQL 恰恰只能用真库验证；
 *    脚本（seed）也要能读同一份花名册。
 * 2. 没有请求上下文（脚本 / 用例）与「没有 cookie」是同一件事，语义上就该落到默认
 *    成员，所以这里 fail-soft 回 DEFAULT_MEMBER，而不是让读模型拒绝服务。
 *
 * 认的是**解码后**的名字（与 layout 的顶栏一致），不是 cookie 原文。
 */
export async function currentMember(): Promise<string> {
  try {
    const { cookies } = await import('next/headers');
    const jar = await cookies();
    return actorFromCookie(jar.get(ACTOR_COOKIE)?.value);
  } catch {
    return DEFAULT_MEMBER;
  }
}
