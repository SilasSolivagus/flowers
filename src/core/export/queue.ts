import { sql } from 'drizzle-orm';

import { db as appDb, type Db } from '../../db/client.js';
import { defaultRunner, type Runner } from '../notify/wecom.js';
import {
  DEFAULT_TIMEOUT_MS, MSG_MISSING_BINARY as MISSING_BINARY_HINT, errcodeOf, looksUnauthorized,
  parseResponse, redact, resolveCli, tail, type CliResponse,
} from '../prd/wecom.js';

/**
 * 「把待排期导成一张企微智能表格」这件事本身（P1b）。
 *
 * ── 为什么从脚本里搬出来
 *
 * 这件事原来只有一条路：`npx tsx scripts/export-queue.ts`。于是「导出」依赖一个人
 * 记得那条命令，而看板上正好有一列叫「待排期」——数据在那里，入口在终端里。
 * 搬进 `src/core` 之后，脚本和列头那个按钮走的是**同一份**查询与同一份列形状；
 * 留在脚本里各写一份，两次导出的列序会慢慢分岔，而这种分岔没人会去比对。
 *
 * ── 为什么走 cli 而不是自己调 API
 *
 * `wecom-cli` 已经把凭据、鉴权、文档权限封装好了（供应商自己的二进制），
 * 我们只负责把行拼成它要的形状。多发一层抽象只会多一处对不齐。
 *
 * ── 两条实测结论（写在两次调用中间的那段注释里）
 *
 * 1. 建表只带 `fields`，**不用 `grid_data` 一次性写行**：实测 `record_count` 仍是 0
 *    （字段到了、行没到）。分两步反而干净——建表、再批量写行，两步各自的错误也能
 *    分开报（「表建出来了但行没进去」是一句必须说出来的话，见下面的 message）。
 * 2. `errcode != 0` 时进程退出码仍然是 0，所以**只看退出码会把失败当成成功**。
 *    成功与否一律由 `errcode` 与响应形状共同判定。
 *
 * ── 三条硬规矩（与 `src/core/notify/wecom.ts`、`src/core/prd/wecom.ts` 同形）
 *
 * 1. **没有 shell。** argv 数组交给注入的 runner（默认是 `execFile`），一行标题里
 *    可以有中文、引号、`-`，走 shell 就等于把内容再解释一遍。
 * 2. **失败是数据，不是异常。** 没装 / 没授权 / 超时 / errcode / 没有行，一律返回
 *    `{ ok:false, code, message }`，message 是中文且说得出下一步。调用方（按钮、脚本）
 *    各自决定怎么显示，这一层不抛。
 * 3. **runner 是注入的。** 用例必须能在不装 CLI、不改 PATH、不连网的前提下跑完
 *    「成功 / 失败 / 空列」三条路——所以 CLI 调用是参数，不是模块顶层的副作用。
 */

/** 导出哪些列。顺序就是表里的列顺序——与看板卡片上读者关心的东西一致。 */
export const QUEUE_COLUMNS = [
  '编号', '标题', '类型', '负责人', '提出人', '等什么', '停留天数', 'PRD', '版本',
] as const;

/** 表格里的第二个 tab 名。与 `待排期` 这个列名一致，不再是另一个词。 */
export const QUEUE_SHEET_TITLE = '待排期';

/** 待排期一行读出来的样子。列名跟着 SQL 的别名走，不再另起一套字段名。 */
export type QueueRow = {
  number: number;
  title: string;
  type: string;
  owner: string | null;
  requester: string;
  /** 「等什么」。这一列里每条都在等排期，所以它由**状态**决定，不查库。 */
  waiting: string;
  /** 停在 `queue` 几个上海日历天。 */
  days: number;
  prd_url: string | null;
  release_name: string | null;
};

/**
 * 失败码。界面按它决定说什么，人读 `message`。
 *
 * `no_rows` 是**正常的一种结果**，不是错误：待排期本来就是空的（这一列每天都可能被
 * 清空一次）。把它做成一个码而不是「返回空数组 + 让调用方自己猜」，是为了让按钮与
 * 脚本说同一句话，也让「空列还去建表」这件事在类型上不可能发生。
 */
export type ExportFailCode =
  | 'no_rows'         // 待排期是空的
  | 'bad_config'      // 读不到 CLI 路径（库错误）
  | 'missing_binary'  // CLI 没装（ENOENT）
  | 'unauthorized'    // CLI 没授权
  | 'cli_failed'      // 退出码非 0（非授权那类）/ 进程起不来
  | 'timeout'         // 单次调用超预算
  | 'bad_output'      // stdout 不是 JSON / 没有 docid
  | 'errcode';        // errcode 非 0（errmsg 原样带出）

export type ExportFail = { ok: false; code: ExportFailCode; message: string };

export type ExportOk = {
  ok: true;
  /** 文档链接。CLI 没回的时候就只有 docid（界面自己决定怎么显示）。 */
  url: string;
  docid: string;
  /** 写进去的行数 = 待排期条数。 */
  rows: number;
  /** 表名（`待排期需求 MM-DD`）。 */
  name: string;
};

