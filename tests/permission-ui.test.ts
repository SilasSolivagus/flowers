import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { AppError } from '../src/core/errors.js';
import {
  can, type Member, type RequirementFacts,
} from '../src/core/auth/roles.js';
import { setPassword, verifyHash } from '../src/core/auth/password.js';
import {
  ACTION_ABILITY, actionsFor, getRequirementDetail, visibleActions,
} from '../src/core/read/detail.js';
import { BOARD_STATES } from '../src/core/read/board.js';
import { memberAdminView, requirementsOwnedBy } from '../src/core/read/member-admin.js';
import { notificationsFor } from '../src/core/read/notify.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import {
  createMember, deactivateMember, saveNotifyChannels,
} from '../src/core/members/manage.js';
import { changePassword } from '../app/password-change.js';
import { transferOwnedRequirements } from '../app/member-transfer.js';
import { resetDb, seedPeople, type SeededPerson } from './helpers/db.js';

/**
 * P4-05：权限的**界面那一半**。
 *
 * 这一组只钉一件事：抽屉里露出来的动作 / 按钮，与 `detail.ts` 用 `can()` 算出来的
 * 结论**永远相等**。服务层已经有一套 12 个动作 × 4 个身份的用例（`auth.test.ts`），
 * 这里不重复它——这里防的是另一种坏法：某天有人为了让一个 case 过，在界面侧悄悄
 * 补了一个 `role === 'pm'` 之类的小分支。所以：
 *
 * 1. 表驱动：10 个状态 × 6 个演员，`visibleActions()` 必须等于
 *    `actionsFor(state)` 过滤 `can()`——两边都用 `detail.ts` 的真函数，不是抄一份。
 * 2. 真库：一条待评审的功能需求，逐身份读 `getRequirementDetail(id, actor)`，
 *    断言动作条与 `permissions`（描述「编辑」、参考段「生成 / 交回材料」的可见性）。
 * 3. 成员管理：只有超管拿得到视图；停用被占用的负责人时服务给的那句中文原样存在，
 *    并且“转交后就能停用”这条路真的走得通。
 * 4. 通知偏好：关掉之后，条线负责人**不再**收到扇出的行，但派单给他的那条仍在。
 * 5. 自改口令：旧口令 / 两次不一致 / 成功三条路。
 */

let people: SeededPerson[] = [];

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

const ADMIN = '房超';
const FEATURE_LEAD = '吕正豪';
const COMMERCIAL_LEAD = '赵越';
const PM = '吕品';
const PM_OTHER = '李嘉';
const PM_BUSINESS = '王妍';

/** 观众谓词用 `site: all` 摊平（P4-07 的档位在 notify-channels.test.ts 里单独测）。 */
const ALL_LEVELS = '{"site":"all","wecom":"off"}';

function memberOf(name: string): Member {
  const found = people.find((person) => person.name === name);
  if (found === undefined) throw new Error(`名册里没有 ${name}`);
  return { ...found, deactivatedAt: null, notifyPrefs: ALL_LEVELS };
}

function idOf(name: string): string {
  return memberOf(name).id;
}

/**
 * 一条功能线 PM（吕品）名下的需求：派单给功能线负责人吕正豪。
 * 表驱动的三种情形从这里派生。P4-06 起事实里没有 `type`——锚点是负责人的条线。
 */
const FEATURE_FACTS: RequirementFacts = {
  ownerMemberId: null,
  ownerLine: 'feature',
  state: 'review',
  reviewerMemberId: null,
};

function factsFor(state: string): RequirementFacts {
  return {
    ...FEATURE_FACTS,
    state,
    ownerMemberId: idOf(PM),
    reviewerMemberId: idOf(FEATURE_LEAD),
  };
}

/** 同一条状态上的商业线需求：负责人王妍（商业线）、派单赵越。跨线那一格靠它。 */
function businessFacts(state: string): RequirementFacts {
  return {
    ownerLine: 'commercial',
    state,
    ownerMemberId: idOf(PM_BUSINESS),
    reviewerMemberId: idOf(COMMERCIAL_LEAD),
  };
}

type Actor = { label: string; member: Member };

