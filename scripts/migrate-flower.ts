/**
 * Flower（生产实例）→ Flowers（本项目）的需求搬运器。
 *
 * 只搬一件事：**旧库里那 11 个状态落到我们这 10 个状态的哪一格**，顺带把
 * platform / priority / line 三个自定义字段翻成我们的词表。
 *
 *   npx tsx scripts/migrate-flower.ts            # 默认 --dry-run：只打印映射，不写库
 *   npx tsx scripts/migrate-flower.ts --baseline <path.json>
 *                                               # dry-run + 把完整分布与逐条 number→state
 *                                               # 写成基线文件（同一个 path 旁边另写一份 .md）
 *   npx tsx scripts/migrate-flower.ts --apply    # 真写（幂等：按 `requirements.legacy_ref`
 *                                               # 跳过已搬过的行，唯一索引兜底）
 *   npx tsx scripts/migrate-flower.ts --verify <path.json>
 *                                               # 只读：拿库里的行与基线逐条对账
 *
 * ## 可撤销性（P1 的硬要求）
 *
 * 搬进来的每一行都带 `legacy_ref` = Flower 那一条的 uuid（迁移 0018 加的列 + 非空唯一
 * 索引）。于是回滚是一条 SQL：
 *
 *   begin;
 *   delete from requirements where legacy_ref is not null;   -- 只删搬来的，不碰演示数据
 *   rollback;                                                -- 演练；真要撤就 commit
 *
 * 不要用 `created_at` / `number` / `actor='migrate-flower'` 猜哪些是搬来的：前两条会连坐
 * 真实数据，第三条是副作用（事件可以被单独删掉），而 `legacy_ref` 是被搬的那一行自己的
 * 属性。
 *
 * ## 状态映射（owner 的裁决）
 *
 * | Flower（803 条，deleted_at is null） | 我们的状态 | 理由 |
 * |---|---|---|
 * | collect      158 | inbox     | 同义 |
 * | to_evaluate  102 | **inbox** | owner 原话：「没有待评估，待评估都是收集」——待评估 = 还没人接 |
 * | evaluated     41 | **design**| owner 原话：「没有已评估，所有已评估都改为待设计」 |
 * | to_design     48 | design    | 同义 |
 * | designing     18 | design    | 设计中也归待设计：我们只有一个「设计」格，没有「设计中」 |
 * | to_develop    18 | ready     | 待开发 |
 * | developing    15 | dev       | 开发中 |
 * | testing        2 | test      | 测试中 |
 * | launched     264 | live      | 已上线 |
 * | rejected      73 | rejected  | 已拒绝 |
 * | shelved       64 | shelved   | 已搁置 |
 *
 * 11 个旧状态全部有落点，**一条都不丢**（脚本会打印核对）。
 *
 * 为什么不加两个状态：owner 看过 P4-09 的第一版方案（加 `to_evaluate` / `evaluated`
 * 两列，看板 12 列）之后明确否掉了——「没有已评估 所有已评估都改为待设计 没有待评估
 * 待评估都是收集」。折进现有两格会让这 143 条需求的**当前动作**变一点点（待评估的
 * 其实是「等评估」，而收集列的动作是「立项」），这是这次迁移唯一一处语义损失，
 * 写在报告里。
 *
 * ## 字段映射
 *
 * - `platform`（多选，856 个值）：按**标签**翻成我们的键（Flower 里除 web/mobile/pc/
 *   mini 之外的平台键是 `x_` 开头的随机串，键不可用）。同一行翻完去重
 *   （`移动端` + `支付宝` → 一个 `mobile`），按我们词表的顺序落库。
 * - `priority`（单选，800 条有值）：键与我们完全一致（`p0..p3` / `green`），直接搬。
 * - `line`（单选，340 条有值）：`功能 → feature`、`商业 → commercial`——它就是我们的
 *   `type` 的生产口径（Flower 自己的 `type` 字段 0 条使用）。没有 line 的行没有类型
 *   依据，**默认 feature** 并把条数打印出来（我们的 type 是 NOT NULL，没有「未定」）。
 * - `description`：Flower 只有一段自由文本；我们把它放进 `context`（「谁在什么情况下
 *   用」）。这是**近似**，不是等价：原文常常同时包含问题、目标与阶段备注。六问的其余
 *   五格留空——原文没有那一格，就不编。
 * - 负责人 / 提出人：按 display_name 对到我们的花名册；对不上的负责人留空（待接单），
 *   对不上的提出人写成 `未知`（我们的 requester 是 NOT NULL 的自由文本，外部提出人
 *   本来就可能不在册）。
 * - `source`（原创 / 线上问题）：我们**没有**这一列。不搬，但把原值记进迁移事件的
 *   payload（`source`），要统计时还查得到。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { recordEvent } from '../src/core/events.js';
import { STATE_LABEL, type State } from '../src/core/state-machine.js';
import {
  normalizePlatforms, platformLabel, PLATFORM_UNSET, type PlatformKey,
} from '../src/core/requirements/platforms.js';
import { normalizePriority, priorityLabel } from '../src/core/requirements/priority.js';

// ─── 映射表（口径本身） ─────────────────────────────────────────────────────

export const STATE_MAP: Readonly<Record<string, State>> = {
  collect: 'inbox',
  // owner 裁决：待评估都是收集。
  to_evaluate: 'inbox',
  to_design: 'design',
  designing: 'design',
  // owner 裁决：已评估都改为待设计。
  evaluated: 'design',
  to_develop: 'ready',
  developing: 'dev',
  testing: 'test',
  launched: 'live',
  rejected: 'rejected',
  shelved: 'shelved',
};

/**
 * Flower 平台**标签** → 我们的键。
 *
 * 键不能用来映射：Flower 的 `field_options.key` 里除 `web/mobile/pc/mini` 之外全是
 * `x_571dbc` 这种随机串（见 field_options 表）。标签是稳定的，也是界面上被勾的那个。
 *
 * 长尾写法逐条给理由：`H5-分享页` / `h5端` 都是 H5 的一种页面；`pc端` = PC客户端；
 * `管理端` / `企业管理后台` = 管理后台；`manager` 与 `Manager后台` 同一个端；
 * `支付宝` 是一个投放渠道，端是移动端。`站内信` 是通知渠道不是端，不映射。
 */
