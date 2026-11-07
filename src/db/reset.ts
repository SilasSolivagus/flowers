import { sql } from 'drizzle-orm';
import { db } from './client.js';

/**
 * 库里允许被重置的那张库。
 *
 * `resetDb` 是 truncate 六张表、`restart identity cascade` —— 对生产库就是一个瞬间的
 * 空库。用例天天调它是安全的（跑的就是这张 flowers），但脚本不是：`scripts/demo.ts`
 * 尊重 `DATABASE_URL`，有人把它指到线上库跑一次冒烟，数据就没了。
 */
const ALLOWED_DATABASE = 'flowers';

/**
 * 是否放行重置。
 *
 * 两个条件满足其一：库名正是 flowers，或显式设了 `FLOWERS_ALLOW_RESET=1`
 * （给「测试库不叫 flowers」的环境留的口子）。写成纯函数是为了能直接钉住判断本身，
 * 不必为了测一条守卫去造一个假库。
 */
export function shouldAllowReset(database: string, allowFlag: string | undefined): boolean {
  return allowFlag === '1' || database === ALLOWED_DATABASE;
}

/**
 * 真正去问库「你是谁」，不是看 `DATABASE_URL` 字符串。
 *
 * 为什么不看环境变量：`DATABASE_URL` 可能缺省、可能被连接串里的库名覆盖、
 * 也可能指向一个解析到别的库的主机；`current_database()` 是服务端给出的答案，
 * 与真正会被 truncate 的那张库是同一个东西。
 *
 * 守卫放在脚本里、不放进 resetDb 本身：用例必须能无条件重置（否则每条用例都得带
 * 一个环境变量），而危险的那条路只有脚本。
 */
export async function assertSafeToReset(): Promise<string> {
  const res = await db.execute<{ name: string }>(sql`select current_database() as name`);
  const database = res.rows[0]?.name ?? '';
  if (!shouldAllowReset(database, process.env.FLOWERS_ALLOW_RESET)) {
    throw new Error(
      `拒绝重置：当前库是「${database}」，不是 ${ALLOWED_DATABASE}。`
      + '这个操作会清空它——确认要清空，请设 FLOWERS_ALLOW_RESET=1。',
    );
  }
  return database;
}

/**
 * 清空八张表（P3.2 起加上 `prd_snapshots`，P4-03 起加上 `notification_reads`）
 * 并把自增序列复位。
 *
 * restart identity 只重置「属于这些表的」序列：events_seq_seq / requirements_number_seq
 * 在迁移 0001 里被 `alter sequence ... owned by ...` 绑到了列上，所以编号会回到 1
 * （用例钉着「第一条需求的编号是 1」）。
 */
export async function resetDb() {
  // 原子性用例会建这个触发器；进程被 kill 时它会留在库里，而 truncate 清不掉
  // 触发器，之后每个写事件的用例都会撞 'boom'。先 drop 再 truncate。
  await db.execute(sql`drop trigger if exists flowers_test_boom on events`);
  // notification_reads（P4-03）跟着 members 一起清：它没有自己的生命周期，
  // 主键就是 member_id，留着只会让下一次种子的同 id 成员继承别人的已读位置。
  await db.execute(sql`truncate requirements, review_assignments, prd_snapshots, events, releases, notification_reads, members, app_settings restart identity cascade`);
}
