import { describe, expect, it } from 'vitest';
import {
  assembleWalkmap, fragmentsPrompt, stripPhoneChrome, stripReportLine, type FlowNode,
  type PageFragment, type RequirementRow,
} from '../src/core/uemaster/compose.js';
import { renderWalkthrough } from '../src/core/uemaster/walkmap.js';

/**
 * 手机 chrome 归模板（2026-11-10）：状态栏与导航栏不再由模型画。
 *
 * 这一组用例钉住四件事，每一件都有对应的「改坏就红」的变异：
 * 1. 片段自带 statusbar/nav 时被剥掉，产物里一页只有**一条**状态栏（两处都不剥 → 双份）；
 * 2. 首页没有回退箭头、非首页恰好一个（`back` 恒真 / 恒假 → 一头红）；
 * 3. 状态栏的 SVG 在**每一张**手机页面上（只在首页塞 → 其余页红）；
 * 4. 模板里那份定义取走之后不进产物（留着 → 产物里多一份 inert 的 statusbar 标记）。
 *
 * 为什么连真 `build.py` 一起跑：chrome 是**模板**给的，只测拼装等于测了一半；产物里
 * 到底有没有两条状态栏，只有走完 `build.py` 才回答得了。
 */

const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg" data-flowspec="1">'
  + '<g data-node="A"><rect x="0" y="0" width="100" height="40"/></g>'
  + '<g data-node="C"><rect x="0" y="60" width="100" height="40"/></g></svg>';

/** 旧契约下模型真的会交的那种片段：整屏 + 自己画的状态栏与导航栏。 */
function rawFragment(title: string, extra = ''): string {
  return '<div class="wt-screen"><div class="wt-statusbar"><span>9:41</span>'
    + '<span class="wt-sb-icons"></span></div><div class="wt-nav">'
    + '<span class="wt-nav-back">返回</span><span class="wt-nav-title">' + title + '</span></div>'
    + '<div class="wt-body"><div class="wt-card">' + title + '内容' + extra + '</div></div></div>';
}

function doc(): { nodes: PageFragment[] } {
  return {
    nodes: [
      { id: 'A', kind: 'page', frame: 'phone', title: '申请发票', html: rawFragment('申请发票'), anno: [['内容', '选订单']] },
      { id: 'C', kind: 'page', frame: 'phone', title: '填开票信息', html: rawFragment('填开票信息'), anno: [['内容', '填抬头']] },
    ],
  };
}

/** 把产物按 `<div class="page" id="…">` 切开：返回 id → 这一页的 HTML。 */
function pagesOf(html: string): Record<string, string> {
  const parts = html.split(/<div class="page" id="([^"]+)">/);
  const out: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 2) out[parts[i]!] = parts[i + 1] ?? '';
  return out;
}

const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

describe('stripPhoneChrome：片段自带外壳时只留内容区', () => {
  it('剥掉 statusbar / nav 并解开 wt-screen，剩下的字节一个字不改', () => {
    const raw = rawFragment('申请发票');
    const stripped = stripPhoneChrome(raw);
    expect(stripped.parts).toEqual(['wt-statusbar', 'wt-nav', 'wt-screen']);
    expect(stripped.html).toBe('<div class="wt-body"><div class="wt-card">申请发票内容</div></div>');
  });

  it('干净的内容区原样返回（不剥就不动）', () => {
    const clean = '<div class="wt-body"><div class="wt-card">选订单</div></div>';
    expect(stripPhoneChrome(clean)).toEqual({ html: clean, parts: [] });
  });

  it('一份片段里写两条状态栏也照剥（双份是最坏的呈现）', () => {
    const twice = '<div class="wt-body">x</div>'
      + '<div class="wt-statusbar"><span>9:41</span></div>'
      + '<div class="wt-statusbar"><span>9:41</span></div>';
    const stripped = stripPhoneChrome(twice);
    expect(stripped.parts).toContain('wt-statusbar');
    expect(stripped.html).not.toContain('wt-statusbar');
  });

  it('日志一行说清剥了哪几个节点、哪些包装类', () => {
    const asm = assembleWalkmap(doc(), { title: 't', svg: 'flow.svg', hasPrev: new Set(['C']) });
    const line = stripReportLine('PAN-47 evaluate', asm.stripped);
    expect(line).toContain('[phone-chrome] PAN-47 evaluate');
    expect(line).toContain('A（状态栏 + 导航栏 + 整屏容器）');
    expect(line).toContain('C（状态栏 + 导航栏 + 整屏容器）');
  });
});

