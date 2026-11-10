import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { AppError } from '../src/core/errors.js';
import type { Member } from '../src/core/auth/roles.js';
import { can, type RequirementFacts } from '../src/core/auth/roles.js';
import { actionsFor, getRequirementDetail, permissionsFor } from '../src/core/read/detail.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { evaluateLock } from '../src/core/requirements/brief.js';
import { attachArtifact } from '../src/core/uemaster/attach.js';
import { artifactUrlIn } from '../src/core/uemaster/generator.js';
import { artifactUrl } from '../src/core/uemaster/store.js';
import { packFor } from '../src/core/uemaster/packs.js';
import { runJob, startGeneration } from '../src/core/uemaster/start.js';
import {
  artifactDirOf, highestVersionOnDisk, nextArtifactVersion, versionedName,
} from '../src/core/uemaster/versions.js';
import { resetDb, seedPeople, type SeededPerson } from './helpers/db.js';
import { BRIEF } from './helpers/brief.js';
import {
  REPO_ROOT, artifactExists, cleanArtifacts, siteFile, writeArtifact,
} from './helpers/files.js';

/**
 * 2026-11-10 的两条产品模型纠正（owner）：
 *
 * 1. **材料按版本留**：新产物落 `evaluate-v001.html`、`evaluate-v002.html`…，
 *    两次生成是两个文件、两条能点开的链接；存量那些指向同一个 `evaluate.html` 的
 *    多行由迁移 0036 如实标注「内容已被覆盖，无法恢复」。
 * 2. **评估 ≠ 立项**：生成材料只落产物、不改状态；`收集 → 待设计` 只由「立项」
 *    （trigger `approve`，`guard: 'brief'`）触发。
 *
 * 这一组用例钉的是这两件事的**可观测后果**，不是实现：
 * 文件到底是不是两份、状态到底有没有动、那句「无法恢复」到底说没说、被拒的那句话
 * 到底是哪一句。每一条都做过 mutation（把实现改回旧形状，用例必须变红——证据在
 * `docs/superpowers/plans/2026-11-10-v1-cut-report.md` §16 的表格里）。
 */

let people: SeededPerson[] = [];

beforeEach(async () => {
  await resetDb();
  people = await seedPeople();
  await cleanArtifacts();
  delete process.env.FLOWERS_GEN_CMD;
});

afterAll(async () => {
  delete process.env.FLOWERS_GEN_CMD;
  await cleanArtifacts();
  await pool.end();
});

const ALL_LEVELS = '{"site":"all","wecom":"off"}';

function memberOf(name: string): Member {
  const found = people.find((person) => person.name === name);
  if (found === undefined) throw new Error(`名册里没有 ${name}`);
  return { ...found, deactivatedAt: null, notifyPrefs: ALL_LEVELS };
}

/** 收集里一条六问齐全的需求（负责人是吕品）。 */
async function inboxInbox(): Promise<{ id: string; number: number }> {
  const row = await createRequirement(db, '吕品', {
    ...BRIEF, title: 'S3 协议支持', type: 'feature', requester: '孙建宏',
    ownerMemberId: memberOf('吕品').id,
  });
  return { id: row.id, number: row.number };
}

async function stateOf(id: string): Promise<string> {
  const res = await db.execute<{ state: string }>(sql`select state from requirements where id = ${id}`);
  return res.rows[0]!.state;
}

