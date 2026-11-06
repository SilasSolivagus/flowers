/**
 * 演示种子：把前端线稿那张看板灌进库里。
 *
 *   npm run seed            # 空库才灌（库里已有数据就拒绝，不覆盖别人的库）
 *   npx tsx scripts/seed.ts --reset   # 先清空 5 张表再灌
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
 * 产出（与线稿一致）：5 个成员、2 个版本、12 条需求铺满 10 个状态，
 * 其中 4 条是当前成员（默认「吕品」）**现在需要动手**的卡。
 *
 * 为什么不是 brief 写的 5 条：`mine` 的口径是「现在欠你一个动作」，而它由「等谁」
 * 那一行派生（见 read/board.ts 的 waitingFor）。12 条的固定分布里，欠人动作的只有
 * 收集（提出人）/ 待设计（负责人）/ 待评审（派单评审人）/ 待排期（负责人）；
 * 待开发 / 开发中 / 测试中 / 已上线 / 终态都不欠人动作（打回、走查、恢复都是可选的）。
 * 待评审那两条按类型只能派给吕正豪 / 赵越，所以吕品最多 4 条。要 5 条只能改分布
 * （例如待排期 3 / 开发中 1），那已经不是 brief 那张板了。
 */
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import type { State } from '../src/core/state-machine.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { reviewPass } from '../src/core/requirements/review.js';
import { schedule } from '../src/core/requirements/schedule.js';
import { shanghaiDayOf, startOfShanghaiDay, tick } from '../src/core/clock/tick.js';
import { assertSafeToReset, resetDb } from '../src/db/reset.js';
import { getBoard } from '../src/core/read/board.js';
import { listReleases } from '../src/core/read/version.js';
import { DEFAULT_MEMBER } from '../src/core/read/member.js';
import { seedPeople } from '../tests/helpers/db.js';

// ─── 小工具 ──────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const PM = '吕品';

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

type Person = { id: string; name: string; role: string };
let people: Person[] = [];

function memberId(name: string): string {
  const found = people.find((p) => p.name === name);
  if (!found) throw new Error(`种子里没有成员 ${name}`);
  return found.id;
}

type Created = { id: string; number: number };

/** 建一条需求（一律 inbox）。owner 为 null 表示还没指定负责人。 */
async function create(
  title: string, type: 'commercial' | 'feature', requester: string, owner: string | null,
): Promise<Created> {
  const r = await createRequirement(db, PM, {
    title, type, requester, ownerMemberId: owner ? memberId(owner) : null,
  });
  return { id: r.id, number: r.number };
}

/** 走评估 → 提交评审（→ 待评审）。 */
async function toReview(target: Created): Promise<void> {
  await evaluate(db, PM, { requirementId: target.id });
  await submitReview(db, PM, {
    requirementId: target.id,
    prdUrl: `https://docs.123pan.example/prd/PAN-${target.number}`,
  });
}

/** 走到待排期（评审由该类型的评审人签）。 */
async function toQueue(target: Created, reviewer: string): Promise<void> {
  await toReview(target);
  await reviewPass(db, reviewer, { requirementId: target.id });
}

async function scheduleInto(
  target: Created, releaseId: string, commitTestAt: string, commitDueAt: string,
): Promise<void> {
  await schedule(db, PM, {
    requirementId: target.id, releaseId, commitTestAt, commitDueAt,
  });
}

async function tickAt(dayText: string, note: string): Promise<void> {
  const moved = await tick(db, startOfShanghaiDay(dayText));
  const label = moved.moved.map((m) => `${m.from}→${m.to}`).join(', ') || '无移动';
  log(`${padTo(`tick ${dayText}`, 22)}${note}   moved=${moved.moved.length}（${label}）`);
}

