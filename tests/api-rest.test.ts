import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import { handleApiRequest } from '../src/api/router.js';
import { mintToken } from '../mcp/tokens.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { createRelease } from '../src/core/releases/manage.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { BRIEF } from './helpers/brief.js';

/**
 * REST 面（2026-11-11，H2）。
 *
 * 这一组钉三件事：
 * 1. 没 token → 401，且**公开端点**（skills / meta）不需要 token；
 * 2. 读接口的参数穿透到工具（q / state / limit）——脚本不该被迫用 MCP 协议才查得动；
 * 3. 写接口走同一批服务：权限与规则照旧（PM 改别人的需求还是 forbidden）。
 */

const WHO = '吕品';

async function token(scope: 'read' | 'write' = 'write', member = WHO): Promise<string> {
  const res = await db.execute<{ id: string }>(sql`select id from members where name = ${member}`);
  const minted = await mintToken(db, { memberId: res.rows[0]!.id, label: 'test', scopes: scope });
  return minted.raw;
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, init);
}

function withToken(raw: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' } };
}

beforeEach(async () => {
  await resetDb();
  await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

describe('鉴权与公开端点', () => {
  it('没有 token → 401；skills / meta 不需要 token', async () => {
    expect((await handleApiRequest(req('/api/v1/requirements'))).status).toBe(401);

    const skills = await handleApiRequest(req('/api/v1/skills/flowers-ops'));
    expect(skills.status).toBe(200);
    const bundle = await skills.json() as { name: string; version: string; files: Array<{ path: string }> };
    expect(bundle.name).toBe('flowers-ops');
    expect(bundle.version).toMatch(/^[0-9a-f]{12}$/);
    expect(bundle.files.map((f) => f.path)).toContain('flowers-ops/flowers.mjs');

    const meta = await handleApiRequest(req('/api/v1/meta'));
    expect(meta.status).toBe(200);
    expect((await meta.json() as { skillUrl: string }).skillUrl).toContain('/api/v1/skills/flowers-ops');
  });
});

describe('读：查询参数穿透', () => {
  it('列表按 q / state 过滤，limit 生效', async () => {
    await createRequirement(db, WHO, { ...BRIEF, title: 'S3 协议支持', type: 'feature', requester: 'x' });
    await createRequirement(db, WHO, { ...BRIEF, title: '分享页搜索', type: 'feature', requester: 'x' });
    const raw = await token('read');

    const res = await handleApiRequest(req('/api/v1/requirements?q=s3&limit=1', withToken(raw)));
    expect(res.status).toBe(200);
    const body = await res.json() as { total: number; count: number; requirements: Array<{ title: string }> };
    expect(body.total).toBe(1);
    expect(body.count).toBe(1);
    expect(body.requirements[0]!.title).toBe('S3 协议支持');
  });

  it('成员与版本列表：给的是 UUID', async () => {
    await createRelease(db, '房超', { name: 'R-1', windowStart: '2026-12-01', releaseDate: '2026-12-20', goal: null, note: null });
    const raw = await token('read');

    const members = await (await handleApiRequest(req('/api/v1/members', withToken(raw)))).json() as { members: Array<{ id: string; name: string }> };
    expect(members.members.some((m) => m.name === WHO)).toBe(true);

    const releases = await (await handleApiRequest(req('/api/v1/releases', withToken(raw)))).json() as { releases: Array<{ id: string; name: string }> };
    expect(releases.releases[0]!.name).toBe('R-1');
  });
});

describe('写：规则照旧', () => {
  it('PATCH 改标题 → 200；别人的需求 → 403 forbidden', async () => {
    const mine = await createRequirement(db, WHO, { ...BRIEF, title: '我的需求', type: 'feature', requester: 'x' });
    const raw = await token('write');

    const ok = await handleApiRequest(req(`/api/v1/requirements/${mine.id}`, withToken(raw, {
      method: 'PATCH', body: JSON.stringify({ title: '改过的标题' }),
    })));
    expect(ok.status).toBe(200);

    const other = await createRequirement(db, '王妍', { ...BRIEF, title: '王妍的需求', type: 'feature', requester: 'x' });
    const denied = await handleApiRequest(req(`/api/v1/requirements/${other.id}`, withToken(raw, {
      method: 'PATCH', body: JSON.stringify({ title: '不该改' }),
    })));
    expect(denied.status).toBe(403);
    expect((await denied.json() as { error: string }).error).toContain('forbidden');
  });

  it('read token 调写接口 → 400 且说明权限不足', async () => {
    const mine = await createRequirement(db, WHO, { ...BRIEF, title: 'x', type: 'feature', requester: 'x' });
    const raw = await token('read');
    const res = await handleApiRequest(req(`/api/v1/requirements/${mine.id}`, withToken(raw, {
      method: 'PATCH', body: JSON.stringify({ title: 'y' }),
    })));
    expect(res.status).toBe(400);
    expect((await res.json() as { message: string }).message).toContain('权限');
  });

  it('动作路由：claim 把一个无主需求接到自己名下', async () => {
    const created = await createRequirement(db, '房超', {
      ...BRIEF, title: '无主', type: 'feature', requester: 'x', ownerMemberId: null,
    });
    const raw = await token('write');
    const res = await handleApiRequest(req(`/api/v1/requirements/${created.id}/actions/claim`, withToken(raw, { method: 'POST' })));
    expect(res.status).toBe(200);
    expect((await res.json() as { owner: string }).owner).toBe(WHO);
  });
});
