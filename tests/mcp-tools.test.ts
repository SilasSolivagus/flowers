import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { reviewPass } from '../src/core/requirements/review.js';
import { schedule } from '../src/core/requirements/schedule.js';
import { startOfShanghaiDay, tick } from '../src/core/clock/tick.js';
import { saveSnapshot } from '../src/core/prd/snapshots.js';
import { runTool, toolByName, type ToolDef } from '../mcp/tools.js';
import { SERVICES } from '../mcp/services.js';
import type { Identity } from '../mcp/tokens.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { BRIEF } from './helpers/brief.js';
import { makeRelease, makeQueued } from './helpers/factory.js';
import { cleanArtifacts, writeArtifact } from './helpers/files.js';

/**
 * 工具这一层要证明的两件事：
 *
 * 1. **每个工具都调到对的service，并把 token 换来的成员当 actor 传进去。**
 *    这一层没有第二个校验层，也没有第二个 actor 来源——用例用 `SERVICES` 上的 spy
 *    断言「谁调的、传的是谁」，再回头读库确认 actor 真的落进了 `events.actor`。
 * 2. **非法状态不是工具自己判的。** 对一个「收集」的需求调排期，必须拿到服务层
 *    那句「不能从「收集」直接到「待排期」」——而且服务**确实被调用了**（spy 有记录）。
 *    如果哪天有人在这里加了一道预判，这条断言会立刻红：那正是「两份状态机」的开始。
 *
 * 读工具（list / show / prd / plan）也在这里：它们不改状态，但「读到的与页面读到的是
 * 同一份」同样值得钉住（同一个读模型，不是第二条 SQL）。
 */

const FEATURE_REVIEWER = '吕正豪';

beforeEach(async () => {
  await resetDb();
  await seedPeople();
  await cleanArtifacts();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await cleanArtifacts();
  await pool.end();
});

/** token 换来的身份。`tokenId` / `memberId` 的内容不影响工具，只影响日志。 */
function as(member = '吕品', scope: Identity['scope'] = 'write'): Identity {
  return { tokenId: 'token-1', memberId: 'member-1', member, scope };
}

async function call(
  name: string, args: unknown, who: Identity = as(),
): Promise<CallToolResult> {
  const def = toolByName(name);
  if (def === null) throw new Error(`没有这个工具：${name}`);
  return runTool(def, who, args);
}

function textOf(result: CallToolResult): string {
  return (result.content ?? []).map((block) => (block as { text?: string }).text ?? '').join('\n');
}

function jsonOf(result: CallToolResult): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

/** 造一条停在某个状态的需求（走真实服务，不手改状态）。 */
async function inInbox(title = 'S3 协议支持'): Promise<string> {
  const created = await createRequirement(db, '吕品', { ...BRIEF,
    title, type: 'feature', requester: '孙建宏',
  });
  return created.id;
}

async function inReview(): Promise<string> {
  const id = await inInbox();
  await evaluate(db, '吕品', { requirementId: id });
  await submitReview(db, '吕品', { requirementId: id, prdUrl: 'https://doc.example.com/prd' });
  return id;
}

async function inTest(): Promise<string> {
  const releaseId = await makeRelease('R-2026-12', '2026-12-01', '2026-12-04');
  const id = await inInbox();
  await evaluate(db, '吕品', { requirementId: id });
  await submitReview(db, '吕品', { requirementId: id, prdUrl: 'https://doc.example.com/prd' });
  await reviewPass(db, FEATURE_REVIEWER, { requirementId: id });
  await schedule(db, '吕品', {
    requirementId: id, releaseId, commitTestAt: '2026-12-01', commitDueAt: '2026-12-04',
  });
  // 一次 tick 只推一步（边的判定基于取出来的那一行），所以要走两次才到「测试中」：
  // 12-01 到开工日 → 开发中；12-03 过了提测日 → 测试中。
  await tick(db, startOfShanghaiDay('2026-12-01'));
  await tick(db, startOfShanghaiDay('2026-12-03'));
  return id;
}

async function stateOf(id: string): Promise<string> {
  const res = await db.execute<{ state: string }>(sql`select state from requirements where id = ${id}`);
  return res.rows[0]!.state;
}

