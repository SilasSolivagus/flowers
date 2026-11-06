import { describe, expect, it } from 'vitest';
import {
  attemptLine, classifyFailure, scrubSecret, type AttemptView,
} from '../src/core/uemaster/trace.js';

/**
 * `classifyFailure` / `attemptLine` 的纯函数用例（P2.13）。
 *
 * 这一组不碰库、不碰网：分类是「一句话 → 一句标题」的翻译，它错的时候错得很安静
 * （界面上照样有一段字，只是那段字在替服务端瞎猜），所以每一类都用**真实见过的原文**
 * 钉住——openai 官方形状、国内网关形状、HTTP 状态行、以及 `provider.ts` 自己拼的两句。
 */

/** 一把足够长的假 key：短了会被 `sk-` 规则漏掉，反而测不出脱敏。 */
const KEY = 'sk-live-9f3Aq2LmZ0pX7cVtR1uYwB4nD8sHgJ6kE5oI';

type Row = {
  name: string;
  raw: string;
  kind: string;
  title: string;
  /** 期望的第二行（原文）；`null` 表示不该有第二行。 */
  detail: string | null;
};

const TABLE: Row[] = [
  // ── 余额 / 配额 ──
  {
    name: '配额 · 官方码（只有七个字母，不带第二行）',
    raw: 'insufficient_quota',
    kind: 'quota',
    title: '这个 key 余额不足',
    detail: null,
  },
  {
    name: '配额 · 网关的中文说法',
    raw: '当前账户余额不足，请充值后重试',
    kind: 'quota',
    title: '这个 key 余额不足',
    detail: '当前账户余额不足，请充值后重试',
  },
  {
    name: '配额 · 裸状态行',
    raw: 'HTTP 402 Payment Required',
    kind: 'quota',
    title: '这个 key 余额不足',
    detail: 'HTTP 402 Payment Required',
  },
  {
    name: '配额 · billing 措辞',
    raw: 'billing_hard_limit_reached',
    kind: 'quota',
    title: '这个 key 余额不足',
    detail: 'billing_hard_limit_reached',
  },
  // ── key 无效 ──
  {
    name: 'key 无效 · 一串 401',
    raw: '401',
    kind: 'invalid_key',
    title: '这个 key 无效',
    detail: null,
  },
  {
    name: 'key 无效 · 官方原文（key 已脱敏）',
    raw: `Incorrect API key provided: ${KEY}`,
    kind: 'invalid_key',
    title: '这个 key 无效',
    detail: 'Incorrect API key provided: sk-***',
  },
  {
    name: 'key 无效 · 下划线码',
    raw: 'invalid_api_key',
    kind: 'invalid_key',
    title: '这个 key 无效',
    detail: null,
  },
  {
    name: 'key 无效 · unauthorized',
    raw: 'Unauthorized',
    kind: 'invalid_key',
    title: '这个 key 无效',
    detail: null,
  },
  // ── 无权限 / 模型不可用 ──
  {
    name: '无权限 · 网关中文（分组/渠道）',
    raw: '分组 auto 下模型 gpt-5.4-mini 的可用渠道不存在',
    kind: 'no_access',
    title: '没有权限，或这个模型不可用',
    detail: '分组 auto 下模型 gpt-5.4-mini 的可用渠道不存在',
  },
  {
    name: '无权限 · 裸 403',
    raw: '403',
    kind: 'no_access',
    title: '没有权限，或这个模型不可用',
    detail: null,
  },
  {
    name: '无权限 · model not found',
    raw: 'The model `gpt-9` does not exist or you do not have access to it.',
    kind: 'no_access',
    title: '没有权限，或这个模型不可用',
    detail: 'The model `gpt-9` does not exist or you do not have access to it.',
  },
  // ── 限流 ──
  {
    name: '限流 · 裸 429',
    raw: '429',
    kind: 'rate_limit',
    title: '被限流了，过一会儿再试',
    detail: null,
  },
  {
    name: '限流 · 官方措辞',
    raw: 'Rate limit reached for requests',
    kind: 'rate_limit',
    title: '被限流了，过一会儿再试',
    detail: 'Rate limit reached for requests',
  },
  // ── 超时（我们自己的那句话）──
  {
    name: '超时 · provider.ts 自己的句子',
    raw: '请求超时：90 秒内没有响应',
    kind: 'timeout',
    title: '请求超时',
    detail: '请求超时：90 秒内没有响应',
  },
  // ── 网络 ──
  {
    name: '网络 · undici 的 fetch failed + cause',
    raw: '请求失败：fetch failed（connect ECONNREFUSED 127.0.0.1:9）',
    kind: 'network',
    title: '连不上模型接口',
    detail: '请求失败：fetch failed（connect ECONNREFUSED 127.0.0.1:9）',
  },
  {
    name: '网络 · 只有 DNS 错误码',
    raw: 'getaddrinfo ENOTFOUND router.example.com',
    kind: 'network',
    title: '连不上模型接口',
    detail: 'getaddrinfo ENOTFOUND router.example.com',
  },
  // ── 认不出来 ──
  {
    name: '未知 · 不发明诊断，原文就是标题',
    raw: '模型睡着了',
    kind: 'unknown',
    title: '模型睡着了',
    detail: null,
  },
];