export const PLATFORM_MAP: Readonly<Record<string, PlatformKey>> = {
  'Web端': 'web',
  '移动端': 'mobile',
  'PC客户端': 'pc',
  '小程序': 'mini',
  '后端': 'backend',
  '管理后台': 'admin',
  'Manager后台': 'manager',
  '前端': 'frontend',
  'H5': 'h5',
  '开放平台': 'open',
  '鸿蒙': 'harmony',
  'TV端': 'tv',
  'H5-分享页': 'h5',
  'h5端': 'h5',
  'pc端': 'pc',
  '管理端': 'admin',
  '企业管理后台': 'admin',
  manager: 'manager',
  '支付宝': 'mobile',
};

/** `line` → 我们的 `type`。没有 line 时按 feature 落（NOT NULL 列，没有「未定」）。 */
const TYPE_MAP: Readonly<Record<string, 'feature' | 'commercial'>> = {
  feature: 'feature',
  business: 'commercial',
  '功能': 'feature',
  '商业': 'commercial',
};

type FlowerRow = {
  id: string;
  number: number;
  title: string;
  description: string;
  state_key: string;
  state_changed_at: string;
  created_at: string;
  owner_name: string | null;
  requester_name: string | null;
  /** 平台标签（`json_agg(fo.label)`）。 */
  platform_labels: string[] | null;
  priority_key: string | null;
  line_key: string | null;
  source_key: string | null;
};

const SSH_HOST = process.env.FLOWER_SSH_HOST ?? 'dogyun';
const CONTAINER = process.env.FLOWER_PG_CONTAINER ?? 'flower-postgres-1';
const DB_NAME = process.env.FLOWER_DB_NAME ?? 'flower';
const DB_USER = process.env.FLOWER_DB_USER ?? 'flower_admin';

/**
 * 取数用 `copy ... to stdout` 而不是 `select json_agg(...)`：psql 会把长行按终端宽度
 * **折行**（`-P columns=0` 也挡不住带空格的 JSON），于是一条 JSON 会被切成一堆碎片；
 * COPY 的输出不过格式化器，永远是一行。
 */
