'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ROLES, ROLE_LABEL, type Role } from '../../src/core/auth/roles';
import type { MemberAdminRow } from '../../src/core/read/member-admin';
import {
  createMemberAction, deactivateMemberAction, resetPasswordAction, transferOwnedAction,
  updateMemberAction, type ActionResult,
} from '../actions';
import { LINE_LABEL, lineLabel } from './roles';

/**
 * 设置 · 成员（P4-05）：只给超管的那一页。
 *
 * 三件事，全部只摆字段与值：
 * 1. **列表**：名字 / 角色 / 条线 / 状态（在用 / 已停用）/ 负责需求数。已停用的人也
 *    出现在列表里——历史行还指着他，删掉一行不会让那条审计线消失。
 * 2. **新增**：名字 + 邮箱 + 角色 + 条线。邮箱是**登录名**（P4-08），不填这个人就登不
 *    进来；初始密码是**团队统一的那一条**（2026-11-10 起，由服务端作为 prop 传进来，
 *    这一层不 import 任何带 `node:crypto` 的模块）。它出现在两个地方：表单上先写清
 *    「新成员会拿到哪一条」，建完之后再回显一次——两个地方都带**改的入口**
 *    （「我的」→「密码」），因为一条大家都知道的密码必须有一条明确的改法。
 * 3. **改**：角色 / 条线 / 停用 / 重置口令（同样只显示一次）。停用还占着需求的负责人时，
 *    服务层会拒绝并说「这个人还负责 N 条需求，先转交」——那句话原文显示在行下，
 *    旁边就是「转交」：选一个人，一次把他名下全部需求转过去（逐条走 `reassignOwner`，
 *    权限与事件都由那个服务回答）。
 *
 * 权限一条都没有写在这里：这一页能不能渲染由服务端 `memberAdminView` 决定，
 * 每个动作能不能成由 `src/core/members/manage.ts` 的 `assertCan` 决定。界面只负责
 * 把拒绝的那句话放在被拒绝的那一行下面。
 */

const LINES_OPTION = ['feature', 'commercial'] as const;

function roleOptions(): Role[] {
  return [...ROLES];
}

