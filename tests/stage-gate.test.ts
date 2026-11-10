import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { AppError } from '../src/core/errors.js';
import { startGeneration } from '../src/core/uemaster/start.js';
import { cancelJob, retryJob } from '../src/core/uemaster/control.js';
import { EVALUATE_STAGE, evaluateStageLock } from '../src/core/uemaster/gate.js';
import { evaluateLock } from '../src/core/requirements/brief.js';
import { STATE_LABEL, type State } from '../src/core/state-machine.js';
import { getRequirementDetail } from '../src/core/read/detail.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { REPO_ROOT, cleanArtifacts } from './helpers/files.js';

/**
 * v1 阶段门：**评估材料只在「收集」阶段生成**（2026-11-10 owner 裁决 A）。
 *
 * owner 的原话：「v1 承诺的是『需求进收集 → 点评估 → 三栏材料』，所以评估材料只能在
 * 收集阶段生成」。这句话如果只写在计划文档里，它会在第一次「有人想给一条待设计的需求
 * 补一份材料」时失效——因为那条路（数据库里状态已经不是 `inbox`）今天走得通。
 *
 * 这一组钉五件事，每一件都对着**会在实现里被改坏的那一行**：
 *
 * 1. 收集里（`inbox`）→ 放行（这一条是判据的反面：不能把两档都关掉）；
 * 2. 待设计 / 待评审 / 待排期 / 已上线 → 拒绝，且**点名中文状态**（不是 `design`）；
 * 3. 绕过界面直接调服务（POST 那条路）→ 仍然被拒（界面只是提前告知）；
 * 4. 「重试」那条路也走同一个判据（`retryJob` → `startGeneration`，不留后门）；
 * 5. 读模型把**同一句话**交给抽屉（按钮先禁用，不是点了才被拒），而**旧材料照常可点**。
 *
 * 另外一条反面：评审 / 走查**不被这条规则拦**（它们由 `FEATURE_REVIEW_MATERIALS` 关着，
 * 那是入口开关，不是阶段门）。顺手扩大范围会让将来打开那两行时多出一道没人要求的门。
 */

/** 六问填齐：这一组判的是阶段门，别让六问门先说话（两句话不一样，混了就测不出谁在拒）。 */
// 2026-11-11 起六问全必填：夹具必须六格，否则每条用例都先撞同一道门。
const FILLED = {
  context: '运营在后台给客户开权限时',
  problem: '每次要跳七个页面，容易漏配',
  outcome: '一次点完，漏配为 0',
  surfaces: '管理后台 · 客户权限页',
  edgeCases: '客户已停用、重复勾选时提示',
  outOfScope: '不做批量导入',
};

/** 与其它生成用例同一个 stub 壳（silent：跑完不留产物，用例只关心「作业有没有落下」）。 */
function stub(name: string): string {
  return `"${process.execPath}" "${path.join(REPO_ROOT, 'tests', 'stubs', name)}"`;
}

async function seedInbox(): Promise<string> {
  const r = await createRequirement(db, '吕品', {
    title: 'S3 协议支持', type: 'feature', requester: '孙建宏', ...FILLED,
  });
  return r.id;
}

/**
 * 把一条需求挪到别的状态。
 *
 * 为什么直接写 `state` 而不是走 `evaluate` / `submitReview` / 时钟：这一组判的对象是
 * **一个只读 `state` 的判据**，状态是怎么走到的与它无关；而那些转移本身由
 * `tests/state-machine.test.ts` / `tests/flow.test.ts` 各自钉着。走真流程要走十几步
 * （派单、PRD、排期版本、时钟），一旦某一步改了，这组用例会红在一个与阶段门无关的地方。
 */
async function moveTo(id: string, state: State): Promise<void> {
  await db.execute(sql`
    update requirements set state = ${state}, state_entered_at = now() where id = ${id}`);
}

async function caught(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected AppError, nothing thrown');
}

