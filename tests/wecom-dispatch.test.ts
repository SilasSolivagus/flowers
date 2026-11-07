import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { resetDb, seedPeople, type SeededPerson } from './helpers/db.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { saveNotifyChannels } from '../src/core/members/manage.js';
import { activeMemberByName } from '../src/core/auth/members.js';
import { pendingDeliveries } from '../src/core/read/notify.js';
import {
  DEFAULT_PER_MEMBER_LIMIT, dispatchWecom, tickThenDispatch, type DispatchSummary,
} from '../src/core/notify/dispatch.js';
import {
  lookupUserid, messageOf, pickUser, resolveUserid, sendMarkdown,
  type Runner,
} from '../src/core/notify/wecom.js';

/**
 * P4-07：企微推送这一层。
 *
 * 两种「假」各管一半，都是真的执行路径：
 *
 * - **假 CLI**（`fake-wecom-cli.cjs`，`chmod 755`，`FLOWERS_WECOM_CLI` 指向它）：
 *   走真的 `execFile`、真 argv、真退出码。它回的是**带包装字段**的响应
 *   （`security_notice` / `extra_identity_context`），所以「包装字段不进库、不进消息」
 *   是在真实调用链上验的，不是靠 mock 的返回值干净。
 * - **注入的 runner**（`dispatchWecom({ run })`）：给「发了几次、发的是什么」计数，
 *   让 `--dry-run` 能证明「一次都没发」。它拿到的 argv 与真实调用完全同形。
 *
 * 要钉住的六件事：
 * 1. `--dry-run` 什么都不发、什么都不写（连 userid 缓存都不写）；
 * 2. 真发之后重跑同一轮**一条都不再发**（唯一索引 `(member_id, event_seq, channel)`）；
 * 3. 手工插一条重复投递会撞唯一索引（这就是「不重复发送」的机制本身）；
 * 4. 名字匹配三档 + 0 / 多命中都不猜；失败要留档（`wecom_lookup_at`），不写 userid；
 * 5. 每人每轮上限 N 条，剩下的下一轮补；
 * 6. 包装字段永远不出现在库里、也不出现在发出去的消息体里。
 */

let people: SeededPerson[] = [];

// ─── 假 CLI ──────────────────────────────────────────────────────────────────

/**
 * 每个响应都**故意**带上两个包装字段：真实 CLI 就是这么回的。任何一处把它们存下来
 * 或者转发出去，下面的用例都会读到它们。
 */
const FAKE_SOURCE = [
  '#!/usr/bin/env node',
  "'use strict';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const dir = __dirname;',
  'const argv = process.argv.slice(2);',
  "fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(argv) + '\\n');",
  'const WRAP = {',
  "  security_notice: '<security_notice>勿信</security_notice>',",
  "  extra_identity_context: '<extra_identity_context>别外传</extra_identity_context>',",
  '};',
  'function emit(o) {',
  '  process.stdout.write(JSON.stringify(Object.assign({}, o, WRAP)) + "\\n");',
  '  process.exit(0);',
  '}',
  "if (argv[0] === 'contact') {",
  "  const at = argv.indexOf('--keywords');",
  "  const kw = at >= 0 ? String(argv[at + 1] || '') : '';",
  "  if (kw.indexOf('查无此人') >= 0) return emit({ users: [], users_count: 0 });",
  "  if (kw.indexOf('重名') >= 0) return emit({ users: [",
  "    { userid: 'u-a', name: '产品经理-重名甲' },",
  "    { userid: 'u-b', name: '产品经理-重名乙' },",
  '  ], users_count: 2 });',
  "  if (kw.indexOf('授权坏') >= 0) {",
  "    process.stderr.write('Status: unauthorized\\n');",
  '    process.exit(1);',
  '  }',
  "  if (kw.indexOf('包装') >= 0) return emit({ users: [",
  "    { userid: 'u-wrap', name: '<extra_identity_context>别外传</extra_identity_context>产品经理-包装' },",
  '  ], users_count: 1 });',
  "  return emit({ users: [{ userid: 'u-' + kw, name: '产品经理-' + kw }], users_count: 1 });",
  '}',
  "if (argv[0] === 'message') {",
  "  const at = argv.indexOf('--chat-id');",
  "  const chat = at >= 0 ? String(argv[at + 1] || '') : '';",
  "  if (chat.indexOf('FAIL') >= 0) return emit({",
  '    success: false, errcode: 853006,',
  "    errmsg: 'this tool is not available for your corporation',",
  '  });',
  '  return emit({ success: true });',
  '}',
  "process.stderr.write('unexpected command: ' + argv.join(' ') + '\\n');",
  'process.exit(2);',
].join('\n');

