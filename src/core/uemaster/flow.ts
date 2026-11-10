import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * mermaid 流程图 → 规范 SVG，**进程内**跑 UEmaster 的排版器，拿回检查报告。
 *
 * 为什么是子进程而不是"让 agent 画"：排版是一件确定的事。同一份 mermaid 必须每次都
 * 得到同一张图、同一组 `crossings/overlaps/textOverflow`，否则"图对不对"这件事就
 * 变成了看模型心情。引擎是 vendored 的零依赖 Python（`vendor/uemaster/flow-canvas/`），
 * 我们只负责喂输入、读产物、把报告翻译成一个可以 `if` 的布尔。
 *
 * 为什么根从**模块位置**推、不认 `process.cwd()`：本文件住在
 * `<仓库>/src/core/uemaster/flow.ts`，往上三层就是仓库根。第二个调用方是 MCP server，
 * 它被**别人的客户端**起在任意目录里——按 cwd 找根就等于"从 /tmp 启动就永远找不到
 * 排版器"，而文件明明在仓库里（`attach.ts` 的 `public/` 就是这么坏过一次的）。
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** vendored 排版器的入口。相对仓库根、与 cwd 无关。 */
export const FLOW_SCRIPT = path.join(REPO_ROOT, 'vendor/uemaster/flow-canvas/scripts/flowlayout.py');

/** 默认解释器。stdlib-only，不需要虚拟环境。 */
export const FLOW_PYTHON = 'python3';

/**
 * 默认超时。
 *
 * 实测一份 5 节点图约 60ms；20s 是给"几百节点的架构图"留的余量，也是**上限**：
 * 排版器在超大输入上会指数级退化，与其把 web 请求挂死，不如报一句"超时"让人改输入。
 */
export const FLOW_TIMEOUT_MS = 20_000;

/**
 * 引擎的浅色主题文件（`--style` 不传时它自己会读这一个，见 `flowcommon.load_style`）。
 *
 * 我们**不**直接用它，而是读它、把每个颜色值换成 CSS 变量名，再把结果作为 `--style`
 * 传回去：这样排版出来的 SVG 里 `fill` / `stroke` 是 `var(--fw-…)`，切主题时同一张图
 * 换色。为什么必须连字体与字号一起带过去：`--style` 会**整个替换**默认主题
 * （`layout()` 是 `DEFAULT_STYLE` 打底 + `style` 覆盖），只传颜色会让字体悄悄退回
 * 引擎内置的 `-apple-system`。
 */
export const FLOW_THEME_FILE = path.join(
  REPO_ROOT, 'vendor/uemaster/_theme/default.style.json',
);

/** 颜色值的形状：hex（3/4/6/8 位）或 `rgba(...)`——主题文件里只有这两种。 */
const COLOR_VALUE = /^(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))$/;

/**
 * 一个主题键 → 它在模板里那个 CSS 变量。
 *
 * 命名只有一条规则：`stroke_process` → `--fw-stroke-process`（下划线换连字符）。
 * 于是排版器里 `st["stroke_process"]` 与模板里 `--fw-stroke-process` 一眼对得上，
 * 不需要第二张对照表——而对照表正是最容易与真实用到的键脱节的东西。
 */
export function fwVar(key: string): string {
  return `--fw-${key.replace(/_/gu, '-')}`;
}

/**
 * 主题文件 → 「所有颜色都换成变量名」的那一份样式覆盖。
 *
 * 为什么由这一层做转换，而不是在模板里写死一遍颜色、再用 CSS 覆盖：SVG 的
 * `fill="…"` 是**属性**，属性值的优先级低于任何 CSS 规则，但**没有**任何 CSS 能选中
 * 「第 3 个节点的矩形」。要让颜色可切，只能在生成时把它写成变量——这是唯一不依赖
 * 「给每个节点配一条 CSS 规则」的做法。
 *
 * 非颜色键（`font_family` / `fs_*`）原样保留：它们不随主题变，而丢了它们就改了版式。
 */
export function styleVarsFromTheme(theme: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme)) {
    if (typeof value !== 'string') continue;
    out[key] = COLOR_VALUE.test(value.trim()) ? `var(${fwVar(key)})` : value;
  }
  return out;
}

/** 报告里必须为 0 的三个计数。名字与引擎 JSON 的键逐字一致。 */
const COUNTERS = ['crossings', 'overlaps', 'textOverflow'] as const;

export type FlowCheck = {
  ok: boolean;
  crossings: number;
  overlaps: number;
  textOverflow: number;
  warnings: string[];
  report: unknown;
  /** `ok` 为真时才有：引擎写出来的 SVG 全文。 */
  svg?: string;
  /** 引擎报错 / 非零退出 / 超时 / 报告读不懂。 */
  error?: string;
};