describe('工具表', () => {
  it('十四个工具，读四个 / 写十个，名字不重复', () => {
    const names = ['requirement_list', 'requirement_show', 'requirement_prd', 'uemaster_plan',
      'requirement_create', 'uemaster_attach', 'requirement_submit_review',
      'requirement_review_pass', 'requirement_review_reject', 'requirement_schedule',
      'requirement_bounce', 'requirement_reject', 'requirement_shelve', 'requirement_restore'];
    for (const name of names) expect(toolByName(name)).not.toBeNull();

    const read = names.filter((name) => toolByName(name)!.scope === 'read');
    expect(read).toEqual([
      'requirement_list', 'requirement_show', 'requirement_prd', 'uemaster_plan',
    ]);
    expect(toolByName('requirement_create')!.scope).toBe('write');
    // 只有两级权限：任何工具的 scope 都落在 read / write 之内。
    expect(names.every((name) => ['read', 'write'].includes(toolByName(name)!.scope))).toBe(true);
    expect(toolByName('nope')).toBeNull();
  });

  it('每个工具的描述都写明了权限与合法状态（由声明算出，不是手写散文）', () => {
    const defs: ToolDef[] = ['requirement_list', 'requirement_schedule', 'requirement_restore']
      .map((name) => toolByName(name)!);
    expect(defs[0]!.description).toContain('权限：读。合法状态：任何状态都能调');
    // 排期只在「待排期」合法——中文名来自 STATE_LABEL。
    expect(defs[1]!.description).toContain('权限：写。合法状态：「待排期」');
    expect(defs[2]!.description).toContain('合法状态：「已搁置」');
  });
});

describe('读工具', () => {
  it('requirement_list：用看板读模型，默认只列自己的（mine）', async () => {
    const id = await inInbox();
    const board = vi.spyOn(SERVICES, 'getBoard');

    const got = await call('requirement_list', {});
    expect(board).toHaveBeenCalledWith('吕品');
    const parsed = jsonOf(got);
    expect(parsed.count).toBe(1);
    const rows = parsed.requirements as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ id, state: 'inbox', stateLabel: '收集' });

    // 过滤器：state 命中 / 不命中；owner 同理。
    expect(jsonOf(await call('requirement_list', { state: 'review' })).count).toBe(0);
    expect(jsonOf(await call('requirement_list', { state: 'inbox' })).count).toBe(1);
    // 越界的 limit 是一句中文（zod 默认的 'Number must be…' 不该漏给 agent）。
    const bad = await call('requirement_list', { limit: 0 });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toBe('limit 至少是 1');
  });

  it('requirement_show：与抽屉同一个读模型，身份也一起传进去（P2）', async () => {
    const id = await inReview();
    const detail = vi.spyOn(SERVICES, 'getRequirementDetail');

    const parsed = jsonOf(await call('requirement_show', { requirementId: id }));
    // 第二条参数是**这个 token 的成员行**：`actions` 因此是「状态 ∩ 他能做」，
    // 与抽屉、动作条同一个 `can()`。这里曾经只传 id，于是读侧报的是状态允许的全部动作。
    expect(detail).toHaveBeenCalledWith(id, expect.objectContaining({ name: '吕品' }));
    expect(parsed).toMatchObject({ id, state: 'review', stateLabel: '待评审' });
    // 吕品是负责人（PM）：待评审状态下他能做的是「搁置」，签字不归他。
    expect(parsed.actions).toEqual(['shelve']);
  });

  it('requirement_show：需求不存在是一句中文 isError', async () => {
    const got = await call('requirement_show', { requirementId: '00000000-0000-4000-8000-000000000000' });
    expect(got.isError).toBe(true);
    expect(textOf(got)).toBe('需求不存在');
  });

  it('requirement_prd：有快照就不读源文档，返回元信息 + 正文两段', async () => {
    const id = await inInbox();
    await saveSnapshot(db, '吕品', {
      requirementId: id, url: 'https://doc.example.com/prd', markdown: '# PRD\n\nS3 兼容',
    });
    const readPrd = vi.spyOn(SERVICES, 'readPrd');

    const got = await call('requirement_prd', { requirementId: id });
    const blocks = (got.content ?? []) as Array<{ text: string }>;
    expect(blocks).toHaveLength(2);
    expect(JSON.parse(blocks[0]!.text)).toMatchObject({ source: 'snapshot', chars: 12 });
    expect(blocks[1]!.text).toBe('# PRD\n\nS3 兼容');
    expect(readPrd).not.toHaveBeenCalled();
  });

  it('requirement_prd：没有快照时明说，并指向 requirement_prd_refresh（只读工具不拉取）', async () => {
    const id = await inInbox();
    const got = await call('requirement_prd', { requirementId: id });
    expect(got.isError).toBe(true);
    expect(textOf(got)).toContain('还没有 PRD 快照');
    expect(textOf(got)).toContain('requirement_prd_refresh');
  });

  it('requirement_prd_refresh：没有 PRD 链接时是一句点名它的中文（不发任何网络请求）', async () => {
    const id = await inInbox();
    await saveSnapshot(db, '吕品', {
      requirementId: id, url: 'https://doc.example.com/prd', markdown: '# PRD',
    });
    const readPrd = vi.spyOn(SERVICES, 'readPrd');

    const got = await call('requirement_prd_refresh', { requirementId: id });
    // 库里没有 prd_url，所以 readPrd 立刻回 missing_prd_url——但它确实被调到了，
    // 这就证明 refresh 没有偷偷用快照顶包。
    expect(readPrd).toHaveBeenCalledWith(db, '吕品', { requirementId: id });
    expect(got.isError).toBe(true);
  });

  it('uemaster_plan：两段文本，第二段是任务包正文', async () => {
    const id = await inInbox();
    const got = await call('uemaster_plan', { requirementId: id, stage: 'evaluate' });
    const blocks = (got.content ?? []) as Array<{ text: string }>;
    expect(blocks).toHaveLength(2);
    expect(JSON.parse(blocks[0]!.text)).toMatchObject({ id, state: 'inbox', type: 'feature' });
    expect(blocks[1]!.text).toContain('PAN-1');
  });
});