/** 演员在用例里现取：`people` 是 beforeEach 才灌进去的。 */
function actors(): Actor[] {
  return [
    { label: '超管', member: memberOf(ADMIN) },
    { label: '功能线负责人', member: memberOf(FEATURE_LEAD) },
    { label: '商业线负责人', member: memberOf(COMMERCIAL_LEAD) },
    { label: '负责人本人（PM）', member: memberOf(PM) },
    { label: '别的 PM', member: memberOf(PM_OTHER) },
    { label: '已停用的 PM', member: { ...memberOf(PM), deactivatedAt: new Date() } },
  ];
}

describe('动作条 = 状态合法 ∩ 这个人能做（漂移探测器）', () => {
  it('10 个状态 × 6 个演员 × 两条线：visibleActions 与 actionsFor ∩ can 逐格相等', () => {
    for (const { label, member } of actors()) {
      for (const state of BOARD_STATES) {
        for (const [line, facts] of [
          ['feature', factsFor(state)],
          ['commercial', businessFacts(state)],
        ] as const) {
          const expected = actionsFor(state).filter(
            (action) => can(member, facts, ACTION_ABILITY[action]),
          );
          // 用 detail.ts 的真函数（不是测试里再写一遍过滤逻辑）。
          expect({ who: label, line, state, actions: visibleActions(state, member, facts) })
            .toEqual({ who: label, line, state, actions: expected });
        }
      }
    }
  });

  it('跨线：负责人是商业线 PM 时，功能线负责人一格都没有', () => {
    const facts = businessFacts('review');
    // 王妍（商业线）名下的需求、派单赵越。吕正豪是功能线负责人——同级，但一格都不该有。
    expect(visibleActions('review', memberOf(FEATURE_LEAD), facts)).toEqual([]);
    // 连「改负责人」也没有：跨线转交在服务层就是 rejected 的。
    expect(can(memberOf(FEATURE_LEAD), facts, 'reassignOwner')).toBe(false);
    // 商业线负责人本人才拿到那三个动作。
    expect(visibleActions('review', memberOf(COMMERCIAL_LEAD), facts))
      .toEqual(['reviewPass', 'reviewReject', 'shelve']);
  });

  /**
   * 变更的起因（P4-06）：**类型与锚点脱钩**。一条商业类需求由功能线 PM 负责时，
   * 商业线负责人一格都没有，功能线负责人拿到全套——与它的类型无关。
   */
  it('商业类 + 功能线负责人：功能线负责人拿到动作条，商业线负责人空', () => {
    const facts: RequirementFacts = {
      ownerMemberId: idOf(PM),
      ownerLine: 'feature',
      state: 'review',
      reviewerMemberId: idOf(FEATURE_LEAD),
    };
    expect(visibleActions('review', memberOf(FEATURE_LEAD), facts))
      .toEqual(['reviewPass', 'reviewReject', 'shelve']);
    expect(visibleActions('review', memberOf(COMMERCIAL_LEAD), facts)).toEqual([]);
    // 负责人本人只能搁置（PM 没有签字权）
    expect(visibleActions('review', memberOf(PM), facts)).toEqual(['shelve']);
  });

  it('没有负责人的需求：动作条是空的，而 PM 拿到「认领」', () => {
    const facts: RequirementFacts = { ownerMemberId: null, ownerLine: null, state: 'inbox' };
    expect(visibleActions('inbox', memberOf(PM), facts)).toEqual([]);
    expect(can(memberOf(PM), facts, 'claim')).toBe(true);
    expect(can(memberOf(FEATURE_LEAD), facts, 'claim')).toBe(true);
    expect(can(memberOf(ADMIN), facts, 'claim')).toBe(true);
  });

  it('待评审：本人 / 本线负责人 / 别的 PM 三格各自成立', () => {
    const facts = factsFor('review');

    // 负责人本人只能搁置：评审动作对他不存在（不是存在但报错）。
    expect(visibleActions('review', memberOf(PM), facts)).toEqual(['shelve']);
    // 派单到的本线负责人：通过 / 打回，外加规则给 edit 的搁置（该条规则由 can 给）。
    expect(visibleActions('review', memberOf(FEATURE_LEAD), facts))
      .toEqual(['reviewPass', 'reviewReject', 'shelve']);
    // 别的 PM：空 —— 不是禁用，是一个都不出现。
    expect(visibleActions('review', memberOf(PM_OTHER), facts)).toEqual([]);
    // 另一条线的负责人：也是空。
    expect(visibleActions('review', memberOf(COMMERCIAL_LEAD), facts)).toEqual([]);
    // 超管：can('review') 与 can('edit') 都给，按 actionsFor 的顺序。
    expect(visibleActions('review', memberOf(ADMIN), facts))
      .toEqual(['reviewPass', 'reviewReject', 'shelve']);
  });

  it('终态 / 已搁置：没有动作的人拿到空数组，不是全部动作', () => {
    for (const state of ['rejected', 'shelved'] as const) {
      expect(visibleActions(state, memberOf(PM_OTHER), factsFor(state))).toEqual([]);
    }
    expect(visibleActions('shelved', memberOf(PM), factsFor('shelved'))).toEqual(['restore']);
  });
});

