import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { AppError } from '../src/core/errors.js';
import {
  can, type Ability, type Member,
} from '../src/core/auth/roles.js';
import {
  BAD_CREDENTIALS, LOCK_MS, MAX_FAILURES, attemptLogin, resetLoginRateLimit,
} from '../src/core/auth/login.js';
import {
  MIN_PASSWORD_LENGTH, generatePassword, hashPassword, setPassword, verifyHash,
} from '../src/core/auth/password.js';
import {
  SESSION_COOKIE, SESSION_TTL_MS, signSession, verifySession,
} from '../src/core/auth/session-token.js';
import { resetSessionSecretCache, sessionSecret, sessionValue } from '../src/core/auth/session.js';
import { firstProductOwner, activeMemberByName } from '../src/core/auth/members.js';
import { currentMember, listMembers } from '../src/core/read/member.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { reviewPass, reviewReject } from '../src/core/requirements/review.js';
import { schedule } from '../src/core/requirements/schedule.js';
import { bounce } from '../src/core/requirements/bounce.js';
import {
  rejectRequirement, restoreRequirement, shelveRequirement,
} from '../src/core/requirements/terminal.js';
import { deleteRequirement, updateRequirement } from '../src/core/requirements/manage.js';
import { reassignOwner } from '../src/core/requirements/assign.js';
import { claimRequirement } from '../src/core/requirements/claim.js';
import {
  createMember, deactivateMember, resetPassword, saveNotifyPrefs, updateMember,
} from '../src/core/members/manage.js';
import { notificationsFor, prefsOf } from '../src/core/read/notify.js';
import { runTool, toolByName } from '../mcp/tools.js';
import type { Identity } from '../mcp/tokens.js';
import { resetDb, seedPeople, type SeededPerson } from './helpers/db.js';
import { makeRelease } from './helpers/factory.js';

/**
 * P4-04：登录、角色、权限。
 *
 * 这一组用例的组织方式与别的不同：它先钉**一张真值表**（`can()` 的每一格），再钉
 * **每一条路都过这张表**（服务层、MCP、成员管理）。理由：
 *
 * - 真值表是**漂移探测器**。权限最容易坏的方式不是「写错一次」，而是「以后某天有人
 *   为了让某个 case 过，悄悄给某个角色加了一支」——那时只有这张逐格断言会红。
 * - 「所有路都过同一张表」是这一轮的核心承诺。单独测 `can()` 只能证明「规则写对了」，
 *   不能证明**没人绕过它**；所以每一个动作都要再验一次「PM 在别人的需求上被拒」。
 *
 * 全部对着真库跑（与 read/notify 一样）：权限判断读的是 `requirements.owner_member_id`
 * 与 `members.role/line`，把它 mock 掉测到的是我以为的库。
 */

let people: SeededPerson[] = [];

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
  resetLoginRateLimit();
});

afterAll(async () => {
  await pool.end();
});

const ADMIN = '房超';
const FEATURE_LEAD = '吕正豪';
const COMMERCIAL_LEAD = '赵越';
const PM = '吕品';
const PM_OTHER = '李嘉';
const PM_COMMERCIAL = '罗丹';

function idOf(name: string): string {
  const found = people.find((person) => person.name === name);
  if (found === undefined) throw new Error(`名册里没有 ${name}`);
  return found.id;
}

function memberOf(name: string): Member {
  const found = people.find((person) => person.name === name);
  if (found === undefined) throw new Error(`名册里没有 ${name}`);
  return { ...found, deactivatedAt: null };
}

/** 捕获 AppError（拿 code + message）。非 AppError 原样抛，免得把 bug 当成「拒绝」。 */
async function caught(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('这次调用本该被拒绝，却成功了');
}

// ─── 1. 真值表（P4-06：锚点是负责人的条线） ──────────────────────────────────

/**
 * 四种需求，全部在「待评审」，区别只在**负责人是谁**：
 *
 * | 代号 | 类型 | 负责人 | 负责人条线 | 派单 | 这一格要证明什么 |
 * |---|---|---|---|---|---|
 * | `pan5` | 商业 | 吕品 | 功能线 | 吕正豪 | 商业类 + 功能线 PM：功能线负责人管得着，商业线负责人管不着 |
 * | `ownedByBusiness` | 功能 | 罗丹 | 商业线 | 赵越 | 镜像：类型是功能，签它的是商业线负责人——类型不再是锚点 |
 * | `noLineOwner` | 商业 | 房超 | 无 | 无派单 | 负责人没有条线：只有超管能动 |
 * | `unowned` | 功能 | 无 | — | 无派单 | 没有负责人：谁都改不了，但谁都能认领 |
 *
 * 六个演员：超管、两条线的负责人、三个 PM（一个功能线「自己」、一个功能线「别人」、
 * 一个商业线）。
 */

const FACTS = {
  pan5: {
    ownerMemberId: null as string | null,
    ownerLine: 'feature' as string | null,
    state: 'review',
    reviewerMemberId: null as string | null,
  },
  ownedByBusiness: {
    ownerMemberId: null as string | null,
    ownerLine: 'commercial' as string | null,
    state: 'review',
    reviewerMemberId: null as string | null,
  },
  noLineOwner: {
    ownerMemberId: null as string | null,
    ownerLine: null as string | null,
    state: 'review',
    reviewerMemberId: null as string | null,
  },
  unowned: {
    ownerMemberId: null as string | null,
    ownerLine: null as string | null,
    state: 'review',
    reviewerMemberId: null as string | null,
  },
};

type CaseKey = keyof typeof FACTS;

function factsOf(key: CaseKey) {
  const base = FACTS[key];
  switch (key) {
    case 'pan5':
      return { ...base, ownerMemberId: idOf(PM), reviewerMemberId: idOf(FEATURE_LEAD) };
    case 'ownedByBusiness':
      return { ...base, ownerMemberId: idOf(PM_COMMERCIAL), reviewerMemberId: idOf(COMMERCIAL_LEAD) };
    case 'noLineOwner':
      return { ...base, ownerMemberId: idOf(ADMIN), reviewerMemberId: null };
    case 'unowned':
      return { ...base, ownerMemberId: null, reviewerMemberId: null };
  }
}

const ABILITIES: Ability[] = ['edit', 'review', 'reassignOwner', 'claim', 'admin', 'manageMembers'];

type ActorKey = 'admin' | 'featureLead' | 'commercialLead' | 'pm' | 'otherPm' | 'businessPm';

