import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { resetDb, seedPeople, type SeededPerson } from './helpers/db.js';
import { activeMemberByName } from '../src/core/auth/members.js';
import {
  bindWecomUserid, saveMemberWebhook, testMemberWebhook,
} from '../src/core/members/manage.js';
import {
  BINDING_LABEL, bindingStateOf, checkWebhook, lookupUseridExact, maskWebhook, sendWebhook,
} from '../src/core/notify/wecom.js';
import { dispatchWecom } from '../src/core/notify/dispatch.js';
import { checkWecomBindings } from '../src/core/notify/self-heal.js';
import { wecomBindingView } from '../src/core/read/wecom-binding.js';
import { ENV_CLI } from '../src/core/prd/wecom.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { BRIEF } from './helpers/brief.js';

/**
 * 2026-11-10：成员**自己**绑企微 userid、**自己**用自己的机器人。
 *
 * 这一组钉四件事，每一件都对应 owner 看到的那句抱怨（「今天 企微账号 是一个被算出来的
 * 值，普通人没有一条路能自己绑」）：
 *
 * 1. **贴进来的 userid 真的会被验**：通讯录里没有这个人就不落库，但会留下「试过」的
 *    痕迹（`wecom_lookup_at`），界面据此显示「验证失败」而不是「未绑定」。
 * 2. **webhook 的判据窄而且有解释**：只认企微那一个主机、那一条路径、带 key；错的那几种
 *    各有一句能照着改的中文。
 * 3. **只回显末 4 位**：视图里永远拿不到整串。
 * 4. **设了自己的机器人的人，通知真的走那条**：共用机器人（CLI + userid）完全不参与，
 *    而且他**不会**被自检报成「没绑账号」。
 *
 * 假的 `wecom-cli` 是一个真脚本（`FLOWERS_WECOM_CLI` 指过去），所以「验证」这一步走的是
 * 与线上同一条代码路径（argv、JSON、errcode、匹配）。
 */

let people: SeededPerson[] = [];
let dir: string;

const ADMIN = '房超';
const PM = '吕品';
const WEBHOOK = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd-1234-wxyz';
const WEBHOOK_OTHER = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=9999-zzzz-8888';

/** 通讯录里有两个人：`lvpin`（名字带部门前缀）与 `wangyan`。查不到别人。 */
const FAKE_CLI = `#!/usr/bin/env node
const argv = process.argv.slice(2);
const keywords = argv[argv.indexOf('--keywords') + 1] ?? '';
const USERS = [
  { userid: 'lvpin', name: '产品经理-吕品' },
  { userid: 'wangyan', name: '产品助理-王妍' },
];
const hit = USERS.filter((u) => u.userid.includes(keywords) || u.name.includes(keywords));
process.stdout.write(JSON.stringify({ success: true, users: hit }));
`;

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
  dir = await mkdtemp(path.join(tmpdir(), 'flowers-wecom-'));
  const bin = path.join(dir, 'wecom-cli');
  await writeFile(bin, FAKE_CLI, 'utf8');
  await chmod(bin, 0o755);
  process.env[ENV_CLI] = bin;
});

