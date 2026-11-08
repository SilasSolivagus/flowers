import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { reviewPass, reviewReject } from '../src/core/requirements/review.js';
import { schedule } from '../src/core/requirements/schedule.js';
import { bounce } from '../src/core/requirements/bounce.js';
import { shelveRequirement } from '../src/core/requirements/terminal.js';
import { updateRequirement } from '../src/core/requirements/manage.js';
import { startOfShanghaiDay, tick } from '../src/core/clock/tick.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { makeRelease } from './helpers/factory.js';
import {
  latestNoticeSeq, markRead, notificationsFor, notifyView, pendingDeliveries, unreadCount,
  type Notice,
} from '../src/core/read/notify.js';

/**
 * 站内通知（P4-03）的用例：全部对着真库跑，不 mock。
 *
 * 通知是 `events` 的投影，所以「谁收到」这件事只能在 SQL 上验证——把谓词拆成 JS
 * 纯函数再测，测到的是我以为的库。每条规则都**同时断言两侧**：该收到的人有，不该
 * 收到的人没有。只测「有」的话，一条「发给所有人」的实现会让所有用例都绿。
 *
 * 日期相对今天算（与 read.test.ts 同一条理由）：写死 2026-12 的叙事会在那一天之后
 * 逐条腐烂，而代码一行没错。
 */

let people: Array<{ id: string; name: string; role: string; line: string | null }> = [];

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

/**
 * 内存里那一行 + **摊平的档位**。
 *
 * P4-07 起 `notify_prefs` 默认是 `key`（只收「要动手 + 有结果」），而这一组用例钉的
 * 是「谁该收到」——观众谓词，不是档位。所以显式写 `site: all`：类过滤不参与，
 * 每条断言的差异只可能来自观众规则。档位本身的九格在 tests/notify-channels.test.ts。
 */
const ALL_LEVELS = '{"site":"all","wecom":"off"}';

function member(name: string): {
  id: string; name: string; role: string; line: string | null; notifyPrefs: string;
} {
  const found = people.find((p) => p.name === name);
  if (!found) throw new Error(`种子里没有成员 ${name}`);
  return { ...found, notifyPrefs: ALL_LEVELS };
}

const PM = '吕品';
const FEATURE_REVIEWER = '吕正豪';
const COMMERCIAL_REVIEWER = '赵越';

/**
 * 签字人 = 负责人所在条线的负责人（P4-06）。写死名字，不从实现反查。
 * 通知用例里负责人总是王妍（商业线），所以签字人是赵越——**与需求类型无关**，
 * 于是下面那些 type: 'feature' 的需求同样由商业线负责人签。
 */
function signerFor(owner: string): string {
  const found = member(owner);
  if (found.line === 'feature') return FEATURE_REVIEWER;
  if (found.line === 'commercial') return COMMERCIAL_REVIEWER;
  return owner; // 没有条线（超管）：自己签
}

const TODAY = new Date().toISOString().slice(0, 10);
const FUTURE = shiftDay(TODAY, 30);
const PAST = shiftDay(TODAY, -30);

function shiftDay(day: string, delta: number): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + delta);
  return at.toISOString().slice(0, 10);
}

function typesOf(notices: Notice[]): string[] {
  return notices.map((notice) => notice.type);
}

/** 这条需求有没有出现在这个人的 feed 里（按 id，不看类型）。 */
function has(notices: Notice[], requirementId: string): boolean {
  return notices.some((notice) => notice.requirementId === requirementId);
}

/**
 * 造一条「测试中」的需求，走真实服务链：create → evaluate → submitReview
 * → reviewPass → schedule → 两次 tick（ready→dev→test）。
 *
 * 两次 tick 而不是一次：时钟一次只推一步（见 clock/tick.ts），这是刻意的——
 * 跨两步的需求要在两个不同的「今天」被推两次。这里两次都用今天，因为排期把
 * 开工日与提测日都放在了过去/今天，两条边都已到点。
 */
