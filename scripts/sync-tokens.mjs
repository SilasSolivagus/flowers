#!/usr/bin/env node
/**
 * 从 vendor/silas-ux/tokens.json 生成 app/tokens.css。
 *
 * 为什么要有这个脚本：`app/tokens.css` 以前是从 silas-UX 手抄过来的，抄的那一刻就
 * 开始漂——文件头还写着 v1.0.0，而真源已经 v1.2.0（多了 `info`、深色档的 weak 色、
 * 三栏断点）。手抄的副本没有版本戳、没有校验，谁也说不清它到底对应哪一版规范。
 *
 * 现在它只有一个来源：`vendor/silas-ux/` 里的 tokens.json + COMMIT 戳，
 * 这个脚本把 json 展开成 CSS 变量。改规范 = 更新 vendor 目录 + `npm run tokens:sync`。
 *
 * 规矩（见 silas-UX docs/usage.md）：颜色只从变量取、字号只从七档取、间距只用 4 的倍数。
 * 脚本只做翻译，不发明数值——唯一的例外是下面 DERIVED 里那几个：真源的深色档没写
 * weak 底色（`positive-weak` 等）和遮罩，而界面在深色下要用，于是用 `color-mix()` 从
 * 已有变量推导，不落任何字面色值。
 *
 * 用法：
 *   node scripts/sync-tokens.mjs           # 生成 app/tokens.css
 *   node scripts/sync-tokens.mjs --check   # 只校验是否最新，不一致退出 1
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor', 'silas-ux');
const TOKENS_JSON = join(VENDOR, 'tokens.json');
const COMMIT_FILE = join(VENDOR, 'COMMIT');
const OUT = join(ROOT, 'app', 'tokens.css');

const tokens = JSON.parse(readFileSync(TOKENS_JSON, 'utf8'));
const commit = existsSync(COMMIT_FILE) ? readFileSync(COMMIT_FILE, 'utf8').trim().slice(0, 7) : 'unknown';

/** 深色档缺的变量：从真源已有变量推导，不新增色值。 */
const DERIVED_DARK = {
  'positive-weak': 'color-mix(in srgb, var(--c-positive) 16%, var(--c-surface))',
  'negative-weak': 'color-mix(in srgb, var(--c-negative) 16%, var(--c-surface))',
  'warning-weak': 'color-mix(in srgb, var(--c-warning) 18%, var(--c-surface))',
  'info-weak': 'color-mix(in srgb, var(--c-info) 16%, var(--c-surface))',
  scrim: 'color-mix(in srgb, black 60%, transparent)',
};

const SIZE_NAMES = {
  'control-h': 'control',
  'control-h-phone': 'control-phone',
  'row-h': 'row',
  'row-h-dense': 'row-dense',
  'topbar-h': 'topbar',
  'nav-h-phone': 'nav-phone',
  'status-h-phone': 'status-phone',
  'btn-h-phone': 'btn-phone',
  'device-phone-min-h': 'device-phone-min',
  'table-head-h': 'table-head',
};

const BP_NAMES = {
  phone: 'phone',
  tablet: 'tablet',
  'three-col-phone': 'three-col-phone',
  'three-col-wide': 'three-col-wide',
  laptop: 'laptop',
  desktop: 'desktop',
};

function colorBlock(mode) {
  const c = tokens.color[mode];
  const lines = [];
  for (const [key, item] of Object.entries(c)) {
    const value = typeof item === 'object' && item !== null ? item.value : item;
    if (value === undefined) continue;
    lines.push(`  --c-${key}: ${value};`);
  }
  if (mode === 'dark') {
    for (const [key, expr] of Object.entries(DERIVED_DARK)) {
      if (c[key]) continue; // 真源哪天补上了，就让真源说话
      lines.push(`  --c-${key}: ${expr};`);
    }
  }
  return lines;
}

const type = tokens.type;
const scale = type.scale;