const SOURCE_SQL = `
set app.scope = 'system';
copy (select encode(convert_to(coalesce(json_agg(x)::text, '[]'), 'utf8'), 'base64') from (
  select r.id,
         r.number,
         r.title,
         r.description,
         r.state_key,
         r.state_changed_at,
         r.created_at,
         om.display_name as owner_name,
         rm.display_name as requester_name,
         (select json_agg(fo.label order by fo.sort, fo.label)
            from field_values fv
            join field_definitions fd on fd.id = fv.field_id
            join field_options fo on fo.id = fv.option_id
           where fv.entity_id = r.id and fd.key = 'platform') as platform_labels,
         (select fo.key
            from field_values fv
            join field_definitions fd on fd.id = fv.field_id
            join field_options fo on fo.id = fv.option_id
           where fv.entity_id = r.id and fd.key = 'priority'
           limit 1) as priority_key,
         (select fo.key
            from field_values fv
            join field_definitions fd on fd.id = fv.field_id
            join field_options fo on fo.id = fv.option_id
           where fv.entity_id = r.id and fd.key = 'line'
           limit 1) as line_key,
         (select fo.key
            from field_values fv
            join field_definitions fd on fd.id = fv.field_id
            join field_options fo on fo.id = fv.option_id
           where fv.entity_id = r.id and fd.key = 'source'
           limit 1) as source_key
    from requirements r
    left join members om on om.id = r.owner_member_id
    left join members rm on rm.id = r.requester_member_id
   where r.deleted_at is null
) x) to stdout;
`;

function loadFlowerRows(): FlowerRow[] {
  const res = spawnSync(
    'ssh',
    [
      SSH_HOST,
      `docker exec -i ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -t -A -q -f -`,
    ],
    { input: SOURCE_SQL, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`读取 Flower 失败（exit ${res.status}）：${res.stderr.trim()}`);
  }
  // COPY 的 text 格式会把 JSON 里的反斜杠再转义一次（`\n` → `\\n`），直接 JSON.parse
  // 一定会炸。所以让 PG 先 base64：输出是一行没有引号/反斜杠的 ASCII，解出来就是原文。
  const line = res.stdout.split('\n').map((item) => item.trim()).filter(Boolean).pop();
  if (line === undefined) throw new Error(`Flower 没有返回数据：${res.stdout.slice(0, 200)}`);
  // PG 的 `encode(..., 'base64')` 按 RFC 2045 每 76 字符插一个换行；COPY 的 text 格式
  // 把它转义成两个字符 `\n`。base64 字母表里没有反斜杠，所以直接删掉它们是安全的。
  const json = Buffer.from(line.replace(/\\n/g, ''), 'base64').toString('utf8');
  return JSON.parse(json) as FlowerRow[];
}

// ─── 报表 ────────────────────────────────────────────────────────────────────

type Bucket = { old: string; count: number; state: State | null };

function buckets(rows: FlowerRow[]): Bucket[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.state_key, (counts.get(row.state_key) ?? 0) + 1);
  return [...counts.entries()]
    .map(([old, count]) => ({ old, count, state: STATE_MAP[old] ?? null }))
    .sort((a, b) => b.count - a.count);
}

function pad(text: string, width: number): string {
  // 等宽不够用：中文两列宽。只用于这张报表，按字符数补 + CJK 宽字符修正。
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    w += (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xff00 && cp <= 0xff60) ? 2 : 1;
  }
  return text + ' '.repeat(Math.max(0, width - w));
}

/**
 * 一条 Flower 行要落成什么 —— **dry-run 报表、基线文件、`--apply`、`--verify` 四处
 * 必须用同一个函数算**，否则「基线说的」和「写进去的」是两段各自正确的代码。
 */
type RowPlan = {
  /** 我们的状态；null = 旧状态认不出（这条不写）。 */
  state: State | null;
  type: 'feature' | 'commercial';
  platforms: PlatformKey[];
  priority: string | null;
  /** 翻不成键、被丢掉的平台标签原文。 */
  droppedLabels: string[];
};

function planRow(row: FlowerRow): RowPlan {
  const labels = row.platform_labels ?? [];
  const keys: PlatformKey[] = [];
  const droppedLabels: string[] = [];
  for (const label of labels) {
    const key = PLATFORM_MAP[label];
    if (key === undefined) {
      droppedLabels.push(label);
    } else {
      keys.push(key);
    }
  }
  return {
    state: STATE_MAP[row.state_key] ?? null,
    type: row.line_key === null || row.line_key === undefined
      ? 'feature'
      : TYPE_MAP[row.line_key] ?? 'feature',
    // `normalizePlatforms` 去重并按住词表顺序输出：同一行勾了「移动端 + 支付宝」只留一个。
    platforms: normalizePlatforms(keys),
    priority: normalizePriority(row.priority_key),
    droppedLabels,
  };
}