afterEach(async () => {
  delete process.env[ENV_CLI];
  await rm(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await pool.end();
});

function idOf(name: string): string {
  const found = people.find((person) => person.name === name);
  if (found === undefined) throw new Error(`名册里没有 ${name}`);
  return found.id;
}

/** 从库里重读一行（绑定状态是列上的事实，内存那份会过期）。 */
async function fresh(name: string) {
  const row = await activeMemberByName(db, name);
  if (row === null) throw new Error(`名册里没有 ${name}`);
  return row;
}

describe('绑定状态是算出来的（三种，各有各的下一步）', () => {
  it('有 userid = 已绑定；没试过 = 未绑定；试过没成 = 验证失败', () => {
    expect(bindingStateOf({ wecomUserId: 'lvpin' }, null)).toBe('bound');
    expect(bindingStateOf({ wecomUserId: '  lvpin  ' }, new Date())).toBe('bound');
    expect(bindingStateOf({ wecomUserId: null }, null)).toBe('unbound');
    expect(bindingStateOf({ wecomUserId: null }, new Date('2026-11-10T00:00:00Z'))).toBe('failed');
    // 三个词就是界面上那三个 pill 的字。
    expect(BINDING_LABEL).toEqual({
      bound: '已绑定', need_init: '已绑定 · 未激活', unbound: '未绑定', failed: '验证失败',
    });
  });
});

describe('按 userid 验证：真的去通讯录里看', () => {
  it('命中就回那个人（逐字相等，不看名字像不像）', async () => {
    const found = await lookupUseridExact('lvpin');
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.user.userid).toBe('lvpin');
      expect(found.user.name).toBe('产品经理-吕品');
    }
  });

  it('通讯录里没有这个人 → 一句能照着改的中文', async () => {
    const found = await lookupUseridExact('nobody');
    expect(found.ok).toBe(false);
    if (!found.ok) {
      expect(found.code).toBe('no_match');
      expect(found.message).toContain('没有 userid 为「nobody」的人');
      // 下一步写在句子里：去资料页核对 / 让管理员查通讯录。
      expect(found.message).toContain('资料页');
    }
  });

  it('形状不对的输入在发请求之前就被拦下（粘贴了整段界面文字时）', async () => {
    const found = await lookupUseridExact('企业微信 → 我');
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.message).toContain('字母、数字');
  });

  it('名字里的片段也能查到（`--keywords` 是模糊的），但落库要的是 userid', async () => {
    const found = await lookupUseridExact('wangyan');
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.user.name).toContain('王妍');
  });
});

