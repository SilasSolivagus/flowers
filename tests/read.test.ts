import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { reviewPass } from '../src/core/requirements/review.js';
import { schedule } from '../src/core/requirements/schedule.js';
import { shelveRequirement } from '../src/core/requirements/terminal.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { makeRelease } from './helpers/factory.js';
import { getBoard } from '../src/core/read/board.js';
import { getRequirementDetail } from '../src/core/read/detail.js';
import { attachArtifact } from '../src/core/uemaster/attach.js';
import { cleanArtifacts, writeArtifact } from './helpers/files.js';
import { listReleases } from '../src/core/read/version.js';
import { actorFromCookie, DEFAULT_MEMBER, listMembers } from '../src/core/read/member.js';

/**
 * 读模型的用例：全部对着真库跑。
 *
 * 为什么不去测一个纯函数：读模型就是 SQL（连接、列名、coalesce、review_assignments
 * 的 handed 选取、state_entered_at 的折算）——把这些拆成纯函数再测，测到的是
 * 「我以为的库」，而不是库。这里的每一条都在问 PG 要答案。
 */

let people: Array<{ id: string; name: string; role: string }> = [];

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
});

afterAll(async () => {
  // attach 现在会 stat 站内链接，这些用例在 public/uemaster/ 下造了真文件。
  await cleanArtifacts();
  await pool.end();
});

function memberId(name: string): string {
  const found = people.find((p) => p.name === name);
  if (!found) throw new Error(`种子里没有成员 ${name}`);
  return found.id;
}

const DAY_MS = 86_400_000;

/**
 * 所有日期相对「今天」算，不写死某一天。
 *
 * 这不是洁癖：读模型里 `isPastDay` 是严格小于，写死 '2026-12-04' 的断言会在
 * 2026-12-05 那天开始变红，而代码一行没错——那种红是最没人愿意查的红。
 * `TODAY` 取 UTC 零点的那一天：用例里的日期都按 'YYYY-MM-DD' 写库（服务也是这么
 * 解析的），相对它加减永远落在同一种基准上。
 */
const TODAY = new Date().toISOString().slice(0, 10);
/** 足够远，任何「还没到」的判断都不会被时区或运行时长碰到。 */
const FUTURE = shiftDay(TODAY, 30);
/** 足够远，任何「已经过了」的判断都成立。 */
const PAST = shiftDay(TODAY, -30);

/** 'YYYY-MM-DD' 加减天数（用例里的日期都是 UTC 零点，直接按天算）。 */
function shiftDay(day: string, delta: number): string {
  return new Date(new Date(day).getTime() + delta * DAY_MS).toISOString().slice(0, 10);
}

/** 读模型把日期格式化成 'MM-DD'；'YYYY-MM-DD'.slice(5) 是同一天的同一种写法。 */
function md(day: string): string {
  return day.slice(5);
}

/**
 * 把一条需求推到「测试中」（brief 里的 seedOneTesting）。
 *
 * 走真实服务到 ready，然后直接改状态列：读模型只关心数据形状，不重测状态机
 * （状态机的边由 tests/state-machine.test.ts 与 clock.test.ts 钉住）。
 * 时钟那一步刻意不跑 tick：tick 是全局的，会把别的行一起推走。
 */
async function seedOneTesting(opts: {
  commitDueAt?: string;
  owner?: string;
  title?: string;
  type?: 'commercial' | 'feature';
} = {}) {
  const due = opts.commitDueAt ?? FUTURE;
  // 版本时间窗与提测日都从承诺完成日推：schedule 要求 提测 <= 承诺 <= 发版，
  // 让助手替用例守住这条次序，用例才能专心写它要断言的日期。
  const windowStart = shiftDay(due, -7);
  const testAt = shiftDay(due, -2);
  const releaseId = await makeRelease(`R-${due}`, windowStart, due);
  const r = await createRequirement(db, '吕品', {
    title: opts.title ?? 'S3 协议支持',
    type: opts.type ?? 'feature',
    requester: '孙建宏',
    ownerMemberId: memberId(opts.owner ?? '房超'),
  });
  await evaluate(db, '吕品', { requirementId: r.id });
  await submitReview(db, '吕品', {
    requirementId: r.id,
    prdUrl: 'https://docs.example.com/prd/s3',
  });
  await reviewPass(db, '吕正豪', { requirementId: r.id });
  await schedule(db, '吕品', {
    requirementId: r.id, releaseId, commitTestAt: testAt, commitDueAt: due,
  });
  await db.execute(sql`update requirements set state = 'test' where id = ${r.id}`);
  return { id: r.id, number: r.number, releaseId, due, windowStart, testAt };
}

