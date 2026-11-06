import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { AppError } from '../src/core/errors.js';
import { SERVICES } from '../mcp/services.js';
import {
  BAD_TOKEN, MISSING_TOKEN, authenticate, bearerOf, hashToken, listTokens, mintToken,
  revokeToken, scopeAllows,
} from '../mcp/tokens.js';
import { resetDb, seedPeople } from './helpers/db.js';

/**
 * token 这一层：**库里只有 hash**、**鉴权先于一切**、**scope 是包含关系**。
 *
 * 三件事各自对应一次真实的坏法：
 * 1. 存原文 → 库被读走就等于所有 token 被拿走（而且事后无法区分「谁泄露了」）；
 * 2. 没 token 也查一次库 → 一个陌生请求能让服务端替它做一次工作（还留下日志噪音）；
 * 3. 把 read 当成「除了写什么都能干」→ 一个只该看的人能排期，而排期就是承诺。
 */

let memberId = '';

beforeEach(async () => {
  await resetDb();
  const people = await seedPeople();
  memberId = people.find((person) => person.name === '吕品')!.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await pool.end();
});

async function caught(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected AppError, nothing thrown');
}

describe('mintToken', () => {
  it('库里存的是 sha256，不是原文', async () => {
    const minted = await mintToken(db, { memberId, label: 'claude-code', scopes: 'write' });

    const row = await db.execute<{ token_hash: string; label: string; scopes: string; revoked_at: unknown }>(
      sql`select token_hash, label, scopes, revoked_at from mcp_tokens where id = ${minted.id}`,
    );
    const stored = row.rows[0]!;
    expect(stored.token_hash).toBe(hashToken(minted.raw));
    expect(stored.token_hash).not.toBe(minted.raw);
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    // 原文哪一列都不许出现：这条断言比「等于 hash」更狠，它连「顺手多存一列」都拦。
    const dumped = JSON.stringify(stored);
    expect(dumped.includes(minted.raw)).toBe(false);
    expect(stored).toMatchObject({ label: 'claude-code', scopes: 'write', revoked_at: null });
  });

  it('形状是 flw_ + 43 个 base64url 字符，两次生成不重复', async () => {
    const a = await mintToken(db, { memberId, label: 'a', scopes: 'read' });
    const b = await mintToken(db, { memberId, label: 'b', scopes: 'read' });
    expect(a.raw).toMatch(/^flw_[A-Za-z0-9_-]{43}$/);
    expect(a.raw).not.toBe(b.raw);
  });

  it('label 空着直接拒绝——列表里三个 agent 撤谁？', async () => {
    const error = await caught(mintToken(db, { memberId, label: '   ', scopes: 'read' }));
    expect(error.code).toBe('invalid');
    expect(error.message).toContain('名字');
  });

  it('成员不存在时是一句中文，不是 PG 的 23503', async () => {
    const error = await caught(
      mintToken(db, {
        memberId: '00000000-0000-4000-8000-000000000000', label: 'x', scopes: 'read',
      }),
    );
    expect(error.code).toBe('not_found');
    expect(error.message).toBe('成员不存在');
  });
});

describe('authenticate', () => {
  it('好 token → 成员与权限，actor 是那个人的名字', async () => {
    const minted = await mintToken(db, { memberId, label: 'codex', scopes: 'write' });
    const got = await authenticate(db, `Bearer ${minted.raw}`);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.identity.member).toBe('吕品');
    expect(got.identity.memberId).toBe(memberId);
    expect(got.identity.scope).toBe('write');
    expect(got.identity.tokenId).toBe(minted.id);
  });

  it('scheme 大小写不敏感（RFC 7235），其它 scheme 一律当没有', async () => {
    const minted = await mintToken(db, { memberId, label: 'x', scopes: 'read' });
    expect(bearerOf(`bearer ${minted.raw}`)).toBe(minted.raw);
    expect(bearerOf(`Basic ${minted.raw}`)).toBeNull();
    expect(bearerOf(minted.raw)).toBeNull();
    expect(bearerOf(null)).toBeNull();
  });

  it('缺头 → 401，且**一次查询都不发**', async () => {
    const execute = vi.spyOn(db, 'execute');
    const got = await authenticate(db, null);
    expect(got).toEqual({ ok: false, status: 401, message: MISSING_TOKEN });
    expect(execute).not.toHaveBeenCalled();
  });

  it('形状不对 → 401，同样不查库', async () => {
    const execute = vi.spyOn(db, 'execute');
    for (const header of ['Bearer abc', 'Bearer flw_short', `Bearer ${'x'.repeat(60)}`]) {
      const got = await authenticate(db, header);
      expect(got).toEqual({ ok: false, status: 401, message: BAD_TOKEN });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('形状对但库里没有 → 401（不自造身份）', async () => {
    const got = await authenticate(db, `Bearer flw_${'A'.repeat(43)}`);
    expect(got).toEqual({ ok: false, status: 401, message: BAD_TOKEN });
  });

  it('已撤销 → 401，且撤销之后工具一个都调不到', async () => {
    const minted = await mintToken(db, { memberId, label: 'gone', scopes: 'write' });
    expect(await revokeToken(db, minted.id)).toBe(true);

    const got = await authenticate(db, `Bearer ${minted.raw}`);
    expect(got).toEqual({ ok: false, status: 401, message: BAD_TOKEN });
    // 撤销是软删除：行还在，`revoked_at` 有值——时间线上那些事件还指着这个 token。
    const row = await db.execute<{ revoked_at: Date | null }>(
      sql`select revoked_at from mcp_tokens where id = ${minted.id}`);
    expect(row.rows[0]!.revoked_at).not.toBeNull();
    // 再撤一次是 false（不是抛错）：连点两下「撤销」不该给一句报错。
    expect(await revokeToken(db, minted.id)).toBe(false);
  });

  it('401 时一个领域服务都没被调用', async () => {
    const show = vi.spyOn(SERVICES, 'getRequirementDetail');
    const create = vi.spyOn(SERVICES, 'createRequirement');
    await authenticate(db, null);
    await authenticate(db, 'Bearer flw_short');
    await authenticate(db, `Bearer flw_${'B'.repeat(43)}`);
    expect(show).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('scope', () => {
  it('read ⊂ write ⊂ admin', () => {
    expect(scopeAllows('write', 'read')).toBe(true);
    expect(scopeAllows('read', 'write')).toBe(false);
    expect(scopeAllows('admin', 'write')).toBe(true);
    expect(scopeAllows('admin', 'read')).toBe(true);
    expect(scopeAllows('read', 'read')).toBe(true);
  });
});

describe('listTokens', () => {
  it('列出全部（含已撤销），按生成时间倒序，不带原文', async () => {
    const first = await mintToken(db, { memberId, label: 'first', scopes: 'read' });
    await mintToken(db, { memberId, label: 'second', scopes: 'write' });
    await revokeToken(db, first.id);

    const rows = await listTokens(db);
    expect(rows.map((row) => row.label)).toEqual(['second', 'first']);
    expect(rows.every((row) => row.member === '吕品')).toBe(true);
    expect(rows[1]!.revokedAt).not.toBeNull();
    expect(JSON.stringify(rows)).not.toContain('flw_');
  });
});