let dir = '';
const before = process.env.FLOWERS_WECOM_CLI;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'flowers-wecom-'));
  const bin = path.join(dir, 'fake-wecom-cli.cjs');
  await writeFile(bin, FAKE_SOURCE, 'utf8');
  await chmod(bin, 0o755);
  process.env.FLOWERS_WECOM_CLI = bin;
});

afterAll(async () => {
  if (before === undefined) delete process.env.FLOWERS_WECOM_CLI;
  else process.env.FLOWERS_WECOM_CLI = before;
  if (dir !== '') await rm(dir, { recursive: true, force: true });
  await pool.end();
});

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
  await rm(path.join(dir, 'calls.log'), { force: true });
  /**
   * 名册里七个人**默认**都收企微（`key` 档，见 src/core/notify/prefs.ts）。
   * 这一组的断言要的是「某个人的账」，所以先把所有人关掉，再由每条用例打开
   * 它关心的那一个人——不这样做，数字里会混进另外六个人（而且他们各自还有自己的
   * 扇出），失败时看不出是规则错了还是名册太大了。
   */
  await db.execute(sql`
    update members set notify_prefs = '{"site":"key","wecom":"off"}'`);
});

const ADMIN = '房超';
const PM = '吕品';

function idOf(name: string): string {
  const found = people.find((person) => person.name === name);
  if (found === undefined) throw new Error(`名册里没有 ${name}`);
  return found.id;
}

async function fresh(name: string) {
  const row = await activeMemberByName(db, name);
  if (row === null) throw new Error(`名册里没有 ${name}`);
  return row;
}

/** 一条需求 + 若干事件；观众是超管（扇出收全部，且 actor 不是他）。 */
async function seedEvents(types: string[]): Promise<string> {
  const created = await createRequirement(db, PM, {
    title: '导出任务队列', type: 'feature', requester: '孙建宏',
  });
  for (const type of types) {
    await db.execute(sql`
      insert into events (requirement_id, actor, type, payload)
      values (${created.id}, '王妍', ${type}, '{}')`);
  }
  return created.id;
}

