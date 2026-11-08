import { sql } from 'drizzle-orm';
import { db } from './client.js';
import {
  DEMO_DATABASE, TEST_DATABASE, TEST_DATABASE_SHAPE, isTestRun, type DbEnv,
} from './url.js';

/**
 * 测试进程允许清空的库名形状：`flowers_test`、`flowers_test_ci` 之类。
 *
 * 形状本身住在 `url.ts`（`TEST_DATABASE_SHAPE`）：`db:test:setup` 要用同一条，
 * 两处各写一份正则迟早会「一处放行、一处拒绝」。
 */
const TEST_DATABASE_PATTERN = TEST_DATABASE_SHAPE;

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
      + `（正常应落到 ${TEST_DATABASE}_<runId>，每一轮一张）。`
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
 * 清空 15 张表（P3.2 起加上 `prd_snapshots`，P4-03 起加上 `notification_reads`，
 * 本轮加上 `uemaster_*` 与 `mcp_tokens`；`code_index` 按设计留着，见下）并把自增
 * 序列复位。
 *
 * **守卫就在 truncate 前面**，不再只放在脚本里：以前「用例无条件重置」与
 * 「脚本才有守卫」的组合，在测试连错库时等于一条无声的数据销毁路径——而这正是
 * P0 要堵的事故。现在配置指错时 `resetDb` 自己会抛，一张表都不会被清。
 *
 * 这份清单是**测试边界**的全部内容：不在这里的表就是「跨用例共享」的表。所以
 * 每加一张表都要回答一句「用例会不会往里写行」。本轮补上四张以前没人写进来、
 * 只靠 `truncate … cascade` 的外键顺带清掉的表（`uemaster_artifacts` /
 * `uemaster_jobs` / `uemaster_job_attempts` / `mcp_tokens`）：实测它们确实被
 * cascade 清掉了，但那种「清掉」是**借来的**——哪天有人把外键改成 `set null`、
 * 或者只 truncate `members` 不 truncate `requirements`，行就静默留下。写进来
 * 才是声明，而不是继承。
 *
 * **`blob_index` 故意不在这里**（不是忘了）：
 * - 它没有外键，`cascade` 带不到它，所以它真的会留下来——实测确认过；
 * - 它存的是 ssh 镜像里真实提交的**解析结果**（一块内容 → 符号 / 引用 / 路由声明），
 *   重建要逐个仓扫镜像再解析（两个仓 HEAD 合计 277 行，137 个文件的仓要 1.3 秒），
 *   一次演示重灌不该付这笔账；
 * - 泄漏由它的唯一用户自己收口：`tests/index.test.ts` 与 `tests/blob-index.test.ts`
 *   在 beforeAll / afterAll 里按 fixture 的 blob id `forgetBlobs`，跑完不留痕。
 * 结论：它不是「忘了清」，是「清了更贵，且有明确的收口人」。要改这条结论，先给它
 * 一个能廉价重建的来源。
 *
 * restart identity 只重置「属于这些表的」序列：events_seq_seq / requirements_number_seq
 * 在迁移 0001 里被 `alter sequence ... owned by ...` 绑到了列上，所以编号会回到 1
 * （用例钉着「第一条需求的编号是 1」）。
 */
export const RESET_TABLES = [
  'requirements',
  'review_assignments',
  'prd_snapshots',
  'events',
  'releases',
  'notification_reads',
  'notify_deliveries',
  'members',
  'app_settings',
  'commit_history',
  'locate_runs',
  // 本轮补上的四张：它们以前只被 `cascade` 顺带清掉（外键挂在 members /
  // requirements 上）。写进来是**声明**——「这些表里有行会让下一个用例看到上一轮的
  // 残留」，而不是把这件事继续托付给外键的当前形状。
  'uemaster_artifacts',
  'uemaster_jobs',
  'uemaster_job_attempts',
  'mcp_tokens',
] as const;

/**
 * 故意**不**清的表。清单外的一切都该问一句「为什么」；这个是问过之后答「留下」的。
 *
 * `blob_index`（迁移 0029，0030 之后是这套索引唯一的表）：没有外键指向任何人，
 * `cascade` 带不到它，所以它是真的活下来；而它存的是 ssh 镜像里真实提交的解析结果，
 * 重建要逐个仓扫镜像再解析——一次「重灌演示数据」不该付这笔账。
 *
 * 它的泄漏由唯一用户自己收口：`tests/index.test.ts` 与 `tests/blob-index.test.ts` 在
 * beforeAll / afterAll 里按 fixture 的 blob id `forgetBlobs`，跑完不留痕。也就是说
 * 「不清」不会让下一轮用例看到上一轮的残留：会看残留的那几张表（需求/事件/派单）都在
 * `RESET_TABLES` 里，而内容索引表从来只有 fixture 自己读写。
 *
 * （`code_index` 与 `tree_entry` 已经不在这个清单里了——它们被迁移 0030 删除。
 * `code_index` 是整份快照，`tree_entry` 是「一个提交一整棵树」的映射：前者被内容寻址
 * 取代，后者按 `文件 × 提交` 增长，139 个仓时是几百万行，而 git 列一棵树只要 0.3 秒。）
 */
