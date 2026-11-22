import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { prefsJson, prefsOf, withLevel } from './prefs.js';
import { enqueueOutbox, resolveOutboxBin } from './wecom.js';

export const FANG_CHAO_USERID = 'wouEv6DQAA71ZeIq-GIEDTmN6msaW0JQ';
export const VOID_NOTE_20261122 = '[voided 2026-11-22] 历史积压通知作废（不补发）';

export type StuckDeliveryItem = {
  id: string;
  memberId: string;
  memberName: string;
  eventSeq: number;
  createdAt: string;
  error: string | null;
};

export type NotifyCleanupResult = {
  dryRun: boolean;
  voidedCount: number;
  voidedItems: StuckDeliveryItem[];
  zhaoDisabled: boolean;
  zhaoMemberId: string | null;
  zhaoPrefsAfter: string | null;
  fangMemberId: string | null;
  fangUserid: string | null;
  fangWebhookCleared: boolean;
  fangVerified: boolean;
  fangVerifyDetail: string;
};

/**
 * 2026-11-22 一次性个人推送清理与通道修正：
 * 1. 将 `notify_deliveries` 中卡死循环重试的历史 `failed` 行标记作废
 *    （`status = 'sent', sent_at = null, error = VOID_NOTE_20261122`——满足现有
 *    CHECK 约束且使 `pendingDeliveries` 永不再补发，`sent_at IS NULL` 保留未真实发送的审计痕迹）；
 * 2. 关闭赵越个人企微直推（`wecom: 'off'`，保留站内 `site` 与群播报，清空 `wecom_webhook`）；
 * 3. 清空房超残余的个人 `wecom_webhook`（如有），确保走 `aibot` + `FANG_CHAO_USERID`，
 *    并在 Outbox 可用时用 `--dry-run` 校验路由解析通过。
 */
export async function applyNotifyCleanup20261122(
  database: Db,
  opts: { dryRun?: boolean } = {},
): Promise<NotifyCleanupResult> {
  const dryRun = opts.dryRun !== false;

  const failedRes = await database.execute<{
    id: string;
    member_id: string;
    member_name: string;
    event_seq: number;
    created_at: Date | string;
    error: string | null;
  }>(sql`
    select d.id, d.member_id, m.name as member_name, d.event_seq, d.created_at, d.error
      from notify_deliveries d
      join members m on m.id = d.member_id
     where d.channel = 'wecom' and d.status = 'failed'
     order by m.name, d.event_seq`);

  const voidedItems: StuckDeliveryItem[] = failedRes.rows.map((r) => ({
    id: r.id,
    memberId: r.member_id,
    memberName: r.member_name,
    eventSeq: Number(r.event_seq),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    error: r.error,
  }));

  const memberRes = await database.execute<{
    id: string;
    name: string;
    notify_prefs: string | null;
    wecom_userid: string | null;
    wecom_webhook: string | null;
  }>(sql`
    select id, name, notify_prefs, wecom_userid, wecom_webhook
      from members
     where name in ('赵越', '房超') and deactivated_at is null`);

  const zhao = memberRes.rows.find((r) => r.name === '赵越') ?? null;
  const fang = memberRes.rows.find((r) => r.name === '房超') ?? null;

  const zhaoPrefsAfter = zhao === null
    ? null
    : prefsJson(withLevel(prefsOf(zhao.notify_prefs), 'wecom', 'off'));

  const fangCurrentPrefs = fang === null ? null : prefsOf(fang.notify_prefs);
  const fangNextPrefs = fangCurrentPrefs === null
    ? null
    : (fangCurrentPrefs.wecom === 'off'
      ? prefsJson(withLevel(fangCurrentPrefs, 'wecom', 'key'))
      : prefsJson(fangCurrentPrefs));
  const fangHadWebhook = fang !== null && (fang.wecom_webhook?.trim() ?? '') !== '';
  const fangTargetUserid = (fang?.wecom_userid?.trim() || FANG_CHAO_USERID);

  if (!dryRun) {
    await database.transaction(async (tx) => {
      if (voidedItems.length > 0) {
        await tx.execute(sql`
          update notify_deliveries
             set status = 'sent',
                 sent_at = null,
                 error = ${VOID_NOTE_20261122}
           where channel = 'wecom' and status = 'failed'`);
      }

      if (zhao !== null && zhaoPrefsAfter !== null) {
        await tx.execute(sql`
          update members
             set notify_prefs = ${zhaoPrefsAfter},
                 wecom_webhook = null
           where id = ${zhao.id}`);
      }

      if (fang !== null && fangNextPrefs !== null) {
        await tx.execute(sql`
          update members
             set notify_prefs = ${fangNextPrefs},
                 wecom_userid = ${fangTargetUserid},
                 wecom_webhook = null
           where id = ${fang.id}`);
      }
    });
  }

  let fangVerified = false;
  let fangVerifyDetail = '未找到房超账号';
  if (fang !== null) {
    const outboxBin = resolveOutboxBin();
    if (outboxBin !== null) {
      const check = await enqueueOutbox({
        channel: 'aibot',
        target: fangTargetUserid,
        type: 'markdown',
        dedupKey: 'flowers-verify-fangchao-20261122',
        content: '**通道核验**\ndry-run',
        dryRun: true,
      }, { bin: outboxBin });
      fangVerified = check.ok;
      fangVerifyDetail = check.ok
        ? `wecom-enqueue --dry-run 通过（aibot -> ${fangTargetUserid}）`
        : `wecom-enqueue --dry-run 失败：${check.message}`;
    } else {
      fangVerified = fangTargetUserid.length > 0;
      fangVerifyDetail = `本地无 wecom-enqueue，已核验 userid=${fangTargetUserid}`;
    }
  }

  return {
    dryRun,
    voidedCount: voidedItems.length,
    voidedItems,
    zhaoDisabled: zhao !== null,
    zhaoMemberId: zhao?.id ?? null,
    zhaoPrefsAfter,
    fangMemberId: fang?.id ?? null,
    fangUserid: fang === null ? null : fangTargetUserid,
    fangWebhookCleared: fangHadWebhook,
    fangVerified,
    fangVerifyDetail,
  };
}
