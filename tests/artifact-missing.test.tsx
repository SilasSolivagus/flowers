import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { DetailRef } from '../src/core/read/detail.js';
import type { GeneratorView } from '../src/core/uemaster/candidates';
import { RefRow } from '../app/components/Drawer';

/**
 * 参考段那一行：库里有产物行、磁盘上没文件时，**不许**再画一条链接。
 *
 * 事故（2026-11-08）：子 agent 会话里跑了一次 `git clean -fdx`，`data/uemaster/`
 * 被整个删掉，`uemaster_artifacts` 的行还在。抽屉里那一行照旧是一条可点的链接，
 * 点开是路由给的 404「产物不存在」——用户看到的是「材料没了」，系统看到的是「一切正常」。
 *
 * 这一组测的是**界面那一半**：`filePresent === false` 时把链接换成「文件已丢失」+
 * 「重新生成」。路由那一层的 404 保持不动（直接访问旧 URL 仍然该是 404）。
 *
 * 为什么渲染 `RefRow` 而不是整张抽屉：抽屉里是 `next/link`，脱离 App Router 的
 * 上下文渲染会直接抛。判据在这一格里，用例就只渲染这一格。
 *
 * 为什么要 mock `../app/actions`：`GenerateButton` / `AttachForm` 从那里拿 server
 * action，而 `app/actions.ts` 是 `'use server'` 模块（顶层 import 了 `next/cache`），
 * 在用例进程里起不来。这一组盯的是「链接还是那句话」，不是按下去之后发生什么。
 */
vi.mock('../app/actions', () => ({
  generateAction: vi.fn(async () => ({ ok: true, jobId: 'job-1' })),
  generationStatusAction: vi.fn(async () => null),
  attachAction: vi.fn(async () => ({ ok: true, url: '/uemaster/PAN-7/evaluate.html' })),
}));

/**
 * `GenerateButton` 第一行就是 `useRouter()`，而它只在 App Router 的上下文里有值；
 * 用例进程里直接渲染会抛 `invariant expected app router to be mounted`。
 * 这一组不按按钮，只让它渲染得出来——`refresh` 给一个空函数就够。
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const URL = '/uemaster/PAN-7/evaluate.html';

/** 一份「库里最新那一行」的读模型值，只有 `filePresent` 在变。 */
function ref(filePresent: boolean | null, url = URL): DetailRef {
  return {
    stage: 'evaluate',
    label: '评估材料',
    url,
    at: '2026-11-07T00:00:00.000Z',
    atLabel: '11-07',
    present: true,
    filePresent,
    freshness: 'fresh',
    versions: 1,
    history: [],
    generation: null, needsDescription: null,
  };
}

/** 一个「什么都没配」的生成器视图：这一组的用例不按那个按钮。 */
const GENERATOR: GeneratorView = {
  state: 'none',
  source: null,
  command: null,
  provider: null,
  saved: null,
  candidates: [],
  known: [],
  options: [],
  defaultId: null,
  savedId: null,
  test: null,
};

function html(item: DetailRef, canEdit = true): string {
  return renderToStaticMarkup(
    <RefRow
      item={item} id="id-1" number={7} state="inbox" generator={GENERATOR} canEdit={canEdit}
    />,
  );
}

describe('参考段：文件不在了就不再画链接', () => {
  it('文件还在：是链接，没有「文件已丢失」', () => {
    const out = html(ref(true));
    expect(out).toContain(`href="${URL}"`);
    expect(out).not.toContain('文件已丢失');
  });

  it('行在、文件没了：没有链接，写「文件已丢失，重新生成」', () => {
    const out = html(ref(false));
    // 死链是这一条用例的全部理由：那个 href 一点就是 404。
    expect(out).not.toContain('href="/uemaster/');
    expect(out).toContain('文件已丢失');
    // 「怎么办」也要说出来：右侧按钮是给有 edit 的人的，这句话是给所有人的。
    expect(out).toContain('重新生成');
  });

  it('丢了也留着阶段名与日期：说清「丢的是哪一份」', () => {
    const out = html(ref(false));
    expect(out).toContain('评估材料');
    expect(out).toContain('11-07');
  });

  it('没有 edit 的人看到同一句话（按钮不在，动作名在）', () => {
    const out = html(ref(false), false);
    expect(out).not.toContain('href="/uemaster/');
    expect(out).toContain('文件已丢失');
    expect(out).toContain('重新生成');
  });

  it('站外链接（filePresent 为 null）：照旧是链接，不算丢失', () => {
    const out = html(ref(null, 'https://docs.example.com/uemaster/e.html'));
    expect(out).toContain('href="https://docs.example.com/uemaster/e.html"');
    expect(out).not.toContain('文件已丢失');
  });

  it('没有产物行时既没有链接也没有「丢失」：那一行是「生成」入口', () => {
    const out = html({
      stage: 'inspect', label: '走查材料', url: null, at: null, atLabel: null,
      present: false, filePresent: false, freshness: 'unknown', versions: 0, history: [],
      generation: null, needsDescription: null,
    });
    expect(out).not.toContain('href="/uemaster/');
    expect(out).not.toContain('文件已丢失');
  });
});
