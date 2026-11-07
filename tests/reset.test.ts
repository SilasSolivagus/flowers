import { afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import {
  KEPT_TABLES, RESET_TABLES,
  assertNoMigratedRequirements, assertSafeToReset, countMigratedRequirements,
  resetDb, resetRefusal, shouldAllowReset, truncateMembersOnly,
} from '../src/db/reset.js';
import { DEMO_DATABASE, TEST_DATABASE, resolveDatabaseUrl, withDatabase } from '../src/db/url.js';

afterAll(async () => {
  await pool.end();
});

/**
 * I8：`resetDb` 是 truncate 八张表的硬操作，而 `scripts/demo.ts` / `scripts/seed.ts`
 * 尊重 `DATABASE_URL`。守卫的两个条件就在这里钉死：库名是 flowers，或显式设了
 * `FLOWERS_ALLOW_RESET=1`。
 */
describe('resetDb 的守卫（脚本口径）', () => {
  it('库名不是 flowers 时必须显式放行', () => {
    expect(shouldAllowReset('flowers', undefined)).toBe(true);
    expect(shouldAllowReset('flowers', '0')).toBe(true);
    expect(shouldAllowReset('flowers_prod', undefined)).toBe(false);
    expect(shouldAllowReset('flowers_prod', '0')).toBe(false);
    expect(shouldAllowReset('flowers_prod', 'true')).toBe(false);
    // 只有字符串 '1' 才算放行：'true' / 'yes' / 空串都不该被当成同意。
    expect(shouldAllowReset('flowers_prod', '1')).toBe(true);
  });

  it('问的是库自己（current_database()），不是环境变量', async () => {
    // 用例跑在测试库上，守卫应当放行并把库名交回来给脚本打印。
    await expect(assertSafeToReset()).resolves.toBe(TEST_DATABASE);
  });
});

/**
 * P0 的另一半：**测试进程只许清测试库**。
 *
 * 这几条比脚本口径更严——不看 `FLOWERS_ALLOW_RESET`。理由写在 reset.ts 里：
 * 那个口子是给手工脚本清演示库用的，测试若能用它去清 `flowers`，
 * 「配置指错 → 演示数据被截断」这条事故就又回来了。
 */
describe('resetDb 的守卫（测试口径）', () => {
  const asTest = { VITEST: 'true' };

  it('flowers_test 放行，演示库不放行', () => {
    expect(shouldAllowReset('flowers_test', undefined, asTest)).toBe(true);
    // 同一个名字，非测试进程里当然也放行——差别只在下面的 flowers。
    expect(shouldAllowReset('flowers', undefined, asTest)).toBe(false);
    expect(shouldAllowReset('flowers', '1', asTest)).toBe(false);
    expect(shouldAllowReset('flowers', '1', { NODE_ENV: 'test' })).toBe(false);
    // 自建测试库（TEST_DATABASE_URL）只要名字带 _test 就放行。
    expect(shouldAllowReset('flowers_test_ci', '0', asTest)).toBe(true);
    expect(shouldAllowReset('flowers_p410', undefined, asTest)).toBe(false);
  });

  it('拒绝时点名 TEST_DATABASE_URL 与 db:test:setup', () => {
    const reason = resetRefusal('flowers', undefined, asTest);
    expect(reason).toContain('演示库');
    expect(reason).toContain(TEST_DATABASE);
    expect(reason).toContain('TEST_DATABASE_URL');
    expect(reason).toContain('npm run db:test:setup');
    expect(resetRefusal('flowers_test', undefined, asTest)).toBeNull();
    expect(resetRefusal('flowers', undefined, {})).toBeNull();
  });

  it('resetDb 自己就守：被拒绝时一张表都不清（演示库那套数据不受影响）', async () => {
    // 这行的价值：守卫从「只放在脚本里」挪进了 resetDb 本身。以前用例无条件重置
    // 是安全的（连的就是 flowers），现在用例换库了，若还有人不带守卫地重置一次，
    // 指错库就等于一次静默的数据销毁。
    await db.execute(sql`insert into members (name, email, role, line) values ('哨兵','sentinel@x.test','pm',null)`);
    await expect(resetDb({ guardDatabase: 'flowers', env: asTest })).rejects.toThrow(/TEST_DATABASE_URL/);
    const left = await db.execute<{ n: number }>(sql`select count(*)::int as n from members where name = '哨兵'`);
    expect(left.rows[0]?.n).toBe(1);
    await resetDb();
  });

  it('resetDb 清的是测试库，并把它自己的库名交回来', async () => {
    await db.execute(sql`insert into members (name, email, role, line) values ('待清','wipe@x.test','pm',null)`);
    await expect(resetDb()).resolves.toBe(TEST_DATABASE);
    const left = await db.execute<{ n: number }>(sql`select count(*)::int as n from members`);
    expect(left.rows[0]?.n).toBe(0);
  });
});

// ─── 本轮（数据守卫）新增：迁移数据不许被一条命令带走 ─────────────────────────

/** 子进程：`src/db/client.ts` 在 import 时就把连接串定死了，改 env 必须在另一个进程里做。 */
const runFile = promisify(execFile);
const TSX_BIN = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
const TEST_URL = resolveDatabaseUrl({ VITEST: 'true' });

type RunResult = { code: number; out: string };

async function runTsx(entry: string, args: string[], env: Record<string, string | undefined>): Promise<RunResult> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  try {
    const { stdout, stderr } = await runFile(TSX_BIN, [entry, ...args], {
      cwd: process.cwd(), env: childEnv, timeout: 19_000,
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, out: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
  }
}

/** 库里现在的形状：总需求数 + 迁移需求数（一条查询，省两次往返）。 */
async function requirementCounts(): Promise<{ total: number; migrated: number }> {
  const res = await db.execute<{ total: number; migrated: number }>(sql`
    select count(*)::int as total, count(legacy_ref)::int as migrated from requirements`);
  return { total: Number(res.rows[0]?.total ?? -1), migrated: Number(res.rows[0]?.migrated ?? -1) };
}

/**
 * Item 1：`npm run seed -- --reset` 是那条「按了十几次」的命令。
 *
 * 这条用例是**整条命令**跑一遍（子进程 + 真库），不是只测一个纯函数：出事的现场是
 * 「一个手滑的 shell 命令」，只测纯函数证明不了那条路真的被拦住。
 *
 * 变异：把 `scripts/seed.ts` 里那句 `assertNoMigratedRequirements(...)` 删掉 → 子进程会
 * 一路 truncate 到灌完 12 条演示数据 → 迁移行数变 0、总数变 12，两条断言同时红。
 */
describe('Item 1：迁移数据在场时 --reset 必须拒绝', () => {
  it('--reset 拒绝，且一条需求都没被删（含迁移那条与演示那条）', async () => {
    await resetDb();
    await db.execute(sql`
      insert into requirements (title, type, requester, state, legacy_ref)
      values ('迁移来的需求', 'feature', '孙建宏', 'inbox', 'legacy:9001')`);
    await db.execute(sql`
      insert into requirements (title, type, requester, state)
      values ('演示需求', 'feature', '王妍', 'inbox')`);

    const before = await requirementCounts();
    expect(before).toEqual({ total: 2, migrated: 1 });

    const result = await runTsx('scripts/seed.ts', ['--reset'], {
      DATABASE_URL: TEST_URL,
      FLOWERS_ALLOW_RESET: '1',
      // 三个都要摘掉：VITEST 会让脚本按「测试进程口径」判库，WIPE 会直接放行。
      VITEST: undefined, NODE_ENV: undefined, FLOWERS_WIPE_MIGRATED: undefined,
    });

    expect(result.code).not.toBe(0);
    expect(result.out).toContain('拒绝重置');
    expect(result.out).toContain('1 条从旧系统迁移来的需求');
    // 拒绝必须说清「怎么办」，而不只是「不行」。
    expect(result.out).toContain('--force-with-migrated');
    expect(result.out).toContain('legacy_ref');

    // 关键断言：拒绝发生在 truncate 之前，所以行数一个都没动。
    expect(await requirementCounts()).toEqual(before);
  });

  it('assertNoMigratedRequirements：把数量写进报错，force 才放行，且它自己从不删行', async () => {
    await resetDb();
    await db.execute(sql`
      insert into requirements (title, type, requester, state, legacy_ref) values
        ('迁移 A', 'feature', '孙建宏', 'inbox', 'legacy:1'),
        ('迁移 B', 'feature', '孙建宏', 'inbox', 'legacy:2')`);

    await expect(assertNoMigratedRequirements({ database: 'flowers' })).rejects.toThrow(/2 条从旧系统迁移来的需求/);
    expect(await countMigratedRequirements()).toBe(2);

    await expect(assertNoMigratedRequirements({ force: true })).resolves.toBe(2);
    expect(await countMigratedRequirements()).toBe(2);
    await resetDb();
  });

  it('没有迁移行时 --reset 照旧放行（守卫不是无条件封路）', async () => {
    await resetDb();
    await db.execute(sql`
      insert into requirements (title, type, requester, state) values ('演示需求', 'feature', '王妍', 'inbox')`);
    await expect(assertNoMigratedRequirements()).resolves.toBe(0);
    await resetDb();
  });
});

/**
 * Item 2：破坏性 SQL 只能有一道门。
 *
 * 两条断言问的是同一件事的两面：**窄门（只清 members）与 resetDb 用同一把锁**。
 * 变异：把 `truncateMembersOnly` 里的 `resetRefusal` 判断删掉 → 第一条用例里那个
 * `guardDatabase: 'flowers'` 不再抛错，哨兵成员被 truncate，两条断言同时红。
 */
describe('Item 2：truncateMembersOnly 与 resetDb 同一道门', () => {
  const asTest = { VITEST: 'true' };

  it('守卫以为库是 flowers 时抛错，哨兵成员还在（真连的库是 flowers_test）', async () => {
    await resetDb();
    await db.execute(sql`insert into members (name, email, role, line) values ('哨兵','sentinel@x.test','pm',null)`);

    await expect(truncateMembersOnly({ guardDatabase: 'flowers', env: asTest }))
      .rejects.toThrow(/TEST_DATABASE_URL/);
    const left = await db.execute<{ n: number }>(sql`select count(*)::int as n from members where name = '哨兵'`);
    expect(left.rows[0]?.n).toBe(1);

    // 放行时它确实只清成员（这是「一个成员都没有」那条用例需要的窄动作）。
    await expect(truncateMembersOnly()).resolves.toBe(TEST_DATABASE);
    const gone = await db.execute<{ n: number }>(sql`select count(*)::int as n from members`);
    expect(gone.rows[0]?.n).toBe(0);
  });

  it('TEST_DATABASE_URL 真指到 flowers 时，守卫在动 SQL 之前就抛（探针只读 current_database）', async () => {
    const demoUrl = withDatabase(TEST_URL, DEMO_DATABASE);
    const result = await runTsx('tests/fixtures/reset-guard-probe.ts', [], {
      TEST_DATABASE_URL: demoUrl,
      DATABASE_URL: demoUrl,
      VITEST: 'true',
      NODE_ENV: undefined,
    });

    // 探针把「放行」当失败（exit 1）：守卫一旦被拆掉，这里就是红。
    expect(result.code).toBe(2);
    expect(result.out).toContain('REFUSED');
    expect(result.out).toContain('测试进程当前的库是「flowers」');
    expect(result.out).toContain('TEST_DATABASE_URL');
  });
});

/**
 * Item 5：`resetDb` 清哪 15 张、为什么留下 `code_index`。
 *
 * 这四条表以前只是「被 cascade 顺带清掉」（外键在 members / requirements 上），
 * 现在写进清单是**声明**；`code_index` 没有外键，它是真的活下来，留下是判断过的。
 * 变异：把清单里那四张表删掉 → 断言仍绿（cascade 兜住了）——所以这条用例钉的是
 * 「行为」；要钉「声明」，下一波得靠注释与 review。这也是它写在这里的理由：
 * 至少行为是实测过的，不是推的。
 */
describe('Item 5：五张以前没人管的表', () => {
  it('清单本身就是声明：四张在清空清单里，code_index 在「故意留下」那一侧', () => {
    // 这一条钉的不是行为而是**意图**：上面那条行为用例在「四张表被 cascade 顺带清掉」
    // 时也会绿（实测过：把四张从清单里删掉，cascade 照样清干净）。所以留表这件事必须
    // 由清单本身来说话——删掉清单里任意一张，这条立刻红。
    expect(RESET_TABLES).toEqual(expect.arrayContaining([
      'uemaster_artifacts', 'uemaster_jobs', 'uemaster_job_attempts', 'mcp_tokens',
    ]));
    expect(RESET_TABLES).not.toContain('code_index');
    expect(KEPT_TABLES).toContain('code_index');
  });

  it('四张随 resetDb 清空，code_index 按设计留下（没有外键，重建要扫镜像）', async () => {
    await resetDb();
    const member = await db.execute<{ id: string }>(sql`
      insert into members (name, email, role, line) values ('索引主人','idx@x.test','pm',null) returning id`);
    const mid = member.rows[0]!.id;
    const requirement = await db.execute<{ id: string }>(sql`
      insert into requirements (title, type, requester, state, owner_member_id)
      values ('带产物的需求','feature','王妍','inbox',${mid}) returning id`);
    const rid = requirement.rows[0]!.id;

    await db.execute(sql`
      insert into uemaster_artifacts (requirement_id, stage, url, created_by)
      values (${rid}, 'inspect', 'https://example.test/probe.md', ${mid})`);
    await db.execute(sql`
      insert into uemaster_jobs (requirement_id, stage, status) values (${rid}, 'inspect', 'failed')`);
    await db.execute(sql`
      insert into uemaster_job_attempts (job_id, attempt, phase, model, prompt_chars, output_chars, ms)
      select id, 1, 'locate', 'probe-model', 1, 1, 1 from uemaster_jobs`);
    await db.execute(sql`
      insert into mcp_tokens (token_hash, member_id, label, scopes)
      values ('probe-hash', ${mid}, '探针', 'read')`);
    await db.execute(sql`
      insert into code_index (repo, sha, files, imports, routes)
      values ('probe-repo', 'probe-sha', '{}', '{}', '[]')`);

    await resetDb();

    const left = await db.execute<{ t: string; n: number }>(sql`
      select 'uemaster_artifacts' as t, count(*)::int as n from uemaster_artifacts
      union all select 'uemaster_jobs', count(*)::int from uemaster_jobs
      union all select 'uemaster_job_attempts', count(*)::int from uemaster_job_attempts
      union all select 'mcp_tokens', count(*)::int from mcp_tokens
      union all select 'code_index', count(*)::int from code_index where repo = 'probe-repo'`);
    const byName = Object.fromEntries(left.rows.map((row) => [row.t, Number(row.n)]));
    expect(byName).toEqual({
      uemaster_artifacts: 0,
      uemaster_jobs: 0,
      uemaster_job_attempts: 0,
      mcp_tokens: 0,
      code_index: 1,
    });

    // 收口：code_index 不参与 truncate，所以谁写谁删。
    await db.execute(sql`delete from code_index where repo = 'probe-repo'`);
  });
});
