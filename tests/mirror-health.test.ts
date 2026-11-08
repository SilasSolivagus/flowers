import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { resetDb, seedPeople, type SeededPerson } from './helpers/db.js';
import {
  MIRROR_STALE_DAYS, checkMirrorFreshness, judgeMirror, recordMirrorHealth,
} from '../src/core/codemirror/health.js';
import { notificationsFor, pendingDeliveries } from '../src/core/read/notify.js';
import { todayInShanghai } from '../src/core/locate/copy.js';
import { EVENT_CLASS, classOf } from '../src/core/notify/classes.js';
import type { Member } from '../src/core/auth/roles.js';

/**
 * 镜像变旧 → 一条主动通知（0031 + `core/codemirror/health.ts`）。
 *
 * 这一组用例钉的是**触发规则**，不是实现细节，所以顺序按「判定表」排：
 *
 * | 行 | 库里的状态 | 期望 |
 * |---|---|---|
 * | 1 | `ok = false`（有 HEAD 日期 + 原因） | 一条，正文含原因；同一天再跑仍是一条 |
 * | 2 | 健康，HEAD 8 天前 | 一条，**不含**「上次同步失败」 |
 * | 3 | 健康，HEAD 6 天前 | 没有 |
 * | 4 | 健康，HEAD 正好 7 天前 | 没有（门槛是 `> 7`） |
 * | 5 | `mirror_health` 里**没有**这个仓 | 一条（按「未知」报），再跑仍是一条 |
 * | 6 | 两个仓同时旧 | 两条（去重按仓，不是全局一条） |
 * | 7 | 失败且没读到 HEAD | 正文说「从来没有同步成功过」 |
 * | 8 | 一次失败写回（`headSha: null`） | 上一次已知的 sha / 日期**不丢** |
 * | 9 | 扇出 | 只有超管收；企微候选是同一批（同一个 `addressed`） |
 *
 * 日期全部相对「今天（Asia/Shanghai）」算：写死 2026-11 的叙事会在那一天之后逐条腐烂，
 * 而代码一行没错（与 `read.test.ts` / `notify.test.ts` 同一条理由）。
 */

let people: SeededPerson[] = [];

/** 与用例里的「今天」同步：判据用的是上海日历日，不是 UTC。 */
const TODAY = todayInShanghai(new Date());
/** 通知口味：`site: all` + 企微也开（第 9 行要验企微候选是同一批）。 */
function prefsAll(): string {
  return JSON.stringify({ site: 'all', wecom: 'all' });
}

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
});

afterEach(async () => {
  // `mirror_health` 不在 `RESET_TABLES` 里（与 `blob_index` 同一个理由：它存的是真实镜像
  // 的状态，重建要重跑一次夜间同步）。所以**泄漏由这一组用例自己收口**：只删 `fixture-`
  // 前缀的那几行，真仓的行一个字都不碰。
  await db.execute(sql`delete from mirror_health where repo like 'fixture-%'`);
});

afterAll(async () => {
  await pool.end();
});

// ─── 素材 ────────────────────────────────────────────────────────────────────

/** 上海日历日往回推 N 天的那个**时刻**（10:00 +08:00，任意稳定时刻就够）。 */
function isoDaysAgo(days: number): string {
  const base = new Date(`${TODAY}T10:00:00+08:00`).getTime();
  return new Date(base - days * 86_400_000).toISOString();
}

/** 同一个时刻的上海日历日（`YYYY-MM-DD`），用来断言正文里那个日期。 */
function dayAgo(days: number): string {
  return todayInShanghai(new Date(isoDaysAgo(days)));
}

function member(name: string): Member {
  const found = people.find((person) => person.name === name);
  if (found === undefined) throw new Error(`种子里没有成员 ${name}`);
  return { ...found, notifyPrefs: prefsAll() };
}

const ADMIN = '房超';
const PM = '吕品';

/** 库里的 `mirror.stale` 事件（按 seq 升序）。 */
async function staleEvents(): Promise<Array<{ seq: number; payload: Record<string, unknown> }>> {
  const res = await db.execute<{ seq: number; payload: string }>(sql`
    select seq, payload from events where type = 'mirror.stale' order by seq asc`);
  return res.rows.map((row) => ({ seq: Number(row.seq), payload: JSON.parse(row.payload) }));
}

/** 超管铃铛里那些镜像提醒的正文（一行一句）。 */
async function adminLines(): Promise<string[]> {
  const notices = await notificationsFor(db, member(ADMIN));
  return notices.filter((notice) => notice.type === 'mirror.stale').map((notice) => notice.line);
}

// ─── 1~5：触发规则（判定表） ─────────────────────────────────────────────────

