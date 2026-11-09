import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterAll } from 'vitest';
import {
  MAX_STEPS, MAX_WHAT_CHARS, PARTICIPANTS, SEQ_WIDTH, canonicalParticipant, elideText,
  layoutSequence, missingStepsReason, normalizeSteps, renderSequencePage, sequenceSvg,
  stepLanguageProblem, textWidth, wrapText, type Participant, type SeqStep,
} from '../src/core/uemaster/sequence.js';
import { countHtmlBodyHits } from '../src/core/uemaster/body-language.js';
import {
  FLOW_DROP_RULE, assembleWalkmap, buildFlow, dropReportLine, droppedNotesIn, flowPrompt,
  fragmentsPrompt, fragmentsRepairPrompt, readFragments, repairPrompt,
  type ComposeDeps, type ComposeUsage, type PageFragment, type RequirementRow,
} from '../src/core/uemaster/compose.js';
import {
  readVerify, structurePrompt, structureRepairPrompt, verifyPrompt, verifyRepairPrompt,
} from '../src/core/uemaster/inspect.js';
import type { Trace } from '../src/core/uemaster/attempts.js';
import type { ProviderConfig } from '../src/core/uemaster/provider.js';
import {
  BUILD_SCRIPT, OUTPUT_FILE, WALKMAP_FILE, materializeWalkmap, validateWalkmap,
} from '../src/core/uemaster/walkmap.js';

/**
 * 后端节点的时序图（2026-11-09）。
 *
 * 这一份用例盯的是三件互不重叠的事：
 *
 * 1. **词表是封闭的、产品级的**：参与方只能是那七个角色，`what` 里不许出现方法名、
 *    表名、接口地址（owner 的硬规矩：时序图不能把代码词汇重新引进材料）；
 * 2. **排版是确定性的、能退化也能撑住**：同一份步骤两次排出同一份字节；2 参与方 ×
 *    1 条消息要看得懂；6 参与方 × 12 条消息要装进 690px；
 * 3. **拼装与校验**：没有页面的节点拿到 `backend-<id>` 伪页面（frame=sequence），
 *    而「既没有页面也没有步骤」的节点照旧被拒收——那正是 `PAN-815` 那次事故的守门人。
 */

const SVG_ONE = '<svg data-flowspec="1" xmlns="http://www.w3.org/2000/svg"></svg>';

/** 退款那一段：owner 在裁定里逐字给的正例。 */
const REFUND_STEPS: SeqStep[] = [
  { from: '用户', to: '页面', what: '点「申请退款」' },
  { from: '页面', to: '服务端', what: '提交退款申请' },
  { from: '服务端', to: '服务端', what: '按剩余权益计算可退金额' },
  { from: '服务端', to: '支付渠道', what: '发起退款' },
  { from: '支付渠道', to: '服务端', what: '退款成功' },
  { from: '服务端', to: '服务端', what: '回收权益、写退款记录' },
  { from: '服务端', to: '用户', what: '站内通知' },
];

const temps: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

function runPy(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('python3', args, { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        resolve({
          code: e === null ? 0 : (typeof e.code === 'number' ? e.code : null),
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      });
  });
}

// ─── 1. 词表：封闭、产品级 ──────────────────────────────────────────────────

describe('参与方词表', () => {
  it('七个角色，全是产品级说法；别名收下，编出来的名字一律不收', () => {
    expect(PARTICIPANTS).toEqual(['用户', '页面', '运营后台', '服务端', '支付渠道', '通知渠道', '第三方']);
    expect(canonicalParticipant('服务端')).toBe('服务端');
    // 别名：模型见过别的材料里这么写，认下来是对的直觉
    expect(canonicalParticipant('客户端')).toBe('页面');
    expect(canonicalParticipant('后端')).toBe('服务端');
    expect(canonicalParticipant('短信')).toBe('通知渠道');
    expect(canonicalParticipant(' 服务端：')).toBe('服务端');
    // 表外：代码类名、随手指派的角色、空串
    expect(canonicalParticipant('ShareController')).toBeNull();
    expect(canonicalParticipant('资金方')).toBeNull();
    expect(canonicalParticipant('  ')).toBeNull();
  });

  it('参与方不在词表里 → 报错点名第几步 + 可用词表', () => {
    const read = normalizeSteps([
      { from: '用户', to: '页面', what: '点「申请退款」' },
      { from: 'RefundService', to: '服务端', what: '计算可退金额' },
    ]);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.why).toContain('第 2 步');
    expect(read.why).toContain('RefundService');
    expect(read.why).toContain('用户、页面、运营后台、服务端');
  });
});

