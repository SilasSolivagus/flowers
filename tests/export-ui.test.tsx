import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { BoardCard, BoardColumn } from '../src/core/read/board.js';
import { ColumnHeader } from '../app/components/ColumnHeader';

/**
 * 「导出」出现在哪一格（P1b 的界面那一半）。
 *
 * `ExportQueueButton` 从 `../actions` 拿服务端动作，而 `app/actions.ts` 是
 * `'use server'` 模块（顶层 import 了 `next/cache`、`next/navigation`），在用例进程里
 * 起不来。这里把它换掉：这一组测的是**按钮出不出现**，不是「点了之后服务端做什么」
 * ——后者由 `export.test.tsx` 对着真库覆盖。
 *
 * 断言渲染出来的 HTML，而不是某个 `shouldShowExport()` 的布尔：这条用例要能替
 * 页面回答「待排期是空的时候屏幕上有没有这个入口」，对着一个辅助函数断言就只能
 * 证明辅助函数对，证明不了列头用了它。
 */
vi.mock('../app/actions', () => ({
  exportQueueAction: vi.fn(async () => ({ ok: true, url: 'https://x', rows: 1, docid: 'd' })),
}));

describe('列头里的「导出」', () => {
  it('待排期为空：没有「导出」（不是点了才报「没有可导出的行」）', () => {
    expect(html(column('queue', []))).not.toContain('导出');
  });

  it('待排期有卡片：有「导出」', () => {
    expect(html(column('queue', [card(1)]))).toContain('导出');
  });

  it('别的列即使有卡片也没有「导出」', () => {
    // 待评审那一列有同一条卡片，导出只属于待排期。
    expect(html(column('review', [card(1)]))).not.toContain('导出');
  });
});

// ─── 夹具 ────────────────────────────────────────────────────────────────────

function html(value: BoardColumn): string {
  return renderToStaticMarkup(<ColumnHeader column={value} />);
}

/**
 * 一张卡片。只有列头用得到的字段有意义，其余给稳定值——`ColumnHeader` 不该读它们，
 * 读了也不会在这里露出来（这一格渲染的不是卡片本身）。
 */
function card(number: number): BoardCard {
  return {
    id: `id-${number}`,
    number,
    title: `需求 ${number}`,
    owner: '吕品',
    waiting: '吕品 排期',
    waitingOn: 'person',
    late: false,
    days: 3,
    inspectAtLabel: null,
    missingDates: [],
    mine: false,
    claimable: false,
    // v1（2026-11-10）：非「收集」的卡要标「v1 暂未开放」。这一组用例看的是列头，
    // 卡片上那一行不参与判断；给 `true` 是因为这里造的是「待排期」那一列的卡。
    v1Closed: true,
  };
}

function column(state: BoardColumn['state'], cards: BoardCard[]): BoardColumn {
  return { state, label: state === 'queue' ? '待排期' : '待评审', cards };
}
