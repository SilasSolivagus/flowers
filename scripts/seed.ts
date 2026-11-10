/**
 * 演示种子：把前端线稿那张看板灌进库里。
 *
 *   npm run seed            # 空库才灌（库里已有数据就拒绝，不覆盖别人的库）
 *   npx tsx scripts/seed.ts --reset   # 先清空 15 张表再灌（**库里有迁移数据时会被拒绝**）
 *   npx tsx scripts/seed.ts --reset --force-with-migrated
 *                           # 明知库里有 803 条 legacy_ref 需求，仍要清空重灌
 *
 * 最后那条是本轮（数据守卫）加的第二道门。`flowers` 里现在有 803 条从旧系统迁移来
 * 的需求（`legacy_ref` 非空），而 `--reset` 会对 requirements 做
 * `truncate … restart identity cascade`——一条命令就能把它们连同编号一起抹掉，且迁移
 * 不会自己回来。所以 `--reset` 单独出现时只允许在**没有**迁移数据的库上跑；要清真
 * 数据，必须再给一个开关（见 main() 里那段注释：谁是最后一道门，为什么在这里）。
 *
 * 两条硬口径：
 *
 * 1. **需求全部走真实服务建**（createRequirement → evaluate → submitReview →
 *    reviewPass → schedule → tick），不直接 INSERT 状态列。这样 seed 本身就是
 *    域层的第二条端到端用例：哪天有人改坏了「排期必须先评审」「签字人必须是派单
 *    的评审人」，跑一次 seed 就会炸，而不是靠页面上一眼看不出来的错。
 *    只有 members / releases 是裸 INSERT——P1 没有这两张表的服务（demo.ts 也一样）。
 *
 * 2. **日期相对「今天」算**（上海日历日）。写死的 2026-12 叙事在一个月后就会
 *    全部变成逾期，界面上的「停留天数 / 等开工日」全失去意义。相对日期让这张
 *    看板任何时候打开都处在「正在跑」的状态。
 *
 * 产出（与线稿一致）：7 个成员（各有邮箱登录名，P4-08）、2 个版本、12 条需求铺满
 * 10 个状态（其中 PAN-6 带平台 H5 + Android），
 * 其中 3 条是当前成员（默认「吕品」）**现在需要动手**的卡。
 *
 * 为什么不是 brief 写的 5 条：`mine` 的口径是「现在欠你一个动作」，而它由「等谁」
 * 那一行派生（见 read/board.ts 的 waitingFor）。12 条的固定分布里，能欠到本组某个
 * 成员动作的只有 待设计（负责人）/ 待评审（派单评审人）/ 待排期（负责人）：
 * 收集那条的提出人是外部人员（R39，「待接单」，谁都不框），
 * 待开发 / 开发中 / 测试中 / 已上线 / 终态都不欠人动作（打回、走查、恢复都是可选的）。
 * 待评审那两条按类型只能派给吕正豪 / 赵越，所以吕品手上是 待设计 1 + 待排期 2 = 3 条。
 * 要 5 条只能改分布（例如待排期 3 / 开发中 1），那已经不是 brief 那张板了。
 */
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import type { State } from '../src/core/state-machine.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { updateRequirement } from '../src/core/requirements/manage.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { reviewPass } from '../src/core/requirements/review.js';
import { schedule } from '../src/core/requirements/schedule.js';
import { shanghaiDayOf, startOfShanghaiDay, tick } from '../src/core/clock/tick.js';
import { assertNoMigratedRequirements, assertSafeToReset, resetDb } from '../src/db/reset.js';
import { getBoard } from '../src/core/read/board.js';
import { listReleases } from '../src/core/read/version.js';
import { DEFAULT_MEMBER_PASSWORD, setPassword } from '../src/core/auth/password.js';
import { seedPeople } from '../tests/helpers/db.js';