/** 建一条停在 inbox 的需求（除了标题 / 提出人什么都没填，也永远没有版本）。 */
async function seedInbox(requester = '房超', owner?: string) {
  const r = await createRequirement(db, '吕品', {
    title: 'PC 剪贴板读取 URL',
    type: 'commercial',
    requester,
    ownerMemberId: owner ? memberId(owner) : null,
  });
  return r;
}

/** 建一条推到 ready 的需求：负责人是 owner，开工日还没到。返回 id。 */
async function seedReady(owner: string) {
  const windowStart = shiftDay(TODAY, 7);
  const releaseId = await makeRelease(`R-${windowStart}`, windowStart, shiftDay(TODAY, 14));
  const r = await createRequirement(db, '吕品', {
    title: 'PC 端支持打开分享页',
    type: 'feature',
    requester: '孙建宏',
    ownerMemberId: memberId(owner),
  });
  await evaluate(db, '吕品', { requirementId: r.id });
  await submitReview(db, '吕品', { requirementId: r.id, prdUrl: 'https://docs.example.com/prd/r' });
  await reviewPass(db, '吕正豪', { requirementId: r.id });
  await schedule(db, '吕品', {
    requirementId: r.id,
    releaseId,
    commitTestAt: shiftDay(TODAY, 9),
    commitDueAt: shiftDay(TODAY, 12),
  });
  return r.id;
}

/** 建一条推到 review 的需求，返回 id 与 type 决定的评审人姓名。 */
async function seedInReview(type: 'commercial' | 'feature') {
  const r = await createRequirement(db, '吕品', {
    title: type === 'commercial' ? '直链分享限速（二期）' : '导出任务队列改造',
    type,
    requester: '王妍',
    ownerMemberId: memberId('王妍'),
  });
  await evaluate(db, '吕品', { requirementId: r.id });
  await submitReview(db, '吕品', { requirementId: r.id, prdUrl: 'https://docs.example.com/prd/r' });
  return r.id;
}

/** 在某一列里取出某张卡（取不到就炸，免得断言读到 undefined 也「通过」）。 */
async function cardOf(state: string, id: string, me: string) {
  const board = await getBoard(me);
  const column = board.find((c) => c.state === state);
  if (!column) throw new Error(`看板没有 ${state} 这一列`);
  const card = column.cards.find((c) => c.id === id);
  if (!card) throw new Error(`看板 ${state} 列里没有需求 ${id}`);
  return card;
}

describe('成员', () => {
  it('listMembers 返回五个人，两条评审线都在', async () => {
    const rows = await listMembers();
    expect(rows.map((m) => m.name).sort()).toEqual(['吕品', '吕正豪', '房超', '王妍', '赵越'].sort());
    expect(rows.every((m) => m.id.length > 0)).toBe(true);
    expect(rows.map((m) => m.role)).toContain('commercial_reviewer');
    expect(rows.map((m) => m.role)).toContain('feature_reviewer');
  });

  it('cookie 缺省与坏值都退回默认成员', () => {
    expect(DEFAULT_MEMBER).toBe('吕品');
    expect(actorFromCookie(undefined)).toBe(DEFAULT_MEMBER);
    expect(actorFromCookie('')).toBe(DEFAULT_MEMBER);
    // 客户端写 cookie 时 encodeURIComponent 过，读回来必须解码
    expect(actorFromCookie(encodeURIComponent('房超'))).toBe('房超');
    // 坏值不抛错：顶栏不该因为一个人手改的 cookie 白屏
    expect(actorFromCookie('%E4%B8')).toBe('%E4%B8');
  });
});

