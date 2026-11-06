import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { parseRequirementId } from '../validate.js';
import { STAGES, type Stage } from './packs.js';

export type ArtifactRef = {
  stage: Stage;
  url: string;
  at: Date;
  /**
   * 生成这份产物时需求描述的指纹（P4-02），null = 那一版没记（老产物 / 人手 attach）。
   *
   * 读模型只把它**带出来**，不解释：`fresh` / `stale` / `unknown` 由调用方拿它与
   * 当前描述的指纹比（`requirements/fingerprint.ts` 的 `freshnessOf`）。在这里算的
   * 话，`listArtifacts` 就得为每条需求再查一次描述——而它的调用方（抽屉）本来就有
   * 那一行。
   */
  inputHash: string | null;
  /**
   * 这个 stage 一共存过几版（= `uemaster_artifacts` 里同一 (需求, stage) 的行数）。
   *
   * 读侧只认最新一行，但「我在覆盖第几版」是人在按下「重新生成」之前要知道的事实
   * ——回给界面的是一个数字，不是一句说明（P4-02 的 labels-only 口径）。
   */
  versions: number;
};

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

  /**
   * `count(*) over (partition by stage)` 与 `distinct on` 在同一个 select 里是安全的：
   * PG 的求值顺序是 窗口函数 → DISTINCT → ORDER BY，所以窗口数的是**这一组的总行数**，
   * 而 `distinct on` 随后只留下一行。多一次分组扫描换来「不用第二次查询就问出版本数」。
   */
  const res = await db.execute<{
    stage: Stage; url: string; at: Date; input_hash: string | null; versions: number;
  }>(sql`
    select stage, url, at, input_hash, versions from (
      select distinct on (stage) stage, url, created_at as at, id, input_hash,
             count(*) over (partition by stage) as versions
        from uemaster_artifacts
       where requirement_id = ${id}
       order by stage, created_at desc, id desc
    ) latest`);

  return res.rows
    .map((row) => ({
      stage: row.stage,
      url: row.url,
      at: new Date(row.at),
      inputHash: row.input_hash,
      versions: Number(row.versions),
    }))
    .sort((a, b) => (RANK.get(a.stage) ?? 0) - (RANK.get(b.stage) ?? 0));
}
