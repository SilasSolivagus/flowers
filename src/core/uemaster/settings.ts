import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import type { ProviderConfig } from './provider.js';
import {
  CANDIDATES, commandReady, defaultOptionId, dropdownOptions, idForCommand, viewOf,
  type CandidateView, type GeneratorTest, type GeneratorView,
} from './candidates.js';
import { detect } from './detect.js';
import { resolveGenerator } from './generator.js';
import { resolveProviderConfig } from './provider.js';

/**
 * 生成器设置：`app_settings` 里那两个键的**唯一**读写口。
 *
 * 为什么是键值表而不是两张列明确的表：这一层要回答的是「这个部署把这一格设成了
 * 什么」，键值是最小形状；键本身是常量（下面两个），库不解释它。
 *
 * 两条键：
 * - `generator.command`：用户选定（或手写）的那一行命令。**空串等于没设**——
 *   设置页的「清空」不需要一个删除按钮，存空串就会退回探测。
 * - `generator.test`：上一次就地测试的结果（JSON）。它跟着命令走：命令改了，
 *   这条结果就不算数（`GeneratorView.test.command` 与原命令比对，界面自己判）。
 *   为什么连失败也要落库：刷新之后那一行仍要显示「未通过测试」，而不是一次刷新
 *   就把失败洗成「未配置」。
 *
 * 没有缓存：设置页与生成动作，一次请求读一两次，`app_settings` 是主键读。
 * 探测才有缓存（`detect.ts`），因为那要碰文件系统。
 */

export const GENERATOR_KEY = 'generator.command';
export const TEST_KEY = 'generator.test';

/** 命令的长度上限：`app_settings.value` 是文本，但一行命令不该长到失控。 */
const MAX_COMMAND = 600;

type Queryable = Pick<Db, 'execute'>;

async function readKey(db: Queryable, key: string): Promise<string | null> {
  const res = await db.execute<{ value: string }>(sql`
    select value from app_settings where key = ${key}`);
  return res.rows[0]?.value ?? null;
}

async function writeKey(db: Queryable, key: string, value: string): Promise<void> {
  await db.execute(sql`
    insert into app_settings (key, value, updated_at)
    values (${key}, ${value}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`);
}

/** 库里存着的生成器命令；没设 / 空串都返回 null。 */
export async function generatorCommand(db: Queryable): Promise<string | null> {
  const value = (await readKey(db, GENERATOR_KEY))?.trim() ?? '';
  return value === '' ? null : value;
}

/**
 * 保存一条命令。
 *
 * 存之前只拦两件事：空的（那不是一条命令，是要把设置退回探测）与未填的占位符
 * （`ollama run <模型名>` 交给 shell 会被当成重定向）。**不测**——测试是设置页
 * 上另一个按钮，保存与「它能不能跑」是两件事；允许存一条还没通过的，只要行上
 * 如实写着「未通过测试」。
 */
export async function saveGeneratorCommand(db: Queryable, raw: unknown): Promise<string> {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length > MAX_COMMAND) throw new AppError('invalid_command', `生成器命令不能超过 ${MAX_COMMAND} 个字符`);
  if (value !== '' && !commandReady(value)) {
    throw new AppError('invalid_command', '生成器命令里还有没填的占位符');
  }
  await writeKey(db, GENERATOR_KEY, value);
  // 换了一条命令，上一次的测试结果立刻作废：它测的是另一条。
  await db.execute(sql`delete from app_settings where key = ${TEST_KEY}`);
  return value;
}

/** 上一次的就地测试结果；没测过 / JSON 坏了都返回 null（坏数据不该让设置页白屏）。 */
export async function readTest(db: Queryable): Promise<GeneratorTest | null> {
  const raw = await readKey(db, TEST_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const test = parsed as Partial<GeneratorTest>;
    if (typeof test.ok !== 'boolean' || typeof test.command !== 'string' || typeof test.at !== 'string') {
      return null;
    }
    return {
      ok: test.ok,
      command: test.command,
      at: test.at,
      size: typeof test.size === 'number' ? test.size : null,
      ms: typeof test.ms === 'number' ? test.ms : null,
      error: typeof test.error === 'string' ? test.error : null,
    };
  } catch {
    return null;
  }
}

/** 记一次测试结果（成功与失败都记）。 */
export async function writeTest(db: Queryable, test: GeneratorTest): Promise<void> {
  await writeKey(db, TEST_KEY, JSON.stringify(test));
}

/**
 * 界面要的全部生成器事实，一次读齐。
 *
 * 三块拼起来：库里的（saved / test）、PATH 里的（candidates / options）、以及按解析
 * 顺序算出的结论（state / source / command / provider）。页面与设置页都只调这一个
 * 函数——两处显示同一格事实时，不可能一处说「未配置」、另一处说「claude」。
 *
 * P2.8 起 `candidates` 不再被当成选项表用：它是**探测结论**（PATH 里有谁），
 * `options` 才是选项（七行全在，探测只决定后缀）。所以「装了四个」与「能选七个」
 * 是两件事，各自有各自的字段。
 *
 * **P2.10 的修正：结论必须与 `resolveStrategy()` 一致。** 服务端跑哪条路由
 * `resolveStrategy()` 决定（配齐了三格模型接口就走 provider，不看 CLI），而这一格
 * 之前只按 CLI 那条路算 `state`——于是「配了 key」的部署按下生成，界面还在问
 * 「用哪个 CLI」，问的是一条永远不会被走的路。现在这里先问同一件事：provider 在，
 * `state` 就是 `ready`、`source` 就是 `'provider'`，与 `choose` / `none` 无关。
 *
 * 为什么直接叫 `resolveProviderConfig()` 而不是 `resolveStrategy()`：策略住在 `start.ts`，
 * 而 `start.ts` 已经 import 本文件——反向再 import 一次就是一个 settings ↔ start 的环，
 * 还会把 worker 那一整套（compose / attach / packs / spawn）拖进设置页的模块图。判定本身
 * 只有一句（`config === null` 就是 CLI），两条写法同源，语义不会分叉。
 *
 * 与 `provider.ts` 之间确实多了一条边（它 import 本文件的 `providerSettings`），是一个
 * 只在函数体里互相引用的环：两边的模块顶层都不调用对方，加载顺序因此无关紧要。
 */