const ACTOR_NAME: Record<ActorKey, string> = {
  admin: ADMIN,
  featureLead: FEATURE_LEAD,
  commercialLead: COMMERCIAL_LEAD,
  pm: PM,
  otherPm: PM_OTHER,
  businessPm: PM_COMMERCIAL,
};

/** 只写 `true` 的格；没写的格一律断言 false（默认拒绝，写错的代价是红的）。 */
type Truth = Partial<Record<Ability, true>>;

/**
 * 真值表本体。**每一格都在下面的 it.each 里断言**（144 行），这里只写「哪些是 true」。
 *
 * 三句读法：
 * - 超管一行全是 true（`claim` 除外：有主的需求不能认领，超管也一样）；
 * - 每条线的负责人只在自己那一条「负责人线」上是 true，另一条线一格都没有；
 * - PM 只有 `edit` 自己那一条是 true，`claim` 只对**没有负责人**的需求成立。
 */
const EXPECT: Record<ActorKey, Record<CaseKey, Truth>> = {
  admin: {
    pan5: { edit: true, review: true, reassignOwner: true, admin: true, manageMembers: true },
    ownedByBusiness: { edit: true, review: true, reassignOwner: true, admin: true, manageMembers: true },
    noLineOwner: { edit: true, review: true, reassignOwner: true, admin: true, manageMembers: true },
    unowned: { edit: true, review: true, reassignOwner: true, claim: true, admin: true, manageMembers: true },
  },
  featureLead: {
    pan5: { edit: true, review: true, reassignOwner: true },
    ownedByBusiness: {},
    noLineOwner: {},
    unowned: { claim: true },
  },
  commercialLead: {
    pan5: {},
    ownedByBusiness: { edit: true, review: true, reassignOwner: true },
    noLineOwner: {},
    unowned: { claim: true },
  },
  pm: {
    // 吕品：pan5 的负责人本人；ownedByBusiness 是别人的；unowned 可以认领。
    pan5: { edit: true },
    ownedByBusiness: {},
    noLineOwner: {},
    unowned: { claim: true },
  },
  otherPm: {
    pan5: {},
    ownedByBusiness: {},
    noLineOwner: {},
    unowned: { claim: true },
  },
  businessPm: {
    pan5: {},
    ownedByBusiness: { edit: true },
    noLineOwner: {},
    unowned: { claim: true },
  },
};

const TABLE: Array<[ActorKey, Ability, CaseKey, boolean]> = [];
for (const actor of Object.keys(EXPECT) as ActorKey[]) {
  for (const ability of ABILITIES) {
    for (const req of Object.keys(FACTS) as CaseKey[]) {
      TABLE.push([actor, ability, req, EXPECT[actor][req][ability] === true]);
    }
  }
}

describe('can() 真值表：锚点是负责人所在条线', () => {
  it.each(TABLE)('%s × %s × %s = %s', (actor, ability, req, expected) => {
    expect(can(memberOf(ACTOR_NAME[actor]), factsOf(req), ability)).toBe(expected);
  });

  /**
   * 变更的起因，逐字钉死：同一个 PM（吕品，功能线）名下的**商业类**需求。
   * 功能线负责人既能改、也能签；商业线负责人一个字都不能动（不是「看得到但不能签」，
   * 是整格都是 false，动作条上什么都不会出现）。
   */
  it('商业类 + 功能线 PM：功能线负责人可改可签，商业线负责人一格都没有', () => {
    const pan5 = factsOf('pan5');
    expect(can(memberOf(FEATURE_LEAD), pan5, 'edit')).toBe(true);
    expect(can(memberOf(FEATURE_LEAD), pan5, 'review')).toBe(true);
    expect(can(memberOf(FEATURE_LEAD), pan5, 'reassignOwner')).toBe(true);

    expect(can(memberOf(COMMERCIAL_LEAD), pan5, 'edit')).toBe(false);
    expect(can(memberOf(COMMERCIAL_LEAD), pan5, 'review')).toBe(false);
    expect(can(memberOf(COMMERCIAL_LEAD), pan5, 'reassignOwner')).toBe(false);
  });

  it('镜像：功能类 + 商业线 PM，签它的是商业线负责人（类型不参与判断）', () => {
    const facts = factsOf('ownedByBusiness');
    expect(can(memberOf(COMMERCIAL_LEAD), facts, 'edit')).toBe(true);
    expect(can(memberOf(COMMERCIAL_LEAD), facts, 'review')).toBe(true);
    expect(can(memberOf(FEATURE_LEAD), facts, 'edit')).toBe(false);
    expect(can(memberOf(FEATURE_LEAD), facts, 'review')).toBe(false);
  });

  /**
   * 评审这一步还有三条**状态 / 派单**条件，不该混进上面那张按人看的表里：
   * 状态不是 review / 派单不是自己的，都没有签字权。
   */
  it('review 只认「状态是 review」+「派单是自己」', () => {
    const facts = factsOf('pan5');
    // 状态不是 review：这条线的负责人也不行
    expect(can(memberOf(FEATURE_LEAD), { ...facts, state: 'inbox' }, 'review')).toBe(false);
    expect(can(memberOf(FEATURE_LEAD), { ...facts, state: 'queue' }, 'review')).toBe(false);
    // 派单是别人（同一条线配两个人的情形）：不行
    expect(can(memberOf(FEATURE_LEAD), {
      ...facts, reviewerMemberId: idOf(PM_OTHER),
    }, 'review')).toBe(false);
    // 还没有派单：这条线的负责人可以（否则一条派单丢了的会永远签不了）
    expect(can(memberOf(FEATURE_LEAD), { ...facts, reviewerMemberId: null }, 'review')).toBe(true);
    // 超管不受派单限制，但照样受状态限制
    expect(can(memberOf(ADMIN), { ...facts, reviewerMemberId: idOf(PM_OTHER) }, 'review')).toBe(true);
    expect(can(memberOf(ADMIN), { ...facts, state: 'inbox' }, 'review')).toBe(false);
  });

  it('负责人没有条线：只有超管能动（不是「谁都可以」）', () => {
    const facts = factsOf('noLineOwner');
    for (const who of [FEATURE_LEAD, COMMERCIAL_LEAD, PM, PM_OTHER, PM_COMMERCIAL]) {
      for (const ability of ['edit', 'review', 'reassignOwner', 'claim'] as Ability[]) {
        expect({ who, ability, allowed: can(memberOf(who), facts, ability) })
          .toEqual({ who, ability, allowed: false });
      }
    }
    expect(can(memberOf(ADMIN), facts, 'edit')).toBe(true);
    expect(can(memberOf(ADMIN), facts, 'review')).toBe(true);
  });

  it('没有负责人：谁都改不了，但 PM / 条线负责人 / 超管都能认领', () => {
    const facts = factsOf('unowned');
    for (const who of [FEATURE_LEAD, COMMERCIAL_LEAD, PM, PM_OTHER, PM_COMMERCIAL]) {
      expect(can(memberOf(who), facts, 'edit')).toBe(false);
      expect(can(memberOf(who), facts, 'review')).toBe(false);
      expect(can(memberOf(who), facts, 'reassignOwner')).toBe(false);
      expect(can(memberOf(who), facts, 'claim')).toBe(true);
    }
  });

  it('停用的人什么都不行（角色还写着 pm 也一样）', () => {
    const deactivated: Member = { ...memberOf(PM), deactivatedAt: new Date() };
    for (const ability of ABILITIES) {
      expect(can(deactivated, factsOf('pan5'), ability)).toBe(false);
    }
    // 查询层也把他当不存在
    expect(can(null, factsOf('pan5'), 'edit')).toBe(false);
  });
});

