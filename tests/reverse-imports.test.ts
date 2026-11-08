import { describe, expect, it } from 'vitest';

import { extractIndex, type CodeIndex } from '../src/core/codemirror/code-index.js';
import { reverseImports } from '../src/core/codemirror/reverse-imports.js';

/**
 * Task 3：反向导入图。
 *
 * 为什么这一层必须存在：评估里最容易判错的一件事是「改一处 vs 改三处」。正向的
 * `index.imports` 只能回答「这个文件用了谁」——那正好是**错的那一半**：评审要的
 * 是「改这个组件会波及几个页面」，而组件自己不知道谁在用它。三个用例一起钉的是
 * 三条契约：出边的方向、没有入边的不出现在结果里（不制造空数组噪音）、顺序稳定。
 */
describe('reverseImports', () => {
  it('把 文件→引用 翻成 被引用→文件', () => {
    const out = reverseImports({
      'pages/share/index.vue': ['components/SearchBar.vue'],
      'pages/fav/index.vue': ['components/SearchBar.vue'],
      'components/SearchBar.vue': [],
    });
    expect(out['components/SearchBar.vue']).toEqual([
      'pages/fav/index.vue',
      'pages/share/index.vue',
    ]);
  });

  it('没有入边的文件不出现在结果里（不制造空数组噪音）', () => {
    const out = reverseImports({ 'a.ts': ['b.ts'] });
    expect(Object.keys(out)).toEqual(['b.ts']);
  });

  it('结果稳定排序（同一个仓跑两次结果逐字相同）', () => {
    const once = reverseImports({ c: ['x'], a: ['x'], b: ['x'] });
    const twice = reverseImports({ b: ['x'], c: ['x'], a: ['x'] });
    expect(once).toEqual(twice);
  });

  it('自引用被忽略（import 自己不会让它出现在结果里）', () => {
    expect(reverseImports({ 'a.ts': ['a.ts'] })).toEqual({});
  });
});

/** 纯函数装配入口：只用来钉「装配时填了 importedBy」，不碰 git、不碰库。 */
function indexOf(files: Record<string, string>): CodeIndex {
  const paths = Object.keys(files);
  return extractIndex({
    repo: 'fixture-reverse',
    sha: '0123456789abcdef',
    all: paths,
    sources: paths.map((path) => ({ path, size: files[path]?.length ?? 0, text: files[path] ?? '' })),
  });
}

describe('装配：importedBy 由 imports 现算（不落库）', () => {
  it('装配出来的索引里，组件那一格写着引用它的页面', () => {
    const index = indexOf({
      'src/pages/share/index.vue': [
        '<template>',
        '  <SearchBar />',
        '</template>',
        '<script setup lang="ts">',
        "import SearchBar from '@/components/SearchBar.vue';",
        '</script>',
      ].join('\n'),
      'src/components/SearchBar.vue': '<template>\n  <div class="bar" />\n</template>\n',
      // 谁都没引用的那一页：它自己不能作为「被引用」出现。
      'src/pages/fav/index.vue': '<template>\n  <div class="fav" />\n</template>\n',
    });
    expect(index.importedBy['src/components/SearchBar.vue']).toEqual(['src/pages/share/index.vue']);
    expect(index.importedBy['src/pages/fav/index.vue']).toBeUndefined();
  });

  it('imports 里没有的路径不会凭空出现在 importedBy 里', () => {
    const index = indexOf({ 'src/pages/share/index.vue': '<template>\n  <div />\n</template>\n' });
    expect(index.importedBy).toEqual({});
  });
});