async function caught(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected AppError, nothing thrown');
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、材料按版本留
// ─────────────────────────────────────────────────────────────────────────────

describe('版本化 URL：两次生成是两个文件，不是一次覆盖', () => {
  /**
   * 这一条用真服务层 + 真库 + 真文件系统跑两遍生成，只有「谁来写 HTML」换成 stub。
   * 断言三件事，缺一件都还是可以「库说两版、盘上一份」：
   * - 两个 url 不同；
   * - 两个 url 各自有文件，内容里写着自己的名字（不是同一份被写了两遍）；
   * - 状态还在收集（生成不改状态，见第二节）。
   */
  it('连续生成两次：v001 与 v002 是两份文件，两处链接都打得开', async () => {
    const stub = `"${process.execPath}" "${path.join(REPO_ROOT, 'tests', 'stubs', 'gen-ok.mjs')}"`;
    process.env.FLOWERS_GEN_CMD = stub;
    const r = await inboxInbox();

    const first = await startGeneration(db, '吕品', { requirementId: r.id, stage: 'evaluate' });
    await runJob(db, first.jobId, { actor: '吕品', timeoutMs: 15000 });
    const second = await startGeneration(db, '吕品', { requirementId: r.id, stage: 'evaluate' });
    await runJob(db, second.jobId, { actor: '吕品', timeoutMs: 15000 });

    const rows = await db.execute<{ url: string; content_lost: boolean }>(sql`
      select url, content_lost from uemaster_artifacts
       where requirement_id = ${r.id} and stage = 'evaluate' order by created_at, id`);
    expect(rows.rows).toHaveLength(2);
    const urls = rows.rows.map((row) => row.url);
    expect(urls).toEqual([
      `/uemaster/PAN-${r.number}/evaluate-v001.html`,
      `/uemaster/PAN-${r.number}/evaluate-v002.html`,
    ]);
    expect(new Set(urls).size).toBe(2);
    // 新落的两行都不是「内容已覆盖」——它们指向两个不同的文件。
    expect(rows.rows.map((row) => row.content_lost)).toEqual([false, false]);

    // 两份文件都在，而且各自的正文里写着自己的路径：证明不是同一份被写了两遍。
    for (const url of urls) {
      expect(await artifactExists(url)).toBe(true);
      const body = await readFile(siteFile(url), 'utf8');
      // stub 写的是包让它写的那个相对路径（`data/uemaster/…`），所以我们能当场看出
      // 这份文件是哪一版写的。
      expect(body).toContain(`data-stub-file="data${url}"`);
    }

    // 生成不改状态（第二节的同一条边界，这里从整条管线上再钉一次）。
    expect(await stateOf(r.id)).toBe('inbox');
  });

  it('版本号 = max(库里行数, 盘上最大版号) + 1：孤儿文件不会被同名覆盖', async () => {
    const r = await inboxInbox();
    // 手工造一个「库里没有行、盘上有文件」的孤儿（attach 失败 / 人工删除行都会留下它）。
    const orphan = path.join(artifactDirOf(r.number), versionedName('evaluate', 5));
    await mkdir(path.dirname(orphan), { recursive: true });
    await writeFile(orphan, '<!doctype html><title>孤儿</title>', 'utf8');

    expect(await highestVersionOnDisk(r.number, 'evaluate')).toBe(5);
    // 库里有 0 行，盘上有 v005 → 下一版是 v006（写 v001 不会撞名，但也没必要跳号）。
    expect(await nextArtifactVersion(db, r.id, r.number, 'evaluate')).toBe(6);
  });

  it('名字零填充三位：按名字排序就是按版本排序', () => {
    expect(versionedName('evaluate', 1)).toBe('evaluate-v001.html');
    expect(versionedName('evaluate', 10)).toBe('evaluate-v010.html');
    expect(['evaluate-v010.html', 'evaluate-v002.html'].sort())
      .toEqual(['evaluate-v002.html', 'evaluate-v010.html']);
  });

  it('任务包里写的是同一个名字（包怎么写、文件就在哪），两种形状都解析得回来', () => {
    const base = {
      id: '00000000-0000-4000-8000-000000000000', number: 7, title: '示例',
      type: 'feature', requester: '孙建宏', prdUrl: null,
    };
    const pack = packFor('evaluate', { ...base, version: 3 });
    expect(pack).toContain('data/uemaster/PAN-7/evaluate-v003.html');
    expect(pack).toContain('/uemaster/PAN-7/evaluate-v003.html');
    expect(artifactUrlIn(pack)).toBe('/uemaster/PAN-7/evaluate-v003.html');

    // 不带版本号的老口径仍然认（存量包的形状）。
    expect(artifactUrlIn(packFor('evaluate', base))).toBe('/uemaster/PAN-7/evaluate.html');
  });
});

describe('存量同 URL 的多行：如实标注，不假装是两个版本', () => {
  /**
   * 迁移 0036 的判据就在这个文件里（`src/db/migrations/0036_artifact_content_lost.sql`），
   * 而测试库是**先迁移、后 seed** 的，所以迁移本身对用例新造的行不起作用。这里的
   * 做法是：造出固定文件名时代那种数据（两行同 url），再把迁移里那条 update 原样
   * 跑一遍——测的是**迁移的判断**，不是一份抄本。
   */
  async function annotateLikeMigration(): Promise<void> {
    const file = path.join(REPO_ROOT, 'src/db/migrations/0036_artifact_content_lost.sql');
    const text = await readFile(file, 'utf8');
    const statement = text
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.includes('set content_lost = true'));
    if (statement === undefined) throw new Error('0036 里没有那条 update');
    await db.execute(sql.raw(statement));
  }

  /** 固定文件名时代的两行：同一个 `evaluate.html`，先写的先被覆盖。 */
  async function seedLegacyPair(): Promise<{ id: string; number: number; older: string; newer: string }> {
    const r = await inboxInbox();
    const url = `/uemaster/PAN-${r.number}/evaluate.html`;
    await writeArtifact(url, '<!doctype html><title>后来那一版</title>');
    const older = await attachArtifact(db, '吕品', { requirementId: r.id, stage: 'evaluate', url });
    const newer = await attachArtifact(db, '吕品', { requirementId: r.id, stage: 'evaluate', url });
    // created_at 钉死：迁移的判据是「同一 url 有多行时，除最新一行外都算被覆盖」，
    // 而两次 insert 的 now() 可能落在同一毫秒。
    await db.execute(sql`update uemaster_artifacts set created_at = '2026-11-10T03:00:00Z' where id = ${older.id}`);
    await db.execute(sql`update uemaster_artifacts set created_at = '2026-11-10T04:00:00Z' where id = ${newer.id}`);
    return { id: r.id, number: r.number, older: older.id, newer: newer.id };
  }

  it('迁移的判断：同 url 的旧行标 true，最新那一行不标', async () => {
    const seeded = await seedLegacyPair();
    await annotateLikeMigration();

    const rows = await db.execute<{ id: string; content_lost: boolean }>(sql`
      select id, content_lost from uemaster_artifacts where requirement_id = ${seeded.id}`);
    const byId = new Map(rows.rows.map((row) => [row.id, row.content_lost]));
    expect(byId.get(seeded.older)).toBe(true);
    expect(byId.get(seeded.newer)).toBe(false);
  });

  it('迁移是幂等的：跑第二遍不会多标一行，也不会把已经标的改回去', async () => {
    const seeded = await seedLegacyPair();
    await annotateLikeMigration();
    await annotateLikeMigration();

    const rows = await db.execute<{ id: string; content_lost: boolean }>(sql`
      select id, content_lost from uemaster_artifacts where requirement_id = ${seeded.id}`);
    expect(rows.rows.filter((row) => row.content_lost).map((row) => row.id)).toEqual([seeded.older]);
  });

  it('读模型：最新一份 + 历史（1 版），历史那一行标着「内容已被覆盖」', async () => {
    const seeded = await seedLegacyPair();
    await annotateLikeMigration();

    const detail = await getRequirementDetail(seeded.id);
    const ref = detail!.refs.find((item) => item.stage === 'evaluate')!;
    expect(ref.present).toBe(true);
    expect(ref.versions).toBe(2);
    // 历史：只有更早那一行（最新那一行在 `url` / `at` 上，不重复出现）。
    expect(ref.history).toHaveLength(1);
    expect(ref.history[0]!.url).toBe(ref.url);            // 同一个文件
    expect(ref.history[0]!.contentLost).toBe(true);        // 但内容不是那一版的
    expect(ref.history[0]!.filePresent).toBe(true);        // 文件在——所以「覆盖」这件事
                                                          // 不能被「文件还在」冒充成「还在」
  });

  it('不同 url 的两行谁也没覆盖谁（版本化之后就只有这种形状）', async () => {
    const r = await inboxInbox();
    for (const name of ['evaluate-v001.html', 'evaluate-v002.html']) {
      const url = `/uemaster/PAN-${r.number}/${name}`;
      await writeArtifact(url);
      await attachArtifact(db, '吕品', { requirementId: r.id, stage: 'evaluate', url });
    }
    await annotateLikeMigration();

    const detail = await getRequirementDetail(r.id);
    const ref = detail!.refs.find((item) => item.stage === 'evaluate')!;
    expect(ref.history).toHaveLength(1);
    expect(ref.history[0]!.contentLost).toBe(false);
    expect(ref.history[0]!.url).toBe(`/uemaster/PAN-${r.number}/evaluate-v001.html`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、评估 ≠ 立项
// ─────────────────────────────────────────────────────────────────────────────

describe('生成材料不改状态，立项是另一个动作', () => {
  it('交回一份评估材料：材料落了库，状态还在收集，事件只有「材料」', async () => {
    const r = await inboxInbox();
    const url = `/uemaster/PAN-${r.number}/evaluate-v001.html`;
    await writeArtifact(url);

    await attachArtifact(db, '吕品', { requirementId: r.id, stage: 'evaluate', url });

    expect(await stateOf(r.id)).toBe('inbox');
    const events = await db.execute<{ type: string }>(sql`
      select type from events where requirement_id = ${r.id} order by seq`);
    expect(events.rows.map((row) => row.type)).toEqual(['requirement.created', 'uemaster.attached']);
  });

  it('六问缺一条 → 立项被拒，那句就是 `brief.ts` 的那一句（不是新写的第二句）', async () => {
    const r = await createRequirement(db, '吕品', {
      ...BRIEF, title: '缺成功口径', type: 'feature', requester: '孙建宏',
      ownerMemberId: memberOf('吕品').id, outcome: '',
    });

    const error = await caught(evaluate(db, '吕品', { requirementId: r.id }));
    expect(error.code).toBe('missing_brief');
    expect(error.message).toBe(evaluateLock({
      context: BRIEF.context, problem: BRIEF.problem, outcome: '',
    }));
    expect(error.message).toContain('还差一条没填：做成什么样算成功');
    // 门一响，状态与事件都不动。
    expect(await stateOf(r.id)).toBe('inbox');
    const events = await db.execute<{ type: string }>(sql`
      select type from events where requirement_id = ${r.id} order by seq`);
    expect(events.rows.map((row) => row.type)).toEqual(['requirement.created']);
  });

  it('六问齐 → 立项成功：进待设计，写一条迁移事件（payload 仍是 {from,to}）', async () => {
    const r = await inboxInbox();

    const out = await evaluate(db, '吕品', { requirementId: r.id });
    expect(out.state).toBe('design');
    expect(await stateOf(r.id)).toBe('design');

    const events = await db.execute<{ type: string; payload: string }>(sql`
      select type, payload from events where requirement_id = ${r.id} order by seq`);
    expect(events.rows.map((row) => row.type)).toEqual([
      'requirement.created', 'requirement.evaluated',
    ]);
    expect(JSON.parse(events.rows[1]!.payload)).toEqual({ from: 'inbox', to: 'design' });
  });

  it('动作条里收集状态给的是 `approve`（立项），不是「出材料」', () => {
    const actions = actionsFor('inbox');
    expect(actions).toContain('approve');
    // 名字不能再叫 evaluate：那个名字属于「生成评估材料」，而那个动作不在动作条上。
    expect(actions as string[]).not.toContain('evaluate');
  });

  /**
   * 权限：两个动作**同一套规则**（`can('edit')`），只是拦在不同的层。
   *
   * - 生成：`generateAction` 只解身份（`currentMember()`），能不能看见按钮由读模型的
   *   `permissions.edit` 决定（`Drawer` 里 `canEdit` 才渲染 `GenerateButton`）；
   * - 立项：读模型同样按 `permissions.edit` 过滤动作条，**并且**服务层
   *   `assertCan(..., 'edit')` 再拦一次（`requirements/evaluate.ts`）。
   *
   * 这张表钉的是「规则相同」：六种演员在收集状态下，`approve` 出现在动作条里
   * ⇔ `can('edit')` 为真 ⇔ 生成按钮会渲染。
   */
  it('同一套规则：能看见「立项」的人，就是能看见「生成」的人', async () => {
    const r = await inboxInbox();
    const facts: RequirementFacts = {
      ownerMemberId: memberOf('吕品').id, ownerLine: 'feature', state: 'inbox',
      reviewerMemberId: null,
    };
    const actors: { label: string; member: Member }[] = [
      { label: '超管', member: memberOf('房超') },
      { label: '功能线负责人', member: memberOf('吕正豪') },
      { label: '商业线负责人（别的线）', member: memberOf('赵越') },
      { label: '负责人本人', member: memberOf('吕品') },
      { label: '别的 PM', member: memberOf('李嘉') },
      { label: '已停用的负责人', member: { ...memberOf('吕品'), deactivatedAt: new Date() } },
    ];

    for (const actor of actors) {
      const canEdit = can(actor.member, facts, 'edit');
      const detail = await getRequirementDetail(r.id, actor.member);
      expect({ who: actor.label, approve: detail!.actions.includes('approve') })
        .toEqual({ who: actor.label, approve: canEdit });
      expect({ who: actor.label, generate: detail!.permissions.edit })
        .toEqual({ who: actor.label, generate: canEdit });
      // `permissionsFor` 是抽屉「生成 / 交回材料」那两个按钮的唯一判据。
      expect(permissionsFor(actor.member, facts).edit).toBe(canEdit);
    }

    // 服务层那一道：没有 edit 的人点立项会被拒（读模型过滤只是「看不看得见」）。
    const error = await caught(evaluate(db, '李嘉', { requirementId: r.id }));
    expect(error.code).toBe('forbidden');
  });
});

/**
 * 版本化之后还有一个隐蔽的坏法：`artifactUrl` 只负责「磁盘路径 → 站内路径」，
 * 它不认识版本号也不该认识。这一条把两头的翻译钉在一起（写错一个字符，文件名就漂了）。
 */
describe('磁盘路径与站内路径的翻译仍然是一对', () => {
  it('versionedFileOf / artifactUrl 互为反函数', async () => {
    const { versionedFileOf } = await import('../src/core/uemaster/versions.js');
    const file = versionedFileOf(7, 'evaluate', 12);
    expect(artifactUrl(file)).toBe('/uemaster/PAN-7/evaluate-v012.html');
    expect(artifactUrl(file)).toBe(`/uemaster/PAN-7/${versionedName('evaluate', 12)}`);
  });
});
