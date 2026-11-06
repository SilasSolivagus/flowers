import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import {
  CANDIDATES, commandReady, viewOf,
  type CandidateView, type GeneratorTest, type GeneratorView,
} from './candidates.js';
import { detect } from './detect.js';
import { resolveGenerator } from './generator.js';

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
 * 三块拼起来：库里的（saved / test）、PATH 里的（candidates）、以及按解析顺序算出的
 * 结论（state / source / command）。页面与设置页都只调这一个函数——两处显示同一格
 * 事实时，不可能一处说「未配置」、另一处说「claude」。
 */
export async function generatorView(db: Queryable): Promise<GeneratorView> {
  const [saved, test] = await Promise.all([generatorCommand(db), readTest(db)]);
  const resolution = await resolveGenerator(saved);
  const detected = await detect();

  const candidates: CandidateView[] = detected.map((item) => viewOf(item.candidate));
  const known: CandidateView[] = CANDIDATES.map(viewOf);

  if (resolution.kind === 'ready') {
    return {
      state: 'ready',
      source: resolution.source,
      command: resolution.command,
      saved,
      candidates,
      known,
      test,
    };
  }
  return {
    state: resolution.kind,
    source: null,
    command: null,
    saved,
    candidates,
    known,
    test,
  };
}
