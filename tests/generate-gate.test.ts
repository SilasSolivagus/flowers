import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { AppError } from '../src/core/errors.js';
import { startGeneration } from '../src/core/uemaster/start.js';
import { cancelJob } from '../src/core/uemaster/control.js';
import { evaluateLock, lockMessage, missingRequired } from '../src/core/requirements/brief.js';
import { getRequirementDetail } from '../src/core/read/detail.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { REPO_ROOT, cleanArtifacts } from './helpers/files.js';

/**
 * 六问没填，不许生成（2026-11-10 owner 的裁定）。
 *
 * 事故的形状：一条六问全空的收集需求照样能进「评估」，模型于是从一个标题编出一套
 * 流程、一套页面、一套成功口径——材料看起来完整（有图、有线框、有「待确认」），
 * 而里面没有一格来自写需求的人。owner：「如果需求的描述没填写 是需要让用户先填
 * 才能生成的」。
 *
 * 裁定（写进报告，可被推翻）：**必填** context / problem / outcome（谁在什么情况下用、
 * 现在怎么做哪不好、做成什么样算成功）；**不必填** surfaces / edgeCases / outOfScope
 * （收集阶段本来常常没有，材料已经把「没写」当待确认项列出来）。
 *
 * 这一组钉四件事：
 * 1. 三问缺任何一条 → 拒绝，并且**点名那一条**；
 * 2. 三问齐 → 放行；
 * 3. 绕过界面直接调用服务（POST 那条路）→ 仍然被拒（界面只是提前告知）；
 * 4. 读模型把**同一句话**交给抽屉（按钮先禁用，不是点了才被拒）。
 */

const FILLED = {
  context: '运营在后台给客户开权限时',
  problem: '每次要跳七个页面，容易漏配',
  outcome: '一次点完，漏配为 0',
};

/** 与其它生成用例同一个 stub 壳。 */
function stub(name: string): string {
  return `"${process.execPath}" "${path.join(REPO_ROOT, 'tests', 'stubs', name)}"`;
}

type Fields = Partial<Record<'context' | 'problem' | 'outcome', string>>;

async function seed(fields: Fields): Promise<string> {
  const r = await createRequirement(db, '吕品', {
    title: 'S3 协议支持', type: 'feature', requester: '孙建宏', ...fields,
  });
  return r.id;
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
  it('三问全空 → 三条都点名，顺序与裁定一致', () => {
    expect(lockMessage(missingRequired({}))).toBe(
      '还差三条没填：谁在什么情况下用、现在怎么做/哪不好、做成什么样算成功。'
      + '补完才能立项，也才能出评估材料——立项要拿这三问站住，材料要按这三问画，缺了只能靠编。',
    );
  });

  it('只缺成功口径 → 只点名它（用户不必回头找是哪一条）', () => {
    expect(lockMessage(missingRequired({
      context: FILLED.context, problem: FILLED.problem,
    }))).toBe('还差一条没填：做成什么样算成功。'
      + '补完才能立项，也才能出评估材料——立项要拿这三问站住，材料要按这三问画，缺了只能靠编。');
  });

  it('只缺现状问题 / 只缺使用场景 → 各自点名', () => {
    expect(lockMessage(missingRequired({
      context: FILLED.context, outcome: FILLED.outcome,
    }))).toContain('现在怎么做/哪不好');
    expect(lockMessage(missingRequired({
      problem: FILLED.problem, outcome: FILLED.outcome,
    }))).toContain('谁在什么情况下用');
  });

  it('只有空白字符也算没填（与指纹的归一同一条口径）', () => {
    expect(missingRequired({ context: '   ', problem: '\n', outcome: '\t' })).toHaveLength(3);
  });

  it('三问齐 → null；而且那三问之外的字段空不空不影响', () => {
    expect(evaluateLock(FILLED)).toBeNull();
    // surfaces / edgeCases / outOfScope 空着是允许的（收集阶段本来就常常没有）。
    expect(evaluateLock({ ...FILLED, surfaces: '', edgeCases: '', outOfScope: '' })).toBeNull();
  });
});