describe('触发规则：ok / 天数 / 未知', () => {
  it('ok = false → 一条，正文带失败原因；同一天再跑仍是一条', async () => {
    const repo = 'fixture-failed';
    await recordMirrorHealth(db, {
      repo, headSha: 'a'.repeat(40), headDate: isoDaysAgo(19), ok: false,
      // 原因走 `clip(…, 40)`（铃铛只有一行）：这里用一个短到能完整显示的原因，
      // 断言的才是「正文里真的带着那句话」而不是被截断的半截。
      error: 'Could not resolve host: codeup',
    });

    const first = await checkMirrorFreshness(db, { repos: [repo], now: new Date() });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ repo, days: 19, reason: 'failed' });

    // 同一天第二次（launchd 重跑、或人手工再跑一次）不该再来一条。
    const second = await checkMirrorFreshness(db, { repos: [repo], now: new Date() });
    expect(second).toEqual([]);
    expect(await staleEvents()).toHaveLength(1);

    expect(await adminLines()).toEqual([
      `${repo} 的镜像停在 ${dayAgo(19)}（19 天前），上次同步失败：Could not resolve host: codeup`,
    ]);
  });

  it('健康但 8 天前 → 一条，且**不写**「上次同步失败」这一截', async () => {
    const repo = 'fixture-old';
    await recordMirrorHealth(db, {
      repo, headSha: 'b'.repeat(40), headDate: isoDaysAgo(8), ok: true, error: null,
    });

    const alerts = await checkMirrorFreshness(db, { repos: [repo], now: new Date() });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ repo, days: 8, error: null, reason: 'old' });

    const [line] = await adminLines();
    expect(line).toBe(`${repo} 的镜像停在 ${dayAgo(8)}（8 天前），上游这段时间没有新提交`);
    // 判据是**提交日期**，不是同步成不成：同步是成功的，说成失败会让人去修一个没坏的东西。
    expect(line).not.toContain('上次同步失败');
  });

  it('健康且 6 天前 → 没有', async () => {
    const repo = 'fixture-fresh';
    await recordMirrorHealth(db, {
      repo, headSha: 'c'.repeat(40), headDate: isoDaysAgo(6), ok: true, error: null,
    });
    expect(await checkMirrorFreshness(db, { repos: [repo], now: new Date() })).toEqual([]);
    expect(await staleEvents()).toEqual([]);
  });

  it('正好 7 天 → 没有（门槛是 严格大于 7，与材料那句「较旧」同一个习惯）', async () => {
    const repo = 'fixture-day7';
    await recordMirrorHealth(db, {
      repo, headSha: 'd'.repeat(40), headDate: isoDaysAgo(MIRROR_STALE_DAYS), ok: true, error: null,
    });
    expect(await checkMirrorFreshness(db, { repos: [repo], now: new Date() })).toEqual([]);

    // 第 8 天越线：同一条行、只把日期往前挪一天。
    await recordMirrorHealth(db, {
      repo, headSha: 'd'.repeat(40), headDate: isoDaysAgo(MIRROR_STALE_DAYS + 1), ok: true, error: null,
    });
    const alerts = await checkMirrorFreshness(db, { repos: [repo], now: new Date() });
    expect(alerts.map((alert) => alert.days)).toEqual([MIRROR_STALE_DAYS + 1]);
  });

  it('表里没有这个仓 → 按「未知」报一条（不跳过），再跑仍是一条', async () => {
    const repo = 'fixture-never-recorded';
    const first = await checkMirrorFreshness(db, { repos: [repo], now: new Date() });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ repo, headDate: null, days: null, reason: 'unknown' });

    expect(await adminLines()).toEqual([
      `${repo} 的镜像还没有同步记录——夜间索引可能一次都没跑成`,
    ]);
    expect(await checkMirrorFreshness(db, { repos: [repo], now: new Date() })).toEqual([]);
  });

  it('两个仓同时旧 → 两条（去重按仓，不是全局一条）', async () => {
    for (const repo of ['fixture-a', 'fixture-b']) {
      await recordMirrorHealth(db, {
        repo, headSha: 'e'.repeat(40), headDate: isoDaysAgo(10), ok: true, error: null,
      });
    }
    const alerts = await checkMirrorFreshness(db, {
      repos: ['fixture-a', 'fixture-b'], now: new Date(),
    });
    expect(alerts.map((alert) => alert.repo).sort()).toEqual(['fixture-a', 'fixture-b']);
    expect(await staleEvents()).toHaveLength(2);
  });

  it('失败且一次都没读到 HEAD → 正文说「从来没有同步成功过」', async () => {
    const repo = 'fixture-never-ok';
    await recordMirrorHealth(db, {
      repo, headSha: null, headDate: null, ok: false, error: 'ssh: connect to host dogyun port 22',
    });
    await checkMirrorFreshness(db, { repos: [repo], now: new Date() });
    expect(await adminLines()).toEqual([
      `${repo} 的镜像从来没有同步成功过，上次同步失败：ssh: connect to host dogyun port 22`,
    ]);
  });
});