type Analysis = {
  total: number;
  stateBuckets: Bucket[];
  /** 落点 → 条数（我们的状态）。 */
  stateTotals: Record<string, number>;
  priorityCounts: Record<string, number>;
  priorityUnset: number;
  /** 平台键 → 被打上这个键的**行数**。 */
  platformCounts: Record<string, number>;
  platformUnsetRows: number;
  /** 认不出、被丢掉的平台标签 → 出现在几行里。 */
  unmappedPlatforms: Record<string, number>;
  /** 有平台标签但翻完一个键都没剩下的行（复合值那种）。 */
  rowsLosingAllPlatforms: { number: number; title: string; labels: string[] }[];
  typeCounts: Record<string, number>;
  noLineRows: number;
  descriptionEmptyRows: number;
  descriptionPresentRows: number;
  sourceCounts: Record<string, number>;
  unmappedStates: string[];
  ownerUnmatched: Record<string, number>;
};

function sortedRecord(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function analyze(rows: FlowerRow[]): Analysis {
  const list = buckets(rows);
  const stateTotals = new Map<string, number>();
  const priorityCounts = new Map<string, number>();
  const platformCounts = new Map<string, number>();
  const unmappedPlatforms = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  const ownerUnmatched = new Map<string, number>();
  const rowsLosingAllPlatforms: Analysis['rowsLosingAllPlatforms'] = [];
  let priorityUnset = 0;
  let platformUnsetRows = 0;
  let noLineRows = 0;
  let descriptionEmptyRows = 0;
  let descriptionPresentRows = 0;

  for (const row of rows) {
    const plan = planRow(row);
    if (plan.state !== null) {
      stateTotals.set(plan.state, (stateTotals.get(plan.state) ?? 0) + 1);
    }
    if (plan.priority === null) priorityUnset += 1;
    else priorityCounts.set(plan.priority, (priorityCounts.get(plan.priority) ?? 0) + 1);
    if (plan.platforms.length === 0 && (row.platform_labels ?? []).length === 0) platformUnsetRows += 1;
    for (const key of plan.platforms) platformCounts.set(key, (platformCounts.get(key) ?? 0) + 1);
    for (const label of plan.droppedLabels) {
      unmappedPlatforms.set(label, (unmappedPlatforms.get(label) ?? 0) + 1);
    }
    if ((row.platform_labels ?? []).length > 0 && plan.platforms.length === 0) {
      rowsLosingAllPlatforms.push({
        number: Number(row.number),
        title: row.title,
        labels: row.platform_labels ?? [],
      });
    }
    typeCounts.set(plan.type, (typeCounts.get(plan.type) ?? 0) + 1);
    if (row.line_key === null || row.line_key === undefined) noLineRows += 1;
    if (row.description === '' || row.description === null) descriptionEmptyRows += 1;
    else descriptionPresentRows += 1;
    const source = row.source_key ?? '(未填)';
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
    if (row.owner_name === null) ownerUnmatched.set('(无负责人)', (ownerUnmatched.get('(无负责人)') ?? 0) + 1);
  }

  return {
    total: rows.length,
    stateBuckets: list,
    stateTotals: sortedRecord(stateTotals),
    priorityCounts: sortedRecord(priorityCounts),
    priorityUnset,
    platformCounts: sortedRecord(platformCounts),
    platformUnsetRows,
    unmappedPlatforms: sortedRecord(unmappedPlatforms),
    rowsLosingAllPlatforms,
    typeCounts: sortedRecord(typeCounts),
    noLineRows,
    descriptionEmptyRows,
    descriptionPresentRows,
    sourceCounts: sortedRecord(sourceCounts),
    unmappedStates: list.filter((item) => item.state === null).map((item) => item.old),
    ownerUnmatched: sortedRecord(ownerUnmatched),
  };
}

function printReport(a: Analysis): void {
  process.stdout.write('\n== 状态映射（Flower 11 → 我们 10） ==\n');
  process.stdout.write(
    `${pad('旧状态', 16)}${pad('条数', 8)}${pad('我们的状态', 16)}中文\n`,
  );
  for (const item of a.stateBuckets) {
    process.stdout.write(
      `${pad(item.old, 16)}${pad(String(item.count), 8)}`
      + `${pad(item.state ?? '（未映射）', 16)}${item.state === null ? '—' : STATE_LABEL[item.state]}\n`,
    );
  }
  process.stdout.write(`${pad('合计', 16)}${String(a.total)}\n`);

  process.stdout.write('\n== 我们的状态（合计） ==\n');
  for (const [state, count] of Object.entries(a.stateTotals)) {
    process.stdout.write(`${pad(state, 12)}${pad(String(count), 8)}${STATE_LABEL[state as State] ?? '—'}\n`);
  }

  process.stdout.write('\n== 平台（标签 → 我们的键；同一行去重） ==\n');
  for (const [key, count] of Object.entries(a.platformCounts)) {
    process.stdout.write(`${pad(key, 12)}${pad(String(count), 8)}${platformLabel(key)}\n`);
  }
  process.stdout.write(`${pad('未标注', 12)}${String(a.platformUnsetRows)}\n`);
  if (Object.keys(a.unmappedPlatforms).length > 0) {
    process.stdout.write('未映射的平台标签（会被丢弃，逐条列出）：\n');
    for (const [label, count] of Object.entries(a.unmappedPlatforms)) {
      process.stdout.write(`  ${pad(label, 40)}${count}\n`);
    }
  }

  process.stdout.write('\n== 优先级 ==\n');
  for (const [key, count] of Object.entries(a.priorityCounts)) {
    process.stdout.write(`${pad(key, 12)}${pad(String(count), 8)}${priorityLabel(key)}\n`);
  }
  process.stdout.write(`${pad('未定', 12)}${String(a.priorityUnset)}\n`);

  process.stdout.write('\n== 类型（line → type） ==\n');
  for (const [type, count] of Object.entries(a.typeCounts)) {
    process.stdout.write(`${pad(type, 40)}${String(count)}\n`);
  }
  process.stdout.write(`${pad('（无 line，默认 feature）', 40)}${String(a.noLineRows)}\n`);

  process.stdout.write('\n== 其他（迁移缺陷的口径） ==\n');
  process.stdout.write(`description 非空 ${a.descriptionPresentRows} / 空 ${a.descriptionEmptyRows}（全部进 context，近似）\n`);
  process.stdout.write(`source 未搬（只记进事件 payload）：${JSON.stringify(a.sourceCounts)}\n`);
  process.stdout.write(`有平台标签但一个键都没剩的行：${a.rowsLosingAllPlatforms.length}\n`);
  for (const row of a.rowsLosingAllPlatforms) {
    process.stdout.write(`  Flower #${row.number} ${row.title} [${row.labels.join(' | ')}]\n`);
  }
}

// ─── 基线文件 ────────────────────────────────────────────────────────────────

type BaselineRow = {
  id: string;
  number: number;
  title: string;
  stateKey: string;
  state: string | null;
  priorityKey: string | null;
  priority: string | null;
  platforms: string[];
  platformLabels: string[];
  lineKey: string | null;
  type: string;
  ownerName: string | null;
  requesterName: string | null;
  sourceKey: string | null;
  descriptionLength: number;
  createdAt: string;
  stateChangedAt: string;
};

type Baseline = {
  generatedAt: string;
  source: { sshHost: string; container: string; database: string; where: string };
  scriptArgs: string[];
  total: number;
  analysis: Analysis;
  rows: BaselineRow[];
};

function toBaselineRow(row: FlowerRow): BaselineRow {
  const plan = planRow(row);
  return {
    id: row.id,
    number: Number(row.number),
    title: row.title,
    stateKey: row.state_key,
    state: plan.state,
    priorityKey: row.priority_key,
    priority: plan.priority,
    platforms: plan.platforms,
    platformLabels: row.platform_labels ?? [],
    lineKey: row.line_key,
    type: plan.type,
    ownerName: row.owner_name,
    requesterName: row.requester_name,
    sourceKey: row.source_key,
    descriptionLength: (row.description ?? '').length,
    createdAt: row.created_at,
    stateChangedAt: row.state_changed_at,
  };
}

/** 人读的那一份：分布 + 逐条 `number → state`（报告里引用的就是它）。 */
function baselineMarkdown(baseline: Baseline): string {
  const a = baseline.analysis;
  const lines: string[] = [];
  lines.push('# P1 迁移基线（Flower → Flowers）', '');
  lines.push(`生成时间：${baseline.generatedAt}`);
  lines.push(`来源：\`ssh ${baseline.source.sshHost}\` → \`docker exec ${baseline.source.container}\` → \`${baseline.source.database}\`，${baseline.source.where}`);
  lines.push(`命令：\`${baseline.scriptArgs.join(' ')}\``, '');
  lines.push(`**总计：${baseline.total} 条**`, '');
  lines.push('## 旧状态 → 我们的状态', '', '| 旧状态 | 条数 | 我们的状态 | 中文 |', '|---|---:|---|---|');
  for (const b of a.stateBuckets) {
    lines.push(`| \`${b.old}\` | ${b.count} | ${b.state === null ? '（未映射）' : `\`${b.state}\``} | ${b.state === null ? '—' : STATE_LABEL[b.state]} |`);
  }
  lines.push(`| **合计** | **${a.total}** | | |`, '');
  lines.push('## 我们的状态（合计）', '', '| 状态 | 条数 |', '|---|---:|');
  for (const [state, count] of Object.entries(a.stateTotals)) lines.push(`| \`${state}\` | ${count} |`);
  lines.push('', '## 优先级', '', '| 值 | 条数 |', '|---|---:|');
  for (const [key, count] of Object.entries(a.priorityCounts)) lines.push(`| \`${key}\` | ${count} |`);
  lines.push(`| （未定） | ${a.priorityUnset} |`, '');
  lines.push('## 平台', '', '| 键 | 行数 | 中文 |', '|---|---:|---|');
  for (const [key, count] of Object.entries(a.platformCounts)) lines.push(`| \`${key}\` | ${count} | ${platformLabel(key)} |`);
  lines.push(`| （未标注） | ${a.platformUnsetRows} | |`, '');
  lines.push('未映射、会被丢弃的平台标签：', '');
  for (const [label, count] of Object.entries(a.unmappedPlatforms)) lines.push(`- \`${label}\` — ${count} 行`);
  lines.push('', '## 类型', '', '| type | 条数 |', '|---|---:|');
  for (const [type, count] of Object.entries(a.typeCounts)) lines.push(`| \`${type}\` | ${count} |`);
  lines.push(`| （无 line，默认 feature） | ${a.noLineRows} |`, '');
  lines.push('## 逐条 number → state', '', '| number | 旧状态 | 我们的状态 | id |', '|---:|---|---|---|');
  for (const row of baseline.rows) {
    lines.push(`| ${row.number} | \`${row.stateKey}\` | ${row.state === null ? '（未映射）' : `\`${row.state}\``} | \`${row.id}\` |`);
  }
  lines.push('');
  return lines.join('\n');
}

