/**
 * 花名册导入（2026-11-10，切换前的第一步）。
 *
 * ```bash
 * npx tsx scripts/import-members.ts           # 预览：谁会被建、谁是已有的
 * npx tsx scripts/import-members.ts --apply   # 真写（密码统一为初始密码）
 * ```
 *
 * ── 为什么需要它
 *
 * `migrate-flower.ts` 只搬**需求**：它按 `display_name` 去花名册里找负责人，找不到就
 * 留空（「待接单」）。所以空库上直接跑迁移的结果是——804 条需求、**0 个人**、全员无主、
 * 谁也登不进来。这在 2026-11-10 的首次部署上真的发生了（`reset-passwords` 报「在册 0 人」）。
 *
 * ── 名单从哪来
 *
 * 不是从 Flower 全量搬（那是一个多组织平台，几百号人，包括已经离职的）：flowers 是
 * **产品团队的需求门禁**，只收这批人。名字与邮箱取自生产 Flower 花名册里对应的那 7 个
 * 账号（登录名是公司统一口径 `<拼音>@123pan.com`），角色/条线按 P4-04 的四个角色落位：
 *
 * - `product_owner` 超管：房超
 * - `commercial_reviewer` 商业线负责人：赵越
 * - `feature_reviewer` 功能线负责人：吕正豪
 * - `pm`：吕品（功能线）、李嘉（商业线）、王妍（商业线）、罗丹（商业线）
 *
 * 这份映射是**产品决定**，所以写在代码里、不在运行时猜：Flower 的 `org_role` 只有
 * admin/member/guest 三档，`function_tag` 是给工单打标签用的，两者都推不出「谁是
 * 商业线负责人」。
 *
 * ── 幂等
 *
 * 按邮箱 upsert：已存在的人只补角色/条线（不动密码与通知口味——那些是本人改过的）。
 * 新建的人拿 `DEFAULT_MEMBER_PASSWORD`，登录后自改。
 */
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import { DEFAULT_MEMBER_PASSWORD, setPassword } from '../src/core/auth/password.js';
import { ROSTER, type RosterEntry } from '../src/core/migrate/roster.js';

export { ROSTER } from '../src/core/migrate/roster.js';


const apply = process.argv.includes('--apply');

try {
  const existing = (await db.execute<{ email: string; name: string; role: string }>(sql`
    select email, name, role from members order by email`)).rows;
  const byEmail = new Map(existing.map((row) => [row.email, row]));

  process.stdout.write(`${apply ? '真执行' : '预览（什么都没改）'}｜名册 ${existing.length} 人｜本次候选 ${ROSTER.length} 人\n`);

  let created = 0;
  let updated = 0;

  for (const person of ROSTER) {
    const found = byEmail.get(person.email);
    if (found === undefined) {
      created += 1;
      process.stdout.write(`  + ${person.name} <${person.email}> ${person.role}${person.line === null ? '' : ` / ${person.line}`}\n`);
      if (!apply) continue;
      const inserted = await db.execute<{ id: string }>(sql`
        insert into members (name, email, role, line)
        values (${person.name}, ${person.email}, ${person.role}, ${person.line})
        returning id`);
      await setPassword(db, inserted.rows[0]!.id, DEFAULT_MEMBER_PASSWORD);
      continue;
    }

    const same = found.role === person.role;
    if (!same) {
      updated += 1;
      process.stdout.write(`  ~ ${person.name} <${person.email}> 角色 ${found.role} → ${person.role}\n`);
      if (apply) {
        await db.execute(sql`
          update members set role = ${person.role}, line = ${person.line}
           where email = ${person.email}`);
      }
    }
  }

  process.stdout.write(`\n${apply ? '已写入' : '待写入'}：新建 ${created} 人 · 改角色 ${updated} 人\n`);
  if (!apply) process.stdout.write('--dry-run：没有写库。要真写真加 --apply。\n');
  else process.stdout.write(`初始密码：${DEFAULT_MEMBER_PASSWORD}（登录后自改）\n`);
} finally {
  await pool.end();
}