// ─── 小工具 ──────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
/** 演示里「当前成员」的默认身份：吕品（超管之外最常用的一条线）。 */
const PM = '吕品';
/** 超管。种子里的「无人认领」那条卡由他建（只有超管能显式留空负责人）。 */
const ADMIN = '房超';

/** 中文按两列宽补空格，否则状态那一列会被 CJK 推歪（与 demo.ts 同一套算法）。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function log(text = '') {
  process.stdout.write(`${text}\n`);
}

function head(text: string) {
  log();
  log(`── ${text} ${'─'.repeat(Math.max(0, 64 - displayWidth(text)))}`);
}

// ─── 相对日期 ────────────────────────────────────────────────────────────────

const todayNow = shanghaiDayOf(new Date().toISOString());
if (todayNow === null) throw new Error('系统时钟不合法，无法生成相对日期');
/** 显式标成 number：TS 不会把模块顶部的 null 收窄带进下面 day() 的闭包里。 */
const TODAY: number = todayNow;

/**
 * 整数「上海第几天」→ 那天的 'YYYY-MM-DD'。
 *
 * 不自己加 08:00：`new Date(day * DAY_MS)` 这个瞬间是 UTC 零点，它的上海日历日
 * 正是 day（上海是同一天的 08:00），所以 toISOString() 切出来的日期就是上海那天。
 * 「哪一天」这条规则仍然只由 clock/tick.ts 的 shanghaiDayOf 定义。
 */