async function toTestState(owner: string, title = 'S3 协议支持') {
  // P4-04：以负责人身份建与推进（PM 只能改自己负责的需求；建人即负责，见 create.ts）。
  const created = await createRequirement(db, owner, {
    title, type: 'feature', requester: PM,
  });
  await evaluate(db, owner, { requirementId: created.id });
  await submitReview(db, owner, { requirementId: created.id, prdUrl: 'https://x' });
  await reviewPass(db, signerFor(owner), { requirementId: created.id });
  const releaseId = await makeRelease('R-测试', PAST, FUTURE);
  await schedule(db, owner, {
    requirementId: created.id, releaseId, commitTestAt: TODAY, commitDueAt: FUTURE,
  });
  await tick(db, startOfShanghaiDay(TODAY));
  await tick(db, startOfShanghaiDay(TODAY));
  return created;
}

describe('派生规则：谁收到哪条事件', () => {
  it('进入收集：提出人（按姓名）与全部 PM 收到，别人不收到', async () => {
    const created = await createRequirement(db, PM, {
      title: 'S3 协议支持', type: 'feature', requester: FEATURE_REVIEWER,
    });

    // 提出人：姓名在名册里（吕正豪是功能线评审人，不是 PM，所以这一条只能来自姓名匹配）
    expect(has(await notificationsFor(db, member(FEATURE_REVIEWER)), created.id)).toBe(true);
    // PM：三个都是（spec §8「进入 inbox → 提出人 + PM」）
    for (const name of ['吕品', '房超', '王妍']) {
      expect(has(await notificationsFor(db, member(name)), created.id)).toBe(true);
    }
    // 商业线评审人既不是提出人也不是 PM：一条都不该有
    expect(await notificationsFor(db, member(COMMERCIAL_REVIEWER))).toEqual([]);
  });

  it('进入待设计：只有负责人收到（评估人、提出人都不收到）', async () => {
    const owner = member('王妍');
    const created = await createRequirement(db, owner.name, {
      title: '权益套餐结构', type: 'commercial', requester: PM,
    });
    await evaluate(db, owner.name, { requirementId: created.id });

    const forOwner = await notificationsFor(db, owner);
    expect(typesOf(forOwner)).toContain('requirement.evaluated');
    expect(has(forOwner, created.id)).toBe(true);

    // 评估人（吕品）是 PM，会收到 created，但不该收到 evaluated
    const forActor = await notificationsFor(db, member(PM));
    expect(typesOf(forActor)).not.toContain('requirement.evaluated');
  });

  it('进入待评审：只有派单的评审人收到（负责人、PM 都不收到）', async () => {
    // 负责人放在功能线：这条需求派给吕正豪（P4-06 锚点是人的条线，不是类型）。
    const owner = member(PM);
    const created = await createRequirement(db, owner.name, {
      title: '导出任务队列', type: 'feature', requester: PM,
    });
    await evaluate(db, owner.name, { requirementId: created.id });
    await submitReview(db, owner.name, { requirementId: created.id, prdUrl: 'https://x' });

    const forReviewer = await notificationsFor(db, member(FEATURE_REVIEWER));
    expect(typesOf(forReviewer)).toContain('requirement.review_requested');
    expect(has(forReviewer, created.id)).toBe(true);

    // 负责人与商业线评审人都不是这条的观众
    expect(typesOf(await notificationsFor(db, owner))).not.toContain(
      'requirement.review_requested',
    );
    expect(has(await notificationsFor(db, member(COMMERCIAL_REVIEWER)), created.id)).toBe(false);
  });

  it('评审打回：负责人收到，且行里带原因', async () => {
    const owner = member('王妍');
    const created = await createRequirement(db, owner.name, {
      title: '导出任务队列', type: 'feature', requester: PM,
    });
    await evaluate(db, owner.name, { requirementId: created.id });
    await submitReview(db, owner.name, { requirementId: created.id, prdUrl: 'https://x' });
    await reviewReject(db, signerFor(owner.name), {
      requirementId: created.id, reason: '缺少回滚方案',
    });

    const forOwner = await notificationsFor(db, owner);
    const notice = forOwner.find((item) => item.type === 'requirement.review_rejected');
    expect(notice).toBeDefined();
    expect(notice!.line).toContain('评审打回');
    expect(notice!.line).toContain('缺少回滚方案');

    // 评审人不是观众（打回是给负责人的）；他手里只有更早的 review_requested
    expect(typesOf(await notificationsFor(db, member(FEATURE_REVIEWER))))
      .not.toContain('requirement.review_rejected');
  });

  it('进入测试中：只有负责人收到（评审人不收到）', async () => {
    const owner = member(PM);
    const created = await toTestState(owner.name);

    const forOwner = await notificationsFor(db, owner);
    expect(typesOf(forOwner)).toContain('requirement.auto_test');
    expect(forOwner.find((item) => item.type === 'requirement.auto_test')!.line)
      .toContain('进入测试中');

    /**
     * 评审人**现在也会收到** auto_test：他是功能线的负责人，扇出让他收本线全部变更
     * （P4-04）。旧断言（「评审人收不到」）随扇出作废；仍然要守的是「另一条线的
     * 负责人收不到」——那才是这条用例原本要证明的东西。
     */
    expect(typesOf(await notificationsFor(db, member(FEATURE_REVIEWER))))
      .toContain('requirement.auto_test');
    expect(typesOf(await notificationsFor(db, member(COMMERCIAL_REVIEWER))))
      .not.toContain('requirement.auto_test');
  });

  it('打回开发中：负责人收到，行里带新承诺日', async () => {
    const owner = member(PM);
    const created = await toTestState(owner.name);
    await bounce(db, owner.name, {
      requirementId: created.id, newCommitDueAt: FUTURE, reason: '接口没对齐',
    }, new Date());

    const forOwner = await notificationsFor(db, owner);
    const notice = forOwner.find((item) => item.type === 'requirement.bounced');
    expect(notice).toBeDefined();
    expect(notice!.line).toContain('打回开发中');
    expect(notice!.line).toContain(FUTURE);

    // 同上一组：本线负责人收得到，另一条线收不到。
    expect(typesOf(await notificationsFor(db, member(FEATURE_REVIEWER))))
      .toContain('requirement.bounced');
    expect(typesOf(await notificationsFor(db, member(COMMERCIAL_REVIEWER))))
      .not.toContain('requirement.bounced');
  });

  it('打回后重新提交：两轮 review_requested 都归同一个派单评审人', async () => {
    const owner = member(PM);
    const created = await createRequirement(db, owner.name, {
      title: '两轮评审', type: 'feature', requester: PM,
    });
    await evaluate(db, owner.name, { requirementId: created.id });
    await submitReview(db, owner.name, { requirementId: created.id, prdUrl: 'https://x' });
    await reviewReject(db, signerFor(owner.name), {
      requirementId: created.id, reason: '补一下边界',
    });
    await submitReview(db, owner.name, { requirementId: created.id, prdUrl: 'https://x?v=2' });

    // 第二轮提交会再派一次单（新的一行、decided_at 为 null）。两轮的通知都该归
    // 功能线评审人：第一轮由「decided_at >= 事件时刻」那一行认领，第二轮由未收口的
    // 那一行认领——不是「当前 handed 的那一行」。
    const forReviewer = (await notificationsFor(db, member(FEATURE_REVIEWER)))
      .filter((notice) => notice.type === 'requirement.review_requested');
    expect(forReviewer).toHaveLength(2);
    expect(typesOf(await notificationsFor(db, owner)))
      .not.toContain('requirement.review_requested');
  });

  /**
   * 「没有站内观众」这件事在 P4-04 之后**只对 PM 成立**。
   *
   * 扇出规则是「超管收每一条变更，条线负责人收本线每一条变更」，所以 review_passed /
   * scheduled / updated 这些**有**观众了——只是观众是超管与那条线的负责人，不是
   * 与这条需求无关的 PM。这条用例因此改成两侧都断：无关 PM 一条都没有，超管有。
   */
  it('与这条需求无关的 PM 一条都不产生（扇出只给超管与本线负责人）', async () => {
    const owner = member(PM);
    const created = await createRequirement(db, owner.name, {
      title: '直链分享限速', type: 'feature', requester: PM,
    });
    await evaluate(db, owner.name, { requirementId: created.id });
    await submitReview(db, owner.name, { requirementId: created.id, prdUrl: 'https://x' });
    // review_passed：spec §8 里没有站内那一行
    await reviewPass(db, signerFor(owner.name), { requirementId: created.id });
    // scheduled：也没有
    const releaseId = await makeRelease('R-空', PAST, FUTURE);
    await schedule(db, owner.name, {
      requirementId: created.id, releaseId, commitTestAt: TODAY, commitDueAt: FUTURE,
    });
    // shelved：P4-04 起**有**观众（规则 3：条线负责人与超管要收到「被叫停」）
    await shelveRequirement(db, owner.name, { requirementId: created.id, reason: '先不做' });
    // updated：描述改了一笔，也是「变更」
    await updateRequirement(db, owner.name, { requirementId: created.id, title: '直链分享限速（二期）' });

    const quiet = [
      'requirement.review_passed', 'requirement.scheduled',
      'requirement.shelved', 'requirement.updated',
    ];
    // 李嘉是功能线的 PM，但这条需求既不是他提的、也不归他：一条都不该有。
    const bystander = typesOf(await notificationsFor(db, member('李嘉')));
    for (const type of quiet) expect(bystander).not.toContain(type);
    // 超管（房超）相反：全部都在（扇出）。
    const forAdmin = typesOf(await notificationsFor(db, member('房超')));
    for (const type of quiet) expect(forAdmin).toContain(type);
  });

  it('已删除的需求整条消失（通知行不该指向一个打不开的抽屉）', async () => {
    const created = await createRequirement(db, PM, {
      title: '删掉的需求', type: 'feature', requester: FEATURE_REVIEWER,
    });
    expect(has(await notificationsFor(db, member(FEATURE_REVIEWER)), created.id)).toBe(true);

    await db.execute(sql`update requirements set deleted_at = now() where id = ${created.id}`);
    expect(has(await notificationsFor(db, member(FEATURE_REVIEWER)), created.id)).toBe(false);
    expect(await unreadCount(db, member(FEATURE_REVIEWER))).toBe(0);
  });
});

