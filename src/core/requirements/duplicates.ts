import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';

/**
 * 相似需求（2026-11-11）。
 *
 * 现状：系统**没有**强制查重。三道软保障是：MCP 说明里让 agent 先查、看板能搜标题、
 * 告警 P3 事后报「同名重复」。人直接从网页点「新建需求」时，没有任何提示。
 *
 * 这里补的是**提示**，不是门：建完把「像它的那几条」一起返回，界面与 agent 都能看见，
 * 由人决定是搁置新的还是改旧的。为什么不拦：标题像不等于同一条（同名的两个模块、
 * 一期二期），拦错一次人会去改标题凑合规，比重复更糟。
 *
 * 判据刻意保守：
 * - 归一（去括号注记/标点/空格、小写）后**完全相同**；或
 * - 一方包含另一方，且短的那一边 ≥ 6 个字（「AI 搜索」这种太短，会把不相干的算进来）。
 */
export type DuplicateSuggestion = {
  id: string;
  number: number;
  title: string;
  state: string;
};

export function normalizeTitle(raw: string): string {
  return raw
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[【】\[\]《》「」（）()\s·、，,。.:：;；/|｜\-—_]/g, '')
    .toLowerCase();
}

export function looksSimilar(a: string, b: string): boolean {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (left === '' || right === '') return false;
  if (left === right) return true;
  // 包含匹配要求**短的那一边**至少 6 个字：「直链升级二期」这种能命中，
  // 「AI 搜索」这种 4 字的会把一堆不相干的拉进来。
  if (Math.min(left.length, right.length) < 6) return false;
  return left.includes(right) || right.includes(left);
}

/** 池子里与这个标题像的（最多 3 条，按编号升序）。软删除的不算。 */
export async function findDuplicates(
  db: Db, title: string,
): Promise<DuplicateSuggestion[]> {
  const needle = normalizeTitle(title);
  if (needle === '') return [];
  const res = await db.execute<{
    id: string; number: number; title: string; state: string;
  }>(sql`select id, number, title, state from requirements
          where deleted_at is null order by number`);
  return res.rows
    .filter((row) => looksSimilar(title, row.title))
    .slice(0, 3)
    .map((row) => ({ ...row, number: Number(row.number) }));
}
