import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../src/core/runtime-dir.js';

import { PATHOLOGICAL_SHAPES } from './helpers/parse-shapes.js';

/**
 * 2026-11-09 的事故守卫：一个 903 字节的 `.vue` 把整晚的索引按住了。
 *
 * ── 事故的形状（写清是因为它长得不像它看起来那样）
 *
 * `src/components/SvgIcon/index.vue`（platform-fontend，903 字节，里面有一句
 * `export default defineComponent({…})`）让 `platform-fontend` 与 `fe-tool` 两个仓的
 * 索引**永远不返回**：180 秒墙钟、0 进展、CPU 烧满（`time 180s` 实测 user 2m37s）。
 * 采样栈停在 `RegExpPrototypeExec`，第一反应是「灾难性回溯」——**不是**。
 *
 * 真因在 `exportsOf` 的那一圈循环上：
 *
 *     const COMPONENT_NAME = /\bdefineComponent\s*\(|name\s*:\s*['"]([\w$-]+)['"]/;   // 没有 g
 *     for (let m = COMPONENT_NAME.exec(text); m !== null; m = COMPONENT_NAME.exec(text)) { … }
 *
 * **不带 `g` 的 `exec` 每次都从下标 0 重新开始**，于是在一个有 `defineComponent` 的文件里
 * 它每次都命中同一个 `defineComponent(`，`lastIndex` 永远是 0，循环永不结束——15 秒 580 万次
 * `exec`。回溯是「一次 exec 太久」，这里是「exec 次数无限」；两者在栈上都只看得见
 * `RegExpPrototypeExec`，所以只能靠**实测**分辨（见报告里的探针表）。
 *
 * ── 为什么这些用例必须跑在子进程里
 *
 * 同步死循环把事件循环整个堵死：`testTimeout`、`vi.waitFor`、`AbortSignal` 一次都轮不到。
 * `onboard-repos.ts` 里那条 240 s 的看门狗在事故当晚就是这么失效的（它的注释记着这件事）。
 * 唯一能停下它的是别的进程发信号，所以这里 `execFile(tsx, …)` + `SIGKILL`，
 * 预算名字就叫 `PARSE_BUDGET_MS`。
 */

/** 一个形状的解析预算（毫秒）。**守卫的名字**：报告里的「硬预算」就是它。 */
const PARSE_BUDGET_MS = 2000;

/**
 * 子进程启动余量：预算只管**解析**那一行（子进程自己用 `performance.now()` 量的毫秒），
 * 不管 `node` + `tsx` 冷启动要多久（实测 0.9–1.3 s）。两者相加才是父进程的击杀线，
 * 这样「慢在启动」不会被误报成「解析退化」。
 */
const CHILD_STARTUP_ALLOWANCE_MS = 8000;

const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const RUNNER = path.join(REPO_ROOT, 'tests', 'helpers', 'parse-budget-runner.mts');

type ChildRun = {
  /** 解析器自己的毫秒（子进程量的）；被杀时为 null。 */
  lines: Record<string, unknown>[];
  timedOut: boolean;
  code: number | null;
};

/**
 * 跑一次子进程。`timedOut` 是这条用例唯一能观察到「挂住」的信号：被杀时 `status` 是 null、
 * stdout 只剩挂在那一行之前的内容。
 */
function runChild(args: readonly string[]): ChildRun {
  const result = runWithBudget(args);
  const parsed: Record<string, unknown>[] = [];
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue;
    try {
      parsed.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // 非 JSON 行（tsx 的告警）直接丢：只有 runner 打的那些行是契约。
    }
  }
  return { lines: parsed, timedOut: result.timedOut, code: result.code };
}

/**
 * 阻塞跑一次子进程，超时就 SIGKILL。
 *
 * 为什么是 `spawnSync` 而不是 async 的 `execFile` + `Promise.race`：`Promise.race` 在
 * 同步死循环面前同样轮不到执行——它等的是「另一个回调有机会跑」，而这里正是没有机会。
 * `spawnSync` 的 `timeout` 由父进程的 libuv 计时，子进程堵不堵死与它无关。
 */
