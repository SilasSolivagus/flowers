import { describe, expect, it } from 'vitest';

import {
  ABSENT_HEADLINE,
  ABSENT_LINE,
  CANDIDATES_LINE,
  CONFIRM_WITH_DEV,
  LOW_CONFIDENCE_HEADLINE,
  NOT_FOUND_HEADLINE,
} from '../src/core/locate/copy.js';
import type { Candidate } from '../src/core/locate/types.js';

const one: Candidate[] = [
  { path: 'a/b.vue', reason: '出自 11-03 那次合并', source: 'history', score: 1 },
];

describe('那几句话', () => {
  it('「没读到」与「没找到」是两句不同的话', () => {
    expect(ABSENT_LINE('镜像连不上')).toContain('没读到');
    expect(ABSENT_LINE('镜像连不上')).toContain('镜像连不上');
    expect(NOT_FOUND_HEADLINE).toContain('没能');
    expect(ABSENT_LINE('x')).not.toBe(NOT_FOUND_HEADLINE);
  });

  it('候选一律标注「待研发确认」，且推动更新 PRD 而不是填六问', () => {
    const line = CANDIDATES_LINE(one);
    expect(line).toContain('a/b.vue');
    expect(line).toContain('出自 11-03 那次合并');
    expect(line).toContain('待研发确认');
    expect(CONFIRM_WITH_DEV).toContain('PRD');
    expect(CONFIRM_WITH_DEV).not.toContain('六问');
  });

  /**
   * 多条候选必须按传入顺序编号、一条不丢。
   *
   * 为什么这条值得单独钉：`CANDIDATES_LINE` 是唯一把「检索给的一串路径」翻成
   * 「PM 能照着看的一串」的地方，一旦有人为了「去重 / 只留前 N 条 / 按来源分组」
   * 在这里加一层 map 或 slice，编号会与顺序脱节（第 1 条其实排第三），或者静默少掉
   * 一条候选——两种都不会报错，只会在材料里看起来「查得挺干净」。简报里的两个用例
   * 都只喂了一条候选，结构上丢了顺序也照样过。
   */
  it('多条候选按传入顺序编号，一条不丢', () => {
    const items: Candidate[] = [
      { path: 'src/pages/transfer.vue', reason: '出自 11-03 那次合并', source: 'history', score: 3 },
      { path: 'src/components/Upload/index.vue', reason: '目录名与需求里的「上传」对上', source: 'structure', score: 2 },
      { path: 'src/api/file.ts', reason: '文本命中「断点续传」', source: 'grep', score: 1 },
    ];
    const line = CANDIDATES_LINE(items);

    expect(line).toContain('1. `src/pages/transfer.vue` ← 出自 11-03 那次合并');
    expect(line).toContain('2. `src/components/Upload/index.vue` ← 目录名与需求里的「上传」对上');
    expect(line).toContain('3. `src/api/file.ts` ← 文本命中「断点续传」');

    // 顺序 = 传入顺序（排序是检索层的事，文案层不许再排一次）。
    const at = items.map((c) => line.indexOf(c.path));
    expect(at.every((v) => v >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // 编号与路径的相邻关系也钉住：只断言「包含」的话，编号错位仍能过。
    expect(line.indexOf('1. `src/pages/transfer.vue`')).toBeLessThan(
      line.indexOf('2. `src/components/Upload/index.vue`'),
    );
    expect(line.indexOf('2. `src/components/Upload/index.vue`')).toBeLessThan(
      line.indexOf('3. `src/api/file.ts`'),
    );
  });

  /**
   * 两句结论不许互相串味。
   *
   * 上面第一个用例只能证明「两句现在不一样」，证不了「以后不会并成一句」——
   * 只要有人图省事把「没读到」也写成「没能找到」，`ABSENT_LINE('x') !== NOT_FOUND_HEADLINE`
   * 依然成立，两层含义却在措辞上合一了。所以这里反过来钉：各自的特征词只能出现在
   * 自己那句里，并且全仓的这四句里都不许出现「代码里没有」——那句是把「没看到」
   * 说成「没有」的原话，也是这两轮返工的起点。
   */
  it('「没读到」与「没找到」的特征词不交叉，且没有人写「代码里没有」', () => {
    expect(ABSENT_HEADLINE).toContain('没读到');
    expect(NOT_FOUND_HEADLINE).not.toContain('没读到');
    expect(NOT_FOUND_HEADLINE).toContain('没能');
    expect(ABSENT_HEADLINE).not.toContain('没能');

    const all = [
      ABSENT_HEADLINE,
      NOT_FOUND_HEADLINE,
      LOW_CONFIDENCE_HEADLINE,
      CONFIRM_WITH_DEV,
      ABSENT_LINE('镜像连不上'),
      CANDIDATES_LINE(one),
    ];
    for (const text of all) expect(text).not.toContain('代码里没有');
  });
});
