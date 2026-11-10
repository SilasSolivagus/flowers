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
import { BRIEF } from './helpers/brief.js';
import { makeRelease } from './helpers/factory.js';
import { getBoard } from '../src/core/read/board.js';
import { getRequirementDetail } from '../src/core/read/detail.js';
import { attachArtifact } from '../src/core/uemaster/attach.js';
import { cleanArtifacts, removeArtifact, writeArtifact } from './helpers/files.js';
import { listReleases } from '../src/core/read/version.js';
import { actorFromCookie, listMembers } from '../src/core/read/member.js';

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
  // attach 现在会 stat 站内链接，这些用例在 data/uemaster/ 下造了真文件。
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

/**
 * 签字人 = 负责人所在条线的负责人（P4-06）。负责人没有条线（房超）时由他自己签——
 * 那一条只有超管能动，而超管不受派单限制。写死名字，不从实现反查。
 */
function signerFor(owner: string): string {
  switch (owner) {
    case '吕品':
    case '李嘉':
      return '吕正豪';
    case '王妍':
    case '罗丹':
      return '赵越';
    case '房超':
      return '房超';
    default:
      throw new Error(`不知道 ${owner} 在哪条线`);
  }
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
  /**
   * P4-04：**以负责人的身份**走完全程。
   *
   * 以前这里由「吕品」替别人建需求、替别人排期——那正是权限层上线后不允许的事（PM
   * 只能改自己负责的需求）。规则 1「录入即负责人」让这个助手更短：谁建谁负责，
   * 后面的每一步都由同一个人做。
   */
  const owner = opts.owner ?? '吕品';
  const r = await createRequirement(db, owner, { ...BRIEF,
    title: opts.title ?? 'S3 协议支持',
    type: opts.type ?? 'feature',
    requester: '孙建宏',
  });
  await evaluate(db, owner, { requirementId: r.id });
  await submitReview(db, owner, {
    requirementId: r.id,
    prdUrl: 'https://docs.example.com/prd/s3',
  });
  await reviewPass(db, signerFor(owner), { requirementId: r.id });
  await schedule(db, owner, {
    requirementId: r.id, releaseId, commitTestAt: testAt, commitDueAt: due,
  });
  await db.execute(sql`update requirements set state = 'test' where id = ${r.id}`);
  return { id: r.id, number: r.number, releaseId, due, windowStart, testAt };
}