describe('提出人：自由文本 → 成员', () => {
  /**
   * P4-04 把「重名」从一条要处理的边界改成了**不可能**：名字必须唯一
   * （`members_name_unique`）。名字仍然是**身份**（事件、通知、派单都按它），两个
   * 「王妍」会让这些全都取决于 `order by id limit 1`。
   *
   * 所以这条用例改成钉那个唯一索引本身——它是「提出人按姓名匹配」这条规则的前置条件。
   * P4-08 起凭证换成邮箱（`members_email_unique`），两个索引一起钉：名字撞、邮箱撞
   * 都建不出第二行。
   */
  it('名字与邮箱各自唯一：第二个同名/同邮箱成员建不出来', async () => {
    await expect(db.execute(sql`
      insert into members (name, email, role)
      values ('王妍','wangyan2@123pan.com','pm')`)).rejects.toThrow(/duplicate key/);
    await expect(db.execute(sql`
      insert into members (name, email, role)
      values ('另一个王妍','wangyan@123pan.com','pm')`)).rejects.toThrow(/duplicate key/);

    const created = await createRequirement(db, PM, {
      title: '外部提的需求', type: 'feature', requester: '王妍',
    });

    // 姓名匹配照旧成立：提出人写的是名册上的名字，那个人收到。
    expect(has(await notificationsFor(db, member('王妍')), created.id)).toBe(true);
    // 另一条线的负责人依然收不到（这条需求是功能类）。
    expect(has(await notificationsFor(db, member(COMMERCIAL_REVIEWER)), created.id)).toBe(false);
  });

  it('查无此人：只有 PM 收到，不报错', async () => {
    const created = await createRequirement(db, PM, {
      title: '外部提的需求', type: 'feature', requester: '从来没见过的名字',
    });

    for (const name of ['吕品', '房超', '王妍']) {
      expect(has(await notificationsFor(db, member(name)), created.id)).toBe(true);
    }
    /**
     * 功能线评审人**现在会收到**：他是功能线的负责人，扇出规则让他收本线全部变更
     * （P4-04）。旧断言（「非 PM 收不到」）随 P4-04 作废——但另一条线的负责人仍然
     * 收不到，那才是这条用例真正要守的东西。
     */
    expect(has(await notificationsFor(db, member(FEATURE_REVIEWER)), created.id)).toBe(true);
    expect(has(await notificationsFor(db, member(COMMERCIAL_REVIEWER)), created.id)).toBe(false);
  });
});