export type ExportOutcome = ExportOk | ExportFail;

/** 空列那句话只有一处：服务、按钮、报告说的是同一句。 */
export const MSG_NO_ROWS = '没有可导出的行：待排期是空的';

/** 没授权那句话。前缀「企微未授权」是给人一眼分类用的，后半句说下一步。 */
export const MSG_UNAUTHORIZED = '企微未授权：先在企业微信里扫码（wecom-cli auth init）';

/** 没装那句话。`ENOENT` 在部署里只有一个现实原因：这台机器没有这个命令。 */
export const MSG_NO_BINARY = `命令不存在：${MISSING_BINARY_HINT}`;

function fail(code: ExportFailCode, message: string): ExportFail {
  return { ok: false, code, message };
}

// ─── 读行 ────────────────────────────────────────────────────────────────────

/**
 * 待排期 = `queue`。
 *
 * 「等什么」由状态本身决定（这一列里每条都在等排期），所以这里不重复写「等排期」；
 * 真正有信息量的是**它挂了哪个版本**与**停了几天**——排期要看的就是这两件事。
 *
 * 左连接（不是内连接）：没有负责人、没有版本的行必须出现在表里。它们是待排期这一列
 * 的常态（刚过评审、还没排版本的），不是脏数据。
 */
export async function loadQueueRows(database: Db = appDb): Promise<QueueRow[]> {
  const res = await database.execute<{
    number: number; title: string; type: string; owner: string | null;
    requester: string; days: number; prd_url: string | null; release_name: string | null;
  }>(sql`
    select r.number, r.title, r.type,
           m.name as owner,
           r.requester,
           greatest(0, date_part('day', now() - r.state_entered_at))::int as days,
           r.prd_url,
           rel.name as release_name
      from requirements r
      left join members m on m.id = r.owner_member_id
      left join releases rel on rel.id = r.release_id
     where r.state = 'queue' and r.deleted_at is null
     order by r.number`);

  return res.rows.map((row) => ({
    ...row,
    days: Number(row.days),
    // 这一列里每条都卡在同一件事上；把它写出来是为了让表格脱离看板也能读。
    waiting: QUEUE_SHEET_TITLE,
  }));
}

// ─── 拼载荷 ──────────────────────────────────────────────────────────────────

/**
 * 一行的 values：`{ 字段标题: 值 }`。
 *
 * 用**字段标题**当键（`--key-type field_title`）而不是 field_id：field_id 是建表时
 * 服务端生成的，我们手里没有，先建表再查一遍 ID 只为了发一次写入不值得。
 */
export function recordValues(row: QueueRow): Record<string, string> {
  return {
    编号: `PAN-${row.number}`,
    标题: row.title,
    类型: row.type === 'commercial' ? '商业' : '功能',
    负责人: row.owner ?? '—',
    提出人: row.requester,
    等什么: row.waiting,
    停留天数: String(row.days),
    PRD: row.prd_url ?? '—',
    版本: row.release_name ?? '—',
  };
}

/**
 * 建表要的字段表。**顺序由 `QUEUE_COLUMNS` 决定**——它是唯一的列序来源，
 * 用例钉的就是它（改一次顺序，导出的表就整列错位，而错位没人会当场发现）。
 */
export function sheetFields(): Array<{ field_title: string; field_type: string }> {
  return QUEUE_COLUMNS.map((title) => ({
    field_title: title,
    // 只有「停留天数」是数字列：别的列都可能有中文标点或短横，标成数字会被服务端拒。
    field_type: title === '停留天数' ? 'number' : 'text',
  }));
}

/** 表名：`待排期需求 MM-DD`。导出的表是按天看的，所以名字带日期。 */
export function sheetName(now: Date): string {
  const stamp = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `待排期需求 ${stamp}`;
}

export function createArgv(name: string): string[] {
  // 只带字段：`grid_data` 一次性写行实测不落库（见文件头第 1 条）。
  const body: Record<string, unknown> = {
    name,
    sheet_title: QUEUE_SHEET_TITLE,
    fields: sheetFields(),
  };
  return ['smartsheet', 'create', '--json', JSON.stringify(body)];
}

export function recordsArgv(docid: string, rows: QueueRow[]): string[] {
  return [
    'smartsheet', 'records', 'add',
    '--docid', docid,
    '--sheet-title', QUEUE_SHEET_TITLE,
    '--key-type', 'field_title',
    '--records', JSON.stringify(rows.map((row) => ({ values: recordValues(row) }))),
  ];
}

// ─── 跑一次 ──────────────────────────────────────────────────────────────────

/** 报告里「其他」那一类要带的东西：原始输出的**首行**（整段是几十行 warning 时没用）。 */
function firstLine(text: string): string {
  const line = text.split('\n').map((item) => item.trim()).find((item) => item !== '') ?? '';
  const cut = line.length <= 200 ? line : `${line.slice(0, 200)}…`;
  return redact(cut);
}