export const KEPT_TABLES = ['blob_index'] as const;

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
  // 表名只能来自 RESET_TABLES 这个常量（`sql.raw` 不接受任何外部输入）：清单与
  // 真正执行的 SQL 是同一份，用例断言清单就等于断言 SQL，不会漂。
  await db.execute(sql.raw(`truncate ${RESET_TABLES.join(', ')} restart identity cascade`));
  return database;
}

/**
 * 「只清成员」的窄门（`tests/auth.test.ts` 的「一个成员都没有」、`schema.test.ts` 的
 * 建表前置）。
 *
 * 为什么它必须存在、而不是让用例自己写 `truncate members cascade`：那条 SQL 是
 * **不可逆的**，而 `cascade` 会顺着外键递归到 `requirements.owner_member_id`、
 * `review_assignments`、`notification_reads`、`notify_deliveries`、`mcp_tokens`、
 * `uemaster_*`——也就是说，`TEST_DATABASE_URL` 一旦指到演示库，803 条迁移数据会
 * 在这些用例的 beforeAll 里被删掉，**比任何守卫抛错都早**。所以这条窄门和
 * `resetDb` 用同一个 `resetRefusal`：破坏性 SQL 只有一道门，门上的锁只有一把。
 */
export async function truncateMembersOnly(options: ResetOptions = {}): Promise<string> {
  const database = options.guardDatabase ?? await currentDatabase();
  const refusal = resetRefusal(database, process.env.FLOWERS_ALLOW_RESET, options.env ?? process.env);
  if (refusal !== null) throw new Error(refusal);

  await db.execute(sql`truncate members restart identity cascade`);
  return database;
}

/**
 * 库里有多少条「从旧系统迁移来的真数据」：`legacy_ref` 非空。
 *
 * 为什么以这一列为准：`scripts/migrate-flower.ts` 每迁一条都写 `legacy_ref`（旧系统
 * 的主键），而演示种子写的 12 条一律为 null。所以「数这一列」正好等于「数真数据」，
 * 不需要再维护一张「哪些是演示」的名单——名单会漂，列不会。
 */
export async function countMigratedRequirements(): Promise<number> {
  const res = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from requirements where legacy_ref is not null`,
  );
  return Number(res.rows[0]?.n ?? 0);
}

/** 迁移数据守卫的开关：`force` 必须是**第二个**刻意的动作（命令行参数或环境变量）。 */
export type MigratedGuardOptions = {
  force?: boolean;
  database?: string;
};

/**
 * `--reset` 之前的最后一道门：库里有迁移数据时拒绝。
 *
 * 谁是最后一道门、为什么在这里：
 * `/tmp/restore-demo.sh` 那种一键脚本不在版本库里（换台机器就没有了，也没人 review
 * 它的 diff），而它今天被反射般地按了十几次。所以真正能负责的门必须住在**会被提交、
 * 会被读到、会被测试钉住**的那一侧——`scripts/seed.ts` 调用这里，`tests/reset.test.ts`
 * 钉住它。脚本那侧只允许是「打印 + 转调」，不许是唯一实现。
 *
 * 为什么拒绝而不是「跳过 requirements 只清别的」：`--reset` 的语义就是「从一张空库
 * 重灌 12 条演示需求」，它对 requirements 是 `truncate … restart identity cascade`，
 * 连编号一起回到 1。半清（只清 members 或只清 events）会留下一张「有 803 条真需求、
 * 但成员被换掉、编号还接着涨」的库——那比拒绝更难发现。要么全清（第二个开关），
 * 要么一条都不动。
 *
 * 返回迁移行数（放行时调用方可以把它打进日志，让「清了几条」出现在屏幕而不是脑子里）。
 */
export async function assertNoMigratedRequirements(
  options: MigratedGuardOptions = {},
): Promise<number> {
  const migrated = await countMigratedRequirements();
  if (migrated === 0 || options.force === true) return migrated;

  const where = options.database === undefined ? '这张库' : `库「${options.database}」`;
  throw new Error(
    `拒绝重置：${where}里有 ${migrated} 条从旧系统迁移来的需求（legacy_ref 非空）。`
    + '--reset 会 truncate requirements … restart identity cascade，'
    + `把这 ${migrated} 条连同它们的历史一起删掉，编号也会从 1 重新开始；`
    + '而迁移不会自己回来（重跑迁移会覆盖人工修正过的那部分）。'
    + '确实要清空（例如只要一屏演示数据），请显式加上第二个开关——一次是命令，两次才是决定：'
    + 'npm run seed -- --reset --force-with-migrated'
    + '（或 FLOWERS_WIPE_MIGRATED=1）。'
    + '只想刷新演示数据、保留迁移数据，请跑 /tmp/restore-demo.sh 的安全路径。',
  );
}

