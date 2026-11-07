/**
 * 「旧描述 → 六问」的一次性工具（P4-08）。
 *
 *   npx tsx scripts/split-description.ts --file tests/fixtures/prd-pan6.md
 *   npx tsx scripts/split-description.ts --file tests/fixtures/prd-pan6.md --dry-run
 *
 * 与界面上那个「从原文拆六问」是**同一个函数**（`src/core/uemaster/intake.ts` 的
 * `splitDescription`）。这个脚本存在的理由：拆分的结果要能被贴进报告、被 diff、
 * 被第二次、第三次跑同一份输入——而一个按钮做不到这些。
 *
 * ## `--dry-run` 是什么
 *
 * **不调模型**。它打印：文件有多少字、标题取的是哪一行、提示词有多长、当前解析到的
 * 模型配置是「哪一层」（env / 成员 / 平台）与三个值是否存在——**绝不打印 key 本身**。
 * 用途是「这个文件会不会把提示词撑爆」「我的 key 到底配上了没有」这类问题，
 * 不必先花一次调用。
 *
 * ## 口径（与界面完全一致）
 *
 * 六问里每一格都必须有**逐字引文**；原文没说的格子是空的，并列进 `missing`；
 * `notes` 里 `←` 是用了的原文片段、`⨯` 是被丢掉的（引文在原文里找不到）。
 * 这就是「这段旧描述能不能变成可用的六问」的答案，脚本只负责把它摆出来。
 *
 * 输出格式刻意朴素（一行一格 + 计数），因为它的读者是报告与终端里的人：
 *
 *   ✔/✘ 六个字段各一段
 *   missing: 2 格（problem、out_of_scope）
 *   notes:   4 条（3 采用 / 1 丢弃）
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../src/db/client.js';
import { resolveProvider } from '../src/core/uemaster/provider.js';
import { splitDescription, SPLIT_KEYS, rejectedCount } from '../src/core/uemaster/intake.js';
import { DESCRIPTIVE_FIELDS } from '../src/core/requirements/fields.js';

/**
 * snake_case 的六格 → 界面上的中文标签。从 `DESCRIPTIVE_FIELDS` 反推（`edgeCases`
 * → `edge_cases`），因为「标签只有一个来源」这件事不该在这个脚本里破一次。
 */
const LABEL: Record<string, string> = Object.fromEntries(
  DESCRIPTIVE_FIELDS.map((field) => [
    field.key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`),
    field.label,
  ]),
);

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  const next = process.argv[index + 1];
  return next === undefined || next.startsWith('--') ? '' : next;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** 标题：第一个 markdown 标题；没有就用文件名。模型需要知道它在拆什么。 */
function titleOf(markdown: string, file: string): string {
  for (const line of markdown.split('\n')) {
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match !== null) return match[1]!;
  }
  return path.basename(file);
}

/** 一格里的一行：多行内容缩进对齐，读起来还是一格。 */
function block(text: string): string {
  if (text === '') return '  （空）';
  return text.split('\n').map((line) => `  ${line}`).join('\n');
}

async function main(): Promise<void> {
  const file = arg('file') ?? '';
  if (file === '') {
    process.stderr.write('用法：npx tsx scripts/split-description.ts --file <path> [--dry-run]\n');
    process.exitCode = 2;
    return;
  }

  const markdown = await readFile(file, 'utf8');
  const title = titleOf(markdown, file);

  process.stdout.write(`文件：${file}\n`);
  process.stdout.write(`标题：${title}\n`);
  process.stdout.write(`原文：${markdown.length} 字\n`);

  const resolved = await resolveProvider(undefined);
  if (resolved === null) {
    process.stderr.write(
      '\n未配置模型接口：env 的三个变量没有设，库里也没有完整的「接口地址 + API Key + 模型名」。\n'
      + '去「设置」里填，或用 FLOWERS_PROVIDER_BASE_URL / FLOWERS_PROVIDER_API_KEY / FLOWERS_PROVIDER_MODEL 注入。\n',
    );
    process.exitCode = 1;
    return;
  }

  // 只报「哪一层 + 三个值在不在」，**不打印值**：它可能是别人的 key。
  const { config, scope } = resolved;
  process.stdout.write(
    `模型：${scope} 层 · ${config.model} · 地址 ${config.baseUrl} · key ${config.apiKey === '' ? '缺' : '已配'}\n`,
  );

  if (has('dry-run')) {
    process.stdout.write('\n--dry-run：不调模型。提示词长度 '
      + `${markdown.length + 900} 字（含六问的说明），六格全部留空待填。\n`);
    return;
  }

  const started = Date.now();
  const result = await splitDescription(config, { title, description: markdown });
  const ms = Date.now() - started;

  process.stdout.write(`\n── 六问（${ms}ms） ─────────────────────────────────────\n`);
  for (const key of SPLIT_KEYS) {
    const label = LABEL[key] ?? key;
    const marker = result[key] === '' ? '✘' : '✔';
    process.stdout.write(`\n${marker} ${key}（${label}）\n${block(result[key])}\n`);
  }

  const filled = SPLIT_KEYS.filter((key) => result[key] !== '').length;
  process.stdout.write('\n── 计数 ────────────────────────────────────────────────\n');
  process.stdout.write(`filled:  ${filled} / ${SPLIT_KEYS.length}\n`);
  process.stdout.write(`missing: ${result.missing.length} 格`
    + `${result.missing.length === 0 ? '' : `（${result.missing.join('、')}）`}\n`);
  process.stdout.write(`notes:   ${result.notes.length} 条`
    + `（采用 ${result.notes.length - rejectedCount(result)} / 丢弃 ${rejectedCount(result)}）\n`);

  process.stdout.write('\n── 依据（notes） ───────────────────────────────────────\n');
  for (const note of result.notes) process.stdout.write(`${note}\n`);
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => {
  // 这个脚本只读库（配不配模型），所以连接用完就关，进程不会挂着。
  void pool.end();
});
