import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderToStaticMarkup } from 'react-dom/server';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import {
  keyTail, memberKeyText, type MemberKeyView,
} from '../src/core/uemaster/candidates.js';
import {
  configOf, memberKeyView, memberProviderKey, memberProviderParts, memberProviderSettings,
  saveMemberProviderSettings,
} from '../src/core/uemaster/member-provider.js';
import {
  PROBE_MAX_TOKENS, PROBE_TIMEOUT_MS, probeProvider, resolveProvider, resolveProviderConfig,
} from '../src/core/uemaster/provider.js';
import { saveProviderSettings } from '../src/core/uemaster/settings.js';
import { resolveStrategy } from '../src/core/uemaster/start.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { MemberKeyRow } from '../app/settings/MemberKeyRow';

/**
 * P2.12：**每个人自己的模型 key**。
 *
 * 要证明的五件事：
 * 1. 成员那三格排在平台之前，且**不拼半份**——只填了其中一格的成员整层作废、
 *    退回平台那一份（拼出来的半份会把一个人的 key 发到另一个人填的地址上）；
 * 2. `resolveStrategy()` 问的是**这次生成的那个人**：同一个部署里，配了 key 的人走
 *    provider，没配的人走 CLI；
 * 3. 设置页那一行只说三种状态（未配置 / 平台统一模型 · x / x），文案由判据拼；
 * 4. key 不出现在任何视图对象与渲染出来的那一行里（最多带末 4 位）；
 * 5. 「测试」把服务端的原文带回那一行、不抛，通过才落库。
 *
 * 网络一律打到本机的 stub provider（`http.createServer` + 临时端口）：这里测的是
 * 真的 `fetch`、真的 15 秒超时口径、真的 HTTP 状态码，一条外部请求都不发。
 */

// ─── 一个真的 provider（与 tests/provider.test.ts 同一种形状） ───────────────

type Reply = { status: number; body: string } | null;

type Call = { url: string; auth: string; body: string };

type Stub = { baseUrl: string; calls: Call[]; close: () => Promise<void> };

