/**
 * 告警规则（2026-11-11，H1 的 P0 五条）。
 *
 * 全是**纯函数**：喂一份快照，返回该发哪些告警。发不发、发到哪、多久冷却，在 `run.ts`；
 * 这里只回答「这条坏没坏」。这样规则可以被用例逐条钉住，不需要真的坏一台机器。
 *
 * 五条都是「系统坏了却没人知道」那一类，与业务判断无关：
 * 1. 群播报失败堆积（`group_posts` 里连续失败）
 * 2. 汇总表写失败堆积（`sheet_sync`）
 * 3. 定时任务停摆（日志文件超过 2 倍周期没更新）
 * 4. 企微授权失效（发不出消息）
 * 5. 外部门（b123）不可用（5xx / 连不上）
 */

export type AlertLevel = 'p0' | 'p1';

export type Alert = {
  /** 稳定标识：冷却窗口与去重都按它算，改文案不会重复发。 */
  key: string;
  level: AlertLevel;
  title: string;
  /** 一句话说清「哪坏了 + 现在是多少」。 */
  detail: string;
};

export type Snapshot = {
  /** 群播报：最近 N 轮里失败条数（只数最近 30 分钟）。 */
  groupFailedRecent: number;
  /** 汇总表：未处理的失败行数。 */
  sheetFailed: number;
  /** 定时任务：每个任务「上次更新到现在多少分钟」，key 是任务名。 */
  cronAgeMinutes: Record<string, number>;
  /** 企微授权：`wecom-cli auth show` 是不是 authorized。 */
  wecomAuthorized: boolean;
  /** 外部门探测：HTTP 状态码；null = 连不上。 */
  gateStatus: number | null;
};

/** 每个定时任务允许的最大静默（分钟）。2 倍周期 + 余量。 */
export const CRON_LIMITS: Record<string, number> = {
  'wecom-dispatch': 15, // 每 5 分钟
  'group-dispatch': 15, // 每 5 分钟
  'sheet-sync': 30, // 每 10 分钟
};

export function evaluateAlerts(snapshot: Snapshot): Alert[] {
  const alerts: Alert[] = [];

  if (snapshot.groupFailedRecent > 0) {
    alerts.push({
      key: 'group_failed',
      level: 'p0',
      title: '群播报失败',
      detail: `最近 30 分钟有 ${snapshot.groupFailedRecent} 条没能发到群里（工作台里的状态是对的，只是没播出去）。`,
    });
  }

  if (snapshot.sheetFailed >= 3) {
    alerts.push({
      key: 'sheet_failed',
      level: 'p0',
      title: '汇总表同步失败',
      detail: `有 ${snapshot.sheetFailed} 行写不进企微汇总表，待排期的需求会缺行。`,
    });
  }

  for (const [task, age] of Object.entries(snapshot.cronAgeMinutes)) {
    const limit = CRON_LIMITS[task];
    if (limit === undefined) continue;
    if (age > limit) {
      alerts.push({
        key: `cron_stale:${task}`,
        level: 'p0',
        title: '定时任务停摆',
        detail: `${task} 已经 ${Math.round(age)} 分钟没动弹（预期 ${limit} 分钟内一轮）。`,
      });
    }
  }

  if (!snapshot.wecomAuthorized) {
    alerts.push({
      key: 'wecom_auth',
      level: 'p0',
      title: '企微授权失效',
      detail: 'wecom-cli 不在 authorized 状态，个人推送与私聊全部发不出去。',
    });
  }

  if (snapshot.gateStatus === null || snapshot.gateStatus >= 500) {
    alerts.push({
      key: 'gate_down',
      level: 'p0',
      title: '看板门不可用',
      detail: snapshot.gateStatus === null
        ? 'b123 的门连不上（请求超时或连接被拒）。'
        : `b123 的门返回 ${snapshot.gateStatus}，所有人都进不去。`,
    });
  }

  return alerts;
}
