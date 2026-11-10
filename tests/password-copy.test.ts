import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT } from './helpers/files.js';

/**
 * 2026-11-10：用户可见的「口令」一律改叫「密码」。
 *
 * 为什么这一条要写成**全目录的守卫**而不是几条断言：文案是一种「漏一个就够刺眼」的
 * 东西。设置页写着「改密码」，成员行却写着「重置口令」，读的人会以为那是两件事
 * （界面上曾经真的是两套动作）。所以判据不是「这几个字符串改了」，而是**这两个目录
 * 里一个都不剩**。
 *
 * 两条例外，各自有理由：
 * - `src/db/seeds/prd-url-backfill.json`：那是**需求内容**（一条 PRD 标题里就写着
 *   「走生成口令的逻辑」），不是界面文案。改它等于改材料内容，超出这一条的范围。
 * - 标识符（`oldPassword`、`passwordHash`、`PasswordRow`…）：改名要动数据库列、
 *   会话票据与所有调用方，而这一条只要求**用户看到的字**统一。
 *
 * 判据是「文件里没有这两个字」：把任何一处改回去，这一条立刻红。
 */

const ROOTS = ['app', 'src'];
const DATA_SEEDS = path.join('src', 'db', 'seeds');

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full.endsWith(DATA_SEEDS)) continue;
      out.push(...await walk(full));
    } else if (/\.(?:ts|tsx|css|md)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('「口令」→「密码」', () => {
  it('app/ 与 src/ 里一处都不剩（数据种子除外）', async () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of await walk(path.join(REPO_ROOT, root))) {
        const text = await readFile(file, 'utf8');
        if (text.includes('口令')) offenders.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('界面上的那几处说的是「密码」', async () => {
    const read = (p: string): Promise<string> => readFile(path.join(REPO_ROOT, p), 'utf8');
    const me = await read('app/settings/MeSecurity.tsx');
    expect(me).toContain('<b>密码</b>');
    expect(me).toContain('旧密码');
    expect(me).toContain('新密码');

    const admin = await read('app/settings/MemberAdmin.tsx');
    expect(admin).toContain('重置密码');
    expect(admin).toContain('初始密码');
    expect(admin).toContain('新密码');

    // 登录页的字段本来就是「密码」，这条钉住它别再被改回去。
    const login = await read('app/login/page.tsx');
    expect(login).toContain('密码');

    // 错误消息（服务层，逐字给用户看）。
    const passwordChange = await read('app/password-change.ts');
    expect(passwordChange).toContain('旧密码不对');
    expect(passwordChange).toContain('两次输入的新密码不一致');
  });

  it('标识符与列名一个都没有跟着改（那是另一件事）', async () => {
    const read = (p: string): Promise<string> => readFile(path.join(REPO_ROOT, p), 'utf8');
    // 表单字段名 / 服务函数 / 列名：改了它们等于改协议，而这一条只改字。
    const me = await read('app/settings/MeSecurity.tsx');
    expect(me).toContain('name="oldPassword"');
    expect(me).toContain('name="newPassword"');
    expect(me).toContain('export function PasswordRow');

    const manage = await read('src/core/members/manage.ts');
    expect(manage).toContain('export async function resetPassword');

    const schema = await read('src/db/schema.ts');
    expect(schema).toContain("passwordHash: text('password_hash')");
  });
});