function runWithBudget(args: readonly string[]): { stdout: string; code: number | null; timedOut: boolean } {
  const run = spawnSync(TSX, [RUNNER, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: PARSE_BUDGET_MS + CHILD_STARTUP_ALLOWANCE_MS,
    killSignal: 'SIGKILL',
    env: { ...process.env, TZ: process.env.TZ ?? 'Asia/Shanghai' },
    maxBuffer: 8 * 1024 * 1024,
  });
  const timedOut = (run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  return { stdout: run.stdout ?? '', code: run.status, timedOut };
}

describe('解析器的线性性：903 字节的 SvgIcon/index.vue 与病态形状', () => {
  it('真实事故文件：在 PARSE_BUDGET_MS 内解析完，且 outline 与符号是这份内容应有的样子', () => {
    const fixture = path.join(REPO_ROOT, 'tests', 'fixtures', 'svg-icon-index.vue');
    const run = runChild(['--fixture', fixture, 'src/components/SvgIcon/index.vue']);

    // 修复前：这一行永远不会到。父进程 10 s 后 SIGKILL，`--fixture` 一行都打不出来。
    expect(run.timedOut).toBe(false);
    expect(run.code, '子进程被信号杀掉 = 解析没有前进').toBe(0);

    const line = run.lines.at(-1);
    expect(line, '子进程没打出结果行').toBeDefined();
    if (line === undefined) return;

    expect(line.kind).toBe('fixture');
    // 字节数是这条用例的锚：内容被谁改了（哪怕多一个空行），这份用例就该被重新看一眼。
    expect(line.bytes).toBe(903);
    expect(Number(line.ms)).toBeLessThan(PARSE_BUDGET_MS);

    // outline 空是**正确答案**：这份 template 里只有 `svg` / `use` 两个小写标签，
    // 而 outline 的口径是「大写开头的组件」（`div`/`svg` 不是我们维护的东西）。
    expect(line.outline).toEqual([]);
    // 符号也空：`<script>` 不是 `<script setup>`，文件里也没有 `export const/function`；
    // `defineComponent({…})` 里没有 `name:`，所以那一支本来就不该产出名字。
    expect(line.symbols).toEqual([]);
    expect(line.specs).toEqual([]);
  });

  it('病态形状各自在 PARSE_BUDGET_MS 内跑完（长属性串 / 深层嵌套 / 长未闭合标签 / 巨型单行 / 大写长游程）', () => {
    const run = runChild(['--shapes']);

    expect(run.timedOut, '至少一个形状把子进程挂住了').toBe(false);
    expect(run.code).toBe(0);

    // 行数必须齐：挂在第 4 个形状时只有 3 行，而「少一行」本身就是失败信号。
    expect(run.lines.length).toBe(PATHOLOGICAL_SHAPES.length);
    const seen = run.lines.map((line) => String(line.name));
    expect(seen).toEqual(PATHOLOGICAL_SHAPES.map((shape) => shape.name));

    for (const line of run.lines) {
      const ms = Number(line.ms);
      const bytes = Number(line.bytes);
      expect(ms, `形状 ${String(line.name)}（${bytes} 字节）超预算`).toBeGreaterThanOrEqual(0);
      expect(ms, `形状 ${String(line.name)}（${bytes} 字节）超预算`).toBeLessThan(PARSE_BUDGET_MS);
    }
  });
});

describe('类别守卫：exec 循环驱动的正则必须带 g', () => {
  /**
   * 这一类 = 「匹配永不前进」。它比回溯更难发现，因为
   * 1. 单条正则本身完全正常（`COMPONENT_NAME` 一秒就能在 903 字节里找到匹配）；
   * 2. 只有在**被 exec 循环驱动**时才变成死循环；
   * 3. 表现与回溯一模一样（栈停在 `RegExpPrototypeExec`、CPU 烧满、无输出）。
   *
   * 所以守卫不写在业务用例里，而是扫源码：`for (let m = X.exec(…))` 里的 `X` 必须是一个
   * 带 `g` 的正则字面量。`for (const re of [A, B])` 这种别名也展开。
   */
  it('src/ 下每一处 exec 循环的正则都带 g', () => {
    const files = collectSources(path.join(REPO_ROOT, 'src'));
    const offenders: string[] = [];
    let loops = 0;

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const aliases = new Map<string, string[]>();
      for (const match of src.matchAll(/for\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s+\[([^\]]*)\]/g)) {
        const names = (match[2] ?? '').split(',').map((part) => part.trim())
          .filter((part) => /^[A-Za-z_$][\w$]*$/.test(part));
        aliases.set(match[1] ?? '', names);
      }
      const declared = new Map<string, string>();
      // 只认单行正则字面量（这份代码库里没有跨行写的；跨行也不该用 exec 循环驱动）。
      for (const match of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*\/(?:\\.|\[(?:\\.|[^\]])*\]|[^/\n\\])+\/([dgimsuvy]*)/g)) {
        declared.set(match[1] ?? '', match[2] ?? '');
      }
      for (const match of src.matchAll(/for\s*\(\s*(?:let|var)\s+[A-Za-z_$][\w$]*\s*=\s*([A-Za-z_$][\w$]*)\.exec\(/g)) {
        const id = match[1] ?? '';
        loops += 1;
        for (const one of aliases.get(id) ?? [id]) {
          const flags = declared.get(one);
          // 找不到声明（函数参数、`new RegExp` 构造出来的）就不在这里判：这条守卫只钉
          // 「字面量 + exec 循环」这个组合，越界去猜会让它变成一条会误报的规则。
          if (flags === undefined) continue;
          if (!flags.includes('g')) {
            offenders.push(`${path.relative(REPO_ROOT, file)}: ${one} = /…/${flags}`);
          }
        }
      }
    }

    // 这条断言防「扫了个空」：扫不到循环的守卫永远绿，等于没有。
    expect(loops, '一处 exec 循环都没扫到 = 这条守卫失效了').toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});

describe('口径不变：`name:` 仍从 defineComponent 文件里抽组件名', () => {
  /**
   * 修复只允许改「安全性」，不许改「什么算一个符号」。这一组是那一条的钉子：
   * 修复前（带 `g` 的等价写法）与修复后必须给出同一个答案。
   *
   * 断言在**子进程**里跑（`--behavior`）：它调的 `exportsOf` 就是挂住过的那条路径，
   * 放在父进程里的话，修复被打回时这份用例会挂起而不是变红（实测 300 s 不退出）。
   */
  it('defineComponent + name: 抽出组件名；没有 defineComponent 的文件不抽', () => {
    const run = runChild(['--behavior']);
    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(0);
    const line = run.lines.at(-1);
    expect(line?.kind).toBe('behavior');
    expect(line?.withDefine).toEqual(['SearchEntrance']);
    // 门槛没变：`name:` 只在组件**定义**文件里算符号（原来就是 `text.includes('defineComponent')`）。
    expect(line?.withoutDefine).toEqual([]);
  });
});

/** `src/` 下所有 `.ts/.tsx/.mts`（递归）。 */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectSources(full));
    else if (/\.(?:ts|tsx|mts)$/.test(full)) out.push(full);
  }
  return out;
}
