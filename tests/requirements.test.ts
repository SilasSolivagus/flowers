import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { AppError } from '../src/core/errors.js';
import { resetDb, seedPeople } from './helpers/db.js';

beforeEach(async () => {
  await resetDb();
  await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

/**
 * 抓取 reject 出来的错误，让调用方同时断言 instance、code、message。
 *
 * 不要退回 `rejects.toThrowError(new AppError('code', '消息'))`：vitest 传实例时
 * 只比较 `.message`，`new Error('同样的消息')` 或换了 code 的 AppError 都会算通过，
 * 而下游服务是按 `e.code` 分支的。
 */
async function caught(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('expected AppError, nothing thrown');
}

async function requirementCount(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`select count(*)::int as n from requirements`);
  return Number(res.rows[0]!.n);
}

describe('createRequirement', () => {
  it('建出来就是 inbox，编号从 1 开始', async () => {
    const r = await createRequirement(db, '吕品', {
      title: 'S3 协议支持', type: 'feature', requester: '孙建宏',
    });
    expect(r.state).toBe('inbox');
    expect(r.number).toBe(1);

    const row = await db.execute<{ state: string; title: string; type: string }>(
      sql`select state, title, type from requirements where id = ${r.id}`,
    );
    expect(row.rows[0]).toMatchObject({ state: 'inbox', title: 'S3 协议支持', type: 'feature' });
  });

  it('每次创建写一条事件', async () => {
    const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    const rows = await db.execute<{ type: string; requirement_id: string; actor: string; payload: string }>(
      sql`select type, requirement_id, actor, payload from events`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      type: 'requirement.created',
      requirement_id: r.id,
      actor: '吕品',
    });
    expect(JSON.parse(rows.rows[0]!.payload)).toMatchObject({
      number: 1, title: 'a', type: 'feature',
    });
  });

  it('类型缺失或不在枚举内都直接拒绝', async () => {
    expect(await caught(createRequirement(db, '吕品', {
      title: 'x', requester: 'y',
    } as never))).toMatchObject({ code: 'invalid', message: '必须选择类型：商业或功能' });

    expect(await caught(createRequirement(db, '吕品', {
      title: 'x', type: 'other', requester: 'y',
    } as never))).toMatchObject({ code: 'invalid', message: '必须选择类型：商业或功能' });

    expect(await requirementCount()).toBe(0);
  });

  it('标题缺失或只有空白都拒绝', async () => {
    expect(await caught(createRequirement(db, '吕品', {
      type: 'feature', requester: 'y',
    } as never))).toMatchObject({ code: 'invalid', message: '标题不能为空' });

    expect(await caught(createRequirement(db, '吕品', {
      title: '   ', type: 'feature', requester: 'y',
    }))).toMatchObject({ code: 'invalid', message: '标题不能为空' });
  });

  it('提出人缺失或只有空白都拒绝', async () => {
    expect(await caught(createRequirement(db, '吕品', {
      title: 'x', type: 'feature',
    } as never))).toMatchObject({ code: 'invalid', message: '提出人不能为空' });

    expect(await caught(createRequirement(db, '吕品', {
      title: 'x', type: 'feature', requester: ' ',
    }))).toMatchObject({ code: 'invalid', message: '提出人不能为空' });
  });

  it('负责人 ID 不是 uuid 就给中文消息', async () => {
    expect(await caught(createRequirement(db, '吕品', {
      title: 'x', type: 'feature', requester: 'y', ownerMemberId: 'abc',
    }))).toMatchObject({ code: 'invalid', message: '负责人 ID 格式不正确' });

    expect(await caught(createRequirement(db, '吕品', {
      title: 'x', type: 'feature', requester: 'y', ownerMemberId: 123,
    }))).toMatchObject({ code: 'invalid', message: '负责人 ID 格式不正确' });
  });

  it.each([null, [], 'str'])('非对象入参 %j 给中文消息', async (body) => {
    expect(await caught(createRequirement(db, '吕品', body))).toMatchObject({
      code: 'invalid', message: '参数不合法',
    });
  });

  it('编号取 max(number)+1，不复用空洞', async () => {
    await db.execute(sql`
      insert into requirements (number, title, type, state, requester)
      values (7, '历史需求', 'feature', 'inbox', '孙建宏')`);

    const a = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    const b = await createRequirement(db, '吕品', { title: 'b', type: 'commercial', requester: 'c' });
    expect([a.number, b.number]).toEqual([8, 9]);

    const rows = await db.execute<{ number: number }>(sql`select number from requirements order by number`);
    expect(rows.rows.map((r) => Number(r.number))).toEqual([7, 8, 9]);
  });

  it('事件写失败时需求也回滚（同一事务）', async () => {
    // 用临时触发器让 events 插入抛错：若需求插入不在同一事务里，它就会留下来。
    // 先 drop：resetDb 只 truncate，被 kill 的旧进程会把触发器留在库里，
    // 之后所有写事件的用例都会撞上 'boom'。
    await db.execute(sql`drop trigger if exists flowers_test_boom on events`);
    await db.execute(sql`
      create or replace function flowers_test_boom() returns trigger as $$
      begin raise exception 'boom'; end $$ language plpgsql`);
    await db.execute(sql`
      create trigger flowers_test_boom before insert on events
      for each row execute function flowers_test_boom()`);
    try {
      let thrown: unknown;
      try {
        await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
      } catch (e) {
        thrown = e;
      }
      // 钉住抛出源：触发器 raise exception 的 P0001 / 'boom'。
      // 不是 AppError 才说明它是从 DB 层穿透出来的——若 createRequirement 提前
      // 校验失败、或 insert 挪到 recordEvent 之后，两个计数同样是 0，这条断言会挂。
      expect(thrown).toMatchObject({ code: 'P0001', message: 'boom' });
      expect(thrown).not.toBeInstanceOf(AppError);

      const reqs = await db.execute<{ n: number }>(sql`select count(*)::int as n from requirements`);
      const events = await db.execute<{ n: number }>(sql`select count(*)::int as n from events`);
      expect(Number(reqs.rows[0]!.n)).toBe(0);
      expect(Number(events.rows[0]!.n)).toBe(0);
    } finally {
      await db.execute(sql`drop trigger if exists flowers_test_boom on events`);
      await db.execute(sql`drop function if exists flowers_test_boom()`);
    }
  });
});
