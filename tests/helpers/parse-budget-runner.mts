#!/usr/bin/env tsx
/**
 * 子进程里的解析跑腿：**只因为父用例需要一个能真正掐断的预算**。
 *
 * 为什么不能在同一进程里用 `vi.waitFor` / `AbortSignal` / `testTimeout` 守：
 * 正则退化与「匹配永不前进」都是**同步**的——事件循环整个堵死，定时器与 abort 回调
 * 一次都轮不到。2026-11-09 那次事故就是这个形状：`platform-fontend` 的索引挂住 20 分钟，
 * 而 `onboard-repos.ts` 里 240 s 的看门狗**连响都没响**（它的注释里记着这件事）。
 * 唯一能停下一个同步死循环的东西是**另一个进程**把信号发进来。
 *
 * 因此：本文件被父用例用 `execFile(tsx, …)` 拉起，父进程只负责 `timeout` + SIGKILL。
 * 每一行结果都走 `fs.writeSync(1, …)` 直接写 fd——挂在第 4 个形状时，前 3 行必须已经
 * 到了父进程手上，否则「哪个形状挂的」又是一次猜。
 *
 * 用法（父用例用）：
 *   tsx tests/helpers/parse-budget-runner.mts --fixture <file> <path>
 *   tsx tests/helpers/parse-budget-runner.mts --shapes
 *   tsx tests/helpers/parse-budget-runner.mts --behavior
 *
 * 输出：每行一个 JSON 对象。
 *   {"kind":"fixture","ms":1.2,"outline":[…],"symbols":[…],"specs":[…]}
 *   {"kind":"shape","name":"long-attr-list","bytes":58929,"ms":6.7,"outline":1,"symbols":0}
 *   {"kind":"behavior","withDefine":["SearchEntrance"],"withoutDefine":[]}
 *
 * `--behavior` 存在的理由：口径用例（「`name:` 仍能抽出组件名」）**不能在父进程里跑**。
 * 它调的 `exportsOf` 正是挂住过的那条路径——修复被打回时，父进程会被同一个死循环按住，
 * 于是整份用例**既不红也不绿**（实测：vitest 300 s 不退出，比红更糟）。把它也搬进子进程，
 * 「违反」就变成一条能读到的失败，而不是一条挂起的 CI。
 */
import { writeSync } from 'node:fs';
import { readFileSync } from 'node:fs';

import { exportsOf, parseBlob } from '../../src/core/codemirror/code-index.js';

import { PATHOLOGICAL_SHAPES } from '../helpers/parse-shapes.js';

function emit(value: unknown): void {
  writeSync(1, `${JSON.stringify(value)}\n`);
}

const argv = process.argv.slice(2);
const mode = argv[0] ?? '';

if (mode === '--fixture') {
  const file = argv[1] ?? '';
  const repoPath = argv[2] ?? 'index.vue';
  const text = readFileSync(file, 'utf8');
  const t0 = performance.now();
  const parsed = parseBlob(text, repoPath, text);
  emit({
    kind: 'fixture',
    ms: Number((performance.now() - t0).toFixed(3)),
    bytes: text.length,
    outline: parsed.outline,
    symbols: parsed.symbols,
    specs: parsed.refs.specs,
  });
} else if (mode === '--behavior') {
  const withDefine = "<script>export default defineComponent({ name: 'SearchEntrance', setup() { return {} } })</script>";
  const withoutDefine = "<script>export default { name: 'PlainComp' }</script>";
  emit({
    kind: 'behavior',
    withDefine: exportsOf(withDefine, 'index.vue'),
    withoutDefine: exportsOf(withoutDefine, 'index.vue'),
  });
} else if (mode === '--shapes') {
  for (const shape of PATHOLOGICAL_SHAPES) {
    const t0 = performance.now();
    const parsed = parseBlob(shape.text, shape.path, shape.text);
    emit({
      kind: 'shape',
      name: shape.name,
      bytes: shape.text.length,
      ms: Number((performance.now() - t0).toFixed(3)),
      outline: parsed.outline.length,
      symbols: parsed.symbols.length,
    });
  }
} else {
  writeSync(2, '用法：--fixture <file> <path> | --shapes\n');
  process.exit(2);
}
