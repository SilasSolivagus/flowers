import { defaultRunner, type Runner } from '../notify/wecom.js';
import {
  DEFAULT_TIMEOUT_MS, errcodeOf, looksUnauthorized, parseResponse, redact, tail,
} from '../prd/wecom.js';
import { priorityLabel } from '../requirements/priority.js';
import type { PlatformKey } from '../requirements/platforms.js';

/**
 * 「进待排期就写进企微汇总表」这件事的**纯形状**（2026-11-10）。
 *
 * 目标表是别人维护的一张电子表格（`迭代需求汇总-版本日志` / tab「待排期需求」），
 * 不是我们建的。所以这里只有两件事：把一条需求摊成那一行的 11 格，以及读一次 A 列
 * 做去重。写库、重试、失败留痕都在 `sync.ts`。
 *
 * ── 三条口径（都是对着真表定的，不是对着想象）
 *
 * 1. **`#` 写 `PAN-<编号>`，不续表里的连号**。表里现在是人工的 1–22，用户已定
 *    「旧行不动、新行往后接」。用 PAN 编号当幂等键：它唯一、可反查，而且与那 22 行的
 *    纯数字天然不冲突——按标题去重会误杀（库里同一个标题能有三条需求）。
 * 2. **空列不写，写 `{}` 占位**。`迭代情况` / `涉及研发人员` / `预评审` 在 flowers 里
 *    没有数据源（表里也基本是空的：迭代情况 208 行只有 22 行有值，预评审整列 0 条）。
 *    机器不猜，留着比编一个「跟随」干净。
 * 3. **`需求描述` 取 `outcome`，空则退 `problem`**。表里那几行是「作为…我希望…」的
 *    句式，但那种句子拼出来一眼是机器写的；直接放「做成什么样算成功」那句话更诚实。
 */

/** 台账里的目标名。多一张表就多一个值。 */
export const QUEUE_SHEET_TARGET = 'queue-sheet';

/**
 * 默认目标。可以从环境变量覆盖：表格换了（或者想先拿一张测试表试）不必改代码。
 * `FLOWERS_QUEUE_SHEET_DOC` 收整条文档链接（CLI 两种都收），
 * `FLOWERS_QUEUE_SHEET_TAB` 收工作表 id。
 */
export const DEFAULT_QUEUE_SHEET_DOC =
  'https://doc.weixin.qq.com/sheet/e3_AZ4AigbQAKcCNvihAC03dRSCODHl1';

/** 「待排期需求」那一格的 sheet_id（`tab=` 参数里那个）。 */
export const DEFAULT_QUEUE_SHEET_TAB = 'kvf2dh';

/** 列的语义顺序。改这里的顺序 = 改表里的列顺序，两处必须一起改。 */
export const QUEUE_SHEET_COLUMNS = [
  '#', '需求名称', '负责人', '优先级', '迭代情况', '涉及端',
  '涉及研发人员', '需求描述', '预评审', 'PRD链接', '备注',
] as const;

/**
 * 平台键 → 表里用的词。
 *
 * 表里出现过的是 `管理后台 / web / PC / APP / H5 / 开放平台`，与界面上的标签
 * （`Web端 / 移动端 / PC客户端`）不是一套写法。这张映射是**给表看的**，不是给界面看的，
 * 所以它住在这里、不住在 `platforms.ts`：那边是产品的词，这边是对方表格的词。
 */
const SHEET_PLATFORM: Record<PlatformKey, string> = {
  web: 'web',
  mobile: 'APP',
  pc: 'PC',
  mini: '小程序',
  backend: '后端',
  admin: '管理后台',
  manager: 'Manager后台',
  frontend: '前端',
  h5: 'H5',
  open: '开放平台',
  harmony: '鸿蒙',
  tv: 'TV',
};