function build() {
  const out = [];
  out.push(`/* silas-UX 设计变量 v${tokens.meta.version} · 由 scripts/sync-tokens.mjs 生成，勿手改`);
  out.push(`   真源：vendor/silas-ux/tokens.json（silas-UX@${commit}）`);
  out.push(`   更新：npm run tokens:sync    校验：npm run tokens:check`);
  out.push(`   规矩：颜色只从变量取 · 字号只从七档取 · 间距只用 4 的倍数 */`);
  out.push('');
  out.push(':root {');
  out.push('  color-scheme: light;');
  out.push(...colorBlock('light'));
  out.push('');
  out.push(`  --f-sans: ${type.family};`);
  out.push(`  --f-num: ${type['family-num']};`);
  out.push(`  --f-mono: ${type['family-mono']};`);
  out.push('');
  for (const [step, v] of Object.entries(scale)) {
    out.push(`  --t-${step}: ${v.size}px/${v.line}px;`);
  }
  out.push('');
  for (const [step, v] of Object.entries(scale)) {
    out.push(`  --tw-${step}: ${v.weight};`);
  }
  out.push('');
  out.push(
    Object.entries(tokens.space)
      .map(([k, v]) => `  --s-${k}: ${v === 0 ? 0 : `${v}px`};`)
      .join('\n'),
  );
  out.push('');
  out.push(
    Object.entries(tokens.radius)
      .map(([k, v]) => `  --r-${k}: ${v}px;`)
      .join('\n'),
  );
  out.push('');
  out.push(`  --sh-overlay: ${tokens.shadow.overlay};`);
  out.push('');
  out.push(
    [
      `--d-fast: ${tokens.motion['duration-fast']}ms;`,
      `--d-base: ${tokens.motion['duration-base']}ms;`,
      `--d-slow: ${tokens.motion['duration-slow']}ms;`,
    ].join(' '),
  );
  out.push(`  --e-standard: ${tokens.motion['easing-standard']};`);
  out.push('');
  const sizes = Object.entries(tokens.size)
    .filter(([k]) => SIZE_NAMES[k])
    .map(([k, v]) => `--h-${SIZE_NAMES[k]}: ${v}px;`);
  out.push(sizes.join(' '));
  out.push('');
  out.push('  /* 布局断点：媒体查询里写数值（CSS 的 @media 不能读 var()），这些变量供 JS 与 @container 用 */');
  const bps = Object.entries(tokens.breakpoint)
    .filter(([k]) => BP_NAMES[k])
    .map(([k, v]) => `--bp-${BP_NAMES[k]}: ${v}px;`);
  out.push(bps.join(' '));
  out.push('}');
  out.push('');
  /*
   * 深色档写两份，因为「谁决定深色」有两个来源：
   * - `[data-theme="dark"]`：用户亲手点过的（顶栏三档开关，见 app/components/theme-pref.ts）；
   * - `@media (prefers-color-scheme: dark)`：没点过的用户跟随系统——服务端不知道这件事，
   *   只能由浏览器裁。`:not([data-theme])` 保证用户的选择永远优先于系统设置。
   */
  out.push(darkBlock('[data-theme="dark"]'));
  out.push('');
  out.push('@media (prefers-color-scheme: dark) {');
  out.push('  :root:not([data-theme]) {');
  out.push('    color-scheme: dark;');
  out.push(...colorBlock('dark').map((line) => `  ${line}`));
  out.push('  }');
  out.push('}');
  out.push('');
  return out.join('\n');
}

function darkBlock(selector) {
  return [
    `${selector} {`,
    '  color-scheme: dark;',
    ...colorBlock('dark'),
    '}',
  ].join('\n');
}

const css = build();

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== css) {
    console.error('app/tokens.css 与 vendor/silas-ux/tokens.json 不一致：先跑 npm run tokens:sync');
    process.exit(1);
  }
  console.log('app/tokens.css 与真源一致 (silas-UX@' + commit + ')');
} else {
  writeFileSync(OUT, css);
  console.log(`已生成 app/tokens.css ← silas-UX@${commit} v${tokens.meta.version}`);
}
