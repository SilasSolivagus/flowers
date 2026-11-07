import { describe, expect, it } from 'vitest';

import { BANNER_CLASS, bannerHtml, injectBanner } from '../src/core/locate/banner.js';
import {
  ABSENT_HISTORY_HEADLINE, ABSENT_HISTORY_LINE, ABSENT_LINE, CONFIRM_WITH_DEV,
  LOW_CONFIDENCE_HEADLINE, NOT_FOUND_HEADLINE,
} from '../src/core/locate/copy.js';
import { renderLocate } from '../src/core/uemaster/inspect.js';
import type { LocateResult } from '../src/core/locate/types.js';

/**
 * 材料顶部的定位横幅（终审 Blocker 2）。
 *
 * 这一层钉两件事：
 * 1. **文字进的是产物**，不是提示词——横幅 HTML 里逐字带着 `copy.ts` 的输出；
 * 2. 插不进去时**抛**，不返回原样 HTML。悄悄跳过等于退回「只进提示词」的老毛病，
 *    而那种失败只有真人逐字读材料才会发现。
 */

const HTML = '<!doctype html><html><head><title>t</title></head><body class="x"><main>正文</main></body></html>';

/** 从产物里把横幅那段文字抠出来（去标签 → 一行一段）。 */
function bannerTextOf(html: string): string {
  const match = /<section class="locate-banner"[\s\S]*?<\/section>/.exec(html);
  if (match === null) throw new Error('产物里没有横幅');
  return match[0]
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

describe('横幅：由代码写、模型不参与', () => {
  it('插在 <body> 后面，位于全部正文之前', () => {
    const out = injectBanner(HTML, NOT_FOUND_HEADLINE);
    const at = out.indexOf(BANNER_CLASS);
    expect(at).toBeGreaterThan(out.indexOf('<body'));
    expect(at).toBeLessThan(out.indexOf('<main>'));
    // 别的都没动：横幅是**前插**，不是替换
    expect(out).toContain('<main>正文</main>');
  });

  it('三种情况逐字等于 copy.ts 的输出（不是我们自己拼的一句）', () => {
    const cases: LocateResult[] = [
      { kind: 'absent', why: '镜像 ssh 连接超时' },
      { kind: 'none' },
      { kind: 'candidates', confidence: 'low', items: [
        { path: 'src/pages/video/video.vue', reason: '出自 11-03「用户权益缩减」', source: 'history', score: 3 },
      ] },
    ];

    for (const result of cases) {
      const text = renderLocate(result, 'history');
      const got = bannerTextOf(injectBanner(HTML, text));
      expect(got).toBe(text);
    }

    // 逐字对到常量上（不经过 renderLocate 的自证）：absent 是「历史没读到」那一句。
    const absent = bannerTextOf(injectBanner(HTML, ABSENT_HISTORY_LINE('镜像 ssh 连接超时')));
    expect(absent.startsWith(ABSENT_HISTORY_HEADLINE)).toBe(true);
    expect(absent).toContain('镜像 ssh 连接超时');
    expect(absent).toContain(CONFIRM_WITH_DEV);

    const none = bannerTextOf(injectBanner(HTML, `${NOT_FOUND_HEADLINE}${CONFIRM_WITH_DEV}`));
    expect(none).toBe(`${NOT_FOUND_HEADLINE}${CONFIRM_WITH_DEV}`);

    // 「代码没读到」那一句不许出现在 `history` 这一半上——两句必须分得开。
    expect(absent).not.toContain('代码没读到');
  });

  it('候选清单在横幅里保留行结构（编号一行一条，不连成一句）', () => {
    const text = renderLocate({
      kind: 'candidates',
      confidence: 'low',
      items: [
        { path: 'src/a.vue', reason: '出自 11-03 那次合并', source: 'history', score: 2 },
        { path: 'src/b.vue', reason: '出自 10-28 那次合并', source: 'history', score: 1 },
      ],
    }, 'history');
    expect(text.startsWith(LOW_CONFIDENCE_HEADLINE)).toBe(true);

    const lines = bannerTextOf(injectBanner(HTML, text)).split('\n');
    expect(lines).toContain('1. `src/a.vue` ← 出自 11-03 那次合并');
    expect(lines).toContain('2. `src/b.vue` ← 出自 10-28 那次合并');
    expect(lines).toContain('以上是线索，不是结论。请与研发确认现在实际是怎么做的，确认后更新 PRD 文档，材料会标记为旧版并重新生成。');
  });

  it('原因是带尖括号的原始句子 → 转义，横幅不许把正文打断', () => {
    const out = injectBanner(HTML, ABSENT_LINE('mirror <unset> & broken'));
    expect(out).toContain('mirror &lt;unset&gt; &amp; broken');
    expect(out).not.toContain('<unset>');
    // 标签没有被提前闭合：横幅仍然是完整的一段
    expect(/<section class="locate-banner"[\s\S]*?<\/section>/.test(out)).toBe(true);
  });

  it('插不进去就抛：没有 <body> / 文字是空的', () => {
    expect(() => injectBanner('<html><main>x</main></html>', NOT_FOUND_HEADLINE))
      .toThrow('<body>');
    expect(() => injectBanner(HTML, '   ')).toThrow('定位横幅是空的');
  });
});
