/**
 * 存量回退：**只**把「六问核心三条不齐」的 `待设计` 需求退回 `收集`。
 *
 *   npx tsx scripts/migrate-brief-to-inbox.ts            # 默认 dry-run：只打印会发生什么
 *   npx tsx scripts/migrate-brief-to-inbox.ts --apply    # 真写库（幂等）
 *
 * ## 为什么要有这条迁移
 *
 * owner 的裁决（2026-11-10）：「六问不齐不能立项。收集阶段必须填好核心三问才能点
 * 评估；点了评估就进待设计，所以『六问不齐』既不能生成材料、也不能进待设计。」
 *
 * 于是门挂到了状态变迁上（`state-machine.ts` 的 `guard: 'brief'`）。但库里已经有一批
 * 在规则落地**之前**就进了待设计的行：它们从来没被要求填过核心三问，今天也不会再被
 * 要求（它们已经过了评估这一关）。两条路只能选一条：
 *
 * - 只对新数据生效 → 同一条规则在库里出现两种事实，看板上的「待设计」既可能是
 *   「六问齐的」也可能是「六问空的」，而抽屉里那一行按钮的禁用理由会按状态说两种话。
 * - 按新口径把**还没过门的那一步**退回去 → owner 选了这一条：口径只有一个。
 *
 * ## 只动 `design`，其余一律不碰（承重的一条）
 *
 * `review / queue / ready / dev / test / live / rejected / shelved` **一个字都不改**，
 * 即使它们六问也不齐。理由与 0021 那条迁移同源：**终态是结论，不是流程位置**，而
 * review 之后的位置是已经发生过的判断（评审过、排过期、上过线）。把它们退回收集等于
 * 用一条今天的数据规范去撤销当时有人做过的决定，而且会让一张「已上线」的卡出现在
 * 「等人补描述」的列里。owner 的原话：「已到 待评审 / 待排期 / 待开发 / 开发中 /
 * 测试中 / 已上线 / 已拒绝 / 已搁置 的一律不动」。
 *
 * ## 判据不是 SQL 里另抄一遍
 *
 * 哪些行算「核心三条不齐」由 `src/core/requirements/brief.ts` 的 `missingRequired`
 * 判——**与状态机那道门、生成前那道门、抽屉里那句话是同一个函数**。写成 SQL 谓词
 * （`btrim(context) <> ''`）会立刻变成第二份口径：`missingRequired` 判的是 `trim()`
 * 之后的空串，SQL 那边的空值 / 全角空格 / NBSP 处理随时会和它分叉，而分叉的后果是
 * 「门说缺，迁移说齐」——一批该退的行留在待设计，规则看起来生效了、其实没生效。
 *
 * 所以流程是：先把候选行连三格一起读回来 → JS 里用 `missingRequired` 过滤 →
 * 只对命中的 id 逐条 `update`（`and state = 'design'` 让并发 / 重复执行时第二次
 * 命中 0 行、不写第二条事件）。
 *
 * ## 幂等
 *
 * 第二次跑只会选出 `state = 'design'` 的行，而该动的行第一次就都变成 `inbox` 了，
 * 所以命中 0 行、写 0 条事件。空库（0 条需求）同样不报错：`before` / `after` 两张
 * 分布表都是空的，`moved` 是 0。
 *
 * ## 事件
 *
 * 每条被移动的行写一条 `requirement.state_changed`，`actor = 'system'`，payload 里
 * 三件事：`from` / `to`（两端都是状态机的枚举，读侧用 `STATE_LABEL` 翻中文）、
 * `reason`（那句原因，写死在下面）与 `batch`。
 *
 * `batch` 是 0028 那条裁定的口令（「批量操作不该刷屏」）：一次命令移动 42 行，
 * 如果逐条进通知，超管会收到 42 条一模一样的东西。带上它，`read/notify.ts` 的
 * `notBatch` 会把它们挡在 feed / 红点 / 企微之外——**事件是账，通知是打扰**，
 * 审计记录照旧留在时间轴上（`detail.ts` 的 `describe` 认这个类型）。
 */

import { sql } from 'drizzle-orm';
import { db, pool, type Db } from '../src/db/client.js';
import { recordEvent } from '../src/core/events.js';
import { missingRequired } from '../src/core/requirements/brief.js';
import { STATE_LABEL, type State } from '../src/core/state-machine.js';

/** 被移动的行写进事件的那句原因（owner 的原话，一字不改）。 */
export const REASON = '六问核心三条不齐，v1 立项前必须先补';

/** 这一批的标识：进 payload 的 `batch`，让 `read/notify.ts` 不把它当通知发。 */
export const BATCH = '2026-11-10-brief-to-inbox';

/** 迁移前 / 后的状态分布（`state` → 条数）。只含出现过的状态，按状态表的顺序。 */
export type Distribution = Record<string, number>;

export type BackfillResult = {
  /** 真的被移动的行（dry-run 与 --apply 都给这个数：它是「会不会动」的答案）。 */
  moved: number;
  /** 被移动的 PAN 编号，升序。报告里点名用。 */
  numbers: number[];
  /** 跑之前 / 跑之后的状态分布（dry-run 时两者相同）。 */
  before: Distribution;
  after: Distribution;
};

