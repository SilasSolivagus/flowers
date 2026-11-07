import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { AppError } from '../src/core/errors.js';
import { createRequirement } from '../src/core/requirements/create.js';
import {
  deleteRequirement, updateRequirement,
} from '../src/core/requirements/manage.js';
import {
  FINGERPRINT_FIELDS, fingerprintOfRow, freshnessOf, requirementFingerprint,
} from '../src/core/requirements/fingerprint.js';
import { createRelease, deleteRelease, updateRelease } from '../src/core/releases/manage.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { reviewPass } from '../src/core/requirements/review.js';
import { schedule } from '../src/core/requirements/schedule.js';
import { getBoard } from '../src/core/read/board.js';
import { getRequirementDetail } from '../src/core/read/detail.js';
import { listReleases } from '../src/core/read/version.js';
import { attachArtifact } from '../src/core/uemaster/attach.js';
import { DESCRIPTIVE_FIELDS, hintFor } from '../src/core/requirements/fields.js';
import { overlapLine, previousLine } from '../src/core/releases/window.js';
import { elapsedLabel } from '../src/core/read/elapsed.js';
import { resetDb, seedPeople } from './helpers/db.js';

/**
 * 录入面的用例（P4-02）：指纹、新鲜度、改描述、软删除、版本重叠、表单校验。
 *
 * 全部对着真库跑，与 `read.test.ts` 同一条理由：这些行为一半在 SQL 里（`deleted_at
 * is null` 出现在六个读侧、`distinct on` 的取最新、join 上版本软删除），把 SQL 抽成
 * 纯函数再测，测到的是「我以为的库」。
 *
 * 没有网络：`attachArtifact` 只接受 http(s) 或站内路径，这里一律用 http(s) 链接
 * （不会去访问它，只落库）。
 */

let people: Array<{ id: string; name: string; role: string }> = [];

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

function memberId(name: string): string {
  const found = people.find((p) => p.name === name);
  if (!found) throw new Error(`种子里没有成员 ${name}`);
  return found.id;
}

/** 一条「六问都写全」的需求，供改描述 / 新鲜度那几组用例用。 */
async function makeDescribed(title = '分享页搜索') {
  // P4-04：建人即负责，所以负责人就是吕品；后面的改描述 / 删除也必须由他做
  // （PM 只能改自己负责的需求）。
  return createRequirement(db, '吕品', {
    title,
    type: 'feature',
    requester: '王妍',
    context: '运营在后台找分享链接',
    problem: '现在只能按编号找',
    outcome: '按标题能搜到',
    surfaces: '分享管理页',
    edgeCases: '搜不到时给空态',
    outOfScope: '不做全文检索',
  });
}

async function error(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (caught) {
    expect(caught).toBeInstanceOf(AppError);
    const e = caught as AppError;
    return { code: e.code, message: e.message };
  }
  throw new Error('期待一个 AppError，但它成功了');
}

// ─── 1. 指纹 ─────────────────────────────────────────────────────────────────