describe('未读数与已读水位线', () => {
  /** 造三条「吕正豪是提出人」的需求：他会收到三条 created。 */
  async function threeForReviewer() {
    const made = [];
    for (const title of ['一', '二', '三']) {
      made.push(await createRequirement(db, PM, {
        title, type: 'feature', requester: FEATURE_REVIEWER,
      }));
    }
    return made;
  }

  it('水位线 0：全部未读；推到中间：只读掉更早的', async () => {
    const made = await threeForReviewer();
    const reviewer = member(FEATURE_REVIEWER);
    const before = await notificationsFor(db, reviewer);
    expect(before).toHaveLength(3);
    expect(before.every((notice) => notice.unread)).toBe(true);
    expect(await unreadCount(db, reviewer)).toBe(3);
    expect(before[2]!.requirementId).toBe(made[0]!.id);

    // seqs 是倒序的：seqs[0] 最新，seqs[1] 中间，seqs[2] 最旧
    const seqs = before.map((notice) => notice.eventSeq);
    const moved = await markRead(db, reviewer, seqs[1]!);
    expect(moved).toBe(seqs[1]);

    const after = await notificationsFor(db, reviewer);
    const read = after.filter((notice) => !notice.unread).map((notice) => notice.eventSeq);
    // 水位线的语义：到 seqs[1] 为止都算读过——包括更旧的那一条，不包括更新的
    expect(read).toEqual([seqs[1], seqs[2]]);
    expect(after[0]!.unread).toBe(true);
    expect(await unreadCount(db, reviewer)).toBe(1);
  });

  it('水位线不回退：用一个更早的 seq 再标一次，什么都不会少读', async () => {
    const made = await threeForReviewer();
    const reviewer = member(FEATURE_REVIEWER);
    const notices = await notificationsFor(db, reviewer);
    const newest = notices[0]!;
    const oldest = notices[notices.length - 1]!;

    await markRead(db, reviewer, newest.eventSeq);
    expect(await unreadCount(db, reviewer)).toBe(0);

    const kept = await markRead(db, reviewer, oldest.eventSeq);
    expect(kept).toBe(newest.eventSeq);
    expect(await unreadCount(db, reviewer)).toBe(0);
    expect(made).toHaveLength(3);
  });

  it('水位线大于最新事件：不炸，未读为 0，且之后的新事件仍然是未读', async () => {
    await threeForReviewer();
    const reviewer = member(FEATURE_REVIEWER);

    const stored = await markRead(db, reviewer, 999_999);
    // 写侧夹到事件流的最大 seq，而不是把 999999 存下来
    await markRead(db, reviewer, 0);
    expect(stored).toBeLessThan(999_999);
    expect(await unreadCount(db, reviewer)).toBe(0);
    expect((await notificationsFor(db, reviewer)).every((notice) => !notice.unread)).toBe(true);

    // 夹取的真正意义：下一个事件仍然会被看见（否则红点永远不会再亮）
    const fresh = await createRequirement(db, PM, {
      title: '水位线之后', type: 'feature', requester: FEATURE_REVIEWER,
    });
    expect(await unreadCount(db, reviewer)).toBe(1);
    const notices = await notificationsFor(db, reviewer);
    expect(notices[0]!.requirementId).toBe(fresh.id);
    expect(notices[0]!.unread).toBe(true);
  });

  it('负数与非法值退到 0，不会把所有事件变成未读', async () => {
    await threeForReviewer();
    const reviewer = member(FEATURE_REVIEWER);
    await markRead(db, reviewer, 50);
    expect(await unreadCount(db, reviewer)).toBe(0);

    expect(await markRead(db, reviewer, -100)).toBeGreaterThanOrEqual(0);
    expect(await unreadCount(db, reviewer)).toBe(0);
    expect(await markRead(db, reviewer, Number.NaN)).toBeGreaterThanOrEqual(0);
  });

  it('已读位置是每个人各自的', async () => {
    await threeForReviewer();
    await markRead(db, member(FEATURE_REVIEWER), 999_999);
    expect(await unreadCount(db, member(FEATURE_REVIEWER))).toBe(0);
    expect(await unreadCount(db, member(PM))).toBe(3);
  });

  it('没有通知的人：空数组 + 0，不是错误', async () => {
    await threeForReviewer();
    expect(await notificationsFor(db, member(COMMERCIAL_REVIEWER))).toEqual([]);
    expect(await unreadCount(db, member(COMMERCIAL_REVIEWER))).toBe(0);
    expect(await latestNoticeSeq(db, member(COMMERCIAL_REVIEWER))).toBeNull();
    await expect(notifyView(db, member(COMMERCIAL_REVIEWER)))
      .resolves.toEqual({ notices: [], unread: 0 });
  });

  it('「全部已读」的边界是最新一条点到我的事件，不是当前这一页', async () => {
    await threeForReviewer();
    const reviewer = member(FEATURE_REVIEWER);
    const latest = await latestNoticeSeq(db, reviewer);
    expect(latest).not.toBeNull();
    await markRead(db, reviewer, latest!);
    expect(await unreadCount(db, reviewer)).toBe(0);
    expect(await latestNoticeSeq(db, reviewer)).toBe(latest);
  });
});

