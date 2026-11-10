import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { GeneratorView } from '../src/core/uemaster/candidates';
import { GenerateButton } from '../app/components/GenerateButton';

/**
 * 抽屉那一格的两个新形状（2026-11-10）：
 * - **在跑** → 那一行旁边有「停止」（事故里最疼的是「no way to stop」）；
 * - **六问没填** → 按钮禁用 + 那句理由 + 一个进「编辑」的入口（不是点了才被拒）。
 *
 * 为什么只渲染静态一帧、不点按钮：`GenerateButton` 顶层 import 了 server action 与
 * `useRouter`，用例进程里两者都起不来（`tests/artifact-missing.test.tsx` 同一套 mock）。
 * 点击之后的行为由服务层用例钉（`tests/job-control.test.ts` / `tests/generate-gate.test.ts`）；
 * 这里钉的是**屏幕上有没有那个东西**——一个不该出现的按钮和一句说不出口的理由，
 * 都是服务层用例看不见的那种坏。
 */

vi.mock('../app/actions', () => ({
  generateAction: vi.fn(async () => ({ ok: true, jobId: 'job-1' })),
  generationStatusAction: vi.fn(async () => null),
  stopGenerationAction: vi.fn(async () => ({ ok: true, canceled: true })),
  retryGenerationAction: vi.fn(async () => ({ ok: true, jobId: 'job-2' })),
  attachAction: vi.fn(async () => ({ ok: true, url: '/uemaster/PAN-7/evaluate.html' })),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const GENERATOR: GeneratorView = {
  state: 'ready', source: 'provider', command: null, provider: null, saved: null,
  candidates: [], known: [], options: [], defaultId: null, savedId: null, test: null,
} as unknown as GeneratorView;

const LOCK = '还差三条没填：谁在什么情况下用、现在怎么做/哪不好、做成什么样算成功。'
  + '先补完再生成——否则材料只能靠编。';

function render(overrides: Partial<Parameters<typeof GenerateButton>[0]> = {}): string {
  return renderToStaticMarkup(
    <GenerateButton
      requirementId="11111111-1111-4111-8111-111111111111"
      stage="evaluate"
      generation={null}
      generator={GENERATOR}
      present={false}
      fresh={false}
      versions={0}
      needsDescription={null}
      {...overrides}
    />,
  );
}

describe('在跑那一格：停止', () => {
  it('有一行「正在生成」+ 一个「停止」按钮', () => {
    const html = render({
      generation: {
        id: 'job-1', startedAt: new Date(Date.now() - 5000).toISOString(), phase: 'pages', attempt: 2,
      },
    });
    expect(html).toContain('正在生成页面片段');
    expect(html).toContain('停止');
    // 停止是当时唯一能做的动作：这一帧不该同时出现「生成」按钮（那意味着两件事都能点）。
    expect(html).not.toContain('>生成<');
  });

  it('六问没填也照样能停（在跑的行优先）', () => {
    const html = render({
      generation: {
        id: 'job-1', startedAt: new Date(Date.now() - 5000).toISOString(), phase: 'pages', attempt: 1,
      },
      needsDescription: LOCK,
    });
    expect(html).toContain('停止');
    // 理由不在这一帧里：跑起来之后要说的是「停不停」，不是「描述缺什么」。
    expect(html).not.toContain('还差三条没填');
  });
});

describe('六问没填那一格：禁用 + 理由 + 出路', () => {
  it('按钮禁用、理由是那句原话、旁边有进编辑的链接', () => {
    const html = render({ needsDescription: LOCK });
    expect(html).toContain(LOCK);
    expect(html).toContain('去补');
    // 禁用是**真的**禁用（属性在按钮上），不是只靠 CSS 变灰。
    expect(html).toMatch(/<button[^>]*class="btn gen"[^>]*disabled/);
    expect(html).toContain('title="' + LOCK.replace(/"/g, '&quot;') + '"');
  });

  it('不拦着「交回材料」那条路：这一格只画自己（按钮禁用不等于整行消失）', () => {
    const html = render({ needsDescription: LOCK });
    // 阶段名 / 产物链接那些由旁边那一格负责；这里只该有理由 + 按钮，没有一句废话。
    expect(html).not.toContain('生成失败');
    expect(html).toContain('gen-off');
  });

  it('三问齐（null）→ 照旧一个能按的「生成」，没有任何提示', () => {
    const html = render({ needsDescription: null });
    expect(html).not.toContain('还差');
    expect(html).toContain('生成');
    expect(html).not.toMatch(/<button[^>]*class="btn gen"[^>]*disabled/);
  });
});
