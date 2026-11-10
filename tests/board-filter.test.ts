import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { db, pool } from '../src/db/client.js';
import { readBoard, getBoard, type BoardView } from '../src/core/read/board.js';
import {
  boardQuery, isFiltered, parseBoardFilter, MAX_Q, NO_FILTER,
} from '../src/core/read/board-filter.js';
import { resetDb, seedPeople } from './helpers/db.js';

/**
 * 看板筛选（`?q=` / `?owner=`）的用例：全部对着真库跑。
 *
 * 为什么不去测一个纯函数：这次要证明的核心事实是**过滤发生在 SQL 里**
 * （列头计数就是被筛的那个数）。把 where 抠成一个纯函数再测，只能证明「我以为的
 * SQL」，而不搜编号、不搜六问这两条**否定**结论更是只能在真数据上问出来——
 * 一条 `where title ilike …` 写漏了 `and`，纯函数测试照样绿。
 *
 * 每条用例对应报告里变异表的一行：把那一行改坏，这一条就必须红。
 */

let people: Array<{ id: string; name: string; role: string }> = [];

beforeEach(async () => {
  // `resetDb` 是 `truncate … restart identity`：`requirements_number_seq` 绑定在
  // number 列上，所以每个用例里编号都从 1 开始——显式写入 PAN-742 不会撞车。
  await resetDb();
  people = await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

function idOf(name: string): string {
  const found = people.find((p) => p.name === name);
  if (!found) throw new Error(`种子里没有成员 ${name}`);
  return found.id;
}

/**
 * 造一条需求：只写读模型要看的那几列，直接 insert。
 *
 * 不走 `createRequirement` 是因为这里的用例要的是**形状**（任意状态、任意负责人、
 * 指定编号、六问里塞一个独特的词），而服务层每一步都带着状态机与权限。读模型只认表。
 */
async function seed(shape: {
  title: string;
  state?: string;
  owner?: string | null;
  number?: number;
  context?: string | null;
  problem?: string | null;
}): Promise<{ id: string; number: number }> {
  const request = shape.number === undefined
    ? db.execute<{ id: string; number: number }>(sql`
        insert into requirements (title, state, requester, owner_member_id, context, problem)
        values (${shape.title}, ${shape.state ?? 'inbox'}, '测试提出人',
                ${shape.owner ?? null}, ${shape.context ?? null}, ${shape.problem ?? null})
        returning id, number`)
    : db.execute<{ id: string; number: number }>(sql`
        insert into requirements (number, title, state, requester, owner_member_id, context, problem)
        values (${shape.number}, ${shape.title}, ${shape.state ?? 'inbox'}, '测试提出人',
                ${shape.owner ?? null}, ${shape.context ?? null}, ${shape.problem ?? null})
        returning id, number`);
  return (await request).rows[0]!;
}

/** 某个状态那一列现在有几张卡（列不在就炸，免得断言读到 undefined 也算通过）。 */
function count(view: BoardView, state: string): number {
  const column = view.columns.find((c) => c.state === state);
  if (!column) throw new Error(`看板没有 ${state} 这一列`);
  return column.cards.length;
}

/** URL 上的两个字符串 → 读模型（与页面走同一条解析）。 */
async function board(raw: Record<string, string>, me = '吕品'): Promise<BoardView> {
  return readBoard(me, parseBoardFilter(raw));
}

describe('?q= 只搜需求标题', () => {
  it('中文子串命中；ASCII 大小写不敏感', async () => {
    const hit = await seed({ title: '风控规则改造' });
    await seed({ title: '分享页改版' });
    await seed({ title: 'S3 协议支持' });

    const zh = await board({ q: '风控' });
    expect(zh.shown).toBe(1);
    expect(zh.columns.flatMap((c) => c.cards).map((c) => c.id)).toEqual([hit.id]);

    // 标题里的 ASCII 也按「子串 + 不分大小写」匹配：搜 s3 能命中 S3。
    expect((await board({ q: 's3' })).shown).toBe(1);
    expect((await board({ q: 'S3' })).shown).toBe(1);
    // 大小写混写同样命中（ILIKE 的那一半价值）。
    expect((await board({ q: '协议' })).shown).toBe(1);
  });

  it('不搜编号：PAN-742 与 742 都是 0 条（owner 裁决，编号搜索是刻意不做的，不是漏了）', async () => {
    const target = await seed({ number: 742, title: '支付宝投诉自动退款' });
    expect(target.number).toBe(742);

    // 「helpful」地给 q 加上 `or r.number = 742` 会让下面两条立刻变绿——
    // 这一格就是拦那次「顺手加一下」的。
    expect((await board({ q: 'PAN-742' })).shown).toBe(0);
    expect((await board({ q: '742' })).shown).toBe(0);
    expect((await board({ q: 'pan-742' })).shown).toBe(0);

    // 同一批数据里，标题搜索仍然正常工作（证明上面是「不搜编号」，不是「什么都搜不到」）。
    expect((await board({ q: '投诉' })).shown).toBe(1);
  });

  it('不搜六问：正文里出现过的词不算命中', async () => {
    await seed({
      title: '导出任务队列改造',
      context: '运营在风控场景下导出名单',
      problem: '风控规则一改就要重新导一次',
    });

    expect((await board({ q: '风控' })).shown).toBe(0);
    expect((await board({ q: '运营' })).shown).toBe(0);
    // 只有标题能被搜到。
    expect((await board({ q: '队列' })).shown).toBe(1);
  });

  it('搜索词里的 % 与 _ 是字面量，不是通配符', async () => {
    await seed({ title: '直链分享限速策略' });
    await seed({ title: '完成度 100% 的走查' });

    expect((await board({ q: '%' })).shown).toBe(1);
    expect((await board({ q: '_' })).shown).toBe(0);
    expect((await board({ q: '100%' })).shown).toBe(1);
  });
});

describe('?owner= 按负责人筛（单选）', () => {
  it('me / none / 具体成员 id 三种都只留该留的', async () => {
    const mine = await seed({ title: '我的需求', owner: idOf('吕品') });
    const others = await seed({ title: '王妍的需求', owner: idOf('王妍') });
    const nobody = await seed({ title: '没人的需求', owner: null });

    const asMine = await board({ owner: 'me' }, '吕品');
    expect(asMine.shown).toBe(1);
    expect(asMine.columns.flatMap((c) => c.cards)[0]!.id).toBe(mine.id);

    const asNone = await board({ owner: 'none' });
    expect(asNone.shown).toBe(1);
    expect(asNone.columns.flatMap((c) => c.cards)[0]!.id).toBe(nobody.id);

    const asWang = await board({ owner: idOf('王妍') });
    expect(asWang.shown).toBe(1);
    expect(asWang.columns.flatMap((c) => c.cards)[0]!.id).toBe(others.id);

    // 「me」跟着当前成员走，换个人看同一块板子是另一组。
    expect((await board({ owner: 'me' }, '王妍')).shown).toBe(1);
    expect((await board({ owner: 'me' }, '房超')).shown).toBe(0);
  });

  it('owner 与 q 同时生效（AND，不是两个筛选各显示一遍）', async () => {
    await seed({ title: '风控规则改造', owner: null });
    await seed({ title: '风控误判申诉', owner: idOf('王妍') });
    await seed({ title: '分享页改版', owner: null });

    const both = await board({ q: '风控', owner: 'none' });
    expect(both.shown).toBe(1);
    expect(both.columns.flatMap((c) => c.cards)[0]!.title).toBe('风控规则改造');
  });
});

describe('列头计数跟着筛选走', () => {
  it('收集列的 cards.length 等于筛后条数，不是全量条数', async () => {
    // 收集列三条，其中两条标题带「风控」；另有一条已上线的也带「风控」。
    await seed({ title: '风控规则改造' });
    await seed({ title: '风控误判申诉' });
    await seed({ title: '分享页改版' });
    await seed({ title: '风控看板', state: 'live' });

    const all = await board({});
    expect(count(all, 'inbox')).toBe(3);
    expect(count(all, 'live')).toBe(1);
    expect(all.total).toBe(4);

    const filtered = await board({ q: '风控' });
    // 关键断言：收集列是 2，不是 3（筛后的数，不是这张表的全量）。
    expect(count(filtered, 'inbox')).toBe(2);
    expect(count(filtered, 'live')).toBe(1);
    expect(filtered.shown).toBe(3);
    // 分母不动：全库还是 4 条，被筛掉的只是分子。
    expect(filtered.total).toBe(4);
  });

  it('筛空时十列都还在，计数全是 0，不崩', async () => {
    await seed({ title: '分享页改版' });
    await seed({ title: 'S3 协议支持', state: 'test' });

    const empty = await board({ q: '一个不可能存在的词' });
    expect(empty.columns.map((c) => c.state)).toEqual([
      'inbox', 'design', 'review', 'queue', 'ready', 'dev', 'test', 'live', 'rejected', 'shelved',
    ]);
    expect(empty.columns.every((c) => c.cards.length === 0)).toBe(true);
    expect(empty.columns.map((c) => c.label)).toContain('收集');
    expect(empty.shown).toBe(0);
    expect(empty.total).toBe(2);
  });
});

describe('URL 解析：坏值退回「不筛」', () => {
  it('认不出的 owner 一律当成 all（手改的 URL 不会 500）', async () => {
    await seed({ title: '分享页改版', owner: null });
    await seed({ title: 'S3 协议支持', owner: idOf('吕品') });

    for (const bad of ['', ' ', 'ALL', 'everyone', '__proto__', '42', '%E4%B8', 'null', 'true']) {
      const filter = parseBoardFilter({ owner: bad });
      expect(filter.owner.kind).toBe('all');
      // 不只解析对，实际读一遍也得是整块板子（把坏值交给 ::uuid 会在这里炸）。
      expect((await readBoard('吕品', filter)).shown).toBe(2);
    }
  });

  it('合法的 uuid 形状照收（认不出的成员得到的是空板，不是静默的 all）', async () => {
    await seed({ title: '分享页改版' });
    const ghost = '00000000-0000-4000-8000-000000000000';
    const filter = parseBoardFilter({ owner: ghost });
    expect(filter.owner).toEqual({ kind: 'member', id: ghost });
    const view = await readBoard('吕品', filter);
    expect(view.shown).toBe(0);
    expect(view.total).toBe(1);
  });

  it('同名参数取第一个；q 去空白并截断；空 q = 不筛', () => {
    expect(parseBoardFilter({ q: ['风控', '退款'] }).q).toBe('风控');
    expect(parseBoardFilter({ q: '  风控  ' }).q).toBe('风控');
    expect(parseBoardFilter({ q: '   ' }).q).toBe('');
    expect(parseBoardFilter({ q: 'x'.repeat(MAX_Q + 50) }).q).toHaveLength(MAX_Q);
    expect(isFiltered(parseBoardFilter({}))).toBe(false);
    expect(isFiltered(parseBoardFilter({ q: '风控' }))).toBe(true);
    expect(isFiltered(parseBoardFilter({ owner: 'none' }))).toBe(true);
  });

  it('boardQuery 只写非默认值（默认状态是一条干净的 /）', () => {
    expect(boardQuery(NO_FILTER)).toBe('');
    expect(boardQuery(parseBoardFilter({ q: '风控', owner: 'all' }))).toBe('q=%E9%A3%8E%E6%8E%A7');
    expect(boardQuery(parseBoardFilter({ q: 'a b', owner: 'none' }))).toBe('q=a%20b&owner=none');
    expect(boardQuery(parseBoardFilter({ q: '', owner: 'me' }))).toBe('owner=me');
  });
});

describe('过滤发生在 SQL 里', () => {
  it('发出的 SQL 自带 where（标题 ilike / 无主 is null），且返回行数 = 卡片数', async () => {
    await seed({ title: '风控规则改造', owner: null });
    await seed({ title: '风控误判申诉', owner: null });
    await seed({ title: '分享页改版', owner: idOf('王妍') });

    const dialect = new PgDialect();
    const spy = vi.spyOn(db, 'execute');
    let view: BoardView;
    try {
      view = await readBoard('吕品', parseBoardFilter({ q: '风控', owner: 'none' }));
      // 第一发是 readBoard 内部查「我是谁」（`memberByName`），看板那条要按形状挑：
      // 它认 requirements 这张表。
      const boardCall = spy.mock.calls
        .map((call) => dialect.sqlToQuery(call[0] as SQL))
        .find((one) => one.sql.includes('from requirements r'));
      expect(boardCall).toBeDefined();
      const emitted = boardCall!;
      // 两条条件都在**语句里**——不是取回全表再在 JS 里 filter（那种实现下这两行
      // 会出现在一个 `select *` 之上，而 params 里也不会带 `%风控%`）。
      expect(emitted.sql).toContain('r.title ilike');
      expect(emitted.sql).toContain('r.owner_member_id is null');
      expect(emitted.sql).toContain('and');
      expect(emitted.params).toContain('%风控%');
    } finally {
      spy.mockRestore();
    }

    expect(view!.shown).toBe(2);
    // 这条才是「没有把没筛的行读进内存」的证词：SQL 返回的行数就是筛后的行数。
    expect(view!.scanned).toBe(view!.shown);
    expect(view!.total).toBe(3);
  });

  it('不筛时 getBoard 仍然只给十列（旧签名不变）', async () => {
    await seed({ title: '分享页改版' });
    const columns = await getBoard('吕品');
    expect(columns).toHaveLength(10);
    expect(columns.flatMap((c) => c.cards)).toHaveLength(1);
  });
});

/**
 * 时间范围（2026-11-10）：默认不显示「已上线超过 90 天」的历史。
 *
 * 库里的实测分布是 265 条已上线、其中 207 条停在那儿超过 90 天——全部摊在板子上，
 * 最左边几列就没人看了。这一组钉三件事：默认藏、`?scope=all` 放出来、
 * 其余九列**不受影响**（收的只是「发完很久、没人再看」的那一批，不是所有老数据）。
 */
describe('window: 已上线超过 90 天的默认不显示', () => {
  /** 把一条需求「钉」到某个进入状态的时间上（`seed` 只写形状，时间由这里改）。 */
  async function backdate(id: string, days: number): Promise<void> {
    await db.execute(sql`
      update requirements set state_entered_at = now() - make_interval(days => ${days})
       where id = ${id}`);
  }

  it('90 天前的已上线默认不显示，10 天前的显示；scope=all 两条都出来', async () => {
    const old = await seed({ title: '去年发的那个功能', state: 'live' });
    await backdate(old.id, 120);
    const fresh = await seed({ title: '上周刚上线', state: 'live' });
    await backdate(fresh.id, 10);

    const active = await board({});
    expect(count(active, 'live')).toBe(1);
    expect(active.shown).toBe(1);
    // 分母跟着范围走：「筛出 1 / 1」读得通，而不是「1 / 2」。
    expect(active.total).toBe(1);

    const all = await board({ scope: 'all' });
    expect(count(all, 'live')).toBe(2);
    expect(all.total).toBe(2);
  });

  it('其余九列不受影响：收集里停了一年的条目照旧显示', async () => {
    const stale = await seed({ title: '提了但没人立项', state: 'inbox' });
    await backdate(stale.id, 400);

    expect(count(await board({}), 'inbox')).toBe(1);
    // 默认范围下 total 就是 1——这条规则只对 live 生效。
    expect((await board({})).total).toBe(1);
  });

  it('URL 解析：scope=all 才是含历史，其余（空串 / active / 垃圾值）都是默认', async () => {
    expect(parseBoardFilter({ scope: 'all' }).scope).toBe('all');
    expect(parseBoardFilter({ scope: 'active' }).scope).toBe('active');
    expect(parseBoardFilter({ scope: '' }).scope).toBe('active');
    // 手改坏了的 URL 不该把 200 张历史卡放出来。
    expect(parseBoardFilter({ scope: 'ALL ' }).scope).toBe('active');
    expect(parseBoardFilter({ scope: '1' }).scope).toBe('active');
  });

  it('URL 往返：默认范围不写进 URL，含历史才写 scope=all', () => {
    expect(boardQuery({ q: '', owner: { kind: 'all' }, scope: 'active' })).toBe('');
    expect(boardQuery({ q: '', owner: { kind: 'all' }, scope: 'all' })).toBe('scope=all');
    // 与搜索词一起出现时顺序固定：q、owner、scope。
    expect(boardQuery({ q: '风控', owner: { kind: 'me' }, scope: 'all' }))
      .toBe('q=%E9%A3%8E%E6%8E%A7&owner=me&scope=all');
  });
});