// ─── 2. 服务层：八种动作都过同一张表 ─────────────────────────────────────────

/** 负责人 → 他所在条线的负责人。**派单跟着人走，不跟类型走**（P4-06）。 */
const LEAD_OF: Record<string, string> = {
  [PM]: FEATURE_LEAD,
  [PM_OTHER]: FEATURE_LEAD,
  [PM_COMMERCIAL]: COMMERCIAL_LEAD,
  [ADMIN]: ADMIN,
};

/**
 * 造一条属于 `owner` 的需求，并推到指定状态。**每一步都由 owner 自己做**（规则 1 +
 * 「PM 只能改自己的」）——所以这个助手本身就是一条正向用例。
 *
 * 签字那一步必须由 owner 所在条线的负责人做：`LEAD_OF` 是这句话的测试侧写法
 * （写死名字，不从实现反查——实现错了这里要红）。
 */
async function makeFor(owner: string, type: 'feature' | 'commercial', state: string): Promise<string> {
  const created = await createRequirement(db, owner, {
    title: `${owner} 的${type === 'feature' ? '功能' : '商业'}需求`,
    type,
    requester: '孙建宏',
  });
  if (state === 'inbox') return created.id;

  if (state === 'design') {
    await evaluate(db, owner, { requirementId: created.id });
    return created.id;
  }

  await evaluate(db, owner, { requirementId: created.id });
  await submitReview(db, owner, { requirementId: created.id, prdUrl: 'https://docs.example/prd' });
  if (state === 'review') return created.id;

  const reviewer = LEAD_OF[owner];
  if (reviewer === undefined) throw new Error(`不知道 ${owner} 在哪条线`);
  await reviewPass(db, reviewer, { requirementId: created.id });
  if (state === 'queue') return created.id;

  const releaseId = await makeRelease('R-权限', '2026-11-01', '2026-11-30');
  await schedule(db, owner, {
    requirementId: created.id, releaseId, commitTestAt: '2026-11-10', commitDueAt: '2026-11-20',
  });
  if (state === 'ready') return created.id;

  if (state === 'shelved') {
    await shelveRequirement(db, owner, { requirementId: created.id, reason: '先不做' });
    return created.id;
  }
  // test：直接改状态列（读/权限用例不重测时钟，见 read.test.ts 的同一条注释）
  await db.execute(sql`update requirements set state = 'test' where id = ${created.id}`);
  return created.id;
}

/**
 * 八种动作 + 改描述 / 删除 / 转交，各自需要什么状态、什么参数。
 *
 * 每一项都是 `(actor, id) => Promise`，于是「同一个动作换不同的人」可以在一个循环里
 * 断言，不必为每个动作抄一遍。
 */
const ACTIONS: Array<{
  name: string;
  state: string;
  run: (actor: string, id: string, targetId: string) => Promise<unknown>;
}> = [
  { name: 'evaluate', state: 'inbox', run: (a, id) => evaluate(db, a, { requirementId: id }) },
  {
    name: 'submitReview',
    state: 'design',
    run: (a, id) => submitReview(db, a, { requirementId: id, prdUrl: 'https://docs.example/x' }),
  },
  {
    name: 'reviewPass',
    state: 'review',
    run: (a, id) => reviewPass(db, a, { requirementId: id }),
  },
  {
    name: 'reviewReject',
    state: 'review',
    run: (a, id) => reviewReject(db, a, { requirementId: id, reason: '不行' }),
  },
  {
    name: 'schedule',
    state: 'queue',
    run: async (a, id) => {
      const releaseId = await makeRelease(`R-${id.slice(0, 8)}`, '2026-11-01', '2026-11-30');
      return schedule(db, a, {
        requirementId: id, releaseId, commitTestAt: '2026-11-10', commitDueAt: '2026-11-20',
      });
    },
  },
  {
    name: 'bounce',
    state: 'test',
    run: (a, id) => bounce(db, a, {
      requirementId: id, newCommitDueAt: '2099-01-01', reason: '没做完',
    }, new Date('2026-11-01T00:00:00Z')),
  },
  {
    name: 'reject',
    state: 'inbox',
    run: (a, id) => rejectRequirement(db, a, { requirementId: id, reason: '不做' }),
  },
  {
    name: 'shelve',
    state: 'queue',
    run: (a, id) => shelveRequirement(db, a, { requirementId: id, reason: '先放着' }),
  },
  {
    name: 'restore',
    state: 'shelved',
    run: (a, id) => restoreRequirement(db, a, { requirementId: id }),
  },
  {
    name: 'update',
    state: 'inbox',
    run: (a, id) => updateRequirement(db, a, { requirementId: id, title: '改个标题' }),
  },
  {
    name: 'delete',
    state: 'inbox',
    run: (a, id) => deleteRequirement(db, a, { requirementId: id }),
  },
  {
    name: 'reassignOwner',
    state: 'inbox',
    run: (a, id, targetId) => reassignOwner(db, a, { requirementId: id, ownerMemberId: targetId }),
  },
];

