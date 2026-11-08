import { describe, expect, it } from 'vitest';

import {
  extractIndex, isIndexable, pagesFromConfig, type CodeIndex,
} from '../src/core/codemirror/code-index.js';

/**
 * Task 1：页面清单不再靠目录约定猜。
 *
 * 为什么这条清单要单独存在：评估材料的通病是「写一个已经存在的页面」。目录约定只能
 * 回答「这里可能有一页」，而 `pages.json` 是**应用自己说的**那份清单（连标题都有）。
 * 两者都收，但 `pages.json` 胜出——同一页被说过之后，约定推出来的那条只是同一条路由
 * 的另一种拼法，留着会让材料以为这一个页面有两个入口。
 */

/** 真文件的形状：uni-app 的条件编译注释，以及注释之间**没有逗号**（`} // #endif {`）。 */
const UNI_PAGES_JSON = [
  '{',
  '  "pages": [',
  '    // #ifdef MP-ALIPAY',
  '    {',
  '      "path": "pages/alipay/index",',
  '      "style": { "navigationBarTitleText": "123云盘" }',
  '    },',
  '    {',
  '      "path": "pages/doc/user",',
  '      "style": { "navigationBarTitleText": "用户协议" }',
  '    }',
  '    // #endif',
  '    // #ifndef MP-ALIPAY',
  '    {',
  '      "path": "pages/index/index"',
  '    },',
  '    {',
  '      "path": ""',
  '    }',
  '    // #endif',
  '  ],',
  '  // 分包：这里的 `path` 不是顶层页面，不能被当成页面收进来',
  '  "subPackages": [',
  '    {',
  '      "root": "pkgA",',
  '      "pages": [',
  '        { "path": "sub/index", "style": { "navigationBarTitleText": "分包页" } }',
  '      ]',
  '    }',
  '  ],',
  '  "globalStyle": { "navigationBarTitleText": "123云盘" }',
  '}',
].join('\n');

/** 纯函数装配入口：路径 + 内容 → 一份索引（不碰 git、不碰库）。 */
function indexOf(files: Record<string, string>): CodeIndex {
  const paths = Object.keys(files);
  return extractIndex({
    repo: 'fixture-pages',
    sha: '0123456789abcdef',
    all: paths,
    sources: paths.map((path) => ({ path, size: files[path]?.length ?? 0, text: files[path] ?? '' })),
  });
}

describe('pagesFromConfig', () => {
  it('从 pages.json 取出 route 与 navigationBarTitleText', () => {
    const json = JSON.stringify({
      pages: [
        { path: 'pages/share/index', style: { navigationBarTitleText: '分享页' } },
        { path: 'pages/search/index', style: { navigationBarTitleText: '搜索结果' } },
      ],
    });
    expect(pagesFromConfig('pages.json', json)).toEqual([
      { route: '/pages/share/index', title: '分享页', source: 'pages.json' },
      { route: '/pages/search/index', title: '搜索结果', source: 'pages.json' },
    ]);
  });

  it('不是 pages.json 的路径返回空数组（不做猜测）', () => {
    // 内容长得像页面清单也不算：路径不是 `pages.json` 就没有「这是页面清单」的授权。
    expect(pagesFromConfig('src/router.ts', JSON.stringify({ pages: [{ path: 'a/b' }] }))).toEqual([]);
  });

  it('JSON 坏了返回空数组而不是抛错（索引不能因为一个坏文件整体失败）', () => {
    expect(pagesFromConfig('pages.json', '{oops')).toEqual([]);
  });

  it('条件编译注释、注释之间缺的逗号、没有 style 的页面都不影响取全', () => {
    expect(pagesFromConfig('src/pages.json', UNI_PAGES_JSON)).toEqual([
      { route: '/pages/alipay/index', title: '123云盘', source: 'pages.json' },
      { route: '/pages/doc/user', title: '用户协议', source: 'pages.json' },
      { route: '/pages/index/index', title: null, source: 'pages.json' },
    ]);
  });

  it('标题里的 // 不是注释（字符串里的斜杠不能吃掉后面的声明）', () => {
    const json = JSON.stringify({
      pages: [
        { path: 'pages/a/a', style: { navigationBarTitleText: 'https://123pan.com' } },
        { path: 'pages/b/b', style: { navigationBarTitleText: 'B 页' } },
      ],
    });
    expect(pagesFromConfig('pages.json', json).map((page) => page.title))
      .toEqual(['https://123pan.com', 'B 页']);
  });
});

describe('isIndexable：只收 pages.json 这一种 json', () => {
  it('pages.json 进索引，其它 json 一个都不进', () => {
    expect(isIndexable('pages.json')).toBe(true);
    expect(isIndexable('src/pages.json')).toBe(true);
    expect(isIndexable('package-lock.json')).toBe(false);
    expect(isIndexable('src/config.json')).toBe(false);
    expect(isIndexable('src/services/share.ts')).toBe(true);
  });
});

describe('装配：pages.json 的页面赢过目录约定', () => {
  it('被 pages.json 说过的页面不再造约定条目（真 uni-app 的形状）', () => {
    const index = indexOf({
      'src/pages.json': JSON.stringify({
        pages: [{ path: 'pages/share/index', style: { navigationBarTitleText: '分享页' } }],
      }),
      'src/pages/share/index.vue': '<template><view /></template>\n',
    });
    expect(index.pages).toEqual([
      { route: '/pages/share/index', title: '分享页', source: 'pages.json' },
    ]);
  });

  it('同一条 route 字符串时 pages.json 胜出（落不到文件的声明也算数）', () => {
    // 两个页面文件都以 `share` 结尾：后缀匹配有歧义 → pages.json 那一条**落不到文件**，
    // 「这个文件已经被说过」这条压制用不上，只剩「同一条 route」这一条兜着。
    const index = indexOf({
      'src/pages.json': JSON.stringify({
        pages: [{ path: 'share', style: { navigationBarTitleText: '分享' } }],
      }),
      'src/pages/share/share.vue': '<template><view /></template>\n',
      'src/pages/legacy/share.vue': '<template><view /></template>\n',
    });
    expect(index.pages).toEqual([{ route: '/share', title: '分享', source: 'pages.json' }]);
  });

  it('pages.json 没提到的页面仍然有约定条目（source: convention）', () => {
    const index = indexOf({
      'src/pages.json': JSON.stringify({ pages: [{ path: 'pages/share/index' }] }),
      'src/pages/share/index.vue': '<template><view /></template>\n',
      'src/pages/invoice/apply.vue': '<template><view /></template>\n',
    });
    expect(index.pages).toContainEqual({ route: '/apply', title: null, source: 'convention' });
    expect(index.pages).toContainEqual({ route: '/pages/share/index', title: null, source: 'pages.json' });
  });
});
