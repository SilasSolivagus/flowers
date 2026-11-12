import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import { evaluateAlerts, CRON_LIMITS, type Snapshot } from '../src/core/alerts/rules.js';
import { runAlerts, COOLDOWN_MINUTES, COOLDOWN_MINUTES_BY_LEVEL } from '../src/core/alerts/run.js';
import { writeSetting } from '../src/core/uemaster/settings.js';
import { resetDb, seedPeople } from './helpers/db.js';

/**
 * 告警 P0 五条（2026-11-11）。
 *
 * 规则是纯函数（喂快照、拿结论），跑批那层只钉两件事：**冷却**与**不抛**。
 * 每一条规则都要能独立响，不能因为另一条坏了就被吞掉。
 */

const HEALTHY: Snapshot = {
  groupFailedRecent: 0,
  sheetFailed: 0,
  cronAgeMinutes: { 'wecom-dispatch': 3, 'group-dispatch': 4, 'sheet-sync': 8 },
  wecomAuthorized: true,
  gateEdge: 302,
  gateUpstream: 401,
  samples: {},
  personalFailedRecent: 0,
  queueBacklog: 0,
  stuck: { review: 0, queue: 0, dev: 0 },
  inboxOverdue: 0,
  lateReleases: 0,
  untestedNearRelease: 0,
  unboundMembers: 0,
  duplicateTitles: 0,
};

beforeEach(async () => { await resetDb(); await seedPeople(); });
afterAll(async () => { await pool.end(); });

describe('规则：五条各自独立响', () => {
  it('全好 → 一条都不发', () => {
    expect(evaluateAlerts(HEALTHY)).toEqual([]);
  });

  it('群播报失败 / 汇总表失败 3 条以上', () => {
    expect(evaluateAlerts({ ...HEALTHY, groupFailedRecent: 2 }).map((a) => a.key)).toEqual(['group_failed']);
    expect(evaluateAlerts({ ...HEALTHY, sheetFailed: 3 }).map((a) => a.key)).toEqual(['sheet_failed']);
    expect(evaluateAlerts({ ...HEALTHY, sheetFailed: 2 })).toEqual([]);
  });

  it('定时任务超过 2 倍周期没动静（含「日志文件不存在」）', () => {
    const stale = evaluateAlerts({
      ...HEALTHY,
      cronAgeMinutes: { 'sheet-sync': CRON_LIMITS['sheet-sync']! + 1 },
    });
    expect(stale.map((a) => a.key)).toEqual(['cron_stale:sheet-sync']);
    const missing = evaluateAlerts({ ...HEALTHY, cronAgeMinutes: { 'group-dispatch': Number.POSITIVE_INFINITY } });
    expect(missing[0]!.key).toBe('cron_stale:group-dispatch');
  });

  it('企微授权失效 / 门 5xx / 门连不上', () => {
    expect(evaluateAlerts({ ...HEALTHY, wecomAuthorized: false }).map((a) => a.key)).toEqual(['wecom_auth']);
    // 只有一个来源坏 → 不报（上一版的误报就是这么来的）
    expect(evaluateAlerts({ ...HEALTHY, gateEdge: 503 }).map((a) => a.key)).toEqual([]);
    expect(evaluateAlerts({ ...HEALTHY, gateUpstream: null }).map((a) => a.key)).toEqual([]);
    // 两个都坏 → 报
    expect(evaluateAlerts({ ...HEALTHY, gateEdge: 503, gateUpstream: 500 }).map((a) => a.key)).toEqual(['gate_down']);
    expect(evaluateAlerts({ ...HEALTHY, gateEdge: null, gateUpstream: null }).map((a) => a.key)).toEqual(['gate_down']);
  });

  it('P1：个人推送失败 ≥3 条 / 待排期积压 / 卡住 / 收集久放', () => {
    expect(evaluateAlerts({ ...HEALTHY, personalFailedRecent: 3 }).map((a) => a.key)).toEqual(['personal_failed']);
    expect(evaluateAlerts({ ...HEALTHY, personalFailedRecent: 2 })).toEqual([]);
    expect(evaluateAlerts({ ...HEALTHY, queueBacklog: 16 }).map((a) => a.key)).toEqual(['queue_backlog']);
    expect(evaluateAlerts({ ...HEALTHY, stuck: { review: 2, queue: 0, dev: 1 } }).map((a) => a.key)).toEqual(['stuck']);
    expect(evaluateAlerts({ ...HEALTHY, inboxOverdue: 4 }).map((a) => a.key)).toEqual(['inbox_overdue']);
  });

  it('P2/P3：延期版本 / 发版前未提测 / 未绑定成员 / 同名重复', () => {
    expect(evaluateAlerts({ ...HEALTHY, lateReleases: 1 }).map((a) => a.key)).toEqual(['release_late']);
    expect(evaluateAlerts({ ...HEALTHY, untestedNearRelease: 2 }).map((a) => a.key)).toEqual(['release_untested']);
    expect(evaluateAlerts({ ...HEALTHY, unboundMembers: 4 }).map((a) => a.key)).toEqual(['member_unbound']);
    expect(evaluateAlerts({ ...HEALTHY, duplicateTitles: 6 }).map((a) => a.key)).toEqual(['duplicate_titles']);
  });

  it('多个问题同时坏 → 每条都报（不互相吞）', () => {
    const keys = evaluateAlerts({
      ...HEALTHY, groupFailedRecent: 1, sheetFailed: 5, wecomAuthorized: false,
      gateEdge: 502, gateUpstream: null,
    }).map((a) => a.key).sort();
    expect(keys).toEqual(['gate_down', 'group_failed', 'sheet_failed', 'wecom_auth']);
  });
});

