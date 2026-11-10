import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { GeneratorView } from '../src/core/uemaster/candidates';
import type { DetailRef } from '../src/core/read/detail';
import { GenerateButton } from '../app/components/GenerateButton';
import { RefList } from '../app/components/Drawer';

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
      state="inbox"
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

describe('六问没填那一格：按钮可点，点进编辑表单（2026-11-11 改）', () => {
  const MISSING = ['context', 'problem', 'outcome'] as const;

  it('不再摆红字：理由只在 title 里，屏幕上只有一个「生成」入口', () => {
    const html = render({ needsDescription: LOCK, missing: MISSING });
    // 「不要直接写字」：那句锁因不再作为可见文本出现。
    expect(html).not.toContain(`>${LOCK}<`);
    // 但它没有消失——悬停在按钮上仍然读得到为什么。
    expect(html).toContain('title="' + LOCK.replace(/"/g, '&quot;') + '"');
  });

  it('按钮是**链接**不是禁用的按钮：点下去就是编辑表单（?edit=1）', () => {
    const html = render({ needsDescription: LOCK, missing: MISSING });
    expect(html).toContain('href="/?open=11111111-1111-4111-8111-111111111111&amp;edit=1"');
    expect(html).not.toMatch(/<button[^>]*class="btn gen"[^>]*disabled/);
    expect(html).toContain('生成');
  });

  it('三问齐（missing 为空）→ 照旧一个能按的「生成」，没有提示', () => {
    const html = render({ needsDescription: null, missing: [] });
    expect(html).not.toContain('还差');
    expect(html).toContain('生成');
    // 这一支是 `<button>`（真提交），不是链接。
    expect(html).toMatch(/<button[^>]*class="btn gen"/);
  });
});

/**
 * v1 阶段门那一格（2026-11-10，与六问门共用同一格 `needsDescription`）。
 *
 * 形状一样、理由不一样，**出路**也不一样：六问能在收集里原地补（`?edit=1`），阶段不对
 * 不能——那句话给的出路是「在收集里新建一条，或先把它退回收集」，再挂一个编辑表单的
 * 链接就是指向一条做不成事的路。所以这一组盯的是「同一个禁用格 + 不同的出路」。
 */
const STAGE_LOCK = 'v1 只在收集阶段生成评估材料。这条需求现在在「待设计」'
  + '——想用这个能力，请把描述补在收集里新建一条，或先把它退回收集。';

describe('阶段门那一格：禁用 + 理由（补完也生成不了，所以不给编辑入口）', () => {
  it('按钮禁用、理由是那句原话、**没有**进编辑的链接', () => {
    const html = render({ state: 'design', needsDescription: STAGE_LOCK, missing: [] });
    expect(html).toContain(STAGE_LOCK);
    expect(html).toMatch(/<button[^>]*class="btn gen"[^>]*disabled/);
    expect(html).not.toContain('去补');
    expect(html).not.toContain('edit=1');
  });

  it('阶段门优先：即使六问也缺，待设计里点「生成」仍然是被拦住的（不骗人去补）', () => {
    const html = render({
      state: 'design', needsDescription: STAGE_LOCK, missing: ['context', 'problem', 'outcome'],
    });
    expect(html).toContain(STAGE_LOCK);
    expect(html).not.toContain('edit=1');
  });

  it('在跑的行优先：阶段变了也不会把「停止」换成一句理由', () => {
    const html = render({
      state: 'design',
      needsDescription: STAGE_LOCK,
      generation: {
        id: 'job-1', startedAt: new Date(Date.now() - 5000).toISOString(), phase: 'pages', attempt: 1,
      },
    });
    expect(html).toContain('停止');
    expect(html).not.toContain('v1 只在收集阶段');
  });
});

/**
 * 整条链：读模型那一句 → 抽屉那一行 → 按钮禁用。
 *
 * 单独渲染 `GenerateButton` 只能证明「给了理由会禁用」；这一条证明**理由真的从读模型
 * 走到了按钮上**（`RefList` 把 `state` 一路交给 `RefRow` → `GenerateButton`）。少了
 * 这一格，一张待设计的需求会在抽屉里画出一个能按的「生成」，按下去才撞服务那句拒绝
 * ——而「按钮还能点、点了才被拒」正是这一整段注释在防的观感。
 */
it('读模型的理由到位：RefList 在待设计上禁用「生成」，且不给「去补」', () => {
  const parked: DetailRef = {
    stage: 'evaluate', label: '评估材料', url: null, at: null, atLabel: null,
    present: false, filePresent: false, freshness: 'unknown', versions: 0, history: [],
    generation: null, needsDescription: STAGE_LOCK,
  };
  const html = renderToStaticMarkup(
    <RefList
      refs={[parked]} id="11111111-1111-4111-8111-111111111111" number={7}
      state="design" generator={GENERATOR} canEdit reviewMaterials={false}
    />,
  );
  expect(html).toContain(STAGE_LOCK);
  expect(html).toMatch(/<button[^>]*class="btn gen"[^>]*disabled/);
  expect(html).not.toContain('去补');
});
