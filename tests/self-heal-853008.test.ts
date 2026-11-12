import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { checkWecomBindings } from '../src/core/notify/self-heal.js';
import { resetDb, seedPeople } from './helpers/db.js';
beforeEach(async () => { await resetDb(); await seedPeople(); });
afterAll(async () => { await pool.end(); });
describe('绑定自检', () => {
  it('853008 三条失败 → 不报「账号没对上」', async () => {
    const m = (await db.execute<{id:string}>(sql`select id from members where name='房超'`)).rows[0]!;
    await db.execute(sql`update members set wecom_userid='u1' where id=${m.id}`);
    for (let i = 1; i <= 3; i += 1) {
      await db.execute(sql`insert into notify_deliveries (member_id, event_seq, channel, status, error)
        values (${m.id}, ${100 + i}, 'wecom', 'failed',
        '这个成员还没和机器人说过话：... 853008')`);
    }
    const alerts = await checkWecomBindings(db, new Date());
    expect(alerts.find((a) => a.memberName === '房超')).toBeUndefined();
  });
  it('真的账号没对上（其它错误）→ 仍然报', async () => {
    const m = (await db.execute<{id:string}>(sql`select id from members where name='赵越'`)).rows[0]!;
    await db.execute(sql`update members set wecom_userid='' , wecom_lookup_at=null where id=${m.id}`);
    for (let i = 1; i <= 3; i += 1) {
      await db.execute(sql`insert into notify_deliveries (member_id, event_seq, channel, status, error)
        values (${m.id}, ${200 + i}, 'wecom', 'skipped', '通讯录里没有这个人')`);
    }
    const alerts = await checkWecomBindings(db, new Date());
    expect(alerts.some((a) => a.memberName === '赵越')).toBe(true);
  });
});