describe('本人绑定：验过才落库，失败只留「试过」', () => {
  it('成功：库里有了 userid，视图说「已绑定」，userid 全给（它不是秘密）', async () => {
    const result = await bindWecomUserid(db, PM, { userid: 'lvpin' });
    expect(result).toMatchObject({ ok: true, userid: 'lvpin', cleared: false });
    expect((await fresh(PM)).wecomUserId).toBe('lvpin');
    const view = await wecomBindingView(idOf(PM));
    expect(view.state).toBe('bound');
    expect(view.stateLabel).toBe('已绑定');
    expect(view.userid).toBe('lvpin');
  });

  it('失败：userid 一格都不写，但 `wecom_lookup_at` 落章 → 界面显示「验证失败」', async () => {
    const result = await bindWecomUserid(db, PM, { userid: 'nobody' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('没有 userid 为「nobody」的人');
    expect((await fresh(PM)).wecomUserId).toBeNull();
    const view = await wecomBindingView(idOf(PM));
    expect(view.state).toBe('failed');
    expect(view.lastLookupDay).not.toBeNull();
  });

  it('空串 = 解绑：两列一起清，「试过」的痕迹也清掉（否则会显示成验证失败）', async () => {
    await bindWecomUserid(db, PM, { userid: 'lvpin' });
    const cleared = await bindWecomUserid(db, PM, { userid: '   ' });
    expect(cleared).toMatchObject({ ok: true, cleared: true });
    expect((await fresh(PM)).wecomUserId).toBeNull();
    expect((await wecomBindingView(idOf(PM))).state).toBe('unbound');
  });

  it('别人不能替你绑：非超管改不到别人那一行', async () => {
    await expect(bindWecomUserid(db, PM, { memberId: idOf(ADMIN), userid: 'lvpin' }))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect((await fresh(ADMIN)).wecomUserId).toBeNull();
  });
});

describe('自己的机器人：判据窄、只回显末 4 位', () => {
  it('只认企微群机器人的那一个地址，四种错各有各的话', () => {
    expect(checkWebhook(WEBHOOK)).toEqual({ ok: true, url: WEBHOOK });
    const cases: Array<[string, string]> = [
      ['', '空的'],
      ['not-a-url', '不是一个完整的地址'],
      ['http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x', '必须'],
      ['https://evil.example.com/cgi-bin/webhook/send?key=x', 'qyapi.weixin.qq.com'],
      ['https://qyapi.weixin.qq.com/cgi-bin/webhook/send', '没有 key'],
    ];
    for (const [input, expected] of cases) {
      const checked = checkWebhook(input);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.message).toContain(expected);
    }
  });

  it('掩码只留末 4 位，主机与路径照给', () => {
    expect(maskWebhook(WEBHOOK)).toBe(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=****wxyz',
    );
    expect(maskWebhook('')).toBeNull();
    expect(maskWebhook(null)).toBeNull();
    // 太短的 key 一位都不露（与模型 key 的 `keyTail` 同一条规矩）。
    expect(maskWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=ab')).toBe(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=****',
    );
  });

  it('存进去之后，视图里只有掩码，整串拿不到', async () => {
    const saved = await saveMemberWebhook(db, PM, { webhook: WEBHOOK });
    expect(saved).toEqual({
      ok: true, masked: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=****wxyz', cleared: false,
    });
    const view = await wecomBindingView(idOf(PM));
    expect(view.webhookSet).toBe(true);
    expect(view.webhook).not.toContain('abcd-1234');
    expect(JSON.stringify(view)).not.toContain('abcd-1234');
    // 库里仍然是整串（要拿它 POST），只有**视图**是掩码。
    expect((await fresh(PM)).wecomWebhook).toBe(WEBHOOK);
  });

  it('不合法的不落库，而且把原因说清楚', async () => {
    const bad = await saveMemberWebhook(db, PM, { webhook: 'https://evil.example.com/x?key=1' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('qyapi.weixin.qq.com');
    expect((await fresh(PM)).wecomWebhook).toBeNull();
  });

  it('空串 = 清除（回到共用的机器人）', async () => {
    await saveMemberWebhook(db, PM, { webhook: WEBHOOK });
    const cleared = await saveMemberWebhook(db, PM, { webhook: '' });
    expect(cleared).toEqual({ ok: true, masked: null, cleared: true });
    expect((await fresh(PM)).wecomWebhook).toBeNull();
  });

  it('什么都没设时点测试：一句「先把地址贴进来」，不发任何请求', async () => {
    const result = await testMemberWebhook(db, PM, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('还没有 webhook');
  });
});

describe('发一条：成功看 errcode，失败不夹带 key', () => {
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });

  it('errcode=0 就是发出去了；正文是 markdown', async () => {
    let seen: { url: string; body: string } | null = null;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), body: String(init?.body ?? '') };
      return json({ errcode: 0, errmsg: 'ok' });
    }) as typeof fetch;
    const result = await sendWebhook(WEBHOOK, '**标题**\n正文', { fetchImpl: fakeFetch });
    expect(result).toEqual({ ok: true });
    expect(seen!.url).toBe(WEBHOOK);
    expect(JSON.parse(seen!.body)).toEqual({
      msgtype: 'markdown', markdown: { content: '**标题**\n正文' },
    });
  });

  it('HTTP 200 但 errcode 非 0 → 失败（企微业务错误不按状态码报）', async () => {
    const fakeFetch = (async () => json({ errcode: 93000, errmsg: 'invalid webhook url' })) as typeof fetch;
    const result = await sendWebhook(WEBHOOK, 'x', { fetchImpl: fakeFetch });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('invalid webhook url');
      // 原话照登，但不带地址里的 key。
      expect(result.message).not.toContain('abcd-1234');
    }
  });

  it('传给它的不是企微地址 → 一个请求都不发', async () => {
    let called = false;
    const fakeFetch = (async () => { called = true; return json({ errcode: 0 }); }) as typeof fetch;
    const result = await sendWebhook('https://evil.example.com/x', 'x', { fetchImpl: fakeFetch });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe('设了自己机器人的人：通知走那条，共用机器人完全不参与', () => {
  it('dispatch 把消息 POST 到他的 webhook，记一行 sent', async () => {
    const created = await createRequirement(db, ADMIN, {
      ...BRIEF, title: '导出一条队列', type: 'feature', requester: '孙建宏',
      ownerMemberId: idOf(PM),
    });
    // `requirement.evaluated` 是 outcome 类：负责人在 `key` 档也收得到（created 是
    // change 类，默认档不发）。这一条用例要的是「有一条该发的消息」。
    await db.execute(sql`
      insert into events (requirement_id, actor, type, payload)
      values (${created.id}, ${ADMIN}, 'requirement.evaluated', '{}')`);
    await saveMemberWebhook(db, PM, { webhook: WEBHOOK });

    const seen: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 });
    }) as typeof fetch;

    // 共用那条路的 CLI 一律失败：如果代码还走它，sent 一定是 0。
    const summary = await dispatchWecom(db, {
      webhookFetch: fakeFetch,
      run: async () => ({ exitCode: 1, timedOut: false, spawnError: null, stdout: '', stderr: 'shared robot should not be used' }),
    });
    expect(seen).toEqual([WEBHOOK]);
    expect(summary.sent).toBeGreaterThan(0);
    const mine = summary.members.find((member) => member.name === PM);
    expect(mine?.sent).toBeGreaterThan(0);
  });

  it('自检不把「有自己的机器人」的人报成没绑账号', async () => {
    await saveMemberWebhook(db, PM, { webhook: WEBHOOK });
    const alerts = await checkWecomBindings(db, new Date('2026-11-10T04:00:00Z'));
    // 吕品没有 userid，但他有自己的机器人：不该出现在 missing 那一类里。
    expect(alerts.filter((alert) => alert.memberName === PM && alert.reason === 'missing')).toEqual([]);
    // 其他没绑也没机器人的人照旧被报出来（判据没有被这次改动放空）。
    expect(alerts.some((alert) => alert.reason === 'missing')).toBe(true);
  });
});

