import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import {
  complete, extractJson, probeProvider, PROBE_MAX_TOKENS, redactSecret, resolveProviderConfig,
  type ProviderConfig,
} from '../src/core/uemaster/provider.js';
import { providerSettings, saveProviderSettings } from '../src/core/uemaster/settings.js';

/**
 * P2.9：直连 chat 接口的客户端。
 *
 * **一条网络请求都不发。** 「provider」是一个真的 `http.createServer`，监听
 * `127.0.0.1:0`（内核分配的临时端口），所以这里测的是真实的 `fetch`、真实的
 * `AbortSignal.timeout`、真实的 HTTP 状态码与正文——不是被 mock 掉的形状。
 * 唯一一件不真实的事：它不会去连任何外部接口。
 *
 * 要证明的六件事：
 * 1. 一个 key 加一个模型名就能拿到文字，`usage` 也带回来；
 * 2. 服务端说「分组 auto 下模型 x 的可用渠道不存在」时，这句原文要原样到 owner 眼前；
 * 3. 不回话的服务端会在我们设定的秒数之后被掐掉，并且那句话里说了几秒；
 * 4. 回来一个空串算失败（那不是一份材料），不算成功；
 * 5. 服务端把 Authorization 回显在错误里时，key 在离开本模块之前就变成 `***`；
 * 6. 配置的来源顺序是 env → 库 → null，且**不拼半份**。
 */

// ─── 一个真的 provider ──────────────────────────────────────────────────────

type Reply = { status: number; body: string } | null; // null = 永不回应（测超时用）

type Call = { url: string; auth: string; body: string };

type Provider = { baseUrl: string; calls: Call[]; close: () => Promise<void> };

async function startProvider(reply: (call: Call) => Reply): Promise<Provider> {
  const calls: Call[] = [];
  const server = createServer((req: IncomingMessage, res) => {
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
      // 超时那条用例留下一根没回应过的连接：先掐断，close 才不会等它。
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

const KEY = 'sk-live-ABC.123/x+y';

function cfgFor(baseUrl: string, over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { baseUrl, apiKey: KEY, model: 'gpt-5.4-mini', ...over };
}

/** 一个最小可用的 chat 响应体。 */
function chatBody(content: string, usage?: { prompt_tokens?: number; completion_tokens?: number }): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    ...(usage === undefined ? {} : { usage }),
  });
}

/**
 * 推理模型「预算被思考吃光」时的真实形状（2026-11 拿 deepseek-flash 抓的）：
 * `content` 空串、`reasoning_content` 有一大段、`finish_reason=length`。
 */
function reasoningOnlyBody(reasoningChars: number): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: '', reasoning_content: '思'.repeat(reasoningChars) },
      finish_reason: 'length',
    }],
  });
}

