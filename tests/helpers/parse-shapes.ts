/**
 * 「病态形状」语料：解析器**必须**在硬预算内吃完的输入。
 *
 * 为什么把形状放在这里而不是散在用例里：`code-index-backtracking.test.ts` 的守卫用例
 * 与 `parse-budget-runner.mts`（子进程）必须喂**同一份**语料。两边各写一份的话，
 * 改了一边另一边还在测旧形状，而报告里的「预算内」会是一句没人核对的话。
 *
 * 为什么是这五个形状：它们都是「正则退化」的经典触发面——量词套量词、`[^>]*` 撞上
 * 没有 `>` 的长尾巴、超大单行上没有词边界的长词串。真实仓里的 `.vue` 不长这样，
 * 但**生成代码、粘贴进来的整页 HTML、被截断的文件**长这样，而索引不区分来源。
 */
export type PathologicalShape = {
  /** 用例与报告里用的名字（短、可 grep）。 */
  name: string;
  /** 一句话说清它压的是哪条规则的哪个弱点。 */
  why: string;
  /** 喂给 `parseBlob` 的路径（只决定走哪条抽取分支，不看目录）。 */
  path: string;
  text: string;
};

function build(): PathologicalShape[] {
  return [
    {
      name: 'long-attr-list',
      why: '`<template(?:\s[^>]*)?>` 要在几千个属性里找 `>`',
      path: 'index.vue',
      text: `<template ${Array.from({ length: 4000 }, (_, i) => `data-a${i}="v"`).join(' ')}>\n  <AppHeader />\n</template>\n`,
    },
    {
      name: 'nested-div',
      why: '两万层同名嵌套：任何按「标签对」写的规则都会在这里退化成 O(n²)',
      path: 'index.vue',
      text: `<template>\n${'<div>'.repeat(20_000)}${'</div>'.repeat(20_000)}\n</template>\n`,
    },
    {
      name: 'unclosed-tag',
      why: '200 KB 属性串 + 全文没有 `>`：`[^>]*` 的每一种回溯都会在这里露出来',
      path: 'index.vue',
      text: `<template ${Array.from({ length: 8000 }, (_, i) => `a${i}="${'v'.repeat(20)}"`).join(' ')}\n`,
    },
    {
      name: 'single-line-template',
      why: '400 KB 单行、标签密集：`(?:…)*` 里再套量词就是指数',
      path: 'index.vue',
      text: `<template>${'<div class="x"><span title="t">hi</span></div>'.repeat(9000)}</template>`,
    },
    {
      name: 'uppercase-run',
      why: '没有词边界的长大写词串：`([A-Z][A-Za-z0-9_]*)*` 这种形状在这里是指数',
      path: 'index.vue',
      text: `<template>\n  <${'A'.repeat(40)}.\n</template>\n`,
    },
  ];
}

/** 语料（每次现造，避免用例之间互相改到同一个字符串——字符串本来也不可变，但便宜）。 */
export const PATHOLOGICAL_SHAPES: readonly PathologicalShape[] = build();