describe('服务层：九种动作都过 can()', () => {
  /**
   * 逐条：PM 在**别人的**需求上被拒。
   *
   * 拒绝的形状：`forbidden` + 一句中文。评审那一格是 `not_reviewer`（更精确，见
   * roles.ts 的注释）——它是唯一一个不叫 forbidden 的动作，下面单独断言。
   */
  for (const action of ACTIONS) {
    it(`${action.name}：PM 改别人的需求 → 拒绝`, async () => {
      const id = await makeFor(PM_OTHER, 'feature', action.state);
      if (action.name === 'reviewPass' || action.name === 'reviewReject') {
        expect(await caught(action.run(PM, id, idOf(PM))))
          .toMatchObject({ code: 'not_reviewer' });
        return;
      }
      expect(await caught(action.run(PM, id, idOf(PM))))
        .toMatchObject({ code: 'forbidden' });
    });

    it(`${action.name}：负责人自己做 → 通过`, async () => {
      const id = await makeFor(PM_OTHER, 'feature', action.state);

      /**
       * 两处例外，都是规则本身：
       * - **评审**不随负责人走。PM 是负责人，但没有签字权（规则 2：只有条线负责人和
       *   超管是评审人）——所以「负责人自己能签」这句话对 PM 不成立，被拒才是对的。
       * - **转交**同理。PM 能改自己的需求，但不能把它甩给别人；转交是条线负责人/超管
       *   的动作（`reassignOwner`）。
       */
      if (action.name === 'reviewPass' || action.name === 'reviewReject') {
        expect(await caught(action.run(PM_OTHER, id, idOf(PM))))
          .toMatchObject({ code: 'not_reviewer' });
        return;
      }
      if (action.name === 'reassignOwner') {
        expect(await caught(action.run(PM_OTHER, id, idOf(PM))))
          .toMatchObject({ code: 'forbidden' });
        return;
      }
      await action.run(PM_OTHER, id, idOf(PM));
    });

    it(`${action.name}：条线负责人 → 通过`, async () => {
      const id = await makeFor(PM_OTHER, 'feature', action.state);
      await action.run(FEATURE_LEAD, id, idOf(PM));
    });

    it(`${action.name}：超管 → 通过`, async () => {
      const id = await makeFor(PM_OTHER, 'feature', action.state);
      await action.run(ADMIN, id, idOf(PM));
    });
  }

  it('另一条线的负责人也不行（商业负责人碰功能线 PM 的需求）', async () => {
    const id = await makeFor(PM_OTHER, 'feature', 'inbox');
    expect(await caught(updateRequirement(db, COMMERCIAL_LEAD, {
      requirementId: id, title: '改个标题',
    }))).toMatchObject({ code: 'forbidden' });
  });

  /**
   * 变更的起因在服务层的那一半：一条**商业类**需求由功能线 PM 负责。
   * 旧规则下它派给商业线负责人；新规则下商业线负责人连改都改不了，功能线负责人能改能签。
   */
  it('商业类需求归功能线 PM：功能线负责人能改能签，商业线负责人被拒', async () => {
    const id = await makeFor(PM, 'commercial', 'review');

    expect(await caught(updateRequirement(db, COMMERCIAL_LEAD, {
      requirementId: id, title: '越线改',
    }))).toMatchObject({ code: 'forbidden' });
    expect(await caught(reviewPass(db, COMMERCIAL_LEAD, { requirementId: id })))
      .toMatchObject({ code: 'not_reviewer' });

    await updateRequirement(db, FEATURE_LEAD, { requirementId: id, title: '本线改' });
    expect((await reviewPass(db, FEATURE_LEAD, { requirementId: id })).state).toBe('queue');
  });

  it('名字不在名册上 → forbidden（不是 500，也不泄露名册）', async () => {
    const id = await makeFor(PM, 'feature', 'inbox');
    expect(await caught(updateRequirement(db, '张三', {
      requirementId: id, title: '改个标题',
    }))).toMatchObject({ code: 'forbidden' });
  });
});

describe('评审：只有派单的评审人能签字', () => {
  it('PM 即使在待评审状态也没有签字权', async () => {
    const id = await makeFor(PM_OTHER, 'feature', 'review');
    expect(await caught(reviewPass(db, PM, { requirementId: id })))
      .toMatchObject({ code: 'not_reviewer' });
    expect(await caught(reviewReject(db, PM, { requirementId: id, reason: 'x' })))
      .toMatchObject({ code: 'not_reviewer' });
  });

  it('派单上的那位可以签，签完状态走到 queue', async () => {
    // 商业类需求、负责人罗丹（商业线）→ 派给商业线负责人赵越。类型与锚点在这条里一致。
    const id = await makeFor(PM_COMMERCIAL, 'commercial', 'review');
    expect((await reviewPass(db, COMMERCIAL_LEAD, { requirementId: id })).state).toBe('queue');
  });
});

// ─── 3. 录入即负责人（服务层 + MCP） ─────────────────────────────────────────

describe('规则 1：录入即负责人', () => {
  it('PM 不指定负责人时，自己成为负责人', async () => {
    const created = await createRequirement(db, PM, {
      title: '录入手', type: 'feature', requester: '孙建宏',
    });
    const row = await db.execute<{ owner_member_id: string }>(
      sql`select owner_member_id from requirements where id = ${created.id}`);
    expect(row.rows[0]!.owner_member_id).toBe(idOf(PM));
  });

  it('PM 想把需求挂到别人头上 → forbidden', async () => {
    expect(await caught(createRequirement(db, PM, {
      title: '甩锅', type: 'feature', requester: '孙建宏', ownerMemberId: idOf(PM_OTHER),
    }))).toMatchObject({ code: 'forbidden' });
  });

  it('条线负责人只能指定本线的人（与需求类型无关）', async () => {
    // 两条都写成**商业类**：一条挂本线、一条挂另一条线。允许与拒绝都不看类型。
    const ok = await createRequirement(db, FEATURE_LEAD, {
      title: '本线', type: 'commercial', requester: '孙建宏', ownerMemberId: idOf(PM_OTHER),
    });
    const cross = await caught(createRequirement(db, FEATURE_LEAD, {
      title: '跨线', type: 'commercial', requester: '孙建宏', ownerMemberId: idOf(PM_COMMERCIAL),
    }));
    expect(cross).toMatchObject({ code: 'forbidden', message: '只能把需求交给本线的人' });
    expect(ok.id).toBeTruthy();
  });

  it('超管可以指定任何人，也可以显式留空（那条「待接单」的卡）', async () => {
    const assigned = await createRequirement(db, ADMIN, {
      title: '指定', type: 'commercial', requester: '孙建宏', ownerMemberId: idOf(PM_COMMERCIAL),
    });
    const unowned = await createRequirement(db, ADMIN, {
      title: '待接单', type: 'commercial', requester: '孙建宏', ownerMemberId: null,
    });
    const rows = await db.execute<{ id: string; owner_member_id: string | null }>(sql`
      select id, owner_member_id from requirements
       where id in (${assigned.id}, ${unowned.id}) order by id`);
    const byId = new Map(rows.rows.map((row) => [row.id, row.owner_member_id]));
    expect(byId.get(assigned.id)).toBe(idOf(PM_COMMERCIAL));
    expect(byId.get(unowned.id)).toBeNull();
  });

  it('MCP 录进来也是同一条规则（token 是谁，负责人就是谁）', async () => {
    const def = toolByName('requirement_create');
    expect(def).not.toBeNull();
    const who: Identity = { tokenId: 't', memberId: idOf(PM_OTHER), member: PM_OTHER, scope: 'write' };
    await runTool(def!, who, {
      title: 'agent 建的需求', type: 'feature', requester: 'agent', 
    });
    const row = await db.execute<{ owner_member_id: string }>(sql`
      select owner_member_id from requirements where title = 'agent 建的需求'`);
    expect(row.rows[0]!.owner_member_id).toBe(idOf(PM_OTHER));
  });
});