describe('读工具接权限（P2）：agent 不该被告知它的人做不到的动作', () => {
  it('同一份需求、两个 token：PM 只有搁置，条线负责人多出签字', async () => {
    // 一条「待评审」的需求，负责人是吕品（功能线 PM），派单派给吕正豪（功能线负责人）。
    // 同一个状态、同一条需求，两个 token 读到两份不同的 actions —— 这正是这一项要的。
    const id = await inReview();

    const asPm = jsonOf(await call('requirement_show', { requirementId: id }, as('吕品')));
    const asLead = jsonOf(await call('requirement_show', { requirementId: id }, as('吕正豪', 'read')));

    expect(asPm.actions).toEqual(['shelve']);
    expect(asLead.actions).toEqual(['reviewPass', 'reviewReject', 'shelve']);

    // permissions 与 actions 同源：PM 能改（他是负责人）但不能签。
    expect(asPm.permissions).toMatchObject({ edit: true, review: false });
    expect(asLead.permissions).toMatchObject({ edit: true, review: true });
  });

  it('PM 读别人的需求是只读：一个动作都没有', async () => {
    // 吕品的需求，李嘉来读。李嘉既不是负责人、也不是这条线的负责人：
    // 收集状态下「立项 / 提交评审 / 拒绝 / 搁置」全部要 edit，而 edit 对他不成立；
    // 「认领」也不行——这条需求已经有负责人。于是列表就是空的（不是报错、不是隐藏按钮）。
    const id = await inInbox();

    const parsed = jsonOf(await call('requirement_show', { requirementId: id }, as('李嘉')));

    expect(parsed.actions).toEqual([]);
    expect(parsed.permissions).toEqual({
      edit: false, review: false, reassignOwner: false, claim: false, manageMembers: false,
    });
  });

  it('token 指向的人被停用：动作清空，而不是退回「状态允许的全部」', async () => {
    // 停用的人手里那张 token 仍然验得过（session_epoch 与 token 无关），所以身份必须
    // 在读模型这一层失效。`null` 那条路给的是空动作 + 全 false 权限，与页面一致。
    const id = await inInbox();
    await db.execute(sql`update members set deactivated_at = now() where name = '吕品'`);

    const parsed = jsonOf(await call('requirement_show', { requirementId: id }, as('吕品')));

    expect(parsed.actions).toEqual([]);
    expect(parsed.permissions).toMatchObject({ edit: false, review: false });
  });
});

