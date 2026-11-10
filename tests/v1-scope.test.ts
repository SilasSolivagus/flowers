import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { getBoard } from '../src/core/read/board.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { EMPTY_SURFACES } from '../src/core/locate/copy.js';
import {
  assembleWalkmap, flowPrompt, fragmentsPrompt, knownForEvaluate, readFragments,
  type ComposeDeps, type FragmentDoc, type PageFragment, type RequirementRow,
} from '../src/core/uemaster/compose.js';
import { NO_OPEN, openRows, readOpen } from '../src/core/uemaster/annotations.js';
import {
  SEQ_INFERENCE_LABEL, SEQ_INFERENCE_NOTE, renderSequencePage, type SeqStep,
} from '../src/core/uemaster/sequence.js';
import {
  EVALUATE_READS_CODE_FLAG, REVIEW_MATERIALS_FLAG, V1_CLOSED_MARK,
  evaluateReadsCode, refsForV1, reviewMaterialsEnabled,
} from '../src/core/uemaster/features.js';
import type { KnownSurfaces } from '../src/core/locate/copy.js';

/**
 * v1 范围裁剪（2026-11-10）的四条承诺，逐条钉住。
 *
 * 这份用例的对象不是「代码写没写」，而是**四句会被读者当事实的话**：
 *
 * 1. 右栏的两组标注（待需求方确认 / 待研发确认）真的分开了——合并之后没人认领；
 * 2. 推出来的时序图**印着「推演」**——v1 不读代码，不标就是拿假时序图去评审；
 * 3. 评审 / 走查的入口关着——留着入口就是「点得到、做不出」；
 * 4. 非「收集」状态标着「v1 暂未开放」——不标就会有人以为功能坏了去查。
 *
 * 每一条的写法都刻意对着**会在实现里被改坏的那一行**：组标题的铺法、标签串、开关的
 * 短路、状态判断。改坏任何一条，这里就有一处变红（报告里那四条 mutation 就是它们）。
 */

// ─── 夹具 ────────────────────────────────────────────────────────────────────

const req = {
  id: 'r1', number: 42, title: '分享链接', type: 'feature', requester: '吕品',
  prd_url: null, context: null, problem: null, outcome: null, surfaces: null,
  edge_cases: null, out_of_scope: null, platforms: ['mobile'], priority: null,
} as unknown as RequirementRow;

const STEP: SeqStep = { from: '服务端', to: '服务端', what: '记一笔订单' };

/** 一份「两页 + 两个后端节点」的片段集：页面的与没有页面的都在里面。 */
function doc(open?: { req: string[][]; dev: string[][] }, withOpen = true): FragmentDoc {
  const page = '<div class="wt-screen"><div class="wt-body">寄养</div></div>';
  const nodes: PageFragment[] = [
    {
      id: 'A', title: '进入寄养频道', kind: 'page', frame: 'phone', html: page,
      anno: [['内容', '按距离列出可寄养门店']],
      ...(withOpen ? { open: readOpen(open ?? { req: [['失败怎么办', '加载失败停在哪一屏']], dev: [] }) } : {}),
    },
    { id: 'B', title: '服务端接单', kind: 'system', frame: 'phone', html: '', anno: [], steps: [STEP] },
    { id: 'C', title: '是否首次预约', kind: 'decision', frame: 'phone', html: '', anno: [], steps: [STEP] },
  ];
  return { nodes };
}

// ─── 1. 两栏标注 ────────────────────────────────────────────────────────────

