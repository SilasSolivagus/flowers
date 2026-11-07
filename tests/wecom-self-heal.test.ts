import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { resetDb, seedPeople, type SeededPerson } from './helpers/db.js';
import { activeMemberByName } from '../src/core/auth/members.js';
import { saveNotifyChannels } from '../src/core/members/manage.js';
import { notificationsFor } from '../src/core/read/notify.js';
import { tickThenDispatch } from '../src/core/notify/dispatch.js';
import {
  EVENT_MEMBER_WECOM_UNLINKED, FAILED_STREAK, checkWecomBindings,
} from '../src/core/notify/self-heal.js';
import type { Runner } from '../src/core/notify/wecom.js';

/**
 * P2「企微绑定自愈」：**绑不上的人，要有人知道。**
 *
 * 这一组用例钉的不是「有没有发一条通知」这一件事，而是四条互相独立的规则：
 *
 * 1. **谁收到**：只有超管（能去点「查一下」的人），PM 与条线负责人收不到。
 * 2. **一天一条**：同一天跑两次还是一条；第二天再跑是第二条（否则「提醒」会变成
 *    「一辈子一条」——第一天被忽略之后就永远不再提）。
 * 3. **关掉的人不打扰**：`wecom: 'off'` 是「我不要」，不是「我收不到」。替人报这种
 *    警等于不听话，而且会把超管的铃铛变成一台坏掉的打印机。
 * 4. **两类坏法都认**：从没绑上（`wecom_userid is null`）与绑过但最近几条都发不出去
 *    （连着 `FAILED_STREAK` 条没有一条 `sent`）。
 *
 * 覆盖的不是 mock：`tickThenDispatch` 是 cron 真正调的那个入口，`notificationsFor` 是
 * 铃铛真正用的那个读模型。中间只有一件东西被换掉——企微 CLI（注入的 runner），
 * 否则用例会真的去敲网络。
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

/** 企微 CLI 的替身：联系人查询一律「查无此人」，发送一律成功（这两件事本组不关心）。 */
function fakeRunner(): Runner {
  return async (_bin, argv) => ({
    exitCode: 0,
    timedOut: false,
    spawnError: null,
    stdout: JSON.stringify(argv[0] === 'contact'
      ? { users: [], users_count: 0 }
      : { success: true }),
    stderr: '',
  });
}

/** 库里的成员行（含 `notify_prefs` 与 `wecom_userid` 的当前值）。 */
async function fresh(name: string) {
  const row = await activeMemberByName(db, name);
  if (row === null) throw new Error(`名册里没有 ${name}`);
  return row;
}

/** 某人铃铛里那几条成员级提醒（按 seq 升序）。 */
async function alertsOf(name: string) {
  const member = await fresh(name);
  const notices = await notificationsFor(db, member, { limit: 50 });
  return notices.filter((notice) => notice.type === EVENT_MEMBER_WECOM_UNLINKED);
}

/** 直接读账本：这类事件一共几条（不经过读模型的扇出，用来数「写了几条」）。 */
async function alertRows(): Promise<Array<{ name: string; payload: string }>> {
  const res = await db.execute<{ payload: string }>(sql`
    select payload from events where type = ${EVENT_MEMBER_WECOM_UNLINKED} order by seq`);
  return res.rows.map((row) => ({
    name: (JSON.parse(row.payload) as { memberName?: string }).memberName ?? '',
    payload: row.payload,
  }));
}