describe('跑批：冷却与「发不出去也不炸」', () => {
  it('第一次发、第二次在冷却窗口内被压住', async () => {
    const sent: string[] = [];
    const deps = {
      cronLogs: {},
      wecomAuthorized: async () => true,
      probeGate: async () => 302,
      webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=00000000-0000-0000-0000-000000000000',
      send: async (_hook: string, text: string) => { sent.push(text); return { ok: true }; },
    };
    await db.execute(sql`insert into group_posts (kind, ref, status, content, created_at)
      values ('events', 'evt:test-1', 'failed', 'x', now())`);

    const first = await runAlerts({ deps });
    expect(first.sent).toContain('group_failed');
    // P3 的「成员未绑定」在测试库里也会响（7 个人都没绑），所以不按顺序断言第一条。
    expect(sent.some((text) => text.includes('群播报失败'))).toBe(true);
    // 消息必须带「下一步」与级别，否则群里没人知道该动什么。
    expect(sent[0]).toContain('下一步：');
    expect(sent[0]).toContain('告警 · P');

    const second = await runAlerts({ deps });
    expect(second.suppressed).toContain('group_failed');
    expect(second.sent).not.toContain('group_failed');
  });

  it('P1–P3 是 3 天冷却，P0 仍是 6 小时', () => {
    expect(COOLDOWN_MINUTES_BY_LEVEL.p0).toBe(360);
    expect(COOLDOWN_MINUTES_BY_LEVEL.p1).toBe(4320);
    expect(COOLDOWN_MINUTES_BY_LEVEL.p3).toBe(4320);
  });

  it('过了冷却窗口会再发一次', async () => {
    await writeSetting(db, 'alert.group_failed', new Date(Date.now() - (COOLDOWN_MINUTES + 5) * 60_000).toISOString());
    await db.execute(sql`insert into group_posts (kind, ref, status, content, created_at)
      values ('events', 'evt:test-2', 'failed', 'x', now())`);
    const run = await runAlerts({
      deps: {
        cronLogs: {}, wecomAuthorized: async () => true, probeGate: async () => 302,
        webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=00000000-0000-0000-0000-000000000000',
        send: async () => ({ ok: true }),
      },
    });
    expect(run.sent).toContain('group_failed');
  });

  it('没有可用的机器人地址 → 记 failed，不抛', async () => {
    await db.execute(sql`insert into group_posts (kind, ref, status, content, created_at)
      values ('events', 'evt:test-3', 'failed', 'x', now())`);
    const run = await runAlerts({
      deps: { cronLogs: {}, wecomAuthorized: async () => true, probeGate: async () => 302, webhook: '' },
    });
    expect(run.failed.some((text) => text.startsWith('group_failed'))).toBe(true);
  });
});

describe('门探活参数（2026-11-12 修 hairpin）', () => {
  it('域名钉到 127.0.0.1，端口跟着 URL 走', async () => {
    const { gateProbeArgs } = await import('../src/core/alerts/run.js');
    const args = gateProbeArgs('https://b123.dirctable.com/');
    expect(args[args.indexOf('--resolve') + 1]).toBe('b123.dirctable.com:443:127.0.0.1');
    expect(args).toContain('-k');
    expect(args[args.length - 1]).toBe('https://b123.dirctable.com/');
  });
});