// ─── 3.5 立项（认领）：无主的需求落到人身上，然后跟着他的条线 ─────────────────

describe('立项：任何 PM 都能认领，认领即成为负责人', () => {
  /** 超管显式留空造出来的「待接单」卡（种子 #1 就是它）。 */
  async function unownedRequirement(): Promise<string> {
    const created = await createRequirement(db, ADMIN, {
      title: '待接单', type: 'commercial', requester: '孙建宏', ownerMemberId: null,
    });
    const row = await db.execute<{ owner_member_id: string | null }>(
      sql`select owner_member_id from requirements where id = ${created.id}`);
    expect(row.rows[0]!.owner_member_id).toBeNull();
    return created.id;
  }

  it('PM 认领之后成为负责人，写一条 owner_assigned 事件（from 为 null）', async () => {
    const id = await unownedRequirement();
    const result = await claimRequirement(db, PM, { requirementId: id });
    expect(result).toMatchObject({ owner: PM, changed: true });

    const row = await db.execute<{ owner_member_id: string }>(
      sql`select owner_member_id from requirements where id = ${id}`);
    expect(row.rows[0]!.owner_member_id).toBe(idOf(PM));

    const events = await db.execute<{ actor: string; payload: string }>(sql`
      select actor, payload from events
       where requirement_id = ${id} and type = 'requirement.owner_assigned'`);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.actor).toBe(PM);
    expect(JSON.parse(events.rows[0]!.payload)).toEqual({ from: null, to: PM });
  });

  it('认领之后：只有他的条线负责人 / 超管 / 他自己能动，别的线一格都没有', async () => {
    const id = await unownedRequirement();
    await claimRequirement(db, PM, { requirementId: id });

    // 他自己（PM）能改
    await updateRequirement(db, PM, { requirementId: id, title: '认领后改' });
    // 他的条线负责人能改
    await updateRequirement(db, FEATURE_LEAD, { requirementId: id, title: '本线负责人改' });
    // 另一条线的负责人不能
    expect(await caught(updateRequirement(db, COMMERCIAL_LEAD, {
      requirementId: id, title: '越线改',
    }))).toMatchObject({ code: 'forbidden' });
    // 别的 PM 不能
    expect(await caught(updateRequirement(db, PM_OTHER, {
      requirementId: id, title: '别人改',
    }))).toMatchObject({ code: 'forbidden' });
  });

  it('有主之后不能再认领（超管也不行，那是转交）', async () => {
    const id = await unownedRequirement();
    await claimRequirement(db, PM, { requirementId: id });
    expect(await caught(claimRequirement(db, PM_OTHER, { requirementId: id })))
      .toMatchObject({ code: 'forbidden', message: '这条需求已经有负责人了' });
    expect(await caught(claimRequirement(db, ADMIN, { requirementId: id })))
      .toMatchObject({ code: 'forbidden', message: '这条需求已经有负责人了' });
  });

  it('认领后再提交评审，派单跟到认领人的条线', async () => {
    const id = await unownedRequirement();
    await claimRequirement(db, PM_COMMERCIAL, { requirementId: id });
    await evaluate(db, PM_COMMERCIAL, { requirementId: id });
    await submitReview(db, PM_COMMERCIAL, { requirementId: id, prdUrl: 'https://x/prd' });

    const assigned = await db.execute<{ name: string }>(sql`
      select m.name from review_assignments ra
        join members m on m.id = ra.reviewer_member_id
       where ra.requirement_id = ${id} and ra.verdict = 'handed'`);
    expect(assigned.rows.map((r) => r.name)).toEqual([COMMERCIAL_LEAD]);
  });
});

// ─── 4. MCP：token 的权限 = 绑定账号的权限 ──────────────────────────────────

