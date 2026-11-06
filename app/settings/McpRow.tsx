'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Scope } from '../../mcp/tokens';
import { mintMcpTokenAction, revokeMcpTokenAction } from './mcp-actions';

/**
 * 设置页「我的」栏里那一格：**接你的 agent**。
 *
 * 一行解释都没有，只有标签与值（这一页的铁律）：端点、生成、复制、撤销。
 *
 * 这一格与「我的模型 key」是同一张脸的两种东西：那边是「我拿什么干活」，这边是
 * 「别人怎么把活交给我」。所以形状照抄——一行值 + 两个按钮，点开才有表单；
 * 生成出来的东西留在行下面，不弹窗、不 toast。
 *
 * 三条口径：
 *
 * 1. **token 原文只显示这一次。** 生成之后它就只活在这个组件的 state 里；刷新、
 *    切 tab、换个人打开，那一行都只剩「label + 日期 + 撤销」。库里存的是 sha256
 *    （`mcp/tokens.ts`），所以这不是「没做显示」，是拿不回来。
 * 2. **每条粘贴行都是完整的、能直接执行的。** 三个客户端各一行：Claude Code 是
 *    `claude mcp add …`，Cursor 是 `.cursor/mcp.json` 里那一行 JSON，Codex 是
 *    `codex mcp add …`。刚生成的那一秒，行里带的就是真 token（可以照着粘）；
 *    没生成时占位符是 `<token>`，人一眼看得出还要替换。
 * 3. **撤销是软删除。** 那一行变成「已撤销」而不是消失：它写过的事件还指着它，
 *    列表里少了那一行，owner 会以为是自己记错了。
 */

export type McpTokenRow = {
  id: string;
  label: string;
  member: string;
  scope: Scope;
  /** 生成那天（服务端已折成上海日历日，客户端不再算时区）。 */
  createdDay: string;
  /** 撤销那天；null = 还活着。 */
  revokedDay: string | null;
};

/** 三个客户端各一行。`token` 是刚生成的原文，没有时用占位符。 */
function snippets(endpoint: string, token: string): Array<{ client: string; line: string }> {
  return [
    {
      client: 'Claude Code',
      line: `claude mcp add --transport http flowers ${endpoint} --header "Authorization: Bearer ${token}"`,
    },
    {
      client: 'Cursor',
      line: `{"mcpServers":{"flowers":{"url":"${endpoint}","headers":{"Authorization":"Bearer ${token}"}}}}`,
    },
    {
      client: 'Codex',
      line: `codex mcp add flowers --url ${endpoint} --bearer-token-env-var FLOWERS_MCP_TOKEN`,
    },
  ];
}

const SCOPE_TEXT: Record<Scope, string> = { read: '只读', write: '读写', admin: '管理' };

export function McpRow({ endpoint, tokens }: { endpoint: string; tokens: McpTokenRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('claude-code');
  const [scope, setScope] = useState<Scope>('write');
  /** 刚生成的那一枚。只在这一次会话里存在——刷新之后拿不回来（库里只有 hash）。 */
  const [minted, setMinted] = useState<{ raw: string; label: string } | null>(null);
  const [busy, setBusy] = useState<'mint' | 'revoke' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (key: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
    } catch {
      // 剪贴板被拒（非 https、或浏览器策略）时不说「已复制」——那是假话。
      setError('复制失败：浏览器不让写剪贴板，手动选中吧');
    }
  };

  const mint = async (): Promise<void> => {
    setBusy('mint');
    setError(null);
    try {
      const form = new FormData();
      form.set('label', label);
      form.set('scopes', scope);
      const done = await mintMcpTokenAction(form);
      if (!done.ok) {
        setError(done.message);
        return;
      }
      setMinted({ raw: done.raw, label: done.label });
      setOpen(false);
      router.refresh();
    } catch {
      setError('生成没有送达');
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (id: string): Promise<void> => {
    setBusy('revoke');
    setError(null);
    try {
      const form = new FormData();
      form.set('id', id);
      const done = await revokeMcpTokenAction(form);
      if (!done.ok) {
        setError(done.message);
        return;
      }
      router.refresh();
    } catch {
      setError('撤销没有送达');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="sg">
      <div className="i gen-row">
        <div className="l"><b>接你的 agent</b></div>
        <div className="v gen-actions">
          <span className="gen-src mcp-end">{endpoint}</span>
          <button className="btn ghost sm" type="button" onClick={() => void copy('endpoint', endpoint)}>
            {copied === 'endpoint' ? '已复制' : '复制'}
          </button>
          <button
            className="btn sm"
            type="button"
            aria-expanded={open}
            disabled={busy !== null}
            onClick={() => {
              setOpen((value) => !value);
              setError(null);
            }}
          >
            {open ? '取消' : '生成 token'}
          </button>
        </div>
      </div>

      {open && (
        <div className="i gen-detail mcp-form">
          <label className="mk-f">
            <span>名字</span>
            <input
              className="gen-input"
              type="text"
              spellCheck={false}
              autoComplete="off"
              value={label}
              placeholder="claude-code"
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <label className="mk-f">
            <span>权限</span>
            <select
              className="gen-input"
              value={scope}
              onChange={(event) => setScope(event.target.value as Scope)}
            >
              <option value="read">只读</option>
              <option value="write">读写</option>
            </select>
          </label>
          <div className="mk-acts">
            <button className="btn sm" type="button" disabled={busy !== null} onClick={() => void mint()}>
              {busy === 'mint' ? '生成中' : '生成'}
            </button>
            <button className="btn ghost sm" type="button" disabled={busy !== null} onClick={() => setOpen(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* 刚生成的那一刻：原文 + 复制 + 那句必须说的话。它排在粘贴行的**上面**，
          因为「先把这个 token 收好」发生在「把它粘进客户端」之前。 */}
      {minted !== null && (
        <div className="i gen-detail mcp-token">
          <div className="mcp-pair">
            <code>{minted.raw}</code>
            <button
              className="btn ghost sm"
              type="button"
              onClick={() => void copy('raw', minted.raw)}
            >
              {copied === 'raw' ? '已复制' : '复制'}
            </button>
          </div>
          <div className="gen-msg bad">{`「${minted.label}」只显示这一次：关掉就看不到了，库里只有它的 sha256`}</div>
        </div>
      )}

      {snippets(endpoint, minted?.raw ?? '<token>').map((item) => (
        <div className="i mcp-line" key={item.client}>
          <div className="l"><b>{item.client}</b></div>
          <div className="v mcp-pair">
            <code>{item.line}</code>
            <button
              className="btn ghost sm"
              type="button"
              onClick={() => void copy(item.client, item.line)}
            >
              {copied === item.client ? '已复制' : '复制'}
            </button>
          </div>
        </div>
      ))}

      {tokens.map((token) => (
        <div className="i" key={token.id}>
          <div className="l">
            <b>{token.label}</b>
            <span className="mcp-sub">{`${SCOPE_TEXT[token.scope]} · ${token.member} · ${token.createdDay}`}</span>
          </div>
          <div className="v gen-actions">
            {token.revokedDay === null
              ? (
                <button
                  className="btn ghost sm"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void revoke(token.id)}
                >
                  撤销
                </button>
              )
              : <span className="pill no">{`已撤销 · ${token.revokedDay}`}</span>}
          </div>
        </div>
      ))}

      {error !== null && (
        <div className="i gen-detail">
          <div className="gen-msg bad">{error}</div>
        </div>
      )}
    </section>
  );
}

export default McpRow;
