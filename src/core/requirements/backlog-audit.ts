import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';

const STATE_LABEL: Record<string, string> = {
  inbox: '收集',
  design: '待设计',
  review: '待评审',
  queue: '待排期',
  ready: '待开发',
  dev: '开发中',
  test: '测试中',
  live: '已上线',
  rejected: '已拒绝',
  shelved: '已搁置',
};

const STATE_ORDER: Record<string, number> = {
  test: 0,
  dev: 1,
  ready: 2,
};

export type MissingReleaseCard = {
  number: number;
  title: string;
  state: string;
  stateLabel: string;
  owner: string;
  daysInState: number;
  enteredSource: 'event' | 'migrated_or_entered';
  stateEnteredDay: string;
  createdDay: string;
};

export type DuplicateCardItem = {
  number: number;
  title: string;
  state: string;
  stateLabel: string;
  owner: string;
  releaseName: string | null;
  createdDay: string;
};

export type DuplicateTitleGroup = {
  key: string;
  representativeTitle: string;
  items: DuplicateCardItem[];
};

export type BacklogAuditReport = {
  generatedAtIso: string;
  generatedDayShanghai: string;
  missingReleaseCards: MissingReleaseCard[];
  duplicateGroups: DuplicateTitleGroup[];
};

/** 与 `src/core/alerts/run.ts` 完全同口径的标题归一键（保留中文、小写字母与数字）。 */
export function titleAuditKey(title: string): string {
  return title.toLowerCase().replace(/[^一-龥a-z0-9]/g, '');
}

