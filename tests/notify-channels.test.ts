import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { resetDb, seedPeople, type SeededPerson } from './helpers/db.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { clockTransitions } from '../src/core/state-machine.js';
import {
  CLASSES, EVENT_CLASS, allows, classOf, knownTypes, typesOfLevel, type EventClass,
} from '../src/core/notify/classes.js';
import {
  CHANNELS, DEFAULT_PREFS, LEVELS, prefsJson, prefsOf, type Level,
} from '../src/core/notify/prefs.js';
import { saveNotifyChannels } from '../src/core/members/manage.js';
import { activeMemberByName } from '../src/core/auth/members.js';
import {
  notificationsFor, notifyView, pendingDeliveries, unreadCount,
} from '../src/core/read/notify.js';

/**
 * P4-07：**事件分三类 × 两个频道 × 三档**。
 *
 * 这一组用例钉三件互相独立的事：
 *
 * 1. **映射是穷举的**。事件类型不是一张手写的清单，而是从源码里 `recordEvent` 的
 *    每一个 `type` 字面量扫出来的，再加上时钟由 `TRANSITIONS` 派生出来的
 *    `requirement.auto_<state>`。扫出来的集合与 `EVENT_CLASS` 的键**必须相等**：
 *    新加一个事件类型却忘了分类，这条用例就红。
 * 2. **九格矩阵**。`off` / `key` / `all` × action / outcome / change，逐格断言。
 * 3. **两个频道各读各的档位，而且 feed 与红点同源**。站内 `off` 而企微 `all` 是
 *    合法组合：铃铛空、推送照发。红点（`unreadCount`）与列表（`notificationsFor`）
 *    在每一档上都必须给出同一个数——它们共用 `addressed` 那一条谓词。
 */

let people: SeededPerson[] = [];

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

const ADMIN = '房超';
const PM = '吕品';

function idOf(name: string): string {
  const found = people.find((person) => person.name === name);
  if (found === undefined) throw new Error(`名册里没有 ${name}`);
  return found.id;
}

/** 从库里重新读一行（`notify_prefs` 是行上的列，内存里那份会过期）。 */
async function fresh(name: string) {
  const row = await activeMemberByName(db, name);
  if (row === null) throw new Error(`名册里没有 ${name}`);
  return row;
}

// ─── 1. 映射是穷举的 ────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname, '..');

/** `src` / `app` / `scripts` / `mcp` 下的全部 .ts / .tsx（不碰 node_modules 与 .next）。 */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  for (const dir of ['src', 'app', 'scripts', 'mcp']) walk(path.join(ROOT, dir));
  return out;
}

/**
 * 源码里真实写下的事件类型。
 *
 * 两个模式，对应两种写法：
 * - `type: 'requirement.created'`——`recordEvent` 的调用点（17 处）；
 * - `EVENT_PRD_FETCHED = 'prd.fetched'`——常量式的那个。
 *
 * 再加时钟那三个：`tick.ts` 写的是 `` `requirement.auto_${edge.to}` ``，字面量里没有
 * 完整类型，而边来自 `TRANSITIONS`——所以从表里派生，而不是把三个名字抄一遍。
 */
function scannedEventTypes(): string[] {
  const patterns = [
    /\btype:\s*'([a-z]+\.[a-z_.]+)'/g,
    /\bEVENT_[A-Z_]+\s*=\s*'([a-z]+\.[a-z_.]+)'/g,
  ];
  const found = new Set<string>();
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        if (match[1] !== undefined) found.add(match[1]);
      }
    }
  }
  for (const edge of clockTransitions()) found.add(`requirement.auto_${edge.to}`);
  return [...found].sort();
}

describe('事件 → 类：表必须穷举', () => {
  it('源码里每一个事件类型都恰好有一个类，表里也没有多余的行', () => {
    const scanned = scannedEventTypes();
    const mapped = knownTypes().sort();
    expect(scanned).toEqual(mapped);

    // 每个值都得是三个类之一；一个类型只能出现一次（Record 的键天然唯一，
    // 这里钉的是「没有哪个类被写成一个新词」）。
    for (const type of mapped) {
      expect(CLASSES).toContain(EVENT_CLASS[type]);
    }
    // 三个类都不是空的：一个空类会让某一档静默地少收一整批事件。
    for (const cls of CLASSES) {
      expect(mapped.filter((type) => classOf(type) === cls).length).toBeGreaterThan(0);
    }
  });

  it('三类各自收谁：动手 / 结果 / 变动', () => {
    // 抽样钉住产品口径里最容易被改错的几个。
    expect(classOf('requirement.review_requested')).toBe('action'); // 等我签字
    expect(classOf('requirement.evaluated')).toBe('action');       // 等我出 PRD
    expect(classOf('requirement.review_passed')).toBe('outcome');  // 评审通过
    expect(classOf('requirement.shelved')).toBe('outcome');        // 搁置
    expect(classOf('requirement.bounced')).toBe('outcome');        // 打回开发
    expect(classOf('requirement.created')).toBe('change');         // 新建
    expect(classOf('requirement.owner_assigned')).toBe('change');  // 换负责人 / 认领
    expect(classOf('requirement.updated')).toBe('change');         // 描述更新
    // 未登记的类型按 change 兜底，不抛（库里可能有更早版本写下的类型）。
    expect(classOf('requirement.something_new')).toBe('change');
  });
});

