import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { attachArtifact } from '../src/core/uemaster/attach.js';
import { getRequirementDetail } from '../src/core/read/detail.js';
import { AppError } from '../src/core/errors.js';
import {
  evaluateLock, lockMessage, missingRequired,
} from '../src/core/requirements/brief.js';
import {
  STATE_LABEL, TRANSITIONS, assertTransition, assertTrigger, type State,
} from '../src/core/state-machine.js';
import { startGeneration } from '../src/core/uemaster/start.js';
import { cancelJob } from '../src/core/uemaster/control.js';
import { evaluateStageLock } from '../src/core/uemaster/gate.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { REPO_ROOT, cleanArtifacts } from './helpers/files.js';

/**
 * 六问不齐不能立项（2026-11-10 owner 的裁决）：**门在状态变迁上**。
 *
 * 上一版把六问门只装在生成器上（`startGeneration` 里那次检查），它能挡住「不许出
 * 材料」，挡不住「没有六问的需求照样能立项」——MCP 的 `requirement_start_design`、
 * 直接交回一份材料（`attach` 走的是同一条迁移）、将来的批量导入，每条路都能绕过它。
 * 所以这一版的判据挂到 `inbox → design` 那条边上（`guard: 'brief'`）。
 *
 * 为什么是这条边而不是生成器：**立项是一个动作，材料是这个动作的产物。** 材料可以
 * 重做、可以别人替你交；立项一旦发生，需求就离开了「等人补描述」的那一列。
 *
 * 这一组钉六件事：
 * 1. 表里那一条真的带 `guard: 'brief'`（不是「在别处判一下」）；
 * 2. 缺 context / problem / outcome → 各拒一次，并且**只点名真正缺的那一条**；
 * 3. 三条齐 → 放行；
 * 4. 服务层（点评估 / MCP 的立项工具）拒绝时**点名**，且状态一动没动、事件一条没写；
 * 5. 绕过界面直接 `attach` 材料也撞同一道门（这是「门在变迁上」最硬的那个证据：
 *    材料与状态迁移在同一个事务里，门一响两件都没发生）；
 * 6. 抽屉里按钮旁边那句话与错误原文逐字相同，而且两个门的措辞各说各的事——
 *    谁都不许承诺状态机里不存在的边（「退回收集」）。
 */

const FILLED = {
  context: '运营在后台给客户开权限时',
  problem: '每次要跳七个页面，容易漏配',
  outcome: '一次点完，漏配为 0',
};

type BriefKey = 'context' | 'problem' | 'outcome';

/** 三条里去掉一条（其余两条照 old 填）。 */
function without(missing: BriefKey): Partial<Record<BriefKey, string>> {
  return Object.fromEntries(
    Object.entries(FILLED).filter(([key]) => key !== missing),
  ) as Partial<Record<BriefKey, string>>;
}

const LABEL: Record<BriefKey, string> = {
  context: '谁在什么情况下用',
  problem: '现在怎么做/哪不好',
  outcome: '做成什么样算成功',
};

