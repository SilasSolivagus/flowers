import { statSync } from 'node:fs';

import { sql } from 'drizzle-orm';

import { db } from '../../db/client.js';
import { readSetting, writeSetting } from '../uemaster/settings.js';
import { readGroupWebhook } from '../notify/group.js';
import { checkWebhook, sendWebhook } from '../notify/wecom.js';
import { evaluateAlerts, type Alert, type Snapshot } from './rules.js';

/**
 * 告警跑一轮（2026-11-11，H1 的 P0）。
 *
 * 三件事，顺序固定：**量 → 判 → 发**。
 *
 * 1. 量：从库里数失败行、从日志文件的 mtime 算停摆、问一次 wecom-cli、探一次外部门；
 * 2. 判：交给 `rules.ts` 的纯函数（没有任何 I/O，用例能逐条钉）；
 * 3. 发：同一个告警在冷却窗口内只发一次（台账在 `app_settings`，键 `alert.<key>`）。
 *
 * ── 为什么不复用 `notify_deliveries` 那张表
 *
 * 那张表的唯一键是 `(member, event_seq, channel)`——它是「某个人收到了哪条需求事件」的
 * 账。告警不是事件，也没有人；硬塞进去会把「谁收到什么」这件事搅浑。告警需要的是
 * 「这条规则上次什么时候响过」，一个键值足够，`app_settings` 就是现成的键值表。
 *
 * ── 失败怎么办
 *
 * 发不出去**不抛**：告警系统自己坏了，最坏的结果是没告警，而不是把 cron 里整条链
 * 打挂（下一轮还会再试）。发送结果写进返回值，脚本打日志。
 */

export const ALERT_PREFIX = 'alert.';
/** 同一告警的冷却：6 小时内不重复（P0 里最急的那条也会在下一轮再提醒一次）。 */
export const COOLDOWN_MINUTES = 360;

export type AlertRun = {
  checkedAtIso: string;
  snapshot: Snapshot;
  alerts: Alert[];
  sent: string[];
  suppressed: string[];
  failed: string[];
  dryRun: boolean;
};

export type AlertDeps = {
  now?: () => Date;
  /** 测试注入：别真的去问企微 / 探门。 */
  probeGate?: () => Promise<number | null>;
  wecomAuthorized?: () => Promise<boolean>;
  send?: (webhook: string, text: string) => Promise<{ ok: boolean; message?: string }>;
  cronLogs?: Record<string, string>;
  webhook?: string;
};

const DEFAULT_CRON_LOGS: Record<string, string> = {
  'wecom-dispatch': '/var/log/flowers-push.log',
  'group-dispatch': '/var/log/flowers-group.log',
  'sheet-sync': '/var/log/flowers-sheet.log',
};

async function countSince(sqlText: ReturnType<typeof sql>): Promise<number> {
  const res = await db.execute<{ n: number }>(sqlText);
  return Number(res.rows[0]?.n ?? 0);
}