describe('从没绑上：给超管一条站内提醒', () => {
  it('一次 tick 之后，超管铃铛里有一条，点得出是谁、要他做什么；PM 收不到', async () => {
    // 注意这里不依赖任何一条推送成功：自检只写事件（`result.summary.sent === 0`），
    // 「发现坏了」与「发得出去」是两件独立的事——一个坏掉的通道不该把报警也一起吞掉。
    const result = await tickThenDispatch(db, new Date(), { run: fakeRunner() });

    const written = result.alerts.map((alert) => alert.memberName).sort();
    // 名册七个人都没绑过企微，所以七条（每人一条，不是每条需求一条）。
    expect(written).toEqual(people.map((person) => person.name).sort());

    const adminAlerts = await alertsOf(ADMIN);
    const names = adminAlerts.map((notice) => notice.line);
    expect(names.some((line) => line.includes(`「${PM}」`))).toBe(true);
    // 文案必须说清下一步：点「查一下」是设置页上那个按钮的名字。
    expect(adminAlerts.every((notice) => notice.line.includes('查一下'))).toBe(true);
    // 成员级提醒没有需求可挂：编号与标题都是空的，页面据此不去开抽屉。
    expect(adminAlerts.every((notice) => notice.requirementId === null)).toBe(true);
    expect(result.summary.sent).toBe(0);

    // PM 自己收不到自己的报警（他不是「能去点查一下」的人）。
    expect(await alertsOf(PM)).toEqual([]);
  });

  it('同一天跑两次：还是一条（不会每轮 tick 都提醒一次）', async () => {
    const now = new Date();
    await tickThenDispatch(db, now, { run: fakeRunner() });
    const afterFirst = (await alertRows()).length;

    const second = await tickThenDispatch(db, now, { run: fakeRunner() });

    expect(second.alerts).toEqual([]);
    expect((await alertRows()).length).toBe(afterFirst);
    const mine = (await alertsOf(ADMIN)).filter((notice) => notice.line.includes(`「${PM}」`));
    expect(mine).toHaveLength(1);
  });

  it('第二天再跑：第二条（一天一条，不是一辈子一条）', async () => {
    const now = new Date();
    await tickThenDispatch(db, now, { run: fakeRunner() });

    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await tickThenDispatch(db, tomorrow, { run: fakeRunner() });

    const rows = (await alertRows()).filter((row) => row.name === PM);
    expect(rows).toHaveLength(2);
  });

  it('企微档位是 off 的人不报警：关掉是他不要，不是他收不到', async () => {
    await saveNotifyChannels(db, PM, { wecom: 'off' });

    const result = await tickThenDispatch(db, new Date(), { run: fakeRunner() });

    expect(result.alerts.map((alert) => alert.memberName)).not.toContain(PM);
    expect((await alertRows()).filter((row) => row.name === PM)).toEqual([]);
  });

  it('dry-run 不写提醒：预览的语义是「什么都不改」', async () => {
    const result = await tickThenDispatch(db, new Date(), { dryRun: true, run: fakeRunner() });

    expect(result.alerts).toEqual([]);
    expect(await alertRows()).toEqual([]);
  });
});

/** 给一个人造 N 条投递记录（`event_seq` 只是序号，不建外键）。 */
async function seedDeliveries(
  name: string, statuses: Array<'sent' | 'failed' | 'skipped'>, startSeq = 1,
): Promise<void> {
  let seq = startSeq;
  for (const status of statuses) {
    await db.execute(sql`
      insert into notify_deliveries (member_id, event_seq, channel, status, error)
      values (${idOf(name)}, ${seq}, 'wecom', ${status}, null)`);
    seq += 1;
  }
}

describe('绑过但发不出去：连续几条都没成也报警', () => {
  it(`最近 ${FAILED_STREAK} 条没有一条 sent → 一条提醒，文案说清是「都没发出去」`, async () => {
    // 有 userid（所以不走「从没绑上」那一条），但最近的投递全是 failed / skipped。
    await db.execute(sql`
      update members set wecom_userid = 'u-lvpin' where id = ${idOf(PM)}`);
    await seedDeliveries(PM, ['failed', 'failed', 'skipped']);

    const alerts = await checkWecomBindings(db, new Date());

    const mine = alerts.find((alert) => alert.memberName === PM);
    expect(mine).toMatchObject({ reason: 'failing', streak: FAILED_STREAK });
    const notice = (await alertsOf(ADMIN)).find((row) => row.line.includes(`「${PM}」`));
    expect(notice?.line).toContain('没发出去');
  });

  it('中间夹着一条 sent 就不报：通道是通的，那是偶发抖动', async () => {
    await db.execute(sql`
      update members set wecom_userid = 'u-lvpin' where id = ${idOf(PM)}`);
    // 倒序取最近三条 = failed, sent, failed → 有三条记录但不构成「连续」。
    await seedDeliveries(PM, ['failed', 'sent', 'failed']);

    const alerts = await checkWecomBindings(db, new Date());

    expect(alerts.map((alert) => alert.memberName)).not.toContain(PM);
  });

  it('投递记录不足三条也不报：还没攒够证据', async () => {
    await db.execute(sql`
      update members set wecom_userid = 'u-lvpin' where id = ${idOf(PM)}`);
    await seedDeliveries(PM, ['failed', 'failed']);

    const alerts = await checkWecomBindings(db, new Date());

    expect(alerts.map((alert) => alert.memberName)).not.toContain(PM);
  });
});
