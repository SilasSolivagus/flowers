import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client.js';
import {
  IMPORT_EVENT_TYPE,
  STALE_DAYS,
  activityOf,
  buildAudit,
  idleDays,
  isFresh,
  normalizeTitle,
  type AuditRow,
  type LiveRow,
} from '../src/core/requirements/stale-audit.js';

/**
 * 「没有负责人 + 很久没人动」的分桶口径（`src/core/requirements/stale-audit.ts`）。
 *
 * 这一组**不碰库**：全部是内存里的行 + 一个固定的 `now`。分桶是一段纯算术，它唯一
 * 需要的输入是「最后活动是什么时候」，而那段算术正是这个审计会不会被采信的全部。
 * 拿真库跑一遍只能证明「今天跑了不报错」，改错一个比较符照样绿。
 *
 * 写法是**变异优先**：每条用例都点名「把哪一处改掉，这条会变红」，否则用例只是把
 * 实现重抄了一遍。最重要的一条是 `迁移记账事件`：整个审计存在的前提就是「搬运那天
 * 不算活动」，把它加回去，B 桶立刻归零——那份报告也就没有意义了。
 *
 * 为什么还得关 `pool`：口径模块 import 了 `clock/tick.ts`（`shanghaiDayOf`，与界面
 * 「停留 N 天」同一套北京日历），那条链会连带 `db/client.js`。不关池，vitest 会挂住。
 */
afterAll(async () => {
  await pool.end();
});

/** 固定「现在」：2026-11-08 00:00 北京时间（= 2026-11-07T16:00Z）。 */
const NOW = new Date('2026-11-08T00:00:00+08:00');
/** 时效线：NOW - 180 天 = 2026-05-12 00:00 北京时间。 */
const CUTOFF = '2026-05-12T00:00:00+08:00';
/** 时效线前 1 毫秒 —— 边界用例的反面。 */
const JUST_STALE = '2026-05-11T23:59:59.999+08:00';

function row(over: Partial<AuditRow> & Pick<AuditRow, 'id' | 'number' | 'state' | 'stateEnteredAt'>): AuditRow {
  return {
    title: `标题 ${over.number}`,
    prdUrl: null,
    source: null,
    platforms: [],
    lastEventAt: null,
    ...over,
  };
}

/** 未删需求那一侧：无主的行**也在**里面（真库里它就是未删行的一条）。 */
function asLive(rows: AuditRow[]): LiveRow[] {
  return rows.map((item) => ({
    id: item.id, number: item.number, title: item.title, state: item.state,
  }));
}

describe('分桶：A / B / C', () => {
  const rows: AuditRow[] = [
    // A：进状态在半年内（没有事件）
    row({ id: 'r1', number: 1, state: 'inbox', stateEnteredAt: '2026-10-01T00:00:00+08:00' }),
    // A：进状态很旧，但半年前之后有过业务事件 → 取大
    row({
      id: 'r2', number: 2, state: 'inbox', stateEnteredAt: '2026-01-01T00:00:00+08:00',
      lastEventAt: '2026-09-01T00:00:00+08:00',
    }),
    // B：进状态旧，最后一条业务事件也旧（有事件 → 不算 C）
    row({
      id: 'r3', number: 3, state: 'inbox', stateEnteredAt: '2026-01-01T00:00:00+08:00',
      lastEventAt: '2026-02-01T00:00:00+08:00',
    }),
    // B 且 C：一条业务事件都没有
    row({ id: 'r4', number: 4, state: 'inbox', stateEnteredAt: '2026-01-31T00:00:00+08:00' }),
    // 终态：A（rejected，半年内）
    row({ id: 'r5', number: 5, state: 'rejected', stateEnteredAt: '2026-09-01T00:00:00+08:00' }),
    // 终态：B（shelved，很旧）
    row({ id: 'r6', number: 6, state: 'shelved', stateEnteredAt: '2026-01-01T00:00:00+08:00' }),
    // 边界：**恰好** 180 天 → A
    row({ id: 'r7', number: 7, state: 'inbox', stateEnteredAt: CUTOFF }),
    // 边界：差 1 毫秒 → B
    row({ id: 'r8', number: 8, state: 'inbox', stateEnteredAt: JUST_STALE }),
  ];

  const audit = buildAudit({ ownerless: rows, live: asLive(rows), now: NOW });

  it('A / B / C 的计数与总数对得上（变异：把 `>=` 改成 `>`，A 掉 1、B 涨 1）', () => {
    expect(audit.total).toBe(8);
    expect(audit.buckets).toEqual({ fresh: 4, stale: 4, noEvents: 3 });
    expect(audit.buckets.fresh + audit.buckets.stale).toBe(audit.total);
  });

  it('恰好 180 天算「还活着」：边界归 A，不归 B（变异：`>=` → `>`，r7 落进 B）', () => {
    const fresh = audit.staleRows.map((item) => item.number);
    expect(fresh).not.toContain(7);
    expect(fresh).toContain(8);
  });

  it('C 是 B 的子集：只有「一条业务事件都没有」才进 C（变异：把 lastEventAt 非空也算 C → 变 4）', () => {
    expect(audit.buckets.noEvents).toBe(3);
    // r3 有一条 2026-02-01 的业务事件，所以它进 B 但不进 C。
    expect(audit.staleRows.filter((item) => !item.hasEvents).map((item) => item.number))
      .toEqual([6, 4, 8]);
  });

  it('终态不推群、不进批量拒绝：actionable 只算非终态（变异：把终态也算进去 → 8/4/4）', () => {
    expect(audit.terminal.total).toBe(2);
    expect(audit.actionable).toEqual({ total: 6, fresh: 3, stale: 3 });
    expect(audit.staleRows.map((item) => item.terminal)).toEqual([true, false, false, false]);
  });

  it('B 桶按最后活动从旧到新排（变异：不排序 → 第一个变成 3）', () => {
    expect(audit.staleRows.map((item) => item.number)).toEqual([6, 4, 3, 8]);
    expect(audit.staleRows[0]!.lastActivityAt).toBe('2026-01-01');
  });
});