// ─── 8：写入口的两个语义 ─────────────────────────────────────────────────────

describe('按仓阈值：清单那张表接在 checkMirrorFreshness 上', () => {
  it('同一个 400 天前的仓，阈值 365 时无声、never 时无声、默认 7 天时一条', async () => {
    const repo = 'fixture-archived';
    await recordMirrorHealth(db, {
      repo, headSha: 'b'.repeat(40), headDate: isoDaysAgo(400), ok: true, error: null,
    });
    // 默认（不给表）：400 天远过 7 天。
    expect(await checkMirrorFreshness(db, { repos: [repo], now: new Date() })).toHaveLength(1);
    await db.execute(sql`delete from events where (payload::jsonb ->> 'repo') = ${repo}`);

    // 阈值 365：仍然报（400 > 365），说明表真的被用上了，而不是被忽略。
    expect(await checkMirrorFreshness(db, {
      repos: [repo], now: new Date(), staleAfterDays: { [repo]: 365 },
    })).toHaveLength(1);
    await db.execute(sql`delete from events where (payload::jsonb ->> 'repo') = ${repo}`);

    // 阈值 500：不报了。
    expect(await checkMirrorFreshness(db, {
      repos: [repo], now: new Date(), staleAfterDays: { [repo]: 500 },
    })).toEqual([]);

    // `never`（清单里的 null）：也不报——但下一格证明它不吞失败。
    expect(await checkMirrorFreshness(db, {
      repos: [repo], now: new Date(), staleAfterDays: { [repo]: null },
    })).toEqual([]);

    // 同一个仓、同一个 never 阈值，同步坏掉时照样一条。
    await recordMirrorHealth(db, {
      repo, headSha: 'b'.repeat(40), headDate: isoDaysAgo(400), ok: false, error: 'HTTP 000',
    });
    const alerts = await checkMirrorFreshness(db, {
      repos: [repo], now: new Date(), staleAfterDays: { [repo]: null },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ repo, reason: 'failed', error: 'HTTP 000' });
  });
});

describe('写入口：失败不抹掉上一次已知的 HEAD', () => {
  it('headSha / headDate 传 null 时保留旧值，只把 ok / error 刷成本轮', async () => {
    const repo = 'fixture-keep';
    const head = isoDaysAgo(19);
    await recordMirrorHealth(db, {
      repo, headSha: 'f'.repeat(40), headDate: head, ok: true, error: null,
    });
    // 第二天 ssh 连不上：head() 什么都拿不到。
    await recordMirrorHealth(db, {
      repo, headSha: null, headDate: null, ok: false, error: 'Could not resolve host',
    });

    const row = await db.execute<{
      head_sha: string; head_date: string; ok: boolean; error: string;
    }>(sql`select head_sha, head_date, ok, error from mirror_health where repo = ${repo}`);
    expect(row.rows[0]!.head_sha).toBe('f'.repeat(40));
    expect(new Date(row.rows[0]!.head_date).getTime()).toBe(new Date(head).getTime());
    expect(row.rows[0]!.ok).toBe(false);
    expect(row.rows[0]!.error).toBe('Could not resolve host');

    // 有了保留的日期，正文才能说出「停在哪天」——那是这一半的全部用途。
    const [line] = await adminLinesAfterCheck(repo);
    expect(line).toContain(`的镜像停在 ${dayAgo(19)}（19 天前）`);
  });

  it('成功写回时覆盖成新的 sha / 日期', async () => {
    const repo = 'fixture-forward';
    await recordMirrorHealth(db, {
      repo, headSha: '1'.repeat(40), headDate: isoDaysAgo(20), ok: true, error: null,
    });
    await recordMirrorHealth(db, {
      repo, headSha: '2'.repeat(40), headDate: isoDaysAgo(1), ok: true, error: null,
    });
    const row = await db.execute<{ head_sha: string }>(
      sql`select head_sha from mirror_health where repo = ${repo}`,
    );
    expect(row.rows[0]!.head_sha).toBe('2'.repeat(40));
    // 前进之后就不再报：判的是 HEAD 日期，不是「曾经旧过」。
    expect(await checkMirrorFreshness(db, { repos: [repo], now: new Date() })).toEqual([]);
  });
});

async function adminLinesAfterCheck(repo: string): Promise<string[]> {
  await checkMirrorFreshness(db, { repos: [repo], now: new Date() });
  return adminLines();
}

// ─── 判据本身的纯函数（不连库也能逐格钉住） ─────────────────────────────────

