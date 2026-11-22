import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (p: string) => {
    prepare(sqlText: string): { all(): unknown[] };
    close(): void;
  };
};
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import { resetDb, seedPeople, type SeededPerson } from './helpers/db.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { saveNotifyChannels } from '../src/core/members/manage.js';
import { dispatchWecom } from '../src/core/notify/dispatch.js';
import {
  alertDedupKey,
  dailyImageDedupKey,
  enqueueOutbox,
  groupDailyDedupKey,
  groupEventDedupKey,
  outboxEnqueueArgv,
  outboxGroupTarget,
  personalDedupKey,
} from '../src/core/notify/wecom.js';
import { enqueueDailyImage, postGroup, sendGroupCard } from '../src/core/notify/group.js';
import { runAlerts } from '../src/core/alerts/run.js';
import { applyNotifyCleanup20261122 } from '../src/core/notify/cleanup-20261122.js';
import { collectBacklogAudit, renderBacklogAuditMarkdown } from '../src/core/requirements/backlog-audit.js';

const REAL_WECOM_ENQUEUE = path.resolve(
  import.meta.dirname,
  '../../123pan-tools/bin/wecom-enqueue',
);

const MINIMAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

let people: SeededPerson[] = [];
let tempDir = '';
const origEnv = {
  WECOM_ENQUEUE_BIN: process.env.WECOM_ENQUEUE_BIN,
  WECOM_OUTBOX_DB: process.env.WECOM_OUTBOX_DB,
  WECOM_OUTBOX_CONF: process.env.WECOM_OUTBOX_CONF,
  FLOWERS_GROUP_TAG: process.env.FLOWERS_GROUP_TAG,
};