describe('classifyFailure', () => {
  for (const row of TABLE) {
    it(`${row.name}`, () => {
      const failure = classifyFailure(row.raw);
      expect(failure.kind).toBe(row.kind);
      expect(failure.title).toBe(row.title);
      if (row.detail === null) expect(failure.detail).toBeUndefined();
      else expect(failure.detail).toBe(row.detail);
    });
  }

  it('未知形状：kind=unknown，且**没有**编出来的标题（标题就是原文）', () => {
    const raw = 'something the gateway said that we have never seen';
    const failure = classifyFailure(raw);
    expect(failure.kind).toBe('unknown');
    expect(failure.title).toBe(raw);
    expect(failure.detail).toBeUndefined();
  });

  it('空原文也能读：不返回空白标题', () => {
    const failure = classifyFailure('   ');
    expect(failure.kind).toBe('unknown');
    expect(failure.title.length).toBeGreaterThan(0);
  });

  it('分类结果里**绝不出现** api key（标题与第二行都断言）', () => {
    const shapes = [
      `Incorrect API key provided: ${KEY}`,
      `insufficient_quota (key=${KEY})`,
      `Authorization: Bearer ${KEY}`,
      `${KEY}`,
    ];
    for (const raw of shapes) {
      const failure = classifyFailure(raw);
      const shown = `${failure.title}\u0000${failure.detail ?? ''}`;
      expect(shown).not.toContain(KEY);
      expect(shown).not.toContain(KEY.slice(3));
    }
  });
});

describe('scrubSecret', () => {
  it('三种真实回显都洗得掉', () => {
    expect(scrubSecret(`key=${KEY}`)).not.toContain(KEY);
    expect(scrubSecret(`Authorization: Bearer ${KEY}`)).not.toContain(KEY);
    // 没有 sk- 前缀的随机串（有的网关自己发）也按长度兜住。
    expect(scrubSecret('token 9f3Aq2LmZ0pX7cVtR1uYwB4nD8sHgJ6kE5oI')).not.toContain(
      '9f3Aq2LmZ0pX7cVtR1uYwB4nD8sHgJ6kE5oI',
    );
  });

  it('不碰正常的中文与诊断句', () => {
    expect(scrubSecret('请求超时：90 秒内没有响应')).toBe('请求超时：90 秒内没有响应');
  });
});

// ─── 详情里那一行 ────────────────────────────────────────────────────────────

function attempt(over: Partial<AttemptView>): AttemptView {
  return {
    attempt: 1, phase: 'flow', model: 'gpt-5.4-mini',
    promptChars: 4000, outputChars: 320, error: null, ms: 900,
    ...over,
  };
}

describe('attemptLine', () => {
  it('形状判据那句话压成两个数字：`第 1 次 · flow · 2 个节点 1 条连线被拒`', () => {
    const line = attemptLine(attempt({
      error: '上一版只有 2 个节点、1 条连线，而要求是 3–8 个节点、至少 2 条连线',
    }));
    expect(line).toBe('第 1 次 · flow · 2 个节点 1 条连线被拒');
  });

  it('通过的那一次显示产出的字数', () => {
    expect(attemptLine(attempt({ attempt: 2, outputChars: 1203 })))
      .toBe('第 2 次 · flow · 1203 字');
  });

  it('别的理由不改写，只压平与截断', () => {
    const line = attemptLine(attempt({
      phase: 'pages',
      error: '节点 A 的片段没有使用 wt- 类；节点 B 的片段没有使用 wt- 类；节点 C 也没有',
    }));
    expect(line.startsWith('第 1 次 · pages · 节点 A 的片段没有使用 wt- 类')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
    expect(line.includes('\n')).toBe(false);
  });

  it('provider 的原文在详情里就是一个字都不改', () => {
    expect(attemptLine(attempt({ error: 'insufficient_quota' })))
      .toBe('第 1 次 · flow · insufficient_quota');
  });
});