function writeBaseline(rows: FlowerRow[], analysis: Analysis, path: string): void {
  const baseline: Baseline = {
    generatedAt: new Date().toISOString(),
    source: { sshHost: SSH_HOST, container: CONTAINER, database: DB_NAME, where: 'deleted_at is null' },
    scriptArgs: ['tsx', 'scripts/migrate-flower.ts', ...process.argv.slice(2)],
    total: rows.length,
    analysis,
    rows: rows.map(toBaselineRow).sort((a, b) => a.number - b.number),
  };
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  const mdPath = path.replace(/\.json$/, '.md');
  writeFileSync(mdPath, baselineMarkdown(baseline), 'utf8');
  process.stdout.write(`\n基线已写入：${path}\n人读版：${mdPath}\n`);
}

// ─── 对账（只读） ────────────────────────────────────────────────────────────

type VerifyRow = {
  legacy_ref: string;
  state: string;
  priority: string | null;
  platforms: string[];
  type: string;
  title: string;
};

/**
 * 拿库里的行与基线**逐条**比：状态 / 优先级 / 平台 / 类型 / 标题。
 *
 * 为什么逐条而不是只比分布：分布能对上而个别行错位是可能的（两条互换落点），
 * 而这次迁移的验收要求是「每一条都落在 dry-run 说的那一格」。
 */
