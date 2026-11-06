import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { packFor, STAGES, type Stage } from '../src/core/uemaster/packs.js';
import { attachArtifact } from '../src/core/uemaster/attach.js';
import { listArtifacts } from '../src/core/uemaster/list.js';
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
 * 抓取服务抛出来的错误，让调用方同时断言 instance、code、message。
 *
 * 和 requirements.test.ts 里的同名助手一个形状：`rejects.toThrowError(实例)` 只比
 * `.message`，换了 code 的 AppError 也算通过，而下游按 `e.code` 分支。
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

/** 库里现在的事件类型，按写入顺序。 */
async function eventTypes(): Promise<string[]> {
  const res = await db.execute<{ type: string }>(sql`select type from events order by seq`);
  return res.rows.map((r) => r.type);
}

async function artifactCount(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`select count(*)::int as n from uemaster_artifacts`);
  return Number(res.rows[0]!.n);
}

async function newRequirement(): Promise<{ id: string; number: number }> {
  const r = await createRequirement(db, '吕品', {
    title: 'S3 协议支持', type: 'feature', requester: '孙建宏',
  });
  return { id: r.id, number: r.number };
}

const BASE = { number: 7, title: 'S3 协议支持', type: 'feature', prdUrl: 'https://x/prd' };
const NO_PRD = { ...BASE, prdUrl: null };

describe('packFor', () => {
  it('三份任务包都点名要 UEmaster，且带 PRD 链接', () => {
    for (const stage of STAGES) {
      const p = packFor(stage, BASE);
      expect(p).toContain('UEmaster');
      expect(p).toContain('S3 协议支持');
      expect(p).toContain('https://x/prd');
    }
  });

  it('任务包里带需求的编号、类型与两个 sub-skill', () => {
    for (const stage of STAGES) {
      const p = packFor(stage, BASE);
      expect(p).toContain('PAN-7');
      expect(p).toContain('feature');
      expect(p).toContain('https://github.com/SilasSolivagus/UEmaster');
      expect(p).toContain('flow-canvas');
      expect(p).toContain('flow-walkthrough');
    }
  });

  it('固定六行骨架：任务 / 输入 / 技能 / 产出 / 交付 / 约束', () => {
    const p = packFor('evaluate', BASE);
    for (const head of ['任务：', '输入：', '技能：', '产出：', '交付：', '约束：']) {
      expect(p).toContain(head);
    }
    // 六行各只出现一次：重复的行意味着模板被拼了两遍。
    expect(p.split('产出：')).toHaveLength(2);
  });

  it('评审包要求问题清单，走查包要求与 PRD 版对比，评估包两样都不要', () => {
    expect(packFor('review', BASE)).toContain('问题清单');
    expect(packFor('inspect', BASE)).toContain('对比');
    expect(packFor('evaluate', BASE)).not.toContain('问题清单');
    expect(packFor('evaluate', BASE)).not.toContain('差异清单');
  });

  it('评审包的问题清单点名五类问题，并要求每条带位置', () => {
    const p = packFor('review', BASE);
    for (const kind of ['死路', '无页面步骤', '缺状态', '歧义词', '未知角色']) {
      expect(p).toContain(kind);
    }
    expect(p).toContain('位置');
  });

  it('走查包的差异清单分三档', () => {
    const p = packFor('inspect', BASE);
    for (const bucket of ['一致', '缺失', '溢出']) {
      expect(p).toContain(bucket);
    }
  });

  it('交付指向 public/uemaster/PAN-n/<stage>.html，并要求调 uemaster_attach', () => {
    for (const stage of STAGES) {
      const p = packFor(stage, BASE);
      expect(p).toContain(`public/uemaster/PAN-7/${stage}.html`);
      expect(p).toContain(`/uemaster/PAN-7/${stage}.html`);
      expect(p).toContain('uemaster_attach');
    }
  });

  it('约束说清只画 PRD 里有的，不编页面与状态', () => {
    for (const stage of STAGES) {
      const p = packFor(stage, BASE);
      expect(p).toContain('只画 PRD');
      expect(p).toContain('不要');
    }
  });

  it('PRD 缺失时照实说缺、且说明无法继续，而不是省掉这行', () => {
    for (const stage of STAGES) {
      const p = packFor(stage, NO_PRD);
      expect(p).toContain('输入：');
      expect(p).toContain('未提供');
      expect(p).toContain('无法');
      expect(p).not.toContain('null');
    }
  });

  it('三份包是三个不同的文本', () => {
    const texts = STAGES.map((s) => packFor(s, BASE));
    expect(new Set(texts).size).toBe(3);
  });

  it('纯函数：同一个输入两次调用给出同一段文本', () => {
    expect(packFor('review', BASE)).toBe(packFor('review', BASE));
  });
});