describe('排序与上限', () => {
  it('按 seq 倒序，limit 生效', async () => {
    const made = [];
    for (const title of ['甲', '乙', '丙']) {
      made.push(await createRequirement(db, PM, {
        title, type: 'feature', requester: FEATURE_REVIEWER,
      }));
    }

    const page = await notificationsFor(db, member(FEATURE_REVIEWER), { limit: 2 });
    expect(page).toHaveLength(2);
    expect(page[0]!.requirementId).toBe(made[2]!.id);
    expect(page[1]!.requirementId).toBe(made[1]!.id);
    expect(page[0]!.eventSeq).toBeGreaterThan(page[1]!.eventSeq);
    expect(page[0]!.line).toContain(`PAN-${made[2]!.number}`);

    // 未读数不受 limit 影响：它数的是全部，不是这一页
    expect(await unreadCount(db, member(FEATURE_REVIEWER))).toBe(3);

    const all = await notificationsFor(db, member(FEATURE_REVIEWER), { limit: 0 });
    expect(all).toHaveLength(1);
  });
});

/**
 * 2026-11-08 裁定：**批量操作不该刷屏**。
 *
 * 现场是 0028 那一次：一条 command 搁置 34 条，动作人是 `system`——扇出里「排除自己做的
 * 事」那条规则因此谁都排除不掉，超管为**一条命令**收到 34 条通知。
 *
 * 这里不跑那条迁移（它动的是真数据），只按它写下的**那一行形状**造事件：
 * `requirement.shelved` + payload 里的 `batch` 标记 + `actor = 'system'`。断言是两侧的：
 * 批量的一条都不该出现（七个人、两个频道都查），同一批需求上一条**没有** batch 的搁置
 * 照旧照常通知——只测「没有」的话，一个把所有搁置都吞掉的实现也会绿。
 */
