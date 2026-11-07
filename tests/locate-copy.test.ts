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
   * 四句话逐字钉住——改一个字就要红。
   *
   * 上面的用例全是 `toContain` / `not.toBe`，它们保护的是「两句话不串味」「关键词还在」，
   * 但**这套文案本身就是本任务的交付物**：删掉「这一轮不含任何现状判断」、把「定位到」
   * 改成「找到」、把「请与研发确认」截成一句短话，全部能过。Task 5–9 的人回头「顺手
   * 润色一下」时，就成了无声的语义变更。所以这里对**完整字符串**做 `toBe`：这是唯一
   * 能挡住改字的写法，代价是以后真要改文案必须同时改测试——那正是我们想要的摩擦。
   *
   * 拼装输出也一起钉：清单的分隔符、编号格式、句号与空行位置都属于措辞的一部分。
   */
  it('四句话逐字钉住——改一个字就要红', () => {
    expect(ABSENT_HEADLINE).toBe('代码没读到，这一轮不含任何现状判断。');
    expect(NOT_FOUND_HEADLINE).toBe('没能在代码里定位到这条需求的实现。');
    expect(LOW_CONFIDENCE_HEADLINE).toBe('最可能的位置（待研发确认）：');
    expect(CONFIRM_WITH_DEV).toBe(
      '请与研发确认现在实际是怎么做的，确认后更新 PRD 文档，材料会标记为旧版并重新生成。',
    );
    expect(ABSENT_LINE('镜像连不上')).toBe(
      '代码没读到，这一轮不含任何现状判断。（原因：镜像连不上）'
      + '请与研发确认现在实际是怎么做的，确认后更新 PRD 文档，材料会标记为旧版并重新生成。',
    );
    expect(CANDIDATES_LINE([
      { path: 'src/a.vue', reason: '路由 /a 的页面', source: 'structure', score: 10 },
      { path: 'src/b.ts', reason: '出自 11-03 那次合并', source: 'history', score: 6 },
    ])).toBe(
      '最可能的位置（待研发确认）：\n'
      + '1. `src/a.vue` ← 路由 /a 的页面\n'
      + '2. `src/b.ts` ← 出自 11-03 那次合并\n'
      + '以上是线索，不是结论。'
      + '请与研发确认现在实际是怎么做的，确认后更新 PRD 文档，材料会标记为旧版并重新生成。',
    );
  });

  /**
   * 空候选必须炸，不许渲染成一条空清单。
   *
   * 「最可能的位置（待研发确认）：」后面跟零条目是一句假话：它宣称找到了位置，实际
   * 一条也没有；材料不缺块、不报错，只有真人逐字读才发现——正是本仓修过两遍的
   * 「失败被渲染成空结果」。抛异常让 bug 停在能追责的那一层（检索层该返回
   * `{ kind: 'none' }`），而不是被文案层悄悄吸收。
   */
  it('空候选直接抛，不渲染空清单', () => {
    expect(() => CANDIDATES_LINE([])).toThrow(/CANDIDATES_LINE 不接受空数组/);
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
      { path: 'src/api/file.ts', reason: '路由 /transfer 的页面（命中「断点续传」）', source: 'structure', score: 1 },
    ];
    const line = CANDIDATES_LINE(items);

    expect(line).toContain('1. `src/pages/transfer.vue` ← 出自 11-03 那次合并');
    expect(line).toContain('2. `src/components/Upload/index.vue` ← 目录名与需求里的「上传」对上');
    expect(line).toContain('3. `src/api/file.ts` ← 路由 /transfer 的页面（命中「断点续传」）');

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
