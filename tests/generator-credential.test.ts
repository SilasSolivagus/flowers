import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { credentialEnvFor } from '../src/core/uemaster/candidates.js';
import { credentialFor, testGenerator } from '../src/core/uemaster/generator.js';

/**
 * 2026-11-10：harness 那条路的凭据接线（`MISSING_CREDENTIAL` 那一行）。
 *
 * 要证明的不是「dsh 能用」（它能不能用取决于那把 key），而是：
 * 1. **库里那把 key 真的进了子进程的环境**——用一个只认 `DEEPSEEK_API_KEY` 的假 `dsh`
 *    钉住，它的退出码就是判据；
 * 2. 不补的时候它仍然是失败的（否则第 1 条就是自证）；
 * 3. 只给认这条路的那一条命令补（`claude` / 自建命令不补）；
 * 4. 不转发 `provider.baseUrl`：dsh 的 `DEEPSEEK_BASE_URL` 要的是 Messages 兼容根，
 *    我们那三格是 OpenAI 兼容根——塞过去会把默认地址改坏；
 * 5. key 不出现在任何返回值里（失败那一行照登 CLI 的原文，但原文里没有我们的 key）。
 *
 * 假 `dsh` 是**真**子进程（`spawn` + `shell` + `env`），所以把 `runRaw` 里那一行
 * `env: childEnv(...)` 摘掉，前两条立刻红。
 */

const KEY = 'sk-test-credential-not-a-real-key';
const MUST_MISS = 'MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"';

/**
 * 一个假 `dsh`：只有环境里带着我们那把 key 时才交出一份 HTML。
 *
 * 为什么用 shell 脚本而不是 node stub：`spawn` 走的是 `shell: true`，真生成时的
 * 是 `dsh headless '…'` 这一行字。用同名可执行文件才能把「命令字符串 → 二进制 →
 * 环境」这条路整段跑通，而不是只测到一个函数。
 */
const FAKE_DSH = `#!/bin/sh
if [ "$DEEPSEEK_API_KEY" = "${KEY}" ]; then
  printf '<!doctype html><html><head><title>stub</title></head><body><p>env ok</p></body></html>'
  exit 0
fi
printf '%s\\n' '${MUST_MISS}' >&2
exit 1
`;

let dir: string;
const REAL_PATH = process.env.PATH;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'flowers-cred-'));
  const file = path.join(dir, 'dsh');
  await writeFile(file, FAKE_DSH, 'utf8');
  await chmod(file, 0o755);
  process.env.PATH = dir;
});

afterAll(async () => {
  process.env.PATH = REAL_PATH;
});

/** 每次跑完删掉那个临时 PATH 目录（一个用例一个，互不干扰）。 */
async function cleanup(): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  process.env.PATH = REAL_PATH;
}

const DSH_COMMAND = 'dsh headless {prompt}';

describe('凭据该补到哪条命令上', () => {
  it('dsh → DEEPSEEK_API_KEY；claude / ollama / 自建命令不补', () => {
    expect(credentialEnvFor(DSH_COMMAND)).toBe('DEEPSEEK_API_KEY');
    // 用户手改过的命令（多了参数）仍然是 dsh：按第一个词认，与 `idForCommand` 同一判据。
    expect(credentialEnvFor('dsh headless --json {prompt}')).toBe('DEEPSEEK_API_KEY');
    expect(credentialEnvFor('claude -p --permission-mode acceptEdits')).toBeNull();
    expect(credentialEnvFor('codex exec --sandbox workspace-write -')).toBeNull();
    expect(credentialEnvFor('ollama run qwen2.5-coder')).toBeNull();
    expect(credentialEnvFor('./my-gen --stdin')).toBeNull();
    expect(credentialEnvFor('')).toBeNull();
  });

  it('有 key 才补；空串 / null / 首尾空白都不补', () => {
    expect(credentialFor(DSH_COMMAND, KEY)).toEqual({ env: 'DEEPSEEK_API_KEY', value: KEY });
    expect(credentialFor(DSH_COMMAND, `  ${KEY}  `)).toEqual({ env: 'DEEPSEEK_API_KEY', value: KEY });
    expect(credentialFor(DSH_COMMAND, '')).toBeNull();
    expect(credentialFor(DSH_COMMAND, '   ')).toBeNull();
    expect(credentialFor(DSH_COMMAND, null)).toBeNull();
    expect(credentialFor(DSH_COMMAND, undefined)).toBeNull();
    // 不需要凭据的命令：有 key 也不补。
    expect(credentialFor('claude -p', KEY)).toBeNull();
  });

  it('只带变量名与值：不转发 provider.baseUrl（那是另一套协议的根）', () => {
    const credential = credentialFor(DSH_COMMAND, KEY);
    expect(credential).not.toBeNull();
    // 契约就是「一个变量」——没有 `baseUrl`、没有 `model` 的位子。
    expect(Object.keys(credential!).sort()).toEqual(['env', 'value']);
    expect(JSON.stringify(credential)).not.toContain('DEEPSEEK_BASE_URL');
  });
});

describe('小测真的把 key 送进子进程', () => {
  it('带凭据 → 假 dsh 交得出 HTML（通过）', async () => {
    const result = await testGenerator(DSH_COMMAND, {
      timeoutMs: 10_000,
      credential: credentialFor(DSH_COMMAND, KEY),
    });
    await cleanup();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mode).toBe('stdout');
  });

  it('不带凭据 → 同一句话原样回来（证明上面那条不是自证）', async () => {
    const result = await testGenerator(DSH_COMMAND, { timeoutMs: 10_000 });
    await cleanup();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('MISSING_CREDENTIAL');
  });

  it('凭据只对认它的命令生效：给 claude 补 key 也不会让假 dsh 通过', async () => {
    // 命令是 claude → credentialFor 返回 null → 假 dsh 看不到变量（这里它根本不执行，
    // 因为它不在 PATH 里；用 dsh 的名字 + claude 的「不补」结论来钉这一条）。
    const credential = credentialFor('claude -p', KEY);
    expect(credential).toBeNull();
    const result = await testGenerator(DSH_COMMAND, { timeoutMs: 10_000, credential });
    await cleanup();
    expect(result.ok).toBe(false);
  });

  it('失败那一行不夹带 key', async () => {
    const result = await testGenerator(DSH_COMMAND, {
      timeoutMs: 10_000,
      // 一个「不匹配」的 key：假 dsh 会说缺凭据，而我们的 key 不该出现在那句话里。
      credential: credentialFor(DSH_COMMAND, 'sk-wrong-key-value'),
    });
    await cleanup();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain('sk-wrong-key-value');
      expect(result.error).toContain('MISSING_CREDENTIAL');
    }
  });
});