/** 建一条停在 inbox 的需求（除了标题 / 提出人什么都没填，也永远没有版本）。 */
async function seedInbox(requester = '房超', owner?: string) {
  // 由超管建：要造「没有负责人」的卡，只有超管能显式传 null（见 create.ts 的
  // resolveOwner）；有负责人时由超管指定也不受条线限制。
  const r = await createRequirement(db, '房超', { ...BRIEF,
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
  const r = await createRequirement(db, owner, { ...BRIEF,
    title: 'PC 端支持打开分享页',
    type: 'feature',
    requester: '孙建宏',
  });
  await evaluate(db, owner, { requirementId: r.id });
  await submitReview(db, owner, { requirementId: r.id, prdUrl: 'https://docs.example.com/prd/r' });
  await reviewPass(db, signerFor(owner), { requirementId: r.id });
  await schedule(db, owner, {
    requirementId: r.id,
    releaseId,
    commitTestAt: shiftDay(TODAY, 9),
    commitDueAt: shiftDay(TODAY, 12),
  });
  return r.id;
}

/**
 * 建一条推到 review 的需求。
 *
 * P4-06：**负责人挑在对应的条线上**——功能类交给功能线 PM（吕品，派给吕正豪），
 * 商业类交给商业线 PM（王妍，派给赵越）。类型与负责人故意保持一致，是为了让这一组
 * 读模型用例继续只关心「读」；「类型与条线错开」的那一格由 auth / permission-ui 钉。
 */
async function seedInReview(type: 'commercial' | 'feature') {
  const owner = type === 'commercial' ? '王妍' : '吕品';
  const r = await createRequirement(db, owner, { ...BRIEF,
    title: type === 'commercial' ? '直链分享限速（二期）' : '导出任务队列改造',
    type,
    requester: owner,
  });
  await evaluate(db, owner, { requirementId: r.id });
  await submitReview(db, owner, { requirementId: r.id, prdUrl: 'https://docs.example.com/prd/r' });
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
  it('listMembers 返回七个人，两条评审线与一个超管都在', async () => {
    const rows = await listMembers();
    expect(rows.map((m) => m.name).sort()).toEqual(
      ['吕品', '吕正豪', '房超', '李嘉', '王妍', '罗丹', '赵越'].sort(),
    );
    expect(rows.every((m) => m.id.length > 0)).toBe(true);
    expect(rows.map((m) => m.role)).toContain('commercial_reviewer');
    expect(rows.map((m) => m.role)).toContain('feature_reviewer');
    expect(rows.map((m) => m.role)).toContain('product_owner');
    // PM 也有条线（P4-04）：条线是人的属性，不只是评审人的
    expect(rows.filter((m) => m.role === 'pm').every((m) => m.line !== null)).toBe(true);
  });

  /**
   * P4-04：旧的 `flowers_actor` cookie **不再**是身份。
   *
   * 这条用例原来钉的是「缺省退回写死的吕品」——那正是 owner 撞到的 bug（他是房超，
   * 应用每次都说他是吕品）。现在它钉相反的事：解析器对缺值与坏值一律给 null，
   * 「我是谁」由 `currentMember()` 按会话 → 环境变量 → 第一个超管 的顺序回答。
   * 真值顺序的用例在 `tests/auth.test.ts`。
   */
  it('旧 cookie 解析器：缺值与空白是 null，好值照旧解码', () => {
    expect(actorFromCookie(undefined)).toBeNull();
    expect(actorFromCookie('')).toBeNull();
    expect(actorFromCookie(encodeURIComponent('房超'))).toBe('房超');
    // 坏值不抛错：一个手改过的 cookie 只该等于「没身份」，不该让整页 500
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
    // 默认负责人是吕品（功能线）：P4-06 之后签字人是他的条线负责人吕正豪。
    expect(card.owner).toBe('吕品');
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
    // P4-04：搁置也要过权限——房超是负责人（也是超管），吕品是 PM、不负责这条。
    await shelveRequirement(db, '房超', { requirementId: r.id, reason: '本期不做' });
    const card = await cardOf('shelved', r.id, '房超');
    expect(card.waiting).toBe('—');
    expect(card.waitingOn).toBe('none');
    // 恢复是可选的，所以搁置的卡不算「需要你动手」
    expect(card.mine).toBe(false);
  });
});

/** 建一条推到「已上线」的需求：走真实服务到测试中，再把状态列改成 live（与上面同一条口径）。 */
async function seedLive() {
  const seeded = await seedOneTesting();
  await db.execute(sql`update requirements set state = 'live' where id = ${seeded.id}`);
  return seeded;
}

/**
 * 走查是**一个状态**，不是一句提示。
 *
 * P2 收口时看板上 `live` 的卡写着「可发起走查」——那句话说的是「你可以动」，不是
 * 「这件事做没做」，于是同一列里做过与没做过的卡长得一模一样。改成两态之后，
 * 判断依据是 `uemaster_artifacts` 里有没有 `stage='inspect'` 的行，而那个事实由
 * `getBoard` 那条大 SQL 一次带出来（`inspectAtLabel`），组件不查库。
 */
describe('已上线：走查做没做过', () => {
  it('没有走查材料：待走查，且仍然不欠任何人动作', async () => {
    const { id } = await seedLive();
    const card = await cardOf('live', id, '房超');
    expect(card.waiting).toBe('待走查');
    expect(card.waitingOn).toBe('none');
    expect(card.inspectAtLabel).toBeNull();
    // 走查是可选的，不是「你的卡」
    expect(card.mine).toBe(false);
  });

  it('交回走查材料之后：已走查 · MM-DD，日期就是那份材料的日期', async () => {
    const { id } = await seedLive();
    await writeArtifact('/uemaster/PAN-9/inspect.html');
    await attachArtifact(db, '吕品', {
      requirementId: id, stage: 'inspect', url: '/uemaster/PAN-9/inspect.html',
    });
    // 把写入时刻钉死一个已知的 UTC 零点（上海同一天 08:00），标签就与运行时间无关。
    await db.execute(sql`update uemaster_artifacts set created_at = '2026-01-02T00:00:00Z'`);

    const card = await cardOf('live', id, '吕品');
    expect(card.inspectAtLabel).toBe('01-02');
    expect(card.waiting).toBe('已走查 · 01-02');
    expect(card.waitingOn).toBe('none');
    expect(card.mine).toBe(false);
  });

  it('走查材料重做过：取最新那一份（与抽屉的 listArtifacts 同一个口径）', async () => {
    const { id } = await seedLive();
    await writeArtifact('/uemaster/PAN-9/inspect.html');
    await attachArtifact(db, '吕品', {
      requirementId: id, stage: 'inspect', url: '/uemaster/PAN-9/inspect.html',
    });
    await writeArtifact('/uemaster/PAN-9/inspect-v2.html');
    await attachArtifact(db, '吕品', {
      requirementId: id, stage: 'inspect', url: '/uemaster/PAN-9/inspect-v2.html',
    });
    await db.execute(sql`
      update uemaster_artifacts set created_at = '2026-01-02T00:00:00Z'
       where url = '/uemaster/PAN-9/inspect.html'`);
    await db.execute(sql`
      update uemaster_artifacts set created_at = '2026-03-04T00:00:00Z'
       where url = '/uemaster/PAN-9/inspect-v2.html'`);

    const card = await cardOf('live', id, '吕品');
    expect(card.waiting).toBe('已走查 · 03-04');
    expect(card.inspectAtLabel).toBe('03-04');
  });

  it('别的需求的走查材料不算在我头上', async () => {
    const mine = await seedLive();
    const other = await seedLive();
    await writeArtifact('/uemaster/PAN-9/inspect.html');
    await attachArtifact(db, '吕品', {
      requirementId: other.id, stage: 'inspect', url: '/uemaster/PAN-9/inspect.html',
    });
    expect((await cardOf('live', mine.id, '吕品')).waiting).toBe('待走查');
    expect((await cardOf('live', other.id, '吕品')).waiting).toMatch(/^已走查 · /);
  });

  it('评审材料不算走查：只认 stage=inspect', async () => {
    const { id } = await seedLive();
    await writeArtifact('/uemaster/PAN-9/review.html');
    await attachArtifact(db, '吕品', {
      requirementId: id, stage: 'review', url: '/uemaster/PAN-9/review.html',
    });
    expect((await cardOf('live', id, '吕品')).waiting).toBe('待走查');
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
    const feature = await seedInReview('feature'); // owner 吕品（功能线），派给吕正豪
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
      // 负责人是房超，所以评估也得由房超做（PM 不能改别人的需求）。
      await evaluate(db, '房超', { requirementId: r.id });
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

/**
 * 裁定 6（2026-11-08）：缺日期的时钟状态要**被看板说破**。
 *
 * 这一组是「下一次别再让这种事悄悄发生」的那一半：迁移 `0024` 把已经缺日期的行退回
 * 待排期，但将来还会有人（导入脚本、MCP、直接写库）把一条缺日期的行放进 `dev`——
 * 那时 `schedule` 的 `missing_dates` 管不到，库里也没有 CHECK（理由见 0024 的注释）。
 * 于是最后一层提醒只剩读模型：卡片必须点名缺的是哪一天，而不是显示一句看起来正常的
 * 「等开工日 11-14」。
 *
 * 为什么不用字符串断言了事、而是连 `missingDates` 一起断言：那句话是从这一格拼出来的
 * （`waiting` = 「缺」+ 词表），只钉字符串的话，把 `missingDates` 清空、留下一个写死的
 * 字符串也能过——那样的用例什么都没钉住。
 */
describe('缺日期的时钟状态：卡片点名缺的是哪一天', () => {
  /**
   * 目标用例（缺警告就红）：一条 `ready` 行没有提测日。
   *
   * 形状是**迁移数据**的形状：版本与开工日都在（`seedReady` 排过期），提测日从来没填过。
   * 这种行开工日到了会被时钟推进到开发中，然后永远冻在那里——所以它在待开发这一列
   * 就已经是「排期没填完」，卡片该说的不是「等开工日」，是「缺提测日」。
   */
  it('待开发缺提测日：说「缺提测日」，不装作在等开工日', async () => {
    const id = await seedReady('房超');
    await db.execute(sql`update requirements set commit_test_at = null where id = ${id}`);

    const card = await cardOf('ready', id, '房超');
    expect(card.missingDates).toEqual(['commit_test_at']);
    expect(card.waiting).toBe('缺提测日');
    // 缺日期不产生「欠谁的卡」：该修的是数据，不是负责人欠一个动作。
    expect(card.waitingOn).toBe('none');
    expect(card.mine).toBe(false);
  });

  it('开发中缺承诺完成日：说「缺承诺完成日」（提测日在，但走出去就冻住）', async () => {
    const { id } = await seedOneTesting();
    await db.execute(sql`
      update requirements set state = 'dev', commit_due_at = null where id = ${id}`);

    const card = await cardOf('dev', id, '吕品');
    expect(card.missingDates).toEqual(['commit_due_at']);
    expect(card.waiting).toBe('缺承诺完成日');
    expect(card.waitingOn).toBe('none');
  });

  it('测试中缺承诺完成日：说「缺承诺完成日」', async () => {
    const { id } = await seedOneTesting();
    await db.execute(sql`update requirements set commit_due_at = null where id = ${id}`);

    const card = await cardOf('test', id, '吕品');
    expect(card.missingDates).toEqual(['commit_due_at']);
    expect(card.waiting).toBe('缺承诺完成日');
  });

  it('几个都缺就一起点名（词序按状态需要的那几列，不是按库里读出来的顺序）', async () => {
    const id = await seedReady('房超');
    // 没有版本 = 没有开工日；提测日也空着。这正是 0024 执行前那 18 条 ready 的形状。
    await db.execute(sql`
      update requirements set release_id = null, commit_test_at = null where id = ${id}`);

    const card = await cardOf('ready', id, '房超');
    expect(card.missingDates).toEqual(['window_start', 'commit_test_at']);
    expect(card.waiting).toBe('缺开工日、提测日');
  });

  it('日期齐全的卡一条都不误报（missingDates 为空、仍然等日期）', async () => {
    const ready = await seedReady('房超');
    const testing = await seedOneTesting();

    const readyCard = await cardOf('ready', ready, '房超');
    expect(readyCard.missingDates).toEqual([]);
    expect(readyCard.waiting).toMatch(/^等开工日 /);
    expect(readyCard.waitingOn).toBe('clock');
    expect((await cardOf('test', testing.id, '吕品')).missingDates).toEqual([]);
  });

  it('其它状态不看日期：收集列的 missingDates 恒为空', async () => {
    const r = await seedInbox('房超');
    expect((await cardOf('inbox', r.id, '房超')).missingDates).toEqual([]);
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
      owner: '吕品',
      // P4-06 加的：负责人所在条线（权限锚点）必须被读出来，抽屉要显示它。
      ownerLine: 'feature',
      ownerLineLabel: '功能线',
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
    // 收集（inbox）里现在有「立项」：认领只给负责人、不动状态，而收集状态的唯一出口
    // 就是 inbox → 待设计。收进的直提评审那条路仍然开着（spec §6：评估是加速器，不是关卡）。
    // 动作名 2026-11-10 从 `evaluate` 改成 `approve`（它就是「立项」，与出材料无关）。
    expect((await getRequirementDetail(inbox.id))!.actions).toEqual([
      'approve', 'submitReview', 'reject', 'shelve',
    ]);

    const review = await seedInReview('commercial');
    expect((await getRequirementDetail(review))!.actions).toEqual([
      'reviewPass', 'reviewReject', 'shelve',
    ]);

    // 待开发 / 开发中不是「只能等」：spec 说每个非终态都能搁置
    const ready = await seedReady('房超');
    expect((await getRequirementDetail(ready))!.actions).toEqual(['shelve']);

    await shelveRequirement(db, '房超', { requirementId: inbox.id, reason: '本期不做' });
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

  /**
   * 2026-11-08 事故的读侧那一半：`data/uemaster/` 被一次 `git clean -fdx` 整个删掉，
   * 而 `uemaster_artifacts` 的行还在。`present` 说的是「库里有没有这一行」，
   * 所以它仍然是 `true`；**新加的那一格 `filePresent` 说的才是「盘上还有没有文件」**。
   * 这两个答案必须能同时给出，否则界面只有两种选择：画一条 404 链接，或者假装
   * 这份材料从没生成过（后者更糟：日期、版本数、指纹全都对不上）。
   */
  it('行在、文件也在：filePresent 为真（照旧给链接）', async () => {
    const r = await seedInbox('房超');
    await writeArtifact('/uemaster/PAN-7/evaluate.html');
    await attachArtifact(db, '吕品', {
      requirementId: r.id, stage: 'evaluate', url: '/uemaster/PAN-7/evaluate.html',
    });

    const ref = (await getRequirementDetail(r.id))!.refs.find((x) => x.stage === 'evaluate')!;
    expect(ref).toMatchObject({
      present: true, filePresent: true, url: '/uemaster/PAN-7/evaluate.html',
    });
  });

  it('行在、文件被删掉：present 仍为真，filePresent 为假', async () => {
    const r = await seedInbox('房超');
    await writeArtifact('/uemaster/PAN-7/evaluate.html');
    await attachArtifact(db, '吕品', {
      requirementId: r.id, stage: 'evaluate', url: '/uemaster/PAN-7/evaluate.html',
    });
    // 模拟那场事故：只删文件，不碰库里的行。
    await removeArtifact('/uemaster/PAN-7/evaluate.html');

    const ref = (await getRequirementDetail(r.id))!.refs.find((x) => x.stage === 'evaluate')!;
    expect(ref).toMatchObject({
      // 库里的那行还在：url / 日期 / 版本数一样不少，界面因此还能说清「丢的是哪一份」
      present: true, url: '/uemaster/PAN-7/evaluate.html', atLabel: shanghaiMonthDay(),
      // 但盘上没有了——这一格是界面据以画「文件已丢失」的唯一依据
      filePresent: false,
    });
  });

  it('站外链接不由本地磁盘判死活：filePresent 为 null', async () => {
    const r = await seedInbox('房超');
    await attachArtifact(db, '吕品', {
      requirementId: r.id, stage: 'evaluate', url: 'https://docs.example.com/uemaster/e.html',
    });

    const ref = (await getRequirementDetail(r.id))!.refs.find((x) => x.stage === 'evaluate')!;
    // 别人的服务器上那份文件我们够不着：不给结论，界面照旧给它一个链接。
    expect(ref).toMatchObject({ present: true, filePresent: null });
  });

  it('没有产物行时 filePresent 也是假：本来就没有文件可丢', async () => {
    const r = await seedInbox('房超');
    const d = (await getRequirementDetail(r.id))!;
    expect(d.refs.every((x) => x.present === false && x.filePresent === false)).toBe(true);
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
   * P2.6：参考段那一行现在给的是**正在生成的作业**，不再是任务包正文。
   *
   * 任务包搬到了服务端（worker 里 `packFor` 自己算），页面不需要它：按钮按下去
   * 由后台把包喂给 CLI。页面要知道的只有「这个阶段现在有没有人在跑」，因为
   * 「生成中」必须活过刷新——只放在客户端 state 里的话，一刷新就变成一个可以
   * 再按一次的「生成」，按下去只能撞「正在生成中」。
   */
  it('三行默认都没有正在生成的作业；只有 running 的那一行带 generation', async () => {
    const id = await seedInReview('feature');
    const before = (await getRequirementDetail(id))!;
    for (const stage of ['evaluate', 'review', 'inspect'] as const) {
      expect(before.refs.find((x) => x.stage === stage)!.generation).toBeNull();
    }

    // 直接在库里造一条 running 作业：这条用例盯的是读模型，不是 startGeneration。
    const job = await db.execute<{ id: string }>(sql`
      insert into uemaster_jobs (requirement_id, stage, status)
      values (${id}, 'review', 'running') returning id`);
    const jobId = job.rows[0]!.id;

    const after = (await getRequirementDetail(id))!;
    // 2026-11-10 起这一格多了三格（`startedAt` / `phase` / `attempt`）：抽屉里
    // 「正在跑」那一行要显示「在第几步、跑了多久、第几次尝试」，而这三件事在服务端
    // 渲染时就该知道（否则刷新后的第一帧又只剩下「生成中」三个字）。
    // 刚造出来的这条作业一次尝试都没有 → `phase` 为 null、`attempt` 为 0，
    // 界面按 `phases.ts` 折成「正在读 PRD」。
    expect(after.refs.find((x) => x.stage === 'review')!.generation).toMatchObject({
      id: jobId, phase: null, attempt: 0,
    });
    expect(
      (after.refs.find((x) => x.stage === 'review')!.generation as { startedAt: string }).startedAt,
    ).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 另外两行不受影响：一条作业只属于它自己的那个阶段。
    expect(after.refs.find((x) => x.stage === 'evaluate')!.generation).toBeNull();
    expect(after.refs.find((x) => x.stage === 'inspect')!.generation).toBeNull();
  });

  /**
   * 只有 `running` 算「生成中」。done / failed 是历史：成功已经由产物链接回答
   * （`listArtifacts`），失败是行内一次性的提示——刷新之后那一行该回到「生成」，
   * 否则一次失败会把这条需求永久画成坏的，也没有重试的入口。
   */
  it('done / failed 的作业不算「生成中」', async () => {
    const id = await seedInReview('feature');
    await db.execute(sql`
      insert into uemaster_jobs (requirement_id, stage, status, error, finished_at) values
        (${id}, 'evaluate', 'failed', 'Failed to authenticate: OAuth session expired', now()),
        (${id}, 'inspect', 'done', null, now())`);
    const d = (await getRequirementDetail(id))!;
    for (const stage of ['evaluate', 'review', 'inspect'] as const) {
      expect(d.refs.find((x) => x.stage === stage)!.generation).toBeNull();
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