describe('getBoard', () => {
  it('看板返回 10 列，列顺序与状态机一致', async () => {
    const board = await getBoard('吕品');
    expect(board.map((c) => c.state)).toEqual([
      'inbox', 'design', 'review', 'queue', 'ready', 'dev', 'test', 'live', 'rejected', 'shelved',
    ]);
    expect(board.map((c) => c.label)).toEqual([
      '收集', '待设计', '待评审', '待排期', '待开发', '开发中', '测试中', '已上线', '已拒绝', '已搁置',
    ]);
  });

  it('卡片带出负责人、等谁、停留天数', async () => {
    const { id, due } = await seedOneTesting();
    const card = await cardOf('test', id, '吕品');
    expect(card.number).toBeGreaterThan(0);
    expect(card.title).toBe('S3 协议支持');
    expect(card.owner).toBe('房超');
    expect(card.waiting).toBe(`${md(due)} 自动上线`);
    expect(card.waitingOn).toBe('clock');
    expect(card.late).toBe(false);
    expect(card.days).toBeGreaterThanOrEqual(0);
  });

  it('停留天数是上海日历天，不是毫秒除法', async () => {
    const { id } = await seedOneTesting();
    await db.execute(sql`
      update requirements set state_entered_at = now() - interval '3 days' where id = ${id}`);
    const card = await cardOf('test', id, '吕品');
    expect(card.days).toBe(3);
  });

  it('mine 跟着当前成员走，换个身份标签就换', async () => {
    // inbox 的「补必填」欠在提出人身上，所以这里换的是提出人
    const mine = await seedInbox('房超');
    const other = await seedInbox('王妍');

    const asFang = await getBoard('房超');
    const inboxFang = asFang.find((c) => c.state === 'inbox')!.cards;
    expect(inboxFang.find((x) => x.id === mine.id)!.mine).toBe(true);
    expect(inboxFang.find((x) => x.id === other.id)!.mine).toBe(false);

    const asWang = await getBoard('王妍');
    const inboxWang = asWang.find((c) => c.state === 'inbox')!.cards;
    expect(inboxWang.find((x) => x.id === mine.id)!.mine).toBe(false);
    expect(inboxWang.find((x) => x.id === other.id)!.mine).toBe(true);
  });

  it('同一列里等的东西不一样：待评审分给两条评审线', async () => {
    const commercial = await seedInReview('commercial');
    const feature = await seedInReview('feature');
    const board = await getBoard('吕品');
    const cards = board.find((c) => c.state === 'review')!.cards;
    expect(cards.find((c) => c.id === commercial)!.waiting).toBe('等 赵越 评审');
    expect(cards.find((c) => c.id === feature)!.waiting).toBe('等 吕正豪 评审');
    expect(cards.every((c) => c.waitingOn === 'person')).toBe(true);
  });

  it('测试中逾期：逾期标出来，但仍然不欠任何人一个动作', async () => {
    // 承诺完成日已经过去：卡片该标红（late），但「现在需要你动手」是 false ——
    // 时钟还没跑到，而打回是可选的，可选动作不产生「你的卡」。
    const { id } = await seedOneTesting({ commitDueAt: PAST, owner: '房超' });
    const card = await cardOf('test', id, '房超');
    expect(card.late).toBe(true);
    expect(card.waiting).toContain(md(PAST));
    expect(card.waitingOn).toBe('clock');
    expect(card.mine).toBe(false);
  });

  it('没有版本的需求照样出现在它那一列', async () => {
    const r = await seedInbox('房超');
    const card = await cardOf('inbox', r.id, '吕品');
    expect(card.waiting).toBe('房超 补必填');
    expect(card.owner).toBeNull();
    // 收集列等的是人（提出人补必填），不是日期
    expect(card.waitingOn).toBe('person');

    const detail = await getRequirementDetail(r.id);
    expect(detail!.commit.release).toBeNull();
  });

  it('终态的列等的是「—」，不假装有人在等', async () => {
    const r = await seedInbox('房超', '房超');
    await shelveRequirement(db, '吕品', { requirementId: r.id, reason: '本期不做' });
    const card = await cardOf('shelved', r.id, '房超');
    expect(card.waiting).toBe('—');
    expect(card.waitingOn).toBe('none');
    // 恢复是可选的，所以搁置的卡不算「需要你动手」
    expect(card.mine).toBe(false);
  });
});

/**
 * `mine` 的负向用例。
 *
 * 这一组是这次裁决的核心：主色框与「等谁」那一行必须说同一件事。旧实现用
 * `owner === me || reviewer === me`，于是「等 吕正豪 评审」的卡会被框成负责人（王妍）的，
 * 一张卡同时说着「等别人」和「你需要动手」。正向用例抓不到这种不一致，只有负向能。
 */
