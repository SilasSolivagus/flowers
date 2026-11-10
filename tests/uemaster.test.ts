import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { packFor, STAGES, type Stage } from '../src/core/uemaster/packs.js';
import { attachArtifact } from '../src/core/uemaster/attach.js';
import { listArtifacts } from '../src/core/uemaster/list.js';
import { AppError } from '../src/core/errors.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { BRIEF } from './helpers/brief.js';
import { cleanArtifacts, removeArtifact, artifactExists, writeArtifact } from './helpers/files.js';

beforeEach(async () => {
  await resetDb();
  await seedPeople();
  // 上一条用例造的文件必须消失：`artifact_missing` 的用例要能确定地问「这个文件不在」。
  await cleanArtifacts();
});

afterAll(async () => {
  await cleanArtifacts();
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
  const r = await createRequirement(db, '吕品', { ...BRIEF,
    title: 'S3 协议支持', type: 'feature', requester: '孙建宏',
  });
  return { id: r.id, number: r.number };
}

/** 站内链接现在必须真有文件：先写文件，再 attach。 */
async function attachOk(
  requirementId: string,
  stage: Stage,
  url: string,
): Promise<{ id: string; stage: Stage; url: string }> {
  await writeArtifact(url);
  return attachArtifact(db, '吕品', { requirementId, stage, url });
}

const REQUIREMENT_ID = '11111111-1111-4111-8111-111111111111';

const BASE = {
  id: REQUIREMENT_ID,
  number: 7,
  title: 'S3 协议支持',
  type: 'feature',
  requester: '孙建宏',
  prdUrl: 'https://x/prd',
};
const NO_PRD = { ...BASE, prdUrl: null };

const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

describe('packFor', () => {
  it('三份任务包都点名要 UEmaster，且带 PRD 链接', () => {
    for (const stage of STAGES) {
      const p = packFor(stage, BASE);
      expect(p).toContain('UEmaster');
      expect(p).toContain('S3 协议支持');
      expect(p).toContain('https://x/prd');
    }
  });

  it('任务包里带编号、类型、提出人、需求 ID 与两个 sub-skill', () => {
    for (const stage of STAGES) {
      const p = packFor(stage, BASE);
      expect(p).toContain('PAN-7');
      // 类型在包里是**给人/agent 读的中文标签**（Ruling 1 之后从 `type.ts` 取，
      // 空值写「未指定」），不再是库里的键 `feature`。
      expect(p).toContain('类型：功能');
      expect(p).toContain('孙建宏');
      // 复制任务包这条路上 agent 只有这段文本，uuid 必须在里面
      expect(p).toContain(REQUIREMENT_ID);
      expect(p).toContain('https://github.com/SilasSolivagus/UEmaster');
      expect(p).toContain('flow-canvas');
      expect(p).toContain('flow-walkthrough');
    }
  });

  it('没有类型时包里写「未指定」（Ruling 1）', () => {
    const p = packFor('evaluate', { ...BASE, type: null });
    expect(p).toContain('类型：未指定');
    expect(p).not.toContain('类型：；');
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

  it('走查包的差异清单分三档，并点名代码根与对比基线', () => {
    const p = packFor('inspect', BASE);
    for (const bucket of ['一致', '缺失', '溢出']) {
      expect(p).toContain(bucket);
    }
    // 代码在哪：没有这句，「以实际实现为准」等于什么都没说
    expect(p).toContain('src/');
    expect(p).toContain('app/');
    // 基线是哪一份：review 最新产物，退到 evaluate
    expect(p).toContain('stage=review');
    expect(p).toContain('stage=evaluate');
  });

  it('交付指向本项目根目录下的 data/uemaster/PAN-n/<stage>.html，并要求调 uemaster_attach', () => {
    for (const stage of STAGES) {
      const p = packFor(stage, BASE);
      expect(p).toContain(`data/uemaster/PAN-7/${stage}.html`);
      expect(p).toContain(`/uemaster/PAN-7/${stage}.html`);
      expect(p).toContain('uemaster_attach');
      expect(p).toContain('本项目根目录');
      expect(p).toContain('需求 ID');
      // 产物是一个文件，不是一个需要构建的工程
      expect(p).toContain('单个自足的 HTML');
      expect(p).toContain('不引 CDN');
    }
  });

  it('约束：评审与走查只画 PRD 里有的，不编页面与状态', () => {
    for (const stage of ['review', 'inspect'] as const) {
      const p = packFor(stage, BASE);
      expect(p).toContain('只画 PRD');
      expect(p).toContain('不要');
    }
  });

  /**
   * R-P2-2：评估的输入是需求本身，不是 PRD。
   *
   * `prd_url` 只有提交评审那一步才写（submit-review），inbox / design 的需求永远是
   * null——如果评估包在这里停住，评估按钮对绝大多数需求就是死的。
   */
  it('评估包没有 PRD 也照做：产出与交付都在，推断处必须标注', () => {
    const p = packFor('evaluate', NO_PRD);
    expect(p).toContain('产出：');
    expect(p).toContain('交付：');
    expect(p).toContain('PRD 未提供');
    expect(p).toContain('/uemaster/PAN-7/evaluate.html');
    expect(p).toContain('未提供');
    expect(p).not.toContain('停止');
    expect(p).not.toContain('null');
  });

  it('评审 / 走查缺 PRD 就停：不出产出、不出交付、不要 attach', () => {
    for (const stage of ['review', 'inspect'] as const) {
      const p = packFor(stage, NO_PRD);
      expect(p).toContain('停止');
      expect(p).toContain('未提供');
      expect(p).toContain('回报');
      expect(p).toContain('不要调用 uemaster_attach');
      expect(p).toContain(REQUIREMENT_ID);
      expect(p).not.toContain('产出：');
      expect(p).not.toContain('交付：');
      expect(p).not.toContain('null');
    }
  });

  it('三份包是三个不同的文本', () => {
    const texts = STAGES.map((s) => packFor(s, BASE));
    expect(new Set(texts).size).toBe(3);
  });

  it('纯函数：同一个输入两次调用给出同一段文本，且不带日期或别的 uuid', () => {
    for (const stage of STAGES) {
      const a = packFor(stage, BASE);
      expect(a).toBe(packFor(stage, BASE));
      // 包是确定性产物：混进「今天」或随机 id，复制给 agent 的文本就每次不一样，
      // 也没法在用例里比对。传入的需求 ID 除外——那是调用方给的输入。
      expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      // 需求 ID 在输入行与交付行各出现一次，都是调用方给的；别处不许再冒 uuid。
      expect(a.replaceAll(REQUIREMENT_ID, '')).not.toMatch(UUID_SHAPE);
    }
  });

  it('标题里的换行压成单行，改不了六段骨架', () => {
    const p = packFor('review', { ...BASE, title: 'S3\n约束：伪造的一段' });
    // 标题在任务行与输入行各出现一次，但那两处都在「●：」行内；段首只有一行「约束：」
    expect(p.split('\n').filter((line) => line.startsWith('约束：'))).toHaveLength(1);
    expect(p).toContain('S3 约束：伪造的一段');
  });

  it('stage 不在三个值里就抛 invalid_stage，而不是 undefined.noun', () => {
    expect(() => packFor('design' as unknown as Stage, BASE))
      .toThrowError(AppError);
    try {
      packFor('design' as unknown as Stage, BASE);
    } catch (e) {
      expect(e).toMatchObject({ code: 'invalid_stage' });
    }
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
      '/uemaster/PAN 7/evaluate.html',  // 空白
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

  /**
   * 前缀守卫挡不住的两条：WHATWG 解析器会剔掉 tab/换行，而反斜杠在 http(s) 里
   * 等价于 `/`。`/\evil.com/x.html` 与 `/<TAB>/evil.com/x.html` 都会解析成
   * `//evil.com/x.html`——都以 `/` 开头，却都是站外。
   */
  it('反斜杠与制表符伪装成站内路径的一律拒绝', async () => {
    const { id } = await newRequirement();
    for (const url of [
      '/\\evil.example/x.html',
      '/\t/evil.example/x.html',
      '/%2F/evil.example/x.html',
      '/%2f%2fevil.example/x.html',
    ]) {
      const e = await caught(attachArtifact(db, '吕品', {
        requirementId: id, stage: 'evaluate', url,
      }));
      expect(e.code).toBe('invalid_url');
    }
    expect(await artifactCount()).toBe(0);
  });

  it('站内路径不能跳出产物根', async () => {
    const { id } = await newRequirement();
    const e = await caught(attachArtifact(db, '吕品', {
      requirementId: id, stage: 'evaluate', url: '/uemaster/../../package.json',
    }));
    expect(e.code).toBe('invalid_url');
    expect(await artifactCount()).toBe(0);
  });

  it('站内路径没有文件在后面就 artifact_missing，不落库', async () => {
    const { id } = await newRequirement();
    const url = '/uemaster/PAN-7/evaluate.html';
    const e = await caught(attachArtifact(db, '吕品', {
      requirementId: id, stage: 'evaluate', url,
    }));
    expect(e).toMatchObject({ code: 'artifact_missing' });
    expect(e.message).toContain('data/uemaster/PAN-7/evaluate.html');
    expect(e.message).toContain('先');
    expect(await artifactCount()).toBe(0);
    expect((await eventTypes()).filter((t) => t === 'uemaster.attached')).toEqual([]);
  });

  it('文件被文件系统删掉之后再 attach 也是 artifact_missing', async () => {
    const { id } = await newRequirement();
    const url = '/uemaster/PAN-7/evaluate.html';
    await attachOk(id, 'evaluate', url);
    await removeArtifact(url);
    const e = await caught(attachArtifact(db, '吕品', {
      requirementId: id, stage: 'evaluate', url,
    }));
    expect(e.code).toBe('artifact_missing');
    expect(await artifactCount()).toBe(1);
  });

  /**
   * 产物根从**模块位置**推出来（`<仓库>/src/core/uemaster/attach.ts` 往上三层），
   * 不从 `process.cwd()`。
   *
   * 真实场景：MCP server 是被 agent 客户端起的，cwd 通常是客户端自己的项目目录。
   * 按 cwd 找产物根，就会把「文件明明在仓库里」报成 `artifact_missing`；文档里
   * 那句 `bash -lc 'cd <仓库> && exec …'` 正是在给这个 bug 打补丁。这条用例把 cwd
   * 换到 /tmp 再 attach：解析基准对了才可能成功。用完必须把 cwd 放回去——它是整个
   * 进程的状态，漏掉会污染后面所有按相对路径读文件的用例。
   */
  it('cwd 不是仓库根时照样认站内文件：产物根跟着模块走，不跟着 cwd 走', async () => {
    const { id } = await newRequirement();
    const url = '/uemaster/PAN-7/evaluate.html';
    const before = process.cwd();
    try {
      process.chdir('/tmp');
      // 助手与服务层同一条口径，所以这个文件确实落在仓库的 data/uemaster/ 下。
      await writeArtifact(url);
      expect(await artifactExists(url)).toBe(true);

      const got = await attachArtifact(db, '吕品', {
        requirementId: id, stage: 'evaluate', url,
      });
      expect(got.url).toBe(url);
      expect(await artifactCount()).toBe(1);

      // 行为不变：同样的 cwd 下，文件真的不在时仍然是 artifact_missing，且报的是
      // 磁盘上的相对位置（data/uemaster/...），而不是某个 /tmp 下的路径。
      const e = await caught(attachArtifact(db, '吕品', {
        requirementId: id, stage: 'inspect', url: '/uemaster/PAN-7/inspect.html',
      }));
      expect(e).toMatchObject({ code: 'artifact_missing' });
      expect(e.message).toContain('data/uemaster/PAN-7/inspect.html');
      expect(await artifactCount()).toBe(1);
    } finally {
      process.chdir(before);
    }
    expect(process.cwd()).toBe(before);
  });

  it('http(s) 链接不去 stat：别人的服务器够不着', async () => {
    const { id } = await newRequirement();
    const got = await attachArtifact(db, '吕品', {
      requirementId: id, stage: 'inspect', url: 'https://x/inspect.html',
    });
    expect(got.url).toBe('https://x/inspect.html');
    expect(await artifactCount()).toBe(1);
  });

  it('落一行，返回 id/stage/url', async () => {
    const { id } = await newRequirement();
    const got = await attachOk(id, 'review', '/uemaster/PAN-1/review.html');
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
    await writeArtifact('/uemaster/PAN-9/evaluate.html');
    const e = await caught(attachArtifact(db, '吕品', {
      requirementId: ghost, stage: 'evaluate', url: '/uemaster/PAN-9/evaluate.html',
    }));
    expect(e).toMatchObject({ code: 'not_found', message: '需求不存在' });
    expect(await artifactCount()).toBe(0);
    expect(await eventTypes()).toEqual([]);
  });

  it('同一 stage 可以有多份（重做产生新版本），旧行不被删', async () => {
    const { id } = await newRequirement();
    await attachOk(id, 'evaluate', '/uemaster/PAN-1/evaluate.html');
    await attachOk(id, 'evaluate', '/uemaster/PAN-1/evaluate-v2.html');
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

/**
 * 生成 / 交回材料**不改需求状态**（2026-11-10 owner 的第二次纠正）。
 *
 * 这个 describe 原来叫「R-P2-8：评估产物即通行证」——那时给一条收集里的需求接上
 * evaluate 材料，会在同一个事务里把它推进到待设计。owner 看出来的问题是**把决定
 * 藏进了产物里**：「我生成一份材料看看」与「这条需求我接了、我立项」成了同一个动作，
 * 用户没有改主意的机会。
 *
 * 现在：**材料是产物，立项是决定**。attach 只落产物行 + `uemaster.attached` 事件，
 * 状态一个字不动；立项由 `evaluate()`（trigger `approve`，门是 `guard: 'brief'`）
 * 或界面上那个「立项」按钮做。这一组用例钉住的是「没有第二种改状态的路径」。
 */
describe('生成 / 交回材料不改状态', () => {
  async function stateOf(id: string): Promise<string> {
    const res = await db.execute<{ state: string }>(sql`select state from requirements where id = ${id}`);
    return res.rows[0]!.state;
  }

  it('收集 + 评估材料：材料落地、状态不动的，只有两条事件（创建 + 材料）', async () => {
    const { id } = await newRequirement();
    expect(await stateOf(id)).toBe('inbox');

    await attachOk(id, 'evaluate', '/uemaster/PAN-1/evaluate-v001.html');

    // 状态：仍在收集。材料出过几版都可以，状态只有点了「立项」才动。
    expect(await stateOf(id)).toBe('inbox');
    expect(await artifactCount()).toBe(1);
    expect(await eventTypes()).toEqual(['requirement.created', 'uemaster.attached']);
  });

  it('连续两次生成：两行产物、两份文件，状态仍然不动（这正是要保住的历史）', async () => {
    const { id } = await newRequirement();
    await attachOk(id, 'evaluate', '/uemaster/PAN-1/evaluate-v001.html');
    await attachOk(id, 'evaluate', '/uemaster/PAN-1/evaluate-v002.html');

    expect(await stateOf(id)).toBe('inbox');
    expect(await artifactCount()).toBe(2);
    expect(await eventTypes()).toEqual([
      'requirement.created', 'uemaster.attached', 'uemaster.attached',
    ]);
    // 两份文件的链接不同（版本化之前它们是同一个 url，第二份把第一份盖掉了）。
    const urls = (await listArtifacts(db, id)).map((row) => row.url);
    expect(new Set(urls).size).toBe(2);
  });

  it('评审 / 走查材料同样不改状态', async () => {
    const { id } = await newRequirement();
    await attachOk(id, 'review', '/uemaster/PAN-1/review-v001.html');
    await attachOk(id, 'inspect', '/uemaster/PAN-1/inspect-v001.html');

    expect(await stateOf(id)).toBe('inbox');
    expect(await eventTypes()).toEqual([
      'requirement.created', 'uemaster.attached', 'uemaster.attached',
    ]);
  });

  it('待评审上重做评估材料：停在待评审（补材料不该变成回退）', async () => {
    const { id } = await newRequirement();
    await evaluate(db, '吕品', { requirementId: id });
    await submitReview(db, '吕品', { requirementId: id, prdUrl: 'https://x/prd' });
    expect(await stateOf(id)).toBe('review');

    await attachOk(id, 'evaluate', '/uemaster/PAN-1/evaluate-v002.html');

    expect(await stateOf(id)).toBe('review');
    expect(await artifactCount()).toBe(1);
    // 迁移事件只有立项那一条（来自前面的 evaluate），attach 一条都不添。
    expect((await eventTypes()).filter((t) => t === 'requirement.evaluated')).toHaveLength(1);
  });

  it('收集 + 没有类型：材料照样落地，状态照样不动（Ruling 1：类型不再是门）', async () => {
    const { id } = await newRequirement();
    await db.execute(sql`update requirements set type = null where id = ${id}`);

    await attachOk(id, 'evaluate', '/uemaster/PAN-1/evaluate-v001.html');

    expect(await stateOf(id)).toBe('inbox');
    expect(await artifactCount()).toBe(1);
    expect(await eventTypes()).toEqual(['requirement.created', 'uemaster.attached']);
  });

  it('收集里六问不齐：材料照样能落地（六问管的是「能不能立项 / 材料能不能编」的那道门，在生成入口上）', async () => {
    // 直接 attach（人手 / agent 交回材料）这条路不过六问门：门在「生成」与「立项」
    // 两处，而不是在所有写产物的地方。这条边界有意留在服务层：attach 收的是链接，
    // 它无从判断那份材料是按什么画出来的。
    const { id } = await createRequirement(db, '吕品', {
      title: '没有六问的需求', type: 'feature', requester: '孙建宏',
    });
    await attachOk(id, 'evaluate', '/uemaster/PAN-1/evaluate-v001.html');
    expect(await stateOf(id)).toBe('inbox');
  });
});

describe('listArtifacts', () => {
  it('没有产物时返回空数组', async () => {
    const { id } = await newRequirement();
    expect(await listArtifacts(db, id)).toEqual([]);
  });

  it('同一 stage 的每一版都给（新的在前），历史行要能点开', async () => {
    // 2026-11-10 起不再「每 stage 只给最新一行」：抽屉画「最新一份 + 历史（N 版）」，
    // 而历史版本必须打得开——只给最新一行的话，旧版本在库里有、在盘上有、在界面上
    // 一个入口都没有（那和丢掉只差一步）。
    const { id } = await newRequirement();
    await attachOk(id, 'evaluate', '/uemaster/PAN-1/evaluate-v001.html');
    await attachOk(id, 'evaluate', '/uemaster/PAN-1/evaluate-v002.html');
    const rows = await listArtifacts(db, id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.url)).toEqual([
      '/uemaster/PAN-1/evaluate-v002.html',
      '/uemaster/PAN-1/evaluate-v001.html',
    ]);
    expect(rows[0]!.at).toBeInstanceOf(Date);
    // 版本数两条行上都写着同一个数（它属于「这一组」，不属于某一行）。
    expect(rows.map((r) => r.versions)).toEqual([2, 2]);
    expect(rows.map((r) => r.contentLost)).toEqual([false, false]);
  });

  it('三个 stage 各一行（没有重做时），按固定顺序 evaluate → review → inspect', async () => {
    const { id } = await newRequirement();
    await attachOk(id, 'inspect', '/uemaster/PAN-1/inspect.html');
    await attachOk(id, 'evaluate', '/uemaster/PAN-1/evaluate.html');
    await attachOk(id, 'review', '/uemaster/PAN-1/review.html');
    const rows = await listArtifacts(db, id);
    expect(rows.map((r) => r.stage)).toEqual(['evaluate', 'review', 'inspect']);
  });

  it('只取本需求的产物', async () => {
    const a = await newRequirement();
    const b = await createRequirement(db, '吕品', { ...BRIEF,
      title: '另一个', type: 'commercial', requester: '孙建宏',
    });
    await attachOk(a.id, 'evaluate', '/uemaster/PAN-1/evaluate.html');
    await attachOk(b.id, 'review', '/uemaster/PAN-2/review.html');
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
