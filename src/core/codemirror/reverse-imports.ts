/**
 * 反向导入图：**谁在引用这个文件**。
 *
 * 评估里最容易判错的一件事是「改一处 vs 改三处」。正向的 `index.imports` 只能回答
 * 「这个文件用了谁」，而评审问的正好是反面：「改这个 `SearchBar.vue` 会波及几个页面」。
 * 那个答案不在组件自己身上——它在**所有 import 过它的文件**里，所以必须把图翻过来。
 *
 * 三条契约，都是为了「材料可读」：
 * 1. **不制造空数组噪音**：没有入边的文件不出现在结果里。若给每个文件都留一格 `[]`，
 *    一份 142 个文件的索引就有 142 个键，而真正有用的可能只有 20 个。
 * 2. **自引用忽略**：`import` 自己（重导出、类型自引用）不能让一个文件「被自己引用」，
 *    否则材料里会出现「改它会波及 1 处：它自己」。
 * 3. **顺序固定**（键按字典序、值也按字典序）：同一份索引跑两次必须逐字相同。否则
 *    同一份材料每次生成的说法顺序都不一样，评审会以为看到了新东西。
 *
 * 它**不落库**：反向图完全由 `imports` 决定，而 `imports` 是装配期用**这一棵树**解析
 * 出来的（见 `code-index.ts` 的 `assembleIndex`）。存一份就等于再存一个会过期的副本。
 */
export function reverseImports(
  imports: Record<string, readonly string[]>,
): Record<string, string[]> {
  const map = new Map<string, Set<string>>();
  for (const from of Object.keys(imports)) {
    for (const to of imports[from] ?? []) {
      // 自引用不算「被引用」：那不是一次改动的影响面。
      if (to === from) continue;
      let set = map.get(to);
      if (set === undefined) {
        set = new Set();
        map.set(to, set);
      }
      set.add(from);
    }
  }
  const out: Record<string, string[]> = {};
  for (const [key, set] of [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out[key] = [...set].sort();
  }
  return out;
}