describe('mine = 现在欠你一个动作（不是「跟你有关」）', () => {
  it('待评审的卡不框负责人，只框派单到的评审人', async () => {
    const feature = await seedInReview('feature'); // owner 王妍，派给吕正豪
    const asOwner = await cardOf('review', feature, '王妍');
    expect(asOwner.waiting).toBe('等 吕正豪 评审');
    expect(asOwner.mine).toBe(false);

    const asReviewer = await cardOf('review', feature, '吕正豪');
    expect(asReviewer.mine).toBe(true);

    // 另一条线的评审人也不该被框
    expect((await cardOf('review', feature, '赵越')).mine).toBe(false);
  });

  it('待开发 / 开发中 / 测试中：负责人也不框，等的是日期', async () => {
    const ready = await seedReady('房超');
    const readyCard = await cardOf('ready', ready, '房超');
    expect(readyCard.owner).toBe('房超');
    expect(readyCard.waitingOn).toBe('clock');
    expect(readyCard.mine).toBe(false);

    const testing = await seedOneTesting({ owner: '房超' });
    const testCard = await cardOf('test', testing.id, '房超');
    expect(testCard.waitingOn).toBe('clock');
    expect(testCard.mine).toBe(false);
  });

  it('待排期 / 待设计框的是负责人，收集框的是提出人', async () => {
    const { id: designId } = await (async () => {
      const r = await seedInbox('孙建宏', '房超');
      await evaluate(db, '吕品', { requirementId: r.id });
      return r;
    })();
    expect((await cardOf('design', designId, '房超')).mine).toBe(true);
    expect((await cardOf('design', designId, '吕品')).mine).toBe(false);

    const inbox = await seedInbox('王妍');
    expect((await cardOf('inbox', inbox.id, '王妍')).mine).toBe(true);
    expect((await cardOf('inbox', inbox.id, '房超')).mine).toBe(false);
  });

  /**
   * R39：收集列的提出人是**自由文本字段**，可以是一个不在花名册里的外部人员。
   * 外部提出人在这个系统里没有账号，动不了手；而这条需求也还没人认领。
   * 所以卡片写「待接单」（确实在等人，on 仍是 person），但谁都不框 —— who 为 null。
   * 旧写法会把「孙建宏 补必填」框成一个谁都不该戴的主色框（孙建宏不是成员）。
   */
  it('收集列的提出人不是成员时写「待接单」，谁都不框', async () => {
    const r = await seedInbox('孙建宏');
    const card = await cardOf('inbox', r.id, '吕品');
    expect(card.waiting).toBe('待接单');
    expect(card.waitingOn).toBe('person');
    expect(card.mine).toBe(false);

    // 「不是任何人的卡」要按每个身份都问一遍：提出人名字都不在 `who` 里了，
    // 连「用提出人的名字当当前成员」也不该把它框起来。
    for (const me of ['吕品', '房超', '王妍', '赵越', '吕正豪', '孙建宏']) {
      expect((await cardOf('inbox', r.id, me)).mine).toBe(false);
    }
  });
});

