import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db, pool } from '../src/db/client.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { makeQueued } from './helpers/factory.js';
import { createRequirement } from '../src/core/requirements/create.js';
import {
  MSG_NO_BINARY, MSG_NO_ROWS, MSG_UNAUTHORIZED, QUEUE_COLUMNS,
  exportQueue, loadQueueRows, type ExportOutcome,
} from '../src/core/export/queue.js';
import type { Runner, RunResult } from '../src/core/notify/wecom.js';

/**
 * P1b：待排期 → 企微智能表格。
 *
 * 三件必须钉住的事，各自防一种坏法：
 * 1. **待排期为空时**：服务返回 `no_rows`，**一次 CLI 都不调**。
 *    坏法是「先建表再发现没行」——那会在企微里留一张空表，而且按钮点下去才说
 *    （按钮本身在空列里根本不该出现，那一条在 `export-ui.test.tsx`）。
 * 2. **成功时**：行数 = 待排期条数（不是「所有需求」），载荷是 9 列、顺序与
 *    `QUEUE_COLUMNS` 一致。坏法是列序错位——导出照样成功，只是内容整列错开。
 * 3. **CLI 失败时**：`errcode != 0` 与退出码非 0 都要变成**带原始原因**的中文，
 *    不能吞成「导出失败」。坏法是那句 `errmsg` 只留在服务端日志里，用户看到四个字。
 *
 * CLI 一律是注入的 runner（`(bin, argv, timeoutMs) => RunResult`）：
 * 这一组用例不装 `wecom-cli`、不联网、也不依赖 PATH。
 */

// ─── 假 CLI ──────────────────────────────────────────────────────────────────

type Call = { bin: string; argv: string[]; timeoutMs: number };

const OK_CREATE = {
  errcode: 0,
  docid: 'doc-1',
  url: 'https://doc.weixin.qq.com/smartsheet/doc-1',
};
const OK_ADD = { errcode: 0, success: true };

/** 每次调用回一条排队好的结果；调用记录留在 `calls` 里供断言。 */
function cli(responses: Array<Partial<RunResult>>): { calls: Call[]; run: Runner } {
  const calls: Call[] = [];
  let index = 0;
  const run: Runner = async (bin, argv, timeoutMs) => {
    calls.push({ bin, argv, timeoutMs });
    const response = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    return {
      exitCode: 0, timedOut: false, spawnError: null, stdout: '', stderr: '', ...response,
    };
  };
  return { calls, run };
}

/** 一次成功的两步：建表 → 写行。 */
function cliOk() {
  return cli([{ stdout: JSON.stringify(OK_CREATE) }, { stdout: JSON.stringify(OK_ADD) }]);
}

/** argv 里某个开关后面的值。 */
function flag(argv: string[], name: string): string {
  const at = argv.indexOf(name);
  expect(at, `argv 里没有 ${name}：${argv.join(' ')}`).toBeGreaterThanOrEqual(0);
  return argv[at + 1]!;
}

