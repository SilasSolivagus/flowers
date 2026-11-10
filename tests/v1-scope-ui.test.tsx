import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { BoardCard } from '../src/core/read/board.js';
import type { DetailRef } from '../src/core/read/detail.js';
import type { GeneratorView } from '../src/core/uemaster/candidates';
import { V1_CLOSED_MARK } from '../src/core/uemaster/features';
import { RefList, StateChips } from '../app/components/Drawer';
import { Card } from '../app/components/Card';

/**
 * v1 范围裁剪（2026-11-10）的**界面那一半**。
 *
 * 三件事只有在屏幕上才成立，所以对着渲染出来的 HTML 断言，而不是对着辅助函数的返回值：
 *
 * 1. 参考段关掉评审 / 走查之后，那两行**真的不在**（不是被 CSS 藏起来的死按钮）；
 * 2. 非「收集」状态标着「v1 暂未开放」，而「收集」**不标**——标错方向就是告诉人
 *    「v1 最重要的那条链也不能用」；
 * 3. 卡片上那一行只在非收集时出现。
 *
 * 为什么要 mock `../app/actions` 与 `next/navigation`：`GenerateButton` / `ClaimButton`
 * 从 server action 拿东西，`app/actions.ts` 是 `'use server'` 模块；`GenerateButton`
 * 还用 `useRouter()`。这一组盯的是「哪几行被渲染出来」，不是按下去之后发生什么。
 */
vi.mock('../app/actions', () => ({
  generateAction: vi.fn(async () => ({ ok: true, jobId: 'job-1' })),
  generationStatusAction: vi.fn(async () => null),
  attachAction: vi.fn(async () => ({ ok: true, url: '/uemaster/PAN-7/evaluate.html' })),
  claimAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const GENERATOR: GeneratorView = {
  state: 'none',
  label: '没有可用的生成器',
  hint: '去设置里配一个',
  candidates: [],
} as unknown as GeneratorView;

function ref(stage: DetailRef['stage'], label: string): DetailRef {
  return {
    stage,
    label,
    url: null,
    at: null,
    atLabel: null,
    present: false,
    filePresent: false,
    freshness: 'unknown',
    versions: 0,
    generation: null, needsDescription: null,
  };
}

const REFS = [
  ref('evaluate', '评估材料'),
  ref('review', '评审材料'),
  ref('inspect', '走查材料'),
];

describe('参考段：评审 / 走查入口关着', () => {
  it('关着（v1 默认）：那两行整行不渲染，只剩评估材料', () => {
    const html = renderToStaticMarkup(
      <RefList refs={REFS} id="id-1" number={7} generator={GENERATOR} canEdit reviewMaterials={false} />,
    );
    expect(html).toContain('评估材料');
    expect(html).not.toContain('评审材料');
    expect(html).not.toContain('走查材料');
  });

  it('打开时三行都在（代码与历史产物没被删）', () => {
    const html = renderToStaticMarkup(
      <RefList refs={REFS} id="id-1" number={7} generator={GENERATOR} canEdit reviewMaterials />,
    );
    expect(html).toContain('评估材料');
    expect(html).toContain('评审材料');
    expect(html).toContain('走查材料');
  });
});

describe('「v1 暂未开放」标记', () => {
  it('收集：不标（v1 承诺的正是这一条链）', () => {
    const html = renderToStaticMarkup(<StateChips state="inbox" stateLabel="收集" />);
    expect(html).toContain('收集');
    expect(html).not.toContain(V1_CLOSED_MARK);
  });

  it('非收集：标一行，且状态名还在（不是把状态藏起来）', () => {
    for (const [state, label] of [
      ['design', '待设计'], ['review', '待评审'], ['dev', '开发中'], ['live', '已上线'],
    ] as const) {
      const html = renderToStaticMarkup(<StateChips state={state} stateLabel={label} />);
      expect(html).toContain(label);
      expect(html).toContain(V1_CLOSED_MARK);
    }
  });

  it('看板卡：非收集的卡上有这一行，收集的卡上没有', () => {
    const base: BoardCard = {
      id: 'id-1', number: 7, title: 'S3 协议支持', owner: '吕品', waiting: '吕品 评估',
      waitingOn: 'person', late: false, days: 2, inspectAtLabel: null, missingDates: [],
      mine: false, claimable: false, v1Closed: true,
    };
    const closed = renderToStaticMarkup(<Card card={base} />);
    expect(closed).toContain(V1_CLOSED_MARK);
    const open = renderToStaticMarkup(<Card card={{ ...base, v1Closed: false }} />);
    expect(open).not.toContain(V1_CLOSED_MARK);
  });
});
