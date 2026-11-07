import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import {
  buildPlan, type FlowerDoc, type LocalReq,
} from '../src/core/prd/backfill-plan.js';
import { resetDb, seedPeople } from './helpers/db.js';

/**
 * 0025：老系统的 PRD 链接回填。
 *
 * 这一组**跑真迁移文件**（`0025_prd_url_backfill.sql`），不是在用例里重写一遍那条
 * SQL：迁移里的四道门就是口径本身，抄一份到这里以后两边会分叉，用例只证明「抄的那份
 * 对」。种子数据由用例自己造（真种子是 203 条外部数据，见 `src/db/seeds/`）。
 *
 * 钉五件事：
 *
 * 1. **一对一才写**：一条需求 + 一条同名文档 → 写；
 * 2. **歧义不猜**：两条需求同题 + 一条文档 → 一条都不写（这条最要紧：挑一条的
 *    代价是「库里有个看起来对的 PRD，其实是别人的」，比空着坏得多）；
 * 3. **不覆盖、不碰演示行、不收空 URL**：三道旁门；
 * 4. **幂等**：第二遍 0 行；
 * 5. **判据是承重的**：把「唯一」放宽成「至少一条」（等价于「取第一条」的写法），
 *    同一个歧义场景立刻写成 2 行 —— 一条变异用例，钉住那个 `= 1`。
 */

let people: Awaited<ReturnType<typeof seedPeople>> = [];

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
  // 种子表不在 `RESET_TABLES` 里（它是老系统的快照，不是应用数据，见 0025 的注释），
  // 所以这一组必须自己清：否则上一条用例的种子会漏进下一条。
  await db.execute(sql`delete from prd_url_backfill_seed`);
});

afterAll(async () => {
  await pool.end();
});

const MIGRATION = '0025_prd_url_backfill.sql';

function migrationText(): string {
  return readFileSync(path.join(process.cwd(), 'src/db/migrations', MIGRATION), 'utf8');
}

/** 跑一份迁移 SQL：按 drizzle 的分隔符切开，逐条执行，返回 `update` 改掉的行数。 */
async function runSql(text: string = migrationText()): Promise<number> {
  let changed = 0;
  for (const statement of text.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed === '') continue;
    const res = await db.execute(sql.raw(trimmed));
    changed += res.rowCount ?? 0;
  }
  return changed;
}

/** 种一条「文档」：标题 + URL。表结构就是这么两列（外加 loaded_at）。 */
async function seedDoc(title: string, url: string): Promise<void> {
  await db.execute(sql`
    insert into prd_url_backfill_seed (title, url) values (${title}, ${url})`);
}

const URL_A = 'https://doc.weixin.qq.com/doc/w3_A?scode=X';

/**
 * 造一条需求。
 *
 * `legacy` 决定它是「迁移行」（`legacy_ref` 有值）还是「演示行」——这正是 0025 的
 * 第一道门，也是这组用例唯一需要造出来的差别。
 */
async function insertRequirement(opts: {
  title: string;
  legacy: boolean;
  prdUrl?: string | null;
}): Promise<{ id: string; number: number }> {
  const legacyRef = opts.legacy ? `legacy-${Math.random().toString(36).slice(2)}` : null;
  const res = await db.execute<{ id: string; number: number }>(sql`
    insert into requirements (title, type, requester, state, owner_member_id, legacy_ref, prd_url)
    values (${opts.title}, 'feature', '未知', 'inbox',
            ${people.find((p) => p.name === '吕品')!.id}, ${legacyRef}, ${opts.prdUrl ?? null})
    returning id, number`);
  return res.rows[0]!;
}

async function prdOf(id: string): Promise<string | null> {
  const res = await db.execute<{ prd_url: string | null }>(sql`
    select prd_url from requirements where id = ${id}`);
  return res.rows[0]!.prd_url;
}