describe('服务层：生成被拒（唯一真相）', () => {
  it('三问全空 → 拒绝，作业一行都不落', async () => {
    const requirementId = await seed({});
    const error = await caught(startGeneration(db, '吕品', { requirementId, stage: 'evaluate' }));

    expect(error.code).toBe('description_incomplete');
    expect(error.message).toContain('还差三条没填');
    expect(error.message).toContain('补完才能立项');
    expect(await jobCount(requirementId)).toBe(0);
  });

  it('每缺一条 → 那一句点名它（三条各一次）', async () => {
    const cases: Array<[keyof Fields, string]> = [
      ['context', '谁在什么情况下用'],
      ['problem', '现在怎么做/哪不好'],
      ['outcome', '做成什么样算成功'],
    ];
    for (const [missing, label] of cases) {
      await resetDb();
      await seedPeople();
      const rest = Object.fromEntries(
        Object.entries(FILLED).filter(([key]) => key !== missing),
      ) as Fields;
      const requirementId = await seed(rest);

      const error = await caught(startGeneration(db, '吕品', { requirementId, stage: 'evaluate' }));
      expect(error.code).toBe('description_incomplete');
      expect(error.message).toContain('还差一条没填');
      expect(error.message).toContain(label);
      // 别的那两条不该出现在「还差」里：一次只该看到真正缺的那一条。
      for (const [key, other] of Object.entries(FILLED)) {
        if (key !== missing) expect(error.message).not.toContain(other.slice(0, 6));
      }
      expect(await jobCount(requirementId)).toBe(0);
    }
  });

  it('绕过界面直接调服务（POST 那条路）→ 仍然被拒，且是同一句话', async () => {
    // 界面那条路会先把按钮禁用；一个手写的 POST / server action 调用不走界面。
    const requirementId = await seed({ context: FILLED.context });
    const error = await caught(startGeneration(db, '吕品', { requirementId, stage: 'evaluate' }));

    expect(error.code).toBe('description_incomplete');
    // 逐字等于读模型交给抽屉的那一句（见下面那一组）：界面与服务不会各说一句。
    const detail = await getRequirementDetail(requirementId);
    expect(detail!.refs.find((r) => r.stage === 'evaluate')!.needsDescription)
      .toBe(error.message);
  });

  it('三问齐 → 放行，落下一条 running 作业', async () => {
    const requirementId = await seed(FILLED);
    const { jobId } = await startGeneration(db, '吕品', { requirementId, stage: 'evaluate' });

    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await jobCount(requirementId)).toBe(1);
    // 收口：这次真的甩出去一个 worker，停掉它（别让它跨用例跑）。
    await cancelJob(db, jobId);
  });
});

describe('读模型：按钮先禁用，理由是同一句话', () => {
  it('三问没填 → 评估那一行带着理由；评审 / 走查两行不带（它们的输入不是六问）', async () => {
    const requirementId = await seed({ problem: FILLED.problem });
    const detail = (await getRequirementDetail(requirementId))!;

    const evaluate = detail.refs.find((r) => r.stage === 'evaluate')!;
    expect(evaluate.needsDescription).toContain('还差两条没填');
    expect(evaluate.needsDescription).toContain('谁在什么情况下用');
    expect(evaluate.needsDescription).toContain('做成什么样算成功');
    expect(detail.refs.find((r) => r.stage === 'review')!.needsDescription).toBeNull();
    expect(detail.refs.find((r) => r.stage === 'inspect')!.needsDescription).toBeNull();
  });

  it('三问齐 → 评估那一行没有理由（按钮照旧能按）', async () => {
    const requirementId = await seed(FILLED);
    const detail = (await getRequirementDetail(requirementId))!;
    expect(detail.refs.find((r) => r.stage === 'evaluate')!.needsDescription).toBeNull();
  });

  it('已有的材料不受影响：产物链接照旧，只是新的一次生成被拦下', async () => {
    const requirementId = await seed(FILLED);
    await db.execute(sql`
      insert into uemaster_artifacts (requirement_id, stage, url, created_by)
      values (${requirementId}, 'evaluate', ${'/uemaster/PAN-99/evaluate.html'}, '吕品')`);
    // 之后有人把描述清空了：材料还在（历史不动），但新生成会被拒。
    await db.execute(sql`
      update requirements set context = null, problem = null, outcome = null where id = ${requirementId}`);

    const detail = (await getRequirementDetail(requirementId))!;
    const evaluate = detail.refs.find((r) => r.stage === 'evaluate')!;
    expect(evaluate.present).toBe(true);
    expect(evaluate.url).toBe('/uemaster/PAN-99/evaluate.html');
    expect(evaluate.needsDescription).toContain('还差三条没填');
  });
});