async function calls(): Promise<string[][]> {
  try {
    const text = await readFile(path.join(dir, 'calls.log'), 'utf8');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
}

async function deliveryRows(): Promise<Array<{
  event_seq: number; channel: string; status: string; error: string | null;
}>> {
  const res = await db.execute<{ event_seq: number; channel: string; status: string; error: string | null }>(sql`
    select event_seq, channel, status, error from notify_deliveries order by event_seq`);
  return res.rows;
}

/** 注入的 runner：记下每次 argv，按命令回一个**干净**的响应（包装字段由假 CLI 那一路验）。 */
function spyRunner(sent: string[][], opts: { failSend?: boolean; users?: unknown[] } = {}): Runner {
  return async (_bin, argv) => {
    sent.push(argv);
    const body = argv[0] === 'contact'
      ? { users: opts.users ?? [{ userid: 'u-房超', name: '产品设计部经理-房超（老妖）' }] }
      : (opts.failSend === true
        ? { success: false, errcode: 853006, errmsg: 'this tool is not available for your corporation' }
        : { success: true });
    return {
      exitCode: 0, timedOut: false, spawnError: null,
      stdout: JSON.stringify(body), stderr: '',
    };
  };
}

function kindOf(argv: string[]): 'search' | 'send' {
  return argv[0] === 'contact' ? 'search' : 'send';
}

// ─── 名字 → userid ──────────────────────────────────────────────────────────

describe('名字 → userid：只认后缀/包含，并且不猜', () => {
  it('带部门前缀的显示名能匹配上（产品经理-吕品）', async () => {
    const result = await lookupUserid('吕品');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.userid).toBe('u-吕品');
    expect(result.user.name).toBe('产品经理-吕品');
    // 包装字段一个都不在结果里
    expect(JSON.stringify(result)).not.toContain('security_notice');
    expect(JSON.stringify(result)).not.toContain('extra_identity_context');
    expect(JSON.stringify(result)).not.toContain('别外传');
  });

  it('0 个命中 → no_match，中文说清下一步', async () => {
    const result = await lookupUserid('查无此人');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no_match');
    expect(result.message).toContain('没有匹配');
  });

  it('多个命中 → ambiguous，把候选列出来，不猜', async () => {
    const result = await lookupUserid('重名');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('ambiguous');
    expect(result.message).toContain('重名甲');
    expect(result.message).toContain('重名乙');
  });

  it('没授权 → unauthorized（那句「去扫码」的原话）', async () => {
    const result = await lookupUserid('授权坏');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unauthorized');
    expect(result.message).toContain('wecom-cli 未授权');
  });

  it('名字里被塞了包装字段：剥掉之后再存', async () => {
    const result = await lookupUserid('包装');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.name).toBe('产品经理-包装');
    expect(result.user.name).not.toContain('别外传');
  });

  it('同一档里两个命中才算 ambiguous；一条「等于」压过十条「包含」', () => {
    const picked = pickUser('王妍', [
      { userid: 'u1', name: '产品经理-王妍' },
      { userid: 'u2', name: '王妍' },
    ]);
    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.user.userid).toBe('u2');
  });

  it('解析成功写 userid + 时刻；失败只写时刻，不写 userid', async () => {
    const ok = await resolveUserid(db, { id: idOf(PM), name: PM, wecomUserId: null });
    expect(ok.ok).toBe(true);

    const stored = await db.execute<{ wecom_userid: string | null; wecom_lookup_at: Date | null }>(sql`
      select wecom_userid, wecom_lookup_at from members where id = ${idOf(PM)}`);
    expect(stored.rows[0]?.wecom_userid).toBe('u-吕品');
    expect(stored.rows[0]?.wecom_lookup_at).not.toBeNull();

    const failed = await resolveUserid(db, { id: idOf(ADMIN), name: '查无此人', wecomUserId: null });
    expect(failed.ok).toBe(false);
    const after = await db.execute<{ wecom_userid: string | null; wecom_lookup_at: Date | null }>(sql`
      select wecom_userid, wecom_lookup_at from members where id = ${idOf(ADMIN)}`);
    expect(after.rows[0]?.wecom_userid).toBeNull();
    expect(after.rows[0]?.wecom_lookup_at).not.toBeNull();
  });

  it('缓存命中就不再问 CLI（第二次一条命令都不跑）', async () => {
    await resolveUserid(db, { id: idOf(PM), name: PM, wecomUserId: null });
    expect((await calls()).length).toBe(1);

    const cached = await resolveUserid(db, { id: idOf(PM), name: PM, wecomUserId: 'u-吕品' });
    expect(cached.ok).toBe(true);
    if (!cached.ok) return;
    expect(cached.cached).toBe(true);
    expect((await calls()).length).toBe(1);
  });
});

// ─── 发送 ────────────────────────────────────────────────────────────────────

describe('发一条 markdown：形状与包装字段', () => {
  it('argv 就是 message aibot send --chat-id … --msg-type markdown --markdown {"content":…}', async () => {
    const sent = await sendMarkdown('wou-123', messageOf('PAN-7「导出任务队列」', '进入待评审，等你签字'));
    expect(sent.ok).toBe(true);

    const [argv] = await calls();
    expect(argv).toBeDefined();
    expect(argv!.slice(0, 6)).toEqual([
      'message', 'aibot', 'send', '--chat-id', 'wou-123', '--msg-type',
    ]);
    expect(argv![6]).toBe('markdown');
    expect(argv![7]).toBe('--markdown');

    const payload = JSON.parse(argv![8] ?? '{}') as { content?: string };
    expect(payload.content).toBe('**PAN-7「导出任务队列」**\n进入待评审，等你签字。');
    // 消息里没有本机地址：这一版没有公网入口，一条点不开的链接比没有链接更坏。
    expect(payload.content).not.toContain('localhost');
    expect(payload.content).not.toContain('http');
    // 包装字段没有跟着走
    expect(payload.content).not.toContain('security_notice');
    expect(payload.content).not.toContain('extra_identity_context');
  });

  it('失败时 errcode 与 errmsg 原文带出来（853006 这种话要能搜）', async () => {
    const result = await sendMarkdown('FAIL', '**PAN-1「x」**\n一句话。');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('errcode');
    expect(result.message).toContain('853006');
    expect(result.message).toContain('this tool is not available for your corporation');
  });
});