describe('活动 = max(业务事件, 进状态时刻)', () => {
  it('事件比进状态新时，最后活动来自事件（变异：只读 state_entered_at，r2 掉进 B）', () => {
    const r = row({
      id: 'x', number: 1, state: 'inbox', stateEnteredAt: '2026-01-01T00:00:00+08:00',
      lastEventAt: '2026-10-01T00:00:00+08:00',
    });
    expect(activityOf(r)).toEqual({ at: new Date('2026-10-01T00:00:00+08:00').getTime(), from: 'event' });
  });

  it('进状态比事件新时，最后活动来自状态（迁移行的常态：只有那条搬运事件被剔掉之后）', () => {
    const r = row({
      id: 'x', number: 1, state: 'inbox', stateEnteredAt: '2026-10-01T00:00:00+08:00',
      lastEventAt: '2026-06-01T00:00:00+08:00',
    });
    expect(activityOf(r)).toEqual({ at: new Date('2026-10-01T00:00:00+08:00').getTime(), from: 'state' });
  });

  it('停了多少天按北京日历日算：2026-03-12 → 2026-11-08 是 241 天（变异：按 UTC 相减 → 240）', () => {
    const at = new Date('2026-03-12T07:32:56+00:00').getTime();
    expect(idleDays(at, NOW.getTime())).toBe(241);
    expect(idleDays(NOW.getTime(), NOW.getTime())).toBe(0);
    // 时钟偏差不该显示成「未来」：负数夹到 0。
    expect(idleDays(new Date('2026-12-01T00:00:00+08:00').getTime(), NOW.getTime())).toBe(0);
  });

  it('时效线是 180 天，且边界归 A（变异：改成 90 → 边界用例同时变红）', () => {
    expect(STALE_DAYS).toBe(180);
    const nowMs = NOW.getTime();
    expect(isFresh(new Date(CUTOFF).getTime(), nowMs)).toBe(true);
    expect(isFresh(new Date(JUST_STALE).getTime(), nowMs)).toBe(false);
  });
});

describe('迁移记账事件不算活动（这条口径的存在理由）', () => {
  /**
   * 反事实：把这个库里真实发生的事**照字面**算一遍。
   *
   * 803 条迁移需求每条都有一条 `requirement.migrated`，写在 2026-11-07。若「任何一条
   * events 行都算活动」，那么这 803 条的最后活动全是 2026-11-07（半年内），于是
   * 195 条无主需求**全部**落进 A，B 桶为空、报告变成一张废纸。这条用例把那个结果
   * 钉死：它必须有 0 条 B —— 这样下一个人想删掉 SQL 里那句 `type <> IMPORT_EVENT_TYPE`
   * 时，会先看见「删掉之后 B 是空的」这件事本身。
   *
   * 变异：把 `lastEventAt` 那一列去掉（SQL 不再过滤）→ 下面的 `stale` 从 2 变 0。
   */
  it('把搬运事件当成活动，B 桶会归零（变异：去掉 SQL 里的类型过滤 → 这条变红）', () => {
    const migratedAt = '2026-11-07T15:48:31+00:00';
    const rows: AuditRow[] = [
      row({ id: 'm1', number: 1, state: 'inbox', stateEnteredAt: '2026-03-12T00:00:00+08:00' }),
      row({ id: 'm2', number: 2, state: 'inbox', stateEnteredAt: '2026-04-03T00:00:00+08:00' }),
    ];

    // 口径内：搬运事件已被剔除（lastEventAt 为 null）→ 两条都是 B，且都是 C。
    const correct = buildAudit({ ownerless: rows, live: asLive(rows), now: NOW });
    expect(correct.buckets).toEqual({ fresh: 0, stale: 2, noEvents: 2 });

    // 反事实：把搬运事件当作活动 → 一条 B 都不剩。
    const naive = buildAudit({
      ownerless: rows.map((item) => ({ ...item, lastEventAt: migratedAt })),
      live: asLive(rows),
      now: NOW,
    });
    expect(naive.buckets).toEqual({ fresh: 2, stale: 0, noEvents: 0 });
  });

  it('被剔除的那个类型就是迁移脚本写的那一条（变异：字符串写错 → 脚本的 SQL 与用例同时失配）', () => {
    expect(IMPORT_EVENT_TYPE).toBe('requirement.migrated');
  });
});

