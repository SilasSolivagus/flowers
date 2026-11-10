import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT } from './helpers/files.js';
import {
  FLOW_THEME_FILE, fwVar, renderFlowchart, styleVarsFromTheme,
} from '../src/core/uemaster/flow.js';
import { buildWalkmap, renderWalkthrough } from '../src/core/uemaster/walkmap.js';

/**
 * 2026-11-10：深色模式下流程图看不见。
 *
 * ── 坏在哪（两个原因叠在一起）
 *
 * 1. SVG 的 `stroke` / `fill` 是**写死的浅色 hex**（`_theme/default.style.json` 在排版
 *    时插进去的：`#CCD3DB`、`#F8F9FA`…），而画布底色跟着主题翻成 #141416；
 * 2. 模板的切主题 JS 无条件把 `#flow-svg-light` 藏起来、显示 `#flow-svg-dark`——
 *    而这一版 walkmap **没有**深色 SVG（`svg_dark`），于是浅色那份被藏起来、深色那份
 *    不存在 = 左栏一片空白。
 *
 * ── 改法的判据（这一组用例钉的就是这两条）
 *
 * - **颜色走变量**：排版出来的 SVG 里不许再有 `fill="#…"` / `stroke="#…"`，
 *   全部是 `var(--fw-…)`；而每个被用到的变量在模板的 `:root` 与 `[data-theme="dark"]`
 *   里**都有定义**，且深色值与浅色值不同（否则「切主题看不见」这件事会以另一种方式回来）。
 * - **一份 SVG 跟随主题**：模板的切主题 JS 只在**真有**深色那份时才切显隐。
 *
 * 为什么不用浏览器读 `getComputedStyle`：这一轮不许开浏览器（owner 自己点）。所以判据
 * 落在「产物里到底是什么颜色值」这一层——那正好是这次坏掉的东西；而**计算后颜色**这件事
 * 由 CSS 变量的语义保证（同一条变量在两套主题下各有一个值，浏览器没有别的解释方式）。
 */

const TEMPLATE = path.join(
  REPO_ROOT, 'vendor', 'uemaster', 'flow-walkthrough', 'templates', 'walkthrough.html',
);

/** 一份带判断菱形、后端节点、缺口标记与边的流程图。 */
const MERMAID = [
  'flowchart TD',
  '  A["提交申请"] --> B["校验字段"]',
  '  B -->|通过| C{"有权限？"}',
  '  C -->|是| D[["发通知"]]',
  '  C -->|否| E["拒绝并回执"]',
  '  class B p0',
].join('\n');

/**
 * 某个选择器定义的 `--fw-*`。
 *
 * 要扫**同一个选择器的所有块**，不是第一块：模板里 `:root` 出现三次（`--wt-*`、
 * 主题变量、`--fw-*`），取第一块会拿到一堆与流程图无关的东西——而这正是「用例看起来很
 * 严、其实什么都没检查」的那种写法（第一版就是这么写的：`--fw-edge-color` 找不到值）。
 */