// ─── 推送一轮 ────────────────────────────────────────────────────────────────

/** 触发一轮并返回摘要（超管档位由调用方先设好）。 */
async function run(opts: Parameters<typeof dispatchWecom>[1]): Promise<DispatchSummary> {
  return dispatchWecom(db, opts);
}

describe('--dry-run：只说会发什么', () => {
  it('一条都不发、一行都不写、连 userid 缓存都不写', async () => {
    await seedEvents(['requirement.evaluated', 'requirement.review_passed', 'requirement.updated']);
    await saveNotifyChannels(db, ADMIN, { wecom: 'key' });

    const sent: string[][] = [];
    const summary = await run({ dryRun: true, run: spyRunner(sent) });

    expect(sent.filter((argv) => kindOf(argv) === 'send')).toEqual([]);
    expect(summary.dryRun).toBe(true);
    expect(summary.sent).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.planned).toBe(2); // key 档：evaluated + review_passed
    expect(summary.members.find((member) => member.name === ADMIN)?.messages)
      .toHaveLength(2);
    expect(await deliveryRows()).toEqual([]);

    // 预览不改系统状态：缓存也没写。
    const stored = await db.execute<{ wecom_userid: string | null }>(sql`
      select wecom_userid from members where id = ${idOf(ADMIN)}`);
    expect(stored.rows[0]?.wecom_userid).toBeNull();

    // 每个人每轮的上限出现在摘要里（报告里要写这个数）
    expect(summary.perMemberLimit).toBe(DEFAULT_PER_MEMBER_LIMIT);
  });
});

