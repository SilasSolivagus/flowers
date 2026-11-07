/**
 * Flower（生产实例）→ Flowers（本项目）的需求搬运器。
 *
 * 只搬一件事：**旧库里那 11 个状态落到我们这 10 个状态的哪一格**，顺带把
 * platform / priority / line 三个自定义字段翻成我们的词表。
 *
 *   npx tsx scripts/migrate-flower.ts            # 默认 --dry-run：只打印映射，不写库
 *   npx tsx scripts/migrate-flower.ts --apply    # 真写（幂等：按 Flower 的 uuid 跳过已搬过的行）
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

function report(rows: FlowerRow[]): { unmappedStates: string[]; unmappedPlatforms: Map<string, number> } {
  const list = buckets(rows);
  const total = rows.length;

  process.stdout.write('\n== 状态映射（Flower 11 → 我们 10） ==\n');
  process.stdout.write(
    `${pad('旧状态', 16)}${pad('条数', 8)}${pad('我们的状态', 16)}中文\n`,
  );
  for (const item of list) {
    process.stdout.write(
      `${pad(item.old, 16)}${pad(String(item.count), 8)}`
      + `${pad(item.state ?? '（未映射）', 16)}${item.state === null ? '—' : STATE_LABEL[item.state]}\n`,
    );
  }
  process.stdout.write(`${pad('合计', 16)}${String(total)}\n`);

  const unmappedStates = list.filter((item) => item.state === null).map((item) => item.old);

  // ── 平台：每行按标签翻，翻完去重 ──
  const platformCounts = new Map<string, number>();
  const unmappedPlatforms = new Map<string, number>();
  const droppedPerRow: number[] = [];
  for (const row of rows) {
    const labels = row.platform_labels ?? [];
    const keys: string[] = [];
    for (const label of labels) {
      const key = PLATFORM_MAP[label];
      if (key === undefined) {
        unmappedPlatforms.set(label, (unmappedPlatforms.get(label) ?? 0) + 1);
      } else {
        keys.push(key);
        platformCounts.set(key, (platformCounts.get(key) ?? 0) + 1);
      }
    }
    const normalized = normalizePlatforms(keys);
    if (normalized.length < keys.length && keys.length > 1) droppedPerRow.push(1);
  }

  process.stdout.write('\n== 平台（标签 → 我们的键；同一行去重） ==\n');
  for (const [key, count] of [...platformCounts.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`${pad(key, 12)}${pad(String(count), 8)}${platformLabel(key)}\n`);
  }
  process.stdout.write(`${pad('未标注', 12)}${String(rows.filter((r) => (r.platform_labels ?? []).length === 0).length)}\n`);
  if (unmappedPlatforms.size > 0) {
    process.stdout.write('未映射的平台标签（会被丢弃，逐条列出）：\n');
    for (const [label, count] of [...unmappedPlatforms.entries()].sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`  ${pad(label, 40)}${count}\n`);
    }
  }

  // ── 优先级 ──
  const priorityCounts = new Map<string, number>();
  let priorityMissing = 0;
  for (const row of rows) {
    const key = normalizePriority(row.priority_key);
    if (key === null) {
      priorityMissing += 1;
      continue;
    }
    priorityCounts.set(key, (priorityCounts.get(key) ?? 0) + 1);
  }
  process.stdout.write('\n== 优先级 ==\n');
  for (const [key, count] of [...priorityCounts.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`${pad(key, 12)}${pad(String(count), 8)}${priorityLabel(key)}\n`);
  }
  process.stdout.write(`${pad('未定', 12)}${priorityMissing}\n`);

  // ── 类型 ──
  const typeCounts = new Map<string, number>();
  for (const row of rows) {
    const type = row.line_key === null || row.line_key === undefined
      ? '（无 line，默认 feature）'
      : TYPE_MAP[row.line_key] ?? `（未映射 line=${row.line_key}，默认 feature）`;
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }
  process.stdout.write('\n== 类型（line → type） ==\n');
  for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`${pad(type, 40)}${count}\n`);
  }

  return { unmappedStates, unmappedPlatforms };
}

// ─── 写库 ────────────────────────────────────────────────────────────────────

async function membersByName(): Promise<Map<string, string>> {
  const res = await db.execute<{ id: string; name: string }>(sql`select id, name from members`);
  return new Map(res.rows.map((row) => [row.name, row.id]));
}

async function migratedSourceIds(): Promise<Set<string>> {
  const res = await db.execute<{ source_id: string }>(sql`
    select payload::jsonb ->> 'sourceId' as source_id
      from events
     where type = 'requirement.migrated'`);
  return new Set(res.rows.map((row) => row.source_id).filter(Boolean));
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
    const state = STATE_MAP[row.state_key];
    if (state === undefined) {
      // 不认识的旧状态**不写**：搬一条没有状态的需求等于造一条坏数据。
      process.stdout.write(`跳过（未映射状态 ${row.state_key}）：Flower #${row.number} ${row.title}\n`);
      continue;
    }

    const labels = row.platform_labels ?? [];
    const platforms = normalizePlatforms(labels.map((label) => PLATFORM_MAP[label]).filter(Boolean));
    const type = row.line_key === null || row.line_key === undefined
      ? 'feature'
      : TYPE_MAP[row.line_key] ?? 'feature';
    const ownerId = row.owner_name === null ? null : people.get(row.owner_name) ?? null;

    await db.transaction(async (tx) => {
      const created = await tx.execute<{ id: string }>(sql`
        insert into requirements
          (title, type, state, state_entered_at, requester, owner_member_id,
           context, platforms, priority, created_at)
        values (
          ${row.title}, ${type}, ${state}, ${row.state_changed_at},
          ${row.requester_name ?? '未知'}, ${ownerId},
          ${row.description === '' ? null : row.description},
          ${sql.param(platforms)}::text[], ${normalizePriority(row.priority_key)},
          ${row.created_at}
        )
        returning id`);
      const id = created.rows[0]!.id;
      // 迁移本身是一条事件：谁搬的、从哪条搬的、旧状态是什么、原来源是什么。
      // 这样「这条需求是哪来的」在时间轴上答得出来，而且 apply 可以按 sourceId 幂等。
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

const applyFlag = process.argv.slice(2).includes('--apply');
const rows = loadFlowerRows();
const { unmappedStates, unmappedPlatforms } = report(rows);

if (unmappedStates.length > 0) {
  process.stdout.write(`\n未映射的旧状态：${unmappedStates.join('、')}\n`);
}
if (unmappedPlatforms.size > 0) {
  process.stdout.write(`未映射的平台标签：${[...unmappedPlatforms.keys()].join('、')}\n`);
}

if (applyFlag) {
  await apply(rows);
} else {
  process.stdout.write('\n--dry-run：只打印映射，没有写库。要真写请加 --apply。\n');
}

await pool.end();