describe('MCP：权限跟人走，scope 只是「能不能写」', () => {
  it('绑在 PM 上的 write token 排不了别人的需求', async () => {
    const id = await makeFor(PM_OTHER, 'feature', 'queue');
    const releaseId = await makeRelease('R-MCP', '2026-11-01', '2026-11-30');
    const def = toolByName('requirement_schedule')!;
    const who: Identity = { tokenId: 't', memberId: idOf(PM), member: PM, scope: 'write' };

    const result = await runTool(def, who, {
      requirementId: id, releaseId, commitTestAt: '2026-11-10', commitDueAt: '2026-11-20',
    });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain('你只能改自己负责的需求');

    // 一个字段都没变：状态还是待排期
    const row = await db.execute<{ state: string }>(
      sql`select state from requirements where id = ${id}`);
    expect(row.rows[0]!.state).toBe('queue');
  });

  it('同一个 token 改自己的需求就通（scope 与角色是两件事）', async () => {
    const id = await makeFor(PM, 'feature', 'queue');
    const releaseId = await makeRelease('R-MCP-OK', '2026-11-01', '2026-11-30');
    const def = toolByName('requirement_schedule')!;
    const who: Identity = { tokenId: 't', memberId: idOf(PM), member: PM, scope: 'write' };
    const result = await runTool(def, who, {
      requirementId: id, releaseId, commitTestAt: '2026-11-10', commitDueAt: '2026-11-20',
    });
    expect(result.isError).not.toBe(true);
  });

  it('read token 连自己的需求也写不了（scope 先拦）', async () => {
    const id = await makeFor(PM, 'feature', 'inbox');
    const def = toolByName('requirement_schedule')!;
    const who: Identity = { tokenId: 't', memberId: idOf(PM), member: PM, scope: 'read' };
    const result = await runTool(def, who, {
      requirementId: id,
      releaseId: '00000000-0000-0000-0000-000000000001',
      commitTestAt: '2026-11-10',
      commitDueAt: '2026-11-20',
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('需要「写」权限');
  });
});

// ─── 5. 登录 ────────────────────────────────────────────────────────────────

describe('登录', () => {
  it('未知用户与密码错是同一句话（code 也相同）', async () => {
    await setPassword(db, idOf(PM), 'correct-horse');
    const wrong = await caught(attemptLogin(db, PM, 'wrong-password'));
    const unknown = await caught(attemptLogin(db, '查无此人', 'whatever'));
    expect(wrong).toEqual({ code: 'bad_credentials', message: BAD_CREDENTIALS });
    expect(unknown).toEqual(wrong);
  });

  it('口令正确就通过，并且大小写/空白按原样（登录名去首尾空白）', async () => {
    await setPassword(db, idOf(PM), 'correct-horse');
    expect(await attemptLogin(db, ` ${PM} `, 'correct-horse')).toEqual({ name: PM });
  });

  it(`连续失败 ${MAX_FAILURES} 次后锁 ${LOCK_MS / 60000} 分钟：正确口令也进不来`, async () => {
    await setPassword(db, idOf(PM), 'correct-horse');
    const now = 1_800_000_000_000;
    for (let i = 0; i < MAX_FAILURES; i += 1) {
      expect(await caught(attemptLogin(db, PM, 'wrong', now))).toMatchObject({
        code: 'bad_credentials',
      });
    }
    expect(await caught(attemptLogin(db, PM, 'correct-horse', now)))
      .toMatchObject({ code: 'rate_limited' });
    // 窗口过去之后又能试了（不是永久封）
    expect(await attemptLogin(db, PM, 'correct-horse', now + LOCK_MS + 1))
      .toEqual({ name: PM });
  });

  it('成功一次清零：4 次失败 + 1 次成功 + 4 次失败 = 还没锁', async () => {
    await setPassword(db, idOf(PM), 'correct-horse');
    const now = 1_800_000_000_000;
    for (let i = 0; i < 4; i += 1) await caught(attemptLogin(db, PM, 'wrong', now));
    await attemptLogin(db, PM, 'correct-horse', now);
    for (let i = 0; i < 4; i += 1) {
      expect(await caught(attemptLogin(db, PM, 'wrong', now))).toMatchObject({
        code: 'bad_credentials',
      });
    }
  });

  it('停用的人：与密码错同一句话（不暴露「这个账号停了」）', async () => {
    await setPassword(db, idOf(PM_OTHER), 'correct-horse');
    await deactivateMember(db, ADMIN, { memberId: idOf(PM_OTHER) });
    expect(await caught(attemptLogin(db, PM_OTHER, 'correct-horse'))).toMatchObject({
      code: 'bad_credentials', message: BAD_CREDENTIALS,
    });
  });

  it('没有口令的账号一律登录失败（绝不当成空密码）', async () => {
    expect(await caught(attemptLogin(db, PM, ''))).toMatchObject({ code: 'bad_credentials' });
  });
});

describe('口令存储', () => {
  it('scrypt + 每人一个盐：同一个口令两次哈希不同，但都能验过', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
    expect(await verifyHash('same-password', a)).toBe(true);
    expect(await verifyHash('same-password', b)).toBe(true);
    expect(await verifyHash('other-password', a)).toBe(false);
  });

  it('坏掉的存储串是「验不过」，不是抛错', async () => {
    expect(await verifyHash('x', 'garbage')).toBe(false);
    expect(await verifyHash('x', 'scrypt$abc$8$1$aa$bb')).toBe(false);
    expect(await verifyHash('x', null)).toBe(false);
  });

  it(`太短的口令被拒（${MIN_PASSWORD_LENGTH} 位起），中文消息`, async () => {
    expect(await caught(setPassword(db, idOf(PM), 'short')))
      .toMatchObject({ code: 'weak_password', message: `密码至少 ${MIN_PASSWORD_LENGTH} 位` });
  });

  it('生成的初始口令长度够、字符表里没有易混字符', () => {
    const password = generatePassword();
    expect(password.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
    expect(password).not.toMatch(/[0O1lI]/);
  });
});

// ─── 6. 会话 ────────────────────────────────────────────────────────────────

describe('会话 cookie', () => {
  it('签发 → 验签拿回同一个名字', () => {
    const token = signSession(PM, 'secret', 1_000);
    expect(verifySession(token, 'secret', 1_000)).toBe(PM);
  });

  it('换一个密钥 / 改一个字 / 过期 / 改过期时间：全部不认', () => {
    const token = signSession(PM, 'secret', 1_000);
    expect(verifySession(token, 'other-secret', 1_000)).toBeNull();
    // 改签名里的一个字符（名字是 base64、又不在签名串里，直接替换原文是无效篡改）
    const [version, name, exp, signature] = token.split('.') as [string, string, string, string];
    const flipped = signature[0] === 'A' ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
    expect(verifySession([version, name, exp, flipped].join('.'), 'secret', 1_000)).toBeNull();
    // 换名字（签名覆盖它）
    expect(verifySession(
      [version, Buffer.from('李嘉').toString('base64url'), exp, signature].join('.'),
      'secret', 1_000,
    )).toBeNull();
    expect(verifySession(token, 'secret', 1_000 + SESSION_TTL_MS + 1)).toBeNull();
    const parts = token.split('.');
    parts[2] = String(Number(parts[2]) + 10_000);
    expect(verifySession(parts.join('.'), 'secret', 1_000)).toBeNull();
    expect(verifySession(null, 'secret', 1_000)).toBeNull();
    expect(verifySession('v1.abc', 'secret', 1_000)).toBeNull();
  });

  it('cookie 名与默认密钥都在一处定义，密钥可被环境变量覆盖', () => {
    expect(SESSION_COOKIE).toBe('flowers_session');
    const before = process.env.FLOWERS_SESSION_SECRET;
    process.env.FLOWERS_SESSION_SECRET = 'from-env';
    resetSessionSecretCache();
    try {
      const value = sessionValue(PM);
      expect(verifySession(value, 'from-env')).toBe(PM);
      expect(verifySession(value, 'something-else')).toBeNull();
    } finally {
      if (before === undefined) delete process.env.FLOWERS_SESSION_SECRET;
      else process.env.FLOWERS_SESSION_SECRET = before;
      resetSessionSecretCache();
    }
  });
});

describe('currentMember() 的解析顺序', () => {
  it('没有会话也没有环境变量 → 第一个超管（不是写死的吕品）', async () => {
    expect(await currentMember()).toBe(ADMIN);
    expect((await firstProductOwner(db))!.name).toBe(ADMIN);
  });

  it('FLOWERS_ACTOR 优先于兜底（脚本 / 部署用）', async () => {
    process.env.FLOWERS_ACTOR = PM_OTHER;
    try {
      expect(await currentMember()).toBe(PM_OTHER);
    } finally {
      delete process.env.FLOWERS_ACTOR;
    }
  });

  it('环境变量指的人不在名册上 → 显式报错，不编一个身份', async () => {
    process.env.FLOWERS_ACTOR = '查无此人';
    try {
      expect(await caught(currentMember())).toMatchObject({ code: 'no_member' });
    } finally {
      delete process.env.FLOWERS_ACTOR;
    }
  });

  it('一个成员都没有 → no_member（登录页展示这一句）', async () => {
    await db.execute(sql`truncate members cascade`);
    expect(await caught(currentMember())).toMatchObject({
      code: 'no_member', message: '系统里还没有任何成员：请先跑 npm run seed 建人',
    });
  });

  it('停用的人不再被解析成默认身份', async () => {
    await db.execute(sql`update members set deactivated_at = now() where name = ${ADMIN}`);
    // 房超停用之后没有活着的超管了：兜底失败，显式报错（而不是退化成他）
    expect(await caught(currentMember())).toMatchObject({ code: 'no_member' });
    expect(await activeMemberByName(db, ADMIN)).toBeNull();
  });
});

// ─── 7. 成员管理（只有超管） ─────────────────────────────────────────────────

describe('成员管理', () => {
  it('只有超管能建人 / 改人 / 停用 / 重置口令', async () => {
    for (const actor of [PM, FEATURE_LEAD, COMMERCIAL_LEAD]) {
      expect(await caught(createMember(db, actor, {
        name: '新人', role: 'pm', line: 'feature',
      }))).toMatchObject({ code: 'forbidden', message: '只有超管可以管理成员' });
      expect(await caught(updateMember(db, actor, {
        memberId: idOf(PM), role: 'product_owner',
      }))).toMatchObject({ code: 'forbidden' });
      expect(await caught(deactivateMember(db, actor, { memberId: idOf(PM_OTHER) })))
        .toMatchObject({ code: 'forbidden' });
      expect(await caught(resetPassword(db, actor, { memberId: idOf(PM) })))
        .toMatchObject({ code: 'forbidden' });
    }
  });

  it('建人：返回一次初始口令，登录能过；名字重复被拒', async () => {
    const created = await createMember(db, ADMIN, {
      name: '新同学', role: 'pm', line: 'commercial',
    });
    expect(created.member.role).toBe('pm');
    expect(created.member.line).toBe('commercial');
    expect(await attemptLogin(db, '新同学', created.password)).toEqual({ name: '新同学' });

    expect(await caught(createMember(db, ADMIN, {
      name: '新同学', role: 'pm', line: 'feature',
    }))).toMatchObject({ code: 'conflict' });
  });

  it('角色与条线必须一致', async () => {
    expect(await caught(createMember(db, ADMIN, {
      name: '错线', role: 'feature_reviewer', line: 'commercial',
    }))).toMatchObject({ code: 'invalid' });
    expect(await caught(createMember(db, ADMIN, {
      name: '超管有线', role: 'product_owner', line: 'feature',
    }))).toMatchObject({ code: 'invalid' });
    expect(await caught(createMember(db, ADMIN, {
      name: 'PM 没线', role: 'pm', line: null,
    }))).toMatchObject({ code: 'invalid' });
  });

  it('还占着需求的负责人停不掉：说清有几条', async () => {
    await createRequirement(db, PM_OTHER, { title: 'a', type: 'feature', requester: 'x' });
    await createRequirement(db, PM_OTHER, { title: 'b', type: 'feature', requester: 'x' });
    expect(await caught(deactivateMember(db, ADMIN, { memberId: idOf(PM_OTHER) })))
      .toMatchObject({ code: 'member_busy', message: '这个人还负责 2 条需求，先转交' });
  });

  it('停用之后：登录被拒、不在名册里、token 撤销', async () => {
    await db.execute(sql`
      insert into mcp_tokens (token_hash, member_id, label, scopes)
      values ('deadbeef', ${idOf(PM_OTHER)}, 'agent', 'write')`);
    await setPassword(db, idOf(PM_OTHER), 'correct-horse');
    await deactivateMember(db, ADMIN, { memberId: idOf(PM_OTHER) });

    expect(await caught(attemptLogin(db, PM_OTHER, 'correct-horse')))
      .toMatchObject({ code: 'bad_credentials' });
    expect((await listMembers()).map((m) => m.name)).not.toContain(PM_OTHER);

    const tokens = await db.execute<{ revoked_at: Date | null }>(
      sql`select revoked_at from mcp_tokens where member_id = ${idOf(PM_OTHER)}`);
    expect(tokens.rows[0]!.revoked_at).not.toBeNull();
  });

  it('不能停自己，也不能把最后一个超管停掉', async () => {
    expect(await caught(deactivateMember(db, ADMIN, { memberId: idOf(ADMIN) })))
      .toMatchObject({ code: 'invalid', message: '不能停用自己' });
  });

  it('重置口令：新口令能登，旧口令不能', async () => {
    await setPassword(db, idOf(PM), 'old-password');
    const result = await resetPassword(db, ADMIN, { memberId: idOf(PM) });
    expect(await attemptLogin(db, PM, result.password)).toEqual({ name: PM });
    expect(await caught(attemptLogin(db, PM, 'old-password')))
      .toMatchObject({ code: 'bad_credentials' });
  });

  it('通知口味：自己能改自己的，改别人的要超管', async () => {
    const saved = await saveNotifyPrefs(db, PM, {
      prefs: { inherit: false, changed: false, rejected: true },
    });
    expect(saved.memberId).toBe(idOf(PM));
    expect(prefsOf(saved.prefs)).toEqual({ inherit: false, changed: false, rejected: true });

    expect(await caught(saveNotifyPrefs(db, PM, {
      memberId: idOf(PM_OTHER), prefs: { inherit: false },
    }))).toMatchObject({ code: 'forbidden' });

    const asAdmin = await saveNotifyPrefs(db, ADMIN, {
      memberId: idOf(PM_OTHER), prefs: { inherit: false },
    });
    expect(asAdmin.memberId).toBe(idOf(PM_OTHER));
  });
});

describe('转交负责人', () => {
  it('条线负责人只能在本线内转交', async () => {
    const id = await makeFor(PM_OTHER, 'feature', 'inbox');
    expect((await reassignOwner(db, FEATURE_LEAD, {
      requirementId: id, ownerMemberId: idOf(PM),
    })).owner).toBe(PM);

    expect(await caught(reassignOwner(db, FEATURE_LEAD, {
      requirementId: id, ownerMemberId: idOf(PM_COMMERCIAL),
    }))).toMatchObject({ code: 'forbidden', message: '只能把需求交给本线的人' });
  });

  it('商业类需求归功能线 PM 时，转交人也是功能线负责人（不是商业线）', async () => {
    const id = await makeFor(PM, 'commercial', 'inbox');
    expect(await caught(reassignOwner(db, COMMERCIAL_LEAD, {
      requirementId: id, ownerMemberId: idOf(PM_COMMERCIAL),
    }))).toMatchObject({ code: 'forbidden' });
    expect((await reassignOwner(db, FEATURE_LEAD, {
      requirementId: id, ownerMemberId: idOf(PM_OTHER),
    })).owner).toBe(PM_OTHER);
  });

  it('转给同一个人是空操作：不产生事件', async () => {
    const id = await makeFor(PM_OTHER, 'feature', 'inbox');
    const result = await reassignOwner(db, ADMIN, {
      requirementId: id, ownerMemberId: idOf(PM_OTHER),
    });
    expect(result.changed).toBe(false);
    const events = await db.execute(sql`
      select 1 from events where requirement_id = ${id} and type = 'requirement.owner_assigned'`);
    expect(events.rows).toHaveLength(0);
  });

  it('转交写一条事件（时间轴与新负责人的通知都靠它）', async () => {
    const id = await makeFor(PM_OTHER, 'feature', 'inbox');
    await reassignOwner(db, FEATURE_LEAD, { requirementId: id, ownerMemberId: idOf(PM) });
    const events = await db.execute<{ actor: string; payload: string }>(sql`
      select actor, payload from events
       where requirement_id = ${id} and type = 'requirement.owner_assigned'`);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.actor).toBe(FEATURE_LEAD);
    expect(JSON.parse(events.rows[0]!.payload)).toMatchObject({ from: PM_OTHER, to: PM });
  });

  it('PM 不能转交（哪怕是自己的需求）', async () => {
    const id = await makeFor(PM, 'feature', 'inbox');
    expect(await caught(reassignOwner(db, PM, {
      requirementId: id, ownerMemberId: idOf(PM_OTHER),
    }))).toMatchObject({ code: 'forbidden' });
  });
});

// ─── 8. 通知扇出 ────────────────────────────────────────────────────────────

describe('通知扇出：条线 / 超管 / 偏好', () => {
  it('条线负责人只收「自己线上的人负责」的需求，超管全都收', async () => {
    // 三张卡的**类型与负责人故意错开**：类型不再是扇出的判据。
    const byFeaturePm = await createRequirement(db, PM_OTHER, {
      title: '功能线 PM 的功能类', type: 'feature', requester: '孙建宏',
    });
    const commercialTypeByFeaturePm = await createRequirement(db, PM, {
      title: '功能线 PM 的商业类', type: 'commercial', requester: '孙建宏',
    });
    const byBusinessPm = await createRequirement(db, PM_COMMERCIAL, {
      title: '商业线 PM 的商业类', type: 'commercial', requester: '孙建宏',
    });

    const ids = (notices: Array<{ requirementId: string }>) => notices.map((n) => n.requirementId);
    const featureLead = ids(await notificationsFor(db, memberOf(FEATURE_LEAD)));
    const commercialLead = ids(await notificationsFor(db, memberOf(COMMERCIAL_LEAD)));
    const admin = ids(await notificationsFor(db, memberOf(ADMIN)));

    // 功能线负责人：两个功能线 PM 名下的都收，包括那条**商业类**的。
    expect(featureLead).toContain(byFeaturePm.id);
    expect(featureLead).toContain(commercialTypeByFeaturePm.id);
    expect(featureLead).not.toContain(byBusinessPm.id);
    // 商业线负责人：只收商业线 PM 名下那条。
    expect(commercialLead).toContain(byBusinessPm.id);
    expect(commercialLead).not.toContain(byFeaturePm.id);
    expect(commercialLead).not.toContain(commercialTypeByFeaturePm.id);
    // 超管：全部。
    for (const id of [byFeaturePm.id, commercialTypeByFeaturePm.id, byBusinessPm.id]) {
      expect(admin).toContain(id);
    }
  });

  it('拒绝 / 搁置：条线负责人与超管收到（规则 3）', async () => {
    const id = await makeFor(PM_OTHER, 'feature', 'queue');
    await shelveRequirement(db, FEATURE_LEAD, { requirementId: id, reason: '先放着' });

    const forAdmin = await notificationsFor(db, memberOf(ADMIN));
    const notice = forAdmin.find((n) => n.type === 'requirement.shelved');
    expect(notice).toBeDefined();
    expect(notice!.line).toContain('被搁置');
    // 搁置人自己不再是观众（他自己知道）
    const forLead = await notificationsFor(db, memberOf(FEATURE_LEAD));
    expect(forLead.some((n) => n.type === 'requirement.shelved')).toBe(false);
  });

  it('关掉通知的超管什么都收不到；只关 rejected 的还收得到其余变更', async () => {
    await saveNotifyPrefs(db, ADMIN, {
      prefs: { inherit: false, changed: false, rejected: false },
    });
    const created = await createRequirement(db, PM, {
      title: '静音', type: 'feature', requester: '孙建宏',
    });
    const id = created.id;
    await evaluate(db, PM, { requirementId: id });
    // 注意：这里必须用**从库里读出来的那一行**（它带 notify_prefs）——手搭的
    // `memberOf()` 没有这一列，扇出会按默认全开来算。
    const admin = (await activeMemberByName(db, ADMIN))!;
    expect(await notificationsFor(db, admin)).toEqual([]);

    // 只关 rejected
    await saveNotifyPrefs(db, ADMIN, {
      prefs: { inherit: false, changed: true, rejected: false },
    });
    await shelveRequirement(db, PM, { requirementId: id, reason: '停' });
    // 重新读一次：口味是行上的列，上一行读出来的还是「全关」
    const relaxed = (await activeMemberByName(db, ADMIN))!;
    const types = (await notificationsFor(db, relaxed)).map((n) => n.type);
    expect(types).toContain('requirement.evaluated');
    expect(types).not.toContain('requirement.shelved');
  });
});