export async function buildSnapshot(deps: AlertDeps = {}): Promise<Snapshot> {
  const groupFailedRecent = await countSince(sql`
    select count(*)::int as n from group_posts
     where status = 'failed' and created_at > now() - interval '30 minutes'`);

  // 注意列名：`sheet_sync` 用的是 `state`（pending / appended / failed），
  // `group_posts` 才是 `status`。两个表不一致是历史原因，这里按各自的真实列写。
  const sheetFailed = await countSince(sql`
    select count(*)::int as n from sheet_sync
     where state = 'failed'`);

  const now = (deps.now ?? (() => new Date()))().getTime();
  const cronAgeMinutes: Record<string, number> = {};
  for (const [task, file] of Object.entries(deps.cronLogs ?? DEFAULT_CRON_LOGS)) {
    try {
      cronAgeMinutes[task] = (now - statSync(file).mtimeMs) / 60_000;
    } catch {
      // 日志文件不存在 = 这个任务从来没跑过，按「无穷久」算，必须报。
      cronAgeMinutes[task] = Number.POSITIVE_INFINITY;
    }
  }

  const wecomAuthorized = deps.wecomAuthorized
    ? await deps.wecomAuthorized()
    : await probeWecomAuthorized();

  const gateStatus = deps.probeGate ? await deps.probeGate() : await probeGate();

  const personalFailedRecent = await countSince(sql`
    select count(*)::int as n from notify_deliveries
     where channel = 'wecom' and status = 'failed'
       and created_at > now() - interval '2 hours'`);

  const queueBacklog = await countSince(sql`
    select count(*)::int as n from requirements
     where deleted_at is null and state = 'queue'`);

  const stuckRes = await db.execute<{ review: number; queue: number; dev: number }>(sql`
    select
      count(*) filter (where state = 'review' and state_entered_at < now() - interval '5 days')::int as review,
      count(*) filter (where state = 'queue' and state_entered_at < now() - interval '5 days')::int as queue,
      count(*) filter (where state = 'dev' and state_entered_at < now() - interval '10 days')::int as dev
      from requirements where deleted_at is null`);
  const stuck = stuckRes.rows[0] ?? { review: 0, queue: 0, dev: 0 };

  const inboxOverdue = await countSince(sql`
    select count(*)::int as n from requirements
     where deleted_at is null and state = 'inbox' and state_entered_at < now() - interval '14 days'`);

  const lateReleases = Number((await db.execute<{ n: number }>(sql`
    select count(distinct release_id)::int as n from requirements
     where deleted_at is null and release_id is not null
       and state not in ('live', 'rejected', 'shelved')
       and commit_due_at < now()`)).rows[0]?.n ?? 0);

  const untestedNearRelease = await countSince(sql`
    select count(*)::int as n from requirements r
      join releases v on v.id = r.release_id
     where r.deleted_at is null and r.state = 'ready'
       and v.release_date between now() and now() + interval '3 days'`);

  const unboundMembers = await countSince(sql`
    select count(*)::int as n from members
     where deactivated_at is null
       and coalesce(nullif(btrim(wecom_userid), ''), nullif(btrim(wecom_webhook), '')) is null`);

  const duplicateTitles = Number((await db.execute<{ n: number }>(sql`
    select count(*)::int as n from (
      select regexp_replace(lower(title), '[^一-龥a-z0-9]', '', 'g') key, count(*) c
        from requirements where deleted_at is null
       group by 1 having count(*) > 1
    ) d`)).rows[0]?.n ?? 0);

  return {
    groupFailedRecent, sheetFailed, cronAgeMinutes, wecomAuthorized, gateStatus,
    personalFailedRecent, queueBacklog, stuck, inboxOverdue,
    lateReleases, untestedNearRelease, unboundMembers, duplicateTitles,
  };
}

/** `wecom-cli auth show` 里出现 authorized 即视为可用；命令不存在也算不可用。 */
async function probeWecomAuthorized(): Promise<boolean> {
  try {
    const { execFile } = await import('node:child_process');
    const out = await new Promise<string>((resolve, reject) => {
      execFile('wecom-cli', ['auth', 'show'], { timeout: 5000 }, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve(`${stdout}${stderr}`);
      });
    });
    return /authorized/i.test(out) && !/unauthor/i.test(out);
  } catch {
    return false;
  }
}

/** 探一次 b123 的门：没登录时 302 才算健康；5xx / 连不上都算坏。 */
async function probeGate(): Promise<number | null> {
  const url = process.env.FLOWERS_GATE_URL ?? 'https://b123.dirctable.com/';
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    return res.status;
  } catch {
    return null;
  }
}

export async function runAlerts(opts: { dryRun?: boolean; deps?: AlertDeps } = {}): Promise<AlertRun> {
  const deps = opts.deps ?? {};
  const now = (deps.now ?? (() => new Date()))();
  const snapshot = await buildSnapshot(deps);
  const alerts = evaluateAlerts(snapshot);

  const run: AlertRun = {
    checkedAtIso: now.toISOString(),
    snapshot,
    alerts,
    sent: [],
    suppressed: [],
    failed: [],
    dryRun: opts.dryRun === true,
  };
  if (alerts.length === 0) return run;

  const webhook = deps.webhook ?? (await readGroupWebhook(db)) ?? '';
  const send = deps.send ?? ((hook: string, text: string) => sendWebhook(hook, text, { fetchImpl: fetch }));

  for (const alert of alerts) {
    const last = await readSetting(db, `${ALERT_PREFIX}${alert.key}`);
    if (last !== null) {
      const ageMinutes = (now.getTime() - new Date(last).getTime()) / 60_000;
      if (Number.isFinite(ageMinutes) && ageMinutes < COOLDOWN_MINUTES) {
        run.suppressed.push(alert.key);
        continue;
      }
    }
    if (run.dryRun) {
      run.sent.push(`${alert.key}（预览）`);
      continue;
    }
    if (webhook === '' || !checkWebhook(webhook).ok) {
      run.failed.push(`${alert.key}：没有可用的群机器人地址`);
      continue;
    }
    const text = `**[告警] ${alert.title}**\n${alert.detail}`;
    const result = await send(webhook, text);
    if (result.ok) {
      await writeSetting(db, `${ALERT_PREFIX}${alert.key}`, now.toISOString());
      run.sent.push(alert.key);
    } else {
      run.failed.push(`${alert.key}：${result.message ?? '发送失败'}`);
    }
  }
  return run;
}
