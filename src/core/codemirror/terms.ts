/**
 * 中文业务词 → 代码里的英文片段。
 *
 * 为什么这张表必须存在：PRD 写「搜索」，代码里叫 `search.vue`；PRD 写「分享」，
 * 代码里是 `share`。拿中文词去匹配英文路径**永远命中不了**，于是候选集全靠运气——
 * 实测挑到过 `app/downLoad/index.ts` 和 `src/enum/umengPoint.ts`，都不是这个功能。
 *
 * 这张表只做**翻译**，不参与任何判断：它把 PRD 的词换成能在路径/路由/符号里出现的
 * 片段，剩下的打分由 `locate()` 按固定权重做（见 `code-index.ts`）。放在这里而不是
 * 留在 `review.ts` 里，是因为现在有两个调用方（走查的候选集、评审的现状基线）——
 * 两份词表迟早会漂，而漂了之后「同一个 PRD 在两个阶段定位到不同文件」这件事没人查得出来。
 */

export const PATH_TERMS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['搜索', ['search']], ['分享', ['share']], ['目录', ['directory', 'dir']],
  ['面包屑', ['breadcrumb', 'crumbs']], ['排序', ['sort', 'order']],
  ['文件', ['file']], ['文件夹', ['folder', 'dir']], ['列表', ['list']],
  ['详情', ['detail']], ['登录', ['login', 'auth']], ['会员', ['vip', 'member']],
  ['短信', ['sms', 'message']], ['通知', ['notify', 'notification']],
  ['订单', ['order']], ['支付', ['pay', 'payment']], ['剪贴板', ['clipboard']],
  ['直链', ['direct', 'link']], ['限速', ['limit', 'rate']], ['上传', ['upload']],
  ['下载', ['download']], ['历史', ['history']], ['设置', ['setting', 'config']],
  ['多选', ['select', 'checkbox']], ['导航', ['nav', 'navigation']],
  ['移动端', ['mobile', 'h5', 'app']], ['首页', ['home', 'index']],
];

/** 一个中文词对应的英文路径片段（没有就空）。 */
export function pathTokens(word: string): string[] {
  const hit = PATH_TERMS.find(([cn]) => word.includes(cn) || cn.includes(word));
  return hit === undefined ? [] : [...hit[1]];
}

/** 一个关键词展开成的匹配片段：中文词过词表，外加它自己（ASCII 词原样用）。 */
export type Term = {
  /** PRD 里那个词，写进 `why` 用人看得懂。 */
  cn: string;
  /** 落到代码里要去匹配的小写片段（可能多个）。 */
  tokens: string[];
};

/**
 * 关键词 → 匹配片段。去重后保持稳定顺序（同一个 PRD 永远得到同一份），
 * 否则同 sha 的两次定位会给出不同的 `why`，报告就对不上了。
 */
export function expandTerms(keywords: readonly string[]): Term[] {
  const seen = new Set<string>();
  const out: Term[] = [];
  for (const raw of keywords) {
    const word = raw.trim();
    if (word === '') continue;
    const tokens = new Set<string>();
    for (const token of pathTokens(word)) {
      const low = token.toLowerCase();
      if (low !== '') tokens.add(low);
    }
    // ASCII 词（`H5`、`Upload`）原样参战：它本身就是代码里会出现的东西。
    if (/[a-z0-9]/i.test(word)) tokens.add(word.toLowerCase());
    const fresh = [...tokens].filter((token) => !seen.has(token));
    if (fresh.length === 0) continue;
    for (const token of fresh) seen.add(token);
    out.push({ cn: word, tokens: fresh });
  }
  return out;
}

/**
 * 到处都有的词：拿它们定位等于随机挑文件。
 *
 * 实测：「文件」「当前」「返回」「结果」「目录」让排第一的候选变成 `app/downLoad/index.ts`
 * （下载模块）——它不是这个功能的实现。这些词在 PRD 里出现频率高，但**不指向任何具体
 * 位置**：一份 141 个源码文件的仓里，「文件」命中 40 个，`search-entrance` 反而被挤到
 * 第十二名之外。
 *
 * 这张表原来只住在 `review.ts`（评审的现状基线用它过滤关键词），现在 `locate()`
 * 也用同一份：两个阶段对「什么词没有信息量」必须给出同一个答案，否则同一个 PRD
 * 在走查里选中 `search.vue`、在评审里选中 `file-list.vue`，没人解释得清为什么。
 *
 * 用法不是「一律丢掉」：`locate()` 的规矩是**非通用词一个都没命中时**才退回通用词
 * （见 `code-index.ts` 的 `locate`）。只讲「文件」的 PRD，那时通用词就是它全部的线索。
 */
export const GENERIC_WORDS: ReadonlySet<string> = new Set([
  '文件', '当前', '返回', '结果', '目录', '上一级', '支持', '需要', '可以', '进行',
  '展示', '操作', '页面', '功能', '设置', '进入', '点击', '选择', '内容', '数据',
  '新增', '增加', '优化', '调整', '统一', '确认', '记录', '显示', '以下', '上述',
]);

/** 这个词是不是「不指向任何具体位置」。 */
export function isGenericWord(word: string): boolean {
  return GENERIC_WORDS.has(word.trim());
}
