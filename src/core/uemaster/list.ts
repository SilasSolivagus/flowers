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
   * 「我在覆盖第几版」是人在按下「重新生成」之前要知道的事实——回给界面的是一个
   * 数字，不是一句说明（P4-02 的 labels-only 口径）。
   */
  versions: number;
  /**
   * **这一行的内容已经不在磁盘上了**（2026-11-10 owner 的第一次纠正）。
   *
   * 它只对存量数据为真：2026-11-10 之前产物按固定文件名落盘（`evaluate.html`），
   * 同一条需求生成两次 = 库里两行、盘上一份文件，第二份把第一份覆盖掉了。那些更早的
   * 行于是指向一个**已经属于后来那一版**的文件：点开看到的是别人的内容。
   *
   * 值由迁移 0036 算出来并落库（同一 (需求, stage, url) 组里除最新一行外都标 true），
   * 读侧原样带出、不推算：这条信息说的是「当时发生了什么」，而磁盘现在长什么样是
   * 另一件事（`filePresent`）。两件事都要说，且**不许用一件冒充另一件**——把覆盖过的
   * 行按「文件还在」显示成一份可读的历史，就是在编数据。
   */
  contentLost: boolean;
};

/** stage 的固定次序：读模型按它排三行，不按时间。 */
const RANK = new Map<Stage, number>(STAGES.map((stage, i) => [stage, i]));

/**
 * 取一条需求的**全部**产物行（每个 stage 的每一版），每个 stage 内最新的在最前面。
 *
 * 2026-11-10 起从「每个 stage 只给最新一行」改成「全给」：抽屉里那三行现在是
 * 「最新一份 + 历史（N 版）」，而历史版本必须**打得开**（owner 的原话）。只给最新一行
 * 的话，旧版本在库里有、在盘上有、在界面上却没有任何入口——那和丢掉只差一步。
 *
 * 排序：先按 stage 的固定次序（evaluate / review / inspect，三行是对外的固定槽位，
 * 顺序变了抽屉里的行会自己搬家），同一 stage 内按 `created_at desc, id desc`——时间
 * 相同（同一毫秒插两行）时用 id 定序，保证同一份数据每次读出同一个答案，否则刷新
 * 页面历史行会来回跳。
 *
 * `versions` 仍是「这一组一共几行」，用窗口函数一次算出来（`count(*) over
 * (partition by stage)`），不必为它再查一次。
 *
 * requirementId 先按 uuid 校验，不让 PG 的 22P02 漏成 500；需求不存在时返回空数组
 * ——「没有产物」和「没有这条需求」在读侧是同一个答案（三行都不显示），不必报错。
 */
export async function listArtifacts(db: Db, requirementId: string): Promise<ArtifactRef[]> {
  const id = parseRequirementId({ requirementId });

  const res = await db.execute<{
    stage: Stage; url: string; at: Date; input_hash: string | null;
    versions: number; content_lost: boolean;
  }>(sql`
    select stage, url, created_at as at, input_hash, content_lost,
           count(*) over (partition by stage) as versions
      from uemaster_artifacts
     where requirement_id = ${id}
     order by stage, created_at desc, id desc`);

  return res.rows
    .map((row) => ({
      stage: row.stage,
      url: row.url,
      at: new Date(row.at),
      inputHash: row.input_hash,
      versions: Number(row.versions),
      contentLost: row.content_lost === true,
    }))
    .sort((a, b) => {
      const byStage = (RANK.get(a.stage) ?? 0) - (RANK.get(b.stage) ?? 0);
      // stage 内保持 SQL 给的顺序（`created_at desc`）：`sort` 是稳定排序，所以相等时
      // 不会把同一 stage 的行重新洗一遍。`at` 再比一次只是为了让「相等」这件事显式。
      return byStage !== 0 ? byStage : b.at.getTime() - a.at.getTime();
    });
}
