/**
 * 群播报（2026-11-10）：两条口径，一个脚本。
 *
 * ```bash
 * npx tsx scripts/group-dispatch.ts                    # 状态变动（还没播过的事件）
 * npx tsx scripts/group-dispatch.ts --daily            # 版本每日进展
 * npx tsx scripts/group-dispatch.ts --dry-run          # 只打印要发什么
 * npx tsx scripts/group-dispatch.ts --webhook <URL>    # 保存团队群机器人 webhook
 * ```
 *
 * 发到**团队群**（企微群机器人 webhook），不是发给个人——个人推送在
 * `scripts/wecom-dispatch.ts`，两条路各有各的台账（`notify_deliveries` / `group_posts`）。
 *
 * ## 一轮合成一条
 *
 * 最多 `--limit` 条事件（默认 10）合成一条消息。逐条发会让一个上午的评审通过变成
 * 五次手机震动，而且群机器人有 20 条/分钟的频控。台账按事件逐行记（`evt:<seq>`），
 * 所以「这一条播过没有」仍然精确到条，而不是精确到这一轮。
 *
 * ## 先落 pending 再发
 *
 * 与 `notify_deliveries` 同一条理由：消息发出去收不回来，记号必须先于发送存在。
 * 发送失败把那几行改成 failed，下一轮按原样再发一遍；成功则 sent。
 *
 * ## 退出码
 *
 * 有 failed 时为 1（给 cron 一个响动）；没有配置 webhook 时为 2，并说清怎么配。
 */
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import {
  BATCH_MAX, KIND_DAILY, KIND_EVENTS, pendingGroupEvents, postGroup, publicBaseUrl,
  readGroupWebhook, readWatermark, renderEventMessage, saveGroupWebhook, sendGroupCard,
  writeWatermark,
} from '../src/core/notify/group.js';
import {
  groupDailyDedupKey, outboxGroupTarget, resolveOutboxBin, clipBytes,
} from '../src/core/notify/wecom.js';
import { listReleases } from '../src/core/read/version.js';
import { todayInShanghai, versionCards } from '../src/core/read/version-daily.js';