/**
 * 测试与将来"换脚本"用的窄口子。
 *
 * 不给这两个字段也不会改变契约——`renderFlowchart(mermaid)` 就是全部。
 * `timeoutMs` 存在是为了让超时这件事**能被真的证明**（用一个睡着的夹具脚本跑 200ms，
 * 而不是把常量改成 1 然后在测试里假装），`scriptPath` 同理。
 */
export type FlowOptions = {
  timeoutMs?: number;
  scriptPath?: string;
  python?: string;
  /** 浅色主题文件（`--style` 的来源）。用例用它指到一份夹具上。 */
  themeFile?: string;
};

/** 一次子进程执行的结果，**永远 resolve**：失败是一种数据，不是异常。 */
type Run = {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  spawnError?: string;
};

/**
 * 跑一次 `execFile`，把四种失败压成同一种形状。
 *
 * 为什么用 `execFile` 而不是 `exec`：我们喂进去的是**用户写的 mermaid**，里面可以有
 * 引号、`$()`、反引号、分号。走 shell 就等于把那段文本交给 shell 解释一遍。argv 数组
 * 里没有 shell，`$()` 只是四个字符。
 */
function run(args: string[], cwd: string, timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      args[0] as string,
      args.slice(1),
      { cwd, timeout: timeoutMs, killSignal: 'SIGTERM', maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string }) | null;
        if (!e) {
          resolve({ code: 0, signal: null, timedOut: false, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
          return;
        }
        // ENOENT（没装 python3）、EACCES（脚本没执行权限）走这里：没有退出码，只有 errno。
        if (typeof e.code === 'string') {
          resolve({ code: null, signal: null, timedOut: false, stdout: '', stderr: '', spawnError: `${e.code}: ${e.message}` });
          return;
        }
        // Node 在 timeout 触发时置 killed=true 并给出信号名；自家 SIGTERM 与"脚本自己
        // 被信号打死"在 errno 上都能落到这里，只有 killed 能区分。
        const timedOut = Boolean(e.killed) && (e.signal === 'SIGTERM' || e.signal === 'SIGKILL');
        resolve({
          code: typeof e.code === 'number' ? e.code : null,
          signal: e.signal ?? null,
          timedOut,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
  });
}

/** stderr 的最后一段。整段可能很长（Python traceback），报错那一行只要尾巴。 */
function tail(text: string, max = 800): string {
  const t = text.trim();
  return t.length <= max ? t : `…${t.slice(-max)}`;
}

/**
 * 从 stdout 里挖出报告 JSON。
 *
 * 引擎的 stdout 同时装了两样东西：一行报告，外加一行人类看的 `已生成 out.svg`
 * （`--check` 时报告是缩进的、跨多行）。所以不能整段 `JSON.parse`，也不能只读第一行；
 * 取第一个 `{` 到最后一个 `}` 中间的原文，对两种排版都成立，且那行中文永远不含花括号。
 */
export function reportIn(stdout: string): unknown | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

/** 报告里的数字。缺字段/不是数字都当 0——但那意味着 `ok` 也不会被误判成真（见下）。 */
function counter(report: Record<string, unknown>, key: string): number {
  const v = report[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function warningsOf(report: Record<string, unknown>): string[] {
  const v = report['warnings'];
  if (!Array.isArray(v)) return [];
  return v.filter((w): w is string => typeof w === 'string');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 布局被拒时再跑一次 `--check`，把报告捞回来（失败路径专用）。
 *
 * 为什么值得多花一次 ~60ms：`renderFlowchart` 的返回值是**给模型看的修图工单**，
 * 而 `-o` 模式在布局不合格时只有一句「交叉 1 / 重叠 0 / 文字溢出 0」，没有坐标。
 * 报告里的 `*_points` 才说得清「哪两条线在第几像素交叉」。报告拿不到就返回 null，
 * 调用方退回那句中文原文——多跑一次的代价不能换来一个更差的错误。
 */
async function diagnose(args: string[], cwd: string, timeoutMs: number): Promise<Omit<FlowCheck, 'ok' | 'error'> | null> {
  const again = await run(args, cwd, timeoutMs);
  if (again.spawnError || again.timedOut) return null;
  const report = reportIn(again.stdout);
  if (!isRecord(report)) return null;
  return {
    crossings: counter(report, COUNTERS[0]),
    overlaps: counter(report, COUNTERS[1]),
    textOverflow: counter(report, COUNTERS[2]),
    warnings: warningsOf(report),
    report,
  };
}

/**
 * 一份 mermaid 流程图 → 一张查过过的 SVG。
 *
 * 判据只有一条：报告读得懂，且 `crossings`/`overlaps`/`textOverflow` 全为 0。
 * `warnings` 非空但三个计数为 0 仍然是 `ok` —— 上游契约允许"提醒"（例如主干推断、
 * 标签折行）与"不合格"（交叉/重叠/溢出）是两件事，把 warnings 也算进 ok 会让绝大多数
 * 本来能用的图变成红的。
 */
export async function renderFlowchart(mermaid: string, options: FlowOptions = {}): Promise<FlowCheck> {
  const timeoutMs = options.timeoutMs ?? FLOW_TIMEOUT_MS;
  const script = options.scriptPath ?? FLOW_SCRIPT;
  const python = options.python ?? FLOW_PYTHON;
  const themeFile = options.themeFile ?? FLOW_THEME_FILE;

  const empty: FlowCheck = { ok: false, crossings: 0, overlaps: 0, textOverflow: 0, warnings: [], report: null };

  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'flowers-flow-'));
    const mmd = path.join(dir, 'input.mmd');
    const svgPath = path.join(dir, 'out.svg');
    await writeFile(mmd, mermaid, 'utf8');

    /**
     * 把「颜色走变量」的样式覆盖写进临时目录，再交给引擎（`--style`）。
     *
     * 读不到主题文件就**不传** `--style`：那时引擎用自己的默认样式（颜色是 hex），
     * 产物仍然正确、只是深色下不好看——比「因为读不到一个主题文件就生成失败」好。
     * 这条降级不静默：`warnings` 里留一句，报告与用例都看得见。
     */
    const extraWarnings: string[] = [];
    const stylePath = path.join(dir, 'style.vars.json');
    try {
      const theme = JSON.parse(await readFile(themeFile, 'utf8')) as Record<string, unknown>;
      await writeFile(stylePath, JSON.stringify(styleVarsFromTheme(theme)), 'utf8');
    } catch (error) {
      extraWarnings.push(
        `主题文件读不出来，流程图颜色退回引擎默认（深色下可能看不清）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const styleArgs = extraWarnings.length === 0 ? ['--style', stylePath] : [];

    const run1 = await run([python, script, mmd, '-o', svgPath, ...styleArgs], dir, timeoutMs);

    if (run1.spawnError) {
      return { ...empty, error: `排版器起不来（${run1.spawnError}）` };
    }
    if (run1.timedOut) {
      return { ...empty, error: `排版器超时（${timeoutMs}ms 未结束，已终止）` };
    }
    if (run1.code !== 0) {
      const why = tail(run1.stderr) || tail(run1.stdout) || `退出码 ${run1.code ?? run1.signal ?? '?'}`;
      // 布局不合格时引擎**不打印报告**（`-o` 模式直接 SystemExit，只留一句中文），
      // 而报告里才有 `crossing_points` / `overlap_points` / `textOverflow_points`——
      // 那正是「改哪里」的全部信息。所以失败时补跑一次 `--check` 把报告捞回来：
      // 它退出码非 0 但会先打印报告。拿不到报告（形态超限、Python 报错）就退回原文。
      const diagnosis = await diagnose([python, script, mmd, '--check', ...styleArgs], dir, timeoutMs);
      return diagnosis === null ? { ...empty, error: why } : { ...diagnosis, ok: false, error: why };
    }

    const report = reportIn(run1.stdout);
    if (!isRecord(report)) {
      return { ...empty, error: `报告读不懂：${tail(run1.stdout, 400) || '（stdout 为空）'}` };
    }

    const crossings = counter(report, COUNTERS[0]);
    const overlaps = counter(report, COUNTERS[1]);
    const textOverflow = counter(report, COUNTERS[2]);
    // 主题那一层的降级（读不到主题文件）与引擎的提醒**同一个信封**：调用方读一处就够。
    const warnings = [...extraWarnings, ...warningsOf(report)];
    const clean = crossings === 0 && overlaps === 0 && textOverflow === 0;

    if (!clean) {
      return {
        ok: false,
        crossings,
        overlaps,
        textOverflow,
        warnings,
        report,
        error: `布局不合格：交叉 ${crossings}、重叠 ${overlaps}、文字溢出 ${textOverflow}`,
      };
    }

    let svg: string;
    try {
      svg = await readFile(svgPath, 'utf8');
    } catch (e) {
      return {
        ok: false,
        crossings,
        overlaps,
        textOverflow,
        warnings,
        report,
        error: `报告说没问题，但没有产物：${e instanceof Error ? e.message : String(e)}`,
      };
    }

    return { ok: true, crossings, overlaps, textOverflow, warnings, report, svg };
  } catch (e) {
    // 走到这里只可能是 mkdtemp/writeFile 这类宿主侧失败（磁盘满、TMPDIR 不可写）。
    // 对外仍然是 `ok:false` + `error`：调用方不该为了"画图"写 try/catch。
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
