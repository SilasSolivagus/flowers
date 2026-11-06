import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { parseRequirementId } from '../validate.js';
import { STAGES, type Stage } from './packs.js';

export type ArtifactRef = { stage: Stage; url: string; at: Date };

/** stage 的固定次序：读模型按它排三行，不按时间。 */
const RANK = new Map<Stage, number>(STAGES.map((stage, i) => [stage, i]));

/**
 * 取一条需求的产物，**每个 stage 只给最新那一行**。
 *
 * 「最新」按 `created_at` 算：重做会产生新版本（旧行保留），读侧永远只认最近一次，
 * 抽屉里三行各指一份当前有效的材料。`distinct on (stage)` 是 PG 的「每组第一行」，
 * 配上 `order by stage, created_at desc` 恰好就是这件事；时间相同的极端情况下再用
 * `id desc` 定序，保证同一份数据每次读出同一个答案（否则刷新页面会来回跳）。
 *
 * 结果按 evaluate / review / inspect 排，不按时间：三行是对外的固定槽位，顺序变了
 * 抽屉里的行会自己搬家。
 *
 * requirementId 先按 uuid 校验，不让 PG 的 22P02 漏成 500；需求不存在时返回空数组
 * ——「没有产物」和「没有这条需求」在读侧是同一个答案（三行都不显示），不必报错。
 */
export async function listArtifacts(db: Db, requirementId: string): Promise<ArtifactRef[]> {
  const id = parseRequirementId({ requirementId });

  const res = await db.execute<{ stage: Stage; url: string; at: Date }>(sql`
    select stage, url, at from (
      select distinct on (stage) stage, url, created_at as at, id
        from uemaster_artifacts
       where requirement_id = ${id}
       order by stage, created_at desc, id desc
    ) latest`);

  return res.rows
    .map((row) => ({ stage: row.stage, url: row.url, at: new Date(row.at) }))
    .sort((a, b) => (RANK.get(a.stage) ?? 0) - (RANK.get(b.stage) ?? 0));
}
