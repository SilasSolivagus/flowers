import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { restoreRequirement } from '../src/core/requirements/terminal.js';
import { resetDb, seedPeople } from './helpers/db.js';

/**
 * 裁定（2026-11-08）：把过期审计里那 34 条「无主 + 半年没动」的需求**搁置**（`shelved`）。
 *
 * 这一组跑**真迁移文件**（`0028_stale_shelve_batch.sql`），不在用例里重写那套守卫：
 * 迁移文件里的四道核对就是口径本身，抄一份到这里以后两边会分叉，用例只证明「抄的那份对」
 * （与 `ownerless-inbox.test.ts` / `dateless-to-queue.test.ts` / `owner-and-prd-rules.test.ts`
 * 同一条理由）。
 *
 * 钉六件事：
 *
 * 1. **清单没走样**：迁移里写死的 34 组「PAN 号 + id」必须与
 *    `docs/superpowers/plans/2026-11-08-stale-audit.json` 里 `terminal = false` 的那 34 行
 *    逐个相等，且 7 条终态一条都不在里面。改错一个字符、漏一行、把终态抄进来 →
 *    这条用例红；
 * 2. **只动两列**：34 行全部 `state = 'shelved'`、`state_entered_at` 刷成 now()，
 *    其余列（标题 / 类型 / 提出人 / PRD / 平台 / release_id / 三个日期 / skip_reason /
 *    created_at）一个字节都不改；
 * 3. **事件形状与 `shelveRequirement` 一致**：每行**恰好一条** `requirement.shelved`，
 *    `actor = 'system'`，`payload` 里有 `from` / `to` / `reason` / `batch`——前三个键是读侧
 *    真正会读的那三个（`read/detail.ts` 与 `read/notify.ts`），少一个时间轴与通知就哑了；
 * 4. **幂等**：第二遍 `shelved 0 / already 34`，`state_entered_at` 不再被刷一次；
 * 5. **守卫宁可不跑**：有主 / 已软删 / 状态被推走 / 已被别人搁置，四种形状各抛一次错，
 *    而且**整条回滚**（一行都没动、一条事件都没写）；
 * 6. **恢复路径真的能用**：对其中一条按超管走 `restoreRequirement`（无主行的 `edit`
 *    只有超管有，见 `roles.ts` 的 `can()`），它回到 `inbox`；再跑一遍迁移**不会**把它
 *    搁回去——「人否决了这批决定」这件事必须留得住。
 *
 * 为什么不把 `rejected` 也钉一遍：这次裁定明确要 `shelved` 而不是 `rejected`（理由在迁移
 * 文件头与 `docs/superpowers/plans/2026-11-08-stale-shelve.md`）。用例只钉「落的是搁置」，
 * 钉「不是拒绝」的那一条在下面第 3 组里顺手做了（事件类型断言）。
 */

let people: Awaited<ReturnType<typeof seedPeople>> = [];

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

const MIGRATION = '0028_stale_shelve_batch.sql';
const AUDIT_JSON = 'docs/superpowers/plans/2026-11-08-stale-audit.json';

/** 与迁移文件里 `c_reason` 一字不差。改一边不改另一边 → 第 3 组红。 */
const BATCH_REASON = '停 192–241 天且无任何业务活动，按 2026-11-08 过期审计批量搁置';
/** 与迁移文件里 `c_batch` 一字不差。它同时是幂等判据（`payload->>'batch'`）。 */
const BATCH = '2026-11-08-stale-audit';

type Target = { pan: number; id: string };

/** 跑一份迁移文件：按 drizzle 的分隔符切开，逐条执行。 */
async function runMigration(file: string): Promise<void> {
  const text = await readFile(path.join(process.cwd(), 'src/db/migrations', file), 'utf8');
  for (const statement of text.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed !== '') await db.execute(sql.raw(trimmed));
  }
}