describe('右栏的两组待确认', () => {
  it('某一组是空的：**不铺**那一组的标题（标题下有东西才铺）', () => {
    const rows = openRows(readOpen({
      req: [], dev: [['状态', '这一屏有加载中与空态两种，各显示什么']],
    }));
    expect(rows.map((row) => row[0])).toEqual(['待研发确认', '状态']);
    // 空的那一组连标题都不许出现：一个「待需求方确认」下面什么都没有，读者只会得出
    // 「需求方还没确认过」或「系统漏了」——两种都是假话。
    expect(rows.some((row) => row[0] === '待需求方确认')).toBe(false);
  });

  it('两组都有：需求方在前（它决定这件事还做不做），研发在后', () => {
    const rows = openRows(readOpen({
      req: [['验收口径', '这次算做完的标准是什么']],
      dev: [['跳转', '点提交之后去哪一屏']],
    }));
    expect(rows.map((row) => row[0])).toEqual([
      '待需求方确认', '验收口径', '待研发确认', '跳转',
    ]);
  });

  it('两组都空：一行都不铺（不是两行空标题）', () => {
    expect(openRows(NO_OPEN)).toEqual([]);
  });

  it('模型写别的组名也认：需求方 / 研发 / requester / rd', () => {
    const open = readOpen({
      需求方: [['边界', '最多几条']],
      rd: ['失败怎么提示'],
      // 表外的名字不收：那是它自己编了第三组。
      运营: [['不该收', '这一条会被丢掉']],
    });
    expect(open.req.map((row) => row[0])).toEqual(['边界']);
    expect(open.dev.map((row) => row[0])).toEqual(['待确认']);
    expect(open.req.length + open.dev.length).toBe(2);
  });

  it('片段里整份一条待确认都没有：退回，并说清「补什么」', () => {
    const text = JSON.stringify({
      nodes: [
        { id: 'A', kind: 'page', frame: 'phone', title: '进入寄养', html: '<div class="wt-screen">x</div>' },
        { id: 'B', kind: 'system', title: '接单', steps: [{ from: '服务端', to: '服务端', what: '记一笔' }] },
      ],
    });
    const read = readFragments(text, ['A', 'B'], { requireOpen: true });
    expect(read.ok).toBe(false);
    // 这句话得能照着改：说清两组各问什么，而不是「格式不对」。
    expect(read.ok === false && read.why).toContain('两组待确认一条都没有');
    expect(read.ok === false && read.why).toContain('待需求方确认');
    expect(read.ok === false && read.why).toContain('待研发确认');
  });

  it('片段带 open：收进节点，两组都在', () => {
    const text = JSON.stringify({
      nodes: [
        {
          id: 'A', kind: 'page', frame: 'phone', title: '进入寄养',
          html: '<div class="wt-screen">x</div>',
          open: { req: [['失败怎么办', '停在哪一屏']], dev: [['状态', '有哪几种']] },
        },
        { id: 'B', kind: 'system', title: '接单', steps: [{ from: '服务端', to: '服务端', what: '记一笔' }] },
      ],
    });
    const read = readFragments(text, ['A', 'B']);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.doc.nodes[0]!.open?.req.length).toBe(1);
    expect(read.doc.nodes[0]!.open?.dev.length).toBe(1);
  });

  it('拼装：右栏先事实标注、再两组问题，组标题各一条', () => {
    const assembly = assembleWalkmap(doc(), { title: 'PAN-42', svg: '<svg/>' });
    const anno = assembly.walkmap.nodes.A!.anno;
    expect(anno[0]![0]).toBe('内容');
    expect(anno[1]![0]).toBe('待需求方确认');
    expect(anno[2]![0]).toBe('失败怎么办');
    // dev 那一组是空的 → 整份材料里一条「待研发确认」都没有。
    expect(anno.some((row) => row[0] === '待研发确认')).toBe(false);
  });

  it('提示词要求两组，并点名各组该问什么（责任人不同这件事写在提示词里）', () => {
    const prompt = fragmentsPrompt(req, 'evaluate', [{ id: 'A', label: '进入寄养', kind: 'process' }]);
    expect(prompt).toContain('待需求方确认');
    expect(prompt).toContain('待研发确认');
    expect(prompt).toContain('失败怎么办');
    expect(prompt).toContain('这一页有哪些状态');
    expect(prompt).toContain('每个节点至少一条');
  });
});

// ─── 2. 时序图必须标明是推演 ────────────────────────────────────────────────