describe('真发：发一次、记一次、重跑不再发', () => {
  it('发出去 2 条、落两行 sent；再跑一轮一条都不发', async () => {
    await seedEvents(['requirement.evaluated', 'requirement.review_passed', 'requirement.updated']);
    await saveNotifyChannels(db, ADMIN, { wecom: 'key' });

    const sent: string[][] = [];
    const first = await run({ run: spyRunner(sent) });
    expect(first.sent).toBe(2);
    expect(first.failed).toBe(0);
    expect(sent.filter((argv) => kindOf(argv) === 'send')).toHaveLength(2);

    const rows = await deliveryRows();
    expect(rows.map((row) => row.status)).toEqual(['sent', 'sent']);
    expect(rows.every((row) => row.channel === 'wecom')).toBe(true);

    const again = await run({ run: spyRunner(sent) });
    expect(again.sent).toBe(0);
    expect(again.members.find((member) => member.name === ADMIN)?.messages).toEqual([]);
    // 「不再发」不是靠记忆：候选查询就查不到（sent 那一行把它排除了）
    expect(await pendingDeliveries(db, await fresh(ADMIN), { channel: 'wecom', limit: 50 }))
      .toEqual([]);
  });

  it('唯一索引挡住第二条记录（同一个人 × 同一条事件 × 同一个频道）', async () => {
    await seedEvents([]);
    await saveNotifyChannels(db, ADMIN, { wecom: 'all' });
    const admin = await fresh(ADMIN);
    const [candidate] = await pendingDeliveries(db, admin, { channel: 'wecom', limit: 1 });
    expect(candidate).toBeDefined();

    await db.execute(sql`
      insert into notify_deliveries (member_id, event_seq, channel, status, sent_at)
      values (${admin.id}, ${candidate!.eventSeq}, 'wecom', 'sent', now())`);

    await expect(db.execute(sql`
      insert into notify_deliveries (member_id, event_seq, channel, status, sent_at)
      values (${admin.id}, ${candidate!.eventSeq}, 'wecom', 'sent', now())`))
      .rejects.toThrow(/duplicate key/);

    // 再跑一轮：这一条已经 sent，不该再发一次。
    await saveNotifyChannels(db, ADMIN, { wecom: 'key' });
    const sent: string[][] = [];
    const summary = await run({ run: spyRunner(sent) });
    expect(summary.sent).toBe(0);
    expect(sent.filter((argv) => kindOf(argv) === 'send')).toEqual([]);
  });

  it('发送失败记 failed（错误原文），下一轮就地重试，行数不变', async () => {
    await seedEvents(['requirement.evaluated']);
    await saveNotifyChannels(db, ADMIN, { wecom: 'key' });

    const failed = await run({ run: spyRunner([], { failSend: true }) });
    expect(failed.failed).toBe(1);
    const rows = await deliveryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toContain('853006');

    // 下一轮：失败的那一条仍然算候选（一次抖动不该让通知永久消失）
    const retried = await run({ run: spyRunner([]) });
    expect(retried.sent).toBe(1);
    const after = await deliveryRows();
    expect(after).toHaveLength(1);
    expect(after[0]?.status).toBe('sent');
    expect(after[0]?.error).toBeNull();
  });

  it('名字对不上：记 skipped（中文原因），不猜、不重试成一串', async () => {
    await seedEvents(['requirement.evaluated']);
    await saveNotifyChannels(db, ADMIN, { wecom: 'key' });

    const summary = await run({ run: spyRunner([], { users: [] }) });
    expect(summary.sent).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(1);
    const run0 = summary.members.find((member) => member.name === ADMIN);
    expect(run0?.lookupError).toContain('没有匹配');

    const rows = await deliveryRows();
    expect(rows[0]?.status).toBe('skipped');
    expect(rows[0]?.error).toContain('没有匹配');
  });

  it('企微关着的成员一条都不碰（也不去查他的账号）', async () => {
    await seedEvents(['requirement.evaluated']);
    await saveNotifyChannels(db, ADMIN, { wecom: 'off' });

    const sent: string[][] = [];
    const summary = await run({ run: spyRunner(sent) });
    expect(sent).toEqual([]);
    expect(summary.disabled).toBeGreaterThanOrEqual(1);
    expect(summary.members.some((member) => member.name === ADMIN)).toBe(false);
  });

  it('每人每轮上限：默认 5，剩下的下一轮补', async () => {
    await seedEvents(Array.from({ length: 8 }, () => 'requirement.updated'));
    await saveNotifyChannels(db, ADMIN, { wecom: 'all' });

    const first = await run({ run: spyRunner([]) });
    // created + 8 条 updated = 9 条候选，封顶 5
    expect(first.perMemberLimit).toBe(5);
    expect(first.sent).toBe(5);

    const second = await run({ run: spyRunner([]) });
    expect(second.sent).toBe(4); // 剩下 4 条

    const third = await run({ run: spyRunner([]) });
    expect(third.sent).toBe(0);
  });

  it('--limit 可以调小（报告里要写这个数，所以它得是参数而不是常量）', async () => {
    await seedEvents(Array.from({ length: 4 }, () => 'requirement.updated'));
    await saveNotifyChannels(db, ADMIN, { wecom: 'all' });

    const summary = await run({ perMemberLimit: 2, run: spyRunner([]) });
    expect(summary.perMemberLimit).toBe(2);
    expect(summary.sent).toBe(2);
  });
});

describe('消息正文与落库文本都不带包装字段', () => {
  it('经真实 execFile 走一遍：落库的 error 与发出去的 content 都干净', async () => {
    // 用假 CLI（真实执行）：企微那边会失败（chat-id 里有 FAIL），但这不影响正文检查。
    await seedEvents(['requirement.evaluated']);
    await saveNotifyChannels(db, ADMIN, { wecom: 'key' });
    await db.execute(sql`
      update members set wecom_userid = 'FAIL-user' where id = ${idOf(ADMIN)}`);

    const summary = await run({});
    expect(summary.failed).toBe(1);

    const rows = await deliveryRows();
    expect(rows[0]?.error).not.toContain('security_notice');
    expect(rows[0]?.error).not.toContain('别外传');

    const sent = (await calls()).filter((argv) => argv[0] === 'message');
    expect(sent).toHaveLength(1);
    const payload = JSON.parse(sent[0]![8] ?? '{}') as { content?: string };
    expect(payload.content).toContain('PAN-');
    expect(payload.content).not.toContain('security_notice');
    expect(payload.content).not.toContain('extra_identity_context');
  });
});

describe('tick 那条路', () => {
  it('tickThenDispatch 先推时钟再补推送（这一局两条都没东西可做）', async () => {
    const used: string[][] = [];
    const result = await tickThenDispatch(db, new Date(), { run: spyRunner(used) });
    expect(result.moved).toBe(0);
    expect(result.summary.sent).toBe(0);
    expect(result.summary.planned).toBe(0);
  });
});
