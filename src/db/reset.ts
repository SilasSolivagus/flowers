import { sql } from 'drizzle-orm';
import { db } from './client.js';
import { DEMO_DATABASE, TEST_DATABASE, isTestRun, type DbEnv } from './url.js';

/**
 * 测试进程允许清空的库名形状：`flowers_test`、`flowers_test_ci` 之类。
 *
 * 为什么用「名字以 _test 结尾」而不是一张白名单：白名单只认识 `flowers_test`，
 * 有人用 `TEST_DATABASE_URL` 建一张 `flowers_test_ci` 就会被守卫拦死；而这条正则
 * 对**演示库 `flowers` 永远不成立**——这才是要紧的那一半。
 */
const TEST_DATABASE_PATTERN = /_test(_|$)/;

/**
 * 是否放行重置。
 *
 * 两条完全不同口径的路，分开写：
 *
 * 1. **测试进程**（`VITEST=true` / `NODE_ENV=test`）：只许清名字带 `_test` 的库，
 *    且**故意不看 `FLOWERS_ALLOW_RESET`**。那个口子是给 `scripts/seed.ts` /
 *    `scripts/demo.ts` 手工清演示库用的；测试若能用它去清 `flowers`，本任务就
 *    白做了——「配置指错 → 演示数据被截断」正是要堵的那起事故。
 * 2. **非测试进程**：保持原口径——库名是 `flowers`，或显式 `FLOWERS_ALLOW_RESET=1`。
 *
 * 写成纯函数是因为这条判断必须能被用例钉死，而不必为了测一条守卫去造一张假库。
 */
export function shouldAllowReset(
  database: string,
  allowFlag: string | undefined,
  env: DbEnv = {},
): boolean {
  if (isTestRun(env)) return TEST_DATABASE_PATTERN.test(database);
  return allowFlag === '1' || database === DEMO_DATABASE;
}

/**
 * 拒绝的理由（放行时返回 null）。
 *
 * 分开成「判断 + 理由」两段，是为了让拒绝时说清**怎么办**：这个守卫唯一的现实
 * 触发场景就是「测试配置指错库」，报错里必须直接点名 `TEST_DATABASE_URL` 与
 * `npm run db:test:setup`，否则下一个人只会看到一句「拒绝清空」然后去搜代码。
 */
export function resetRefusal(
  database: string,
  allowFlag: string | undefined,
  env: DbEnv = {},
): string | null {
  if (shouldAllowReset(database, allowFlag, env)) return null;
  if (isTestRun(env)) {
    return `拒绝清空：测试进程当前的库是「${database}」，而测试只允许清名字以 _test 结尾的库`
      + `（正常应落到 ${TEST_DATABASE}）。`
      + '这几乎一定是 TEST_DATABASE_URL 指到了演示库——改回来（或删掉这个变量）再跑：'
      + 'npm run db:test:setup';
  }
  return `拒绝重置：当前库是「${database}」，不是 ${DEMO_DATABASE}。`
    + '这个操作会清空它——确认要清空，请设 FLOWERS_ALLOW_RESET=1。';
}

/** 问库「你是谁」：`current_database()` 是服务端给的答案，与真正会被 truncate 的那张库是同一个东西。 */
export async function currentDatabase(): Promise<string> {
  const res = await db.execute<{ name: string }>(sql`select current_database() as name`);
  return res.rows[0]?.name ?? '';
}

/**
 * 脚本（seed / demo）在重置前用的守卫：问库自己叫什么，不放行就抛。
 *
 * 与 `resetDb` 里的守卫重复一次是刻意的：脚本还要在「清空」之外做别的事（灌数据、
 * 跑整条链路），越早失败越好；而 `resetDb` 是最后一道闸，它必须自己也会拒绝。
 */
export async function assertSafeToReset(): Promise<string> {
  const database = await currentDatabase();
  const refusal = resetRefusal(database, process.env.FLOWERS_ALLOW_RESET, process.env);
  if (refusal !== null) throw new Error(refusal);
  return database;
}

/** 只给用例用的注入口：把「守卫以为自己在清哪张库」钉成假名字，真连的库不变。 */
export type ResetOptions = {
  guardDatabase?: string;
  env?: DbEnv;
};

/**
 * 清空八张表（P3.2 起加上 `prd_snapshots`，P4-03 起加上 `notification_reads`）
 * 并把自增序列复位。
 *
 * **守卫就在 truncate 前面**，不再只放在脚本里：以前「用例无条件重置」与
 * 「脚本才有守卫」的组合，在测试连错库时等于一条无声的数据销毁路径——而这正是
 * P0 要堵的事故。现在配置指错时 `resetDb` 自己会抛，一张表都不会被清。
 *
 * restart identity 只重置「属于这些表的」序列：events_seq_seq / requirements_number_seq
 * 在迁移 0001 里被 `alter sequence ... owned by ...` 绑到了列上，所以编号会回到 1
 * （用例钉着「第一条需求的编号是 1」）。
 */
export async function resetDb(options: ResetOptions = {}): Promise<string> {
  const database = options.guardDatabase ?? await currentDatabase();
  const refusal = resetRefusal(database, process.env.FLOWERS_ALLOW_RESET, options.env ?? process.env);
  if (refusal !== null) throw new Error(refusal);

  // 原子性用例会建这个触发器；进程被 kill 时它会留在库里，而 truncate 清不掉
  // 触发器，之后每个写事件的用例都会撞 'boom'。先 drop 再 truncate。
  await db.execute(sql`drop trigger if exists flowers_test_boom on events`);
  // notification_reads（P4-03）跟着 members 一起清：它没有自己的生命周期，
  // 主键就是 member_id，留着只会让下一次种子的同 id 成员继承别人的已读位置。
  // notify_deliveries（P4-07）同理：它是「发给某个人的某条事件」的记号，人与事件
  // 都重置了，记号必须一起清——否则下一轮的用例会看到上一轮留下的「已发送」。
  await db.execute(sql`truncate requirements, review_assignments, prd_snapshots, events, releases, notification_reads, notify_deliveries, members, app_settings, commit_history, locate_runs restart identity cascade`);
  return database;
}