describe('attachArtifact', () => {
  it('非对象一律「参数不合法」', async () => {
    const { id } = await newRequirement();
    for (const raw of [null, undefined, 'x', 42, [], [{ requirementId: id }]]) {
      expect(await caught(attachArtifact(db, '吕品', raw))).toMatchObject({
        code: 'invalid', message: '参数不合法',
      });
    }
    expect(await artifactCount()).toBe(0);
  });

  it('需求 ID 不是 uuid 就给中文消息，不进库也不写事件', async () => {
    const e = await caught(attachArtifact(db, '吕品', {
      requirementId: 'PAN-7', stage: 'evaluate', url: '/uemaster/PAN-7/evaluate.html',
    }));
    expect(e).toMatchObject({ code: 'invalid', message: '需求 ID 格式不正确' });
    expect(await artifactCount()).toBe(0);
    expect(await eventTypes()).toEqual([]);
  });

  it('stage 只认三个值', async () => {
    const { id } = await newRequirement();
    for (const stage of ['design', 'Evaluate', '', undefined, 3]) {
      const e = await caught(attachArtifact(db, '吕品', {
        requirementId: id, stage, url: 'https://x/y.html',
      }));
      expect(e).toMatchObject({ code: 'invalid_stage' });
      expect(e.message).toContain('evaluate');
    }
    expect(await artifactCount()).toBe(0);
  });

  it('只收 http(s) 链接或站内路径', async () => {
    const { id } = await newRequirement();
    const bad = [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'ftp://x/y.html',
      'uemaster/PAN-7/evaluate.html',   // 少了开头的 /
      '//evil.example/x.html',          // 协议相对，等于站外
      'data:text/html,<script>alert(1)</script>',
      '   ',
    ];
    for (const url of bad) {
      const e = await caught(attachArtifact(db, '吕品', {
        requirementId: id, stage: 'evaluate', url,
      }));
      expect(e.code).toBe('invalid_url');
      expect(e.message).toContain('http');
    }
    expect(await artifactCount()).toBe(0);
    // 建需求本身会写一条 requirement.created；这里只看有没有产物事件。
    expect((await eventTypes()).filter((t) => t === 'uemaster.attached')).toEqual([]);
  });

  it('落一行，返回 id/stage/url', async () => {
    const { id } = await newRequirement();
    const got = await attachArtifact(db, '吕品', {
      requirementId: id, stage: 'review', url: '/uemaster/PAN-1/review.html',
    });
    expect(got.stage).toBe('review');
    expect(got.url).toBe('/uemaster/PAN-1/review.html');
    expect(got.id).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await db.execute<{
      requirement_id: string; stage: string; url: string; created_by: string;
    }>(sql`select requirement_id, stage, url, created_by from uemaster_artifacts`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      requirement_id: id, stage: 'review', url: '/uemaster/PAN-1/review.html', created_by: '吕品',
    });
  });

  it('写一条 uemaster.attached 事件，payload 带 stage 与 url', async () => {
    const { id } = await newRequirement();
    await attachArtifact(db, 'agent', {
      requirementId: id, stage: 'inspect', url: 'https://x/inspect.html',
    });
    const rows = await db.execute<{ type: string; actor: string; payload: string }>(
      sql`select type, actor, payload from events where type = 'uemaster.attached'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ type: 'uemaster.attached', actor: 'agent' });
    expect(JSON.parse(rows.rows[0]!.payload)).toEqual({
      stage: 'inspect', url: 'https://x/inspect.html',
    });
  });

  it('需求不存在就 not_found，且不留事件、不留产物', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    const e = await caught(attachArtifact(db, '吕品', {
      requirementId: ghost, stage: 'evaluate', url: '/uemaster/PAN-9/evaluate.html',
    }));
    expect(e).toMatchObject({ code: 'not_found', message: '需求不存在' });
    expect(await artifactCount()).toBe(0);
    expect(await eventTypes()).toEqual([]);
  });

  it('同一 stage 可以有多份（重做产生新版本），旧行不被删', async () => {
    const { id } = await newRequirement();
    await attachArtifact(db, '吕品', {
      requirementId: id, stage: 'evaluate', url: '/uemaster/PAN-1/evaluate.html',
    });
    await attachArtifact(db, '吕品', {
      requirementId: id, stage: 'evaluate', url: '/uemaster/PAN-1/evaluate-v2.html',
    });
    expect(await artifactCount()).toBe(2);
    expect((await eventTypes()).filter((t) => t === 'uemaster.attached')).toHaveLength(2);
  });

  it('库里的 CHECK 拦住绕过服务层的未知 stage', async () => {
    const { id } = await newRequirement();
    let code: string | undefined;
    try {
      await db.execute(sql`
        insert into uemaster_artifacts (requirement_id, stage, url, created_by)
        values (${id}, 'bogus', '/x.html', 'test')`);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('23514');        // check_violation
    expect(await artifactCount()).toBe(0);
  });
});

describe('listArtifacts', () => {
  it('没有产物时返回空数组', async () => {
    const { id } = await newRequirement();
    expect(await listArtifacts(db, id)).toEqual([]);
  });

  it('同一 stage 取最新一行，旧的只是历史', async () => {
    const { id } = await newRequirement();
    await attachArtifact(db, '吕品', {
      requirementId: id, stage: 'evaluate', url: '/uemaster/PAN-1/evaluate.html',
    });
    await attachArtifact(db, '吕品', {
      requirementId: id, stage: 'evaluate', url: '/uemaster/PAN-1/evaluate-v2.html',
    });
    const rows = await listArtifacts(db, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: 'evaluate', url: '/uemaster/PAN-1/evaluate-v2.html' });
    expect(rows[0]!.at).toBeInstanceOf(Date);
  });

  it('三个 stage 各一行，按固定顺序 evaluate → review → inspect', async () => {
    const { id } = await newRequirement();
    await attachArtifact(db, '吕品', {
      requirementId: id, stage: 'inspect', url: '/uemaster/PAN-1/inspect.html',
    });
    await attachArtifact(db, '吕品', {
      requirementId: id, stage: 'evaluate', url: '/uemaster/PAN-1/evaluate.html',
    });
    await attachArtifact(db, '吕品', {
      requirementId: id, stage: 'review', url: '/uemaster/PAN-1/review.html',
    });
    const rows = await listArtifacts(db, id);
    expect(rows.map((r) => r.stage)).toEqual(['evaluate', 'review', 'inspect']);
  });

  it('只取本需求的产物', async () => {
    const a = await newRequirement();
    const b = await createRequirement(db, '吕品', {
      title: '另一个', type: 'commercial', requester: '孙建宏',
    });
    await attachArtifact(db, '吕品', {
      requirementId: a.id, stage: 'evaluate', url: '/uemaster/PAN-1/evaluate.html',
    });
    await attachArtifact(db, '吕品', {
      requirementId: b.id, stage: 'review', url: '/uemaster/PAN-2/review.html',
    });
    expect((await listArtifacts(db, a.id)).map((r) => r.stage)).toEqual(['evaluate']);
    expect((await listArtifacts(db, b.id)).map((r) => r.stage)).toEqual(['review']);
  });

  it('需求 ID 不是 uuid 就给中文消息，不把 22P02 漏出去', async () => {
    const e = await caught(listArtifacts(db, 'PAN-1'));
    expect(e).toMatchObject({ code: 'invalid', message: '需求 ID 格式不正确' });
  });

  it('需求不存在时返回空数组', async () => {
    expect(await listArtifacts(db, '00000000-0000-4000-8000-000000000000')).toEqual([]);
  });
});

describe('Stage 常量', () => {
  it('只有三个 stage，且是编译期类型', () => {
    const stages: readonly Stage[] = STAGES;
    expect([...stages]).toEqual(['evaluate', 'review', 'inspect']);
  });
});