function restoreEnv(): void {
  for (const [k, v] of Object.entries(origEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
  tempDir = await mkdtemp(path.join(tmpdir(), 'flowers-outbox-test-'));
  const confPath = path.join(tempDir, 'wecom.conf');
  const dbPath = path.join(tempDir, 'outbox.db');
  await writeFile(
    confPath,
    JSON.stringify({
      silas_userid: 'wouEv6DQAA71ZeIq-GIEDTmN6msaW0JQ',
      users: {
        silas: 'wouEv6DQAA71ZeIq-GIEDTmN6msaW0JQ',
        房超: 'wouEv6DQAA71ZeIq-GIEDTmN6msaW0JQ',
      },
      webhooks: {
        flowers_main: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=00000000-0000-0000-0000-00000037cdbc',
        flowers_group2: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=00000000-0000-0000-0000-000000528f7e',
        flowers_alert: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=00000000-0000-0000-0000-000000406b56',
      },
    }),
    'utf8',
  );
  process.env.WECOM_ENQUEUE_BIN = REAL_WECOM_ENQUEUE;
  process.env.WECOM_OUTBOX_DB = dbPath;
  process.env.WECOM_OUTBOX_CONF = confPath;
  delete process.env.FLOWERS_GROUP_TAG;

  await db.execute(sql`update members set notify_prefs = '{"site":"key","wecom":"off"}'`);
});

afterEach(async () => {
  restoreEnv();
  if (tempDir !== '') {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

afterAll(async () => {
  await pool.end();
});

function readOutboxRows(): Array<{
  dedup_key: string;
  channel: string;
  target: string;
  msg_type: string;
  payload: string;
  status: string;
}> {
  const dbFile = process.env.WECOM_OUTBOX_DB!;
  if (!existsSync(dbFile)) return [];
  const sqlite = new DatabaseSync(dbFile);
  try {
    return sqlite
      .prepare('SELECT dedup_key, channel, target, msg_type, payload, status FROM outbox_messages ORDER BY id ASC')
      .all() as Array<{
        dedup_key: string;
        channel: string;
        target: string;
        msg_type: string;
        payload: string;
        status: string;
      }>;
  } finally {
    sqlite.close();
  }
}

function idOf(name: string): string {
  const found = people.find((p) => p.name === name);
  if (!found) throw new Error(`missing member ${name}`);
  return found.id;
}

describe('确定性 dedup_key 与目标别名', () => {
  it('四类通知生成稳定、唯一的确定性 dedup_key，群别名按 tag 映射', () => {
    expect(personalDedupKey('m-1', 1680)).toBe('flowers-personal:m-1:1680');
    expect(groupEventDedupKey('', 42)).toBe('flowers-group:main:evt:42');
    expect(groupEventDedupKey('bdf1', 42)).toBe('flowers-group:bdf1:evt:42');
    expect(groupDailyDedupKey('', 'rel-1', '2026-11-22')).toBe('flowers-group:main:daily:rel-1:2026-11-22');
    expect(groupDailyDedupKey('bdf1', 'rel-1', '2026-11-22')).toBe('flowers-group:bdf1:daily:rel-1:2026-11-22');
    expect(dailyImageDedupKey('', 'rel-1', '2026-11-22')).toBe('flowers-daily-img:main:rel-1:2026-11-22');
    expect(dailyImageDedupKey('bdf1', 'rel-1', '2026-11-22')).toBe('flowers-daily-img:bdf1:rel-1:2026-11-22');

    const t0 = new Date('2026-11-22T12:00:00Z');
    const tSameWindow = new Date('2026-11-22T12:15:00Z');
    const tAfterCooldown = new Date(t0.getTime() + 360 * 60_000);
    expect(alertDedupKey('group_failed', 'p0', t0)).toBe(alertDedupKey('group_failed', 'p0', tSameWindow));
    expect(alertDedupKey('group_failed', 'p0', t0)).not.toBe(alertDedupKey('group_failed', 'p0', tAfterCooldown));

    expect(outboxGroupTarget('')).toBe('flowers_main');
    expect(outboxGroupTarget('bdf1')).toBe('flowers_group2');

    expect(outboxEnqueueArgv({
      channel: 'aibot',
      target: 'wouEv6DQAA71ZeIq-GIEDTmN6msaW0JQ',
      type: 'markdown',
      dedupKey: 'flowers-personal:m-1:99',
      content: '**标题**\n正文',
    })).toEqual([
      '--channel', 'aibot',
      '--target', 'wouEv6DQAA71ZeIq-GIEDTmN6msaW0JQ',
      '--type', 'markdown',
      '--dedup-key', 'flowers-personal:m-1:99',
      '--content', '**标题**\n正文',
    ]);
  });
});

describe('真实 wecom-enqueue CLI 合流：个人通知 / 群播报 / 日报图 / 告警', () => {
  it('个人通知（aibot 与个人 webhook）经 wecom-enqueue 入队并写入确定性 dedup_key', async () => {
    const req = await createRequirement(db, '吕品', {
      title: '测试 Outbox 个人推送', type: 'feature', requester: '孙建宏',
    });
    await db.execute(sql`
      insert into events (requirement_id, actor, type, payload)
      values (${req.id}, '王妍', 'requirement.evaluated', '{}')`);

    const fangId = idOf('房超');
    const lvId = idOf('吕品');
    await saveNotifyChannels(db, '房超', { wecom: 'key' });
    await saveNotifyChannels(db, '吕品', { wecom: 'key' });
    await db.execute(sql`
      update members set wecom_userid = 'wouEv6DQAA71ZeIq-GIEDTmN6msaW0JQ', wecom_webhook = null
       where id = ${fangId}`);
    await db.execute(sql`
      update members set wecom_webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=11111111-2222-3333-4444-555555555555'
       where id = ${lvId}`);
    // 让吕品是这条需求的负责人，使其收到 requirement.evaluated
    await db.execute(sql`update requirements set owner_member_id = ${lvId} where id = ${req.id}`);

    const summary = await dispatchWecom(db);
    expect(summary.failed).toBe(0);
    expect(summary.sent).toBe(2);

    const outbox = readOutboxRows();
    expect(outbox).toHaveLength(2);
    const aibotRow = outbox.find((r) => r.channel === 'aibot');
    const hookRow = outbox.find((r) => r.channel === 'webhook');
    expect(aibotRow?.target).toBe('wouEv6DQAA71ZeIq-GIEDTmN6msaW0JQ');
    expect(aibotRow?.dedup_key).toMatch(new RegExp(`^flowers-personal:${fangId}:\\d+$`));
    expect(hookRow?.target).toContain('555555555555');
    expect(hookRow?.dedup_key).toMatch(new RegExp(`^flowers-personal:${lvId}:\\d+$`));
  });

  it('群状态播报、日报卡片与版本日报图经 wecom-enqueue 入队并支持第二群 bdf1 隔离', async () => {
    const mainPost = await postGroup(
      'flowers_main',
      '**PAN-1** 状态更新',
      { dedupKey: groupEventDedupKey('', 501), target: outboxGroupTarget('') },
    );
    expect(mainPost.ok).toBe(true);

    const cardSent = await sendGroupCard(
      'flowers_group2',
      {
        title: '123云盘 研发日报 · 11-22',
        desc: '2026.11 · 还剩 3 个工作日',
        source: { desc: 'Flower · 研发日报', desc_color: 3 },
        emphasis: { title: '80%', desc: '整体进度' },
        stats: [{ keyname: '需求', value: '5 项' }],
        quote: null,
        jumps: [{ title: '查看甘特', url: 'https://flower.dirctable.com/releases' }],
        action: { url: 'https://flower.dirctable.com/releases' },
      },
      { dedupKey: groupDailyDedupKey('bdf1', 'rel-9', '2026-11-22'), target: outboxGroupTarget('bdf1') },
    );
    expect(cardSent.ok).toBe(true);

    const pngPath = path.join(tempDir, 'daily.png');
    await writeFile(pngPath, MINIMAL_PNG);
    const imgSent = await enqueueDailyImage({
      pngPath,
      tag: 'bdf1',
      releaseId: 'rel-9',
      dateKey: '2026-11-22',
    });
    expect(imgSent.ok).toBe(true);

    const rows = readOutboxRows();
    expect(rows.map((r) => ({ key: r.dedup_key, target: r.target, type: r.msg_type }))).toEqual([
      { key: 'flowers-group:main:evt:501', target: 'flowers_main', type: 'markdown' },
      { key: 'flowers-group:bdf1:daily:rel-9:2026-11-22', target: 'flowers_group2', type: 'template_card' },
      { key: 'flowers-daily-img:bdf1:rel-9:2026-11-22', target: 'flowers_group2', type: 'image' },
    ]);
  });

  it('告警在 Outbox 模式下走 flowers_alert 入队且带确定性 dedup_key', async () => {
    await db.execute(sql`insert into group_posts (kind, ref, status, content, created_at)
      values ('events', 'evt:outbox-alert-1', 'failed', 'x', now())`);
    const res = await runAlerts({
      deps: {
        cronLogs: {},
        wecomAuthorized: async () => true,
        probeGate: async () => 302,
      },
    });
    expect(res.failed).toEqual([]);
    expect(res.sent).toContain('group_failed');

    const rows = readOutboxRows();
    expect(rows.some((r) => r.target === 'flowers_alert' && r.dedup_key.startsWith('flowers-alert:group_failed:'))).toBe(true);
  });
});

describe('入队失败不崩溃：错误转为结构化结果并脱敏', () => {
  it('wecom-enqueue 退出非 0、不存在或输出损坏时返回 { ok: false } 且抹掉 key', async () => {
    const brokenBin = path.join(tempDir, 'broken-enqueue.cjs');
    await writeFile(
      brokenBin,
      '#!/usr/bin/env node\nprocess.stderr.write("disk full for https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef1234567890\\n");\nprocess.exit(2);\n',
      'utf8',
    );
    await chmod(brokenBin, 0o755);
    process.env.WECOM_ENQUEUE_BIN = brokenBin;

    const direct = await enqueueOutbox({
      channel: 'webhook',
      target: 'flowers_main',
      type: 'markdown',
      dedupKey: 'flowers-group:main:evt:999',
      content: 'hello',
    });
    expect(direct.ok).toBe(false);
    if (!direct.ok) {
      expect(direct.message).not.toContain('abcdef123456');
      expect(direct.message).toContain('7890');
    }

    const groupRes = await postGroup('flowers_main', 'hello', {
      dedupKey: 'flowers-group:main:evt:1000',
      target: 'flowers_main',
    });
    expect(groupRes.ok).toBe(false);

    process.env.WECOM_ENQUEUE_BIN = path.join(tempDir, 'does-not-exist');
    const missingRes = await enqueueOutbox({
      channel: 'aibot',
      target: 'silas',
      type: 'markdown',
      dedupKey: 'flowers-personal:m:1',
      content: 'hello',
    });
    expect(missingRes.ok).toBe(false);
  });
});

describe('2026-11-22 历史失败清理与存量只读审计', () => {
  it('作废卡死的个人失败通知、关闭赵越直推、修复房超通道后下一轮推送 0 失败且不补发旧账', async () => {
    const fangId = idOf('房超');
    const zhaoId = idOf('赵越');
    await saveNotifyChannels(db, '房超', { wecom: 'key' });
    await saveNotifyChannels(db, '赵越', { wecom: 'key' });
    await db.execute(sql`
      update members
         set wecom_userid = 'wouEv6DQAA71ZeIq-GIEDTmN6msaW0JQ',
             wecom_webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=bad-fang-webhook-000000000000'
       where id = ${fangId}`);
    await db.execute(sql`
      update members
         set wecom_userid = 'wouEv6DQAAvtdZtk6mqXNsd304eOqRVg',
             wecom_webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=bad-zhao-webhook-000000000000'
       where id = ${zhaoId}`);

    const req = await createRequirement(db, '吕品', {
      title: '历史积压测试卡', type: 'commercial', requester: '孙建宏',
    });
    await db.execute(sql`update requirements set owner_member_id = ${zhaoId} where id = ${req.id}`);
    const ev = (await db.execute<{ seq: number }>(sql`
      insert into events (requirement_id, actor, type, payload)
      values (${req.id}, '吕品', 'requirement.evaluated', '{}')
      returning seq`)).rows[0]!;

    await db.execute(sql`
      insert into notify_deliveries (member_id, event_seq, channel, status, error)
      values
        (${fangId}, ${ev.seq}, 'wecom', 'failed', 'e=850003 old failure'),
        (${zhaoId}, ${ev.seq}, 'wecom', 'failed', 'e=850003 old failure')`);

    const cleaned = await applyNotifyCleanup20261122(db, { dryRun: false });
    expect(cleaned.voidedCount).toBe(2);
    expect(cleaned.zhaoDisabled).toBe(true);
    expect(cleaned.fangVerified).toBe(true);

    // 紧接着跑一轮推送：历史作废的 2 条绝不补发，赵越已关，失败 0！
    const after = await dispatchWecom(db);
    expect(after.failed).toBe(0);
    expect(after.sent).toBe(0);
    expect(readOutboxRows()).toEqual([]);
  });

  it('只读对账单准确识别缺版本的 ready/dev/test 卡与同名重复组且不改动任何行', async () => {
    const lvId = idOf('吕品');
    await db.execute(sql`
      insert into requirements (title, state, requester, owner_member_id, state_entered_at)
      values
        ('【企业版】子账号权限管理', 'dev', '王妍', ${lvId}, now() - interval '5 days'),
        ('企业版：子账号权限管理！', 'inbox', '王妍', null, now() - interval '2 days'),
        ('正常已排期需求', 'inbox', '吕品', ${lvId}, now())`);

    const audit = await collectBacklogAudit(db, new Date());
    expect(audit.missingReleaseCards).toHaveLength(1);
    expect(audit.missingReleaseCards[0]?.title).toBe('【企业版】子账号权限管理');
    expect(audit.duplicateGroups).toHaveLength(1);
    expect(audit.duplicateGroups[0]?.items).toHaveLength(2);

    const md = renderBacklogAuditMarkdown(audit);
    expect(md).toContain('【企业版】子账号权限管理');
    expect(md).toContain('PAN-');
  });
});