describe('getRequirementDetail', () => {
  it('六段齐全：信息 / 承诺 / 参考 / 评审 / 记录 / 动作', async () => {
    const { id, due, testAt } = await seedOneTesting();
    const d = (await getRequirementDetail(id))!;

    expect(d.id).toBe(id);
    expect(d.state).toBe('test');
    expect(d.stateLabel).toBe('测试中');

    // 信息
    expect(d.info).toMatchObject({
      type: 'feature',
      typeLabel: '功能',
      requester: '孙建宏',
      owner: '房超',
      prdUrl: 'https://docs.example.com/prd/s3',
      stateLabel: '测试中',
    });

    // 承诺：版本 + 两个日期，且时间已用是个 0..100 的整数
    expect(d.commit.release).toMatchObject({ name: `R-${due}` });
    expect(d.commit.testAt).toContain(testAt);
    expect(d.commit.dueAt).toContain(due);
    expect(d.commit.testAtLabel).toBe(md(testAt));
    expect(d.commit.dueAtLabel).toBe(md(due));
    expect(d.commit.timeUsed!.percent).toBeGreaterThanOrEqual(0);
    expect(d.commit.timeUsed!.percent).toBeLessThanOrEqual(100);

    // 参考：三处 UEmaster 材料一份都没生成（P2 之前 review 行放的是 PRD 快照，
    // Task 4 之后三行同形：没产物就是待生成 + 复制任务包，PRD 留在信息段）
    expect(d.refs.map((r) => r.stage)).toEqual(['evaluate', 'review', 'inspect']);
    expect(d.refs.every((r) => r.present === false && r.url === null)).toBe(true);
    expect(d.info.prdUrl).toBe('https://docs.example.com/prd/s3');

    // 评审：派单上的评审人必须看得见（R29：签字人就是派单上的那个人）
    expect(d.review).toMatchObject({
      reviewer: '吕正豪',
      role: 'feature_reviewer',
      line: '功能线',
      verdict: 'passed',
      verdictLabel: '通过',
    });
    expect(d.review!.decidedAt).toBeTruthy();

    // 记录：从建到排期每一步都在，且每条都有中文标签（未映射的类型会渲染成英文）
    expect(d.events.map((e) => e.type)).toEqual([
      'requirement.created',
      'requirement.evaluated',
      'requirement.review_requested',
      'requirement.review_passed',
      'requirement.scheduled',
    ]);
    expect(d.events.every((e) => e.label.length > 0 && !e.label.includes('requirement.'))).toBe(true);
    expect(d.events.at(-1)!.note).toContain(due);
    expect(d.events.every((e) => /^\d{2}-\d{2}$/.test(e.dateLabel))).toBe(true);

    // 动作：测试中只有打回与搁置
    expect(d.actions).toEqual(['bounce', 'shelve']);
  });

  it('动作随状态变，终态只剩恢复', async () => {
    const inbox = await seedInbox('房超');
    // 收集（inbox）里没有「评估」：D1 之后它不可能成功，入口搬到了参考段的评估材料行。
    // 收进的直提评审这条路仍然开着（spec §6：评估是加速器，不是关卡）。
    expect((await getRequirementDetail(inbox.id))!.actions).toEqual([
      'submitReview', 'reject', 'shelve',
    ]);

    const review = await seedInReview('commercial');
    expect((await getRequirementDetail(review))!.actions).toEqual([
      'reviewPass', 'reviewReject', 'shelve',
    ]);

    // 待开发 / 开发中不是「只能等」：spec 说每个非终态都能搁置
    const ready = await seedReady('房超');
    expect((await getRequirementDetail(ready))!.actions).toEqual(['shelve']);

    await shelveRequirement(db, '吕品', { requirementId: inbox.id, reason: '本期不做' });
    const shelved = (await getRequirementDetail(inbox.id))!;
    expect(shelved.actions).toEqual(['restore']);
    expect(shelved.stateLabel).toBe('已搁置');

    // 任何状态都不再给「评估」（P2 Task 4）：它不可能成功，入口在参考段的评估材料行。
    // 上面四个状态覆盖了 inbox / review / ready / shelved，这里只盯这一件事。
    for (const actions of [
      (await getRequirementDetail(inbox.id))!.actions,  // inbox 已搁置
      (await getRequirementDetail(review))!.actions,
      (await getRequirementDetail(ready))!.actions,
    ]) {
      expect(actions).not.toContain('evaluate');
    }
  });

  it('找不到的需求返回 null，而不是抛错', async () => {
    expect(await getRequirementDetail('00000000-0000-0000-0000-000000000000')).toBeNull();
    // 非 uuid 也不该把页面炸掉：PG 的 22P02 不是给页面看的东西
    expect(await getRequirementDetail('not-a-uuid')).toBeNull();
  });
});

/** 上海日历日的 'MM-DD'：产物刚写进去，那一行的时间必须是今天。 */
function shanghaiMonthDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
  }).format(now);
}

/**
 * 参考段的三处槽位现在读 `uemaster_artifacts`（P2 的 Task 2）。
 *
 * 断言的是读模型给页面看的那一份形状：`{ stage, label, url, at, atLabel, present }`。
 * 抽屉只渲染 `present` 为真的行，所以「没有产物」必须是不出现，而不是出现一行「—」。
 */
