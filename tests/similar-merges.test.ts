import { describe, expect, it } from 'vitest';

import { SIMILAR_MERGES, similarMerges } from '../src/core/locate/history.js';
import { SIMILAR_PREFIX, similarLines, withSimilar } from '../src/core/locate/copy.js';
import type { HistoryRow } from '../src/core/locate/history-store.js';

/**
 * 「同类先例」这一行（Task 5）。
 *
 * 钉的是两件事，分开两组：
 *
 * 1. **选哪几次合并**（`similarMerges`）：它必须与定位那条路**同一套打分**，否则材料上
 *    并排的两句话会自相矛盾（候选说出自某次合并、先例里没有它）。所以这里不测「像不像」
 *    ——那是 Step 5 拿真数据人工判的事——只测契约：命中、无命中、以及**文件数是怎么数的**。
 * 2. **材料上那句话怎么长**（`similarLines` / `withSimilar`）：逐字钉住，尤其是
 *    **没有先例时一个字都不许写**。写「先例：无」会把「我们手上没有可比的历史」
 *    说成「查过了，确实没有」——这正是本仓修过两遍的那种假话。
 *
 * 夹具刻意用真实提交信息的样子（`feat: 下载限速风控开发 / 弹窗…`）：切块与 IDF 都吃
 * 中文二字组，拿 `abc def` 那种英文假数据测不出任何有意义的东西。
 */

type RowIn = { sha: string; message: string; files: string[]; at?: string; repo?: string };

function row(input: RowIn): HistoryRow {
  return {
    repo: input.repo ?? '123pan-pc',
    commitSha: input.sha,
    mergedAt: input.at ?? '2026-11-03T02:00:00.000Z',
    branch: 'feat-download-limit',
    message: input.message,
    files: input.files,
  };
}

/** 真答案：这条需求的实现就在这次合并里，动了两个文件。 */
const HIT = row({
  sha: 'a'.repeat(40),
  message: 'feat: 下载限速风控开发 / 上传下载按量限速弹窗',
  files: ['src/services/download-risk-modal.ts', 'src/pages/Download/list.vue'],
});

/** 同一天、同一个文件的另一次合并：用来验「文件数按合并统计，不累加」。 */
const WIDE = row({
  sha: 'b'.repeat(40),
  message: 'feat: 下载限速风控文案调整 / 限速提示语',
  files: ['src/services/download-risk-modal.ts'],
  at: '2026-11-01T02:00:00.000Z',
});

/** 与标题一个字都不重合的合并（发票报销）：它永远不该出现在先例里。 */
const UNRELATED = row({
  sha: 'c'.repeat(40),
  message: 'feat: 发票报销审批流对接 / 开票信息校验',
  files: ['src/pages/Invoice/apply.vue'],
  at: '2026-10-28T02:00:00.000Z',
});