type Candidate = {
  id: string; number: number;
  context: string | null; problem: string | null; outcome: string | null;
};

/** 当前全部未删除需求的状态分布，按状态表顺序排（`order by` 在 JS 里做，见下）。 */
export async function distribution(db: Db): Promise<Distribution> {
  const res = await db.execute<{ state: string; n: number }>(sql`
    select state, count(*)::int as n
      from requirements
     where deleted_at is null
     group by state`);
  const out: Distribution = {};
  for (const row of res.rows) out[row.state] = Number(row.n);
  // 顺序按 `STATE_LABEL` 的键：同一个库不管 PG 怎么排，报告里那张表都是同一个样子。
  const ordered: Distribution = {};
  for (const state of Object.keys(STATE_LABEL)) {
    if (out[state] !== undefined) ordered[state] = out[state];
  }
  // 认不出的历史状态原样留在最后（不丢、也不假装它是十个之一）。
  for (const [state, n] of Object.entries(out)) {
    if (ordered[state] === undefined) ordered[state] = n;
  }
  return ordered;
}

/**
 * 挑出「现在是待设计、但核心三条不齐」的行。
 *
 * 软删的行**不算**：`deleted_at is not null` 的行对外等于不存在（`lock.ts` 那一层
 * 就挡着），把它退回收集不会让任何人少补一格描述，只会让一条看不见的行多一条事件。
 */
async function candidates(db: Db): Promise<Candidate[]> {
  const res = await db.execute<Candidate>(sql`
    select id, number, context, problem, outcome
      from requirements
     where state = 'design' and deleted_at is null
     order by number`);
  return res.rows.filter((row) => missingRequired(row).length > 0);
}

/**
 * 执行（或预演）这条回退。
 *
 * `dryRun` 只读：它给出「会动几行、哪几条、前后分布长什么样」，一个字节都不写。
 * 真写入在**一个事务**里：42 行要么全退、要么一行都不退——一半退回的库比没跑更坏
 * （没人知道停在了哪一条）。
 */
export async function moveBrieflessDesignToInbox(
  db: Db, opts: { dryRun?: boolean } = {},
): Promise<BackfillResult> {
  const before = await distribution(db);
  const rows = await candidates(db);
  const numbers = rows.map((row) => Number(row.number));
  if (opts.dryRun === true || rows.length === 0) {
    return { moved: rows.length, numbers, before, after: before };
  }

  await db.transaction(async (tx) => {
    for (const row of rows) {
      // `and state = 'design'`：第二个跑同一条命令的人（或一条被别处同时改过的行）
      // 在这里拿 0 行，于是既不写事件、也不把一条已推进的需求退回来。
      const updated = await tx.execute(sql`
        update requirements
           set state = 'inbox',
               state_entered_at = now()
         where id = ${row.id} and state = 'design'`);
      if ((updated.rowCount ?? 0) === 0) continue;
      await recordEvent(tx, {
        requirementId: row.id,
        actor: 'system',
        type: 'requirement.state_changed',
        payload: { from: 'design', to: 'inbox', reason: REASON, batch: BATCH },
      });
    }
  });

  return { moved: rows.length, numbers, before, after: await distribution(db) };
}

/** 一张「状态 前 → 后」的表（报告用；控制台里也是这张）。 */
export function formatDistribution(before: Distribution, after: Distribution): string[] {
  const states = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const out = [`${'状态'.padEnd(8)}${'前'.padStart(6)}${'后'.padStart(6)}${'差'.padStart(6)}`];
  for (const state of states) {
    const b = before[state] ?? 0;
    const a = after[state] ?? 0;
    const label = STATE_LABEL[state as State] ?? state;
    out.push(`${label.padEnd(8)}${String(b).padStart(6)}${String(a).padStart(6)}`
      + `${String(a - b).padStart(6)}`);
  }
  return out;
}

async function main(): Promise<void> {
  const applyNow = process.argv.slice(2).includes('--apply');
  const result = await moveBrieflessDesignToInbox(db, { dryRun: !applyNow });

  const pick = <K extends State>(state: K): number => result.before[state] ?? 0;
  const pickAfter = <K extends State>(state: K): number => result.after[state] ?? 0;
  console.log(`待设计（核心三条不齐）命中：${result.moved} 条`
    + `${applyNow ? '（已退回收集）' : '（dry-run，加 --apply 才写库）'}`);
  if (result.numbers.length > 0) {
    console.log(`  ${result.numbers.map((n) => `PAN-${n}`).join(' · ')}`);
  }
  console.log(`待设计 ${pick('design')} → ${pickAfter('design')}`
    + ` · 收集 ${pick('inbox')} → ${pickAfter('inbox')}`);
  for (const line of formatDistribution(result.before, result.after)) console.log(line);
}

// 只在被当脚本跑时执行：用例 import 的是上面那几个函数，不该顺手打印一份报告、
// 更不该在 import 那一刻就写库。
if (process.argv[1] !== undefined && process.argv[1].endsWith('migrate-brief-to-inbox.ts')) {
  await main();
  await pool.end();
}