async function startStub(reply: (call: Call) => Reply): Promise<Stub> {
  const calls: Call[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      const call: Call = { url: req.url ?? '', auth: String(req.headers.authorization ?? ''), body };
      calls.push(call);
      const answer = reply(call);
      if (answer === null) return;
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/** 一个最小可用的 chat 响应体（带 usage，好让那一行能写出 token 数）。 */
function chatBody(content: string, usage?: { prompt_tokens: number; completion_tokens: number }): string {
  return JSON.stringify({
    id: 'chatcmpl-probe',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    ...(usage === undefined ? {} : { usage }),
  });
}

// ─── 环境与库 ────────────────────────────────────────────────────────────────

const ENV = {
  url: 'FLOWERS_PROVIDER_BASE_URL',
  key: 'FLOWERS_PROVIDER_API_KEY',
  model: 'FLOWERS_PROVIDER_MODEL',
} as const;

function clearEnv(): void {
  for (const name of Object.values(ENV)) delete process.env[name];
}

const PLATFORM = {
  baseUrl: 'https://platform.example.test/v1',
  apiKey: 'sk-platform-0000000000',
  model: 'platform-model',
};

const OWN = {
  baseUrl: 'https://own.example.test/v1',
  apiKey: 'sk-own-ABCDEFGH9876',
  model: 'own-model',
};

/** 名册里那个人的 id（`seedPeople` 灌的五个成员）。 */
async function idOf(name: string): Promise<string> {
  // 直接查，不经过被测量的那一条路（`memberIdByName` 是入口，不该同时当夹具）。
  const people = await db.execute<{ id: string }>(
    sql`select id from members where name = ${name}`,
  );
  const id = people.rows[0]?.id;
  if (id === undefined) throw new Error(`名册里没有 ${name}`);
  return id;
}

describe('P2.12 成员作用域的三格', () => {
  beforeEach(async () => {
    clearEnv();
    await resetDb();
    await seedPeople();
  });

  it('键名是 member.<id>.provider.<字段>，只在一处拼', () => {
    expect(memberProviderKey('m-1', 'baseUrl')).toBe('member.m-1.provider.baseUrl');
    expect(memberProviderKey('m-1', 'apiKey')).toBe('member.m-1.provider.apiKey');
    expect(memberProviderKey('m-1', 'model')).toBe('member.m-1.provider.model');
  });

  it('成员自己那三格赢过平台的三格，且 scope 说得出是谁的那一份', async () => {
    const id = await idOf('吕品');
    await saveProviderSettings(db, PLATFORM);
    await saveMemberProviderSettings(db, id, OWN);

    expect(await memberProviderSettings(db, id)).toEqual(OWN);
    expect(await resolveProviderConfig('吕品')).toEqual(OWN);
    expect((await resolveProvider('吕品'))?.scope).toBe('member');
    // 别人的那一层不受影响：房超没配，看到的是平台那一份。
    expect((await resolveProvider('房超'))?.scope).toBe('platform');
  });

  it('只填了一格：整层作废——不拼半份，也不退到平台（平台只给超管）', async () => {
    const id = await idOf('吕品');
    await saveProviderSettings(db, PLATFORM);
    // 只填了 key（地址与模型留空）：这不是一份能发请求的配置。
    await saveMemberProviderSettings(db, id, { apiKey: 'sk-half-000000' });

    expect(await memberProviderSettings(db, id)).toBeNull();
    // 2026-11-11：平台那三格只服务超管本人，PM 半份配置 = 没有配置。
    expect(await resolveProviderConfig('吕品')).toBeNull();
  });

  it('一格都没填：PM 拿不到平台那份；超管才拿得到', async () => {
    const id = await idOf('吕品');
    await saveProviderSettings(db, PLATFORM);
    expect(await memberProviderSettings(db, id)).toBeNull();
    expect(await resolveProviderConfig('吕品')).toBeNull();
    expect(await resolveProviderConfig('房超')).toEqual(PLATFORM);
  });

  it('两层都没有：null（「还没配」，不是错误）', async () => {
    expect(await resolveProviderConfig('吕品')).toBeNull();
    expect(await resolveProvider('吕品')).toBeNull();
    // 也没有成员这个人时同样是 null。
    expect(await resolveProviderConfig()).toBeNull();
  });

  it('env 排在成员之前：一个部署级覆盖仍然说了算', async () => {
    const id = await idOf('吕品');
    await saveMemberProviderSettings(db, id, OWN);
    process.env[ENV.url] = 'https://env.example.test/v1';
    process.env[ENV.key] = 'sk-env-11111111';
    process.env[ENV.model] = 'env-model';
    try {
      expect(await resolveProviderConfig('吕品'))
        .toEqual({ baseUrl: 'https://env.example.test/v1', apiKey: 'sk-env-11111111', model: 'env-model' });
      expect((await resolveProvider('吕品'))?.scope).toBe('env');
    } finally {
      clearEnv();
    }
  });

  it('名册里没有这个人：两层都不给（身份不明不动别人的 key）', async () => {
    const id = await idOf('吕品');
    await saveMemberProviderSettings(db, id, OWN);
    await saveProviderSettings(db, PLATFORM);
    expect(await resolveProviderConfig('查无此人')).toBeNull();
  });

  it('resolveStrategy 问的是这次生成的那个人', async () => {
    const id = await idOf('吕品');
    await saveMemberProviderSettings(db, id, OWN);

    // 平台上**没有** key：配了自己那一份的人走 provider……
    const mine = await resolveStrategy('吕品');
    expect(mine.kind).toBe('provider');
    if (mine.kind === 'provider') expect(mine.config.model).toBe(OWN.model);

    // ……同一个部署、同一条需求，没配的那个人走 CLI。这就是「按人」的意思。
    expect((await resolveStrategy('房超')).kind).toBe('cli');
    expect((await resolveStrategy()).kind).toBe('cli');

    // 平台补上之后，所有人的底线都变成 provider（各自用自己的那一份）。
    await saveProviderSettings(db, PLATFORM);
    const theirs = await resolveStrategy('房超');
    expect(theirs.kind).toBe('provider');
    if (theirs.kind === 'provider') expect(theirs.config.model).toBe(PLATFORM.model);
    expect((await resolveStrategy('吕品')).kind).toBe('provider');
  });

  it('删掉地址与模型（空串）等于清掉这一份；PM 因此拿不到任何配置', async () => {
    const id = await idOf('吕品');
    await saveProviderSettings(db, PLATFORM);
    await saveMemberProviderSettings(db, id, OWN);
    await saveMemberProviderSettings(db, id, { baseUrl: '', model: '' });
    expect(await memberProviderSettings(db, id)).toBeNull();
    expect(await resolveProviderConfig('吕品')).toBeNull();
  });

  it('保存时去掉首尾空白，并在超长时拒绝（不写坏已有的一格）', async () => {
    const id = await idOf('吕品');
    await saveMemberProviderSettings(db, id, {
      baseUrl: `  ${OWN.baseUrl}  `, apiKey: `  ${OWN.apiKey}  `, model: `  ${OWN.model}  `,
    });
    expect(await memberProviderSettings(db, id)).toEqual(OWN);

    const error = await saveMemberProviderSettings(db, id, { apiKey: 'x'.repeat(401) })
      .catch((thrown: unknown) => thrown);
    expect((error as { code?: string }).code).toBe('invalid_provider');
    expect((await memberProviderSettings(db, id))?.apiKey).toBe(OWN.apiKey);
  });
});

// ─── 那一行说什么 ────────────────────────────────────────────────────────────

describe('memberKeyView / memberKeyText', () => {
  const parts = { baseUrl: OWN.baseUrl, apiKey: OWN.apiKey, model: OWN.model };

  it('三种状态各自一句话', () => {
    expect(memberKeyText(memberKeyView(parts, null))).toBe('未配置');
    expect(memberKeyText(memberKeyView(parts, { config: PLATFORM, scope: 'platform' })))
      .toBe(`平台统一模型 · ${PLATFORM.model}`);
    expect(memberKeyText(memberKeyView(parts, { config: OWN, scope: 'member' }))).toBe(OWN.model);
    expect(memberKeyText(memberKeyView(parts, { config: OWN, scope: 'env' })))
      .toBe(`环境变量 · ${OWN.model}`);
  });

  it('视图里没有任何一格是 key，只有末 4 位', () => {
    const view = memberKeyView(parts, { config: OWN, scope: 'member' });
    expect(view.keyTail).toBe('9876');
    const serialized = JSON.stringify(view);
    expect(serialized.includes(OWN.apiKey)).toBe(false);
    expect(serialized.includes('ABCDEFGH')).toBe(false);
    expect(serialized.includes('apiKey')).toBe(false);
  });

  it('末 4 位只给「够长」的 key；太短的一个字符都不露', () => {
    expect(keyTail('sk-own-ABCDEFGH9876')).toBe('9876');
    expect(keyTail('12345678')).toBe('5678');
    expect(keyTail('1234567')).toBeNull();
    expect(keyTail('')).toBeNull();
    expect(keyTail(null)).toBeNull();
  });

  it('configOf：缺一格就是 null（纯判据，不连库）', () => {
    expect(configOf(parts)).toEqual(OWN);
    expect(configOf({ ...parts, apiKey: null })).toBeNull();
    expect(configOf({ baseUrl: null, apiKey: null, model: null })).toBeNull();
  });
});

// ─── 渲染出来的那一行 ────────────────────────────────────────────────────────

/**
 * 「设置页上不出现 key」这条要求，落到能测的那一层：
 *
 * 1. 页面渲染用的**唯一**输入是 `MemberKeyView`（`apiKey` 不在它的类型上）；
 * 2. 把那一行真的渲染成 HTML，逐个子串搜——不是只搜整串 key（key 被截断、被拼进
 *    高亮、被拆进两个 span 都是可能的漏法，整串搜索抓不到）。
 *
 * `next/navigation` 与 `app/actions` 被替掉：渲染这一行不需要路由器，也不该真的
 * 去调一个 server action。
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock('../app/actions', () => ({
  saveMemberKeyAction: vi.fn(),
  testMemberKeyAction: vi.fn(),
}));

/** key 的每一个「够长」的片段，一个都不该出现在 HTML 里。 */
function fragmentsOf(secret: string): string[] {
  const out: string[] = [];
  for (let size = 5; size <= secret.length; size += 1) {
    for (let start = 0; start + size <= secret.length; start += 1) {
      out.push(secret.slice(start, start + size));
    }
  }
  return out;
}

function rowHtml(view: MemberKeyView): string {
  return renderToStaticMarkup(<MemberKeyRow view={view} />);
}

describe('渲染那一行：没有 key', () => {
  it('自己的 key：显示模型名与「已配置 · 末4位」，HTML 里搜不到 key 的任何长片段', () => {
    const view = memberKeyView(
      { baseUrl: OWN.baseUrl, apiKey: OWN.apiKey, model: OWN.model },
      { config: OWN, scope: 'member' },
    );
    const html = rowHtml(view);
    expect(html).toContain(OWN.model);
    expect(html).toContain('已配置 · 9876');
    expect(html).not.toContain(OWN.apiKey);
    for (const fragment of fragmentsOf(OWN.apiKey)) {
      // 唯一允许出现的是末 4 位本身（它已经在 `已配置 · 9876` 里）。
      if (fragment === '9876') continue;
      expect(html.includes(fragment)).toBe(false);
    }
  });

  it('退回平台：说「平台统一模型 · x」，不提「已配置」', () => {
    const view = memberKeyView(
      { baseUrl: null, apiKey: null, model: null },
      { config: PLATFORM, scope: 'platform' },
    );
    const html = rowHtml(view);
    expect(html).toContain(`平台统一模型 · ${PLATFORM.model}`);
    expect(html).not.toContain('已配置');
    expect(html).not.toContain(PLATFORM.apiKey);
  });

  it('都没有：那一行写「未配置」', () => {
    const html = rowHtml(memberKeyView({ baseUrl: null, apiKey: null, model: null }, null));
    expect(html).toContain('未配置');
    expect(html).not.toContain('已配置');
  });
});

// ─── 测试那一次请求 ──────────────────────────────────────────────────────────

describe('probeProvider：一次极小的补全', () => {
  it('通过时那一行是「通过 · msms · n tokens」，并真的发了 /chat/completions', async () => {
    const stub = await startStub(() => ({
      status: 200,
      body: chatBody('接口可用', { prompt_tokens: 12, completion_tokens: 9 }),
    }));
    try {
      const probe = await probeProvider({
        baseUrl: stub.baseUrl, apiKey: 'sk-probe-00000000', model: 'probe-model',
      });
      expect(probe.ok).toBe(true);
      expect(probe.label).toMatch(/^通过 · \d+ms · 21 tokens$/);
      expect(probe.tokens).toBe(21);
      expect(stub.calls[0]!.url).toBe('/v1/chat/completions');
      expect(stub.calls[0]!.auth).toBe('Bearer sk-probe-00000000');
      // 极小，但要留出「想」的空间：推理模型（deepseek-flash）实测思考 27–85 字 /
      // 16–60 reasoning tokens，16 的预算会被思考一口吃光，答案一个字都轮不到。
      expect(PROBE_MAX_TOKENS).toBe(512);
      expect((JSON.parse(stub.calls[0]!.body) as { max_tokens: number }).max_tokens)
        .toBe(PROBE_MAX_TOKENS);
    } finally {
      await stub.close();
    }
  });

  it('服务端没有给 usage 时只写耗时，不编一个 0 tokens', async () => {
    const stub = await startStub(() => ({ status: 200, body: chatBody('接口可用') }));
    try {
      const probe = await probeProvider({
        baseUrl: stub.baseUrl, apiKey: 'sk-probe-00000000', model: 'probe-model',
      });
      expect(probe.label).toMatch(/^通过 · \d+ms$/);
      expect(probe.tokens).toBeNull();
    } finally {
      await stub.close();
    }
  });

  it('失败时原文照登、不抛：key 回显的那句话在到这一行之前已经变成 ***', async () => {
    const KEY = 'sk-wrong-ABCDEFGH1234';
    const stub = await startStub(() => ({
      status: 401,
      body: JSON.stringify({
        error: { message: `Incorrect API key provided: ${KEY}. You can find your API key at https://example.test/keys` },
      }),
    }));
    try {
      const probe = await probeProvider({
        baseUrl: stub.baseUrl, apiKey: KEY, model: 'probe-model',
      });
      expect(probe.ok).toBe(false);
      // 原文（含它的后半句，那是唯一能指向「哪里配错了」的线索）……
      expect(probe.label).toContain('Incorrect API key provided');
      expect(probe.label).toContain('https://example.test/keys');
      // ……但 key 本身不在里面。
      expect(probe.label).not.toContain(KEY);
      expect(probe.label).not.toContain('ABCDEFGH');
    } finally {
      await stub.close();
    }
  });

  it('配置缺项时也只是一句话，不是异常', async () => {
    const probe = await probeProvider({ baseUrl: '', apiKey: '', model: '' });
    expect(probe).toMatchObject({ ok: false, label: '接口地址是空的' });
  });

  it('超时是 15 秒（10 秒会把冷的网关判成错，45 秒让人以为卡了）', () => {
    expect(PROBE_TIMEOUT_MS).toBe(15_000);
  });
});

afterAll(async () => {
  await pool.end();
});