/** 迁移里那张写死的清单：`(91, 'uuid'::uuid),   -- PAN-91 · …` 一行一条。 */
async function migrationTargets(): Promise<Target[]> {
  const text = await readFile(path.join(process.cwd(), 'src/db/migrations', MIGRATION), 'utf8');
  return [...text.matchAll(/\((\d+), '([0-9a-f-]{36})'::uuid\)/g)]
    .map((m) => ({ pan: Number(m[1]), id: m[2]! }))
    .sort((a, b) => a.pan - b.pan);
}

type AuditRow = { id: string; number: number; terminal: boolean };

/** 审计那份机器可读的 B 桶（41 行，含 7 条终态）。 */
async function auditRows(): Promise<AuditRow[]> {
  const raw = JSON.parse(await readFile(path.join(process.cwd(), AUDIT_JSON), 'utf8')) as {
    staleRows: AuditRow[];
  };
  return raw.staleRows;
}

/**
 * 直接插一行「无主的收集行」，可选地把它摆成某种形状。
 *
 * 不跑服务：这 34 条真实数据不是服务造成的——它们是 `migrate-flower.ts` 从老系统搬来的
 * （老系统没有负责人、没有 PRD、也没有事件）。走服务也造不出「无主的收集行 + 停 200 天」。
 * 除 `state` / `state_entered_at` 之外的列一律给上显眼的值，这样「只动两列」不是一句话，
 * 是一条能红的断言。
 */
async function seed(row: Target, over: {
  state?: string;
  owner?: string | null;
  deleted?: boolean;
  prdUrl?: string | null;
} = {}): Promise<void> {
  await db.execute(sql`
    insert into requirements (id, number, title, type, requester, state, owner_member_id,
                              prd_url, skip_reason, platforms, state_entered_at, created_at,
                              deleted_at)
    values (${row.id}::uuid, ${row.pan}, ${`审计夹具 PAN-${row.pan}`}, 'feature', '王妍',
            ${over.state ?? 'inbox'}, ${over.owner ?? null}, ${over.prdUrl ?? null},
            ${over.state === undefined ? null : '夹具标记'},
            array['web', 'pc']::text[],
            now() - interval '220 days', '2026-03-12 07:32:56+00'::timestamptz,
            ${over.deleted === true ? sql`now()` : null})`);
}

type SnapRow = Record<string, unknown>;

/** 整行快照（拿掉 `state` / `state_entered_at` 这两列，它们在这次迁移里本就该变）。 */
async function snapshots(): Promise<SnapRow[]> {
  // 软删的行也在快照里：这次迁移不许碰它，"没被碰"同样要被证明。
  const res = await db.execute<SnapRow>(sql`select * from requirements order by number`);
  return res.rows.map((row) => {
    const copy: SnapRow = { ...row };
    delete copy.state;
    delete copy.state_entered_at;
    return copy;
  });
}

type StateRow = { state: string; entered: string };

async function stateOf(id: string): Promise<StateRow> {
  const res = await db.execute<StateRow>(sql`
    select state, state_entered_at::text as entered from requirements where id = ${id}`);
  return res.rows[0]!;
}

type EventRow = {
  requirement_id: string;
  actor: string;
  type: string;
  payload: string;
};

async function shelvedEvents(id: string): Promise<EventRow[]> {
  const res = await db.execute<EventRow>(sql`
    select requirement_id, actor, type, payload
      from events where requirement_id = ${id} and type = 'requirement.shelved'
     order by seq`);
  return res.rows;
}

async function eventCount(): Promise<number> {
  const res = await db.execute<{ n: string }>(sql`select count(*)::text as n from events`);
  return Number(res.rows[0]!.n);
}