describe('批量事件：只写账，不打扰', () => {
  const BATCH = '2026-11-08-stale-audit';

  /** 与迁移 0028 同形状的一行：`from` / `to` / `reason`，外加 `batch` 标记。 */
  async function batchShelve(requirementId: string): Promise<void> {
    await db.execute(sql`
      insert into events (requirement_id, actor, type, payload)
      values (${requirementId}, 'system', 'requirement.shelved',
              ${JSON.stringify({
                from: 'inbox', to: 'shelved', reason: '过期审计批量搁置', batch: BATCH,
              })})`);
  }

  /** 两个频道都开满的人：档位不参与这一组（要钉的是观众谓词，不是口味）。 */
  const EVERYONE_LEVELS = '{"site":"all","wecom":"all"}';
  function withWecom(name: string) {
    return { ...member(name), notifyPrefs: EVERYONE_LEVELS };
  }

  /** 七个人（含超管房超）的命令：这是那次事故的观众。 */
  const EVERYONE = ['房超', '吕正豪', '赵越', '吕品', '李嘉', '罗丹', '王妍'];

  it('批量搁置：一条通知都没有（超管也没有），企微也不发，账还在', async () => {
    const batched: string[] = [];
    for (const title of ['批量甲', '批量乙']) {
      const created = await createRequirement(db, PM, {
        title, type: 'feature', requester: PM,
      });
      batched.push(created.id);
    }

    // 批量的**前后各看一次**：差异只可能来自那两行事件。
    const owner = withWecom('房超');
    const unreadBefore = await unreadCount(db, owner);
    const wecomBefore = await pendingDeliveries(db, owner, { channel: 'wecom', limit: 200 });
    for (const id of batched) await batchShelve(id);

    for (const name of EVERYONE) {
      const notices = await notificationsFor(db, member(name));
      const shelved = notices.filter((notice) => notice.type === 'requirement.shelved');
      expect(shelved).toEqual([]);
      // 这两条需求上只该剩下「进入收集」那一行（那是另一条事件，与批量无关）。
      const touching = notices.filter((notice) => batched.includes(notice.requirementId ?? ''));
      expect(touching.every((notice) => notice.type !== 'requirement.shelved')).toBe(true);
    }
    expect(await unreadCount(db, owner)).toBe(unreadBefore);
    expect(await pendingDeliveries(db, owner, { channel: 'wecom', limit: 200 })).toEqual(wecomBefore);

    // 事件是账：两行都在，只是不变成通知。
    const rows = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from events
       where type = 'requirement.shelved'
         and requirement_id in (${sql.join(batched.map((id) => sql`${id}::uuid`), sql`, `)})`);
    expect(Number(rows.rows[0]!.n)).toBe(2);
  });

  it('同一条需求、不带 batch 的搁置：照旧通知超管与本线负责人（企微也算）', async () => {
    const created = await createRequirement(db, PM, {
      title: '手工搁置', type: 'feature', requester: PM,
    });
    await shelveRequirement(db, PM, { requirementId: created.id, reason: '先不做' });

    const notices = await notificationsFor(db, member('房超'));
    const shelved = notices.filter((notice) => notice.type === 'requirement.shelved');
    expect(shelved.map((notice) => notice.requirementId)).toEqual([created.id]);
    expect(shelved[0]!.line).toContain('被搁置：先不做');

    // 企微是同一个谓词：站内会出现的，推送候选里也必须有（反之亦然）。
    const wecom = await pendingDeliveries(db, withWecom('房超'), { channel: 'wecom', limit: 200 });
    expect(wecom.map((candidate) => candidate.type)).toContain('requirement.shelved');
  });
});