export async function generatorView(db: Queryable): Promise<GeneratorView> {
  const [saved, test] = await Promise.all([generatorCommand(db), readTest(db)]);
  const resolution = await resolveGenerator(saved);
  const detected = await detect();
  // 只取能露的两格：`apiKey` 在 `resolveProviderConfig()` 的返回值里，但绝不进视图。
  const config = await resolveProviderConfig();
  const provider = config === null ? null : { model: config.model, baseUrl: config.baseUrl };

  const candidates: CandidateView[] = detected.map((item) => viewOf(item.candidate));
  const known: CandidateView[] = CANDIDATES.map(viewOf);
  const options = dropdownOptions(known, new Set(candidates.map((item) => item.id)));

  const common = {
    saved,
    candidates,
    known,
    options,
    defaultId: defaultOptionId(options),
    savedId: idForCommand(saved),
    test,
  };

  // 配了模型接口：按钮立刻跑（`ready`），不再问 CLI。`command` 留 null——这一版没有
  // 命令可跑，把 CLI 那条塞进来会让界面以为它会被执行。
  if (provider !== null) {
    return { state: 'ready', source: 'provider', command: null, provider, ...common };
  }
  if (resolution.kind === 'ready') {
    return { state: 'ready', source: resolution.source, command: resolution.command, provider: null, ...common };
  }
  return { state: resolution.kind, source: null, command: null, provider: null, ...common };
}

// ─── P2.9：LLM 直连的三条键 ─────────────────────────────────────────────────

/**
 * 直连 chat 接口（`provider.ts`）的三条键。
 *
 * 为什么这三条也住在这里，而不是让 `provider.ts` 自己去写 SQL：`app_settings`
 * 的读写口只有这一处（本文件开头那句「唯一读写口」是硬规矩），多开一个口子就
 * 会有两套「空串算什么」的解读。键名照旧是服务层常量，库不解释它们。
 *
 * 三条**同进同退**：只有 baseUrl 没有 key、或只有 key 没有 model，都不是一个能发
 * 请求的配置；`providerSettings()` 因此在缺一条时给 null，而不是给半份。
 */
export const PROVIDER_BASE_URL_KEY = 'provider.baseUrl';
export const PROVIDER_API_KEY_KEY = 'provider.apiKey';
export const PROVIDER_MODEL_KEY = 'provider.model';

/** 三个字段的长度上限：它们都会进 HTTP 头或请求体，不该长到失控。 */
const MAX_BASE_URL = 500;
const MAX_API_KEY = 400;
const MAX_MODEL = 200;

/** 单格：去空白；空串与没设同义（与 `generator.command` 一个口径）。 */
function cell(value: string | undefined | null): string | null {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
}

/**
 * 库里存着的直连接口配置；三条齐全才算数，缺一条返回 null。
 *
 * **有 key 也只在服务端读它**——本函数的返回值会进 `Authorization` 头，绝不进
 * 响应体、日志或事件（见 `provider.ts` 的脱敏）。
 */
export async function providerSettings(db: Queryable): Promise<ProviderConfig | null> {
  const [baseUrl, apiKey, model] = await Promise.all([
    readKey(db, PROVIDER_BASE_URL_KEY),
    readKey(db, PROVIDER_API_KEY_KEY),
    readKey(db, PROVIDER_MODEL_KEY),
  ]);
  const resolved = { baseUrl: cell(baseUrl), apiKey: cell(apiKey), model: cell(model) };
  if (resolved.baseUrl === null || resolved.apiKey === null || resolved.model === null) return null;
  return { baseUrl: resolved.baseUrl, apiKey: resolved.apiKey, model: resolved.model };
}

/**
 * 写这三条键。传字符串就写，传空串等于**清掉这一格**（读的时候就是没设），
 * 不传的字段保持原样——设置页以后只有一行「改」，不必每次把三条一起送来。
 *
 * 长度超限在这里就拦（`AppError`，与命令那条一个风格）：超过上限的 key 一定不是
 * 一个能用的 key，等到发请求时才失败更难查。
 */
export async function saveProviderSettings(
  db: Queryable,
  input: { baseUrl?: string; apiKey?: string; model?: string },
): Promise<void> {
  const writes: Array<[string, string | undefined, number, string]> = [
    [PROVIDER_BASE_URL_KEY, input.baseUrl, MAX_BASE_URL, '接口地址'],
    [PROVIDER_API_KEY_KEY, input.apiKey, MAX_API_KEY, 'API Key'],
    [PROVIDER_MODEL_KEY, input.model, MAX_MODEL, '模型名'],
  ];
  for (const [key, raw, max, label] of writes) {
    if (raw === undefined) continue;
    const value = raw.trim();
    if (value.length > max) throw new AppError('invalid_provider', `${label}不能超过 ${max} 个字符`);
    await writeKey(db, key, value);
  }
}