describe('0025：PRD 链接回填（标题等值 + 两边唯一）', () => {
  it('一对一：一条迁移行 + 一条同名文档 → 写入它的 external_url', async () => {
    const req = await insertRequirement({ title: '【文件】点号文件名校验', legacy: true });
    await seedDoc('【文件】点号文件名校验', URL_A);

    expect(await runSql()).toBe(1);
    expect(await prdOf(req.id)).toBe(URL_A);
  });

  it('歧义：两条需求同题 + 一条文档 → 一条都不写（不取第一条）', async () => {
    // 这就是真实库里那 2 个标题的形状（PAN-27/PAN-206、PAN-338/PAN-742）。
    const first = await insertRequirement({ title: '用户部分权益缩减调整', legacy: true });
    const second = await insertRequirement({ title: '用户部分权益缩减调整', legacy: true });
    await seedDoc('用户部分权益缩减调整', URL_A);

    expect(await runSql()).toBe(0);
    expect(await prdOf(first.id)).toBeNull();
    expect(await prdOf(second.id)).toBeNull();
  });

  it('混在一起：唯一的那条写、歧义的那条不写（一次跑完）', async () => {
    const unique = await insertRequirement({ title: '主站域名改造', legacy: true });
    const amb1 = await insertRequirement({ title: '【风控】我的分享违规文件展示逻辑问题', legacy: true });
    const amb2 = await insertRequirement({ title: '【风控】我的分享违规文件展示逻辑问题', legacy: true });
    await seedDoc('主站域名改造', URL_A);
    await seedDoc('【风控】我的分享违规文件展示逻辑问题', 'https://doc.weixin.qq.com/doc/w3_B?scode=Y');

    expect(await runSql()).toBe(1);
    expect(await prdOf(unique.id)).toBe(URL_A);
    expect(await prdOf(amb1.id)).toBeNull();
    expect(await prdOf(amb2.id)).toBeNull();
  });

  it('永不覆盖：已有 prd_url 的行一个字节都不改', async () => {
    const req = await insertRequirement({
      title: '主站域名改造', legacy: true, prdUrl: 'https://docs.123pan.example/prd/PAN-1',
    });
    await seedDoc('主站域名改造', URL_A);

    expect(await runSql()).toBe(0);
    expect(await prdOf(req.id)).toBe('https://docs.123pan.example/prd/PAN-1');
  });

  it('只碰迁移行：演示行（legacy_ref 为空）同题也不写', async () => {
    const demo = await insertRequirement({ title: '主站域名改造', legacy: false });
    await seedDoc('主站域名改造', URL_A);

    expect(await runSql()).toBe(0);
    expect(await prdOf(demo.id)).toBeNull();
  });

  it('空 URL 不是一条 PRD 链接：种子里塞空串也不写', async () => {
    const req = await insertRequirement({ title: '主站域名改造', legacy: true });
    await seedDoc('主站域名改造', '   ');

    expect(await runSql()).toBe(0);
    expect(await prdOf(req.id)).toBeNull();
  });

  it('幂等：第二遍 0 行（判据本身就是守卫）', async () => {
    const req = await insertRequirement({ title: '主站域名改造', legacy: true });
    await seedDoc('主站域名改造', URL_A);

    expect(await runSql()).toBe(1);
    expect(await runSql()).toBe(0);
    expect(await prdOf(req.id)).toBe(URL_A);
  });

  it('变异：把「唯一」放宽成「至少一条」，歧义场景立刻写成 2 行', async () => {
    // 这条用例证明 `= 1` 是承重的：它不是防御性代码，它挡的是「9 行全部写错」。
    const first = await insertRequirement({ title: '用户部分权益缩减调整', legacy: true });
    const second = await insertRequirement({ title: '用户部分权益缩减调整', legacy: true });
    await seedDoc('用户部分权益缩减调整', URL_A);

    const original = migrationText();
    const clause = '(select count(*) from requirements r2 where r2.title = s.title) = 1';
    // 锚点必须还在：有人重写那条子查询时，这里要红一次让他来更新变异。
    expect(original).toContain(clause);
    const mutated = original.replace(
      clause,
      '(select count(*) from requirements r2 where r2.title = s.title) >= 1',
    );
    expect(mutated).not.toBe(original);

    // 真迁移：0 行。放宽之后：2 行（「取第一条」那种写法会挑一条、写错）→ 歧义用例红。
    expect(await runSql(original)).toBe(0);
    expect(await runSql(mutated)).toBe(2);
    expect(await prdOf(first.id)).toBe(URL_A);
    expect(await prdOf(second.id)).toBe(URL_A);
  });
});

