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

export type AlertLevel = 'p0' | 'p1' | 'p2' | 'p3';

export type Alert = {
  /** 稳定标识：冷却窗口与去重都按它算，改文案不会重复发。 */
  key: string;
  level: AlertLevel;
  title: string;
  /** 「现在是多少」：一句数字 + 阈值。 */
  detail: string;
  /** 具体是哪几条（最多 3 条，带编号/负责人/天数）。群里的消息要能直接对人。 */
  samples: string[];
  /** 下一步做什么（一句话 + 一个链接）。群消息只说「多少条」等于没说。 */
  nextStep: string;
  link: string;
};

/** 消息里的级别标签：让读者一眼知道「现在要不要动」。 */
export const LEVEL_LABEL: Record<AlertLevel, string> = {
  p0: 'P0 · 现在坏了',
  p1: 'P1 · 这周要处理',
  p2: 'P2 · 发版前处理',
  p3: 'P3 · 找个时间清',
};

export type Snapshot = {
  /** 每条告警要举的例子（key 与 Alert.key 对应，最多 3 条）。 */
  samples: Record<string, string[]>;
  /** 个人推送：近 2 小时失败条数（P1）。 */
  personalFailedRecent: number;
  /** 待排期积压条数。 */
  queueBacklog: number;
  /** 卡在某个状态太久的条数（按状态给）。 */
  stuck: { review: number; queue: number; dev: number };
  /** 收集里超过 14 天没动的条数。 */
  inboxOverdue: number;
  /** 有延期需求（承诺完成日已过、还没上线）的版本数。 */
  lateReleases: number;
  /** 距发版 ≤3 天、但还有没提测的需求（ready）的条数。 */
  untestedNearRelease: number;
  /** 在册但既没绑 userid 也没设 webhook 的人。 */
  unboundMembers: number;
  /** 同名重复需求的对数。 */
  duplicateTitles: number;
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

/** 各状态的「停留多久算卡住」（天）。数字是工程默认，不是产品承诺。 */
export const STUCK_DAYS = { review: 5, queue: 5, dev: 10 } as const;
/** 收集里放多久算久放。 */
export const INBOX_OVERDUE_DAYS = 14;

export function evaluateAlerts(snapshot: Snapshot): Alert[] {
  const alerts: Alert[] = [];

  // ── P1：个人推送失败（2026-11-11 owner 指定） ────────────────────────────
  if (snapshot.personalFailedRecent >= 3) {
    alerts.push({
      key: 'personal_failed',
      level: 'p1',
      title: '个人推送失败',
      detail: `近 2 小时有 ${snapshot.personalFailedRecent} 条私聊没发出去；`
        + '多半是机器人只能给本人发（853008）。',
      samples: snapshot.samples.personal_failed ?? [],
      nextStep: '让这几个人到「设置 · 我的 → 绑定企微」里填自己的群机器人 webhook（不是共用的那台）。',
      link: '/settings',
    });
  }

  if (snapshot.queueBacklog > 15) {
    alerts.push({
      key: 'queue_backlog',
      level: 'p1',
      title: '待排期积压',
      detail: `待排期里有 ${snapshot.queueBacklog} 条，超过 15 条的线。`,
      samples: snapshot.samples.queue_backlog ?? [],
      nextStep: '逐条给版本与承诺日（或搁置）：版本页「加需求 / 改进度」就能做。',
      link: '/releases',
    });
  }

  const stuckParts: string[] = [];
  if (snapshot.stuck.review > 0) stuckParts.push(`待评审 ${snapshot.stuck.review} 条超 ${STUCK_DAYS.review} 天`);
  if (snapshot.stuck.queue > 0) stuckParts.push(`待排期 ${snapshot.stuck.queue} 条超 ${STUCK_DAYS.queue} 天`);
  if (snapshot.stuck.dev > 0) stuckParts.push(`开发中 ${snapshot.stuck.dev} 条超 ${STUCK_DAYS.dev} 天`);
  if (stuckParts.length > 0) {
    alerts.push({
      key: 'stuck',
      level: 'p1',
      title: '需求卡住',
      detail: stuckParts.join('；') + '。',
      samples: snapshot.samples.stuck ?? [],
      nextStep: '找最上面那几条的负责人当天确认：要么推进，要么写原因搁置。',
      link: '/',
    });
  }

  if (snapshot.inboxOverdue > 0) {
    alerts.push({
      key: 'inbox_overdue',
      level: 'p1',
      title: '收集久放',
      detail: `收集里有 ${snapshot.inboxOverdue} 条超过 ${INBOX_OVERDUE_DAYS} 天没立项。`,
      samples: snapshot.samples.inbox_overdue ?? [],
      nextStep: '按名单逐条决定：补六问后立项，或者当场拒绝 / 搁置。',
      link: '/?state=inbox',
    });
  }

  // ── P2：版本与交付 ─────────────────────────────────────────────────────
  if (snapshot.lateReleases > 0) {
    alerts.push({
      key: 'release_late',
      level: 'p2',
      title: '版本有延期需求',
      detail: `${snapshot.lateReleases} 个版本里存在「承诺完成日已过、还没上线」的需求。`,
      samples: snapshot.samples.release_late ?? [],
      nextStep: '到版本页把承诺日往后改（写清为什么），或者把需求退回待开发。',
      link: '/releases',
    });
  }

  if (snapshot.untestedNearRelease > 0) {
    alerts.push({
      key: 'release_untested',
      level: 'p2',
      title: '发版前仍有未提测',
      detail: `距发版 ≤3 天，还有 ${snapshot.untestedNearRelease} 条停在待开发。`,
      samples: snapshot.samples.release_untested ?? [],
      nextStep: '今天确认这几条能不能赶上；赶不上就挪到下一版（版本页改进度）。',
      link: '/releases',
    });
  }

  // ── P3：数据质量 ───────────────────────────────────────────────────────
  if (snapshot.unboundMembers > 0) {
    alerts.push({
      key: 'member_unbound',
      level: 'p3',
      title: '成员收不到私聊',
      detail: `${snapshot.unboundMembers} 个在册成员既没绑 userid、也没设自己的机器人。`,
      samples: snapshot.samples.member_unbound ?? [],
      nextStep: '把名单发给他们，各自到「设置 · 我的 → 用自己的机器人」填一条群机器人 webhook。',
      link: '/settings',
    });
  }

  if (snapshot.duplicateTitles > 0) {
    alerts.push({
      key: 'duplicate_titles',
      level: 'p3',
      title: '同名需求重复',
      detail: `${snapshot.duplicateTitles} 组同名需求（迁移时同一个规划拆成多张卡）。`,
      samples: snapshot.samples.duplicate_titles ?? [],
      nextStep: '每组留一条、其余搁置（写「重复于 PAN-x」），别删——历史要对得上。',
      link: '/',
    });
  }

  if (snapshot.groupFailedRecent > 0) {
    alerts.push({
      key: 'group_failed',
      level: 'p0',
      title: '群播报失败',
      detail: `最近 30 分钟有 ${snapshot.groupFailedRecent} 条没能发到群里（工作台里的状态是对的，只是没播出去）。`,
      samples: snapshot.samples.group_failed ?? [],
      nextStep: '看 group_posts 里 failed 那几行的 error，多半是 webhook 变了或限流；修好它会自动补发。',
      link: '/settings',
    });
  }

  if (snapshot.sheetFailed >= 3) {
    alerts.push({
      key: 'sheet_failed',
      level: 'p0',
      title: '汇总表同步失败',
      detail: `有 ${snapshot.sheetFailed} 行写不进企微汇总表，待排期的需求会缺行。`,
      samples: snapshot.samples.sheet_failed ?? [],
      nextStep: '到「待排期」确认这几条还在，然后跑一次 sheet-sync（或等下一轮）。',
      link: '/?state=queue',
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
        samples: [],
        nextStep: '在服务器上看 /var/log/flowers-*.log 的报错，必要时手动跑一次那个脚本。',
        link: '/settings',
      });
    }
  }

  if (!snapshot.wecomAuthorized) {
    alerts.push({
      key: 'wecom_auth',
      level: 'p0',
      title: '企微授权失效',
      detail: 'wecom-cli 不在 authorized 状态，个人推送与私聊全部发不出去。',
      samples: [],
      nextStep: '在服务器上重新授权 wecom-cli（/root/.config/wecom），之后推送会自动恢复。',
      link: '/settings',
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
      samples: [],
      nextStep: '先看 flowers 是否在跑（systemctl status flowers），再看 edge-nginx 的 45-b123.conf 上游。',
      link: '/settings',
    });
  }

  return alerts;
}