// ─── 2. 九格矩阵 ────────────────────────────────────────────────────────────

describe('档位 × 类：九格', () => {
  const expected: Record<Level, Record<EventClass, boolean>> = {
    all: { action: true, outcome: true, change: true },
    key: { action: true, outcome: true, change: false },
    off: { action: false, outcome: false, change: false },
  };

  for (const level of LEVELS) {
    for (const cls of CLASSES) {
      it(`${level} × ${cls} → ${expected[level][cls]}`, () => {
        expect(allows(level, cls)).toBe(expected[level][cls]);
      });
    }
  }

  it('拼 SQL 用的类型清单与逐格结论一致', () => {
    const all = typesOfLevel('all');
    expect(all).toBeNull(); // null = 不加条件
    expect(typesOfLevel('off')).toEqual([]);
    const key = typesOfLevel('key');
    expect(key).not.toBeNull();
    expect(key!.every((type) => allows('key', classOf(type)))).toBe(true);
    expect(key!.some((type) => classOf(type) === 'change')).toBe(false);
    // 三类里每一类都在 key 的清单里出现过一次判断（避免「清单是空数组也过」）
    expect(key!.length).toBeGreaterThan(0);
  });
});

// ─── 3. 两个频道各读各的档位；feed 与红点同源 ──────────────────────────────

/**
 * 一条需求 + 三条事件（每类一条），观众是超管（扇出：收全部，且排除自己的动作）。
 *
 * 用直接 insert 而不是走服务：这一层要测的是**读侧的分类与档位**，而「一条事件
 * 该不该产生」已经由服务层与 P4-03 的用例钉过了。actor 写别人，扇出才会计入。
 */
async function threeClasses(owner = PM): Promise<{ requirementId: string; types: string[] }> {
  const created = await createRequirement(db, owner, {
    title: '导出任务队列', type: 'feature', requester: '孙建宏',
  });
  const types = ['requirement.evaluated', 'requirement.review_passed', 'requirement.updated'];
  for (const type of types) {
    await db.execute(sql`
      insert into events (requirement_id, actor, type, payload)
      values (${created.id}, '王妍', ${type}, '{}')`);
  }
  return { requirementId: created.id, types };
}

function typesOf(notices: Array<{ type: string }>): string[] {
  return notices.map((notice) => notice.type);
}

