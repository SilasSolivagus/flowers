import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { AppError } from '../src/core/errors.js';
import {
  DEFAULT_MEMBER_PASSWORD, hashPassword, verifyHash,
} from '../src/core/auth/password.js';
import { attemptLogin } from '../src/core/auth/login.js';
import { createMember } from '../src/core/members/manage.js';
import { resetDb, seedPeople, type SeededPerson } from './helpers/db.js';
import { REPO_ROOT } from './helpers/files.js';

/**
 * 2026-11-10：初始密码统一为团队约定的那一条（owner 的裁定）。
 *
 * 三处口径必须**同一份**，任何一处漂了都会让「新人拿哪条密码登录」这件事重新变成
 * 一次猜谜：
 * 1. `createMember`（设置 · 成员 · 新增）不传密码时的默认值；
 * 2. 迁移 `0037`（存量七个人一次性落到这条上——哈希预先算好写在 SQL 里）；
 * 3. `scripts/seed.ts`（重灌之后的七个人）。
 *
 * 第 3 处只能读文件断言（脚本不该在用例里跑：它会 reset 整个库），前两处真跑。
 *
 * 判据是**能登进来**，不是「返回值等于某个字符串」：一条写进库里却验不过的哈希
 * 与没有密码是同一件事。迁移那一条尤其要这么测——那段 SQL 里的 `scrypt$…` 串是
 * 手写进去的，抄错一个字符不会报错，只会让所有人登不进来。
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

function emailOf(name: string): string {
  const found = people.find((person) => person.name === name);
  if (found === undefined) throw new Error(`名册里没有 ${name}`);
  return found.email;
}

describe('团队约定的初始密码', () => {
  it('是一个够长的明文（长度校验与新建走同一道门）', () => {
    expect(DEFAULT_MEMBER_PASSWORD.length).toBeGreaterThanOrEqual(8);
  });

  it('新增成员不传密码 → 默认就是那一条，而且真的能登进来', async () => {
    const created = await createMember(db, ADMIN, {
      name: '钱峰', email: 'qianfeng@123pan.com', role: 'pm', line: 'feature',
    });
    expect(created.password).toBe(DEFAULT_MEMBER_PASSWORD);
    // 判据在登录这条路上：库里的哈希必须验得过这一条明文。
    const who = await attemptLogin(db, 'qianfeng@123pan.com', DEFAULT_MEMBER_PASSWORD);
    expect(who.name).toBe('钱峰');
  });

  it('传了密码就按传的那条走（默认值不覆盖显式值）', async () => {
    const created = await createMember(db, ADMIN, {
      name: '钱峰', email: 'qianfeng@123pan.com', role: 'pm', line: 'feature',
      password: 'a-much-longer-secret',
    });
    expect(created.password).toBe('a-much-longer-secret');
    expect((await attemptLogin(db, 'qianfeng@123pan.com', 'a-much-longer-secret')).name).toBe('钱峰');
  });

  it('太短的显式密码仍然被拒（默认值不是绕过校验的后门）', async () => {
    await expect(createMember(db, ADMIN, {
      name: '钱峰', email: 'qianfeng@123pan.com', role: 'pm', line: 'feature', password: 'short',
    })).rejects.toBeInstanceOf(AppError);
  });

  it('重置密码仍然是**随机**的：它不是「把密码换回那一条」', async () => {
    const { resetPassword } = await import('../src/core/members/manage.js');
    const created = await createMember(db, ADMIN, {
      name: '钱峰', email: 'qianfeng@123pan.com', role: 'pm', line: 'feature',
    });
    const reset = await resetPassword(db, ADMIN, { memberId: created.member.id });
    expect(reset.password).not.toBe(DEFAULT_MEMBER_PASSWORD);
    expect((await attemptLogin(db, 'qianfeng@123pan.com', reset.password)).name).toBe('钱峰');
  });
});

describe('迁移 0037：存量成员落到同一条', () => {
  const FILE = path.join(REPO_ROOT, 'src', 'db', 'migrations', '0037_member_initial_password.sql');

  /** 从迁移文件里取出那个 scrypt 串（两条出现：set 与 where，值相同）。 */
  async function hashInMigration(): Promise<string> {
    const text = await readFile(FILE, 'utf8');
    const found = /'(scrypt\$[^']+)'/.exec(text)?.[1];
    if (found === undefined) throw new Error('迁移里没有 scrypt 串');
    return found;
  }

  it('文件里的哈希验得过那一条明文（抄错一个字符就红）', async () => {
    const hash = await hashInMigration();
    expect(await verifyHash(DEFAULT_MEMBER_PASSWORD, hash)).toBe(true);
    // 别的密码验不过：这条断言挡住「哈希是随便一串」的情况。
    expect(await verifyHash('2026@1234', hash)).toBe(false);
  });

  it('文件里没有明文（只有派生键），也没有把别人的密码写进去', async () => {
    const text = await readFile(FILE, 'utf8');
    expect(text).not.toContain(DEFAULT_MEMBER_PASSWORD);
    expect(text).toContain('password_updated_at = now()');
    // 改密码要让旧票作废，这一句不能少（见 setPassword 的同一条口径）。
    expect(text).toContain('session_epoch = now()');
  });

  it('真跑一遍迁移的语义：七个成员都能用那一条登进来', async () => {
    // 迁移已在 globalSetup 里跑过（空库上没有行）；这里按迁移的 SQL 复现一次，
    // 断言「所有人都落到同一条上」这件事本身，而不是只信文件里的字符串。
    const hash = await hashPassword(DEFAULT_MEMBER_PASSWORD);
    await db.execute(sql`
      update members
         set password_hash = ${hash},
             password_updated_at = now(),
             session_epoch = now()
       where password_hash is distinct from ${hash}`);

    const stored = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from members where password_hash = ${hash}`);
    expect(Number(stored.rows[0]?.n ?? 0)).toBe(people.length);

    for (const person of people) {
      const who = await attemptLogin(db, person.email, DEFAULT_MEMBER_PASSWORD);
      expect(who.name).toBe(person.name);
    }
    // 登录名仍然是邮箱（这条不是「按名字随便进」）。
    expect(emailOf(ADMIN)).toBe('fangchao@123pan.com');
  });
});

describe('种子与新增读的是同一个常量', () => {
  it('scripts/seed.ts 不再随机生成密码、也不再打印明文', async () => {
    const text = await readFile(path.join(REPO_ROOT, 'scripts', 'seed.ts'), 'utf8');
    expect(text).toContain('DEFAULT_MEMBER_PASSWORD');
    expect(text).not.toContain('generatePassword');
    expect(text).not.toContain('${password}');
  });
});