/** 新增成员：一行入口，展开三格。 */
function NewMemberRow({ defaultPassword }: { defaultPassword: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('pm');
  const [line, setLine] = useState<'feature' | 'commercial'>('feature');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState<string | null>(null);

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set('name', name);
    form.set('email', email);
    form.set('role', role);
    form.set('line', role === 'product_owner' ? '' : line);
    try {
      const result = await createMemberAction(form);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setPassword(result.password);
      setName('');
      setEmail('');
      setOpen(false);
      router.refresh();
    } catch {
      setError('新增没有送达');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="i gen-row">
        <div className="l"><b>新增成员</b></div>
        <div className="v gen-actions">
          <button
            className="btn sm"
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
          >
            {open ? '取消' : '新增'}
          </button>
        </div>
      </div>
      {open && (
        <div className="i gen-detail mk-form">
          <label className="mk-f">
            <span>名字</span>
            <input
              className="gen-input"
              type="text"
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="mk-f">
            <span>邮箱</span>
            <input
              className="gen-input"
              type="email"
              autoComplete="off"
              placeholder="lvpin@123pan.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="mk-f">
            <span>角色</span>
            <select
              className="gen-input"
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              {roleOptions().map((value) => (
                <option key={value} value={value}>{ROLE_LABEL[value]}</option>
              ))}
            </select>
          </label>
          {role !== 'product_owner' && (
            <label className="mk-f">
              <span>条线</span>
              <select
                className="gen-input"
                value={line}
                onChange={(event) => setLine(event.target.value as 'feature' | 'commercial')}
              >
                {LINES_OPTION.map((value) => (
                  <option key={value} value={value}>{LINE_LABEL[value]}</option>
                ))}
              </select>
            </label>
          )}
          {/* 初始密码先写在**建之前**：建完才告诉人「他拿到的是一条公共密码」太晚，
              那时人已经准备把它发出去了。 */}
          <div className="mk-note">
            初始密码：<code>{defaultPassword}</code>（统一的一条；他可以在「我的 → 密码」里自己改）
          </div>
          <div className="mk-acts">
            <button className="btn sm primary" type="button" disabled={busy} onClick={() => void create()}>
              新增
            </button>
            <button className="btn ghost sm" type="button" disabled={busy} onClick={() => setOpen(false)}>
              取消
            </button>
          </div>
        </div>
      )}
      {error !== null && (
        <div className="i gen-detail"><div className="gen-msg bad">{error}</div></div>
      )}
      {password !== null && (
        <div className="i gen-detail">
          <div className="pw-once">
            <b>初始密码</b><code>{password}</code>
            <span className="pw-hint">他登录后可以在「我的 → 密码」里自己改</span>
          </div>
        </div>
      )}
    </>
  );
}

/** 一行成员 + 它自己的四个动作。 */
function MemberRow({ row, rows }: { row: MemberAdminRow; rows: MemberAdminRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<Role>(row.role as Role);
  const [line, setLine] = useState<'feature' | 'commercial'>(
    row.line === 'commercial' ? 'commercial' : 'feature',
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [transfer, setTransfer] = useState(false);
  const [target, setTarget] = useState('');
  /** 可转交对象：活着的、不是他自己的人。全部给出来——超管不受本线限制。 */
  const others = rows.filter((item) => item.active && item.id !== row.id);

  const call = async (kind: string, form: FormData, run: (fd: FormData) => Promise<ActionResult>): Promise<void> => {
    setBusy(kind);
    setError(null);
    try {
      const result = await run(form);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      setPassword(null);
      setTransfer(false);
      router.refresh();
    } catch {
      setError('请求没有送达');
    } finally {
      setBusy(null);
    }
  };

  const save = async (): Promise<void> => {
    const form = new FormData();
    form.set('memberId', row.id);
    form.set('role', role);
    form.set('line', role === 'product_owner' ? 'none' : line);
    await call('save', form, updateMemberAction);
  };

  const deactivate = async (): Promise<void> => {
    const form = new FormData();
    form.set('memberId', row.id);
    await call('off', form, deactivateMemberAction);
  };

  const reset = async (): Promise<void> => {
    setBusy('reset');
    setError(null);
    const form = new FormData();
    form.set('memberId', row.id);
    try {
      const result = await resetPasswordAction(form);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setPassword(result.password);
    } catch {
      setError('重置没有送达');
    } finally {
      setBusy(null);
    }
  };

  const move = async (): Promise<void> => {
    const form = new FormData();
    form.set('fromMemberId', row.id);
    form.set('toMemberId', target);
    await call('move', form, transferOwnedAction);
  };

  return (
    <>
      <div className="i gen-row" data-member={row.name}>
        <div className="l">
          <b>{row.name}</b>
          <span className="mem-sub">
            {ROLE_LABEL[row.role as Role] ?? row.role} · {lineLabel(row.line) || '—'}
          </span>
          {/* 登录名（P4-08）：这一行回答「这个人怎么登进来」。它不是名字的重复——
              名字是身份，邮箱是凭证，两者可能完全不同。 */}
          <span className="mem-sub">{row.email}</span>
        </div>
        <div className="v gen-actions">
          <span className={`pill ${row.active ? 'ok' : 'no'}`}>{row.active ? '在用' : '已停用'}</span>
          <span className="mem-owned">{row.owned} 条</span>
          {row.active && (
            <>
              <button
                className="btn ghost sm"
                type="button"
                data-act="edit"
                aria-expanded={open}
                onClick={() => setOpen((was) => !was)}
              >
                {open ? '收起' : '改'}
              </button>
              <button
                className="btn sm"
                type="button"
                data-act="reset"
                disabled={busy !== null}
                onClick={() => void reset()}
              >
                重置口令
              </button>
              <button
                className="btn sm"
                type="button"
                data-act="deactivate"
                disabled={busy !== null}
                onClick={() => void deactivate()}
              >
                停用
              </button>
              {row.owned > 0 && others.length > 0 && (
                <button
                  className="btn sm"
                  type="button"
                  data-act="transfer"
                  aria-expanded={transfer}
                  onClick={() => setTransfer((was) => !was)}
                >
                  转交
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {open && row.active && (
        <div className="i gen-detail mk-form">
          <label className="mk-f">
            <span>角色</span>
            <select
              className="gen-input"
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              {roleOptions().map((value) => (
                <option key={value} value={value}>{ROLE_LABEL[value]}</option>
              ))}
            </select>
          </label>
          {role !== 'product_owner' && (
            <label className="mk-f">
              <span>条线</span>
              <select
                className="gen-input"
                value={line}
                onChange={(event) => setLine(event.target.value as 'feature' | 'commercial')}
              >
                {LINES_OPTION.map((value) => (
                  <option key={value} value={value}>{LINE_LABEL[value]}</option>
                ))}
              </select>
            </label>
          )}
          <div className="mk-acts">
            <button className="btn sm primary" type="button" disabled={busy !== null} onClick={() => void save()}>
              保存
            </button>
            <button className="btn ghost sm" type="button" disabled={busy !== null} onClick={() => setOpen(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      {transfer && row.owned > 0 && others.length > 0 && (
        <div className="i gen-detail mk-form">
          <label className="mk-f">
            <span>接手</span>
            <select
              className="gen-input"
              data-target
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              <option value="">请选择</option>
              {others.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
          <div className="mk-acts">
            <button
              className="btn sm primary"
              type="button"
              data-act="transfer-run"
              disabled={busy !== null || target === ''}
              onClick={() => void move()}
            >
              转交
            </button>
          </div>
        </div>
      )}

      {error !== null && (
        <div className="i gen-detail"><div className="gen-msg bad">{error}</div></div>
      )}
      {password !== null && (
        <div className="i gen-detail">
          <div className="pw-once"><b>新口令</b><code>{password}</code></div>
        </div>
      )}
    </>
  );
}

/**
 * `defaultPassword` 由服务端页面传进来（`DEFAULT_MEMBER_PASSWORD`）：这一层是
 * `'use client'`，直接 import `src/core/auth/password.ts` 会把 `node:crypto` 拖进
 * 浏览器包。值本身不是秘密（它就是「统一的那一条」），秘密的是**没有第二份字面量**。
 */
export function MemberAdmin({ rows, defaultPassword }: {
  rows: MemberAdminRow[];
  defaultPassword: string;
}) {
  return (
    <section className="sg">
      <div className="h">成员</div>
      <NewMemberRow defaultPassword={defaultPassword} />
      {rows.map((row) => <MemberRow key={row.id} row={row} rows={rows} />)}
    </section>
  );
}

export default MemberAdmin;