describe('站内 feed 按档位过滤，红点与列表同一个数', () => {
  it('off：空 feed、0 未读、铃铛该藏起来（档位就是那个判据）', async () => {
    await threeClasses();
    await saveNotifyChannels(db, ADMIN, { site: 'off' });
    const admin = await fresh(ADMIN);

    expect(await notificationsFor(db, admin)).toEqual([]);
    expect(await unreadCount(db, admin)).toBe(0);
    expect(await notifyView(db, admin)).toEqual({ notices: [], unread: 0 });
  });

  it('key：只收动手与结果；change 那两条（created / updated）不在', async () => {
    const made = await threeClasses();
    await saveNotifyChannels(db, ADMIN, { site: 'key' });
    const admin = await fresh(ADMIN);

    const notices = await notificationsFor(db, admin);
    const types = typesOf(notices);
    expect(types).toContain('requirement.evaluated');
    expect(types).toContain('requirement.review_passed');
    expect(types).not.toContain('requirement.updated');
    expect(types).not.toContain('requirement.created');
    expect(made.types).toHaveLength(3);

    // 「红点 3 条、点开只有 2 条」这类分叉的唯一防法是同一个数：
    const view = await notifyView(db, admin);
    expect(view.notices).toHaveLength(2);
    expect(view.unread).toBe(2);
    expect(view.unread).toBe(view.notices.filter((notice) => notice.unread).length);
    expect(await unreadCount(db, admin)).toBe(2);
  });

  it('all：三类都进 feed，红点等于事件总数', async () => {
    await threeClasses();
    await saveNotifyChannels(db, ADMIN, { site: 'all' });
    const admin = await fresh(ADMIN);

    const notices = await notificationsFor(db, admin);
    // created + 三条（evaluated / review_passed / updated）
    expect(notices).toHaveLength(4);
    expect(typesOf(notices)).toEqual(expect.arrayContaining([
      'requirement.created', 'requirement.evaluated', 'requirement.review_passed',
      'requirement.updated',
    ]));
    const view = await notifyView(db, admin);
    expect(view.unread).toBe(4);
    expect(view.unread).toBe(view.notices.length);
    expect(await unreadCount(db, admin)).toBe(4);
    expect(await unreadCount(db, admin))
      .toBe((await notificationsFor(db, admin, { limit: 200 })).length);
  });

  it('两个频道互不影响：站内 off + 企微 all 是合法组合', async () => {
    await threeClasses();
    await saveNotifyChannels(db, ADMIN, { site: 'off', wecom: 'all' });
    const admin = await fresh(ADMIN);

    // 铃铛空
    expect(await notificationsFor(db, admin)).toEqual([]);
    // 推送那边三类都在，而且不看站内水位线（这里一条都没读过）
    const candidates = await pendingDeliveries(db, admin, { channel: 'wecom', limit: 50 });
    expect(candidates).toHaveLength(4);
    expect(new Set(candidates.map((candidate) => candidate.cls))).toEqual(
      new Set(['action', 'outcome', 'change']),
    );
  });

  it('企微 key 档：候选只有动手与结果', async () => {
    await threeClasses();
    await saveNotifyChannels(db, ADMIN, { site: 'all', wecom: 'key' });
    const admin = await fresh(ADMIN);

    const candidates = await pendingDeliveries(db, admin, { channel: 'wecom', limit: 50 });
    expect(candidates.map((candidate) => candidate.type).sort()).toEqual([
      'requirement.evaluated', 'requirement.review_passed',
    ]);
  });

  it('企微 off 档：一条候选都没有（但站内照旧）', async () => {
    await threeClasses();
    await saveNotifyChannels(db, ADMIN, { site: 'all', wecom: 'off' });
    const admin = await fresh(ADMIN);

    expect(await pendingDeliveries(db, admin, { channel: 'wecom', limit: 50 })).toEqual([]);
    expect((await notificationsFor(db, admin)).length).toBe(4);
  });

  it('企微候选取最旧的（升序），站内 feed 取最新的（倒序）', async () => {
    await threeClasses();
    await saveNotifyChannels(db, ADMIN, { site: 'all', wecom: 'all' });
    const admin = await fresh(ADMIN);

    const candidates = await pendingDeliveries(db, admin, { channel: 'wecom', limit: 50 });
    const seqs = candidates.map((candidate) => candidate.eventSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    const notices = await notificationsFor(db, admin);
    const feedSeqs = notices.map((notice) => notice.eventSeq);
    expect(feedSeqs).toEqual([...feedSeqs].sort((a, b) => b - a));
  });
});

// ─── 4. 口味的解析：坏数据回落，老的形状能被读懂 ────────────────────────────

describe('notify_prefs 的解析', () => {
  it('null / 空串 / 坏 JSON / 不是对象 → 默认（两个频道都是 key）', async () => {
    expect(prefsOf(null)).toEqual(DEFAULT_PREFS);
    expect(prefsOf('')).toEqual(DEFAULT_PREFS);
    expect(prefsOf('{')).toEqual(DEFAULT_PREFS);
    expect(prefsOf('[]')).toEqual(DEFAULT_PREFS);
    expect(DEFAULT_PREFS).toEqual({ site: 'key', wecom: 'key' });
  });

  it('认不出的值逐格回落 key，缺的频道也回落 key', () => {
    expect(prefsOf('{"site":"sometimes"}')).toEqual({ site: 'key', wecom: 'key' });
    expect(prefsOf('{"site":"all"}')).toEqual({ site: 'all', wecom: 'key' });
    expect(prefsOf('{"wecom":"off"}')).toEqual({ site: 'key', wecom: 'off' });
    expect(prefsOf('{"site":null,"wecom":3}')).toEqual({ site: 'key', wecom: 'key' });
  });

  it('P4-03 的老形状：全关 → 两个频道 off；其余 → 默认 key', () => {
    expect(prefsOf('{"inherit":false,"changed":false,"rejected":false}'))
      .toEqual({ site: 'off', wecom: 'off' });
    expect(prefsOf('{"inherit":false,"changed":true,"rejected":false}'))
      .toEqual({ site: 'key', wecom: 'key' });
    expect(prefsOf('{"inherit":true}')).toEqual({ site: 'key', wecom: 'key' });
  });

  it('写回的字符串形状固定，且能被读回来', async () => {
    const saved = await saveNotifyChannels(db, PM, { site: 'all', wecom: 'off' });
    expect(prefsJson(saved.prefs)).toBe('{"site":"all","wecom":"off"}');
    const stored = await db.execute<{ notify_prefs: string }>(sql`
      select notify_prefs from members where id = ${idOf(PM)}`);
    expect(prefsOf(stored.rows[0]?.notify_prefs)).toEqual({ site: 'all', wecom: 'off' });
  });

  it('渠道常量就是那两个（报告与界面都读它们）', () => {
    expect([...CHANNELS]).toEqual(['site', 'wecom']);
  });
});
