#!/usr/bin/env tsx
/**
 * A/B 对比：同一份 PRD，两条「摸现状」的路径各跑一遍。
 *
 *   A = 现在线上的做法：抽中文关键词 → 每个词一趟 ssh `git grep` → 按路径/正文命中打分
 *   B = 静态索引：查 code_index → 按路由/文件名/导入/符号打分
 *
 * 比三样东西，缺一不可：
 *   1. **耗时**（A 是 ssh 往返的累加，B 应该是一次查表）
 *   2. **选中的文件**（顺序就是评分顺序，第一名最重要）
 *   3. **进提示词的字符量**（A 是文件正文全文，B 是候选清单）
 *
 * 用法：
 *   npx tsx scripts/compare-locate.ts                       # 默认 PAN-6 的 PRD
 *   npx tsx scripts/compare-locate.ts --prd <file>          # 指定 PRD
 *   npx tsx scripts/compare-locate.ts --repos 123pan-uni-app
 */
import { readFileSync } from 'node:fs';

import * as mirror from '../src/core/codemirror/mirror.js';
import { keywordsFrom } from '../src/core/uemaster/inspect.js';
import { pool } from '../src/db/client.js';


// ─── A 那半边的算法：**从 HEAD 的 review.ts 原样冻结下来** ──────────────────
//
// 为什么不直接调 `gatherBaseline`：索引那一步正在把它的内部换掉。一旦换完，
// 「和它比」就变成「和新版比」——A 消失了，对比也就没意义了。
// 所以把老算法抄一份钉在这里：它永远代表「改之前线上跑的那一套」。

/** 到处都有的词，拿它们定位等于随机挑文件。 */
const STOP_WORDS = new Set([
  '文件', '当前', '返回', '结果', '目录', '上一级', '支持', '需要', '可以', '进行',
  '展示', '操作', '页面', '功能', '设置', '进入', '点击', '选择', '内容', '数据',
  '新增', '增加', '优化', '调整', '统一', '确认', '记录', '显示', '以下', '上述',
]);