describe('complete：happy path', () => {
  it('发出一次 /chat/completions，带回文字与 usage', async () => {
    const provider = await startProvider(() => ({
      status: 200,
      body: chatBody('# 评估结论\n\n可以做。', { prompt_tokens: 128, completion_tokens: 42 }),
    }));
    try {
      const result = await complete(cfgFor(provider.baseUrl), '写一份评估', { maxTokens: 2000 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.text).toBe('# 评估结论\n\n可以做。');
      expect(result.usage).toEqual({ prompt: 128, completion: 42 });

      // 请求本身也是契约的一部分：路径、头、正文。
      expect(provider.calls).toHaveLength(1);
      const call = provider.calls[0]!;
      expect(call.url).toBe('/v1/chat/completions');
      expect(call.auth).toBe(`Bearer ${KEY}`);
      const sent = JSON.parse(call.body) as {
        model: string; max_tokens: number; messages: Array<{ role: string; content: string }>;
      };
      expect(sent.model).toBe('gpt-5.4-mini');
      expect(sent.max_tokens).toBe(2000);
      expect(sent.messages).toEqual([{ role: 'user', content: '写一份评估' }]);
    } finally {
      await provider.close();
    }
  });

  it('baseUrl 已经写成完整路径时不重复拼 /chat/completions', async () => {
    const provider = await startProvider(() => ({ status: 200, body: chatBody('好') }));
    try {
      const result = await complete(cfgFor(`${provider.baseUrl}/chat/completions`), '你好');
      expect(result.ok).toBe(true);
      expect(provider.calls[0]!.url).toBe('/v1/chat/completions');
    } finally {
      await provider.close();
    }
  });

  it('没有 usage 时不硬塞一个空对象', async () => {
    const provider = await startProvider(() => ({ status: 200, body: chatBody('好') }));
    try {
      const result = await complete(cfgFor(provider.baseUrl), '你好');
      expect(result).toEqual({ ok: true, text: '好' });
    } finally {
      await provider.close();
    }
  });
});

describe('complete：服务端的错', () => {
  it('4xx 时把 error.message 原样带回来（分组、模型名都在里面）', async () => {
    const said = '分组 auto 下模型 x 的可用渠道不存在';
    const provider = await startProvider(() => ({
      status: 400,
      body: JSON.stringify({ error: { message: said, type: 'new_api_error' } }),
    }));
    try {
      const result = await complete(cfgFor(provider.baseUrl), '你好');
      expect(result).toEqual({ ok: false, error: said });
    } finally {
      await provider.close();
    }
  });

  it('没有 error.message 就退回状态码，不吞', async () => {
    const provider = await startProvider(() => ({ status: 429, body: '' }));
    try {
      const result = await complete(cfgFor(provider.baseUrl), '你好');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('429');
    } finally {
      await provider.close();
    }
  });

  it('非 JSON 的正文按纯文本带出（反代常这么回）', async () => {
    const provider = await startProvider(() => ({ status: 502, body: 'Bad Gateway' }));
    try {
      const result = await complete(cfgFor(provider.baseUrl), '你好');
      expect(result).toEqual({ ok: false, error: 'Bad Gateway' });
    } finally {
      await provider.close();
    }
  });

  it('200 但正文不是 JSON：说清楚是它不像 JSON', async () => {
    const provider = await startProvider(() => ({ status: 200, body: 'upstream timeout' }));
    try {
      const result = await complete(cfgFor(provider.baseUrl), '你好');
      expect(result).toEqual({ ok: false, error: '模型接口返回的内容不是 JSON' });
    } finally {
      await provider.close();
    }
  });
});

describe('complete：超时', () => {
  it('服务端不回应，短超时把它掐掉，并说出超了几毫秒', async () => {
    const provider = await startProvider(() => null);
    try {
      const started = Date.now();
      const result = await complete(cfgFor(provider.baseUrl), '你好', { timeoutMs: 150 });
      const elapsed = Date.now() - started;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('请求超时：150 毫秒内没有响应');
      // 真的等到超时才回来，而不是立刻失败或等满 120 秒。
      expect(elapsed).toBeGreaterThanOrEqual(120);
      expect(elapsed).toBeLessThan(5000);
    } finally {
      await provider.close();
    }
  }, 10000);

  it('默认超时是 120 秒，那句话里写的是秒', async () => {
    const provider = await startProvider(() => null);
    try {
      // 只读那句话，不真的等两分钟：用 1000 毫秒走一遍格式化。
      const result = await complete(cfgFor(provider.baseUrl), '你好', { timeoutMs: 1000 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('请求超时：1 秒内没有响应');
    } finally {
      await provider.close();
    }
  }, 10000);
});

describe('complete：空内容算失败', () => {
  it('content 是空串时不是成功', async () => {
    const provider = await startProvider(() => ({ status: 200, body: chatBody('') }));
    try {
      const result = await complete(cfgFor(provider.baseUrl), '你好');
      expect(result).toEqual({ ok: false, error: '模型返回了空内容' });
    } finally {
      await provider.close();
    }
  });

  it('只有空白也不算内容', async () => {
    const provider = await startProvider(() => ({ status: 200, body: chatBody('   \n\t ') }));
    try {
      const result = await complete(cfgFor(provider.baseUrl), '你好');
      expect(result).toEqual({ ok: false, error: '模型返回了空内容' });
    } finally {
      await provider.close();
    }
  });

  it('choices 形状不对时说的是格式不对，不是空', async () => {
    const provider = await startProvider(() => ({
      status: 200,
      body: JSON.stringify({ object: 'error', choices: [] }),
    }));
    try {
      const result = await complete(cfgFor(provider.baseUrl), '你好');
      expect(result).toEqual({ ok: false, error: '响应不是 chat 补全的格式' });
    } finally {
      await provider.close();
    }
  });
});

describe('probeProvider：小测只判「连得上 + 钥匙对」', () => {
  it('答案 0 字但思考过 29 字：算通过，并在那一行把实话说全', async () => {
    const provider = await startProvider(() => ({ status: 200, body: reasoningOnlyBody(29) }));
    try {
      const probe = await probeProvider(cfgFor(provider.baseUrl));
      expect(probe.ok).toBe(true);
      expect(probe.error).toBeNull();
      expect(probe.label).toMatch(/^通过 · \d+ms · 推理模型：思考 29 字、答案 0 字（连接与密钥有效）$/);
      // 没有 usage 就不编 token 数。
      expect(probe.tokens).toBeNull();
      // 预算：512 是实测最长思考（60 reasoning tokens）的八倍多，不是拍的。
      expect(PROBE_MAX_TOKENS).toBeGreaterThanOrEqual(512);
      const sent = JSON.parse(provider.calls[0]!.body) as { max_tokens: number };
      expect(sent.max_tokens).toBe(PROBE_MAX_TOKENS);
    } finally {
      await provider.close();
    }
  });

  it('鉴权错：失败，服务端原文照登（key 已脱敏）', async () => {
    const provider = await startProvider(() => ({
      status: 401,
      body: JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }),
    }));
    try {
      const probe = await probeProvider(cfgFor(provider.baseUrl));
      expect(probe.ok).toBe(false);
      expect(probe.label).toContain('Incorrect API key provided');
      expect(probe.label).not.toContain(KEY);
      expect(probe.error).toBe(probe.label);
    } finally {
      await provider.close();
    }
  });

  it('答案 0 字、思考也 0 字：仍然失败——那不是推理模型没轮到，是它没说话', async () => {
    const provider = await startProvider(() => ({ status: 200, body: chatBody('') }));
    try {
      const probe = await probeProvider(cfgFor(provider.baseUrl));
      expect(probe.ok).toBe(false);
      expect(probe.label).toBe('模型返回了空内容');
      expect(probe.error).toBe('模型返回了空内容');
    } finally {
      await provider.close();
    }
  });
});

describe('complete：key 不外泄', () => {
  it('服务端把 Authorization 回显在错误里时，回来的那句话里只有 ***', async () => {
    const provider = await startProvider(() => ({
      status: 401,
      body: JSON.stringify({
        error: {
          message: `Incorrect API key provided: ${KEY}. You can find your API key at https://example.test/keys`,
        },
      }),
    }));
    try {
      const result = await complete(cfgFor(provider.baseUrl), '你好');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).not.toContain(KEY);
      // 一个字符都不许留（key 里有 `.` `/` `+`，正则写法最容易在这里漏）。
      expect(result.error).not.toContain('sk-live-ABC');
      expect(result.error).toContain('***');
      // 句子其余部分还在：脱敏不该把线索一起删掉。
      expect(result.error).toContain('Incorrect API key provided');
    } finally {
      await provider.close();
    }
  });

  it('传输层失败的那句话里也不带 key', async () => {
    // 一个立刻关掉的端口：请求必然失败，错误里是连接原因而不是 key。
    const provider = await startProvider(() => null);
    const baseUrl = provider.baseUrl;
    await provider.close(); // 端口关了，连接被拒。
    const result = await complete(cfgFor(baseUrl), '你好', { timeoutMs: 2000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain(KEY);
    expect(result.error).toContain('请求失败');
  });

  it('redactSecret 是字面替换，不是正则', () => {
    expect(redactSecret('a sk-live-ABC.123/x+y b', KEY)).toBe('a *** b');
    expect(redactSecret('没有任何痕迹', KEY)).toBe('没有任何痕迹');
    // 空 key 不做替换，否则会把整句话切碎。
    expect(redactSecret('abc', '')).toBe('abc');
  });
});

// ─── 配置从哪来 ──────────────────────────────────────────────────────────────

const ENV_URL = 'FLOWERS_PROVIDER_BASE_URL';
const ENV_KEY = 'FLOWERS_PROVIDER_API_KEY';
const ENV_MODEL = 'FLOWERS_PROVIDER_MODEL';
/** 进这个文件之前的三格值：测完要还原，否则会漏到别的用例里（同一进程、串行跑）。 */
const ORIGINAL_ENV = {
  url: process.env[ENV_URL],
  key: process.env[ENV_KEY],
  model: process.env[ENV_MODEL],
};

function clearEnv(): void {
  delete process.env[ENV_URL];
  delete process.env[ENV_KEY];
  delete process.env[ENV_MODEL];
}

function restoreEnv(): void {
  const pairs: Array<[string, string | undefined]> = [
    [ENV_URL, ORIGINAL_ENV.url],
    [ENV_KEY, ORIGINAL_ENV.key],
    [ENV_MODEL, ORIGINAL_ENV.model],
  ];
  for (const [name, value] of pairs) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** 直接写一行 `app_settings`（要造「只有两条」的半份配置，走不了 saveProviderSettings）。 */
async function putRow(key: string, value: string): Promise<void> {
  await db.execute(sql`
    insert into app_settings (key, value, updated_at) values (${key}, ${value}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`);
}

describe('resolveProviderConfig', () => {
  beforeEach(async () => {
    clearEnv();
    await db.execute(sql`delete from app_settings where key like 'provider.%'`);
  });

  afterEach(() => {
    clearEnv();
    restoreEnv();
  });

  it('库里三条齐全就用库里的', async () => {
    await saveProviderSettings(db, {
      baseUrl: 'https://saved.example/v1',
      apiKey: 'sk-saved',
      model: 'qwen3.7-plus',
    });
    expect(await resolveProviderConfig())
      .toEqual({ baseUrl: 'https://saved.example/v1', apiKey: 'sk-saved', model: 'qwen3.7-plus' });
  });

  it('env 排在库之前：三格都设了就用 env', async () => {
    await saveProviderSettings(db, {
      baseUrl: 'https://saved.example/v1', apiKey: 'sk-saved', model: 'qwen3.7-plus',
    });
    process.env[ENV_URL] = 'https://env.example/v1';
    process.env[ENV_KEY] = 'sk-env';
    process.env[ENV_MODEL] = 'glm-5.3';
    expect(await resolveProviderConfig())
      .toEqual({ baseUrl: 'https://env.example/v1', apiKey: 'sk-env', model: 'glm-5.3' });
  });

  it('env 只有一格时不与库里拼成半份——整层作废，落到库里', async () => {
    await saveProviderSettings(db, {
      baseUrl: 'https://saved.example/v1', apiKey: 'sk-saved', model: 'qwen3.7-plus',
    });
    process.env[ENV_URL] = 'https://env.example/v1';
    const resolved = await resolveProviderConfig();
    expect(resolved).toEqual({ baseUrl: 'https://saved.example/v1', apiKey: 'sk-saved', model: 'qwen3.7-plus' });
    expect(resolved?.apiKey).toBe('sk-saved');
    expect(resolved?.model).toBe('qwen3.7-plus');
  });

  it('库里只有两条：null，不是半份配置', async () => {
    await putRow('provider.baseUrl', 'https://saved.example/v1');
    await putRow('provider.apiKey', 'sk-saved');
    expect(await providerSettings(db)).toBeNull();
    expect(await resolveProviderConfig()).toBeNull();
  });

  it('条目存在但值是空串：等于没设', async () => {
    await saveProviderSettings(db, {
      baseUrl: 'https://saved.example/v1', apiKey: 'sk-saved', model: 'qwen3.7-plus',
    });
    await saveProviderSettings(db, { model: '' });
    expect(await resolveProviderConfig()).toBeNull();
  });

  it('两层都没有：null（「还没配」，不是错误）', async () => {
    expect(await resolveProviderConfig()).toBeNull();
  });

  it('保存时去掉首尾空白，并在超长时拒绝', async () => {
    await saveProviderSettings(db, {
      baseUrl: '  https://saved.example/v1  ', apiKey: '  sk-saved  ', model: ' qwen3.7-plus ',
    });
    expect(await providerSettings(db))
      .toEqual({ baseUrl: 'https://saved.example/v1', apiKey: 'sk-saved', model: 'qwen3.7-plus' });
    const error = await saveProviderSettings(db, { apiKey: 'x'.repeat(401) }).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('invalid_provider');
    // 超长那次没有写进库：原来的值还在。
    expect((await providerSettings(db))?.apiKey).toBe('sk-saved');
  });
});

// ─── 从回话里抠 JSON ─────────────────────────────────────────────────────────

describe('extractJson', () => {
  type Shape = { title: string; items: number[] };

  it('裸 JSON', () => {
    expect(extractJson<Shape>('{"title":"甲","items":[1,2]}')).toEqual({ title: '甲', items: [1, 2] });
  });

  it('```json 围栏里的', () => {
    const reply = '这是结果：\n\n```json\n{"title":"乙","items":[3]}\n```\n\n以上。';
    expect(extractJson<Shape>(reply)).toEqual({ title: '乙', items: [3] });
  });

  it('先说话后 JSON', () => {
    const reply = '好的，按你要的格式：\n{"title":"丙","items":[]}\n还需要我补充吗？';
    expect(extractJson<Shape>(reply)).toEqual({ title: '丙', items: [] });
  });

  it('回话里没有 JSON：null', () => {
    expect(extractJson<Shape>('我建议先做用户调研，再定验收标准。')).toBeNull();
    expect(extractJson<Shape>('')).toBeNull();
  });

  it('散文里的 {占位符} 与字符串里的括号都不会被当成 JSON', () => {
    expect(extractJson('请把 {需求} 填进模板')).toBeNull();
    expect(extractJson<Shape>('填好：{"title":"含}和]","items":[1]}'))
      .toEqual({ title: '含}和]', items: [1] });
  });

  it('顶层是数组也算', () => {
    expect(extractJson<number[]>('```\n[1,2,3]\n```')).toEqual([1, 2, 3]);
  });

  it('半截 JSON 不算：不加猜测地返回 null', () => {
    expect(extractJson('{"title":"丁","items":[')).toBeNull();
  });
});

afterAll(async () => {
  await pool.end();
});