describe('真库：抽屉按人算出来的动作与按钮可见性', () => {
  async function reviewRequirement(): Promise<string> {
    const created = await createRequirement(db, PM, {
      title: '权限界面的那一条', type: 'feature', requester: '孙建宏',
    });
    await evaluate(db, PM, { requirementId: created.id });
    await submitReview(db, PM, { requirementId: created.id, prdUrl: 'https://x/prd' });
    return created.id;
  }

  it('PM 打开别人的需求：动作空、不能编辑、也不能生成 / 交回材料', async () => {
    const id = await reviewRequirement();
    const detail = (await getRequirementDetail(id, memberOf(PM_OTHER)))!;

    expect(detail.state).toBe('review');
    expect(detail.actions).toEqual([]);
    expect(detail.permissions.edit).toBe(false);
    expect(detail.permissions.review).toBe(false);
    expect(detail.permissions.reassignOwner).toBe(false);
  });

  it('负责人本人：只能搁置；派单评审人：通过 / 打回 / 搁置；超管：同上', async () => {
    const id = await reviewRequirement();

    const owner = (await getRequirementDetail(id, memberOf(PM)))!;
    expect(owner.actions).toEqual(['shelve']);
    expect(owner.permissions.edit).toBe(true);
    expect(owner.permissions.review).toBe(false);
    // PM 能改自己的需求，但不能把它甩给别人（转交控件因此不出现）。
    expect(owner.permissions.reassignOwner).toBe(false);

    for (const name of [FEATURE_LEAD, ADMIN]) {
      const detail = (await getRequirementDetail(id, memberOf(name)))!;
      expect({ who: name, actions: detail.actions })
        .toEqual({ who: name, actions: ['reviewPass', 'reviewReject', 'shelve'] });
      expect(detail.permissions.review).toBe(true);
      expect(detail.permissions.reassignOwner).toBe(true);
    }
  });

  it('没有身份（MCP 的纯读）仍然拿到「状态合法」的全集——旧契约不变', async () => {
    const id = await reviewRequirement();
    const detail = (await getRequirementDetail(id))!;
    expect(detail.actions).toEqual(actionsFor('review'));
    expect(detail.permissions.edit).toBe(false);
  });

  it('明确没有身份（null）：动作空，权限全 false', async () => {
    const id = await reviewRequirement();
    const detail = (await getRequirementDetail(id, null))!;
    expect(detail.actions).toEqual([]);
    expect(detail.permissions).toEqual({
      edit: false, review: false, reassignOwner: false, claim: false, manageMembers: false,
    });
  });
});

describe('成员管理：只有超管，且停用被占用时要能转交', () => {
  it('memberAdminView 只给超管；负责需求数是真的', async () => {
    await createRequirement(db, PM, { title: '占着一条', type: 'feature', requester: 'x' });

    expect(await memberAdminView(memberOf(PM))).toBeNull();
    expect(await memberAdminView(memberOf(FEATURE_LEAD))).toBeNull();
    expect(await memberAdminView(null)).toBeNull();

    const rows = (await memberAdminView(memberOf(ADMIN)))!;
    expect(rows).not.toBeNull();
    expect(rows).toHaveLength(7);
    const owner = rows.find((row) => row.name === PM)!;
    expect(owner.owned).toBe(1);
    expect(owner.active).toBe(true);
  });

  it('非超管建人：同一句「只有超管可以管理成员」', async () => {
    await expect(createMember(db, PM, { name: '新人', role: 'pm', line: 'feature' }))
      .rejects.toMatchObject({ code: 'forbidden', message: '只有超管可以管理成员' });
  });

  it('停用还占着需求的负责人：中文原样；转交之后就能停用', async () => {
    await createRequirement(db, PM, { title: '占着一条', type: 'feature', requester: 'x' });

    let caught: AppError | null = null;
    try {
      await deactivateMember(db, ADMIN, { memberId: idOf(PM) });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      caught = error;
    }
    expect(caught?.code).toBe('member_busy');
    expect(caught?.message).toBe('这个人还负责 1 条需求，先转交');

    // 界面上的「转交」就是这一条：选一个人，把这个人名下全部需求转过去。
    const moved = await transferOwnedRequirements(db, ADMIN, {
      fromMemberId: idOf(PM), toMemberId: idOf(PM_OTHER),
    });
    expect(moved.moved).toBe(1);
    expect(await requirementsOwnedBy(idOf(PM))).toEqual([]);

    await deactivateMember(db, ADMIN, { memberId: idOf(PM) });
    const after = (await memberAdminView(memberOf(ADMIN)))
      ?.find((row) => row.name === PM)!;
    expect(after.active).toBe(false);
    expect(after.owned).toBe(0);
  });
});