type Args = { daily: boolean; dryRun: boolean; limit: number; webhook: string | null; init: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { daily: false, dryRun: false, limit: BATCH_MAX, webhook: null, init: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--daily') { args.daily = true; continue; }
    if (arg === '--events') { args.daily = false; continue; }
    if (arg === '--dry-run') { args.dryRun = true; continue; }
    if (arg === '--init') { args.init = true; continue; }
    if (arg === '--limit') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error('--limit 要一个正整数');
      args.limit = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === '--webhook') {
      const value = argv[i + 1];
      if (!value) throw new Error('--webhook 要给一个群机器人地址');
      args.webhook = value;
      i += 1;
      continue;
    }
    throw new Error(`认不出的参数：${arg}（只认 --init / --daily / --events / --dry-run / --limit N / --webhook URL）`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

try {
  if (args.webhook !== null) {
    const saved = await saveGroupWebhook(db, args.webhook);
    process.stdout.write(`已保存团队群 webhook（末 4 位 …${saved.slice(-4)}）\n`);
  }

  if (args.init) {
    const seq = await writeWatermark(db);
    process.stdout.write(`已记下起始水位：events.seq <= ${seq} 的历史事件不再补播。\n`);
  }

  const tag = (process.env.FLOWERS_GROUP_TAG ?? '').trim();
  const outboxEnabled = resolveOutboxBin() !== null;
  const target = outboxGroupTarget(tag);
  const webhook = await readGroupWebhook(db);
  const baseUrl = await publicBaseUrl(db);

  // dry-run 或已启用统一 Outbox 时不需要库里存明文 webhook（wecom.conf 按别名解析）。
  if (webhook === null && !outboxEnabled && !args.dryRun) {
    process.stderr.write(
      '没有配置团队群 webhook：用 --webhook <企微群机器人地址> 保存一次，或设 FLOWERS_GROUP_WEBHOOK。\n',
    );
    process.exitCode = 2;
  } else if (args.daily) {
    const today = todayInShanghai();
    const cards = versionCards(await listReleases(), today, baseUrl);
    if (cards.length === 0) {
      process.stdout.write('今天没有要播的版本。\n');
    } else {
      const dateKey = new Date(today * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      for (const { releaseId, releaseName, card } of cards) {
        const ref = `daily:${releaseId}:${dateKey}${tag === '' ? '' : ':' + tag}`;
        const already = (await db.execute<{ n: number }>(sql`
          select count(*)::int as n from group_posts
           where kind = ${KIND_DAILY} and ref = ${ref} and status = 'sent'`)).rows[0]?.n ?? 0;
        if (already > 0) {
          process.stdout.write(`${releaseName}：今天已经发过，跳过（${ref}）\n`);
          continue;
        }
        if (args.dryRun) {
          process.stdout.write(`[dry-run] ${ref}\n${JSON.stringify(card, null, 2)}\n`);
          continue;
        }
        await db.execute(sql`
          insert into group_posts (kind, ref, content, status)
          values (${KIND_DAILY}, ${ref}, ${JSON.stringify(card)}, 'pending')
          on conflict (kind, ref) do nothing`);
        const sent = await sendGroupCard(webhook ?? target, card, {
          dedupKey: groupDailyDedupKey(tag, releaseId, dateKey),
          target,
        });
        if (sent.ok) {
          await db.execute(sql`
            update group_posts set status = 'sent', posted_at = now(), attempts = attempts + 1
             where kind = ${KIND_DAILY} and ref = ${ref}`);
          process.stdout.write(`已发：${releaseName} 研发日报（${ref}）\n`);
        } else {
          await db.execute(sql`
            update group_posts set status = 'failed', error = ${sent.message}, attempts = attempts + 1
             where kind = ${KIND_DAILY} and ref = ${ref}`);
          process.stderr.write(`发送失败：${releaseName} ${sent.message}\n`);
          process.exitCode = 1;
        }
      }
    }
  } else {
    const watermark = await readWatermark(db);
    if (watermark === 0 && !args.dryRun) {
      process.stderr.write(
        '还没设起始水位：先跑一次 --init，否则会把历史事件全部补播一遍（几百条）。\n',
      );
      process.exitCode = 3;
      throw new Error('watermark-missing');
    }
    const items = await pendingGroupEvents(db, args.limit, watermark);
    if (items.length === 0) {
      process.stdout.write('没有新的状态变动。\n');
    } else if (args.dryRun) {
      const preview = items
        .map((item) => renderEventMessage(item, baseUrl))
        .filter((text): text is string => text !== null);
      process.stdout.write(`[dry-run] 将播 ${preview.length} 条：\n${preview.join('\n---\n')}\n`);
    } else {
      const ready = items.map((item) => ({ item, content: renderEventMessage(item, baseUrl) }))
        .filter((row): row is { item: typeof items[number]; content: string } => row.content !== null);
      const chunks: string[] = [];
      if (ready.length === 1) chunks.push(ready[0]!.content);
      else {
        let chunk = `**需求状态变动（${ready.length} 条）**`;
        for (const row of ready) {
          const candidate = `${chunk}\n\n---\n\n${row.content}`;
          if (Buffer.byteLength(candidate, 'utf8') > 3900 && chunk !== `**需求状态变动（${ready.length} 条）**`) {
            chunks.push(chunk);
            chunk = `**需求状态变动（${ready.length} 条，续）**\n\n${row.content}`;
          } else chunk = candidate;
        }
        if (chunk !== `**需求状态变动（${ready.length} 条）**`) chunks.push(clipBytes(chunk, 3900));
      }
      for (const { item, content: eventContent } of ready) {
        await db.execute(sql`insert into group_posts (kind, ref, content, status)
          values (${KIND_EVENTS}, ${`evt:${item.seq}`}, ${eventContent}, 'pending')
          on conflict (kind, ref) do nothing`);
      }
      if (ready.length > 0) {
        let posted: { ok: boolean; message?: string } = { ok: true };
        for (const [index, digest] of chunks.entries()) {
          posted = await postGroup(webhook ?? target, digest, {
            dedupKey: `flowers-group-digest:${ready.map(({ item }) => item.seq).join(',')}:${index}`,
            target,
          });
          if (!posted.ok) break;
        }
        for (const { item } of ready) await db.execute(sql`update group_posts
          set status = ${posted.ok ? 'sent' : 'failed'}, error = ${posted.ok ? null : posted.message},
              posted_at = ${posted.ok ? sql`now()` : sql`null`}, attempts = attempts + 1
          where kind = ${KIND_EVENTS} and ref = ${`evt:${item.seq}`} and status <> 'sent'`);
        if (!posted.ok) { process.stderr.write(`发送失败：${posted.message}\n`); process.exitCode = 1; }
        process.stdout.write(`本轮：合并 ${ready.length} 条，${posted.ok ? '已发送 1 条' : '发送失败'}\n`);
      }
    }
  }
} catch (error) {
  // 水位缺失已经用中文说过了，不再打一段栈——cron 的日志里那一行足够定位。
  if (!(error instanceof Error && error.message === 'watermark-missing')) throw error;
} finally {
  await pool.end();
}
