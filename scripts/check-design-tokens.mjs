#!/usr/bin/env node
/**
 * 设计规范体检：把 silas-UX 的三条规矩变成会红的检查。
 *
 * 规矩的原文在 silas-UX `docs/usage.md`：
 *   1. 颜色只从变量取（不写十六进制）；
 *   2. 字号只从七档取（display / title-1 / title-2 / section / body / body-s / caption）；
 *   3. 间距只用 4 的倍数（4 / 8 / 12 / 16 / 24 / 32 / 48）。
 * 外加本仓库另外两条（同样来自同一份规范）：
 *   4. 圆角只有 xs(4) / sm(6) / md(10) / pill(999)，或 50%（正圆）；
 *   5. 动效时长只从 --d-fast / --d-base / --d-slow（120 / 200 / 320ms）。
 *
 * 为什么要写成脚本而不是写进评审清单：手抄的规范会漂（`app/tokens.css` 就漂过一版），
 * 而漂的过程没人看得见。写成断言之后，谁再写 `padding:10px`，`npm test` 就红。
 *
 * 用法：
 *   node scripts/check-design-tokens.mjs          # 人读报告
 *   node scripts/check-design-tokens.mjs --json   # 机器读（测试用）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS_ROOT = join(ROOT, 'app');

/** 间距规矩：4 的倍数（silas-UX docs/usage.md 第 3 条）。0 与 auto 放行。 */
const SPACE = { isAllowed: (n) => n === 0 || n % 4 === 0 };
const SPACING_PROPS = new Set([
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'gap', 'row-gap', 'column-gap',
]);
const TYPE_PROPS = new Set(['font', 'font-size', 'line-height']);
const RADIUS_PROPS = new Set(['border-radius']);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.css')) out.push(full);
  }
  return out;
}

function stripComments(css) {
  // 注释换成等量换行：保留行号，报告里的 `file:line` 才对得上编辑器。
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/** 声明级扫描：把 `prop: value` 从规则块里摘出来，带行号。 */
function declarations(css) {
  const noComments = stripComments(css);
  const out = [];
  const re = /([a-zA-Z-]+)\s*:\s*([^;{}]+)/g;
  let m;
  while ((m = re.exec(noComments)) !== null) {
    const line = noComments.slice(0, m.index).split('\n').length;
    out.push({ prop: m[1].toLowerCase(), value: m[2].trim(), line });
  }
  return out;
}

function definedColorVars(tokensCss) {
  const defined = new Set();
  for (const m of tokensCss.matchAll(/(--c-[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
  return defined;
}

const violations = [];
const record = (file, line, rule, detail) => violations.push({ file, line, rule, detail });

const tokenPath = join(CSS_ROOT, 'tokens.css');
const tokenCss = readFileSync(tokenPath, 'utf8');
const definedVars = definedColorVars(tokenCss);

for (const full of walk(CSS_ROOT)) {
  const rel = relative(ROOT, full);
  const source = readFileSync(full, 'utf8');
  const isTokens = full === tokenPath;

  // 规则 1：颜色字面量。tokens.css 是真源，字面值就该长在那儿。
  if (!isTokens) {
    const noComments = stripComments(source);
    for (const m of noComments.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g)) {
      const line = noComments.slice(0, m.index).split('\n').length;
      record(rel, line, 'color-literal', m[0]);
    }
  }

  for (const { prop, value, line } of declarations(source)) {
    // 规则 1b：引用了不存在的颜色变量。这类笔误不报错，只是**静默失效**——
    // 今天 globals.css 里的 `var(--c-danger)` 就是这种：文案继承了父色，错误态看不出来。
    if (!isTokens) {
      for (const m of value.matchAll(/var\((--c-[a-z0-9-]+)/g)) {
        if (!definedVars.has(m[1])) record(rel, line, 'color-undefined', m[1]);
      }
    }

    // 规则 2：字号 / 行高只从七档取。
    if (TYPE_PROPS.has(prop) && /\d+(\.\d+)?px/.test(value)) {
      record(rel, line, 'type-raw-px', `${prop}: ${value}`);
    }

    // 规则 3：间距只用 4 的倍数（0 与 auto 放行）。
    if (SPACING_PROPS.has(prop)) {
      for (const m of value.matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
        const n = Math.abs(Number(m[1]));
        if (!SPACE.isAllowed(n)) record(rel, line, 'space-off-scale', `${prop}: ${value}`);
      }
    }

    // 规则 4：圆角只从四档取，正圆写 50%。
    if (RADIUS_PROPS.has(prop)) {
      for (const m of value.matchAll(/(\d+(?:\.\d+)?)px/g)) {
        const n = Number(m[1]);
        if (![4, 6, 10, 999].includes(n)) {
          record(rel, line, 'radius-off-scale', `${prop}: ${value}`);
        }
      }
    }

    // 规则 5：动效时长只从三档取，并且不超过 320ms。
    if (prop === 'transition' || prop === 'animation-duration') {
      for (const m of value.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)) {
        const ms = m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
        // 0s 不是一档时长，是「这一半不要动」——抽屉的 visibility 就靠它。
        if (ms !== 0 && (![120, 200, 320].includes(ms) || ms > 320)) {
          record(rel, line, 'motion-off-scale', `${prop}: ${value}`);
        }
      }
    }

    // 规则 3b：内联尺寸不写死页面的流动——只拦「横向 padding 用 clamp/min」之外的事不管。
    // 这里刻意留空：宽度、高度是内容决定的，规范只管颜色、字号、间距。
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(violations, null, 2));
} else if (violations.length === 0) {
  console.log('设计规范体检通过：颜色 / 字号 / 间距 / 圆角 / 动效，零违规。');
} else {
  const byRule = new Map();
  for (const v of violations) {
    if (!byRule.has(v.rule)) byRule.set(v.rule, []);
    byRule.get(v.rule).push(v);
  }
  for (const [rule, list] of byRule) {
    console.log(`\n${rule}  (${list.length})`);
    for (const v of list) console.log(`  ${v.file}:${v.line}  ${v.detail}`);
  }
  console.log(`\n合计 ${violations.length} 处违规。`);
  process.exit(1);
}