export type QueueSheetSource = {
  number: number;
  title: string;
  owner: string | null;
  /** `p0|p1|p2|p3|green`；null = 未定。 */
  priority: string | null;
  platforms: readonly string[];
  /** 六问里的两问：描述优先 `outcome`，没有就 `problem`。 */
  outcome: string | null;
  problem: string | null;
  prdUrl: string | null;
  remark: string | null;
};

/** 单元格里的换行会把这个行撑成两行（读回来是 CSV），所以一律折成空格。 */
function oneLine(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 一条需求 → 表里那一行的 11 个值。**纯函数**：用例直接钉这 11 格，不碰 CLI。
 */
export function queueSheetCells(row: QueueSheetSource): string[] {
  const owner = oneLine(row.owner);
  const priority = row.priority === null ? '' : priorityLabel(row.priority);
  const platforms = row.platforms
    .map((key) => SHEET_PLATFORM[key as PlatformKey] ?? key)
    .filter((label) => label !== '')
    .join('、');
  const description = oneLine(row.outcome) || oneLine(row.problem);
  const prd = row.prdUrl === null || row.prdUrl === ''
    ? ''
    : `[PRD](${row.prdUrl})`;

  return [
    `PAN-${row.number}`,
    oneLine(row.title),
    owner,
    priority,
    '',            // 迭代情况：留空（没有数据源，机器不猜）
    platforms,
    '',            // 涉及研发人员：留空（同上，owner 已明确不要这一列）
    description,
    '',            // 预评审：留空（表里整列 0 条，写空等于维持现状）
    prd,
    oneLine(row.remark),
  ];
}

/** 一格里放了什么：空串就是「这一格留空」，CLI 认 `{}`。 */
type Cell =
  | { cell_value: { text: string }; data_type: 'TEXT' }
  | { cell_value?: undefined; data_type?: undefined };

export function queueSheetValues(cells: readonly string[]): Cell[] {
  return cells.map((text): Cell => (
    text === ''
      ? {}
      : { cell_value: { text }, data_type: 'TEXT' as const }
  ));
}

export type SheetDeps = {
  run?: Runner;
  /** 可执行文件；不给就走 `FLOWERS_WECOM_CLI` → PATH 上的 `wecom-cli`。 */
  bin?: string;
  doc?: string;
  tab?: string;
  timeoutMs?: number;
};

export function sheetTarget(deps: SheetDeps = {}): { doc: string; tab: string; bin: string } {
  return {
    doc: deps.doc ?? process.env.FLOWERS_QUEUE_SHEET_DOC ?? DEFAULT_QUEUE_SHEET_DOC,
    tab: deps.tab ?? process.env.FLOWERS_QUEUE_SHEET_TAB ?? DEFAULT_QUEUE_SHEET_TAB,
    bin: deps.bin ?? process.env.FLOWERS_WECOM_CLI ?? 'wecom-cli',
  };
}

export type SheetFail = { ok: false; code: SheetFailCode; message: string };
export type SheetOk<T> = { ok: true; value: T };
export type SheetResult<T> = SheetOk<T> | SheetFail;

export type SheetFailCode =
  | 'missing_binary'
  | 'unauthorized'
  | 'cli_failed'
  | 'timeout'
  | 'bad_output'
  | 'errcode';

export const MSG_SHEET_NO_BINARY = '没装 wecom-cli，先 npm i -g @wecom/cli';
export const MSG_SHEET_UNAUTHORIZED = '企微未授权：先在企业微信里扫码（wecom-cli auth init）';

/**
 * 跑一次 `wecom-cli`。判据顺序与 `export/queue.ts` 的 `callCli` 一模一样
 * （spawn 失败 → 退出码 → 不是 JSON → errcode），差别只有返回值形状。
 */
async function callSheet<T>(
  run: Runner, bin: string, argv: string[], timeoutMs: number,
  pick: (body: Record<string, unknown>) => T | null,
): Promise<SheetResult<T>> {
  const result = await run(bin, argv, timeoutMs);

  if (result.spawnError !== null) {
    if (result.spawnError.code === 'ENOENT') return { ok: false, code: 'missing_binary', message: MSG_SHEET_NO_BINARY };
    const detail = redact(`${result.spawnError.code ?? '未知'}：${result.spawnError.message}`);
    return { ok: false, code: 'cli_failed', message: `企微命令起不来（${detail}）` };
  }
  if (result.timedOut) {
    return { ok: false, code: 'timeout', message: `企微命令超时：等了 ${Math.round(timeoutMs / 1000)} 秒还没返回` };
  }
  const combined = `${result.stderr}\n${result.stdout}`;
  if (result.exitCode !== 0) {
    if (looksUnauthorized(combined)) return { ok: false, code: 'unauthorized', message: MSG_SHEET_UNAUTHORIZED };
    const code = result.exitCode === null ? '被信号终止' : `退出码 ${result.exitCode}`;
    const first = (result.stderr || result.stdout).split('\n').map((s) => s.trim()).find(Boolean) ?? '（输出是空的）';
    return { ok: false, code: 'cli_failed', message: `企微命令失败（${code}）：${redact(first)}` };
  }

  const response = parseResponse(result.stdout);
  if (response === null) {
    return { ok: false, code: 'bad_output', message: `企微返回的不是 JSON：${tail(result.stdout, 200)}` };
  }
  const errcode = errcodeOf(response);
  if (errcode !== null && errcode !== 0) {
    const body = response as Record<string, unknown>;
    const errmsg = typeof body.errmsg === 'string' ? body.errmsg : '未知错误';
    return { ok: false, code: 'errcode', message: `企微返回错误：${redact(errmsg)}（errcode ${errcode}）` };
  }
  const value = pick(response as Record<string, unknown>);
  if (value === null) {
    return { ok: false, code: 'bad_output', message: '企微返回的形状不对：没找到要的字段' };
  }
  return { ok: true, value };
}

/**
 * 读 A 列，拿到表里已经存在的 `#`。
 *
 * 为什么读 400 行而不是 `row_count`：`sheet get` 报的 208 是**网格尺寸**，真实数据
 * 只有 22 行。多读一些不花什么钱（一次调用），读少了会漏掉下半张表。
 */
export async function readExistingIds(deps: SheetDeps = {}): Promise<SheetResult<string[]>> {
  const { doc, tab, bin } = sheetTarget(deps);
  const run = deps.run ?? defaultRunner;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return callSheet(
    run, bin,
    ['sheet', 'ranges', 'get', '--docid', doc, '--sheet-id', tab, '--range', 'A1:A400'],
    timeoutMs,
    (body) => {
      const content = body.content;
      if (typeof content !== 'string') return null;
      // 读回来是 CSV：第一行是表头，其余是 `PAN-742` 或 `1`。
      const ids = content
        .split(/\r?\n/)
        .slice(1)
        .map((line) => line.split(',')[0]?.replace(/^"|"$/g, '').trim() ?? '')
        .filter((cell) => cell !== '');
      return ids;
    },
  );
}

/**
 * 往表尾追加一行。
 *
 * 不传 `--sheet-title`：那是智能表格的参数，这里是电子表格，走 `--sheet-id`。
 */
export async function appendQueueRow(
  cells: readonly string[], deps: SheetDeps = {},
): Promise<SheetResult<null>> {
  const { doc, tab, bin } = sheetTarget(deps);
  const run = deps.run ?? defaultRunner;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const row = JSON.stringify({ values: queueSheetValues(cells) });

  // `pick` 返回 `true` 而不是 `null`：`callSheet` 把 `null` 当「形状不对」。
  // 追加成功时没有任何要读回来的字段（`errcode: 0` 就够了）。
  const result = await callSheet(
    run, bin,
    ['sheet', 'rows', 'append', '--docid', doc, '--sheet-id', tab, '--row', row],
    timeoutMs,
    () => true,
  );
  return result.ok ? { ok: true, value: null } : result;
}
