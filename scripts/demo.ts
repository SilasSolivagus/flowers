/**
 * P1 冒烟脚本：把一条需求从「收集中」走到「已上线」，每一步打印状态。
 *
 *   npx tsx scripts/demo.ts
 *
 * 只走真实服务（create / evaluate / submitReview / reviewPass / schedule / tick），
 * 不直接改状态列：任何非法跳步都该像生产那样抛 AppError，而不是被脚本绕过。
 *
 * 校验：每一步的 state 与计划的表逐项对齐；最终状态必须是 live。
 * 任何不一致都以非 0 退出码收场，方便挂到 CI 上。
 */
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import type { State } from '../src/core/state-machine.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { reviewPass } from '../src/core/requirements/review.js';
import { schedule } from '../src/core/requirements/schedule.js';
import { tick } from '../src/core/clock/tick.js';
import { resetDb, seedPeople } from '../tests/helpers/db.js';

// ─── 剧本参数 ────────────────────────────────────────────────────────────────

const ACTOR_PM = '吕品';
const ACTOR_REVIEWER = '吕正豪';
const RELEASE_NAME = '2026.12';
const WINDOW_START = '2026-12-01';
const RELEASE_DATE = '2026-12-04';
const COMMIT_TEST_AT = '2026-12-01';
const COMMIT_DUE_AT = '2026-12-04';

/** 预期状态序列（计划「验收标准」那张表的顺序）。 */
const EXPECTED: State[] = [
  'inbox',  // createRequirement
  'design', // evaluate
  'review', // submitReview
  'queue',  // reviewPass
  'ready',  // schedule
  'dev',    // tick @ 2026-12-01（开工日）
  'test',   // tick @ 2026-12-03（已过提测日）
  'live',   // tick @ 2026-12-04（承诺完成日）
];

// ─── 小工具 ──────────────────────────────────────────────────────────────────

const failures: string[] = [];
const observed: State[] = [];

function log(text = '') {
  process.stdout.write(`${text}\n`);
}

/**
 * 终端里的显示宽度：CJK / 全角字符占两列，`padEnd` 只按码点数算，
 * 中文标签会把 state 那一列推歪。这里按列宽补空格。
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function head(text: string) {
  log();
  log(`── ${text} ${'─'.repeat(Math.max(0, 58 - displayWidth(text)))}`);
}

/** 读回真实的 state 列：不信服务返回值，也不信内存里的副本。 */
async function readState(requirementId: string): Promise<State> {
  const r = await db.execute<{ state: State }>(
    sql`select state from requirements where id = ${requirementId}`);
  const row = r.rows[0];
  if (!row) throw new Error(`需求 ${requirementId} 不见了`);
  return row.state;
}

type Step = { label: string; expected: State; run: () => Promise<unknown> };

/** 跑一步 → 回读状态 → 与预期比对 → 打印一行。 */
async function runStep(index: number, total: number, step: Step, requirementId: () => string) {
  await step.run();
  const state = await readState(requirementId());
  observed.push(state);
  const ok = state === expectedSafe(index);
  if (!ok) {
    failures.push(`第 ${index} 步 ${step.label}：期望 ${expectedSafe(index)}，实际 ${state}`);
  }
  const mark = ok ? '✓' : '✗';
  log(`[${index}/${total}] ${padTo(step.label, 48)} state=${padTo(state, 8)} ${mark}`);
}