describe('四组交叉', () => {
  const owned: LiveRow = { id: 'o1', number: 900, title: '有主的同题', state: 'inbox' };
  const shipped: LiveRow = { id: 'o2', number: 901, title: '已经在跑的那件事', state: 'live' };

  const rows: AuditRow[] = [
    // 与一条**有主**的行同题
    row({
      id: 'd1', number: 1, state: 'inbox', stateEnteredAt: '2026-01-01T00:00:00+08:00',
      title: '有主的同题', prdUrl: 'https://doc.example/prd', source: '需求挖掘',
      platforms: ['web', 'mobile'],
    }),
    // 与另一条**无主**的行同题（全都没负责人 → 拒绝其中一条不需要裁决）
    row({ id: 'd2', number: 2, state: 'shelved', stateEnteredAt: '2026-01-01T00:00:00+08:00', title: '两个都无主' }),
    row({ id: 'd3', number: 3, state: 'inbox', stateEnteredAt: '2026-01-01T00:00:00+08:00', title: '两个都无主' }),
    // 撞上已上线
    row({ id: 'd4', number: 4, state: 'inbox', stateEnteredAt: '2026-01-01T00:00:00+08:00', title: '已经在跑的那件事' }),
  ];
  const audit = buildAudit({
    ownerless: rows, live: [...asLive(rows), owned, shipped], now: NOW,
  });

  it('PRD：全量与「可动作集」分开数（变异：把终态也计入 actionableWithPrd → 变 2）', () => {
    expect(audit.cross.prd).toEqual({ withPrd: 1, withoutPrd: 3, actionableWithPrd: 1 });
  });

  it('同题：全库组数 ⊇ 含无主行的组数；全无主的组单独标出来（变异：不判 allOwnerless → 该列全「否」）', () => {
    expect(audit.cross.duplicateTitles.totalGroups).toBe(3);
    expect(audit.cross.duplicateTitles.ownerlessRows).toBe(4);
    const groups = audit.cross.duplicateTitles.groups;
    // 排序口径：全无主的组优先，其次组小的优先，再按标题码点。
    expect(groups.map((group) => [group.title, group.ownerlessCount, group.allOwnerless])).toEqual([
      ['两个都无主', 2, true],
      ['已经在跑的那件事', 1, false],
      ['有主的同题', 1, false],
    ]);
  });

  it('来源 null 是「未标注」，不是「其他」；平台按勾选计次（变异：把 [] 算成一个端 → 多一行）', () => {
    expect(audit.cross.source).toEqual([
      { key: '（未标注）', count: 3, stale: 3 },
      { key: '需求挖掘', count: 1, stale: 1 },
    ]);
    const platform = Object.fromEntries(audit.cross.platform.map((item) => [item.key, item.count]));
    expect(platform).toEqual({ '（未标注）': 3, web: 1, mobile: 1 });
  });

  it('撞上已上线：标题全等且**不是自己**（变异：去掉 `id !== row.id` 的自撞判断 → 自己撞自己）', () => {
    expect(audit.cross.shippedAdjacent).toEqual({ count: 1, numbers: [4] });

    // 自己就是已上线（终态）且没有别的同题行 → 不该算「撞上」。
    const selfOnly: AuditRow[] = [
      row({ id: 's1', number: 7, state: 'live', stateEnteredAt: '2026-01-01T00:00:00+08:00', title: '自己就是已上线' }),
    ];
    const selfAudit = buildAudit({
      ownerless: selfOnly,
      live: [{ id: 's1', number: 7, title: '自己就是已上线', state: 'live' }],
      now: NOW,
    });
    expect(selfAudit.cross.shippedAdjacent).toEqual({ count: 0, numbers: [] });
  });

  it('标题归一：只 trim + 压空白，不动大小写与全半角（变异：加 toLowerCase → 键变了）', () => {
    expect(normalizeTitle('  A  b  ')).toBe('A b');
    expect(normalizeTitle('ＡＢＣ')).toBe('ＡＢＣ');
  });
});