async function verify(baselinePath: string): Promise<boolean> {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
  const expected = new Map(baseline.rows.map((row) => [row.id, row]));

  const res = await db.execute<VerifyRow>(sql`
    select legacy_ref, state, priority, platforms, type, title
      from requirements
     where legacy_ref is not null`);
  const actual = new Map(res.rows.map((row) => [row.legacy_ref, row]));

  const counts = await db.execute<{ total: string; migrated: string; native: string }>(sql`
    select count(*)::text as total,
           count(legacy_ref)::text as migrated,
           count(*) filter (where legacy_ref is null)::text as native
      from requirements`);

  const missing = [...expected.keys()].filter((id) => !actual.has(id));
  const extra = [...actual.keys()].filter((id) => !expected.has(id));
  const mismatches: string[] = [];
  const sameSet = <T>(a: T[], b: T[]): boolean => {
    const x = [...a].sort();
    const y = [...b].sort();
    return x.length === y.length && x.every((item, index) => item === y[index]);
  };

  for (const [id, want] of expected) {
    const got = actual.get(id);
    if (got === undefined) continue;
    const diffs: string[] = [];
    if (got.state !== want.state) diffs.push(`state ${want.state} ≠ ${got.state}`);
    if ((got.priority ?? null) !== want.priority) diffs.push(`priority ${want.priority} ≠ ${got.priority}`);
    if (!sameSet(got.platforms ?? [], want.platforms)) diffs.push(`platforms [${want.platforms}] ≠ [${got.platforms}]`);
    if (got.type !== want.type) diffs.push(`type ${want.type} ≠ ${got.type}`);
    if (got.title !== want.title) diffs.push('title 不一致');
    if (diffs.length > 0) mismatches.push(`Flower #${want.number}（${id}）：${diffs.join('；')}`);
  }

  // 两套计数，不能混：
  //   按**旧状态**（baseline 的 11 个桶）：这一格搬了几条 —— 与基线 stateBuckets 对；
  //   按**落点**（我们的状态）：最终落进哪一格 —— 与基线 stateTotals 对。
  const actualByOld = new Map<string, number>();
  const actualByState = new Map<string, number>();
  for (const row of res.rows) {
    const want = expected.get(row.legacy_ref);
    if (want === undefined) continue;
    actualByOld.set(want.stateKey, (actualByOld.get(want.stateKey) ?? 0) + 1);
    actualByState.set(row.state, (actualByState.get(row.state) ?? 0) + 1);
  }
  const expectedByState = new Map<string, number>();
  for (const row of baseline.rows) {
    if (row.state === null) continue;
    expectedByState.set(row.state, (expectedByState.get(row.state) ?? 0) + 1);
  }
  // 基线的 stateTotals 与逐行累加必须自洽（基线文件自己先过一遍，再拿去比库）。
  for (const [state, want] of Object.entries(baseline.analysis.stateTotals)) {
    if ((expectedByState.get(state) ?? 0) !== want) {
      process.stdout.write(`基线自相矛盾：${state} 声明 ${want} 条，逐行累加 ${expectedByState.get(state) ?? 0} 条\n`);
    }
  }

  process.stdout.write('\n== 逐条对账 ==\n');
  process.stdout.write(`基线 ${baseline.total} 条；库内 legacy_ref 非空 ${res.rows.length} 条；`
    + `缺失 ${missing.length}；多余 ${extra.length}；字段不一致 ${mismatches.length}\n`);
  process.stdout.write(`requirements 总行数 ${counts.rows[0]!.total}（搬来的 ${counts.rows[0]!.migrated} + 本系统自建 ${counts.rows[0]!.native}）\n`);

  let bucketsOk = true;
  process.stdout.write('\n== 按旧状态（Flower → 我们：基线 = 库内） ==\n');
  for (const bucket of baseline.analysis.stateBuckets) {
    const got = actualByOld.get(bucket.old) ?? 0;
    const same = got === bucket.count;
    bucketsOk = bucketsOk && same;
    process.stdout.write(`${pad(bucket.old, 16)}→ ${pad(bucket.state ?? '（未映射）', 10)}基线 ${pad(String(bucket.count), 6)}库内 ${pad(String(got), 6)}${same ? '一致' : '**不一致**'}\n`);
  }

  let totalsOk = true;
  process.stdout.write('\n== 按落点（我们的状态：基线 = 库内） ==\n');
  for (const [state, want] of Object.entries(baseline.analysis.stateTotals)) {
    const got = actualByState.get(state) ?? 0;
    const same = got === want;
    totalsOk = totalsOk && same;
    process.stdout.write(`${pad(state, 12)}基线 ${pad(String(want), 6)}库内 ${pad(String(got), 6)}${same ? '一致' : '**不一致**'}\n`);
  }
  for (const [state, got] of actualByState) {
    if (!(state in baseline.analysis.stateTotals)) {
      process.stdout.write(`库里有基线没有的落点 ${state}：${got} 条\n`);
      totalsOk = false;
    }
  }

  for (const line of mismatches.slice(0, 20)) process.stdout.write(`  ${line}\n`);
  if (missing.length > 0) process.stdout.write(`  缺失：${missing.slice(0, 10).join('、')}\n`);
  if (extra.length > 0) process.stdout.write(`  多余：${extra.slice(0, 10).join('、')}\n`);

  const ok = missing.length === 0 && extra.length === 0 && mismatches.length === 0
    && bucketsOk && totalsOk;
  process.stdout.write(`\n对账${ok ? '通过' : '**失败**'}。\n`);
  return ok;
}