function expectedSafe(index: number): State {
  const value = EXPECTED[index - 1];
  if (!value) throw new Error(`第 ${index} 步没有预期状态`);
  return value;
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

let requirementIdValue: string | null = null;
const requirementId = () => {
  if (!requirementIdValue) throw new Error('需求还没建出来');
  return requirementIdValue;
};

async function main() {
  log('=== flowers · P1 状态机冒烟 ===');
  log(`库：${process.env.DATABASE_URL ?? 'postgres://postgres:flowers@localhost:54330/flowers'}`);

  head('准备');

  // 1. 重置 + 种人。测试助手是普通函数，脚本里复用，避免两套种子数据分叉。
  await resetDb();
  const people = await seedPeople();
  log(`resetDb()  已清空 5 张表`);
  log(`seedPeople() 建了 ${people.length} 个人：${people.map((p) => `${p.name}/${p.role}`).join('、')}`);

  // 2. 建版本。P1 没有 releases 服务（版本只有建表和排期时的一次读取），
  //    所以这一步只能落 SQL——脚本里唯一的直接写库。
  const rel = await db.execute<{ id: string }>(sql`
    insert into releases (name, window_start, release_date)
    values (${RELEASE_NAME}, ${WINDOW_START}, ${RELEASE_DATE})
    returning id`);
  const releaseId = rel.rows[0]?.id;
  if (!releaseId) throw new Error('版本没建出来');
  log(`releases    ${RELEASE_NAME}：开工 ${WINDOW_START} → 发版 ${RELEASE_DATE}（id=${releaseId.slice(0, 8)}…）`);

  head('链路');

  const steps: Step[] = [
    {
      label: `createRequirement('${ACTOR_PM}', feature)`,
      expected: 'inbox',
      run: async () => {
        const created = await createRequirement(db, ACTOR_PM, {
          title: 'S3 协议支持',
          type: 'feature',
          requester: '孙建宏',
        });
        requirementIdValue = created.id;
        log(`         → 建出需求 #${created.number}（id=${created.id.slice(0, 8)}…）`);
      },
    },
    {
      label: `evaluate('${ACTOR_PM}')`,
      expected: 'design',
      run: () => evaluate(db, ACTOR_PM, { requirementId: requirementId() }),
    },
    {
      label: `submitReview('${ACTOR_PM}', prdUrl)`,
      expected: 'review',
      run: () =>
        submitReview(db, ACTOR_PM, {
          requirementId: requirementId(),
          prdUrl: 'https://docs.example.com/prd/s3',
        }),
    },
    {
      label: `reviewPass('${ACTOR_REVIEWER}')`,
      expected: 'queue',
      run: () => reviewPass(db, ACTOR_REVIEWER, { requirementId: requirementId() }),
    },
    {
      label: `schedule('${ACTOR_PM}', ${RELEASE_NAME})`,
      expected: 'ready',
      run: () =>
        schedule(db, ACTOR_PM, {
          requirementId: requirementId(),
          releaseId,
          commitTestAt: COMMIT_TEST_AT,
          commitDueAt: COMMIT_DUE_AT,
        }),
    },
    {
      label: 'tick(2026-12-01)  开工日：待开发 → 开发中',
      expected: 'dev',
      run: () => tickAt('2026-12-01'),
    },
    {
      label: 'tick(2026-12-03)  已过提测日：开发中 → 测试中',
      expected: 'test',
      run: () => tickAt('2026-12-03'),
    },
    {
      label: 'tick(2026-12-04)  承诺完成日：测试中 → 已上线',
      expected: 'live',
      run: () => tickAt('2026-12-04'),
    },
  ];

  async function tickAt(day: string) {
    // 北京时间零点：tick 按 Asia/Shanghai 的「天」比较，给 UTC 零点会差 8 小时。
    const moved = await tick(db, new Date(`${day}T00:00:00+08:00`));
    const label = moved.moved.map((m) => `${m.from}→${m.to}`).join(', ') || '无移动';
    log(`         → tick moved: ${moved.moved.length}（${label}）`);
  }

  for (const [i, step] of steps.entries()) {
    await runStep(i + 1, steps.length, step, requirementId);
  }

  // ─── 汇总 ────────────────────────────────────────────────────────────────

  head('汇总');

  const events = await db.execute<{ seq: number; type: string; actor: string }>(sql`
    select seq, type, actor from events order by seq`);
  // 不按 verdict 过滤：reviewPass 已经把派单收口成 'passed'，此时库里没有 handed
  // 行，只查 handed 会得到「无评审人」。派单行本身就是历史，verdict 只是它的结果。
  const reviewer = await db.execute<{ name: string; role: string; verdict: string | null }>(sql`
    select m.name, m.role, ra.verdict
      from review_assignments ra
      join members m on m.id = ra.reviewer_member_id
     where ra.requirement_id = ${requirementId()}
     order by ra.decided_at nulls last, m.name
     limit 1`);

  const finalState = await readState(requirementId());
  const reviewerRow = reviewer.rows[0];

  log(`${padTo('状态序列', 10)}${observed.join(' → ')}`);
  log(`${padTo('事件条数', 10)}${events.rows.length}`);
  for (const e of events.rows) {
    log(`  seq ${String(e.seq).padEnd(2)} ${e.type.padEnd(32)} actor=${e.actor}`);
  }
  log(`${padTo('评审人', 10)}${reviewerRow ? `${reviewerRow.name}（${reviewerRow.role}，派单 verdict=${reviewerRow.verdict}）` : '无'}`);
  log(`${padTo('最终状态', 10)}${finalState}`);

  if (finalState !== 'live') {
    failures.push(`最终状态是 ${finalState}，不是 live`);
  }
  if (!reviewerRow) {
    failures.push('汇总时找不到任何派单行，评审人缺失');
  }
  if (observed.length !== EXPECTED.length) {
    failures.push(`只走了 ${observed.length} 步，预期 ${EXPECTED.length} 步`);
  }

  head('结果');
  if (failures.length > 0) {
    for (const f of failures) log(`FAIL  ${f}`);
    log(`结论：失败（${failures.length} 项）`);
    process.exitCode = 1;
    return;
  }
  log('结论：PASS —— 8 步状态全部符合计划，最终 live');
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log();
    log(`链路中断：${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    // pool 不关，node 进程会挂在连接上不退。
    await pool.end();
  });
