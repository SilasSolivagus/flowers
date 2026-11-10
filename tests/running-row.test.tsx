import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { GeneratorView } from '../src/core/uemaster/candidates';
import { PHASE_LABEL, phaseLabelOf } from '../src/core/uemaster/phases.js';
import { RunningRow, runningRowOf } from '../app/components/RunningRow';
import { GenerateButton } from '../app/components/GenerateButton';

/**
 * 抽屉里「正在生成」那一行（2026-11-10）。
 *
 * 事故的形状：一次生成 2–5 分钟，而抽屉那一格只有两个字「生成中」——不随时间变、不说
 * 在做哪一步。两分钟之后读者唯一的判断是「卡死了」。
 *
 * 这一组钉住三件事：
 * 1. 在跑的时候那一行写着**哪一步**（中文，不是 `pages` 这种标识符）与**已用时**；
 * 2. 重试时多一句「第 2 次尝试」；第 1 次**不写**（那是噪音）；
 * 3. 作业结束（done / failed / 不见了）那一行**消失**——判据是 `runningRowOf` 返回
 *    null，而不是散在 JSX 里的三元。
 *
 * 为什么渲染 `RunningRow` / `GenerateButton` 而不是整张抽屉：抽屉里是 `next/link`，
 * 脱离 App Router 会直接抛（与 `tests/artifact-missing.test.tsx` 同一条理由）。
 */

// `GenerateButton` 顶层 import 了 server action（`'use server'` 模块，带 `next/cache`）
// 与 `useRouter`：用例进程里两者都起不来。这一组只看静态那一帧画了什么，不按按钮。
vi.mock('../app/actions', () => ({
  generateAction: vi.fn(async () => ({ ok: true, jobId: 'job-1' })),
  generationStatusAction: vi.fn(async () => null),
  attachAction: vi.fn(async () => ({ ok: true, url: '/uemaster/PAN-7/evaluate.html' })),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

/** 一个「配好了」的生成器视图：这一组不按按钮，只要它画出「生成」那一支。 */
const GENERATOR: GeneratorView = {
  state: 'ready', source: 'provider', command: null, provider: null, saved: null,
  candidates: [], known: [], options: [], defaultId: null, savedId: null, test: null,
} as unknown as GeneratorView;

/** 一份「正在跑」的作业视图：只要这四格，`runningRowOf` 不与别的字段发生关系。 */
const RUNNING = {
  status: 'running',
  phase: 'pages' as const,
  attempt: 1,
  startedAt: '2026-11-10T09:00:00.000Z',
};

function at(startedAt: string, ms: number): number {
  return new Date(startedAt).getTime() + ms;
}

describe('生成中那一行：步 + 秒表 + 第几次', () => {
  it('在跑 → 写着哪一步（中文）与 mm:ss', () => {
    const view = runningRowOf(RUNNING);
    expect(view).not.toBeNull();
    if (view === null) return;
    // 中文那一句来自 `phases.ts`（与右下角进度卡同一份表），不是标识符 `pages`。
    expect(view.phaseLabel).toBe(PHASE_LABEL.pages);
    expect(view.phaseLabel).toBe('正在生成页面片段');

    const html = renderToStaticMarkup(
      <RunningRow view={view} now={at(RUNNING.startedAt, 47_000)} />,
    );
    expect(html).toContain('正在生成页面片段');
    expect(html).toContain('00:47');
    // 第 1 次是常态：不写「第 1 次尝试」。
    expect(html).not.toContain('次尝试');
    // 秒数那一格是 `mm:ss` 的形状，不是一个数字（「47」读起来像还剩 47 秒）。
    expect(html).toMatch(/>\d{2}:\d{2}</);
  });

  it('第二轮尝试 → 多一句「第 2 次尝试」', () => {
    const view = runningRowOf({ ...RUNNING, attempt: 2, phase: 'build' });
    expect(view).not.toBeNull();
    if (view === null) return;
    const html = renderToStaticMarkup(
      <RunningRow view={view} now={at(RUNNING.startedAt, 61_000)} />,
    );
    expect(html).toContain('正在装配三栏');
    expect(html).toContain('01:01');
    expect(html).toContain('第 2 次尝试');
  });

  it('六档 phase 都有中文（没有一档会漏成 `locate` 这种串）', () => {
    for (const key of ['flow', 'pages', 'build', 'locate', 'verify', 'findings'] as const) {
      expect(phaseLabelOf(key)).toBe(PHASE_LABEL[key]);
      expect(phaseLabelOf(key)).toMatch(/^正在/);
    }
    // 一次都没问过模型、以及认不出的值：都给一句人话，不把原文漏到界面上。
    expect(phaseLabelOf(null)).toBe('正在读 PRD');
    expect(phaseLabelOf('unknown-phase')).toBe('正在读 PRD');
  });

  it('作业结束了那一行就消失：done / failed / 不见了都返回 null', () => {
    expect(runningRowOf({ ...RUNNING, status: 'done' })).toBeNull();
    expect(runningRowOf({ ...RUNNING, status: 'failed' })).toBeNull();
    expect(runningRowOf(null)).toBeNull();
  });
});

describe('抽屉那一格：跑的时候画那一行，停下来画回生成按钮', () => {
  it('有在跑的作业 → 抽屉里是「正在生成页面片段 · 00:00」，不是「生成中」两个字', () => {
    const html = renderToStaticMarkup(
      <GenerateButton
        requirementId="11111111-1111-4111-8111-111111111111"
        stage="evaluate"
        generation={{
          id: 'job-1',
          startedAt: new Date().toISOString(),
          phase: 'pages',
          attempt: 1,
        }}
        generator={GENERATOR}
        present={false}
        fresh={false}
        versions={0}
        needsDescription={null}
      />,
    );
    expect(html).toContain('正在生成页面片段');
    expect(html).toContain('00:00');
    // 生成按钮不在（那一格被这一行占着）：一个「生成」摆在一个正在跑的作业旁边，
    // 读者只会以为可以再点一次。
    expect(html).not.toContain('>生成<');
  });

  it('没有在跑的作业 → 那一行不出现，画的是「生成」按钮（材料那一行照旧由服务端给）', () => {
    const html = renderToStaticMarkup(
      <GenerateButton
        requirementId="11111111-1111-4111-8111-111111111111"
        stage="evaluate"
        generation={null}
        generator={GENERATOR}
        present={false}
        fresh={false}
        versions={0}
        needsDescription={null}
      />,
    );
    expect(html).not.toContain('正在');
    expect(html).toContain('生成');
  });
});
