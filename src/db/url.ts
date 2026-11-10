/**
 * 连接串解析：测试进程连哪张库，就由这一条纯函数决定。
 *
 * 为什么要单独一层：在这之前 `npx vitest run` 和演示库是**同一张 `flowers`**，
 * 用例里的 `resetDb()` 会把 12 条演示需求、6 行 `app_settings` 里的真 provider /
 * 镜像配置一起 truncate 掉，于是「跑测试 → 手工重灌」成了每次验证的固定动作。
 * 把「跑测试落到哪张库」写成不碰数据库、不看全局状态的纯函数，是这件事唯一能被
 * 用例钉住的地方——否则只能靠跑一遍全量测试再去看演示库还在不在。
 */

/** 演示库：`npm run seed` / 看板 / 手工验证用的那张。 */
export const DEMO_DATABASE = 'flowers';

/**
 * 测试库的**基名**：`npm run db:test:setup` 建出来的那张。
 *
 * 2026-11-08 起它只是「基名」：每次 `npx vitest run` 实际用的是
 * `flowers_test_<runId>`（见 `testDatabaseName`）。原因是一次实测——两个 vitest
 * 同时在跑时共用 `flowers_test`，互相把对方的行 truncate 掉，60 个用例集体变红，
 * 看上去像一次真回归，排查花了半小时。共用一张库这件事，在「并行」是默认姿势的
 * 时代就是错的：测试之间唯一可靠的隔离是**不共享任何可变状态**，库也算状态。
 */
export const TEST_DATABASE = 'flowers_test';

/**
 * 这次测试跑用哪个 runId（决定库名后缀）。
 *
 * 三个来源，优先级从高到低：
 * 1. `FLOWERS_TEST_RUN_ID`——由 `vitest.config.ts` 在**主进程**生成一次，通过
 *    `test.env` 发给每一个 worker。这是唯一「整轮唯一、且所有 worker 与 globalSetup
 *    看到同一个值」的来源，所以它是主路。
 * 2. `VITEST_POOL_ID`——vitest 自己设的**worker**编号。它不稳：一轮测试的文件会被
 *    分给不同 worker，用它当库名会让同一轮里的文件各拿一张库（而 globalSetup 只建了
 *    一张），于是「表不存在」。只在没有第 1 条时兜底。
 * 3. `process.pid`——最朴素的兜底（手工 `NODE_ENV=test tsx ...` 时用）。
 *
 * 字符集：库名要进 `create database "…"` 的标识符位置，`SAFE_DATABASE_NAME` 只放行
 * 字母数字下划线，所以这里先把非法字符换掉，而不是让下游去拒绝。
 */
export function testRunId(env: DbEnv = process.env, pid: number = process.pid): string {
  const explicit = env.FLOWERS_TEST_RUN_ID?.trim();
  if (explicit !== undefined && explicit !== '') return explicit.replace(/[^\w]/g, '_');
  const pool = env.VITEST_POOL_ID?.trim();
  if (pool !== undefined && pool !== '') return `w${pool}`;
  return `p${pid}`;
}

/** 这一轮的测试库名：`flowers_test_<runId>`。 */
export function testDatabaseName(env: DbEnv = process.env, pid: number = process.pid): string {
  return `${TEST_DATABASE}_${testRunId(env, pid)}`;
}

/** 本地默认连接串（与 docker-compose.yml 的 54330 端口一致）。 */
const DEFAULT_DATABASE_URL = 'postgres://postgres:flowers@localhost:54330/flowers';

/** 只看这几个键；写成 Record 是为了让用例能凭空造一份 env，不必改 process.env。 */
export type DbEnv = Record<string, string | undefined>;

/**
 * 是否在测试进程里。
 *
 * `VITEST` 由 vitest 自己设成字符串 `'true'`；`NODE_ENV === 'test'` 是给别的
 * 运行器（以及手工 `NODE_ENV=test tsx ...`）留的同一条路。
 */
export function isTestRun(env: DbEnv): boolean {
  return env.VITEST === 'true' || env.NODE_ENV === 'test';
}

/**
 * 一张库算不算「测试库」：名字带 `_test`（`flowers_test`、`flowers_test_ci`）。
 *
 * 为什么用形状而不是白名单：白名单只认识 `flowers_test`，有人用 `TEST_DATABASE_URL`
 * 建一张 `flowers_test_ci` 就会被守卫拦死；而这条正则对**演示库 `flowers` 永远不成立**
 * ——这才是要紧的那一半。
 *
 * 写在这里（而不是 `reset.ts`）是因为现在有两个门要用同一条形状：清空前的守卫
 * （`reset.ts`）与 `db:test:setup` 建库/跑迁移前的那道（脚本）。两边各抄一份正则，
 * 早晚会一份改了另一份没改，于是「一处放行、一处拒绝」。
 */
