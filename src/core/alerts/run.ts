import { statSync } from 'node:fs';

import { sql } from 'drizzle-orm';

import { db } from '../../db/client.js';
import { readSetting, writeSetting } from '../uemaster/settings.js';
import { readAlertWebhook } from '../notify/group.js';
import { checkWebhook, sendWebhook } from '../notify/wecom.js';
import { LEVEL_LABEL, evaluateAlerts, type Alert, type Snapshot } from './rules.js';

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
/**
 * 冷却（2026-11-11 owner 的口径：**3 天响一次**）。
 *
 * 但 P0 不能等 3 天：群发不出去、门挂了、任务停摆这些是「现在就坏了」，6 小时后还坏着
 * 就该再喊一次。所以按级别分：
 * - P0：6 小时（故障持续就该持续提醒）；
 * - P1–P3：72 小时（积压、久放、重复这些是慢性问题，一天响几次只会让人屏蔽它）。
 */
export const COOLDOWN_MINUTES_BY_LEVEL: Record<string, number> = {
  p0: 360,
  p1: 4320,
  p2: 4320,
  p3: 4320,
};

/** 兼容旧调用点：默认冷却（P0 那一档）。 */
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
  probeUpstream?: () => Promise<number | null>;
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

  const gateEdge = deps.probeGate ? await deps.probeGate() : await probeGate();
  const gateUpstream = deps.probeUpstream ? await deps.probeUpstream() : await probeUpstream();

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

  // 每条告警最多举 3 个例子：群消息里「19 条」没人能动手，「PAN-380 吕品 5 天」能。
  const sample = async (query: ReturnType<typeof sql>): Promise<string[]> => {
    const res = await db.execute<{ label: string }>(query);
    return res.rows.map((row) => row.label).filter((label) => label.trim() !== '').slice(0, 3);
  };

  /**
   * 每个告警要 @ 谁（2026-11-11 owner：群里必须 @ 到人）。
   *
   * 名单 = 样本里那几条的负责人 + 他们条线的负责人（同一行里 `role` 为条线负责人的成员）。
   * 没有 wecom_userid 的人不进名单——企微 @ 需要 userid，@ 一个名字是空动作。
   */
  const mentionRows = async (query: ReturnType<typeof sql>): Promise<Array<{
    userid: string; name: string; lead: boolean;
  }>> => {
    const res = await db.execute<{ userid: string; name: string; lead: boolean }>(query);
    const seen = new Map<string, { userid: string; name: string; lead: boolean }>();
    for (const row of res.rows) if (!seen.has(row.userid)) seen.set(row.userid, row);
    return [...seen.values()].slice(0, 5);
  };

  const OWNER_AND_LEAD = sql`
    select distinct u.wecom_userid as userid, u.name as name,
           (u.role in ('feature_reviewer','commercial_reviewer')) as lead
      from requirements r
      join members o on o.id = r.owner_member_id
      join members u on u.id = o.id
                      or (u.role in ('feature_reviewer','commercial_reviewer') and u.line = o.line)
     where r.deleted_at is null and u.wecom_userid is not null and u.wecom_userid <> ''`;

  const mentions: Record<string, Array<{ userid: string; name: string; lead: boolean }>> = {
    queue_backlog: await mentionRows(sql`${OWNER_AND_LEAD} and r.state = 'queue'`),
    stuck: await mentionRows(sql`${OWNER_AND_LEAD}
      and ((r.state = 'review' and r.state_entered_at < now() - interval '5 days')
        or (r.state = 'queue' and r.state_entered_at < now() - interval '5 days')
        or (r.state = 'dev' and r.state_entered_at < now() - interval '10 days'))`),
    inbox_overdue: await mentionRows(sql`${OWNER_AND_LEAD}
      and r.state = 'inbox' and r.state_entered_at < now() - interval '14 days'`),
    release_late: await mentionRows(sql`${OWNER_AND_LEAD} and r.release_id is not null
      and r.state not in ('live','rejected','shelved') and r.commit_due_at < now()`),
    release_untested: await mentionRows(sql`${OWNER_AND_LEAD}
      and r.release_id is not null and r.state = 'ready'`),
    personal_failed: await mentionRows(sql`
      select distinct u.wecom_userid as userid, u.name as name, false as lead
        from notify_deliveries d join members u on u.id = d.member_id
       where d.channel = 'wecom' and d.status = 'failed'
         and d.created_at > now() - interval '2 hours'
         and u.wecom_userid is not null`),
  };

  const samples: Record<string, string[]> = {
    queue_backlog: await sample(sql`
      select 'PAN-' || number || ' ' || left(title, 18) || coalesce(' · ' || m.name, ' · 未指派')
             || ' · ' || ${SAMPLE_AGE} as label
        from requirements r left join members m on m.id = r.owner_member_id
       where r.deleted_at is null and r.state = 'queue'
       order by coalesce(r.state_entered_at, now()) asc limit 3`),
    stuck: await sample(sql`
      select 'PAN-' || number || ' ' || left(title, 18) || ' · ' || coalesce(m.name, '未指派')
             || ' · ' || ${SAMPLE_AGE} as label
        from requirements r left join members m on m.id = r.owner_member_id
       where r.deleted_at is null
         and ((state = 'review' and state_entered_at < now() - interval '5 days')
           or (state = 'queue' and state_entered_at < now() - interval '5 days')
           or (state = 'dev' and state_entered_at < now() - interval '10 days'))
       order by state_entered_at asc limit 3`),
    inbox_overdue: await sample(sql`
      select 'PAN-' || number || ' ' || left(title, 20) || coalesce(' · ' || m.name, ' · 未指派') as label
        from requirements r left join members m on m.id = r.owner_member_id
       where r.deleted_at is null and r.state = 'inbox'
         and state_entered_at < now() - interval '14 days'
       order by state_entered_at asc limit 3`),
    release_late: await sample(sql`
      select 'PAN-' || r.number || ' ' || left(r.title, 18) || ' · ' || v.name as label
        from requirements r join releases v on v.id = r.release_id
       where r.deleted_at is null and r.state not in ('live','rejected','shelved')
         and r.commit_due_at < now()
       order by r.commit_due_at asc limit 3`),
    release_untested: await sample(sql`
      select 'PAN-' || r.number || ' ' || left(r.title, 18) || ' · ' || v.name as label
        from requirements r join releases v on v.id = r.release_id
       where r.deleted_at is null and r.state = 'ready'
         and v.release_date between now() and now() + interval '3 days'
       order by v.release_date asc limit 3`),
    member_unbound: await sample(sql`
      select name as label from members
       where deactivated_at is null
         and coalesce(nullif(btrim(wecom_userid), ''), nullif(btrim(wecom_webhook), '')) is null
       order by name limit 3`),
    duplicate_titles: await sample(sql`
      select string_agg('PAN-' || number, ' / ') as label
        from requirements
       where deleted_at is null
       group by regexp_replace(lower(title), '[^一-龥a-z0-9]', '', 'g')
      having count(*) > 1
       order by count(*) desc limit 3`),
    personal_failed: await sample(sql`
      select distinct m.name as label
        from notify_deliveries d join members m on m.id = d.member_id
       where d.channel = 'wecom' and d.status = 'failed'
         and d.created_at > now() - interval '2 hours'
       limit 3`),
    group_failed: await sample(sql`
      select 'evt:' || coalesce(ref, '?') || ' · ' || left(coalesce(error, ''), 30) as label
        from group_posts where status = 'failed'
       order by created_at desc limit 3`),
    sheet_failed: await sample(sql`
      select 'PAN-' || r.number || ' ' || left(r.title, 18) as label
        from sheet_sync s join requirements r on r.id = s.requirement_id
       where s.state = 'failed' limit 3`),
  };

  return {
    samples, mentions,
    groupFailedRecent, sheetFailed, cronAgeMinutes, wecomAuthorized, gateEdge, gateUpstream,
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

/**
 * 门的探活地址与参数（2026-11-12 修）。
 *
 * 事故：告警从凌晨开始每 6 小时报一次「看板门不可用」，但外部访问一直是 302。
 * 原因是探活从服务器打自己的**公网域名**：云主机没有 hairpin NAT，Node 的 fetch
 * 连 47.115.229.192:443 会超时（curl 也时好时坏），而这条链路根本不是用户走的那条。
 *
 * 现在用 `curl --resolve` 把域名钉到 **127.0.0.1**：仍然是「真的过一遍 edge 的
 * server 块与 auth_request」，只是不绕公网。`FLOWERS_GATE_URL` 仍然可以覆盖。
 */
export function gateProbeArgs(rawUrl = process.env.FLOWERS_GATE_URL ?? 'https://b123.dirctable.com/'): string[] {
  const url = new URL(rawUrl);
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
  const insecure = url.protocol === 'https:' ? ['-k'] : [];
  return [
    ...insecure, '--max-time', '6', '-o', '/dev/null', '-w', '%{http_code}',
    '--resolve', `${url.hostname}:${port}:127.0.0.1`, url.href,
  ];
}

/**
 * 上游那一半：直连 flowers 的校验口（不经过 edge），正常应为 401 / 200。
 * 走 `http://127.0.0.1:${PORT}`，端口取 `FLOWERS_PORT`，默认 3010。
 */
async function probeUpstream(): Promise<number | null> {
  const port = process.env.FLOWERS_PORT ?? '3010';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/check?perm=b123`, {
      redirect: 'manual', signal: AbortSignal.timeout(5000),
    });
    return res.status;
  } catch {
    return null;
  }
}

async function probeGate(): Promise<number | null> {
  try {
    const { execFile } = await import('node:child_process');
    const out = await new Promise<string>((resolve, reject) => {
      execFile('curl', gateProbeArgs(), { timeout: 8000 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
    });
    const code = Number(out);
    return Number.isFinite(code) && code > 0 ? code : null;
  } catch {
    // curl 不可用（少见）→ 退回原来的公网探活；它至少能回答「外部到底通不通」。
    try {
      const url = process.env.FLOWERS_GATE_URL ?? 'https://b123.dirctable.com/';
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      return res.status;
    } catch {
      return null;
    }
  }
}

/**
 * 样本里的「多久了」：**从事件表回溯**最后一次进入当前状态的时刻。
 *
 * 迁移把 `state_entered_at` 一律刷成切换那天，直接用它算会得到「208 天」这种假数字。
 * 事件里有「进入这个状态」的记录，取最后一次即可；没有记录（迁移来的）就退回
 * `state_entered_at`，并在文案里说「自迁移起」。
 */
const SAMPLE_AGE = sql`(
  select case
    when last.at is null then '自迁移起 ' || greatest(extract(day from now() - r.state_entered_at)::int, 0) || ' 天'
    when now() - last.at < interval '1 day' then '刚进来'
    else extract(day from now() - last.at)::int || ' 天'
  end
  from (select (select max(e.at) from events e
                 where e.requirement_id = r.id
                   and e.payload::jsonb ->> 'to' = r.state) as at) last
)`;

function webhookBase(): string {
  return (process.env.FLOWERS_PUBLIC_URL ?? '').replace(/\/+$/, '');
}

/**
 * 一条告警长什么样（2026-11-11 第二次改）。
 *
 * 第一版只写「待排期积压 19 条，超过 15 条的线」——群里没人知道那是谁的、下一步做什么。
 * 现在固定四段：**级别 → 现在多少 → 具体哪几条 → 下一步（带链接）**，最后一行说明
 * 多久再提醒。不是越长越好：例子最多 3 条，其余说「等」。
 */
/**
 * 带 @ 的文本消息。`send` 是注入的那条通道（测试里是假的），所以这里只拼请求体，
 * 真正的 POST 仍走 `sendWebhook`——它认 markdown；text 需要另一条路径。
 */
async function sendTextWithMentions(
  webhook: string,
  text: string,
  userids: string[],
  _send: (webhook: string, text: string) => Promise<{ ok: boolean; message?: string }>,
): Promise<{ ok: boolean; message?: string }> {
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'text',
      text: { content: text, mentioned_list: userids },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return { ok: false, message: `HTTP ${response.status}` };
  const payload = (await response.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
  if (payload.errcode !== undefined && payload.errcode !== 0) {
    return { ok: false, message: `errcode ${payload.errcode}：${payload.errmsg ?? ''}` };
  }
  return { ok: true };
}

export function renderAlert(
  alert: Alert,
  base: string,
  targets: Array<{ userid: string; name: string; lead: boolean }> = [],
): string {
  const lines = [
    `**[告警 · ${LEVEL_LABEL[alert.level]}] ${alert.title}**`,
    `现在：${alert.detail}`,
  ];
  if (alert.samples.length > 0) {
    lines.push('具体是：');
    for (const sample of alert.samples) lines.push(`· ${sample}`);
    if (alert.samples.length === 3) lines.push('· ……其余不逐条列');
  }
  if (targets.length > 0) {
    const leads = targets.filter((t) => t.lead).map((t) => t.name);
    lines.push(`相关人：${targets.map((t) => `@${t.name}`).join(' ')}`);
    if (leads.length > 0) {
      lines.push(`其中 ${leads.join('、')} 是条线负责人，请安排人处理（派活 / 改排期 / 搁置）。`);
    }
  }
  lines.push(`下一步：${alert.nextStep}`);
  if (base !== '') lines.push(base + alert.link);
  const cooldown = alert.level === 'p0' ? '6 小时' : '3 天';
  lines.push(`（同类问题 ${cooldown}内不再提醒 · flowers）`);
  return lines.join('\n');
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

  // 告警有自己的机器人（owner 2026-11-12：告警与业务播报分开，别淹产品群）。
  const webhook = deps.webhook ?? (await readAlertWebhook(db)) ?? '';
  const send = deps.send ?? ((hook: string, text: string) => sendWebhook(hook, text, { fetchImpl: fetch }));

  for (const alert of alerts) {
    const last = await readSetting(db, `${ALERT_PREFIX}${alert.key}`);
    if (last !== null) {
      const ageMinutes = (now.getTime() - new Date(last).getTime()) / 60_000;
      const cooldown = COOLDOWN_MINUTES_BY_LEVEL[alert.level] ?? 360;
      if (Number.isFinite(ageMinutes) && ageMinutes < cooldown) {
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
    const targets = snapshot.mentions?.[alert.key] ?? [];
    const mentioned = targets.filter((t) => t.userid.trim() !== '');
    const text = renderAlert(alert, webhookBase(), mentioned);

    /**
     * 有要 @ 的人 → 用 **text** 消息（企微只有 text 支持 mentioned_list；markdown 不行），
     * 没有要 @ 的人 → 仍用 markdown（能加粗、能点链接）。
     * 这是企微的能力边界，不是我们偷懒。
     */
    if (mentioned.length > 0) {
      const res = await sendTextWithMentions(webhook, text, mentioned.map((t) => t.userid), send);
      if (res.ok) {
        await writeSetting(db, `${ALERT_PREFIX}${alert.key}`, now.toISOString());
        run.sent.push(alert.key);
      } else {
        run.failed.push(`${alert.key}：${res.message ?? '发送失败'}`);
      }
      continue;
    }
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