describe('通知偏好：关掉 = 扇出停，关系不动', () => {
  it('条线负责人关掉后不再收本线扇出，派单给他的那条仍然在', async () => {
    const created = await createRequirement(db, PM, {
      title: '会扇出的一条', type: 'feature', requester: '孙建宏',
    });
    await evaluate(db, PM, { requirementId: created.id });
    await submitReview(db, PM, { requirementId: created.id, prdUrl: 'https://x/prd' });

    const lead = memberOf(FEATURE_LEAD);
    const before = await notificationsFor(db, lead);
    expect(before.map((notice) => notice.type).sort()).toEqual([
      'requirement.created',
      'requirement.evaluated',
      'requirement.review_requested',
    ]);

    await saveNotifyChannels(db, FEATURE_LEAD, { site: 'off' });

    // P4-07：`off` 是**真的空**——连派单给他的那一条也不出现（铃铛整个藏起来）。
    // 旧的「关掉扇出、保留派单」是 P4-03 的两开关模型；三档模型里没有这一格：
    // 「我不看」就是不看，替人挑一条留下来是另一种不听话。
    // 读侧重新取一行（`memberOf` 是内存里那份，notify_prefs 是库里的）。
    const stored = await db.execute<{ notify_prefs: string | null }>(sql`
      select notify_prefs from members where id = ${lead.id}`);
    const after = await notificationsFor(db, {
      ...lead, notifyPrefs: stored.rows[0]?.notify_prefs ?? null,
    });
    expect(after).toEqual([]);

    // 切到 key：要动手的（review_requested）与有结果的都在，一般变动（created）不在。
    await saveNotifyChannels(db, FEATURE_LEAD, { site: 'key' });
    const keyed = await db.execute<{ notify_prefs: string | null }>(sql`
      select notify_prefs from members where id = ${lead.id}`);
    const relaxed = await notificationsFor(db, {
      ...lead, notifyPrefs: keyed.rows[0]?.notify_prefs ?? null,
    });
    expect(relaxed.map((notice) => notice.type).sort()).toEqual([
      'requirement.evaluated',
      'requirement.review_requested',
    ]);
  });
});

describe('自改口令', () => {
  it('旧口令不对 / 两次不一致 / 成功', async () => {
    await setPassword(db, idOf(PM), 'old-password-1');

    await expect(changePassword(db, PM, {
      oldPassword: 'wrong-password', newPassword: 'new-password-1', confirm: 'new-password-1',
    })).rejects.toMatchObject({ code: 'invalid', message: '旧口令不对' });

    await expect(changePassword(db, PM, {
      oldPassword: 'old-password-1', newPassword: 'new-password-1', confirm: 'new-password-2',
    })).rejects.toMatchObject({ code: 'invalid', message: '两次输入的新口令不一致' });

    await changePassword(db, PM, {
      oldPassword: 'old-password-1', newPassword: 'new-password-1', confirm: 'new-password-1',
    });
    const row = await db.execute<{ password_hash: string }>(sql`
      select password_hash from members where id = ${idOf(PM)}`);
    expect(await verifyHash('new-password-1', row.rows[0]!.password_hash)).toBe(true);
    expect(await verifyHash('old-password-1', row.rows[0]!.password_hash)).toBe(false);
  });
});