describe('参考段：三处槽位从产物表读', () => {
  it('有产物时该槽位 present 为真，带 url 与当天的 atLabel', async () => {
    const r = await seedInbox('房超');
    await writeArtifact('/uemaster/PAN-7/evaluate.html');
    await attachArtifact(db, '吕品', {
      requirementId: r.id, stage: 'evaluate', url: '/uemaster/PAN-7/evaluate.html',
    });

    const d = (await getRequirementDetail(r.id))!;
    expect(d.refs.find((x) => x.stage === 'evaluate')).toMatchObject({
      label: '评估材料',
      url: '/uemaster/PAN-7/evaluate.html',
      present: true,
      atLabel: shanghaiMonthDay(),
    });
    expect(d.refs.find((x) => x.stage === 'evaluate')!.at).toBeTruthy();

    // 只接了一处：走查那一行不能跟着一起点亮
    expect(d.refs.find((x) => x.stage === 'inspect')).toMatchObject({
      label: '走查材料', url: null, at: null, atLabel: null, present: false,
    });
  });

  it('没有产物时两处 present 为假，url 与 atLabel 都是 null', async () => {
    const r = await seedInbox('房超');
    const d = (await getRequirementDetail(r.id))!;

    for (const stage of ['evaluate', 'inspect'] as const) {
      expect(d.refs.find((x) => x.stage === stage)).toMatchObject({
        url: null, at: null, atLabel: null, present: false,
      });
    }
  });

  it('同一个 stage 有多份时读最新那一份', async () => {
    const r = await seedInbox('房超');
    const target = { requirementId: r.id, stage: 'evaluate' as const };
    await writeArtifact('/uemaster/PAN-7/evaluate-v1.html');
    await attachArtifact(db, '吕品', { ...target, url: '/uemaster/PAN-7/evaluate-v1.html' });
    // 两行同一毫秒写入时 `created_at desc` 会打平，定序就落到随机的 uuid 上：
    // 用例把第一份按下去一小时，读侧的选择才有唯一答案。
    await db.execute(sql`
      update uemaster_artifacts set created_at = now() - interval '1 hour'
       where requirement_id = ${r.id}`);
    await writeArtifact('/uemaster/PAN-7/evaluate-v2.html');
    await attachArtifact(db, '吕品', { ...target, url: '/uemaster/PAN-7/evaluate-v2.html' });

    const d = (await getRequirementDetail(r.id))!;
    expect(d.refs.find((x) => x.stage === 'evaluate')!.url)
      .toBe('/uemaster/PAN-7/evaluate-v2.html');
  });

  /**
   * review 那一行在 P2 Task 4 之后与另外两行同形：没有产物就是「评审材料」+ 复制任务包
   * （不再是「PRD 快照」这一行）。PRD 链接没有丢——它一直在信息段的「PRD 链接」一行，
   * 抽屉里照样点得到，只是参考段的三行不再让 review 特殊。
   */
  it('review 行：没产物时是待生成的评审材料，有产物就显示产物且 PRD 链接仍在', async () => {
    const id = await seedInReview('feature');
    const before = (await getRequirementDetail(id))!;
    expect(before.refs.find((x) => x.stage === 'review')).toMatchObject({
      label: '评审材料', url: null, present: false,
    });
    expect(before.info.prdUrl).toBe('https://docs.example.com/prd/r');

    await writeArtifact('/uemaster/PAN-7/review.html');
    await attachArtifact(db, '吕品', {
      requirementId: id, stage: 'review', url: '/uemaster/PAN-7/review.html',
    });
    const after = (await getRequirementDetail(id))!;
    expect(after.refs.find((x) => x.stage === 'review')).toMatchObject({
      label: '评审材料',
      url: '/uemaster/PAN-7/review.html',
      present: true,
      atLabel: shanghaiMonthDay(),
    });
    // PRD 链接没有被产物顶掉：它还在信息段里
    expect(after.info.prdUrl).toBe('https://docs.example.com/prd/r');
    // 参考段仍然只有三行（产物不新增行）
    expect(after.refs.map((x) => x.stage)).toEqual(['evaluate', 'review', 'inspect']);
  });

  it('既没有 PRD 也没有产物时 review 行仍是「评审材料」的槽位（present 为假）', async () => {
    const r = await seedInbox('房超');
    const d = (await getRequirementDetail(r.id))!;
    expect(d.refs.find((x) => x.stage === 'review')).toMatchObject({
      label: '评审材料', url: null, present: false,
    });
  });

  /**
   * 三行都带任务包正文（P2 Task 4）。参考段没有产物时是一个「复制任务包」按钮，
   * 按钮复制的是**服务端已经渲染进页面**的那段文本，所以它必须由读模型给出：
   * 页面在客户端没有 packFor，也不该为此发一次请求。
   */
  it('三行都带任务包正文：点名 UEmaster、这条需求与它自己的交付路径', async () => {
    // 有 PRD 的需求：三份包都是完整的那一版（没 PRD 时评审 / 走查的包会提前「停止」，
    // 那种形状由下面那条用例盯）。
    const id = await seedInReview('feature');
    const d = (await getRequirementDetail(id))!;
    expect(d.info.prdUrl).not.toBeNull();

    for (const stage of ['evaluate', 'review', 'inspect'] as const) {
      const ref = d.refs.find((x) => x.stage === stage)!;
      expect(ref.pack).toContain('UEmaster');
      expect(ref.pack).toContain(`PAN-${d.number}`);
      expect(ref.pack).toContain(d.title);
      expect(ref.pack).toContain(`/uemaster/PAN-${d.number}/${stage}.html`);
      // 复制出去的文本里必须有 uuid：agent 交回产物时只用得到它（不是 PAN-n）
      expect(ref.pack).toContain(d.id);
    }
  });

  /**
   * 缺 PRD 时评审 / 走查的包是一段「停止：到此停止…」。它照样交给页面：那段文字说的
   * 正是「缺什么」，按钮复制它才有意义——界面不该替他判断「这份包不值得复制」。
   */
  it('没有 PRD 时评审 / 走查的包是「停止」，仍然照给', async () => {
    const r = await seedInbox('房超');
    const d = (await getRequirementDetail(r.id))!;
    expect(d.info.prdUrl).toBeNull();
    expect(d.refs.find((x) => x.stage === 'evaluate')!.pack).not.toContain('停止');
    for (const stage of ['review', 'inspect'] as const) {
      expect(d.refs.find((x) => x.stage === stage)!.pack).toContain('停止');
    }
  });

  /**
   * 接上产物后时间轴会立刻多一种事件。`describe` 的兜底会把没映射的类型原样吐出来
   * （`uemaster.attached`），所以这条断言盯的是「中文 UI」这条硬口径。
   */
  it('提交产物的事件在时间轴上是中文，不是 uemaster.attached', async () => {
    const r = await seedInbox('房超');
    await writeArtifact('/uemaster/PAN-7/inspect.html');
    await attachArtifact(db, '吕品', {
      requirementId: r.id, stage: 'inspect', url: '/uemaster/PAN-7/inspect.html',
    });
    const last = (await getRequirementDetail(r.id))!.events.at(-1)!;
    expect(last).toMatchObject({
      type: 'uemaster.attached', label: '提交走查材料', actor: '吕品',
    });
    expect(last.note).toBe('/uemaster/PAN-7/inspect.html');
  });
});

