import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import {
  GROUP_EVENT_TYPES, KIND_EVENTS, pendingGroupEvents, renderEventMessage,
  type GroupEventItem,
} from '../src/core/notify/group.js';
import type { Release } from '../src/core/read/version.js';
import {
  activeReleases, dueToday, releaseText, todayInShanghai, versionCard, workdaysBetween,
} from '../src/core/read/version-daily.js';
import { resetDb, seedPeople } from './helpers/db.js';

/**
 * 群播报（2026-11-10）。
 *
 * 版式是**逐字对着 Flower 群里原来那几条**定的（owner 的要求是「一模一样」），
 * 所以这一组连 `<font color=…>` 的位置都在断言里：那不是样式细节，是那条消息的形状。
 *
 * 两条口径各一组：
 * 1. **状态变动**：一条事件一条消息，抬头彩色事件名 + 灰产品名、加粗链接、状态变化行、
 *    灰底「谁 · 什么时候」；台账按 `evt:<seq>` 去重。
 * 2. **版本每日进展**：一张 `template_card`，字段与 Flower 的概览卡片同序同义。
 */

let people: Array<{ id: string; name: string; role: string }> = [];

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

const BASE = 'http://localhost:3000';
const ID = '00000000-0000-0000-0000-000000000001';

function item(over: Partial<GroupEventItem> & { type: string }): GroupEventItem {
  return {
    seq: 1, actor: '吕品', requirementId: ID, number: 742, title: '权益套餐产品结构改造',
    payload: { from: 'review', to: 'queue' }, requester: '王妍',
    at: '2026-11-10T10:40:00+08:00',
    ...over,
  };
}

describe('状态变动：一条事件一条消息，版式与 Flower 一致', () => {
  it('四行结构：彩色事件名 + 灰产品名 / 加粗链接 / 状态变化 / 灰底署名', () => {
    const text = renderEventMessage(item({ type: 'requirement.review_passed' }), BASE)!;
    const lines = text.split('\n');

    expect(lines[0]).toBe('<font color="info">评审通过</font><font color="comment"> · 123云盘</font>');
    expect(lines[1]).toBe(`**[PAN-742 权益套餐产品结构改造](${BASE}/?open=${ID})**`);
    // 旧值灰、新值彩色；「状态」与旧值之间是全角空格（Flower 的模板就是这样）。
    expect(lines[2]).toBe('> 状态　<font color="comment">待评审</font> → <font color="info">待排期</font>');
    // 末行：谁 · 什么时候（MM-DD HH:mm，上海）。
    expect(lines[3]).toBe('<font color="comment">吕品 · 11-10 10:40</font>');
    expect(lines).toHaveLength(4);
  });

  it('八种事件各有各的抬头与颜色（坏消息 warning、进展 info）', () => {
    const tone = (type: string) => /^<font color="(\w+)">/.exec(renderEventMessage(item({ type }), BASE)!)![1];
    const label = (type: string) => /^<font color="\w+">([^<]+)</.exec(renderEventMessage(item({ type }), BASE)!)![1];

    expect(label('requirement.owner_assigned')).toBe('需求认领');
    expect(label('requirement.evaluated')).toBe('立项');
    expect(label('requirement.review_requested')).toBe('提交评审');
    expect(label('requirement.review_passed')).toBe('评审通过');
    expect(label('requirement.rejected')).toBe('需求拒绝');
    expect(label('requirement.shelved')).toBe('需求搁置');
    expect(label('requirement.auto_live')).toBe('版本上线 · 待验收');
    expect(label('requirement.rolled_back')).toBe('回滚');

    expect(tone('requirement.review_passed')).toBe('info');
    expect(tone('requirement.auto_live')).toBe('info');
    expect(tone('requirement.evaluated')).toBe('info');
    expect(tone('requirement.rejected')).toBe('warning');
    expect(tone('requirement.shelved')).toBe('warning');
    expect(tone('requirement.rolled_back')).toBe('warning');
    expect(tone('requirement.owner_assigned')).toBe('comment');
  });

  it('认领变的是负责人，不是状态：第二段写「负责人」', () => {
    const text = renderEventMessage(item({
      type: 'requirement.owner_assigned', payload: { from: null, to: '吕品' },
    }), BASE)!;
    expect(text).toContain('> 负责人　');
    expect(text).not.toContain('> 状态');
  });

  it('原因单独一行；已上线上再补一行「请提出人验收」', () => {
    const shelved = renderEventMessage(item({
      type: 'requirement.shelved', payload: { reason: '这版不做' },
    }), BASE)!;
    expect(shelved).toContain('> 这版不做');

    const live = renderEventMessage(item({ type: 'requirement.auto_live', actor: 'system' }), BASE)!;
    expect(live).toContain('> 请提出人 王妍 验收');
    expect(live).toContain('系统 · ');
  });

  it('认不出的类型返回 null（不发一句空话）', () => {
    expect(renderEventMessage(item({ type: 'requirement.updated' }), BASE)).toBeNull();
    expect(renderEventMessage(item({ type: 'requirement.created' }), BASE)).toBeNull();
  });
});