describe('judgeMirror：判定表', () => {
  const today = '2026-11-08';

  it('四种状态各给一条（或 null）', () => {
    const row = (ok: boolean, headDate: string | null, error: string | null = null) => ({
      repo: 'r', head_sha: 'abc', head_date: headDate, ok, error,
    });
    // 失败：哪怕有日期也报（`days` 用来写正文）。
    expect(judgeMirror({ repo: 'r', row: row(false, '2026-10-21T10:00:00+08:00', 'boom'), today }))
      .toMatchObject({ reason: 'failed', days: 18, error: 'boom' });
    // 健康且旧。
    expect(judgeMirror({ repo: 'r', row: row(true, '2026-10-31T10:00:00+08:00'), today }))
      .toMatchObject({ reason: 'old', days: 8, error: null });
    // 健康且新。
    expect(judgeMirror({ repo: 'r', row: row(true, '2026-11-02T10:00:00+08:00'), today })).toBeNull();
    // 第 7 天不报。
    expect(judgeMirror({ repo: 'r', row: row(true, '2026-11-01T10:00:00+08:00'), today })).toBeNull();
    // 未知。
    expect(judgeMirror({ repo: 'r', row: null, today })).toMatchObject({ reason: 'unknown' });
  });

  it('按仓阈值：只放宽「上游不动了」那一条，同步失败照报', () => {
    const today = '2026-11-08';
    const old8 = { repo: 'r', head_sha: 'abc', head_date: '2026-10-31T10:00:00+08:00', ok: true, error: null };
    // 8 天前在默认 7 天下会报；给 365 天就不报了。
    expect(judgeMirror({ repo: 'r', row: old8, today })).toMatchObject({ reason: 'old' });
    expect(judgeMirror({ repo: 'r', row: old8, today, staleAfterDays: 365 })).toBeNull();
    // 超过阈值仍然报（阈值不是静音）。
    expect(judgeMirror({ repo: 'r', row: old8, today, staleAfterDays: 7 }))
      .toMatchObject({ reason: 'old', days: 8 });
    // `null` = never（清单里的 never）：1254 天也不报。
    const ancient = { ...old8, head_date: '2023-06-04T10:00:00+08:00' };
    expect(judgeMirror({ repo: 'r', row: ancient, today })).toMatchObject({ reason: 'old' });
    expect(judgeMirror({ repo: 'r', row: ancient, today, staleAfterDays: null })).toBeNull();
    // **这条是这一格存在的边界**：never 只静音「旧」，不静音「坏」。
    const broken = { repo: 'r', head_sha: 'abc', head_date: '2023-06-04T10:00:00+08:00', ok: false, error: 'HTTP 000' };
    expect(judgeMirror({ repo: 'r', row: broken, today, staleAfterDays: null }))
      .toMatchObject({ reason: 'failed', error: 'HTTP 000' });
    // 表里没有这一行也不受阈值影响（从没跑过 = 静默失败，按未知报）。
    expect(judgeMirror({ repo: 'r', row: null, today, staleAfterDays: null }))
      .toMatchObject({ reason: 'unknown' });
  });
});

// ─── 9：扇出 ────────────────────────────────────────────────────────────────

describe('扇出：只有超管收，且两个频道同一批', () => {
  it('超管看到、PM 看不到；企微候选里也有同一条', async () => {
    const repo = 'fixture-fanout';
    await recordMirrorHealth(db, {
      repo, headSha: '9'.repeat(40), headDate: isoDaysAgo(19), ok: false, error: 'HTTP 000',
    });
    await checkMirrorFreshness(db, { repos: [repo], now: new Date() });

    const admin = member(ADMIN);
    expect((await notificationsFor(db, admin)).filter((n) => n.type === 'mirror.stale')).toHaveLength(1);
    // 成员级 / 全局级提醒不发给 PM，也不发给条线负责人——它不属于任何条线。
    expect((await notificationsFor(db, member(PM))).filter((n) => n.type === 'mirror.stale')).toEqual([]);

    // 企微候选与铃铛共用同一个 `addressed`：推什么必须恰好是铃铛里会出现的那一批。
    const candidates = await pendingDeliveries(db, admin, { channel: 'wecom', limit: 50 });
    const mirror = candidates.filter((candidate) => candidate.type === 'mirror.stale');
    expect(mirror).toHaveLength(1);
    expect(mirror[0]!.requirementId).toBeNull();
    expect(mirror[0]!.headline).toBe('镜像新鲜度提醒');
    expect(mirror[0]!.sentence).toBe(
      `${repo} 的镜像停在 ${dayAgo(19)}（19 天前），上次同步失败：HTTP 000`,
    );
  });
});

// ─── 事件分类 ───────────────────────────────────────────────────────────────

describe('事件分类', () => {
  it('mirror.stale 登记为 action（默认档 key 也要能看到它）', () => {
    expect(EVENT_CLASS['mirror.stale']).toBe('action');
    expect(classOf('mirror.stale')).toBe('action');
  });
});