describe('写工具：每个都调到对的服务，actor 是 token 那个人', () => {
  it('requirement_create', async () => {
    const create = vi.spyOn(SERVICES, 'createRequirement');
    const got = await call('requirement_create', {
      title: 'S3 协议支持', type: 'feature', requester: '孙建宏',
    });
    const args = { title: 'S3 协议支持', type: 'feature', requester: '孙建宏' };
    expect(create).toHaveBeenCalledWith(db, '吕品', args);
    expect(jsonOf(got)).toMatchObject({ number: 1, state: 'inbox' });

    const events = await db.execute<{ actor: string }>(sql`select actor from events`);
    expect(events.rows.map((row) => row.actor)).toEqual(['吕品']);
  });

  it('uemaster_attach', async () => {
    const id = await inInbox();
    const url = '/uemaster/PAN-1/evaluate.html';
    await writeArtifact(url);
    const attach = vi.spyOn(SERVICES, 'attachArtifact');

    const got = await call('uemaster_attach', { requirementId: id, stage: 'evaluate', url });
    expect(attach).toHaveBeenCalledWith(db, '吕品', { requirementId: id, stage: 'evaluate', url });
    expect(jsonOf(got)).toEqual({ ok: true, url });
    // 评估材料是通行证：同一次 attach 把「收集」推进到「待设计」（领域层的事）。
    expect(await stateOf(id)).toBe('design');
  });

  it('requirement_submit_review', async () => {
    const id = await inInbox();
    const submit = vi.spyOn(SERVICES, 'submitReview');
    const got = await call('requirement_submit_review', {
      requirementId: id, prdUrl: 'https://doc.example.com/prd',
    });
    expect(submit).toHaveBeenCalledWith(db, '吕品', {
      requirementId: id, prdUrl: 'https://doc.example.com/prd',
    });
    expect(jsonOf(got)).toMatchObject({ state: 'review', skippedEvaluation: true });
  });

  it('requirement_review_pass：签字人是 token 那个人（对不上时服务层拒绝）', async () => {
    const id = await inReview();
    const pass = vi.spyOn(SERVICES, 'reviewPass');

    const wrong = await call('requirement_review_pass', { requirementId: id }, as('吕品'));
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toBe('签字人不是这条需求派单到的评审人');

    const ok = await call('requirement_review_pass', { requirementId: id }, as(FEATURE_REVIEWER));
    expect(pass).toHaveBeenCalledWith(db, FEATURE_REVIEWER, { requirementId: id });
    expect(jsonOf(ok)).toEqual({ state: 'queue' });
    expect(await stateOf(id)).toBe('queue');
  });

  it('requirement_review_reject', async () => {
    const id = await inReview();
    const reject = vi.spyOn(SERVICES, 'reviewReject');
    const got = await call('requirement_review_reject', {
      requirementId: id, reason: 'PRD 没写清楚',
    }, as(FEATURE_REVIEWER));
    expect(reject).toHaveBeenCalledWith(db, FEATURE_REVIEWER, {
      requirementId: id, reason: 'PRD 没写清楚',
    });
    expect(jsonOf(got)).toEqual({ state: 'design' });
  });

  it('requirement_schedule：版本 + 两个日期', async () => {
    const id = await makeQueued().then((r) => r.id);
    const releaseId = await makeRelease('R-2027-01', '2027-01-01', '2027-01-20');
    const scheduleSpy = vi.spyOn(SERVICES, 'schedule');

    const got = await call('requirement_schedule', {
      requirementId: id, releaseId, commitTestAt: '2027-01-10', commitDueAt: '2027-01-15',
    });
    expect(scheduleSpy).toHaveBeenCalledWith(db, '吕品', {
      requirementId: id, releaseId, commitTestAt: '2027-01-10', commitDueAt: '2027-01-15',
    });
    expect(jsonOf(got)).toEqual({ state: 'ready' });
  });

  it('requirement_bounce：原因 + 新的承诺完成日', async () => {
    const id = await inTest();
    const bounced = vi.spyOn(SERVICES, 'bounce');
    const newDue = '2027-03-20';
    const got = await call('requirement_bounce', {
      requirementId: id, reason: '测试没过', newCommitDueAt: newDue,
    });
    expect(bounced).toHaveBeenCalledWith(db, '吕品', {
      requirementId: id, reason: '测试没过', newCommitDueAt: newDue,
    });
    expect(jsonOf(got)).toEqual({ state: 'dev' });
  });

  it('requirement_reject / requirement_shelve / requirement_restore', async () => {
    const rejectId = await inInbox();
    const reject = vi.spyOn(SERVICES, 'rejectRequirement');
    expect(jsonOf(await call('requirement_reject', { requirementId: rejectId, reason: '不做' })))
      .toEqual({ state: 'rejected' });
    expect(reject).toHaveBeenCalledWith(db, '吕品', { requirementId: rejectId, reason: '不做' });

    const shelveId = await inInbox();
    const shelve = vi.spyOn(SERVICES, 'shelveRequirement');
    expect(jsonOf(await call('requirement_shelve', { requirementId: shelveId, reason: '先等等' })))
      .toEqual({ state: 'shelved' });
    expect(shelve).toHaveBeenCalledWith(db, '吕品', { requirementId: shelveId, reason: '先等等' });

    const restore = vi.spyOn(SERVICES, 'restoreRequirement');
    expect(jsonOf(await call('requirement_restore', { requirementId: shelveId })))
      .toEqual({ state: 'inbox' });
    expect(restore).toHaveBeenCalledWith(db, '吕品', { requirementId: shelveId });
  });
});