describe('去重：一条事件只播一次', () => {
  async function seedEvent(type: string, title = '权益套餐产品结构改造'): Promise<number> {
    const req = (await db.execute<{ id: string }>(sql`
      insert into requirements (title, state, requester) values (${title}, 'queue', '吕品')
      returning id`)).rows[0]!;
    const ev = (await db.execute<{ seq: number }>(sql`
      insert into events (requirement_id, actor, type, payload)
      values (${req.id}, '吕品', ${type}, '{"from":"review","to":"queue"}'::jsonb)
      returning seq`)).rows[0]!;
    return Number(ev.seq);
  }

  it('没播过 → 出现；台账记了 evt:<seq> → 不再出现', async () => {
    const seq = await seedEvent('requirement.review_passed');
    expect((await pendingGroupEvents(db)).map((row) => row.seq)).toContain(seq);

    await db.execute(sql`
      insert into group_posts (kind, ref, content, status)
      values (${KIND_EVENTS}, ${`evt:${seq}`}, 'x', 'sent')`);
    expect((await pendingGroupEvents(db)).map((row) => row.seq)).not.toContain(seq);
  });

  it('水位之前的事件不补播；不在八种里的不进来；软删的不进来', async () => {
    const older = await seedEvent('requirement.review_passed', '水位之前');
    await db.execute(sql`insert into events (requirement_id, actor, type, payload)
      select requirement_id, '吕品', 'requirement.updated', '{}'::jsonb from events where seq = ${older}`);
    const kept = await seedEvent('requirement.auto_live');

    const rows = await pendingGroupEvents(db, 10, older);
    expect(rows.map((r) => r.seq)).toContain(kept);
    expect(rows.map((r) => r.seq)).not.toContain(older);

    await db.execute(sql`update requirements set deleted_at = now()
      where id = (select requirement_id from events where seq = ${kept})`);
    expect((await pendingGroupEvents(db, 10, older)).map((r) => r.seq)).not.toContain(kept);
  });
});

describe('版本每日进展：一张 template_card，字段与 Flower 的概览卡片同序', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const today = todayInShanghai(new Date('2026-11-10T12:00:00+08:00'));

  function release(over: Partial<Release> & { name: string; releaseDate: string }): Release {
    const { name, releaseDate, ...rest } = over;
    return {
      id: name, name,
      windowStart: '2026-11-01T00:00:00+08:00', windowStartLabel: '11-01',
      releaseDate, releaseDateLabel: releaseDate.slice(5, 10),
      timeUsed: 60, inFlight: 0, shipped: 0, late: 0, goal: null, note: null,
      requirements: [],
      ...rest,
    };
  }

  function req(number: number, state: string, due: string | null, late = false) {
    return {
      id: `r${number}`, number, title: `需求${number}`, state: state as never,
      stateLabel: state, commitTestAt: null, testAtLabel: null,
      commitDueAt: due, dueAtLabel: due === null ? null : due.slice(5, 10), days: 2, late,
    };
  }

  it('只播「发版日在过去 7 天到未来 45 天」的版本', () => {
    const list = [
      release({ name: '刚发完', releaseDate: '2026-11-05T00:00:00+08:00' }),
      release({ name: '正在做', releaseDate: '2026-11-24T00:00:00+08:00' }),
      release({ name: '远古', releaseDate: '2026-09-01T00:00:00+08:00' }),
      release({ name: '太远', releaseDate: '2027-03-01T00:00:00+08:00' }),
    ];
    expect(activeReleases(list, today).map((r) => r.name)).toEqual(['刚发完', '正在做']);
  });

  it('卡片字段：标题带 MM-DD、辅助信息带发版日与剩余工作日、关键数据是进度、三项统计', () => {
    const r = release({
      name: '2026.11',
      releaseDate: '2026-11-24T00:00:00+08:00',
      requirements: [
        req(1, 'live', '2026-11-05T00:00:00+08:00'),
        req(2, 'dev', '2026-11-10T00:00:00+08:00'),
        req(3, 'test', '2026-11-08T00:00:00+08:00', true),
      ],
      inFlight: 2, shipped: 1, late: 1,
    });

    const { card } = versionCard(r, today, BASE);
    expect(card.title).toBe('123云盘 研发日报 · 11-10');
    expect(card.desc).toBe('2026.11 · 11/24 发版 · 还剩 10 个工作日');
    expect(card.emphasis).toEqual({ title: '33%', desc: '整体进度（理论 60%）' });
    expect(card.stats).toEqual([
      { keyname: '需求', value: '3 项' },
      { keyname: '已上线', value: '1 项' },
      { keyname: '遗留下期', value: '1 项' },
    ]);
    expect(card.quote?.title).toBe('需要关注');
    expect(card.quote?.quote_text).toContain('延期 PAN-3');
    expect(card.quote?.quote_text).toContain('今日到点 PAN-2');
    // 有延期 → source 用橙红（2）；没有延期那一版用绿（3）。
    expect(card.source).toEqual({ desc: 'Flower · 研发日报', desc_color: 2 });
    expect(card.jumps.map((j) => j.title)).toEqual(['查看甘特', '需求列表']);
    expect(card.action.url).toBe(`${BASE}/releases`);
  });

  it('没有到点也没有延期时，引用区整块不出现（不是空字符串）', () => {
    const r = release({ name: '2026.12', releaseDate: '2026-12-01T00:00:00+08:00' });
    const { card } = versionCard(r, today, BASE);
    expect(card.quote).toBeNull();
    expect(card.source.desc_color).toBe(3);
  });

  it('发版日三句话：今天 / 已过 / 还剩几个工作日（只排除周末）', () => {
    expect(releaseText('2026-11-10T00:00:00+08:00', today)).toBe('今天发版');
    expect(releaseText('2026-11-01T00:00:00+08:00', today)).toBe('已过发版日');
    // 11-10 周二 → 11-24 周二：中间 10 个工作日（11-14/15、21/22 是周末）。
    expect(workdaysBetween(today, today + 14)).toBe(10);
    expect(dueToday(release({
      name: 'x', releaseDate: '2026-11-24T00:00:00+08:00',
      requirements: [req(1, 'live', '2026-11-10T00:00:00+08:00'), req(2, 'dev', '2026-11-10T00:00:00+08:00')],
    }), today)).toEqual([2]);
  });
});