beforeEach(async () => {
  await resetDb();
  await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

// ─── 1. 空列 ─────────────────────────────────────────────────────────────────

describe('待排期为空', () => {
  it('返回 no_rows，并且一次 CLI 都不调（不留空表）', async () => {
    const { calls, run } = cliOk();
    const outcome = await exportQueue({ run });

    expect(outcome).toEqual({ ok: false, code: 'no_rows', message: MSG_NO_ROWS });
    expect(outcome.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('读模型问的就是 queue：别的状态不进导出', async () => {
    // 一条只在收集里的需求，不进待排期。
    await createRequirement(db, '王妍', { title: '还没评估的', type: 'feature', requester: '王妍' });
    expect(await loadQueueRows()).toHaveLength(0);
  });
});

// ─── 2. 成功 ─────────────────────────────────────────────────────────────────

describe('导出成功', () => {
  it('行数 = 待排期条数，链接与表名带回来', async () => {
    await makeQueued();
    await makeQueued();
    // 一条别的状态：不该被算进行数。
    await createRequirement(db, '王妍', { title: '还在收集', type: 'commercial', requester: '王妍' });

    const { run } = cliOk();
    const outcome = await exportQueue({ run, now: new Date('2026-11-07T10:00:00+08:00') });

    expect(outcome.ok).toBe(true);
    const ok = outcome as Extract<ExportOutcome, { ok: true }>;
    expect(ok.rows).toBe(2);
    expect(ok.url).toBe(OK_CREATE.url);
    expect(ok.docid).toBe('doc-1');
    expect(ok.name).toBe('待排期需求 11-07');
  });

  it('建表的字段是 9 列，顺序就是文档里那 9 个', async () => {
    await makeQueued();
    const { calls, run } = cliOk();
    await exportQueue({ run });

    const create = calls[0]!;
    expect(create.argv.slice(0, 3)).toEqual(['smartsheet', 'create', '--json']);
    const body = JSON.parse(flag(create.argv, '--json')) as {
      name: string; sheet_title: string; fields: Array<{ field_title: string; field_type: string }>;
    };
    // 手抄一份文档里的列序（不引用 QUEUE_COLUMNS）：这样改顺序才会真的红。
    expect(body.fields.map((item) => item.field_title)).toEqual([
      '编号', '标题', '类型', '负责人', '提出人', '等什么', '停留天数', 'PRD', '版本',
    ]);
    expect(body.sheet_title).toBe('待排期');
    // 只有「停留天数」是数字列。
    expect(body.fields.filter((item) => item.field_type === 'number').map((item) => item.field_title))
      .toEqual(['停留天数']);
  });

  it('每一行的 values 也是 9 个键、同一个顺序，值来自那一行', async () => {
    const created = await makeQueued();
    const { calls, run } = cliOk();
    await exportQueue({ run });

    const add = calls[1]!;
    expect(add.argv.slice(0, 3)).toEqual(['smartsheet', 'records', 'add']);
    expect(flag(add.argv, '--docid')).toBe('doc-1');
    expect(flag(add.argv, '--key-type')).toBe('field_title');
    const records = JSON.parse(flag(add.argv, '--records')) as Array<{ values: Record<string, string> }>;

    expect(records).toHaveLength(1);
    expect(Object.keys(records[0]!.values)).toEqual([...QUEUE_COLUMNS]);
    expect(records[0]!.values['编号']).toBe(`PAN-${created.number}`);
    expect(records[0]!.values['标题']).toBe('q');
    expect(records[0]!.values['类型']).toBe('功能');
    expect(records[0]!.values['负责人']).toBe('吕品');
    expect(records[0]!.values['等什么']).toBe('待排期');
    expect(records[0]!.values['版本']).toBe('—');
  });
});

// ─── 3. 失败 ─────────────────────────────────────────────────────────────────

describe('CLI 失败：中文原因带原始那句', () => {
  beforeEach(async () => {
    await makeQueued();
  });

  it('退出码非 0：原始 stderr 的首行进 message', async () => {
    const { run } = cli([
      { exitCode: 2, stdout: '', stderr: 'Error: 文档服务 500 ServiceUnavailable\n第二行不要' },
    ]);
    const outcome = await exportQueue({ run });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('不该成功');
    expect(outcome.code).toBe('cli_failed');
    expect(outcome.message).toContain('企微命令失败（退出码 2）');
    expect(outcome.message).toContain('Error: 文档服务 500 ServiceUnavailable');
    // 只带首行：第二行是噪音。
    expect(outcome.message).not.toContain('第二行不要');
  });

  it('errcode != 0（退出码仍是 0）：errmsg 原样带出', async () => {
    const { run } = cli([
      { exitCode: 0, stdout: JSON.stringify({ errcode: 853006, errmsg: 'this tool is not available for your corporation' }) },
    ]);
    const outcome = await exportQueue({ run });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('不该成功');
    expect(outcome.code).toBe('errcode');
    expect(outcome.message).toContain('this tool is not available for your corporation');
    expect(outcome.message).toContain('errcode 853006');
  });

  it('没装：命令不存在，说得出下一步', async () => {
    const { run } = cli([
      { exitCode: null, spawnError: Object.assign(new Error('spawn wecom-cli ENOENT'), { code: 'ENOENT' }) },
    ]);
    const outcome = await exportQueue({ run });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('不该成功');
    expect(outcome.code).toBe('missing_binary');
    expect(outcome.message).toContain('命令不存在');
    expect(outcome.message).toBe(MSG_NO_BINARY);
  });

  it('没授权：一句话指向扫码，而不是「退出码 1」', async () => {
    const { run } = cli([{ exitCode: 1, stdout: '', stderr: 'Status: unauthorized' }]);
    const outcome = await exportQueue({ run });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('不该成功');
    expect(outcome.code).toBe('unauthorized');
    expect(outcome.message).toBe(MSG_UNAUTHORIZED);
  });

  it('建表成功、写行失败：说清「表已建、行没进去」并带上 docid', async () => {
    const { calls, run } = cli([
      { stdout: JSON.stringify(OK_CREATE) },
      { exitCode: 0, stdout: JSON.stringify({ errcode: 40058, errmsg: 'sheet not found' }) },
    ]);
    const outcome = await exportQueue({ run });

    expect(calls).toHaveLength(2);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('不该成功');
    expect(outcome.code).toBe('errcode');
    expect(outcome.message).toContain('sheet not found');
    expect(outcome.message).toContain('表已建、行没写进去');
    expect(outcome.message).toContain('doc-1');
  });

  it('建表没有 docid：不继续写行', async () => {
    const { calls, run } = cli([{ stdout: JSON.stringify({ errcode: 0 }) }]);
    const outcome = await exportQueue({ run });

    expect(calls).toHaveLength(1);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('不该成功');
    expect(outcome.code).toBe('bad_output');
    expect(outcome.message).toContain('没有返回 docid');
  });
});