describe('一个人两条通道不会重复发', () => {
  it('有 webhook 就不再解析 userid：通讯录里一次都没问过这个人', async () => {
    // 让 CLI 把每次问到的关键词记下来——「有没有问过吕品」是这条用例唯一要回答的事。
    const trace = path.join(dir, 'trace.txt');
    await writeFile(trace, '', 'utf8');
    const bin = path.join(dir, 'wecom-cli');
    await writeFile(
      bin,
      '#!/bin/sh\necho "$4" >> "' + trace + '"\nprintf \'{"success":true,"users":[]}\'\n',
      'utf8',
    );
    await chmod(bin, 0o755);

    const created = await createRequirement(db, ADMIN, {
      ...BRIEF, title: '导出一条队列', type: 'feature', requester: '孙建宏',
      ownerMemberId: idOf(PM),
    });
    await db.execute(sql`
      insert into events (requirement_id, actor, type, payload)
      values (${created.id}, ${ADMIN}, 'requirement.evaluated', '{}')`);
    await saveMemberWebhook(db, PM, { webhook: WEBHOOK });

    const fakeFetch = (async () => new Response(JSON.stringify({ errcode: 0 }), { status: 200 })) as typeof fetch;
    await dispatchWecom(db, { webhookFetch: fakeFetch });

    const asked = (await readFile(trace, 'utf8')).split('\n').filter((line) => line !== '');
    // 别人（没设机器人的人）照旧走通讯录——这条路没有因为这次改动被整体关掉。
    expect(asked.length).toBeGreaterThan(0);
    // 但吕品一次都没被问过：他的消息已经由他自己的机器人发了。
    expect(asked).not.toContain(PM);
  });
});