function fwVarsIn(css: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g');
  for (const match of css.matchAll(block)) {
    for (const decl of (match[1] ?? '').matchAll(/(--fw-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      out[decl[1]!] = decl[2]!.trim();
    }
  }
  return out;
}

describe('SVG 的颜色走 CSS 变量', () => {
  it('主题文件里每个颜色键都变成 var(--fw-…)，非颜色键原样保留', () => {
    const vars = styleVarsFromTheme({
      bg: '#FFFFFF',
      edge_color: '#5E6776',
      sel_ring_fill: '#2448D01A',
      fill_added: 'rgba(245,165,36,.14)',
      font_family: 'PingFang SC, system-ui, sans-serif',
      fs_node: 13,
    });
    expect(vars.bg).toBe('var(--fw-bg)');
    expect(vars.edge_color).toBe('var(--fw-edge-color)');
    expect(vars.sel_ring_fill).toBe('var(--fw-sel-ring-fill)');
    // rgba 也是颜色：深色主题里 `--fw-fill-added` 就是一条 rgba。
    expect(vars.fill_added).toBe('var(--fw-fill-added)');
    // 版式不跟着主题变，也不许被这次改动顺手换掉。
    expect(vars.font_family).toBe('PingFang SC, system-ui, sans-serif');
    expect(fwVar('stroke_decision')).toBe('--fw-stroke-decision');
  });

  it('真排一张图：fill / stroke 里一个 hex 都没有，节点框、菱形、边、边标签、选中环全走变量', async () => {
    const result = await renderFlowchart(MERMAID);
    expect(result.ok).toBe(true);
    const svg = result.svg ?? '';

    // 1. 没有任何写死的颜色。
    expect(svg).not.toMatch(/(?:fill|stroke)="#[0-9a-fA-F]{3,8}"/);
    expect(svg).not.toMatch(/(?:fill|stroke)="rgba?\(/);

    // 2. 五类元素各自的变量都在（少一类就是「那一类在深色下还是瞎的」）。
    for (const name of [
      'fill-process', 'stroke-process', 'text-process', // 节点框
      'fill-decision', 'stroke-decision', 'text-decision', // 判断菱形
      'fill-backend', 'stroke-backend', 'text-backend', // 后端节点
      'edge-color', // 边（含箭头 marker）
      'label-color', // 边上的标签
      'sel-ring-stroke', 'sel-ring-fill', // 选中高亮
    ]) {
      expect(svg, `缺 --fw-${name}`).toContain(`var(--fw-${name})`);
    }
    // 缺口标记（`class B p0`）也走变量。
    expect(svg).toContain('var(--fw-fill-p0)');
    expect(svg).toContain('var(--fw-stroke-p0)');
  });

  it('浅色值就是主题文件原来那些 hex（修 bug 不顺手改浅色样子）', async () => {
    const theme = JSON.parse(await readFile(FLOW_THEME_FILE, 'utf8')) as Record<string, unknown>;
    const css = await readFile(TEMPLATE, 'utf8');
    const light = fwVarsIn(css, ':root');
    for (const key of ['stroke_process', 'fill_decision', 'edge_color', 'sel_ring_stroke']) {
      expect(light[fwVar(key)]).toBe(String(theme[key]));
    }
  });

  it('每个用到的变量在两套主题里都有定义，且深色 != 浅色', async () => {
    const svg = (await renderFlowchart(MERMAID)).svg ?? '';
    const used = new Set([...svg.matchAll(/var\((--fw-[a-z0-9-]+)\)/g)].map((m) => m[1]!));
    expect(used.size).toBeGreaterThan(10);

    const css = await readFile(TEMPLATE, 'utf8');
    const light = fwVarsIn(css, ':root');
    const dark = fwVarsIn(css, '[data-theme="dark"]');
    for (const name of used) {
      // `--fw-bg` 是 `var(--wt-white)`：它跟着主题那一条走，两段里都写同一句。
      expect(light[name] ?? name === '--fw-bg', `${name} 没有浅色值`).toBeTruthy();
      if (name === '--fw-bg') continue;
      expect(dark[name], `${name} 没有深色值`).toBeDefined();
      expect(dark[name], `${name} 的深色值与浅色值相同`).not.toBe(light[name]);
    }
  });

  it('切主题：只在真有两份 SVG 时才切显隐（没有深色那份不再把唯一一张藏起来）', async () => {
    const tpl = await readFile(TEMPLATE, 'utf8');
    // 本地改动是**追加的覆盖**（上游那三行一个字没动 —— 模板必须能剥成上游原样，
    // 见 tests/walkmap.test.ts 的字节比对），所以判据落在覆盖块里。
    const patchAt = tpl.indexOf('toggleTheme = function');
    expect(patchAt).toBeGreaterThan(0);
    const patch = tpl.slice(patchAt, tpl.indexOf('本地补丁结束（2026-11-10）', patchAt));
    // 关键结构：藏起浅色那份必须发生在 `if (d) {` 里面；没有 d 时显式保持可见。
    const guard = patch.indexOf('if (d) {');
    expect(guard).toBeGreaterThan(0);
    expect(patch.indexOf('l.style.display = toDark ? "none" : "block"')).toBeGreaterThan(guard);
    expect(patch).toContain('else if (l)');
    // 上游那一行原件仍然在（证明我们没改它，只是包了一层）。
    expect(tpl).toContain('if (l) l.style.display = toDark ? "none" : "block";');
    expect(tpl).toContain('if (d) d.style.display = toDark ? "block" : "none";');
  });
});

describe('真材料：一份走查 HTML 里的流程图与图例', () => {
  /** 拼一份最小 walkmap：一个节点、一页片段，SVG 用真排版出来的那张。 */
  async function buildHtml(): Promise<string> {
    const flow = await renderFlowchart(MERMAID);
    expect(flow.ok).toBe(true);
    const walkmap = buildWalkmap({
      title: '深色模式用例',
      svg: flow.svg ?? '',
      nodes: [{ id: 'A', title: '提交申请', kind: 'page', page: 'p1' }],
      pages: [{ id: 'p1', frame: 'phone', html: '<div class="wt-card">内容</div>' }],
    });
    const built = await renderWalkthrough(walkmap, {
      svg: flow.svg ?? '',
      fragments: { p1: '<div class="wt-card">内容</div>' },
    });
    expect(built.ok).toBe(true);
    return built.html ?? '';
  }

  it('产物自己定义了 --fw-* 的两套值（HTML 是单文件，变量必须内联）', async () => {
    const html = await buildHtml();
    expect(html).toContain('--fw-edge-color: #5E6776');
    expect(html).toContain('--fw-edge-color: #8B8B95');
    expect(html).toContain('[data-theme="dark"]');
    // SVG 走的是变量，不是 hex。
    expect(html).toContain('stroke="var(--fw-edge-color)"');
    expect(html).not.toMatch(/(?:fill|stroke)="#[0-9a-fA-F]{6}"/);
  });

  it('缺口标记与图例：SVG 里出现 p0，图例就出得来，而且小方块跟着主题换色', async () => {
    const html = await buildHtml();
    expect(html).toContain('var(--fw-stroke-p0)');
    expect(html).toContain('P0 缺口');
    // 图例方块用的是变量（深色下不再是原来那条浅色 hex）。
    expect(html).toContain('border-color:var(--fw-stroke-p0)');
  });
});