describe('build.py 产物：模板画 chrome', () => {
  it('自带状态栏的片段 → 每张手机页面恰好一条状态栏、一条导航栏', async () => {
    const asm = assembleWalkmap(doc(), { title: 't', svg: 'flow.svg', hasPrev: new Set(['C']) });
    const built = await renderWalkthrough(asm.walkmap, { svg: SVG_TEXT, fragments: asm.fragments });
    expect(built.ok).toBe(true);
    const html = built.html ?? '';
    const pages = pagesOf(html);
    expect(Object.keys(pages).sort()).toEqual(['p-A', 'p-C']);
    for (const [pid, body] of Object.entries(pages)) {
      expect(count(body, 'class="wt-statusbar"'), `${pid} 的状态栏条数`).toBe(1);
      expect(count(body, 'class="wt-nav"'), `${pid} 的导航栏条数`).toBe(1);
      // 内容区还在（剥掉的只是外壳）
      expect(body).toContain('wt-body');
    }
    // 模板里那份定义是构建期的源，不该留在产物里再被数成第二条状态栏
    expect(html).not.toContain('wt-chrome-phone');
    expect(html).not.toContain('__WT_NAV_TITLE__');
  });

  it('状态栏 SVG 出现在每一张手机页面上（不是只在首页）', async () => {
    const asm = assembleWalkmap(doc(), { title: 't', svg: 'flow.svg', hasPrev: new Set(['C']) });
    const built = await renderWalkthrough(asm.walkmap, { svg: SVG_TEXT, fragments: asm.fragments });
    const pages = pagesOf(built.html ?? '');
    for (const [pid, body] of Object.entries(pages)) {
      expect(count(body, 'class="wt-sb-ico"'), `${pid} 的三个图标`).toBe(3);
      expect(body).toContain('<span class="wt-sb-time">9:41</span>');
    }
  });

  it('首页没有回退箭头，非首页恰好一个', async () => {
    const asm = assembleWalkmap(doc(), { title: 't', svg: 'flow.svg', hasPrev: new Set(['C']) });
    const built = await renderWalkthrough(asm.walkmap, { svg: SVG_TEXT, fragments: asm.fragments });
    const pages = pagesOf(built.html ?? '');
    expect(pages['p-A']).toContain('申请发票');  // 导航栏标题来自节点文案
    expect(count(pages['p-A'] ?? '', '<svg class="wt-nav-back"')).toBe(0);
    expect(count(pages['p-C'] ?? '', '<svg class="wt-nav-back"')).toBe(1);
  });

  it('没有图信息时按「除第一个节点外都有前驱」兜底', () => {
    const asm = assembleWalkmap(doc(), { title: 't', svg: 'flow.svg' });
    expect(asm.walkmap.nodes['A']?.back).toBeUndefined();
    expect(asm.walkmap.nodes['C']?.back).toBe(true);
  });
});

describe('提示词 2 的契约：模型不画外壳', () => {
  const req = { number: 47, title: '发票申请' } as unknown as RequirementRow;
  const nodes: FlowNode[] = [
    { id: 'A', label: '申请发票', kind: 'process' },
    { id: 'C', label: '填开票信息', kind: 'process', prev: ['A'] },
  ];
  const prompt = fragmentsPrompt(req, 'evaluate', nodes);

  it('明说状态栏与导航栏由模板画，并点名不许写那几个类', () => {
    expect(prompt).toContain('手机外壳（状态栏 + 导航栏）由模板画');
    expect(prompt).toContain('不要写 wt-screen、wt-statusbar、wt-sb-icons、wt-nav');
  });

  it('示例片段从 wt-body 起，示范里没有状态栏', () => {
    expect(prompt).toContain('"html": "<div class=\\"wt-body\\">');
    // 规则里会**点名**这些类（说「不要写」），但示例片段里不能真的出现它们
    expect(prompt).not.toContain('class=\\"wt-statusbar');
  });
});