describe('推演的时序图', () => {
  it('每一张时序图都带标签与那句边界说明', () => {
    const html = renderSequencePage([STEP], '服务端接单');
    expect(html).toContain(SEQ_INFERENCE_LABEL);   // 逻辑时序（推演）
    expect(html).toContain(SEQ_INFERENCE_NOTE);    // 参与者与步骤按需求描述推的…
  });

  it('**每一个**没有页面的节点，中栏都带这个标签（不是只带一次）', () => {
    const assembly = assembleWalkmap(doc(), { title: 'PAN-42', svg: '<svg/>' });
    const seqPages = assembly.sequences.map((item) => item.page);
    expect(seqPages).toHaveLength(2);              // B 与 C 都是没有页面的节点
    for (const page of seqPages) {
      expect(assembly.fragments[page]).toContain(SEQ_INFERENCE_LABEL);
      expect(assembly.fragments[page]).toContain(SEQ_INFERENCE_NOTE);
    }
  });

  it('v1 不读代码：评估的图提示词不许出现「现有页面 / 代码索引」那种断言', () => {
    const prompt = flowPrompt(req, 'evaluate', EMPTY_SURFACES);
    expect(prompt).not.toContain('代码索引');
    expect(prompt).not.toContain('现有页面');
    expect(prompt).not.toContain('研发参考');
  });

  it('v1 不读代码：片段提示词也不许（正文规矩里那几句承诺已经摘掉）', () => {
    const prompt = fragmentsPrompt(req, 'evaluate', [{ id: 'A', label: '进入寄养', kind: 'process' }]);
    expect(prompt).not.toContain('代码索引');
    expect(prompt).not.toContain('研发参考');
    expect(prompt).not.toContain('代码坐标');
  });

  it('开关关着（v1 默认）时，评估连「现有页面清单」的读口都不碰', async () => {
    let called = 0;
    const deps: ComposeDeps = {
      complete: async () => { throw new Error('不该走到这里'); },
      render: async () => { throw new Error('不该走到这里'); },
      resolveConfig: async () => null,
      build: async () => { throw new Error('不该走到这里'); },
      loadSurfaces: async (): Promise<KnownSurfaces> => { called += 1; return EMPTY_SURFACES; },
    };
    const known = await knownForEvaluate(deps, false);
    expect(called).toBe(0);
    expect(known).toEqual(EMPTY_SURFACES);
    // 反过来：打开时它照样走那条路（能力没被删，只是没开）。
    await knownForEvaluate(deps, true);
    expect(called).toBe(1);
  });
});

// ─── 3. 评审 / 走查入口关闭 ─────────────────────────────────────────────────

describe('评审 / 走查入口的开关', () => {
  const refs = [
    { stage: 'evaluate', label: '评估材料' },
    { stage: 'review', label: '评审材料' },
    { stage: 'inspect', label: '走查材料' },
  ];

  it('默认关：参考段只剩评估材料一行（没有死按钮）', () => {
    expect(reviewMaterialsEnabled({})).toBe(false);
    expect(refsForV1(refs, false).map((ref) => ref.stage)).toEqual(['evaluate']);
  });

  it('打开时三行都回来（代码、接口、历史产物一个都没删）', () => {
    expect(refsForV1(refs, true).map((ref) => ref.stage))
      .toEqual(['evaluate', 'review', 'inspect']);
  });

  it('只有明确写「开」才算开：0 / 空 / 乱写都是关', () => {
    expect(reviewMaterialsEnabled({ [REVIEW_MATERIALS_FLAG]: '1' })).toBe(true);
    expect(reviewMaterialsEnabled({ [REVIEW_MATERIALS_FLAG]: 'true' })).toBe(true);
    expect(reviewMaterialsEnabled({ [REVIEW_MATERIALS_FLAG]: '0' })).toBe(false);
    expect(reviewMaterialsEnabled({ [REVIEW_MATERIALS_FLAG]: '' })).toBe(false);
    expect(reviewMaterialsEnabled({ [REVIEW_MATERIALS_FLAG]: 'yes-please' })).toBe(false);
    // 评估读代码那个开关同理，默认关。
    expect(evaluateReadsCode({})).toBe(false);
    expect(evaluateReadsCode({ [EVALUATE_READS_CODE_FLAG]: '1' })).toBe(true);
  });
});

// ─── 4. 非「收集」状态标「v1 暂未开放」 ────────────────────────────────────

describe('非收集状态的标记（对着真库）', () => {
  let people: Array<{ id: string; name: string }> = [];

  beforeEach(async () => {
    await resetDb();
    people = await seedPeople();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function stateOf(id: string): Promise<string> {
    const res = await db.execute<{ state: string }>(sql`select state from requirements where id = ${id}`);
    return res.rows[0]!.state;
  }

  it('收集里的卡不标；评估立项之后（待设计）标', async () => {
    const created = await createRequirement(db, '吕品', {
      title: 'S3 协议支持', type: 'feature', requester: '孙建宏',
    });
    const id = created.id as string;
    expect(await stateOf(id)).toBe('inbox');

    const before = await getBoard('吕品');
    const inboxCard = before.find((c) => c.state === 'inbox')!.cards.find((c) => c.id === id)!;
    // 收集这一列正是 v1 承诺的那一条链的起点，标上去就是自相矛盾。
    expect(inboxCard.v1Closed).toBe(false);

    await evaluate(db, '吕品', { requirementId: id });
    expect(await stateOf(id)).toBe('design');

    const after = await getBoard('吕品');
    const designCard = after.find((c) => c.state === 'design')!.cards.find((c) => c.id === id)!;
    // 照常显示、照常能点开，只是多一行字说明这一版没开放（owner 裁决 §三）。
    expect(designCard.v1Closed).toBe(true);
    expect(V1_CLOSED_MARK).toBe('v1 暂未开放');
  });
});
