import { describe, expect, it } from 'vitest';
import {
  DESCRIPTION_PROMPT_MAX, SPLIT_KEYS, splitDescription, splitPrompt, rejectedCount,
} from '../src/core/uemaster/intake.js';
import { normalizeQuote } from '../src/core/uemaster/review.js';
import type { ProviderConfig, ProviderResult } from '../src/core/uemaster/provider.js';

/**
 * 「旧描述 → 六问」（P4-08）。
 *
 * 这一组钉的不是「模型答得好不好」（那要靠真跑），而是**这份工具什么时候不值得信**：
 * 引文必须逐字在原文里、原文没说的格子必须空着、被拒的引文必须留痕。
 *
 * 所以模型被换成一个假的 `complete`：它回什么完全由用例决定，于是「引文是编的」
 * 这件事可以被精确地制造出来——那正是线上最需要被拦住的一种回话。
 */

const CFG: ProviderConfig = { baseUrl: 'https://example.invalid/v1', apiKey: 'k', model: 'm' };

/** 一整段「旧 Flower 风格」的薄描述：一段话，没有小标题。 */
const THIN = '分享页搜索补齐 H5，支持面包屑导航，App 端后置。';

/** 假模型：把一段 JSON 当作回话交回去（`ok: true`），并记下它收到的提示词。 */
function fake(json: unknown, seen?: { prompt?: string }): {
  complete: (c: ProviderConfig, p: string) => Promise<ProviderResult>;
} {
  return {
    complete: async (_cfg, prompt): Promise<ProviderResult> => {
      if (seen !== undefined) seen.prompt = prompt;
      return { ok: true, text: typeof json === 'string' ? json : JSON.stringify(json) };
    },
  };
}

/** 六格全空的一份回话（模型的「原文什么都没说」）。 */
function blank(): Record<string, { value: string; span: string }> {
  return Object.fromEntries(SPLIT_KEYS.map((key) => [key, { value: '', span: '' }]));
}

describe('splitDescription · 逐字核对', () => {
  it('六格都有原文依据时全部采用，notes 里每条都能在原文里找到', async () => {
    const cells = blank();
    cells['surfaces'] = { value: 'H5 分享页的面包屑导航', span: '支持面包屑导航' };
    cells['outcome'] = { value: 'H5 能按层级定位目录', span: '分享页搜索补齐 H5' };
    cells['out_of_scope'] = { value: 'App 端这次不做', span: 'App 端后置' };

    const result = await splitDescription(CFG, { title: '分享页搜索', description: THIN },
      fake(cells));

    expect(result.surfaces).toBe('H5 分享页的面包屑导航');
    expect(result.outcome).toBe('H5 能按层级定位目录');
    expect(result.out_of_scope).toBe('App 端这次不做');
    // 另外三格：模型没说话 → 空 + missing。**不猜**。
    expect(result.context).toBe('');
    expect(result.problem).toBe('');
    expect(result.edge_cases).toBe('');
    expect(result.missing).toEqual(['context', 'problem', 'edge_cases']);
    expect(result.notes).toHaveLength(3);
    // 不变量：每条 `←` 的引文逐字在原文里（归一化之后）。
    for (const note of result.notes) {
      const span = /「(.+)」/.exec(note)?.[1] ?? '';
      expect(normalizeQuote(THIN)).toContain(normalizeQuote(span));
    }
  });

  it('编造的引文：那一格被丢掉、进 missing，notes 里留一条 ⨯', async () => {
    const cells = blank();
    // 原文里没有「失败时提示重试」这句话——这正是模型最爱补的那一句。
    cells['edge_cases'] = { value: '失败时提示重试', span: '失败时提示重试' };
    cells['surfaces'] = { value: 'H5 面包屑', span: '支持面包屑导航' };

    const result = await splitDescription(CFG, { title: 't', description: THIN }, fake(cells));

    expect(result.edge_cases).toBe('');
    expect(result.missing).toContain('edge_cases');
    expect(result.surfaces).toBe('H5 面包屑');
    // 被拒的那一格**内容丢掉了，不是留着一个没有依据的答案**。
    expect(result.notes.some((note) => note.startsWith('edge_cases ⨯'))).toBe(true);
    expect(rejectedCount(result)).toBe(1);
  });

  it('有内容但没有引文：同样算没有依据（并把原因写成一句话）', async () => {
    const cells = blank();
    cells['problem'] = { value: '现在只能一层层翻目录', span: '' };

    const result = await splitDescription(CFG, { title: 't', description: THIN }, fake(cells));

    expect(result.problem).toBe('');
    expect(result.notes).toContain('problem ⨯ （模型没给引文）');
  });

  it('原文没说的格子：空着、列进 missing，而且**没有** notes（与「被拒」分开）', async () => {
    const result = await splitDescription(CFG, { title: 't', description: THIN }, fake(blank()));
    expect(result.missing).toEqual([...SPLIT_KEYS]);
    expect(result.notes).toEqual([]);
    for (const key of SPLIT_KEYS) expect(result[key]).toBe('');
  });

  it('归一化放宽的是格式，不是内容：改词、拼接两处都判不通过', async () => {
    const cells = blank();
    // 格式差异（表格线 / 全角空格 / 强调符）算同一句。
    cells['surfaces'] = { value: 'ok', span: '  **支持 面包屑**导航 ' };
    // 改了一个词 → 判不通过。
    cells['outcome'] = { value: 'x', span: '分享页搜索补齐 PC' };

    const result = await splitDescription(CFG, { title: 't', description: THIN }, fake(cells));
    expect(result.surfaces).toBe('ok');
    expect(result.outcome).toBe('');
    expect(rejectedCount(result)).toBe(1);
  });

  it('value 空、span 站得住时，用 span 当答案（模型只给了引文）', async () => {
    const cells = blank();
    cells['out_of_scope'] = { value: '', span: 'App 端后置' };
    const result = await splitDescription(CFG, { title: 't', description: THIN }, fake(cells));
    expect(result.out_of_scope).toBe('App 端后置');
    expect(result.missing).not.toContain('out_of_scope');
  });
});