describe('清单：迁移里写死的 34 组，就是审计里非终态的那 34 行', () => {
  it('逐个「PAN 号 + id」相等，且 7 条终态一条都不在里面', async () => {
    // 变异：改一个 uuid 字符 / 少抄一行 / 把一条 shelved 或 live 抄进来 → 这里红。
    // 这条用例存在的理由：迁移**不许**在运行期读 JSON（要自洽），所以「抄得对不对」
    // 只剩用例能证明。
    const targets = await migrationTargets();
    const rows = await auditRows();
    const actionable = rows
      .filter((row) => !row.terminal)
      .map((row) => ({ pan: row.number, id: row.id }))
      .sort((a, b) => a.pan - b.pan);

    expect(rows).toHaveLength(41);
    expect(targets).toHaveLength(34);
    expect(targets).toEqual(actionable);

    const terminalIds = new Set(rows.filter((row) => row.terminal).map((row) => row.id));
    for (const target of targets) expect(terminalIds.has(target.id)).toBe(false);
  });
});

describe('批量搁置：34 行 → shelved，只动 state 与 state_entered_at', () => {
  it('34 行全部落进搁置，其余列一个字节都不改', async () => {
    const targets = await migrationTargets();
    // 其中一行带 PRD 链接：真实数据里这 34 条里也有带 PRD 的（审计 cross.prd 那节），
    // 它同样会被搁置——PRD 存在与否不是这次裁定的判据。
    for (const [index, target] of targets.entries()) {
      await seed(target, index === 0 ? { prdUrl: 'https://example.test/prd' } : {});
    }
    const before = await snapshots();
    const enteredBefore = await Promise.all(targets.map((t) => stateOf(t.id)));

    await runMigration(MIGRATION);

    const after = await snapshots();
    const statesAfter = await Promise.all(targets.map((t) => stateOf(t.id)));
    expect(statesAfter.every((row) => row.state === 'shelved')).toBe(true);
    // 除 state / state_entered_at 之外，整行逐字段相等（标题、类型、提出人、PRD、
    // skip_reason、platforms、release_id、三个日期、created_at、deleted_at）。
    expect(after).toEqual(before);
    // `state_entered_at` 真的刷成了 now()：它们今天重新进入了「已搁置」。
    const clock = await db.execute<{ fresh: boolean }>(sql`
      select bool_and(state_entered_at > ${enteredBefore[0]!.entered}::timestamptz
                      and state_entered_at > now() - interval '5 minutes') as fresh
        from requirements`);
    expect(clock.rows[0]!.fresh).toBe(true);
  });

  it('每行恰好一条 requirement.shelved，形状与 shelveRequirement 一致，另加 batch 标记', async () => {
    const targets = await migrationTargets();
    for (const target of targets) await seed(target);

    await runMigration(MIGRATION);

    for (const target of targets) {
      const events = await shelvedEvents(target.id);
      // 「恰好一条」：多一条说明守卫放行了一次重复搁置；少一条说明事件没跟上状态。
      expect(events).toHaveLength(1);
      expect(events[0]!.actor).toBe('system');
      expect(JSON.parse(events[0]!.payload)).toEqual({
        from: 'inbox',
        to: 'shelved',
        reason: BATCH_REASON,
        batch: BATCH,
      });
    }
    // 「落的是搁置，不是拒绝」：事件类型断言在这，库里一条 requirement.rejected 都没有。
    const rejected = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from events where type = 'requirement.rejected'`);
    expect(rejected.rows[0]!.n).toBe('0');
  });

  it('跑第二遍是 no-op：0 行被搁置，事件不增，state_entered_at 不再被刷', async () => {
    const targets = await migrationTargets();
    for (const target of targets) await seed(target);
    await runMigration(MIGRATION);
    const first = await Promise.all(targets.map((t) => stateOf(t.id)));
    const eventsAfterFirst = await eventCount();

    await runMigration(MIGRATION);

    expect(await Promise.all(targets.map((t) => stateOf(t.id)))).toEqual(first);
    expect(await eventCount()).toBe(eventsAfterFirst);
    expect(eventsAfterFirst).toBe(34);
  });
});

describe('守卫：形状不对就抛错，而且整条回滚', () => {
  it('有负责人 → 抛错，一行都没动', async () => {
    const targets = await migrationTargets();
    for (const [index, target] of targets.entries()) {
      await seed(target, index === 0 ? { owner: people[3]!.id } : {});
    }

    await expect(runMigration(MIGRATION)).rejects.toThrow(/已有负责人/);
    // `do` 是一个语句：抛错即全撤。第 1 条之外那 33 条也一条都没被搁置。
    expect(await eventCount()).toBe(0);
    const moved = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from requirements where state = 'shelved'`);
    expect(moved.rows[0]!.n).toBe('0');
  });

  it('状态被推走（不在收集里）→ 抛错', async () => {
    const targets = await migrationTargets();
    for (const [index, target] of targets.entries()) {
      await seed(target, index === 0 ? { state: 'ready' } : {});
    }

    await expect(runMigration(MIGRATION)).rejects.toThrow(/不在收集里/);
    expect(await eventCount()).toBe(0);
  });

  it('已被别人搁置（没有本批标记）→ 抛错，不冒认别人的动作', async () => {
    const targets = await migrationTargets();
    for (const [index, target] of targets.entries()) {
      await seed(target, index === 0 ? { state: 'shelved' } : {});
    }

    await expect(runMigration(MIGRATION)).rejects.toThrow(/已被别的动作搁置/);
    expect(await eventCount()).toBe(0);
  });

  it('已软删 → 抛错', async () => {
    const targets = await migrationTargets();
    for (const [index, target] of targets.entries()) {
      await seed(target, index === 0 ? { deleted: true } : {});
    }

    await expect(runMigration(MIGRATION)).rejects.toThrow(/已软删/);
    expect(await eventCount()).toBe(0);
  });

  it('库里根本没有这行（空库 / 新克隆）→ 不抛错，只把缺的行数报出来', async () => {
    // 空的测试库与新的克隆都没有这 34 行：迁移只能空转（与 0023 的 legacy_ref 查不到即
    // 0 行同一条口径）。有 5 行时，只有那 5 行被搁置。
    const targets = (await migrationTargets()).slice(0, 5);
    for (const target of targets) await seed(target);

    await runMigration(MIGRATION);

    const shelved = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from requirements where state = 'shelved'`);
    expect(shelved.rows[0]!.n).toBe('5');
    expect(await eventCount()).toBe(5);
  });
});

describe('恢复：搁置错了能原路退回，而且迁移不回手', () => {
  it('超管 restore 一条 → 回到收集；再跑迁移不会把它搁回去', async () => {
    const targets = await migrationTargets();
    for (const target of targets) await seed(target);
    await runMigration(MIGRATION);

    const mistake = targets[0]!;
    // 无主行没有条线锚点，`edit` 只有超管有（`roles.ts` 的 `can()`）。房超 = product_owner。
    const out = await restoreRequirement(db, '房超', { requirementId: mistake.id });
    expect(out).toEqual({ state: 'inbox' });
    expect((await stateOf(mistake.id)).state).toBe('inbox');

    // 恢复留下了它自己那条事件（`requirement.restored`），原来的搁置事件仍在——历史不丢。
    const restored = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from events
       where requirement_id = ${mistake.id}::uuid and type = 'requirement.restored'`);
    expect(restored.rows[0]!.n).toBe('1');
    expect(await shelvedEvents(mistake.id)).toHaveLength(1);

    // 再跑一遍：**不会**把它搁回去。"收集 + 已有本批搁置事件" 就是「人否决过」的形状。
    await runMigration(MIGRATION);
    expect((await stateOf(mistake.id)).state).toBe('inbox');
    expect(await shelvedEvents(mistake.id)).toHaveLength(1);
    expect(await eventCount()).toBe(35); // 34 条搁置 + 1 条恢复
  });
});