describe('requirementFingerprint', () => {
  const base = {
    title: '分享页搜索',
    context: '运营在后台找分享链接',
    problem: '现在只能按编号找',
    outcome: '按标题能搜到',
    surfaces: '分享管理页',
    edgeCases: '搜不到时给空态',
    outOfScope: '不做全文检索',
    prdUrl: 'https://doc.example.com/p/1',
    platforms: ['h5', 'mobile'],
    // P4-09：优先级也参与指纹（第十格）。
    priority: 'p1',
  };

  it('null 与空串哈希相同（库里两种「没写」是同一件事）', () => {
    const withNull = requirementFingerprint({ title: 't', context: null, problem: null });
    const withEmpty = requirementFingerprint({ title: 't', context: '', problem: '' });
    const withUndefined = requirementFingerprint({ title: 't' });
    expect(withNull).toBe(withEmpty);
    expect(withNull).toBe(withUndefined);
  });

  it('首尾空白与 CRLF 不改变指纹（同一份内容，同一份产物）', () => {
    const a = requirementFingerprint({ title: 't', context: '一句话' });
    const b = requirementFingerprint({ title: '  t  ', context: '\r\n一句话\r\n' });
    expect(a).toBe(b);
  });

  it('十个字段每一个都参与（P4-08 起多了 platforms，P4-09 起多了 priority）', () => {
    const original = requirementFingerprint(base);
    for (const field of FINGERPRINT_FIELDS) {
      const changed = field === 'platforms'
        ? requirementFingerprint({ ...base, platforms: [...base.platforms, 'pc'] })
        : requirementFingerprint({ ...base, [field]: `${base[field as keyof typeof base]}-改` });
      expect(changed, `改 ${field} 之后指纹必须变`).not.toBe(original);
    }
  });

  it('不参与指纹的字段改了也不变（描述之外的东西）', () => {
    const original = requirementFingerprint(base);
    // type / requester / number / state 根本不在入参里：传进去也不参与序列化。
    const withExtra = requirementFingerprint({
      ...base,
      ...({ type: 'commercial', requester: '别人', number: 99 } as object),
    });
    expect(withExtra).toBe(original);
  });

  it('稳定：与键的书写顺序无关（序列化是数组，不是对象）', () => {
    const reordered = {
      prdUrl: base.prdUrl,
      outOfScope: base.outOfScope,
      edgeCases: base.edgeCases,
      surfaces: base.surfaces,
      outcome: base.outcome,
      platforms: base.platforms,
      priority: base.priority,
      problem: base.problem,
      context: base.context,
      title: base.title,
    };
    expect(requirementFingerprint(reordered)).toBe(requirementFingerprint(base));
  });

  it('SQL 行与 JS 对象走同一个结果（snake_case 只翻译一次）', () => {
    expect(fingerprintOfRow({
      title: base.title,
      context: base.context,
      problem: base.problem,
      outcome: base.outcome,
      surfaces: base.surfaces,
      edge_cases: base.edgeCases,
      out_of_scope: base.outOfScope,
      prd_url: base.prdUrl,
      platforms: base.platforms,
      priority: base.priority,
    })).toBe(requirementFingerprint(base));
  });

  it('平台的顺序与重复不影响指纹；null 与空数组同值（未标注只有一种写法）', () => {
    expect(requirementFingerprint({ ...base, platforms: ['h5', 'android'] }))
      .toBe(requirementFingerprint({ ...base, platforms: ['android', 'H5', 'h5', 'android'] }));
    expect(requirementFingerprint({ title: 't', platforms: [] }))
      .toBe(requirementFingerprint({ title: 't', platforms: null }));
    // 词表外的键不算数：它不参与指纹（写入端也不落库）。
    expect(requirementFingerprint({ ...base, platforms: ['APP' as 'h5'] }))
      .toBe(requirementFingerprint({ ...base, platforms: [] }));
  });

  it('输出是 64 位小写十六进制', () => {
    expect(requirementFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── 2. 新鲜度（读模型三态） ──────────────────────────────────────────────────

describe('产物新鲜度', () => {
  async function describeWithArtifact(stage: 'evaluate' | 'review' | 'inspect', inputHash: string | null) {
    const req = await makeDescribed();
    const hash = requirementFingerprint({
      title: '分享页搜索',
      context: '运营在后台找分享链接',
      problem: '现在只能按编号找',
      outcome: '按标题能搜到',
      surfaces: '分享管理页',
      edgeCases: '搜不到时给空态',
      outOfScope: '不做全文检索',
    });
    await attachArtifact(db, '吕品', {
      requirementId: req.id,
      stage,
      url: `https://m.example.com/${stage}.html`,
      ...(inputHash === null ? {} : { inputHash: inputHash === '' ? hash : inputHash }),
    });
    return { id: req.id, hash };
  }

  it('fresh：存下来的指纹等于当前描述', async () => {
    const { id, hash } = await describeWithArtifact('evaluate', '');
    const detail = await getRequirementDetail(id);
    expect(detail!.refs.find((r) => r.stage === 'evaluate')!.freshness).toBe('fresh');
    expect(freshnessOf(hash, hash)).toBe('fresh');
  });

  it('stale：改一句描述，产物自己变旧（不需要任何额外写入）', async () => {
    const { id } = await describeWithArtifact('evaluate', '');
    await updateRequirement(db, '吕品', { requirementId: id, outcome: '按标题能搜到，且能按创建人筛' });
    const detail = await getRequirementDetail(id);
    expect(detail!.refs.find((r) => r.stage === 'evaluate')!.freshness).toBe('stale');
    // 另外两条没有产物的一行，不因为这条变旧而变成别的状态
    expect(detail!.refs.find((r) => r.stage === 'review')!.present).toBe(false);
  });

  it('数出版本数：同一阶段存两行就是两版（读侧仍只认最新一行）', async () => {
    const req = await makeDescribed();
    for (const url of ['https://m.example.com/a.html', 'https://m.example.com/b.html']) {
      await attachArtifact(db, '吕品', { requirementId: req.id, stage: 'evaluate', url });
    }
    const detail = await getRequirementDetail(req.id);
    const ref = detail!.refs.find((r) => r.stage === 'evaluate')!;
    expect(ref.versions).toBe(2);
    expect(ref.url).toBe('https://m.example.com/b.html');
    // 没有产物的那两行是 0，不是 1
    expect(detail!.refs.find((r) => r.stage === 'review')!.versions).toBe(0);
  });

  it('unknown：attach 时没给指纹 → 版本未知（不猜）', async () => {
    const { id } = await describeWithArtifact('evaluate', null);
    const detail = await getRequirementDetail(id);
    expect(detail!.refs.find((r) => r.stage === 'evaluate')!.freshness).toBe('unknown');
  });

  it('指纹形状不对时 attach 直接拒绝（不留一个永远不等于任何东西的值）', async () => {
    const req = await makeDescribed();
    const bad = await error(attachArtifact(db, '吕品', {
      requirementId: req.id, stage: 'evaluate', url: 'https://m.example.com/a.html', inputHash: 'not-a-hash',
    }));
    expect(bad.code).toBe('invalid_hash');
    expect(bad.message).toBe('内容指纹格式不正确');
  });
});

// ─── 3. 改描述 ───────────────────────────────────────────────────────────────

describe('updateRequirement', () => {
  it('只写变了的字段，事件里记下改了哪几问', async () => {
    const req = await makeDescribed();
    const result = await updateRequirement(db, '吕品', {
      requirementId: req.id,
      title: '分享页搜索',
      context: '运营在后台找分享链接',
      outcome: '按标题能搜到，且能按创建人筛',
    });
    expect(result.changed).toEqual(['outcome']);

    const events = await db.execute<{ payload: string }>(sql`
      select payload from events where requirement_id = ${req.id} and type = 'requirement.updated'`);
    expect(events.rows).toHaveLength(1);
    const payload = JSON.parse(events.rows[0]!.payload) as {
      fields: Array<{ field: string; label: string; from: string; to: string }>;
    };
    expect(payload.fields).toEqual([{
      field: 'outcome',
      label: '成功口径',
      from: '按标题能搜到',
      to: '按标题能搜到，且能按创建人筛',
    }]);
  });

  it('没有变化就没有事件（打开表单、原样保存不该污染时间轴）', async () => {
    const req = await makeDescribed();
    const result = await updateRequirement(db, '吕品', {
      requirementId: req.id,
      title: ' 分享页搜索 ',
      context: '运营在后台找分享链接',
    });
    expect(result.changed).toEqual([]);
    const events = await db.execute(sql`
      select 1 from events where requirement_id = ${req.id} and type = 'requirement.updated'`);
    expect(events.rows).toHaveLength(0);
  });

  it('type / requester / state 一律报 not_editable（不静默丢弃）', async () => {
    const req = await makeDescribed();
    for (const [key, label] of [['type', '类型'], ['requester', '提出人'], ['state', '状态']] as const) {
      const err = await error(updateRequirement(db, '吕品', {
        requirementId: req.id, title: '改个标题', [key]: key === 'type' ? 'commercial' : 'x',
      }));
      expect(err.code).toBe('not_editable');
      expect(err.message).toBe(`描述里不能改${label}：这里只能改标题和六个问题`);
    }
    // 一个字都没写进去
    const detail = await getRequirementDetail(req.id);
    expect(detail!.title).toBe('分享页搜索');
    expect(detail!.info.type).toBe('feature');
    expect(detail!.info.requester).toBe('王妍');
  });

  it('标题不能改成空', async () => {
    const req = await makeDescribed();
    const err = await error(updateRequirement(db, '吕品', { requirementId: req.id, title: '   ' }));
    expect(err.code).toBe('invalid');
    expect(err.message).toBe('标题不能为空');
  });

  it('软删除之后：读模型看不见、也改不动', async () => {
    const req = await makeDescribed();
    await deleteRequirement(db, '吕品', { requirementId: req.id });

    expect(await getRequirementDetail(req.id)).toBeNull();
    const board = await getBoard('吕品');
    expect(board.flatMap((c) => c.cards).map((c) => c.id)).not.toContain(req.id);

    const err = await error(updateRequirement(db, '吕品', { requirementId: req.id, title: '复活' }));
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('需求不存在');
  });

  it('重复删除报 not_found（第二次已经没有东西可删）', async () => {
    const req = await makeDescribed();
    await deleteRequirement(db, '吕品', { requirementId: req.id });
    const err = await error(deleteRequirement(db, '吕品', { requirementId: req.id }));
    expect(err.code).toBe('not_found');
  });

  it('软删除的需求不再被生成：attach 说「需求不存在」', async () => {
    const req = await makeDescribed();
    await deleteRequirement(db, '吕品', { requirementId: req.id });
    const err = await error(attachArtifact(db, '吕品', {
      requirementId: req.id, stage: 'evaluate', url: 'https://m.example.com/e.html',
    }));
    expect(err.code).toBe('not_found');
  });
});

// ─── 4. 新建需求（表单校验） ──────────────────────────────────────────────────

describe('createRequirement 的表单校验', () => {
  it('缺标题 / 类型 / 提出人 → 中文错误', async () => {
    expect((await error(createRequirement(db, '吕品', {}))).message).toBe('标题不能为空');
    expect((await error(createRequirement(db, '吕品', { title: 't' }))).message)
      .toBe('必须选择类型：商业或功能');
    expect((await error(createRequirement(db, '吕品', { title: 't', type: 'feature' }))).message)
      .toBe('提出人不能为空');
  });

  it('六问全空也能建（录入不被拦下），且库里存的是 null 不是空串', async () => {
    const req = await createRequirement(db, '吕品', {
      title: '只要标题', type: 'feature', requester: '王妍',
      context: '   ', problem: '', outcome: null,
    });
    const row = await db.execute<{
      context: string | null; problem: string | null; outcome: string | null;
      surfaces: string | null; edge_cases: string | null; out_of_scope: string | null;
    }>(sql`select context, problem, outcome, surfaces, edge_cases, out_of_scope
             from requirements where id = ${req.id}`);
    expect(row.rows[0]).toEqual({
      context: null, problem: null, outcome: null,
      surfaces: null, edge_cases: null, out_of_scope: null,
    });
  });

  it('六问写了的会落库，读模型原样给出', async () => {
    const req = await makeDescribed();
    const detail = await getRequirementDetail(req.id);
    expect(detail!.description).toEqual({
      context: '运营在后台找分享链接',
      problem: '现在只能按编号找',
      outcome: '按标题能搜到',
      surfaces: '分享管理页',
      edgeCases: '搜不到时给空态',
      outOfScope: '不做全文检索',
    });
  });
});

// ─── 5. 版本 ─────────────────────────────────────────────────────────────────

describe('版本 CRUD', () => {
  it('重叠只是警告，不是错误；警告点名版本与重叠的那一段', async () => {
    await createRelease(db, '吕品', {
      name: 'v1.4', windowStart: '2026-11-01', releaseDate: '2026-11-15',
    });
    const second = await createRelease(db, '吕品', {
      name: 'v1.5', windowStart: '2026-11-10', releaseDate: '2026-11-20',
    });
    expect(second.warning).toBe('与「v1.4」重叠：11-10 → 11-15');
    // 库里照存
    const rows = await db.execute<{ n: number }>(sql`select count(*)::int as n from releases`);
    expect(Number(rows.rows[0]!.n)).toBe(2);
  });

  it('与更晚的版本重叠也警告，且点名的是那一版（不是「上一个版本」）', async () => {
    await createRelease(db, '吕品', {
      name: '2026.11', windowStart: '2026-10-01', releaseDate: '2026-10-15',
    });
    // 更晚的那一版：发版日 12-15，在要建的那一版（发版 11-28）之后，
    // 所以它**不是**「上一个版本」，但它与 11-14 → 11-28 真的重叠着。
    await createRelease(db, '吕品', {
      name: '2026.12', windowStart: '2026-11-20', releaseDate: '2026-12-15',
    });
    const third = await createRelease(db, '吕品', {
      name: '2026.13', windowStart: '2026-11-14', releaseDate: '2026-11-28',
    });

    // 防撞车报的是相交的那一版……
    expect(third.warning).toBe('与「2026.12」重叠：11-20 → 11-28');
    // ……而「上一个版本」仍然是发版日最近的那一个：两个定义各管各的。
    expect(third.previous).toMatchObject({ name: '2026.11' });
    expect(third.overlapping).toMatchObject({ name: '2026.12' });
  });

  it('同时撞上两版时报发版日最近的那一条', async () => {
    await createRelease(db, '吕品', {
      name: 'A', windowStart: '2026-11-01', releaseDate: '2026-11-10',
    });
    await createRelease(db, '吕品', {
      name: 'B', windowStart: '2026-11-05', releaseDate: '2026-11-20',
    });
    // 11-04 → 11-18 同时与 A（11-01→11-10）和 B（11-05→11-20）相交；
    // 发版日离 11-18 最近的是 B（11-20，差 2 天；A 差 8 天）。
    const third = await createRelease(db, '吕品', {
      name: 'C', windowStart: '2026-11-04', releaseDate: '2026-11-18',
    });
    expect(third.warning).toBe('与「B」重叠：11-05 → 11-18');
  });

  it('首尾相接不算重叠', async () => {
    await createRelease(db, '吕品', {
      name: 'v1.4', windowStart: '2026-11-01', releaseDate: '2026-11-15',
    });
    const next = await createRelease(db, '吕品', {
      name: 'v1.5', windowStart: '2026-11-15', releaseDate: '2026-11-29',
    });
    expect(next.warning).toBeNull();
  });

  it('策略行要的「上一个版本」：按发版日取最近的那一版', async () => {
    await createRelease(db, '吕品', {
      name: 'v1.3', windowStart: '2026-10-18', releaseDate: '2026-11-01',
    });
    await createRelease(db, '吕品', {
      name: 'v1.4', windowStart: '2026-11-01', releaseDate: '2026-11-15',
    });
    const { previousRelease } = await import('../src/core/releases/manage.js');
    const previous = await previousRelease(db, '2026-11-29');
    expect(previous).toMatchObject({ name: 'v1.4' });
    expect(await previousRelease(db, '2026-10-01')).toBeNull();
  });

  it('校验：名称必填、两个日期必填、发版日不能早于开窗日', async () => {
    expect((await error(createRelease(db, '吕品', {
      name: '  ', windowStart: '2026-11-01', releaseDate: '2026-11-15',
    }))).message).toBe('版本名称不能为空');

    const missing = await error(createRelease(db, '吕品', { name: 'v1.4' }));
    expect(missing.code).toBe('missing_dates');
    expect(missing.message).toBe('版本要有开始日和发版日');

    expect((await error(createRelease(db, '吕品', {
      name: 'v1.4', windowStart: '2026-11-15', releaseDate: '2026-11-01',
    }))).message).toBe('发版日不能早于版本开始日');
  });

  it('改版本：保存目标与备注，并排除自己算重叠', async () => {
    const release = await createRelease(db, '吕品', {
      name: 'v1.4', windowStart: '2026-11-01', releaseDate: '2026-11-15',
    });
    const updated = await updateRelease(db, '吕品', {
      id: release.id, name: 'v1.4（改）', windowStart: '2026-11-02', releaseDate: '2026-11-16',
      goal: '让运营能自己搜到分享链接', note: '这版只做搜索',
    });
    expect(updated.warning).toBeNull();
    const row = await db.execute<{ name: string; goal: string | null; note: string | null }>(sql`
      select name, goal, note from releases where id = ${release.id}`);
    expect(row.rows[0]).toEqual({
      name: 'v1.4（改）', goal: '让运营能自己搜到分享链接', note: '这版只做搜索',
    });
  });

  it('软删除：从 listReleases 与看板的版本标签上一起消失', async () => {
    const release = await createRelease(db, '吕品', {
      name: 'v1.4', windowStart: '2026-11-01', releaseDate: '2026-11-15',
    });
    const req = await createRequirement(db, '吕品', {
      title: 'q', type: 'feature', requester: 'b',
    });
    await evaluate(db, '吕品', { requirementId: req.id });
    await submitReview(db, '吕品', { requirementId: req.id, prdUrl: 'https://x' });
    await reviewPass(db, '吕正豪', { requirementId: req.id });
    await schedule(db, '吕品', {
      requirementId: req.id,
      releaseId: release.id,
      commitTestAt: '2026-11-10',
      commitDueAt: '2026-11-14',
    });

    // 删之前：卡片上等的是版本给的开工日，抽屉里挂着版本名
    const before = (await getBoard('吕品')).flatMap((c) => c.cards).find((c) => c.id === req.id)!;
    expect(before.waiting).toMatch(/等开工日 11-01/);
    expect((await getRequirementDetail(req.id))!.commit.release?.name).toBe('v1.4');

    await deleteRelease(db, '吕品', { id: release.id });

    expect(await listReleases()).toHaveLength(0);
    const after = (await getBoard('吕品')).flatMap((c) => c.cards).find((c) => c.id === req.id)!;
    expect(after.waiting).toBe('缺开工日');
    const detail = await getRequirementDetail(req.id);
    expect(detail!.commit.release).toBeNull();
    // 排期字段本身仍在（历史事实没被改写）
    expect(detail!.commit.testAt).not.toBeNull();
  });
});

// ─── 6. 进度卡的数据源 ────────────────────────────────────────────────────────

describe('进度卡', () => {
  it('只给还在跑的作业，桌面阶段按中文映射，软删除的需求不出现', async () => {
    const { listRunningJobs } = await import('../src/core/read/progress.js');
    const req = await makeDescribed();
    await db.execute(sql`
      insert into uemaster_jobs (requirement_id, stage, status)
      values (${req.id}, 'evaluate', 'running')`);

    const jobs = await listRunningJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      requirementId: req.id, stage: 'evaluate', stageLabel: '评估中', phase: null, phaseLabel: '正在读 PRD',
    });
    expect(jobs[0]!.number).toBe(req.number);

    await deleteRequirement(db, '吕品', { requirementId: req.id });
    expect(await listRunningJobs()).toHaveLength(0);
  });

  it('有尝试记录之后显示那一段的中文名', async () => {
    const { listRunningJobs } = await import('../src/core/read/progress.js');
    const req = await makeDescribed();
    const job = await db.execute<{ id: string }>(sql`
      insert into uemaster_jobs (requirement_id, stage, status)
      values (${req.id}, 'review', 'running') returning id`);
    await db.execute(sql`
      insert into uemaster_job_attempts
        (job_id, attempt, phase, model, prompt_chars, output_chars, error, ms)
      values (${job.rows[0]!.id}, 1, 'findings', 'm', 10, 5, null, 100)`);

    const [item] = await listRunningJobs();
    expect(item).toMatchObject({ stageLabel: '评审中', phase: 'findings', phaseLabel: '正在写问题清单' });
  });
});

// ─── 7. 两句界面文案的来源（都是纯函数，钉住是为了不让措辞漂） ────────────────

describe('策略提示（六问空着时那一行）', () => {
  const byKey = new Map(DESCRIPTIVE_FIELDS.map((f) => [f.key, f]));

  it('三问有提示，另外三问没有', () => {
    expect(hintFor(byKey.get('surfaces')!, '', 'feature')).toBe('没有它，流程图会画出不存在的页面');
    expect(hintFor(byKey.get('outcome')!, '', 'feature')).toBe('没有它，边界和异常只能靠猜');
    expect(hintFor(byKey.get('context')!, '  ', 'feature')).toBe('没有它，模型编不出角色和入口');
    expect(hintFor(byKey.get('problem')!, '', 'feature')).toBeNull();
    expect(hintFor(byKey.get('edgeCases')!, '', 'feature')).toBeNull();
    expect(hintFor(byKey.get('outOfScope')!, '', 'feature')).toBeNull();
  });

  it('商业需求的成功口径换一句更狠的', () => {
    expect(hintFor(byKey.get('outcome')!, '', 'commercial')).toBe('商业需求没有成功口径，评审过不了');
  });

  it('写了内容就没有提示（提示不是常驻的说明文字）', () => {
    expect(hintFor(byKey.get('outcome')!, '按标题能搜到', 'commercial')).toBeNull();
  });
});

describe('版本时间窗的文案与判定（纯函数）', () => {
  it('策略行：有上一版点名它，没有就说这是第一个', () => {
    expect(previousLine(null)).toBe('还没有版本，这是第一个');
    expect(previousLine({ name: 'v1.4', windowStart: '2026-11-01', releaseDate: '2026-11-15' }))
      .toBe('上一个版本：v1.4 11-01 → 11-15');
  });

  it('重叠句与服务层返回的 warning 是同一个函数产出的那句话', () => {
    const previous = { name: 'v1.4', windowStart: '2026-11-01T00:00:00Z', releaseDate: '2026-11-15T00:00:00Z' };
    expect(overlapLine({ windowStart: '2026-11-10', releaseDate: '2026-11-20' }, previous))
      .toBe('与「v1.4」重叠：11-10 → 11-15');
    expect(overlapLine({ windowStart: '2026-11-15', releaseDate: '2026-11-29' }, previous)).toBeNull();
  });

  it('进度卡的秒数：mm:ss，超过一小时带小时', () => {
    expect(elapsedLabel(0)).toBe('00:00');
    expect(elapsedLabel(47_000)).toBe('00:47');
    expect(elapsedLabel(61_000)).toBe('01:01');
    expect(elapsedLabel(3_723_000)).toBe('1:02:03');
    expect(elapsedLabel(-5_000)).toBe('00:00');
  });
});