describe('buildPlan：软删的行不算「同题需求」', () => {
  /**
   * 这一组**不碰库**：`buildPlan` 是纯函数（口径住在 `src/core/prd/backfill-plan.ts`），
   * 两串内存里的行进去，一份计划出来。测它是为了钉住一件事——`--emit` 重新生成种子
   * 时，「同题唯一」只数**未删**的行。
   *
   * 形状取自 0026 的裁定：`用户部分权益缩减调整` 原有两条（PAN-338 / PAN-742），
   * owner 判「删掉已拒绝的那条」，于是未删的只剩一条，那个标题从此可以配对了。
   */
  const TITLE = '用户部分权益缩减调整';
  const doc: FlowerDoc = { title: TITLE, external_url: URL_A, kind: 'change' };
  const row = (over: Partial<LocalReq> & { number: number }): LocalReq => ({
    legacy_ref: `legacy-${over.number}`, title: TITLE, prd_url: null, deleted_at: null, ...over,
  });

  it('软删的重复行视为不存在：那个标题不再判歧义，该配的配上', () => {
    const plan = buildPlan(
      [doc],
      [row({ number: 338, deleted_at: new Date('2026-11-07T23:34:57Z') }), row({ number: 742 })],
    );

    expect(plan.ambiguous).toHaveLength(0);
    expect(plan.pairs).toEqual([{ title: TITLE, url: URL_A }]);
    expect(plan.counts.total).toBe(1); // 软删的那行不进计数
    expect(plan.counts.migrated).toBe(1);
  });

  it('对偶：没软删时同一场景是歧义（证明上一条的绿来自 deleted_at）', () => {
    const plan = buildPlan([doc], [row({ number: 338 }), row({ number: 742 })]);

    expect(plan.pairs).toHaveLength(0);
    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.ambiguous[0]!.candidates.map((c) => c.number)).toEqual([338, 742]);
    expect(plan.counts.total).toBe(2);
  });

  it('软删的迁移行也不进缺口分类：它既不算歧义，也不算「没有文档」', () => {
    // 「已删的行等于不存在」是全称的：分类缺口时也不该冒出一个 PAN 号。
    const plan = buildPlan([], [row({ number: 338, deleted_at: '2026-11-07T23:34:57Z' })]);

    expect(plan.gaps).toEqual({
      noDocument: [], documentWithoutUrl: [], ambiguous: [], alreadyFilled: [],
    });
    expect(plan.counts).toMatchObject({ total: 0, migrated: 0, demo: 0 });
  });
});

describe('种子文件：仓库里那份 203 条配对', () => {
  type Seed = { count: number; pairs: { title: string; url: string }[] };

  const seed: Seed = JSON.parse(
    readFileSync(path.join(process.cwd(), 'src/db/seeds/prd-url-backfill.json'), 'utf8'),
  ) as Seed;

  it('条数与自述一致，且标题两两不同（表的 title 是主键）', () => {
    expect(seed.pairs.length).toBe(seed.count);
    // 203 = 205 条带 URL 的文档 − 2 条歧义。数字变了要是一次有意的重新生成。
    expect(seed.pairs.length).toBe(203);
    expect(new Set(seed.pairs.map((p) => p.title)).size).toBe(seed.pairs.length);
  });

  it('每一行都有非空标题与 http(s) 链接，且没有首尾空白', () => {
    for (const p of seed.pairs) {
      expect(p.title).not.toBe('');
      expect(p.title).toBe(p.title.trim());
      expect(p.url).toMatch(/^https?:\/\/\S+$/);
    }
  });
});