export const TEST_DATABASE_SHAPE = /_test(_|$)/;

/**
 * `npm run db:test:setup` 的库名形状检查（放行时返回 null）。
 *
 * 与 `resetRefusal` 是两个不同的风险、两句话：那条守的是「别把数据 truncate 掉」，
 * 这条守的是「别把**表结构**建到真库上」。后者更隐蔽——库里只是多了几张空表，
 * 看板照常打开，等哪天有人往 requirements 里灌演示数据才发现演示库被测试迁移改过。
 * 所以必须在 `create database` / `migrate` 之前拒绝，且报错要点名那个变量。
 */
export function testDatabaseShapeRefusal(database: string): string | null {
  if (TEST_DATABASE_SHAPE.test(database)) return null;
  return `拒绝初始化测试库：库名「${database}」里没有 _test，不像一张测试库。`
    + 'db:test:setup 会在这张库里建表、跑迁移——如果它就是演示库 flowers，'
    + '等于把表结构写进了有真数据的那张库。'
    + `请把 TEST_DATABASE_URL 改成 …_test（或删掉这个变量，默认落到 ${TEST_DATABASE}）再跑。`;
}

/**
 * 「库不存在」的说明书（`3D000`）。
 *
 * 新克隆一份仓库、`npm run db:up` 之后直接 `npx vitest run`，第一个查询就会死在
 * 裸的 `error: database "flowers_test" does not exist`——一句没有任何指向的英文。
 * 这条路径唯一的现实原因就是「还没跑 db:test:setup」，所以直接把那句命令写进报错。
 */
export function missingDatabaseRefusal(database: string): string {
  return `测试库 ${database} 不存在。`
    + '`npx vitest run` 会自己建本轮那张库并跑迁移，所以这条错误基本只有一个来源：'
    + 'TEST_DATABASE_URL 指到了一张不存在的库——改对，或删掉这个变量回到自动建库。'
    + '（想要一张现成的空库调试，也可以先跑 npm run db:test:setup。）';
}

/** 连接串里的库名（去掉前导斜杠）；解析不了就返回空串，交给守卫去拒绝。 */
export function databaseNameOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

/**
 * 换掉连接串里的库名，主机 / 端口 / 账号 / 密码 / query 原样保留。
 *
 * 为什么不直接拼死 `postgres://postgres:flowers@localhost:54330/flowers_test`：
 * 有人把 `DATABASE_URL` 指向远端主机或别的账号时，测试库应该跟着同一个服务器走，
 * 只是换个库名。
 */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export type ResolveOptions = {
  /**
   * 测试进程里是否用「每次跑一张」的库名（默认是）。
   *
   * 只有 `scripts/db-test-setup.ts` 传 `false`：它要建的是**基名**那张
   * （`flowers_test`），当作「手动调试时 `TEST_DATABASE_URL` 可以指过去的一张空库」
   * 与迁移模板。建一张一次性的 run 库对那条命令没有意义——它建完就没人用了。
   */
  perRun?: boolean;
};

/**
 * 决定这次进程用哪条连接串。
 *
 * - 非测试进程：完全保持原行为（`DATABASE_URL`，缺省本地 flowers）。
 * - 测试进程：默认把库名换成 `flowers_test_<runId>`（每次跑一张，见 `testDatabaseName`）；
 *   `TEST_DATABASE_URL` 可以整条覆盖
 *   （换主机、换账号都行），**但不做二次纠正**——写错了就是写错了，由
 *   `src/db/reset.ts` 的守卫在最危险的那一步之前把它拦下来，而不是在这里悄悄
 *   改回一个「看起来对」的库（那样真实配置错误会被掩盖成一次静默的跑绿）。
 */
export function resolveDatabaseUrl(env: DbEnv = process.env, options: ResolveOptions = {}): string {
  const base = env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  if (!isTestRun(env)) return base;
  // `TEST_DATABASE_URL` 是调试用的逃生口：写死一条连接串就照它连，连库名也不改。
  if (env.TEST_DATABASE_URL !== undefined && env.TEST_DATABASE_URL.trim() !== '') {
    return env.TEST_DATABASE_URL;
  }
  const database = options.perRun === false ? TEST_DATABASE : testDatabaseName(env);
  return withDatabase(base, database);
}
