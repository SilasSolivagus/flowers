import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { DetailRef } from '../src/core/read/detail.js';
import type { GeneratorView } from '../src/core/uemaster/candidates';
import { LOST_HISTORY_NOTE, RefRow } from '../app/components/Drawer';

/**
 * 参考段那一行的两处新形状（2026-11-10 owner 的第一次纠正）：
 *
 * 1. **最新一份**挂着「最新」，后面跟一个「历史（N 版）」；
 * 2. 历史里每一版都是一条**能点开的链接**——旧版本不能只在库里有、在盘上有，
 *    而界面上没有入口；
 * 3. 固定文件名时代的那几行（`content_lost`）不许被画成「一份可读的历史」：
 *    那一行点开看到的是后来那一版的内容，所以行上写「内容已被覆盖」，整段上面再写
 *    一句为什么救不回来。
 *
 * 为什么渲染 `RefRow` 而不是整张抽屉：抽屉里是 `next/link`，脱离 App Router 的上下文
 * 渲染会直接抛。为什么 mock `../app/actions`：`GenerateButton` / `AttachForm` 从那里拿
 * server action，而 `app/actions.ts` 是 `'use server'` 模块。这一组只看画出来的东西。
 */
vi.mock('../app/actions', () => ({
  generateAction: vi.fn(async () => ({ ok: true, jobId: 'job-1' })),
  generationStatusAction: vi.fn(async () => null),
  stopGenerationAction: vi.fn(async () => ({ ok: true, canceled: true })),
  retryGenerationAction: vi.fn(async () => ({ ok: true, jobId: 'job-2' })),
  attachAction: vi.fn(async () => ({ ok: true, url: '/uemaster/PAN-7/evaluate-v003.html' })),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const GENERATOR: GeneratorView = {
  state: 'ready', source: 'provider', command: null, provider: null, saved: null,
  candidates: [], known: [], options: [], defaultId: null, savedId: null, test: null,
} as unknown as GeneratorView;

/** 最新一版 + 两版历史：一版还在，一版是「内容已被覆盖」的存量行。 */
function ref(overrides: Partial<DetailRef> = {}): DetailRef {
  return {
    stage: 'evaluate',
    label: '评估材料',
    url: '/uemaster/PAN-7/evaluate-v003.html',
    at: '2026-11-10T04:00:00.000Z',
    atLabel: '11-10',
    present: true,
    filePresent: true,
    freshness: 'fresh',
    versions: 3,
    history: [
      {
        url: '/uemaster/PAN-7/evaluate-v002.html',
        at: '2026-11-10T03:00:00.000Z',
        atLabel: '11-10',
        filePresent: true,
        contentLost: false,
      },
      {
        url: '/uemaster/PAN-7/evaluate.html',
        at: '2026-11-09T02:00:00.000Z',
        atLabel: '11-09',
        filePresent: true,
        contentLost: true,
      },
    ],
    generation: null,
    needsDescription: null,
    ...overrides,
  };
}

function html(item: DetailRef, canEdit = true): string {
  return renderToStaticMarkup(
    <RefRow item={item} id="req-1" number={7} state="inbox" generator={GENERATOR} canEdit={canEdit} />,
  );
}

describe('最新一份：一个「最新」，一个历史入口', () => {
  it('最新那一行有链接与「最新」，历史收在「历史（2 版）」里', () => {
    const out = html(ref());
    expect(out).toContain('href="/uemaster/PAN-7/evaluate-v003.html"');
    expect(out).toContain('最新');
    expect(out).toContain('历史（2 版）');
    // 历史默认收起，但链接已经在 DOM 里——展开就能点，不依赖任何脚本。
    expect(out).toContain('href="/uemaster/PAN-7/evaluate-v002.html"');
    expect(out).toContain('<details class="hist">');
  });

  it('没有历史时整段不渲染（只有「最新」，没有空的「历史（0 版）」）', () => {
    const out = html(ref({ versions: 1, history: [] }));
    expect(out).toContain('最新');
    expect(out).not.toContain('历史（');
    expect(out).not.toContain('class="hist"');
  });
});

describe('存量「内容已被覆盖」的行：如实说，不假装是另一个版本', () => {
  it('那一行标「内容已被覆盖」，整段上面写出那句「无法恢复」', () => {
    const out = html(ref());
    expect(out).toContain('内容已被覆盖');
    expect(out).toContain(LOST_HISTORY_NOTE);
    // 原文逐字（这句话是要被读到、被截图发给人的，不能被改写成一个词）。
    expect(LOST_HISTORY_NOTE).toBe('更早的版本内容已被覆盖，无法恢复（当时按固定文件名保存）');
  });

  it('被覆盖的行仍然给出链接（文件还在），但绝不标「最新」也不标「文件已丢失」', () => {
    const out = html(ref({
      versions: 2,
      history: [{
        url: '/uemaster/PAN-7/evaluate.html',
        at: '2026-11-09T02:00:00.000Z',
        atLabel: '11-09',
        filePresent: true,
        contentLost: true,
      }],
    }));
    expect(out).toContain('href="/uemaster/PAN-7/evaluate.html"');
    expect(out).toContain('内容已被覆盖');
    expect(out).not.toContain('文件已丢失');
  });

  it('历史行文件真的没了：说「文件已丢失」，不说「内容已被覆盖」', () => {
    const out = html(ref({
      versions: 2,
      history: [{
        url: '/uemaster/PAN-7/evaluate-v001.html',
        at: '2026-11-09T02:00:00.000Z',
        atLabel: '11-09',
        filePresent: false,
        contentLost: false,
      }],
    }));
    expect(out).toContain('文件已丢失');
    expect(out).not.toContain('内容已被覆盖');
    expect(out).not.toContain(LOST_HISTORY_NOTE);
  });
});