describe('listReleases', () => {
  it('带出在途条数与延期条数，以及每条需求的日期', async () => {
    const live = await seedOneTesting({ title: '在期的一条' });
    const late = await seedOneTesting({ commitDueAt: PAST, title: '延期的一条' });

    const releases = await listReleases();
    const r = releases.find((x) => x.name === `R-${live.due}`)!;
    expect(r.windowStart).toContain(live.windowStart);
    expect(r.releaseDate).toContain(live.due);
    expect(r.inFlight).toBe(1);
    expect(r.late).toBe(0);
    expect(r.timeUsed).not.toBeNull();
    expect(r.requirements.map((x) => x.title)).toEqual(['在期的一条']);
    expect(r.requirements[0]).toMatchObject({ state: 'test', stateLabel: '测试中' });
    expect(r.requirements[0]!.commitDueAt).toContain(live.due);
    expect(r.requirements[0]!.dueAtLabel).toBe(md(live.due));

    const lateRelease = releases.find((x) => x.name === `R-${late.due}`)!;
    expect(lateRelease.late).toBe(1);
    expect(lateRelease.requirements[0]!.late).toBe(true);
  });

  it('已上线的需求不算在途、也不算延期', async () => {
    const { id, releaseId } = await seedOneTesting({ commitDueAt: PAST });
    await db.execute(sql`update requirements set state = 'live' where id = ${id}`);
    const r = (await listReleases()).find((x) => x.id === releaseId)!;
    expect(r.inFlight).toBe(0);
    expect(r.shipped).toBe(1);
    expect(r.late).toBe(0);
    expect(r.requirements[0]).toMatchObject({ state: 'live', late: false });
  });
});