// ─── 写库 ────────────────────────────────────────────────────────────────────

async function membersByName(): Promise<Map<string, string>> {
  const res = await db.execute<{ id: string; name: string }>(sql`select id, name from members`);
  return new Map(res.rows.map((row) => [row.name, row.id]));
}

async function migratedSourceIds(): Promise<Set<string>> {
  // 幂等键是 `requirements.legacy_ref`，不是 events 的 payload：事件是副作用，可以被
  // 单独删掉或补写；被搬的那一行自己身上那一列才是「这条搬过没有」的唯一答案。
  const res = await db.execute<{ legacy_ref: string }>(sql`
    select legacy_ref from requirements where legacy_ref is not null`);
  return new Set(res.rows.map((row) => row.legacy_ref));
}

async function apply(rows: FlowerRow[]): Promise<void> {
  const people = await membersByName();
  const already = await migratedSourceIds();
  let inserted = 0;
  let skipped = 0;

  for (const row of rows) {
    if (already.has(row.id)) {
      skipped += 1;
      continue;
    }
    const plan = planRow(row);
    if (plan.state === null) {
      // 不认识的旧状态**不写**：搬一条没有状态的需求等于造一条坏数据。
      process.stdout.write(`跳过（未映射状态 ${row.state_key}）：Flower #${row.number} ${row.title}\n`);
      continue;
    }
    const state = plan.state;
    const ownerId = row.owner_name === null ? null : people.get(row.owner_name) ?? null;

    await db.transaction(async (tx) => {
      const created = await tx.execute<{ id: string }>(sql`
        insert into requirements
          (title, type, state, state_entered_at, requester, owner_member_id,
           context, platforms, priority, created_at, legacy_ref)
        values (
          ${row.title}, ${plan.type}, ${state}, ${row.state_changed_at},
          ${row.requester_name ?? '未知'}, ${ownerId},
          ${row.description === '' ? null : row.description},
          ${sql.param(plan.platforms)}::text[], ${plan.priority},
          ${row.created_at}, ${row.id}
        )
        returning id`);
      const id = created.rows[0]!.id;
      // 迁移本身是一条事件：谁搬的、从哪条搬的、旧状态是什么、原来源是什么。
      // 幂等键是行上的 `legacy_ref`；事件只负责在时间轴上答「这条需求是哪来的」。
      await recordEvent(tx, {
        requirementId: id,
        actor: 'migrate-flower',
        type: 'requirement.migrated',
        payload: {
          sourceId: row.id,
          sourceNumber: Number(row.number),
          sourceState: row.state_key,
          sourceSource: row.source_key,
          state,
          title: row.title,
        },
      });
    });
    inserted += 1;
  }

  process.stdout.write(`\n写入 ${inserted} 条，跳过（已搬过）${skipped} 条。\n`);
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const applyFlag = argv.includes('--apply');
const baselineIndex = argv.indexOf('--baseline');
const verifyIndex = argv.indexOf('--verify');
const baselinePath = baselineIndex >= 0 ? argv[baselineIndex + 1] : undefined;
const verifyPath = verifyIndex >= 0 ? argv[verifyIndex + 1] : undefined;

if (verifyIndex >= 0) {
  // --verify 只读，不连 Flower：基线文件就是「dry-run 当时线上是什么样」的快照。
  if (verifyPath === undefined) throw new Error('--verify 需要一个基线文件路径');
  const ok = await verify(verifyPath);
  await pool.end();
  if (!ok) process.exitCode = 1;
} else {
  const rows = loadFlowerRows();
  const analysis = analyze(rows);
  printReport(analysis);

  if (analysis.unmappedStates.length > 0) {
    process.stdout.write(`\n未映射的旧状态：${analysis.unmappedStates.join('、')}\n`);
  }
  if (Object.keys(analysis.unmappedPlatforms).length > 0) {
    process.stdout.write(`未映射的平台标签：${Object.keys(analysis.unmappedPlatforms).join('、')}\n`);
  }

  if (baselinePath !== undefined) writeBaseline(rows, analysis, baselinePath);

  if (applyFlag) {
    await apply(rows);
  } else {
    process.stdout.write('\n--dry-run：只打印映射，没有写库。要真写请加 --apply。\n');
  }

  await pool.end();
}