describe('splitDescription · 边界', () => {
  it('原文是空的：六格全空 + 一句原因，不问模型', async () => {
    let called = false;
    const result = await splitDescription(CFG, { title: 't', description: '   \n  ' }, {
      complete: async () => {
        called = true;
        return { ok: true, text: '{}' };
      },
    });
    expect(called).toBe(false);
    expect(result.missing).toEqual([...SPLIT_KEYS]);
    expect(result.notes).toEqual(['原文是空的：六个问题都没有依据']);
  });

  it('回话里没有 JSON：抛一句中文，而不是返回六个空格子', async () => {
    await expect(splitDescription(CFG, { title: 't', description: THIN }, fake('我觉得这个需求还行')))
      .rejects.toThrow(/没有六问的 JSON/);
  });

  it('围栏里的 JSON 也认（模型爱加 ```json）', async () => {
    const cells = blank();
    cells['surfaces'] = { value: 'H5 面包屑', span: '支持面包屑导航' };
    const fenced = `好的：\n\`\`\`json\n${JSON.stringify(cells)}\n\`\`\``;
    const result = await splitDescription(CFG, { title: 't', description: THIN }, fake(fenced));
    expect(result.surfaces).toBe('H5 面包屑');
  });

  it('模型接口报错：原文带出（`{ok:false}` → AppError）', async () => {
    await expect(splitDescription(CFG, { title: 't', description: THIN }, {
      complete: async () => ({ ok: false, error: '分组 auto 下模型 x 的可用渠道不存在' }),
    })).rejects.toThrow('分组 auto 下模型 x 的可用渠道不存在');
  });

  it('提示词里带标题与整段原文，并要求逐字复制', async () => {
    const seen: { prompt?: string } = {};
    await splitDescription(CFG, { title: '分享页搜索', description: THIN }, fake(blank(), seen));
    expect(seen.prompt).toContain('分享页搜索');
    expect(seen.prompt).toContain(THIN);
    expect(seen.prompt).toContain('逐字');
    // 六问的键必须逐个点出来，否则模型会自己发明字段名。
    for (const key of SPLIT_KEYS) expect(seen.prompt).toContain(key);
  });

  it('超长原文：只把前 N 字交给模型，并在 notes 里明说截了', async () => {
    const long = '分享页搜索。'.repeat(DESCRIPTION_PROMPT_MAX);
    const seen: { prompt?: string } = {};
    const result = await splitDescription(
      CFG, { title: 't', description: long }, fake(blank(), seen),
    );
    expect(seen.prompt!.length).toBeLessThan(long.length);
    expect(result.notes[0]).toMatch(/只有前 \d+ 字交给了模型/);
  });

  it('提示词是纯函数：同样的输入给出同样的字符串（可被报告引用）', () => {
    const a = splitPrompt({ title: 't', description: '一段原文' }, '一段原文');
    const b = splitPrompt({ title: 't', description: '一段原文' }, '一段原文');
    expect(a).toBe(b);
  });
});