describe('非法状态：服务层自己说，工具不预判', () => {
  it('对「收集」的需求排期 → isError + 服务层那句中文，而且服务真的被调到了', async () => {
    const id = await inInbox();
    const releaseId = await makeRelease('R-2027-01', '2027-01-01', '2027-01-20');
    const scheduleSpy = vi.spyOn(SERVICES, 'schedule');

    const got = await call('requirement_schedule', {
      requirementId: id, releaseId, commitTestAt: '2027-01-10', commitDueAt: '2027-01-15',
    });
    expect(got.isError).toBe(true);
    expect(textOf(got)).toBe('不能从「收集」直接到「待开发」');
    // 关键的一行：工具**没有**在调服务之前拦一次。有预判的话这条会红。
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(await stateOf(id)).toBe('inbox');
  });

  it('入参形状不对 → 一句中文 isError，不查库', async () => {
    const detail = vi.spyOn(SERVICES, 'getRequirementDetail');
    const got = await call('requirement_show', { requirementId: 'PAN-7' });
    expect(got.isError).toBe(true);
    expect(textOf(got)).toBe('需求 ID 格式不正确');
    expect(detail).not.toHaveBeenCalled();

    const empty = await call('requirement_schedule', { requirementId: 'x' });
    expect(empty.isError).toBe(true);
  });
});

describe('scope：read token 不许写', () => {
  it('read token 调 requirement_schedule → isError + 中文，服务一次都没调', async () => {
    const id = await inInbox();
    const scheduleSpy = vi.spyOn(SERVICES, 'schedule');

    const got = await call('requirement_schedule', {
      requirementId: id,
      releaseId: '00000000-0000-4000-8000-000000000000',
      commitTestAt: '2027-01-10',
      commitDueAt: '2027-01-15',
    }, as('吕品', 'read'));

    expect(got.isError).toBe(true);
    expect(textOf(got)).toBe('这个 token 的权限是「读」，调用 requirement_schedule 需要「写」权限');
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it('read token 可以调读工具', async () => {
    const id = await inInbox();
    const got = await call('requirement_show', { requirementId: id }, as('吕品', 'read'));
    expect(got.isError).toBeUndefined();
  });
});