/** 中文业务词 → 代码里的英文片段。 */
const PATH_TERMS: Array<[string, string[]]> = [
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

function pathTokens(word: string): string[] {
  const hit = PATH_TERMS.find(([cn]) => word.includes(cn) || cn.includes(word));
  return hit === undefined ? [] : hit[1];
}

const FEATURE_PATH = /(^|\/)(pages?|views?|screens?|components?|services?|api|store|hooks)\//i;
const CODE_EXT = /\.(tsx?|jsx?|vue)$/i;
const BASELINE_FILES = 6;
const BASELINE_BYTES = 28_000;

const DEFAULT_PRD = 'tests/fixtures/prd-pan6.md';
const DEFAULT_REPOS = ['123pan-pc', '123pan-uni-app'];
/** 这个功能**应该**被选中的两个文件——验收基准，来自人工核对。 */
const EXPECT = [
  'src/pages/search/search.vue',
  'src/components/search-entrance/search-entrance.vue',
];

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const prdFile = arg('--prd') ?? DEFAULT_PRD;
const repos = (arg('--repos') ?? DEFAULT_REPOS.join(',')).split(',').map((s) => s.trim());

const text = readFileSync(prdFile, 'utf8');
const title = prdFile.split('/').pop() ?? prdFile;

type Picked = { repo: string; path: string; why: string };

/** A：改之前线上跑的那一套（冻结的算法，见上面那段注释）。 */
async function runA(): Promise<{ ms: number; picked: Picked[]; chars: number }> {
  const keywords = keywordsFrom(text, title).filter((w) => !STOP_WORDS.has(w) && w.length >= 2);
  const started = Date.now();
  const picked: Picked[] = [];
  let chars = 0;

  for (const repo of repos) {
    const tree = await mirror.lsTree(repo);
    if (!tree.ok) continue;
    const pool = new Set(tree.data.filter((p) => FEATURE_PATH.test(p) && CODE_EXT.test(p)));

    const hits = new Map<string, { content: number; path: number }>();
    const bump = (path: string, field: 'content' | 'path'): void => {
      const cur = hits.get(path) ?? { content: 0, path: 0 };
      cur[field] += 1;
      hits.set(path, cur);
    };
    for (const path of pool) {
      const low = path.toLowerCase();
      for (const word of keywords) {
        if (low.includes(word.toLowerCase())) bump(path, 'path');
        else if (pathTokens(word).some((t) => low.includes(t))) bump(path, 'path');
      }
    }
    // 正文命中：一个词一趟 ssh —— A 慢就慢在这里。
    for (const word of keywords) {
      const found = await mirror.grep(repo, word, { max: 60 });
      if (!found.ok) continue;
      for (const hit of found.data) if (pool.has(hit.path)) bump(hit.path, 'content');
    }

    const ranked = [...hits.entries()]
      .filter(([, v]) => v.path > 0)
      .sort((a, b) => (b[1].path * 10 + b[1].content) - (a[1].path * 10 + a[1].content)
        || a[0].localeCompare(b[0]))
      .slice(0, BASELINE_FILES)
      .map(([path]) => path);

    let left = BASELINE_BYTES;
    for (const path of ranked) {
      picked.push({ repo, path, why: '' });
      if (left <= 0) continue;
      const body = await mirror.show(repo, path, { maxBytes: Math.min(left, 6_000) });
      if (body.ok) { left -= body.data.length; chars += body.data.length; }
    }
  }

  return { ms: Date.now() - started, picked, chars };
}

/**
 * B：静态索引那条路。
 *
 * 用动态导入：B 还没落地时这个脚本仍然能跑完 A 并把 A 的数字报出来，而不是整个失败——
 * 「对比脚本本身跑不起来」是最没用的失败方式。
 */
async function runB(deps: { db: unknown }): Promise<{ ms: number; picked: Picked[]; chars: number } | null> {
  let locateAcross: unknown;
  let repoIndex: unknown;
  let heads: unknown;
  try {
    ({ locateAcross } = await import('../src/core/codemirror/code-index.js'));
    ({ repoIndex } = await import('../src/core/codemirror/index-store.js'));
    ({ head: heads } = await import('../src/core/codemirror/mirror.js'));
  } catch {
    return null;
  }
  if (typeof locateAcross !== 'function' || typeof repoIndex !== 'function') return null;

  const keywords = keywordsFrom(text, title);
  const started = Date.now();
  const picked: Picked[] = [];

  // 索引先全部拿到，**再**一起定位：B 走的是生产那条路（`locateAcross`），
  // 不是每仓各自 `locate` —— 后者会让 pc 的「文件」噪音排到 search.vue 前面。
  const collected: Array<{ repo: string; index: unknown }> = [];
  for (const repo of repos) {
    // 先钉住这个仓的 HEAD sha：索引的主键是 (repo, sha)，钉错了就是拿旧索引解释新代码。
    const head = (await (heads as (r: string) => Promise<unknown>)(repo)) as
      | { ok: boolean; data?: { sha: string } | null };
    const sha = head.ok ? head.data?.sha : undefined;
    if (sha === undefined) continue;

    const built = (await (repoIndex as (...a: unknown[]) => Promise<unknown>)(
      deps.db, repo, sha, {},
    )) as { ok: boolean; data?: { index: unknown; built: boolean; buildMs: number } };
    if (!built.ok || built.data === undefined) continue;
    collected.push({ repo, index: built.data.index });
  }

  const across = (locateAcross as (...a: unknown[]) => unknown)(
    collected, keywords, { limit: 6 },
  ) as Map<string, { source: string; probes?: Array<{ path: string; why?: string }> }>;
  for (const repo of repos) {
    const chosen = across.get(repo);
    if (chosen === undefined || chosen.source !== 'index') continue;
    for (const p of chosen.probes ?? []) picked.push({ repo, path: p.path, why: p.why ?? '' });
  }

  return { ms: Date.now() - started, picked, chars: JSON.stringify(picked).length };
}

function rankOf(picked: Picked[], want: string): string {
  const i = picked.findIndex((p) => p.path === want);
  return i < 0 ? '未选中' : `第 ${i + 1} 位`;
}

function report(label: string, r: { ms: number; picked: Picked[]; chars: number }): void {
  console.log(`\n── ${label} ─────────────────────────────────────────`);
  console.log(`耗时        ${r.ms} ms`);
  console.log(`进提示词    ${r.chars} 字符`);
  console.log(`选中 ${r.picked.length} 个文件：`);
  r.picked.forEach((p, i) => {
    const why = p.why === '' ? '' : `   ← ${p.why}`;
    console.log(`  ${String(i + 1).padStart(2)}. ${p.repo}:${p.path}${why}`);
  });
  console.log('验收基准：');
  for (const want of EXPECT) console.log(`  ${rankOf(r.picked, want).padEnd(8)} ${want}`);
}

const { db } = await import('../src/db/client.js');
const a = await runA();
const b = await runB({ db }).catch((error: unknown) => {
  console.log(`\n（B 跑失败：${error instanceof Error ? error.message : String(error)}）`);
  return null;
});

console.log(`PRD：${prdFile}（${text.length} 字）`);
console.log(`仓库：${repos.join(' / ')}`);

report('A · 现在（ssh grep）', a);
if (b === null) {
  console.log('\n── B · 静态索引 ─────────────────────────────────────');
  console.log('（还没落地：src/core/codemirror/code-index.ts 没导出 locate）');
} else {
  report('B · 静态索引', b);
  console.log('\n── 对比 ────────────────────────────────────────────');
  const speed = a.ms === 0 ? '—' : `${(a.ms / Math.max(b.ms, 1)).toFixed(1)}×`;
  console.log(`耗时      ${a.ms} ms → ${b.ms} ms（${speed}）`);
  console.log(`字符量    ${a.chars} → ${b.chars}`);
}

await pool.end();