async function main() {
  const reset = process.argv.slice(2).includes('--reset');
  log('=== flowers · 演示种子 ===');
  log(`库：${process.env.DATABASE_URL ?? 'postgres://postgres:flowers@localhost:54330/flowers'}`);
  log(`今天（Asia/Shanghai）：${day(0)}`);

  if (reset) {
    // resetDb 是 truncate 五张表：先问库自己叫什么（不是看 DATABASE_URL 字符串）。
    const database = await assertSafeToReset();
    await resetDb();
    log(`--reset：已清空 5 张表（current_database() = ${database}）`);
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
      process.exitCode = 1;
      return;
    }
  }

  head('准备');

  people = await seedPeople();
  log(`成员 ${people.length} 人：${people.map((p) => `${p.name}/${p.role}`).join('、')}`);

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

  // 1 收集：只有提出人，没有负责人 —— 等的是「提出人补必填」。
  // 提出人就是当前成员：收集列的「补必填」欠在他身上，所以这张卡是「需要你动手」的。
  const inbox = await create('PC 剪贴板读取 URL', 'commercial', PM, null);
  log(`${padTo(`#${inbox.number}`, 5)}${padTo('PC 剪贴板读取 URL', 26)}createRequirement（停在收集）`);

  // 2 待设计（mine）：评估过了，等负责人出正式 PRD。
  const design = await create('连续包月下单后短信通知', 'commercial', '王妍', '吕品');
  await evaluate(db, PM, { requirementId: design.id });
  log(`${padTo(`#${design.number}`, 5)}${padTo('连续包月下单后短信通知', 26)}create → evaluate`);

  // 3 待评审：功能类 → 派给功能线（吕正豪）。
  const reviewFeature = await create('导出任务队列改造', 'feature', '孙建宏', '王妍');
  await toReview(reviewFeature);
  log(`${padTo(`#${reviewFeature.number}`, 5)}${padTo('导出任务队列改造', 26)}… → submitReview（功能线）`);

  // 4 待评审：商业类 → 派给商业线（赵越）。同一列，等的人不同。
  const reviewCommercial = await create('直链分享限速（二期）', 'commercial', '房超', '房超');
  await toReview(reviewCommercial);
  log(`${padTo(`#${reviewCommercial.number}`, 5)}${padTo('直链分享限速（二期）', 26)}… → submitReview（商业线）`);

  // 5 / 6 待排期（都 mine）：评审通过了，等排期。
  const queueA = await create('权益套餐产品结构改造', 'commercial', '李思远', '吕品');
  await toQueue(queueA, '赵越');
  log(`${padTo(`#${queueA.number}`, 5)}${padTo('权益套餐产品结构改造', 26)}… → reviewPass（赵越）`);

  const queueB = await create('分享页搜索补齐 H5 / APP', 'feature', '王妍', '吕品');
  await toQueue(queueB, '吕正豪');
  log(`${padTo(`#${queueB.number}`, 5)}${padTo('分享页搜索补齐 H5 / APP', 26)}… → reviewPass（吕正豪）`);

  // 7 待开发：排进下月版本，开工日还没到（等开工日 day(+7)）。时钟不会碰它。
  const ready = await create('PC 端支持打开分享页', 'feature', '房超', '房超');
  await toQueue(ready, '吕正豪');
  await scheduleInto(ready, releaseId(RELEASE_2), day(9), day(12));
  log(`${padTo(`#${ready.number}`, 5)}${padTo('PC 端支持打开分享页', 26)}… → schedule（${RELEASE_2}，等开工日）`);

  // 8 开发中：排进当月版本，提测日还在未来 —— 时钟走过开工日，把它推到开发中。
  const devOnTime = await create('分享创建页改版', 'feature', '房超', '王妍');
  await toQueue(devOnTime, '吕正豪');
  await scheduleInto(devOnTime, releaseId(RELEASE_1), day(2), day(5));
  log(`${padTo(`#${devOnTime.number}`, 5)}${padTo('分享创建页改版', 26)}… → schedule（${RELEASE_1}，提测日未到）`);

  // 10 测试中：提测日已过 —— 时钟把它推到测试中，等承诺完成日自动上线。
  const testing = await create('S3 协议支持', 'feature', '孙建宏', '吕品');
  await toQueue(testing, '吕正豪');
  await scheduleInto(testing, releaseId(RELEASE_1), day(-6), day(3));
  log(`${padTo(`#${testing.number}`, 5)}${padTo('S3 协议支持', 26)}… → schedule（${RELEASE_1}，提测日已过）`);

  // 11 已上线：承诺完成日已过 —— 时钟推它到 live（历史，甘特上还看得见）。
  const live = await create('直链分享限速策略', 'feature', '房超', '房超');
  await toQueue(live, '吕正豪');
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
  // 所以它停在开发中，卡片上等的东西从「某天提测」变成「等人提测」。
  const devLate = await create('支付宝投诉自动退款', 'commercial', '王妍', '吕品');
  await toQueue(devLate, '赵越');
  await scheduleInto(devLate, releaseId(RELEASE_1), day(-2), day(4));
  log(`${padTo(`#${devLate.number}`, 5)}${padTo('支付宝投诉自动退款', 26)}… → schedule（${RELEASE_1}，提测日已过）`);
  await tickAt(day(0), '补一次 tick：把它推进开发中（一步）');

  head('看板（getBoard 真实读模型）');

  const board = await getBoard(DEFAULT_MEMBER);
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
  log(`共 ${total} 条，其中当前成员（${DEFAULT_MEMBER}）现在需要动手 ${mine} 条，逾期 ${late} 条`);

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
  // 4 = 收集 1（提出人）+ 待设计 1（负责人）+ 待排期 2（负责人）。见文件头的解释。
  if (mine !== 4) failures.push(`当前成员「需要你动手」的卡片是 ${mine} 条，期望 4`);
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