function textAt(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value.trim() : '';
}

type Call =
  | { ok: true; response: CliResponse; raw: string }
  | ExportFail;

/**
 * 跑一次 `wecom-cli`，把五种失败压成同一种形状。
 *
 * 判据顺序不能换：进程没起来 → 退出码（授权只是退出码非 0 的一种，先认它，
 * 报错才说得出「去扫码」而不是「退出码 1」）→ 不是 JSON → errcode。
 */
async function callCli(
  run: Runner, bin: string, argv: string[], timeoutMs: number,
): Promise<Call> {
  const result = await run(bin, argv, timeoutMs);

  if (result.spawnError !== null) {
    if (result.spawnError.code === 'ENOENT') return fail('missing_binary', MSG_NO_BINARY);
    const detail = redact(`${result.spawnError.code ?? '未知'}：${result.spawnError.message}`);
    return fail('cli_failed', `企微命令起不来（${detail}）`);
  }
  if (result.timedOut) {
    return fail('timeout', `企微命令超时：等了 ${Math.round(timeoutMs / 1000)} 秒还没返回`);
  }

  const combined = `${result.stderr}\n${result.stdout}`;
  if (result.exitCode !== 0) {
    // 授权失效时 CLI 只打一行 `Status: unauthorized` 并以非 0 退出：这句话对用户没用，
    // 「去扫码」才是有用的那一句。
    if (looksUnauthorized(combined)) return fail('unauthorized', MSG_UNAUTHORIZED);
    const code = result.exitCode === null ? '被信号终止' : `退出码 ${result.exitCode}`;
    const text = firstLine(result.stderr) || firstLine(result.stdout) || '（stderr 与 stdout 都是空的）';
    return fail('cli_failed', `企微命令失败（${code}）：${text}`);
  }

  const response = parseResponse(result.stdout);
  if (response === null) {
    return fail('bad_output', `企微返回的不是 JSON：${firstLine(result.stdout) || '（stdout 是空的）'}`);
  }
  const errcode = errcodeOf(response);
  if (errcode !== null && errcode !== 0) {
    // errmsg 原样带出，不改写：它是排查的唯一线索（`this tool is not available for
    // your corporation` 这类句子，改写成「导出失败」就什么都不是了）。
    const errmsg = textAt(response as Record<string, unknown>, 'errmsg') || '未知错误';
    return fail('errcode', `企微返回错误：${redact(errmsg)}（errcode ${errcode}）`);
  }
  return { ok: true, response, raw: tail(result.stdout) };
}

export type ExportDeps = {
  /** 读行用哪张库。默认 `src/db/client` 的 `db`（脚本与页面是同一个答案）。 */
  database?: Db;
  /** 跑 CLI 的方式。用例注入假的，就永远不碰二进制、不碰网络。 */
  run?: Runner;
  /** 可执行文件路径。不给就走 `FLOWERS_WECOM_CLI` → 设置 → PATH 上的 `wecom-cli`。 */
  bin?: string;
  /** 表名里的日期。给了就是确定的表名（用例要钉这个名字）。 */
  now?: Date;
  timeoutMs?: number;
};

/**
 * 导出一次：读行 → 建表 → 写行。
 *
 * 两步之间没有事务可言（一个是 CLI、一个是另一个 CLI），所以第二步失败时**必须**
 * 把第一步的成果说出来：表已经建出来了，行没有进去。这句话带着 docid，人可以自己
 * 去删掉那张空表，也知道下一次点「导出」会再建一张——而不是以为「什么都没发生」。
 */
export async function exportQueue(deps: ExportDeps = {}): Promise<ExportOutcome> {
  const database = deps.database ?? appDb;
  const run = deps.run ?? defaultRunner;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? new Date();

  const rows = await loadQueueRows(database);
  if (rows.length === 0) return fail('no_rows', MSG_NO_ROWS);

  const resolved = deps.bin === undefined ? await resolveCli(database) : { ok: true as const, bin: deps.bin };
  if (!resolved.ok) return fail('bad_config', resolved.message);
  const bin = resolved.bin;

  const name = sheetName(now);

  const created = await callCli(run, bin, createArgv(name), timeoutMs);
  if (!created.ok) return created;

  const record = created.response as Record<string, unknown>;
  const docid = textAt(record, 'docid');
  if (docid === '') {
    return fail(
      'bad_output',
      `企微建表没有返回 docid，无法写行：${firstLine(created.raw) || '（响应里没有 docid）'}`,
    );
  }
  const url = textAt(record, 'url');

  const added = await callCli(run, bin, recordsArgv(docid, rows), timeoutMs);
  if (!added.ok) {
    const where = url === '' ? `docid ${docid}` : `docid ${docid} · ${url}`;
    return { ...added, message: `${added.message}（表已建、行没写进去：${where}）` };
  }

  return { ok: true, url, docid, rows: rows.length, name };
}
