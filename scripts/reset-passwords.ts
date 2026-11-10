/**
 * 全员重置密码（切换日的一次性动作，2026-11-10）。
 *
 * ```bash
 * npx tsx scripts/reset-passwords.ts                 # 预览：谁会被重置、谁已经有密码
 * npx tsx scripts/reset-passwords.ts --apply         # 真写（默认密码见 password.ts）
 * npx tsx scripts/reset-passwords.ts --apply --password 'XXXXXXXX'
 * ```
 *
 * ── 为什么必须重置，而不是把 Flower 的哈希搬过来
 *
 * Flower 用 `@node-rs/argon2`（argon2id），flowers 用 `node:crypto` 的 scrypt，两边的
 * 串格式完全不同（`$argon2id$…` vs `scrypt$16384$8$1$<salt>$<key>`）。搬过来等于所有
 * 人都验证失败——而且失败信息与「密码错」一模一样，第二天会被当成登录故障排查半天。
 *
 * 所以切换前统一设成 `DEFAULT_MEMBER_PASSWORD`，在群里公告；登录后自己改。
 *
 * ── 为什么只重置「在用」的人
 *
 * `deactivated_at is not null` 的不碰：他们是已经离开的人，重置只会让一个不该能登录的
 * 账号重新有一条可用密码。
 */
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import { DEFAULT_MEMBER_PASSWORD, setPassword } from '../src/core/auth/password.js';
import { roleLabel } from '../app/settings/roles.js';

type Args = { apply: boolean; password: string };

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, password: DEFAULT_MEMBER_PASSWORD };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') { args.apply = true; continue; }
    if (arg === '--password') {
      const value = argv[i + 1];
      if (!value) throw new Error('--password 要给一个值');
      args.password = value;
      i += 1;
      continue;
    }
    throw new Error(`认不出的参数：${arg}（只认 --apply / --password X）`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

try {
  const rows = (await db.execute<{
    id: string; name: string; email: string; role: string;
    has_password: boolean; created_at: string;
  }>(sql`
    select id, name, email, role, password_hash is not null as has_password,
           created_at::date::text as created_at
      from members
     where deactivated_at is null
     order by role, name`)).rows;

  const withoutPassword = rows.filter((row) => !row.has_password);

  process.stdout.write(
    `${args.apply ? '真执行' : '预览（什么都没改）'}｜在册 ${rows.length} 人`
    + `｜其中还没有密码 ${withoutPassword.length} 人\n`,
  );
  for (const row of rows) {
    process.stdout.write(
      `  ${row.name.padEnd(8, ' ')} ${row.email.padEnd(28, ' ')} ${roleLabel(row.role).padEnd(12, ' ')}`
      + `${row.has_password ? '' : '（无密码）'}\n`,
    );
  }

  if (!args.apply) {
    process.stdout.write('\n--dry-run：没有改任何密码。要真写请加 --apply。\n');
  } else {
    for (const row of rows) {
      await setPassword(db, row.id, args.password);
    }
    process.stdout.write(`\n已重置 ${rows.length} 人的密码。公告里要写：\n`);
    process.stdout.write(`  账号 = 你的邮箱；初始密码 = ${args.password}\n`);
    process.stdout.write('  登录后请在「设置 · 我的」里改掉。\n');
  }
} finally {
  await pool.end();
}
