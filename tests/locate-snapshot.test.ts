import { describe, expect, it } from 'vitest';

import { injectBanner } from '../src/core/locate/banner.js';
import {
  SNAPSHOT_LINE, SNAPSHOT_STALE_DAYS, STALE_LINE, ageInDays, snapshotLines,
  todayInShanghai, withSnapshots,
} from '../src/core/locate/copy.js';
import { renderLocate } from '../src/core/uemaster/inspect.js';
import type { LocateResult } from '../src/core/locate/types.js';

/**
 * 「代码快照」那几行（2026-11-08）。
 *
 * 钉的是**译文本身**：材料里那句「最可能的位置」不是结论，除非同时说清是对着哪一版
 * 代码说的。所以这里对完整字符串做 `toBe` / `toMatchInlineSnapshot`——改一个字就红。
 * 若有人只想「顺手润色一下措辞」，先让他读 `copy.ts` 里那段注释。
 */

const PC = { id: '123pan-pc', date: '2026-10-16T16:39:36+08:00' };

const HTML = '<!doctype html><html><body class="x"><main>正文</main></body></html>';

/** 把横幅里的文字抠出来（去标签 → 非空行）。 */
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

describe('代码快照：材料必须说清对着哪一版代码', () => {
  it('单行措辞逐字钉住', () => {
    expect(SNAPSHOT_LINE('123pan-uni-app', '2026-11-03T19:29:33+08:00'))
      .toBe('代码快照：123pan-uni-app @ 2026-11-03');
    expect(STALE_LINE(23)).toBe('代码快照较旧（23 天前）');
  });

  it('用了几个仓就写几行，旧的那个紧跟一句「较旧」', () => {
    const lines = snapshotLines(
      [
        { id: '123pan-pc', date: '2026-10-16T16:39:36+08:00' },
        { id: '123pan-uni-app', date: '2026-11-06T18:18:15+08:00' },
      ],
      '2026-11-08',
    );
    expect(lines).toMatchInlineSnapshot(`
      [
        "代码快照：123pan-pc @ 2026-10-16",
        "代码快照较旧（23 天前）",
        "代码快照：123pan-uni-app @ 2026-11-06",
      ]
    `);
    // 顺序就是传入顺序：「较旧」说的是它上面那一行（pc），不是 uni-app。
    expect(lines[1]).toBe(STALE_LINE(23));
  });

  it('14 天是门槛：14 天不说旧，15 天说', () => {
    expect(SNAPSHOT_STALE_DAYS).toBe(14);
    expect(snapshotLines([{ id: 'r', date: '2026-11-01T09:00:00+08:00' }], '2026-11-15'))
      .toEqual(['代码快照：r @ 2026-11-01']);
    expect(snapshotLines([{ id: 'r', date: '2026-11-01T09:00:00+08:00' }], '2026-11-16'))
      .toEqual(['代码快照：r @ 2026-11-01', '代码快照较旧（15 天前）']);
  });

  it('「今天」按 Asia/Shanghai 算：UTC 还是昨天时，不能把门槛往前挪一天', () => {
    // 2026-11-08T17:00Z = 北京时间 2026-11-09 01:00
    expect(todayInShanghai(new Date('2026-11-08T17:00:00Z'))).toBe('2026-11-09');
    expect(ageInDays('2026-11-01T23:59:00+08:00', '2026-11-09')).toBe(8);
  });

  it('日期不可解析时不编一个日期（写「日期未知」，也不判旧）', () => {
    expect(SNAPSHOT_LINE('r', '')).toBe('代码快照：r @ 日期未知');
    expect(snapshotLines([{ id: 'r', date: 'not-a-date' }], '2026-11-08'))
      .toEqual(['代码快照：r @ 日期未知']);
    expect(ageInDays('', '2026-11-08')).toBeNull();
  });

  it('候选与「没读到」都带快照行；没有仓时一行都不加', () => {
    const candidates: LocateResult = {
      kind: 'candidates', confidence: 'low',
      items: [{ path: 'src/pages/video/video.vue', reason: '路由 /video 的页面', source: 'structure', score: 9 }],
    };
    const absent: LocateResult = { kind: 'absent', why: '镜像 ssh 连接超时' };
    const uni = { id: '123pan-uni-app', date: '2026-11-03T19:29:33+08:00' };

    const candidateText = withSnapshots(renderLocate(candidates), [PC, uni], '2026-11-08');
    expect(candidateText).toContain('代码快照：123pan-uni-app @ 2026-11-03');
    expect(candidateText).toContain('代码快照：123pan-pc @ 2026-10-16');

    // 两种 absent 都要带：代码没读到的（评审那条路）与「代码读到了、历史没读到」的（走查）。
    for (const text of [
      withSnapshots(renderLocate(absent), [uni], '2026-11-08'),
      withSnapshots(renderLocate(absent, 'history'), [uni], '2026-11-08'),
    ]) {
      expect(text.split('\n').at(-1)).toBe('代码快照：123pan-uni-app @ 2026-11-03');
    }
    expect(withSnapshots(renderLocate(absent), [uni], '2026-11-08')).toContain('代码没读到');

    // 代码根本没读到（没有仓）：只留结论，不写快照。
    expect(withSnapshots(renderLocate(absent), [], '2026-11-08')).toBe(renderLocate(absent));
    expect(snapshotLines([], '2026-11-08')).toEqual([]);
  });

  it('整段横幅逐字快照：改一个字符就红', () => {
    const text = withSnapshots(
      renderLocate({
        kind: 'candidates', confidence: 'low',
        items: [{ path: 'src/pages/search/search.vue', reason: '路由 /search 的页面', source: 'structure', score: 7 }],
      }),
      [{ id: '123pan-uni-app', date: '2026-11-06T18:18:15+08:00' }],
      '2026-11-08',
    );
    expect(text).toMatchInlineSnapshot(`
      "最可能的位置（待研发确认）：
      1. \`src/pages/search/search.vue\` ← 路由 /search 的页面
      以上是线索，不是结论。请与研发确认现在实际是怎么做的，确认后更新 PRD 文档，材料会标记为旧版并重新生成。
      代码快照：123pan-uni-app @ 2026-11-06"
    `);
    // 同一段文字原样进产物（横幅由代码写死，模型不参与）。
    expect(bannerTextOf(injectBanner(HTML, text))).toBe(text);
  });
});