// ─── 2. 一步文案：产品语言，逐条机器拦 ──────────────────────────────────────

describe('一步的文案', () => {
  it('owner 的正例全部合格', () => {
    for (const step of REFUND_STEPS) expect(stepLanguageProblem(step.what)).toBeNull();
  });

  it('方法调用 / 类名 / 表名 / 接口地址 / SQL / 空括号 逐条拒，且说明是哪一种', () => {
    const cases: Array<[string, string]> = [
      ['调用 ShareController.refund()', '方法调用'],
      ['交给 RefundService 处理', '代码类名'],
      ['写 t_refund_order 一行', '表名或字段名'],
      ['POST /api/refund', '接口地址或 HTTP 动词'],
      ['select amount from t_order', 'SQL'],
      ['退款金额计算()', '空括号'],
      // 与正文同一档：实现名词也算（gap 档，无豁免）
      ['带上 focus 参数跳到记录页', '实现词'],
    ];
    for (const [what, noun] of cases) {
      const problem = stepLanguageProblem(what);
      expect(problem, what).not.toBeNull();
      expect(problem, what).toContain(noun);
    }
  });

  it('一步最多 28 个字：超了要拆成两步（不是让我们把字缩小）', () => {
    const long = '先按剩余权益算出可退金额再扣除已用掉的赠送额度最后把结果写给用户确认';
    expect([...long].length).toBeGreaterThan(MAX_WHAT_CHARS);
    expect(stepLanguageProblem(long)).toContain(`超过 ${MAX_WHAT_CHARS} 字`);
  });

  it('三种写法都收：对象、三元数组、中文键；空白与换行压平', () => {
    const read = normalizeSteps([
      { from: '用户', to: '页面', what: '点「申请退款」' },
      ['页面', '服务端', '提交退款申请'],
      { 谁: '服务端', 对谁: '服务端', 做什么: '按剩余权益\n  计算可退金额' },
    ]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.steps.map((s) => `${s.from}→${s.to}`)).toEqual(['用户→页面', '页面→服务端', '服务端→服务端']);
    expect(read.steps[2]!.what).toBe('按剩余权益 计算可退金额');
  });

  it(`步数上限 ${MAX_STEPS}：多一条就退，理由是「拆到相邻节点」`, () => {
    const many = Array.from({ length: MAX_STEPS + 1 }, () => ({ from: '服务端', to: '服务端', what: '记一笔' }));
    const read = normalizeSteps(many);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.why).toContain(`超过上限 ${MAX_STEPS} 条`);
  });
});

// ─── 3. 排版：确定性、退化、上限 ────────────────────────────────────────────

