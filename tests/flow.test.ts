import { afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FLOW_PYTHON, FLOW_SCRIPT, renderFlowchart, reportIn } from '../src/core/uemaster/flow.js';
import { REPO_ROOT } from './helpers/files.js';

/**
 * P2.9：vendored 的 flow-canvas 排版器 + `renderFlowchart` 的薄壳。
 *
 * 这一组用例跑**真的** Python（`/usr/bin/python3` + `vendor/uemaster/flow-canvas/`），
 * 不打桩引擎本身——要是引擎被搬坏了、主题路径断了、mermaid 方言变了，用例必须红。
 * 只有两处用了桩脚本，且都是为了证明**我们的**判断，引擎复现不了：
 * `tests/stubs/flow-sleep.py`（超时是不是真的杀了子进程）、
 * `tests/stubs/flow-warn.py`（warnings 非空但计数全 0 时算不算合格）。
 *
 * 为什么不 mock `execFile`：mock 之后测到的是 mock 的返回值，而这条链路上真正会坏的
 * 东西（Python 找不到、脚本路径算错、stdout 里多了一行中文）全在 mock 的另一侧。
 */

const STUBS = path.join(REPO_ROOT, 'tests', 'stubs');
const SLEEP = path.join(STUBS, 'flow-sleep.py');
const WARN = path.join(STUBS, 'flow-warn.py');

/** 一份 5 节点图：主干 A→B→C→E，B 一个右分支到 D。上游实测 crossings/overlaps/overflow 全 0。 */
const FIVE_NODES = `flowchart TD
  A["进入寄养频道"] --> B{"是否登录？"}
  B -->|是| C["选择宠物"]
  B -->|否| D["跳转登录"]
  C --> E["提交订单"]
`;

/** 一座孤岛：引擎认不出「单主干+右分支+回线」，直接非零退出。 */
const ISLAND = `flowchart TD
  A["开始"] --> B["结束"]
  X["孤岛一"] --> Y["孤岛二"]
`;

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** 直接在测试里跑一次引擎的 `--check`，拿它的原始 JSON 当"标准答案"。 */
async function checkDirectly(mermaid: string): Promise<Record<string, unknown>> {
  const dir = await mkdtemp(path.join(tmpdir(), 'flowers-flow-t-'));
  dirs.push(dir);
  const mmd = path.join(dir, 'input.mmd');
  await writeFile(mmd, mermaid, 'utf8');
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      FLOW_PYTHON,
      [FLOW_SCRIPT, mmd, '--check'],
      { cwd: dir, timeout: 20_000, encoding: 'utf8' },
      (err, out) => (err ? reject(err) : resolve(out)),
    );
  });
  const parsed = reportIn(stdout);
  if (!parsed || typeof parsed !== 'object') throw new Error(`引擎报告读不懂：${stdout.slice(0, 200)}`);
  return parsed as Record<string, unknown>;
}

describe('vendored flow-canvas', () => {
  it('脚本在仓库里、相对模块定位（与 cwd 无关）', async () => {
    expect(FLOW_SCRIPT.startsWith(path.join(REPO_ROOT, 'vendor', 'uemaster'))).toBe(true);
    await expect(access(FLOW_SCRIPT)).resolves.toBeUndefined();
  });
});

describe('renderFlowchart', () => {
  it('5 节点 flowchart：ok、三个计数为 0、SVG 里有 <svg 与节点文案', async () => {
    const r = await renderFlowchart(FIVE_NODES);

    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.crossings).toBe(0);
    expect(r.overlaps).toBe(0);
    expect(r.textOverflow).toBe(0);
    expect(r.warnings).toEqual([]);

    expect(typeof r.svg).toBe('string');
    const svg = r.svg as string;
    expect(svg).toContain('<svg');
    for (const label of ['进入寄养频道', '是否登录？', '选择宠物', '跳转登录', '提交订单']) {
      expect(svg).toContain(label);
    }
    // 契约要求的根元素（下游按 #flowsvg / data-node 抓节点）。
    expect(svg).toContain('id="flowsvg"');
    expect(svg).toContain('data-flowspec="1"');
  });

  it('计数是从引擎报告里读出来的，不是我们自己猜的', async () => {
    const truth = await checkDirectly(FIVE_NODES);
    const r = await renderFlowchart(FIVE_NODES);

    expect(r.ok).toBe(true);
    expect(truth['crossings']).toBe(0);
    expect(r.crossings).toBe(truth['crossings']);
    expect(r.overlaps).toBe(truth['overlaps']);
    expect(r.textOverflow).toBe(truth['textOverflow']);
    expect(r.warnings).toEqual(truth['warnings']);
    // 原样带回来的整份报告：调用方要用它喂回模型，键必须还在。
    const raw = r.report as Record<string, unknown>;
    expect(raw['nodes']).toBe(5);
    expect(raw['edges']).toBe(4);
    expect(raw['canvas']).toEqual(truth['canvas']);
    expect(raw['spine']).toEqual(truth['spine']);
  });

  it('孤岛/不合格形态：ok=false、有 error、不抛', async () => {
    const r = await renderFlowchart(ISLAND);

    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
    expect((r.error as string).length).toBeGreaterThan(0);
    // 引擎原文要说得出"为什么"：它拒的是形态，不是语法。
    expect(r.error).toContain('单主干');
    expect(r.svg).toBeUndefined();
    expect(r.crossings).toBe(0);
    expect(r.overlaps).toBe(0);
    expect(r.textOverflow).toBe(0);
  });

  it('超时：睡着的脚本被真的杀掉（夹具 script + 200ms），不是等它自己醒', async () => {
    const t0 = Date.now();
    const r = await renderFlowchart(FIVE_NODES, { scriptPath: SLEEP, timeoutMs: 200 });
    const spent = Date.now() - t0;

    expect(r.ok).toBe(false);
    expect(r.error).toContain('超时');
    expect(r.error).toContain('200ms');
    // 夹具要睡 30s。真的杀了它，整轮就不可能超过几秒。
    expect(spent).toBeLessThan(5_000);
    expect(r.svg).toBeUndefined();
  });

  it('warnings 非空但三个计数全 0 ⇒ 仍然 ok', async () => {
    const r = await renderFlowchart(FIVE_NODES, { scriptPath: WARN });

    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.svg).toContain('<svg');
  });

  it('引擎起不来（脚本不存在）也不抛，报成 error', async () => {
    const r = await renderFlowchart(FIVE_NODES, { scriptPath: path.join(STUBS, 'nope.py') });

    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.svg).toBeUndefined();
  });

  it('process.chdir("/tmp") 之后照样能用（模块相对定位）', async () => {
    const before = process.cwd();
    try {
      process.chdir('/tmp');
      // macOS 的 /tmp 是指向 /private/tmp 的符号链接，cwd 会报真实路径——只断言"确实换了"。
      expect(process.cwd()).toMatch(/\/tmp$/);
      expect(process.cwd()).not.toBe(before);
      const r = await renderFlowchart(FIVE_NODES);
      expect(r.ok).toBe(true);
      expect(r.svg).toContain('进入寄养频道');
    } finally {
      process.chdir(before);
    }
  });
});
