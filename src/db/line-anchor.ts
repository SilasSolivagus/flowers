import { sql } from 'drizzle-orm';
import { db, type Db } from './client.js';
import { leadRoleOf } from '../core/auth/roles.js';

/**
 * 数据迁移：把**还开着的评审派单**从「按需求类型」重算到「按负责人的条线」（P4-06）。
 *
 * 为什么必须有这一支：派单行（`review_assignments.verdict = 'handed'`）是在旧模型下
 * 造出来的——商业类派给商业线负责人、功能类派给功能线负责人。旧模型里那是对的；新模型
 * 里锚点是负责人的条线，于是同一条需求「该谁签」可能已经换了人。不重算的后果不是
 * 界面难看，而是**错的人能签**：一条商业类需求由功能线 PM 负责时，商业线负责人会在
 * 旧派单的授权下继续签字，而功能线负责人（真正该管的人）签不了。一个错签字的人比
 * 一个没人签的需求坏得多——没人签至少看得见（评审段空着），签错了是记录。
 *
 * 三条规则，与 `can()` 同口径：
 *
 * 1. 负责人有明确条线，那条线也有活着的负责人 → 派单改到那个人身上。
 * 2. 负责人没有条线（今天只有超管）→ 把派单**作废**（`verdict = 'voided'` + 一句中文
 *    原因）。不作废就得留着一个「待签」的错人：他签不了（`can('review')` 不给），
 *    但抽屉会一直显示「等他签」——一句假话。作废之后这一条只剩超管能签，且
 *    `reviewerMemberId` 为 null，`can('review')` 对超管放行。
 * 3. 需求根本没有负责人 → 同样作废，原因写「认领后再派单」。无主的需求没有条线，
 *    谁都不该替它签；认领之后重新提交评审会再派一次单。
 *
 * 幂等：已经是正确评审人的行不动（计入 `kept`），所以这支可以重复跑。
 *
 * **这是数据迁移，不是 schema 迁移**：`npm run db:anchor`（`scripts/migrate-line-anchor.ts`）。
 * 种子（`npm run seed`）走的是真实服务，不依赖这支；但已经跑起来的库必须有它，
 * 否则「代码换了锚点、数据还按类型派着单」这个中间状态会一直存在。
 */

export type LineAnchorMove = {
  number: number;
  title: string;
  /** 旧派单上的评审人（按类型派出来的那一个）。 */
  from: string;
  /** 新派单上的评审人（负责人所在条线的负责人）。 */
  to: string;
};

export type LineAnchorVoid = {
  number: number;
  title: string;
  /** 负责人姓名；null = 没有负责人。 */
  owner: string | null;
  /** 被作废的那张派单上的评审人。 */
  reviewer: string;
  /** 为什么作废 / 谁来签（中文，直接能贴进报告）。 */
  why: string;
};

export type LineAnchorReport = {
  moved: LineAnchorMove[];
  voided: LineAnchorVoid[];
  /** 本来就正确、一行没动的派单数。 */
  kept: number;
  /** 没有负责人的条线（用来解释「为什么有些单没人接」）。 */
  unowned: number;
};

type OpenRow = {
  assignment_id: string;
  number: number;
  title: string;
  owner_member_id: string | null;
  owner_name: string | null;
  owner_line: string | null;
  reviewer_id: string;
  reviewer_name: string;
  lead_id: string | null;
  lead_name: string | null;
};

const VOID_NO_OWNER = '需求还没有负责人：认领后再派单';
const VOID_NO_LINE = '负责人没有条线：改由超管评审';

/**
 * 重算所有开着的派单，返回一份可打印的报告（做了哪些改动、哪些留给超管）。
 *
 * 全程一个事务：作废与改派要么一起成立，要么一起不成立。半途失败留下的
 * 「一半按人、一半按类型」的状态比两种都糟——它看起来像迁移完成了。
 */
export async function realignOpenReviewAssignments(
  database: Db = db,
): Promise<LineAnchorReport> {
  return database.transaction(async (tx) => {
    const rows = await tx.execute<OpenRow>(sql`
      select ra.id as assignment_id,
             r.number, r.title,
             r.owner_member_id,
             own.name as owner_name,
             own.line as owner_line,
             ra.reviewer_member_id as reviewer_id,
             cur.name as reviewer_name,
             lead.id as lead_id,
             lead.name as lead_name
        from review_assignments ra
        join requirements r on r.id = ra.requirement_id
        left join members own on own.id = r.owner_member_id
        left join members cur on cur.id = ra.reviewer_member_id
        left join members lead
          on lead.line = own.line
         and lead.role = case own.line
                          when 'feature' then 'feature_reviewer'
                          when 'commercial' then 'commercial_reviewer'
                        end
         and lead.deactivated_at is null
       where ra.verdict = 'handed'
         and r.deleted_at is null
       order by r.number, ra.id`);

    const report: LineAnchorReport = { moved: [], voided: [], kept: 0, unowned: 0 };

    for (const row of rows.rows) {
      const number = Number(row.number);

      if (row.owner_member_id === null) {
        // 无主：没人该替它签。作废并说清「先认领」。
        await tx.execute(sql`
          update review_assignments
             set verdict = 'voided', reason = ${VOID_NO_OWNER}, decided_at = now()
           where id = ${row.assignment_id} and verdict = 'handed'`);
        report.voided.push({
          number, title: row.title, owner: null, reviewer: row.reviewer_name, why: VOID_NO_OWNER,
        });
        report.unowned += 1;
        continue;
      }

      // 负责人没有条线，或那条线认不出：没有可锚的线，回超管。
      if (row.owner_line === null || leadRoleOf(row.owner_line) === null) {
        await tx.execute(sql`
          update review_assignments
             set verdict = 'voided', reason = ${VOID_NO_LINE}, decided_at = now()
           where id = ${row.assignment_id} and verdict = 'handed'`);
        report.voided.push({
          number, title: row.title, owner: row.owner_name, reviewer: row.reviewer_name, why: VOID_NO_LINE,
        });
        continue;
      }

      // 那条线没有活着的人担任负责人：留给人来配（不静默改成别的线的人）。
      if (row.lead_id === null) {
        await tx.execute(sql`
          update review_assignments
             set verdict = 'voided',
                 reason = ${`${row.owner_line} 条线还没有配负责人：补配之后重新提交评审`},
                 decided_at = now()
           where id = ${row.assignment_id} and verdict = 'handed'`);
        report.voided.push({
          number,
          title: row.title,
          owner: row.owner_name,
          reviewer: row.reviewer_name,
          why: `${row.owner_line} 条线还没有配负责人`,
        });
        continue;
      }

      if (row.lead_id === row.reviewer_id) {
        report.kept += 1;
        continue;
      }

      await tx.execute(sql`
        update review_assignments
           set reviewer_member_id = ${row.lead_id}
         where id = ${row.assignment_id} and verdict = 'handed'`);
      report.moved.push({
        number, title: row.title, from: row.reviewer_name, to: row.lead_name ?? '',
      });
    }

    return report;
  });
}