function day(offset: number): string {
  return new Date((TODAY + offset) * DAY_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → 'YYYY.MM'，版本名跟今天走（2026.11 / 2026.12）。 */
function monthName(dayText: string): string {
  const [year, month] = dayText.split('-');
  return `${year}.${month}`;
}

// ─── 剧本 ────────────────────────────────────────────────────────────────────

/** tick 的三个时点：开工日之前 → 提测日 → 承诺完成日之前，都在过去，好让停留天数为正。 */
const TICK_A = day(-5);
const TICK_B = day(-3);
const TICK_C = day(-1);

const RELEASE_1 = monthName(day(0));       // 当月版本：已在跑，发版日就在本周内
const RELEASE_2 = monthName(day(31));      // 下月版本：开工日还没到

const failures: string[] = [];

type Person = {
  id: string; name: string; email: string; role: string; line: string | null;
};
let people: Person[] = [];

/** 一条需求 + 它的负责人（种子后面所有动作都要以负责人身份做）。 */
type Created = { id: string; number: number; owner: string };

/**
 * 建一条需求（一律 inbox）。
 *
 * P4-04 起种子的建法跟着规则 1 走：**谁建谁负责**，所以「以负责人自己的身份建」。
 * 想造一条没有负责人的卡（演示里的「待接单」）只有一条路——超管显式传 `null`。
 * 这不是种子的取巧，是产品里唯一能产生「无主需求」的路径。
 */
async function create(
  title: string, type: 'commercial' | 'feature', requester: string, owner: string | null,
): Promise<Created> {
  const actor = owner ?? ADMIN;
  const r = await createRequirement(db, actor, {
    title, type, requester,
    ...(owner === null ? { ownerMemberId: null } : {}),
  });
  return { id: r.id, number: r.number, owner: actor };
}

/** 走评估 → 提交评审（→ 待评审）。每一步都以**负责人**身份做（PM 只能改自己的）。 */
async function toReview(target: Created): Promise<void> {
  await evaluate(db, target.owner, { requirementId: target.id });
  await submitReview(db, target.owner, {
    requirementId: target.id,
    prdUrl: `https://docs.123pan.example/prd/PAN-${target.number}`,
  });
}

/** 走到待排期（评审由**负责人所在条线**的负责人签；负责人没有条线时由超管自己签）。 */
async function toQueue(target: Created, reviewer: string): Promise<void> {
  await toReview(target);
  await reviewPass(db, reviewer, { requirementId: target.id });
}

async function scheduleInto(
  target: Created, releaseId: string, commitTestAt: string, commitDueAt: string,
): Promise<void> {
  await schedule(db, target.owner, {
    requirementId: target.id, releaseId, commitTestAt, commitDueAt,
  });
}

async function tickAt(dayText: string, note: string): Promise<void> {
  const moved = await tick(db, startOfShanghaiDay(dayText));
  const label = moved.moved.map((m) => `${m.from}→${m.to}`).join(', ') || '无移动';
  log(`${padTo(`tick ${dayText}`, 22)}${note}   moved=${moved.moved.length}（${label}）`);
}

async function main() {
  const argv = process.argv.slice(2);
  const reset = argv.includes('--reset');
  /**
   * 第二个开关（本轮新增）：只有它和 `--reset` **同时**出现，才允许清掉迁移数据。
   *
   * 为什么必须是两个：`/tmp/restore-demo.sh` 里那句 `npm run seed -- --reset` 今天
   * 被反射地按了十几次。一个参数就是「一个手滑」；两个参数（或一个专门的 env 名）
   * 才是「我知道库里有 803 条真需求，我还是要清」。
   */
  const forceMigrated = argv.includes('--force-with-migrated')
    || process.env.FLOWERS_WIPE_MIGRATED === '1';
  log('=== flowers · 演示种子 ===');
  log(`库：${process.env.DATABASE_URL ?? 'postgres://postgres:flowers@localhost:54330/flowers'}`);
  log(`今天（Asia/Shanghai）：${day(0)}`);

  if (reset) {
    // resetDb 是 truncate 十五张表：先问库自己叫什么（不是看 DATABASE_URL 字符串）。
    const database = await assertSafeToReset();
    /**
     * 最后一道门就在这两行之间：**库名对了**（不是 flowers_test 之类的误连）**还不够**，
     * 还要问「这张库里有没有真数据」。守卫的实现住在 `src/db/reset.ts`（能被用例钉住），
     * 但调用点必须在这里——因为 `npm run seed -- --reset` 是唯一会带着 `--reset` 走进
     * resetDb 的脚本入口，把它放在 /tmp/restore-demo.sh 里等于把门建在库外（那个文件
     * 不进版本库、换机器就没了、也没人 review 它的 diff）。
     *
     * 顺序也是刻意的：先判库名（配置错 → 立刻停，连 count 都不查），再判迁移数据
     * （库对但里面是 803 条真数据 → 拒绝）。两条都不会走到 resetDb。
     */
    const migrated = await assertNoMigratedRequirements({ force: forceMigrated, database });
    if (migrated > 0) {
      log(`⚠ --force-with-migrated：即将清空，并删除 ${migrated} 条迁移需求（无可撤销）。`);
      log('  （commit_history / locate_runs 也在这张清空清单里；要重建它们见 docs 里的恢复步骤）');
    }
    await resetDb();
    log(`--reset：已清空 15 张表（current_database() = ${database}）`);
  } else {
    // 不加 --reset 就只在空库上灌：不然每跑一次就多 12 条，看板会慢慢变成一锅粥，
    // 而「重复的演示数据」最容易被人当成真需求。
    const used = await db.execute<{ n: number }>(sql`
      select (select count(*)::int from requirements)
           + (select count(*)::int from members)
           + (select count(*)::int from releases) as n`);
    const n = Number(used.rows[0]?.n ?? 0);
    if (n > 0) {
      log(`库里已经有数据（${n} 行），不覆盖。要重灌请加 --reset：`);
      log('  npx tsx scripts/seed.ts --reset');
      log('（若这张库里还有迁移需求，--reset 会拒绝；那说明这里不该重灌，见 /tmp/restore-demo.sh）');
      process.exitCode = 1;
      return;
    }
  }

  head('准备');

  people = await seedPeople();
  log(`成员 ${people.length} 人：${people.map((p) => `${p.name}(${p.email})/${p.role}${p.line ? `/${p.line}` : ''}`).join('、')}`);

  /**
   * 初始密码（P4-04 起，2026-11-10 改口径）。
   *
   * 原来每人一条随机串、只在这一屏打印一次。owner 的裁定是**统一一条**（原先的随机
   * 口令要人念给人，念错一个字符就进不去，而谁都拿不回明文）。所以现在七个人都用
   * `DEFAULT_MEMBER_PASSWORD`——这与迁移 `0037`、以及设置页「新增成员」的默认值是
   * **同一个常量**，三处没有第二份字面量。
   *
   * **明文不再打印**：它已经是团队共识的那一条，再往终端里写一遍只是把它多留一份
   * 在 shell 历史 / CI 日志里。这一屏只印「谁、用哪个邮箱登」。
   *
   * P4-08 起登录名是**邮箱**（`<拼音>@123pan.com`，来自企微通讯录），所以这一列印的是
   * 邮箱而不是名字：能用来登录的是它。名字仍然在前面那列，因为界面上、事件流里认的是
   * 名字——两列都要在，才不会有人以为登录也填名字。
   */
  head('初始密码：团队统一的那一条（见 src/core/auth/password.ts 的 DEFAULT_MEMBER_PASSWORD）');
  for (const person of people) {
    await setPassword(db, person.id, DEFAULT_MEMBER_PASSWORD);
    log(`${padTo(person.name, 8)}${padTo(person.email, 26)}${padTo(person.role, 20)}登录后可自己改`);
  }
  log('');
  log('登录名就是第二列那个邮箱。改密码的入口在「我的 → 密码」。');

  // P1 没有 releases 服务（版本只有建表和排期时的一次读取），所以这两行只能落 SQL。
  const releaseRows = await db.execute<{ id: string; name: string }>(sql`
    insert into releases (name, window_start, release_date) values
      (${RELEASE_1}, ${day(-9)}, ${day(6)}),
      (${RELEASE_2}, ${day(7)}, ${day(30)})
    returning id, name`);
  const releaseId = (name: string): string => {
    const found = releaseRows.rows.find((r) => r.name === name);
    if (!found) throw new Error(`版本没建出来：${name}`);
    return found.id;
  };
  log(`版本 ${RELEASE_1}：开工 ${day(-9)} → 发版 ${day(6)}`);
  log(`版本 ${RELEASE_2}：开工 ${day(7)} → 发版 ${day(30)}`);

  head('造需求（全部走真实服务）');

  // 1 收集：只有提出人，没有负责人。提出人是**外部**的孙建宏（不在花名册里），
  // 所以这张卡显示「待接单」且谁都不框（裁决 R39）：外部提出人在本系统里没有账号，
  // 动不了手，而这条需求还没人认领 —— 「待接单」才是实话。
  // （旧种子把提出人写成 PM，纯粹为了让这张卡被框住，那是拿假数据凑界面。）
  const inbox = await create('PC 剪贴板读取 URL', 'commercial', '孙建宏', null);
  log(`${padTo(`#${inbox.number}`, 5)}${padTo('PC 剪贴板读取 URL', 26)}createRequirement（停在收集）`);

  // 2 待设计（mine）：评估过了，等负责人出正式 PRD。
  const design = await create('连续包月下单后短信通知', 'commercial', '王妍', '吕品');
  await evaluate(db, PM, { requirementId: design.id });
  log(`${padTo(`#${design.number}`, 5)}${padTo('连续包月下单后短信通知', 26)}create → evaluate`);

  // 3 待评审：负责人王妍在**商业线** → 派给商业线负责人赵越（P4-06：锚点是人的条线，
  //   与它的「功能类」无关）。
  const reviewFeature = await create('导出任务队列改造', 'feature', '孙建宏', '王妍');
  await toReview(reviewFeature);
  log(`${padTo(`#${reviewFeature.number}`, 5)}${padTo('导出任务队列改造', 26)}… → submitReview（负责人王妍 → 商业线赵越）`);

  // 4 待评审：负责人是超管房超，**没有条线** → 不派单，只有超管能签（P4-06 第 1 条）。
  //   同一列，等的不是同一种人：一条等条线负责人，一条等超管。
  const reviewCommercial = await create('直链分享限速（二期）', 'commercial', '房超', '房超');
  await toReview(reviewCommercial);
  log(`${padTo(`#${reviewCommercial.number}`, 5)}${padTo('直链分享限速（二期）', 26)}… → submitReview（负责人无条线 → 等超管）`);

  // 5 / 6 待排期（都 mine）：评审通过了，等排期。
  // 商业类，但负责人是功能线的吕品 → 由**功能线**负责人吕正豪签（P4-06 换锚点）。
  const queueA = await create('权益套餐产品结构改造', 'commercial', '李思远', '吕品');
  await toQueue(queueA, '吕正豪');
  log(`${padTo(`#${queueA.number}`, 5)}${padTo('权益套餐产品结构改造', 26)}… → reviewPass（吕正豪）`);

  const queueB = await create('分享页搜索补齐 H5 / 移动端', 'feature', '王妍', '吕品');
  await toQueue(queueB, '吕正豪');
  /**
   * 平台（P4-08）：这条需求就是 owner 嘴里那个例子——「PAN-6 是 H5 + APP」。
   *
   * 走的是真实服务 `updateRequirement`（不是裸 UPDATE）：它会算指纹、写一条
   * 「更新描述 · 平台」的事件，于是时间轴上看得见「谁在这条需求上补了平台」。
   * 顺序放在 reviewPass 之后，因为「评估 / 评审」是在还没有平台这一格时做的——那
   * 也正是「补了平台，老材料就变旧」这条语义在种子里的样子。
   *
   * P4-09 换了词表：APP 那一半现在是 `mobile`（移动端）——真实数据里没有
   * iOS / Android 之分，223 条线上需求只写「移动端」。同一句 `['h5','ios','android']`
   * 在旧词表下是两个键、在新词表下是 `['h5','mobile']` 两个键（去重后的结果）。
   */
  await updateRequirement(db, PM, {
    requirementId: queueB.id, platforms: ['h5', 'mobile'], priority: 'p1',
  });
  log(`${padTo(`#${queueB.number}`, 5)}${padTo('分享页搜索补齐 H5 / 移动端', 26)}… → reviewPass（吕正豪）`
    + ' · 平台 H5 / 移动端 · P1');

  // 7 待开发：排进下月版本，开工日还没到（等开工日 day(+7)）。时钟不会碰它。
  const ready = await create('PC 端支持打开分享页', 'feature', '房超', '房超');
  await toQueue(ready, '房超');
  await scheduleInto(ready, releaseId(RELEASE_2), day(9), day(12));
  log(`${padTo(`#${ready.number}`, 5)}${padTo('PC 端支持打开分享页', 26)}… → schedule（${RELEASE_2}，等开工日）`);

  // 8 开发中：排进当月版本，提测日还在未来 —— 时钟走过开工日，把它推到开发中。
  const devOnTime = await create('分享创建页改版', 'feature', '房超', '王妍');
  await toQueue(devOnTime, '赵越');
  await scheduleInto(devOnTime, releaseId(RELEASE_1), day(2), day(5));
  log(`${padTo(`#${devOnTime.number}`, 5)}${padTo('分享创建页改版', 26)}… → schedule（${RELEASE_1}，提测日未到）`);

  // 10 测试中：提测日已过 —— 时钟把它推到测试中，等承诺完成日自动上线。
  const testing = await create('S3 协议支持', 'feature', '孙建宏', '吕品');
  await toQueue(testing, '吕正豪');
  await scheduleInto(testing, releaseId(RELEASE_1), day(-6), day(3));
  log(`${padTo(`#${testing.number}`, 5)}${padTo('S3 协议支持', 26)}… → schedule（${RELEASE_1}，提测日已过）`);

  // 11 已上线：承诺完成日已过 —— 时钟推它到 live（历史，甘特上还看得见）。
  const live = await create('直链分享限速策略', 'feature', '房超', '房超');
  await toQueue(live, '房超');
  await scheduleInto(live, releaseId(RELEASE_1), day(-6), day(-2));
  log(`${padTo(`#${live.number}`, 5)}${padTo('直链分享限速策略', 26)}… → schedule（${RELEASE_1}，承诺日已过）`);

  // 12 测试中：同一列里另一条，承诺完成日更晚（同一列，等的日期不同）。
  const testing2 = await create('连续包月续费提醒', 'commercial', '李思远', '王妍');
  await toQueue(testing2, '赵越');
  await scheduleInto(testing2, releaseId(RELEASE_1), day(-4), day(6));
  log(`${padTo(`#${testing2.number}`, 5)}${padTo('连续包月续费提醒', 26)}… → schedule（${RELEASE_1}，提测日已过）`);

  head('时钟推进（tick 是真实服务，不是改状态列）');

  await tickAt(TICK_A, '开工日：待开发 → 开发中');
  await tickAt(TICK_B, '提测日：开发中 → 测试中');
  await tickAt(TICK_C, '承诺完成日：测试中 → 已上线');

  // 9 开发中（逾期）：排期之后才被时钟发现 —— 提测日已经过去，但时钟一次只推一步，
  // 所以它停在开发中。卡片上等的东西从「MM-DD 提测」变成「提测日已过 MM-DD」，
  // 但两者都是时钟（`on: 'clock'`、没有名字）：日期过了只是「等的东西过期了」，
  // 不是「谁欠一个动作」，所以这张卡不被框（同一列的「等谁」也不该是「等人提测」）。
  const devLate = await create('支付宝投诉自动退款', 'commercial', '王妍', '吕品');
  await toQueue(devLate, '吕正豪');
  await scheduleInto(devLate, releaseId(RELEASE_1), day(-2), day(4));
  log(`${padTo(`#${devLate.number}`, 5)}${padTo('支付宝投诉自动退款', 26)}… → schedule（${RELEASE_1}，提测日已过）`);
  await tickAt(day(0), '补一次 tick：把它推进开发中（一步）');

  head('看板（getBoard 真实读模型）');

  const board = await getBoard(PM);
  let total = 0;
  let mine = 0;
  let late = 0;
  for (const column of board) {
    log(`${padTo(column.label, 8)}${String(column.cards.length).padStart(2)}  ${'·'.repeat(column.cards.length)}`);
    for (const card of column.cards) {
      total += 1;
      if (card.mine) mine += 1;
      if (card.late) late += 1;
      log(`  PAN-${padTo(String(card.number), 4)}${padTo(card.title, 26)}`
        + `${padTo(card.waiting, 26)}${card.days} 天${card.mine ? '  ★ 需要你动手' : ''}`);
    }
  }
  log('');
  log(`共 ${total} 条，其中当前成员（${PM}）现在需要动手 ${mine} 条，逾期 ${late} 条`);

  head('版本（listReleases 真实读模型）');
  for (const release of await listReleases()) {
    log(`${padTo(release.name, 10)}开工 ${release.windowStartLabel ?? '—'}`
      + ` → 发版 ${release.releaseDateLabel ?? '—'}`
      + `　在途 ${release.inFlight}　已上线 ${release.shipped}　延期 ${release.late}`
      + `　时间已用 ${release.timeUsed === null ? '—' : `${release.timeUsed}%`}`);
    for (const item of release.requirements) {
      log(`  ${padTo(`PAN-${item.number}`, 10)}${padTo(item.title, 26)}`
        + `${padTo(item.stateLabel, 8)}提测 ${item.testAtLabel ?? '—'} / 承诺 ${item.dueAtLabel ?? '—'}`
        + `${item.late ? '　延期' : ''}`);
    }
  }

  // ─── 自检：seed 的产出必须正好是线稿那张板 ────────────────────────────────

  head('自检');

  const expected: Array<[State, number]> = [
    ['inbox', 1], ['design', 1], ['review', 2], ['queue', 2], ['ready', 1],
    ['dev', 2], ['test', 2], ['live', 1], ['rejected', 0], ['shelved', 0],
  ];
  for (const [state, count] of expected) {
    const actual = board.find((c) => c.state === state)?.cards.length ?? -1;
    if (actual !== count) failures.push(`状态 ${state}：期望 ${count} 条，实际 ${actual} 条`);
  }
  if (total !== 12) failures.push(`需求总数是 ${total}，期望 12`);
  // 3 = 待设计 1（负责人吕品）+ 待排期 2（负责人吕品）。收集那条不在这里：
  // 它的提出人是外部人员，写「待接单」且谁都不框（R39，见文件头）。
  if (mine !== 3) failures.push(`当前成员「需要你动手」的卡片是 ${mine} 条，期望 3`);

  // R39：收集列的卡必须是「待接单」且不是任何人的卡 —— 外部提出人动不了手，
  // 也没人认领。这条断言把裁决钉在种子上，而不只是钉在读模型用例里。
  const inboxCard = board.find((c) => c.state === 'inbox')!.cards[0];
  if (!inboxCard) failures.push('收集列没有卡片');
  else {
    if (inboxCard.waiting !== '待接单') {
      failures.push(`收集列的「等谁」是「${inboxCard.waiting}」，期望「待接单」（提出人不是成员）`);
    }
    if (inboxCard.waitingOn !== 'person') {
      failures.push(`收集列等的是人，waitingOn 应该是 person，实际 ${inboxCard.waitingOn}`);
    }
    if (board.some((c) => c.cards.some((x) => x.id === inboxCard.id && x.mine))) {
      failures.push(`收集列那条（外部提出人）不该是「需要你动手」的卡（${PM} 身份下）`);
    }
  }
  if (late !== 1) failures.push(`逾期卡片是 ${late} 条，期望 1（开发中那条提测日已过）`);

  // 主色框只该出现在「欠你动作」的那四列：时钟状态与终态一律不框（裁决 R-mine）。
  const accentOnClock = board
    .filter((c) => ['ready', 'dev', 'test', 'live', 'rejected', 'shelved'].includes(c.state))
    .flatMap((c) => c.cards)
    .filter((c) => c.mine);
  if (accentOnClock.length > 0) {
    failures.push(`等日期/终态的卡片不该是「需要你动手」：${accentOnClock.map((c) => c.title).join('、')}`);
  }

  // 同一列里等的东西不一样：这是看板的设计前提，seed 必须演示出来。
  const devWaiting = board.find((c) => c.state === 'dev')!.cards.map((c) => c.waiting);
  if (new Set(devWaiting).size !== devWaiting.length) {
    failures.push(`开发中那两条的「等谁」应该不同，实际都是：${devWaiting.join(' / ')}`);
  }
  const reviewWaiting = board.find((c) => c.state === 'review')!.cards.map((c) => c.waiting);
  if (new Set(reviewWaiting).size !== reviewWaiting.length) {
    failures.push(`待评审那两条应该等不同的评审人，实际：${reviewWaiting.join(' / ')}`);
  }

  if (failures.length > 0) {
    for (const failure of failures) log(`FAIL  ${failure}`);
    log(`结论：失败（${failures.length} 项）`);
    process.exitCode = 1;
    return;
  }
  log(`结论：PASS —— 12 条需求铺满 10 列，${mine} 条是当前成员现在要动手的`);
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log();
    log(`种子中断：${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    // pool 不关，node 进程会挂在连接上不退。
    await pool.end();
  });