async function seed(fields: Partial<Record<BriefKey, string>> = {}): Promise<string> {
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

async function stateOf(id: string): Promise<string> {
  const res = await db.execute<{ state: string }>(sql`
    select state from requirements where id = ${id}`);
  return res.rows[0]!.state;
}

async function eventTypes(id: string): Promise<string[]> {
  const res = await db.execute<{ type: string }>(sql`
    select type from events where requirement_id = ${id} order by seq`);
  return res.rows.map((row) => row.type);
}

/** 与其它生成用例同一个 stub 壳（silent：跑完不留产物）。 */
function stub(name: string): string {
  return `"${process.execPath}" "${path.join(REPO_ROOT, 'tests', 'stubs', name)}"`;
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

describe('表：门挂在变迁上', () => {
  it('inbox → design / approve（立项）那一条带 guard: brief（不是靠调用方自觉）', () => {
    // trigger 2026-11-10 从 `evaluate` 改名 `approve`：生成材料不再走这条边，
    // 这条边只剩「立项」一个含义（见 `state-machine.ts` 的 `Trigger`）。
    const edge = TRANSITIONS.find(
      (t) => t.from === 'inbox' && t.to === 'design' && t.trigger === 'approve',
    )!;
    expect(edge.guard).toBe('brief');
  });

  it('别的边没有被顺手加上这道门（只有立项这一条要核心三问）', () => {
    const brief = TRANSITIONS.filter((t) => t.guard === 'brief');
    expect(brief).toHaveLength(1);
    expect(brief[0]).toMatchObject({ from: 'inbox', to: 'design' });
  });
});

describe('判据：核心三条，逐条点名', () => {
  it('三条齐 → 放行（返回那一条迁移）', () => {
    expect(evaluateLock(FILLED)).toBeNull();
    expect(assertTrigger('inbox', 'design', 'approve', { brief: FILLED })).toMatchObject({
      from: 'inbox', to: 'design', guard: 'brief',
    });
  });

  it('缺 context / problem / outcome：各拒一次，且只点名真正缺的那一条', () => {
    for (const missing of ['context', 'problem', 'outcome'] as BriefKey[]) {
      const error = (() => {
        try {
          assertTrigger('inbox', 'design', 'approve', { brief: without(missing) });
        } catch (e) {
          return e as AppError;
        }
        throw new Error(`${missing} 缺了却放行`);
      })();

      expect(error.code).toBe('missing_brief');
      expect(error.message).toContain(`还差一条没填：${LABEL[missing]}`);
      // 别的那两条不该出现在「还差」里：一次只该看到真正缺的那一条。
      for (const key of ['context', 'problem', 'outcome'] as BriefKey[]) {
        if (key !== missing) expect(error.message).not.toContain(LABEL[key]);
      }
    }
  });

  it('三条全空 / 忘了传 ctx → 三条都点名（fail-closed，不是「跳过检查」）', () => {
    for (const ctx of [{ brief: {} }, {}]) {
      let message = '';
      try {
        assertTransition('inbox', 'design', ctx);
      } catch (error) {
        message = (error as AppError).message;
      }
      expect(message).toContain('还差三条没填');
      for (const key of ['context', 'problem', 'outcome'] as BriefKey[]) {
        expect(message).toContain(LABEL[key]);
      }
    }
  });

  it('空白字符也算没填（与指纹的归一同一条口径）', () => {
    const error = (() => {
      try {
        assertTransition('inbox', 'design', {
          brief: { context: '   ', problem: '\n', outcome: FILLED.outcome },
        });
      } catch (e) {
        return e as AppError;
      }
      throw new Error('三个空格被当成了内容');
    })();
    expect(missingRequired({ context: '  ', problem: '', outcome: 'x' })).toHaveLength(2);
    expect(error.message).toContain('还差两条没填');
  });
});

describe('服务层：立项被拒，而且什么都没发生', () => {
  it('缺成功口径 → 拒绝并点名它；状态还是收集，一条事件都没写', async () => {
    const requirementId = await seed(without('outcome'));

    const error = await caught(evaluate(db, '吕品', { requirementId }));
    expect(error.code).toBe('missing_brief');
    expect(error.message).toContain('还差一条没填：做成什么样算成功');

    expect(await stateOf(requirementId)).toBe('inbox');
    // createRequirement 写过一条 created；迁移事件一条都不该有。
    expect(await eventTypes(requirementId)).toEqual(['requirement.created']);
  });

  it('三条齐 → 真立项（收集 → 待设计），并且照旧写迁移事件', async () => {
    const requirementId = await seed(FILLED);
    await evaluate(db, '吕品', { requirementId });

    expect(await stateOf(requirementId)).toBe('design');
    expect(await eventTypes(requirementId)).toEqual([
      'requirement.created', 'requirement.evaluated',
    ]);
  });

  it('交回一份材料（attach 那条路）不再撞这道门：它不改状态，所以也不需要过六问', async () => {
    // 2026-11-10 owner 的第二次纠正之前，这里断言的是「材料与迁移一起回滚」——
    // 那时 attach 顺手把需求推进到待设计，所以它必须过六问门。
    //
    // 现在 attach **只落产物**：状态一个字不动，也就没有什么「迁移」要过门。六问
    // 只拦两个地方——生成（材料不能编，`start.ts`）与立项（决定不能空，`state-machine.ts`
    // 的 `guard: 'brief'`）。这条用例钉住的是「没有第三处」。
    const requirementId = await seed(without('problem'));

    const attached = await attachArtifact(db, '吕品', {
      requirementId,
      stage: 'evaluate',
      // 站外链接：attach 不会去 stat 本地文件。
      url: 'https://example.com/evaluate-v001.html',
    });
    expect(attached.stage).toBe('evaluate');

    // 材料落了库、状态没动、没有迁移事件。
    const artifacts = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from uemaster_artifacts where requirement_id = ${requirementId}`);
    expect(Number(artifacts.rows[0]!.n)).toBe(1);
    expect(await stateOf(requirementId)).toBe('inbox');
    expect(await eventTypes(requirementId)).toEqual(['requirement.created', 'uemaster.attached']);

    // 而立项仍然撞同一道门（缺 problem）。
    const error = await caught(evaluate(db, '吕品', { requirementId }));
    expect(error.code).toBe('missing_brief');
    expect(error.message).toContain('还差一条没填：现在怎么做/哪不好');
  });
});

describe('读模型：抽屉那一行与服务说同一句话', () => {
  it('缺两条 → 评估材料那一行的理由逐字等于服务端拒绝的原文', async () => {
    const requirementId = await seed({ context: FILLED.context });

    const detail = (await getRequirementDetail(requirementId))!;
    const reason = detail.refs.find((r) => r.stage === 'evaluate')!.needsDescription!;
    expect(reason).toContain('还差两条没填');
    expect(reason).toContain('现在怎么做/哪不好');
    expect(reason).toContain('做成什么样算成功');

    let thrown = '';
    try {
      await evaluate(db, '吕品', { requirementId });
    } catch (error) {
      thrown = (error as AppError).message;
    }
    expect(reason).toBe(thrown);
    // 评审 / 走查两行的输入不是六问，一个字都不该挂上去。
    expect(detail.refs.find((r) => r.stage === 'review')!.needsDescription).toBeNull();
    expect(detail.refs.find((r) => r.stage === 'inspect')!.needsDescription).toBeNull();
  });
});

describe('两个门各说各的事，谁都不许开空头支票', () => {
  const STATES = Object.keys(STATE_LABEL) as State[];

  it('「退回收集」在任何一句话里都不再出现（状态机里没有那条边）', () => {
    const messages: string[] = [];
    for (const state of STATES) {
      const stage = evaluateStageLock(state);
      if (stage !== null) messages.push(stage);
      for (const fields of [{}, without('context'), without('problem'), without('outcome'), FILLED]) {
        const brief = evaluateLock(fields);
        if (brief !== null) messages.push(brief);
      }
    }
    // 三道口（阶段门 / 六问门 / 状态机抛出的同一句话）合起来是一张完整的清单。
    expect(messages.length).toBeGreaterThan(9);
    for (const message of messages) expect(message).not.toContain('退回收集');
  });

  it('阶段门只说阶段：不拿「还差几条」当理由', () => {
    for (const state of STATES) {
      const stage = evaluateStageLock(state);
      if (stage === null) continue;
      expect(stage).not.toContain('还差');
      expect(stage).not.toContain('核心三问');
    }
  });

  it('六问门只说六问：不提阶段、不提新建一条', () => {
    const message = lockMessage(['context', 'problem', 'outcome']);
    expect(message).not.toContain('收集阶段');
    expect(message).not.toContain('新建');
    // 只承诺真能做的那一步：补完再回来点（立项与生成都要这三问，一句话点名两件事）。
    expect(message).toContain('补完才能立项');
    // 也不再写「评估要拿这三问立项」那种把两个动作混成一句话的措辞。
    expect(message).not.toContain('评估要拿这三问立项');
  });
});

describe('生成前那道门仍然在（但判据不是它）', () => {
  it('缺一条时生成也在点下去那一秒被拒，不烧一次模型调用', async () => {
    const requirementId = await seed(without('context'));
    const error = await caught(startGeneration(db, '吕品', {
      requirementId, stage: 'evaluate',
    }));
    expect(error.code).toBe('description_incomplete');
    expect(error.message).toContain('还差一条没填：谁在什么情况下用');
    const jobs = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from uemaster_jobs where requirement_id = ${requirementId}`);
    expect(Number(jobs.rows[0]!.n)).toBe(0);
  });

  it('三条齐 → 作业照旧落地（门不是「什么都不让做」）', async () => {
    const requirementId = await seed(FILLED);
    const { jobId } = await startGeneration(db, '吕品', {
      requirementId, stage: 'evaluate',
    });
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    await cancelJob(db, jobId);
  });
});