describe('确定性排版', () => {
  it('同一份步骤两次排出同一个字节', () => {
    expect(sequenceSvg(REFUND_STEPS)).toBe(sequenceSvg(REFUND_STEPS));
    expect(renderSequencePage(REFUND_STEPS, '提交退款申请')).toBe(renderSequencePage(REFUND_STEPS, '提交退款申请'));
  });

  it('退化：2 参与方 × 1 条消息仍然是一张能看的图', () => {
    const steps: SeqStep[] = [{ from: '页面', to: '服务端', what: '提交退款申请' }];
    const layout = layoutSequence(steps);
    expect(layout.actors).toEqual(['页面', '服务端']);
    expect(layout.width).toBe(SEQ_WIDTH);
    expect(layout.height).toBeLessThan(160);
    const svg = sequenceSvg(steps);
    // 两个参与方框、一条箭头、一个箭头头部、一条编号文案
    expect(svg.match(/class="seq-actor"/g)).toHaveLength(2);
    expect(svg.match(/class="seq-arrow"/g)).toHaveLength(1);
    expect(svg.match(/class="seq-head"/g)).toHaveLength(1);
    expect(svg).toContain('1. 提交退款申请');
  });

  it('自环（自己发给自己）画的是回勾，不是一条零长度的箭头', () => {
    const steps: SeqStep[] = [{ from: '服务端', to: '服务端', what: '回收权益' }];
    const layout = layoutSequence(steps);
    expect(layout.rows[0]!.self).toBe(true);
    const svg = sequenceSvg(steps);
    expect(svg).toContain('class="seq-arrow seq-loop"');
    expect(svg).toContain('H ');
    // 一个参与方也要画得出来（列居中）
    expect(layout.actors).toEqual(['服务端']);
    expect(Number.isFinite(layout.height)).toBe(true);
  });

  it('撑住：6 参与方 × 12 条消息仍然装在 690px 里，坐标不出框', () => {
    const names: Participant[] = ['用户', '页面', '运营后台', '服务端', '支付渠道', '第三方'];
    const steps: SeqStep[] = Array.from({ length: 12 }, (_, i) => ({
      from: names[i % 6]!,
      to: names[(i + 1) % 6]!,
      what: `第${i + 1}步处理`,
    }));
    const layout = layoutSequence(steps);
    expect(layout.actors).toHaveLength(6);
    expect(layout.rows).toHaveLength(12);
    expect(layout.width).toBe(SEQ_WIDTH);
    expect(layout.elided).toBe(0);           // 短文案：一个字都不用省
    const svg = sequenceSvg(steps);
    // 所有 x 坐标都落在画布内
    const xs = [...svg.matchAll(/ x="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(SEQ_WIDTH);
    expect(svg).not.toContain('NaN');
    expect(svg).toContain(`viewBox="0 0 ${SEQ_WIDTH} ${layout.height}"`);
    // 报告里要用的两个数：高度、被省略的步数
    expect(layout.height).toBeGreaterThan(300);
    expect(layout.height).toBeLessThan(900);
  });

  it('省字的边界是诚实的：一行的预算用完就折行，两行用完就省略号，并记账', () => {
    // 11px 字号下每个汉字正好 11px：给 55px 只放得下 5 个字，8 个字要两行
    expect(wrapText('一二三四五六七八', 55, 11)).toEqual(['一二三四五', '六七八']);
    const fit = elideText('一二三四五六七八九十', 33, 11, 2);
    expect(fit.lines).toHaveLength(2);
    expect(fit.elided).toBe(true);
    expect(fit.lines[1]!.endsWith('…')).toBe(true);
    // 文本量算：中文按 1em、半角按 0.56em
    expect(textWidth('服务端', 11)).toBe(33);
    expect(textWidth('ab', 10)).toBeCloseTo(11.2, 5);
  });

  it('图里没有技术词：一段退款时序过正文检查是 0 处命中', () => {
    const html = renderSequencePage(REFUND_STEPS, '提交退款申请');
    expect(countHtmlBodyHits(html)).toBe(0);
    for (const name of ['用户', '页面', '服务端', '支付渠道']) expect(html).toContain(name);
    expect(html).not.toContain('ShareController');
  });

  it('文案里的 & < > 要转义（图里的字来自模型）', () => {
    const svg = sequenceSvg([{ from: '服务端', to: '服务端', what: 'A&B <x>' }]);
    expect(svg).toContain('A&amp;B &lt;x&gt;');
    expect(svg).not.toContain('<x>');
  });
});

// ─── 4. 拼装：后端节点拿伪页面；两者都没有的节点照旧被拒 ────────────────────

/** PAN-815 的形状：六个节点全是服务端步骤，一个页面都没有。 */
function backendOnlyDoc(): PageFragment[] {
  return [
    { id: 'A', title: '接收回调', kind: 'system', frame: 'phone', html: '',
      anno: [['内容', '外部订单状态变化时通知我们']],
      steps: [
        { from: '第三方', to: '服务端', what: '推送订单状态变化' },
        { from: '服务端', to: '服务端', what: '校验这条通知是不是伪造的' },
      ] },
    { id: 'B', title: '是否已发放过', kind: 'decision', frame: 'phone', html: '',
      anno: [['判定依据', '这个订单有没有发过权益']],
      steps: [{ from: '服务端', to: '服务端', what: '按订单查有没有发过权益' }] },
    { id: 'C', title: '发放权益', kind: 'system', frame: 'phone', html: '',
      anno: [['内容', '按订单金额给用户加权益']],
      steps: [
        { from: '服务端', to: '服务端', what: '按订单金额算出该发多少' },
        { from: '服务端', to: '通知渠道', what: '告诉用户权益已到账' },
      ] },
  ];
}

describe('拼装：后端节点 → 时序伪页面', () => {
  it('一个页面都没有的流程，也能拼出合格的 walkmap（PAN-815 的那个形状）', () => {
    const assembly = assembleWalkmap({ nodes: backendOnlyDoc() }, { title: 'PAN-815「权益发放新增回调机制」走查材料', svg: SVG_ONE });

    expect(assembly.walkmap.pages.map((p) => p.id)).toEqual(['backend-A', 'backend-B', 'backend-C']);
    expect(assembly.walkmap.pages.map((p) => p.frame)).toEqual(['sequence', 'sequence', 'sequence']);
    expect(assembly.walkmap.pages.map((p) => p.kind)).toEqual(['sequence', 'sequence', 'sequence']);
    expect(assembly.sequences).toEqual([
      { node: 'A', page: 'backend-A', steps: 2 },
      { node: 'B', page: 'backend-B', steps: 1 },
      { node: 'C', page: 'backend-C', steps: 2 },
    ]);
    // 片段里躺的是排好的 SVG
    expect(assembly.fragments['backend-A']).toContain('<svg class="seq-svg"');
    expect(assembly.fragments['backend-A']).toContain('1. 推送订单状态变化');

    const report = validateWalkmap(assembly.walkmap, { svg: SVG_ONE, fragments: assembly.fragments });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('既没有页面也没有步骤的节点照旧被拒：一句话说清两条出路', () => {
    const nodes: PageFragment[] = [
      { id: 'A', title: '接收回调', kind: 'system', frame: 'phone', html: '', anno: [] },
    ];
    const assembly = assembleWalkmap({ nodes }, { title: 't', svg: SVG_ONE });
    const report = validateWalkmap(assembly.walkmap, { svg: SVG_ONE, fragments: assembly.fragments });
    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toContain('节点 A 既没有页面也没有后端流程');
    // 那一句旧话不再出现：它只说「页面「空」」，读的人不知道下一步
    expect(report.errors.join('\n')).not.toContain('页面「空」');
  });

  it('判为后端但没给步骤 → 不挂最近的页面，而是被拒（第三轮删掉的那条兜底）', () => {
    // 这一条盯的是**兜底本身**：场景里**有**页面节点可挂（A 和 C），所以「挂最近的页面」
    // 那条老逻辑一旦被放回来，B 会安安静静拿到 p-A 或 p-C、整份校验通过——读者于是看见
    // 一屏界面，把一步服务端的事读成「这一步在界面上」。判据必须让它红。
    const nodes: PageFragment[] = [
      { id: 'A', title: '退款入口', kind: 'page', frame: 'phone',
        html: '<div class="wt-screen"><div class="wt-body">可退 30 元</div></div>', anno: [] },
      { id: 'B', title: '计算可退金额', kind: 'system', frame: 'phone', html: '', anno: [] },
      { id: 'C', title: '退款结果', kind: 'page', frame: 'phone',
        html: '<div class="wt-screen"><div class="wt-toast">退款已提交</div></div>', anno: [] },
    ];
    const assembly = assembleWalkmap({ nodes }, { title: 't', svg: SVG_ONE });
    // 没有落点：不指向 p-A，也不指向 p-C
    expect(assembly.walkmap.nodes['B']!.page).toBe('');
    expect(assembly.sequences).toEqual([]);
    const report = validateWalkmap(assembly.walkmap, { svg: SVG_ONE, fragments: assembly.fragments });
    expect(report.ok).toBe(false);
    // 兜底那句话（事实层面）——与读回话那一层的「判为后端流程但没有给出步骤」不是一句
    expect(report.errors.join('\n')).toContain('节点 B 既没有页面也没有后端流程');
  });

  it('既没有页面也没有步骤的节点照旧被拒：一句话说清两条出路', () => {
    const nodes: PageFragment[] = [
      { id: 'A', title: '退款入口', kind: 'page', frame: 'phone',
        html: '<div class="wt-screen"><div class="wt-body">可退 30 元</div></div>', anno: [] },
      { id: 'B', title: '计算可退金额', kind: 'system', frame: 'phone', html: '',
        steps: [{ from: '页面', to: '服务端', what: '提交退款申请' }], anno: [] },
      { id: 'C', title: '退款结果', kind: 'page', frame: 'phone',
        html: '<div class="wt-screen"><div class="wt-toast">退款已提交</div></div>', anno: [] },
    ];
    const assembly = assembleWalkmap({ nodes }, { title: 't', svg: SVG_ONE });
    expect(assembly.walkmap.nodes['A']!.page).toBe('p-A');
    expect(assembly.walkmap.nodes['C']!.page).toBe('p-C');
    expect(assembly.walkmap.nodes['B']!.page).toBe('backend-B');
    expect(assembly.walkmap.pages.find((p) => p.id === 'backend-B')!.frame).toBe('sequence');
    // 状态组只由页面节点推出：时序图不参与成组
    expect(Object.keys(assembly.walkmap.state_groups)).toEqual([]);
  });

  it('时序片段是空的/没画出来 → 拒收（点开一片白比整份被拒更难发现）', () => {
    const nodes = backendOnlyDoc();
    const assembly = assembleWalkmap({ nodes }, { title: 't', svg: SVG_ONE });
    const broken = { ...assembly.fragments, 'backend-A': '<figure class="seq-figure"></figure>' };
    const report = validateWalkmap(assembly.walkmap, { svg: SVG_ONE, fragments: broken });
    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toContain('后端流程图没有画出来');
  });
});

// ─── 5. 读回话：steps 写错要能说清第几步 ────────────────────────────────────

describe('readFragments 收 steps', () => {
  const doc = (steps: unknown): string => JSON.stringify({
    nodes: [
      { id: 'A', kind: 'page', frame: 'phone', title: '退款入口',
        html: '<div class="wt-screen"><div class="wt-body">可退 30 元</div></div>', anno: [['内容', '可退金额']] },
      { id: 'B', kind: 'system', title: '发起退款', steps, anno: [['内容', '走支付渠道']] },
    ],
  });

  it('合格 → 收下 steps；服务端节点不带 html', () => {
    const read = readFragments(doc([{ from: '服务端', to: '支付渠道', what: '发起退款' }]), ['A', 'B']);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const b = read.doc.nodes.find((n) => n.id === 'B')!;
    expect(b.html).toBe('');
    expect(b.steps).toEqual([{ from: '服务端', to: '支付渠道', what: '发起退款' }]);
  });

  it('服务端节点没给 steps → 整份退回，话里点名节点与缺的东西（Gap 1）', () => {
    const read = readFragments(doc(undefined), ['A', 'B']);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    // 逐字：这是运维/模型看到的那一句（`missingStepsReason` 是唯一措辞来源）
    expect(read.why).toBe(
      '节点「B 发起退款」判为后端流程但没有给出步骤：请说明这一步在服务端做什么'
      + '（给 steps：「谁 → 谁 · 做什么」，1–12 步，每步 ≤28 字）',
    );
    // 与「既没有页面也没有后端流程」不是一句：那句说的是事实，这句说的是义务
    expect(read.why).not.toContain('既没有页面也没有后端流程');
  });

  it('steps 是空数组 / 写成 null 也算「没给」：同一句话，不静默放行', () => {
    for (const empty of [[], null]) {
      const read = readFragments(doc(empty), ['A', 'B']);
      expect(read.ok).toBe(false);
      if (read.ok) continue;
      expect(read.why).toContain('判为后端流程但没有给出步骤');
    }
  });

  it('steps 里写了代码类名 → 退回，理由指出是第几步的哪一种问题', () => {
    const read = readFragments(doc([{ from: '服务端', to: 'RefundService', what: '发起退款' }]), ['A', 'B']);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.why).toContain('节点 B');
    expect(read.why).toContain('第 1 步');
    expect(read.why).toContain('RefundService');
  });
});

// ─── 6. 提示词：词表与正例进了每一条路 ──────────────────────────────────────

const REQ: RequirementRow = {
  id: '00000000-0000-0000-0000-000000000000', number: 815,
  title: '【电商】权益发放新增回调机制', type: 'feature', requester: '吕品', prd_url: null,
  context: null, problem: null, outcome: null, surfaces: null, edge_cases: null, out_of_scope: null,
  platforms: ['backend'], priority: 'p0',
};

/** 两条提示词都吃这张清单：`fragmentsPrompt` 要 `FlowNode`（label），`verifyPrompt` 要
 *  `FlowSpec`（title）——两个字段名不同是既有形状，不是这次改出来的，所以各给一份。 */
const FLOW_NODES = [
  { id: 'A', label: '接收回调', kind: 'backend' as const },
  { id: 'B', label: '是否已发放过', kind: 'decision' as const },
];
const FLOWS = [
  { id: 'A', title: '接收回调', kind: 'system' as const },
  { id: 'B', title: '是否已发放过', kind: 'decision' as const },
];

describe('提示词：两种节点 + 封闭词表', () => {
  it('fragmentsPrompt 与 repair 都说清「后端节点交 steps」与七个参与方', () => {
    const prompts = [
      fragmentsPrompt(REQ, 'inspect', FLOW_NODES),
      fragmentsRepairPrompt(REQ, 'inspect', FLOW_NODES, '{"nodes":[]}', '节点 A 没有页面'),
      verifyPrompt(REQ, { url: 'u', markdown: '# PRD', hash: 'h', version: 'v1.0', chars: 5 }, FLOWS, [], []),
      verifyRepairPrompt(REQ, FLOWS, '{"nodes":[]}', '节点 A 没有页面'),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain('用户、页面、运营后台、服务端、支付渠道、通知渠道、第三方');
      expect(prompt).toContain('"from"');
      expect(prompt).toContain('"to"');
      expect(prompt).toContain('"what"');
      // 反例必须在：不给反例，模型会写方法名
      expect(prompt).toContain('ShareController.refund()');
      expect(prompt).toContain('t_refund_order');
    }
  });
});

describe('readVerify 收 steps（走查那条路，与 readFragments 同一句话）', () => {
  const answer = (steps: unknown): string => JSON.stringify({
    nodes: [
      { id: 'A', kind: 'page', frame: 'phone', title: '分享页搜索入口',
        html: '<div class="wt-screen"><div class="wt-body">文件列表</div></div>',
        anno: [['一致', '工具栏已有搜索图标']] },
      { id: 'B', kind: 'decision', title: '是否已输关键词', steps, anno: [['缺失', '没有这个判断']] },
    ],
  });

  it('后端节点没给 steps → 整份退回（同一句中文，措辞不漂）', () => {
    const read = readVerify(answer(undefined), ['A', 'B'], new Map());
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.why).toBe(missingStepsReason('B', '是否已输关键词'));
    expect(read.why).toContain('判为后端流程但没有给出步骤');
  });

  it('给了 steps → 收下，html 是空串', () => {
    const read = readVerify(
      answer([{ from: '页面', to: '服务端', what: '带上输入的关键词' }]),
      ['A', 'B'],
      new Map(),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.doc.nodes.find((n) => n.id === 'B')!.steps).toEqual([
      { from: '页面', to: '服务端', what: '带上输入的关键词' },
    ]);
  });
});

// ─── 6b. 不属于产品流程的步骤：提示词让模型删掉，删了要说一行（Gap 2） ───────

/** 四条「流程」提示词共用的夹具：PRD 基线、空仓、上一版的引擎报告。 */
const PRD = { url: 'u', markdown: '# PRD', hash: 'h', version: 'v1.0', chars: 5 };
const FLOW_CHECK = {
  ok: false, crossings: 1, overlaps: 0, textOverflow: 0, warnings: [], report: null,
};

describe('不属于产品流程的步骤（Gap 2）', () => {
  it('四条流程提示词都写着「删掉」与「已删去：…」，且给了三个反例', () => {
    const prompts = [
      flowPrompt(REQ, 'inspect'),
      repairPrompt(REQ, 'inspect', { mermaid: 'flowchart TD', check: FLOW_CHECK, shape: { nodes: [], edges: 0 } }),
      structurePrompt(REQ, PRD, [], []),
      structureRepairPrompt(REQ, PRD, [], [], '{"flows":[]}', ['节点 A 没有页面']),
    ];
    for (const prompt of prompts) {
      // 判据 + 那一行的形状：两句都在，模型才知道「删」与「说清楚」是一件事的两半
      expect(prompt).toContain('不属于产品流程');
      expect(prompt).toContain('已删去：');
      // 三个反例必须在：不给例子，模型会把线下动作硬画成一屏页面
      expect(prompt).toContain('线下谁去搬货');
      expect(prompt).toContain('第三方自己内部怎么处理');
    }
    // 「删掉」不是可选项的语气：它得说清「不删会变成假话」
    expect(flowPrompt(REQ, 'inspect')).toContain('读者会以为那一步真的这样发生');
  });

  it('「已删去：…」只认整行开头的那个形状；图里的同名词、句子中间的提及都不算', () => {
    const reply = [
      'flowchart TD',
      '  A["进入寄养频道"] --> B["已删去：这不是删改记录，只是节点文案"]',
      '  B --> C["提交订单"]',
      '我删掉了线下搬货那一步，所以这里不写。',
      '已删去：线下谁去搬货',
      '- 已去掉：第三方自己内部怎么处理',
      '',
    ].join('\n');
    expect(droppedNotesIn(reply)).toEqual(['线下谁去搬货', '第三方自己内部怎么处理']);
    // 空清单：一个字都没有（别把「今天没删」也写成一行）
    expect(droppedNotesIn('flowchart TD\n  A["x"] --> B["y"]')).toEqual([]);
  });

  it('删了要打一行日志（谁、删了几步、删了什么）；一步没删就不打', () => {
    const line = dropReportLine('PAN-815 inspect', ['线下谁去搬货']);
    expect(line).toContain('[flow-drop]');
    expect(line).toContain('PAN-815 inspect');
    expect(line).toContain('已删去 1 个');
    expect(line).toContain('线下谁去搬货');
  });

  it('buildFlow 把被接受那一版的删除清单交出来（说了就得有人读）', async () => {
    const cfg: ProviderConfig = { baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'm' };
    const trace: Trace = { jobId: null, model: 'm', write: async () => {} };
    const deps: ComposeDeps = {
      complete: async () => ({
        ok: true,
        text: [
          'flowchart TD',
          '  A["进入寄养频道"] --> B["选择宠物"]',
          '  B --> C["提交订单"]',
          '已删去：线下谁去搬货',
        ].join('\n'),
      }),
      render: async () => ({
        ok: true, crossings: 0, overlaps: 0, textOverflow: 0, warnings: [], report: null,
        svg: SVG_ONE,
      }),
      resolveConfig: async () => cfg,
      build: async () => ({ ok: false, errors: [], warnings: [] }),
    };
    const flow = await buildFlow(cfg, REQ, 'inspect', deps, { prompt: 0, completion: 0 }, trace);
    expect(flow.dropped).toEqual(['线下谁去搬货']);
    // 图本身没被那一行污染（它不在 mermaid 里）
    expect(flow.mermaid).not.toContain('已删去');
  });
});

// ─── 7. 真跑一遍 build.py：时序图真的进了 .frame-seq ────────────────────────

describe('build.py 的产物', () => {
  it('frame=sequence 的片段落在 .frame-seq 里，手机框里一条都不混', async () => {
    const assembly = assembleWalkmap({ nodes: backendOnlyDoc() }, { title: 'PAN-815 走查材料', svg: SVG_ONE });
    const dir = await tempDir('flowers-seq-');
    await materializeWalkmap(dir, assembly.walkmap, { svg: SVG_ONE, fragments: assembly.fragments });
    const run = await runPy([BUILD_SCRIPT, WALKMAP_FILE, '-o', OUTPUT_FILE], dir);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');

    const { readFile } = await import('node:fs/promises');
    const html = await readFile(path.join(dir, OUTPUT_FILE), 'utf8');
    // 三个时序页都进了第三格
    expect(html).toContain('id="backend-A"');
    expect(html).toContain('class="seq-svg"');
    const seqFrame = html.slice(html.indexOf('id="frame-seq"'));
    expect(seqFrame.slice(0, 4000)).toContain('id="backend-B"');
    // 手机框里没有时序图
    const phone = html.slice(html.indexOf('id="frame-phone"'), html.indexOf('id="frame-wide"'));
    expect(phone).not.toContain('seq-svg');
    // 前端按 frame 切换：PAGE_FRAME 里必须是 sequence
    expect(html).toContain('"backend-A": "sequence"');
  });
});