function shanghaiDayString(value: Date | string, fallback = ''): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  const sh = new Date(d.getTime() + 8 * 3600_000);
  const y = sh.getUTCFullYear();
  const m = String(sh.getUTCMonth() + 1).padStart(2, '0');
  const day = String(sh.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * **纯只读**导出存量异常需求卡对账单（绝不执行任何写语句）：
 * 1. 处于 `ready / dev / test` 却缺少 `release_id`（被时钟推进跳过）的全部卡片；
 * 2. 未删除需求中按标题归一键聚合后的全部同名重复组。
 */
export async function collectBacklogAudit(
  database: Db,
  now: Date = new Date(),
): Promise<BacklogAuditReport> {
  const nowMs = now.getTime();

  const missingRes = await database.execute<{
    number: number;
    title: string;
    state: string;
    owner_name: string | null;
    state_entered_at: Date | string;
    last_transition_at: Date | string | null;
    created_at: Date | string;
  }>(sql`
    select r.number,
           r.title,
           r.state,
           m.name as owner_name,
           r.state_entered_at,
           (select max(e.at)
              from events e
             where e.requirement_id = r.id
               and e.payload::jsonb ->> 'to' = r.state) as last_transition_at,
           r.created_at
      from requirements r
      left join members m on m.id = r.owner_member_id
     where r.deleted_at is null
       and r.state in ('ready', 'dev', 'test')
       and r.release_id is null
     order by r.number asc`);

  const missingReleaseCards: MissingReleaseCard[] = missingRes.rows
    .map((row) => {
      const anchorRaw = row.last_transition_at ?? row.state_entered_at;
      const anchorMs = new Date(anchorRaw).getTime();
      const days = Number.isFinite(anchorMs)
        ? Math.max(0, Math.floor((nowMs - anchorMs) / (24 * 3600_000)))
        : 0;
      return {
        number: Number(row.number),
        title: row.title,
        state: row.state,
        stateLabel: STATE_LABEL[row.state] ?? row.state,
        owner: row.owner_name?.trim() || '未指派',
        daysInState: days,
        enteredSource: row.last_transition_at === null ? 'migrated_or_entered' : 'event',
        stateEnteredDay: shanghaiDayString(anchorRaw),
        createdDay: shanghaiDayString(row.created_at),
      } satisfies MissingReleaseCard;
    })
    .sort((a, b) => (
      (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9)
      || b.daysInState - a.daysInState
      || a.number - b.number
    ));

  const allAliveRes = await database.execute<{
    number: number;
    title: string;
    state: string;
    owner_name: string | null;
    release_name: string | null;
    created_at: Date | string;
  }>(sql`
    select r.number,
           r.title,
           r.state,
           m.name as owner_name,
           rel.name as release_name,
           r.created_at
      from requirements r
      left join members m on m.id = r.owner_member_id
      left join releases rel on rel.id = r.release_id and rel.deleted_at is null
     where r.deleted_at is null
     order by r.number asc`);

  const byKey = new Map<string, DuplicateCardItem[]>();
  for (const row of allAliveRes.rows) {
    const key = titleAuditKey(row.title);
    if (key === '') continue;
    const item: DuplicateCardItem = {
      number: Number(row.number),
      title: row.title,
      state: row.state,
      stateLabel: STATE_LABEL[row.state] ?? row.state,
      owner: row.owner_name?.trim() || '未指派',
      releaseName: row.release_name,
      createdDay: shanghaiDayString(row.created_at),
    };
    const bucket = byKey.get(key);
    if (bucket === undefined) byKey.set(key, [item]);
    else bucket.push(item);
  }

  const duplicateGroups: DuplicateTitleGroup[] = [...byKey.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([key, items]) => ({
      key,
      representativeTitle: items[0]!.title,
      items,
    }))
    .sort((a, b) => b.items.length - a.items.length || a.items[0]!.number - b.items[0]!.number);

  return {
    generatedAtIso: now.toISOString(),
    generatedDayShanghai: shanghaiDayString(now),
    missingReleaseCards,
    duplicateGroups,
  };
}

function escCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

export function renderBacklogAuditMarkdown(audit: BacklogAuditReport): string {
  const byStateCounts: Record<string, number> = {};
  for (const c of audit.missingReleaseCards) {
    byStateCounts[c.state] = (byStateCounts[c.state] ?? 0) + 1;
  }
  const duplicateCardTotal = audit.duplicateGroups.reduce((acc, g) => acc + g.items.length, 0);

  const lines: string[] = [
    `# Flower 存量异常需求卡只读对账单（${audit.generatedDayShanghai}）`,
    '',
    `> 生成时间：\`${audit.generatedAtIso}\`（北京时间 \`${audit.generatedDayShanghai}\`）`,
    '> 性质：**纯只读导出**（未对 `requirements` 执行任何退回、搁置或修改操作，供人工逐条拍板）。',
    '',
    '## 概览',
    '',
    '| 异常类别 | 数量 | 说明 |',
    '|---|---:|---|',
    `| 处于 \`ready / dev / test\` 但缺少排期版本的卡片 | **${audit.missingReleaseCards.length} 条** | 时钟推进（\`wecom-dispatch.ts --tick\`）每轮跳过：\`test\` ${byStateCounts.test ?? 0} 条 / \`dev\` ${byStateCounts.dev ?? 0} 条 / \`ready\` ${byStateCounts.ready ?? 0} 条 |`,
    `| 同名重复需求组（未删除全库口径） | **${audit.duplicateGroups.length} 组**（涉及 ${duplicateCardTotal} 条卡片） | 与 \`alerts.ts\` 同口径（去标点空白转小写后完全一致，含已搁置/已上线对照明细） |`,
    '',
    `## 一、缺少排期版本的时钟跳过卡（共 ${audit.missingReleaseCards.length} 条）`,
    '',
    '这批卡片处于研发执行态（`待开发` / `开发中` / `测试中`），但 `release_id IS NULL`，时钟无法自动推进。请条线负责人确认归属迭代版本（补排期）或退回 `待排期` / `搁置`：',
    '',
    '| # | 编号 | 标题 | 当前状态 | 负责人 | 状态停留天数 | 进入当前状态日期 | 创建日期 |',
    '|---:|---|---|---|---|---:|---|---|',
  ];

  audit.missingReleaseCards.forEach((card, idx) => {
    const suffix = card.enteredSource === 'migrated_or_entered' ? `${card.daysInState} 天（自切库/入态）` : `${card.daysInState} 天`;
    lines.push(
      `| ${idx + 1} | PAN-${card.number} | ${escCell(card.title)} | ${card.stateLabel}（\`${card.state}\`） | ${escCell(card.owner)} | ${suffix} | ${card.stateEnteredDay} | ${card.createdDay} |`,
    );
  });

  lines.push(
    '',
    `## 二、同名重复需求卡清单（共 ${audit.duplicateGroups.length} 组）`,
    '',
    '以下按组内卡片数降序列出全部同名重复组，便于人工核对保留主卡并归并/搁置重复卡：',
    '',
  );

  audit.duplicateGroups.forEach((group, idx) => {
    const activeCount = group.items.filter((i) => i.state !== 'shelved' && i.state !== 'rejected').length;
    lines.push(
      `### ${idx + 1}. ${group.representativeTitle}（共 ${group.items.length} 条，其中非终态搁置/拒绝 ${activeCount} 条）`,
      '',
      '| 编号 | 完整标题 | 状态 | 负责人 | 排期版本 | 创建日期 |',
      '|---|---|---|---|---|---|',
    );
    for (const item of group.items) {
      lines.push(
        `| PAN-${item.number} | ${escCell(item.title)} | ${item.stateLabel}（\`${item.state}\`） | ${escCell(item.owner)} | ${escCell(item.releaseName ?? '—')} | ${item.createdDay} |`,
      );
    }
    lines.push('');
  });

  return `${lines.join('\n').trimEnd()}\n`;
}