async function jobCount(requirementId: string): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from uemaster_jobs where requirement_id = ${requirementId}`);
  return Number(res.rows[0]!.n);
}

beforeEach(async () => {
  await resetDb();
  await seedPeople();
  await cleanArtifacts();
  process.env.FLOWERS_GEN_CMD = stub('gen-silent.mjs');
});

afterEach(() => {
  delete process.env.FLOWERS_GEN_CMD;
});

afterAll(async () => {
  await cleanArtifacts();
  await pool.end();
});

describe('判据（纯函数：一句话，两个地方用）', () => {
  it('收集 → null（放行）；v1 承诺的起点就是它', () => {
    expect(EVALUATE_STAGE).toBe('inbox');
    expect(evaluateStageLock('inbox')).toBeNull();
  });

  it('其余九个状态全部拒绝，名字来自 STATE_LABEL（绝不出现 design 这种键）', () => {
    const others: State[] = [
      'design', 'review', 'queue', 'ready', 'dev', 'test', 'live', 'rejected', 'shelved',
    ];
    for (const state of others) {
      const message = evaluateStageLock(state)!;
      expect(message).toContain(`「${STATE_LABEL[state]}」`);
      // 中文名出现在那句话里，而键名不该出现（`review`/`design` 这种词是给库看的）。
      expect(message).not.toContain(`「${state}」`);
      expect(message).not.toContain('inbox');
    }
  });

  /**
   * 一字不差：规则 + 现在在哪 + **一条真能走的路**。
   *
   * 这句话里曾经有半句「或先把它退回收集」——那是空头支票：`TRANSITIONS` 里没有
   * 「待设计 → 收集」这条边，照着做会撞一句「不能从「待设计」直接到「收集」」。
   * 2026-11-10 的裁定把它删掉了（见下面那条用例：这句空头支票不许再出现）。
   */
  it('一字不差：规则 + 现在在哪 + 一条真能走的路（owner 定的那句话）', () => {
    expect(evaluateStageLock('design')).toBe(
      'v1 只在收集阶段生成评估材料。这条需求现在在「待设计」'
      + '——想用这个能力，请在收集里新建一条。',
    );
  });

  it('与六问门是两句话：阶段不对时不拿「还差几条」当理由', () => {
    const stage = evaluateStageLock('live')!;
    expect(stage).not.toContain('还差');
    // 六问全空也照样有它自己那句——两道门不共用措辞（共用的是**形状**：一句话或 null）。
    expect(evaluateLock({})).toContain('还差六条没填');
  });
});

describe('服务层：唯一真相', () => {
  it('收集里 → 放行，落下一条 running 作业', async () => {
    const requirementId = await seedInbox();
    const { jobId } = await startGeneration(db, '吕品', { requirementId, stage: 'evaluate' });

    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await jobCount(requirementId)).toBe(1);
    // 收口：这次真的甩出去一个 worker，停掉它（别让它跨用例跑）。
    await cancelJob(db, jobId);
  });

  it('待设计 / 待评审 / 待排期 / 已上线 → 拒绝，且说清现在在哪（四个状态各一次）', async () => {
    const states: State[] = ['design', 'review', 'queue', 'live'];
    for (const state of states) {
      await resetDb();
      await seedPeople();
      const requirementId = await seedInbox();
      await moveTo(requirementId, state);

      const error = await caught(startGeneration(db, '吕品', { requirementId, stage: 'evaluate' }));
      expect(error.code).toBe('stage_not_inbox');
      expect(error.message).toContain(`这条需求现在在「${STATE_LABEL[state]}」`);
      expect(error.message).toContain('v1 只在收集阶段生成评估材料');
      // 一句话只说一个理由：六问是齐的，所以那句话里不该出现六问门的措辞。
      expect(error.message).not.toContain('还差');
      // 拒绝发生在落作业之前：不留作业行、不甩 worker。
      expect(await jobCount(requirementId)).toBe(0);
    }
  });

  it('绕过界面直接调服务（POST 那条路）→ 仍然被拒，且等于读模型给的那一句', async () => {
    const requirementId = await seedInbox();
    await moveTo(requirementId, 'design');

    const error = await caught(startGeneration(db, '吕品', { requirementId, stage: 'evaluate' }));
    expect(error.code).toBe('stage_not_inbox');

    const detail = (await getRequirementDetail(requirementId))!;
    // 逐字相等：界面与服务不会各说一句（抽屉里那句话就是按钮禁用的理由）。
    expect(detail.refs.find((r) => r.stage === 'evaluate')!.needsDescription)
      .toBe(error.message);
  });

  it('重试那条路也撞同一道门（不留后门）', async () => {
    const requirementId = await seedInbox();
    // 先在收集里开一次作业（合法），再把它停掉——重试的起点是一条真实的旧作业。
    const { jobId } = await startGeneration(db, '吕品', { requirementId, stage: 'evaluate' });
    await cancelJob(db, jobId);
    // 需求在这期间走到了待设计（评估立项之后就是这样），然后有人按「重试」。
    await moveTo(requirementId, 'design');

    const error = await caught(retryJob(db, '吕品', jobId));
    expect(error.code).toBe('stage_not_inbox');
    expect(error.message).toContain('这条需求现在在「待设计」');
    expect(await jobCount(requirementId)).toBe(1);   // 只多了那一条被停止的旧作业
  });

  it('评审 / 走查不被这条规则拦（它们由 FEATURE_REVIEW_MATERIALS 关着，不是阶段门）', async () => {
    // 一条待设计的需求：评估被拒，但走查那条路不该因为「阶段」被拒（PRD 齐、生成器在）。
    const requirementId = await seedInbox();
    await moveTo(requirementId, 'design');
    await db.execute(sql`update requirements set prd_url = 'https://example.com/prd' where id = ${requirementId}`);

    const { jobId } = await startGeneration(db, '吕品', { requirementId, stage: 'inspect' });
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    await cancelJob(db, jobId);

    // 评审同理：它的前提是 PRD，不是阶段。
    const review = await startGeneration(db, '吕品', { requirementId, stage: 'review' });
    await cancelJob(db, review.jobId);
  });
});

describe('读模型：按钮先禁用，理由是同一句话', () => {
  it('待设计 → 评估那一行带理由；评审 / 走查两行不带', async () => {
    const requirementId = await seedInbox();
    await moveTo(requirementId, 'design');
    const detail = (await getRequirementDetail(requirementId))!;

    const evaluate = detail.refs.find((r) => r.stage === 'evaluate')!;
    expect(evaluate.needsDescription).toBe(evaluateStageLock('design'));
    expect(detail.refs.find((r) => r.stage === 'review')!.needsDescription).toBeNull();
    expect(detail.refs.find((r) => r.stage === 'inspect')!.needsDescription).toBeNull();
  });

  it('收集里 → 没有理由（收集阶段那个「生成」照旧能按）', async () => {
    const requirementId = await seedInbox();
    const detail = (await getRequirementDetail(requirementId))!;
    expect(detail.refs.find((r) => r.stage === 'evaluate')!.needsDescription).toBeNull();
  });

  it('阶段门先说话：待设计且六问也空着时，理由是阶段那句（补六问也不管用）', async () => {
    const requirementId = await seedInbox();
    await db.execute(sql`
      update requirements
         set state = 'design', context = null, problem = null, outcome = null
       where id = ${requirementId}`);

    const detail = (await getRequirementDetail(requirementId))!;
    const reason = detail.refs.find((r) => r.stage === 'evaluate')!.needsDescription!;
    expect(reason).toContain('「待设计」');
    expect(reason).not.toContain('还差');
  });

  it('已有的材料不受影响：链接照旧可点，只是新的一次生成被关', async () => {
    const requirementId = await seedInbox();
    await db.execute(sql`
      insert into uemaster_artifacts (requirement_id, stage, url, created_by)
      values (${requirementId}, 'evaluate', ${'/uemaster/PAN-99/evaluate.html'}, '吕品')`);
    await moveTo(requirementId, 'live');

    const detail = (await getRequirementDetail(requirementId))!;
    const evaluate = detail.refs.find((r) => r.stage === 'evaluate')!;
    // 老材料仍然是老材料：读得到、点得开（历史不动）。
    expect(evaluate.present).toBe(true);
    expect(evaluate.url).toBe('/uemaster/PAN-99/evaluate.html');
    expect(evaluate.versions).toBe(1);
    // 新的那一次生成被关，理由与服务的错误原文同源。
    expect(evaluate.needsDescription).toContain('这条需求现在在「已上线」');
  });
});