describe('similarMerges：拿真需求标题去找同类先例', () => {
  it('命中同名需求：先例是那次合并，带日期、标题与它自己的文件数', () => {
    const got = similarMerges([HIT, UNRELATED], '下载限速风控');

    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({
      sha: HIT.commitSha,
      subject: 'feat: 下载限速风控开发',
      files: 2,
      date: '11-03',
    });
  });

  it('无命中返回空：空数组是「不写这一行」的唯一信号，不是「没有先例」这句话', () => {
    // 1) 标题与任何提交信息都不重合
    expect(similarMerges([HIT, UNRELATED], '火星殖民计划预算复核')).toEqual([]);
    // 2) 标题切不出词（纯标点）：与 1 是两种原因，结果同一句话——都不写
    expect(similarMerges([HIT, UNRELATED], '「。！」')).toEqual([]);
    // 3) 一条历史都没有
    expect(similarMerges([], '下载限速风控')).toEqual([]);
  });

  it('文件数按合并统计，不是把前几名的文件加起来', () => {
    const rows = [HIT, WIDE];
    const got = similarMerges(rows, '下载限速风控');

    // 两条都碰过 download-risk-modal.ts：加起来会被数两遍（2 + 1 = 3），
    // 而真实的问题是「上一次改了几个文件」——所以每一格只报它自己那次。
    expect(got.map((item) => item.sha)).toEqual([HIT.commitSha, WIDE.commitSha]);
    expect(got.map((item) => item.files)).toEqual([2, 1]);
    expect(got.map((item) => item.files)).toEqual([HIT.files.length, WIDE.files.length]);
    // 两次合并的并集只有 2 个文件：任何「合计」都会同时大于每一条单次改动
    expect(new Set(rows.flatMap((item) => item.files)).size).toBe(2);
  });

  it('结构性杂活合并不进来：发版 / 合并主干的消息里全是功能词，也不能算先例', () => {
    const plumbing = row({
      sha: 'd'.repeat(40),
      message: '下载限速风控 发版',
      files: ['src/pages/Download/list.vue', 'package.json'],
    });
    // 先验一下它确实「字面上很像」：不过滤的话它会稳稳排第一
    const unfiltered = similarMerges([plumbing, HIT], '下载限速风控', 5);
    expect(unfiltered.map((item) => item.sha)).toEqual([HIT.commitSha]);
  });

  it('默认最多给 3 次：再多就变成一份清单，读者开始逐条数文件', () => {
    const many = Array.from({ length: 6 }, (_, i) => row({
      sha: String(i).repeat(40).slice(0, 40),
      message: `feat: 下载限速风控第 ${i} 次调整 / 弹窗`,
      files: [`src/pages/Download/list${i}.vue`],
      at: `2026-11-0${i + 1}T02:00:00.000Z`,
    }));
    expect(SIMILAR_MERGES).toBe(3);
    expect(similarMerges(many, '下载限速风控')).toHaveLength(3);
    // 显式传 k 就照 k 来（k = 0 等于「不要这一行」）
    expect(similarMerges(many, '下载限速风控', 5)).toHaveLength(5);
    expect(similarMerges(many, '下载限速风控', 0)).toEqual([]);
  });

  it('第一段为空的消息不退成空引号：退到下一段（空消息那 13 行永远赢不了，不伪造标题）', () => {
    // `/ 下载限速风控弹窗`：第一段是空串，标题必须取第二段——直接渲染成 `11-03「」`
    // 会让读者以为我们读坏了消息；而写「（提交信息为空）」对这条消息是假话。
    const headless = row({
      sha: 'e'.repeat(40),
      message: ' / 下载限速风控弹窗',
      files: ['src/pages/Download/list.vue'],
    });
    const got = similarMerges([headless, HIT], '下载限速风控');
    expect(got.map((item) => item.subject).sort()).toEqual(
      ['feat: 下载限速风控开发', '下载限速风控弹窗'].sort(),
    );
    expect(got.every((item) => item.subject !== '')).toBe(true);

    // 整条消息为空的那 13 行：一个二字组都切不出来，进不了先例——所以材料里
    // 不会出现「有日期、没标题」这种半格。
    expect(similarMerges([row({ sha: 'f'.repeat(40), message: '', files: ['x/src/pages/a.vue'] })], '下载限速风控'))
      .toEqual([]);
  });
});

describe('材料里那一行：与「代码快照：」同风格，没有先例时一个字都不写', () => {
  const three = [
    { date: '11-03', subject: 'feat: 下载限速风控开发', files: 2 },
    { date: '11-01', subject: 'feat: 下载限速风控文案调整', files: 1 },
  ];

  it('逐字钉住：全角冒号、一次一格、不写合计数', () => {
    expect(SIMILAR_PREFIX).toBe('同类先例：');
    expect(similarLines(three)).toMatchInlineSnapshot(`
      [
        "同类先例：11-03「feat: 下载限速风控开发」2 个文件；11-01「feat: 下载限速风控文案调整」1 个文件",
      ]
    `);
    // 没有「共 N 个文件」这种合计：它没有单位，还把重复碰过的文件数两遍
    expect(similarLines(three)[0]).not.toContain('共');
  });

  it('没有先例 → 空数组；接在材料上时原样返回（连空行都不加）', () => {
    expect(similarLines([])).toEqual([]);
    const body = '最可能的位置（待研发确认）：\n1. `a.vue`\n代码快照：123pan-pc @ 2026-10-16';
    expect(withSimilar(body, [])).toBe(body);
    expect(withSimilar(body, [])).not.toContain('先例');
  });

  it('有先例时接在末尾，前面那几句一个字都不动', () => {
    const body = '代码快照：123pan-pc @ 2026-10-16';
    const joined = withSimilar(body, three);
    expect(joined).toBe(`${body}\n${similarLines(three)[0]}`);
    // 快照行仍在原位置（先例是接在它后面，不是插在它前面）
    expect(joined.split('\n')[0]).toBe(body);
  });
});
