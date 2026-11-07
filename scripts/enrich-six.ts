/**
 * 把搬过来的旧描述**拆进六问的空格**——批量版（P4-08 收尾）。
 *
 *   npx tsx scripts/enrich-six.ts --limit 5 --dry-run        # 试跑：调模型、打印、不写库
 *   npx tsx scripts/enrich-six.ts --only 1234                # 只补这一条
 *   npx tsx scripts/enrich-six.ts --limit 20                 # 只跑前 20 条（按 number 升序）
 *   npx tsx scripts/enrich-six.ts --concurrency 8            # 并发（默认 4）
 *   npx tsx scripts/enrich-six.ts --only-file retry.txt       # 只补这份清单里的编号（重跑失败行）
 *   npx tsx scripts/enrich-six.ts                            # 剩下的全跑
 *
 * ## 为什么要有这个脚本
 *
 * `scripts/migrate-flower.ts` 把 Flower 的自由文本 `description` 塞进了 `context`
 * （「谁在什么情况下用」），其余五格留空。625 条老需求于是每一条都缺五问——下游
 * 生成材料时就在那五处猜。这个脚本用**界面上同一个函数**
 * （`src/core/uemaster/intake.ts` 的 `splitDescription`，也就是「从原文拆六问」
 * 那个按钮）逐条拆一遍，把结果补进空格。
 *
 * ## owner 的裁决：只填空格，不覆盖已有内容
 *
 * **一格已经有字，就一个字都不动。** 理由不是「怕出错」，是「原来的话比模型的转述
 * 值钱」：那段原文是提出需求的人当年写的，模型给的是对它的**猜测**；写坏了没有第二
 * 份副本可以恢复（`context` 那一列是原文的唯一一份）。所以：
 *
 * - 选行时只要五格**有一个**是 NULL 就要跑（哪怕另外四格已经有字）；
 * - 写库时只给 `is null` 的那几格赋值，别的一律不碰；
 * - SQL 里再用 `coalesce(列, 新值)` 兜一道：**哪怕内存里那份行数据是旧的**（另一个
 *   进程刚填过），也写不进去；
 * - 模型这一格没话（`''`）就**不写**——NULL 保持 NULL，不写空串。「模型没说什么」
 *   与「这里写了一个空值」在库里必须还能区分。
 *
 * 这条规矩在代码里落成两道锁（`planWrites()` 的内存判断 + `writeRow()` 的
 * `coalesce` + `where … is null`），因为它是这个脚本唯一一个「错了就不可恢复」的地方。
 *
 * ## 为什么能断点续跑
 *
 * 进度**只存在库里**：每条写完就提交（一行的几格在同一个事务里），崩了重跑，
 * 选行条件（「至少还有一格是 NULL」）自然把已经补完的排除掉。没有进度文件、
 * 没有 seen 集合——那种东西会在第二天与库对不上。
 *
 * ## `--dry-run` 与 `split-description.ts` 的 `--dry-run` 不是一回事
 *
 * 那个脚本的 `--dry-run` 是「不调模型，只看提示词撑不撑」。这里的 `--dry-run` 是
 * 「照常调模型、把六格与依据全打印出来，但**不写库**」——因为它的用途是**试跑判质量**：
 * 先看 5 条的引文是不是真的落在原文里，再决定要不要跑几百条。所以它照样花钱。
 *
 * ## 失败的口径
 *
 * 一条失败（模型超时 / 回话里没有 JSON / 库写不进去）就记一行、**那一行原样不动**、
 * 接着跑下一条。跑完把失败条数与编号打出来——重跑一次就会只补它们。
 */
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { resolveProvider, type ProviderConfig } from '../src/core/uemaster/provider.js';
import {
  rejectedCount, splitDescription, SPLIT_KEYS, type SplitKey, type SplitResult,
} from '../src/core/uemaster/intake.js';

/** 要补的五格。`context` 不在里面：选行条件保证它非空，而它一个字都不许被改。 */
const FILL_KEYS = SPLIT_KEYS.filter((key) => key !== 'context');

const LABEL: Record<SplitKey, string> = {
  context: '谁在什么情况下用',
  problem: '现在怎么做',
  outcome: '做成什么样算成功',
  surfaces: '涉及哪些页面',
  edge_cases: '失败/空/无权限',
  out_of_scope: '这次不做什么',
};

// ─── 参数 ────────────────────────────────────────────────────────────────────

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  const next = process.argv[index + 1];
  return next === undefined || next.startsWith('--') ? '' : next;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** 正整数参数；不传就用 `fallback`，传了但不是正整数就直接说清是哪个参数（不静默回落）。 */
function positive(name: string, fallback?: number): number {
  const raw = arg(name);
  if (raw === null) {
    if (fallback === undefined) throw new Error(`--${name} 需要一个正整数`);
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} 需要一个正整数，收到的是「${raw}」`);
  }
  return value;
}

/** 读一份编号清单：一行一个，空行与非数字忽略（手工维护的清单里常有空行）。 */
function numbersIn(path: string): number[] {
  const raw = readFileSync(path, 'utf8');
  const numbers: number[] = [];
  for (const line of raw.split('\n')) {
    const value = Number(line.trim());
    if (line.trim() !== '' && Number.isInteger(value)) numbers.push(value);
  }
  if (numbers.length === 0) throw new Error(`${path} 里没有编号`);
  return numbers;
}

// ─── 选行 ────────────────────────────────────────────────────────────────────

type Row = {
  id: string;
  number: number;
  title: string;
  context: string;
  problem: string | null;
  outcome: string | null;
  surfaces: string | null;
  edge_cases: string | null;
  out_of_scope: string | null;
};

/** 五格里还空着哪几格（`null` 才算空；空串是「有人填过」的一种，也算有内容）。 */
function emptyFieldsOf(row: Row): SplitKey[] {
  return FILL_KEYS.filter((key) => row[key] === null);
}

/** 选行的口径，写成一处常量：`--limit` 与「要不要跑」的计数必须用同一个条件。 */
const NEEDS_WORK = sql`legacy_ref is not null
    and context is not null
    and (problem is null or outcome is null or surfaces is null or edge_cases is null
         or out_of_scope is null)`;

/**
 * 「只处理这些行」的条件：`--only` 一个编号，`--only-file` 一份清单（重跑失败行用）。
 *
 * 清单一行一个编号（直接从日志里 `失败：` 那几行抄 `#` 后面的数字即可）；空行与
 * 非数字行忽略——手工维护的清单里常有空行。
 */
function narrowTo(only: number | null, list: number[] | null): ReturnType<typeof sql> {
  if (only !== null) return sql` and number = ${only}`;
  if (list !== null) return sql` and number = any(${sql.param(list)}::int[])`;
  return sql``;
}

async function countNeedingWork(only: number | null, list: number[] | null): Promise<number> {
  const onlyCondition = narrowTo(only, list);
  const res = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from requirements where ${NEEDS_WORK}${onlyCondition}`);
  return res.rows[0]?.n ?? 0;
}

async function pickRows(limit: number | null, only: number | null, list: number[] | null)
  : Promise<Row[]> {
  const onlyCondition = narrowTo(only, list);
  const limitClause = limit === null ? sql`` : sql` limit ${limit}`;
  const res = await db.execute<Row>(sql`
    select id, number, title, context, problem, outcome, surfaces, edge_cases, out_of_scope
      from requirements
     where ${NEEDS_WORK}${onlyCondition}
     order by number${limitClause}`);
  return res.rows;
}

// ─── 写库（两道锁） ──────────────────────────────────────────────────────────

/**
 * 这一行**可以**写哪些格：内存里是 NULL 的、且模型真给了非空内容的。
 *
 * 第一道锁在这里：已经有字的格根本不进 UPDATE 的参数。
 */
function planWrites(row: Row, result: SplitResult): Partial<Record<SplitKey, string>> {
  const writes: Partial<Record<SplitKey, string>> = {};
  for (const key of emptyFieldsOf(row)) {
    const value = result[key];
    // 模型这一格没话说：不写。NULL 保持 NULL（不拿空串去覆盖「没有」）。
    if (value === undefined || value.trim() === '') continue;
    writes[key] = value;
  }
  return writes;
}

/**
 * 一行的几格在**一个事务**里提交：崩在中间不会留下「problem 有了、outcome 没有」的
 * 半条——虽然那也能续跑，但一次一提交才有「写过就是写过」的干净边界。
 *
 * 第二道锁是 SQL：`coalesce(列, 新值)` 加 `where 列 is null`。哪怕这份行数据是几分钟
 * 前读的、中途有人（或另一个实例）已经填过，这一条 UPDATE 也碰不到它。
 */
async function writeRow(row: Row, writes: Partial<Record<SplitKey, string>>): Promise<number> {
  const keys = Object.keys(writes) as SplitKey[];
  if (keys.length === 0) return 0;
  return db.transaction(async (tx) => {
    const res = await tx.execute(sql`
      update requirements set
        problem      = coalesce(problem,      ${writes.problem ?? null}),
        outcome      = coalesce(outcome,      ${writes.outcome ?? null}),
        surfaces     = coalesce(surfaces,     ${writes.surfaces ?? null}),
        edge_cases   = coalesce(edge_cases,   ${writes.edge_cases ?? null}),
        out_of_scope = coalesce(out_of_scope, ${writes.out_of_scope ?? null})
      where id = ${row.id}
        and (${sql.raw(keys.map((key) => `${key} is null`).join(' or '))})`);
    return res.rowCount ?? 0;
  });
}

// ─── 一条的处理 ──────────────────────────────────────────────────────────────

type RowOutcome = {
  number: number;
  title: string;
  ms: number;
  /** 这次真正填进去的格（dry-run 时是「会填进去的」）。 */
  filled: SplitKey[];
  /** 跑完了但仍然是空的格（模型没说，或引文对不上）。 */
  stillEmpty: SplitKey[];
  /** 被丢弃的引文条数（`⨯`）：这是「模型说了、但原文里找不到」，与「没说」不同。 */
  rejected: number;
  /** 写库时那几格已经被别人填上了（UPDATE 命中 0 行）：这条什么都不用做。 */
  skipped: boolean;
  error: string | null;
  /** dry-run 才留：完整结果与依据，供报告引用。 */
  result: SplitResult | null;
};

async function runRow(
  cfg: ProviderConfig, row: Row, dryRun: boolean,
): Promise<RowOutcome> {
  const started = Date.now();
  const base = { number: row.number, title: row.title };
  const result = await splitDescription(cfg, { title: row.title, description: row.context });
  const writes = planWrites(row, result);
  const filled = (Object.keys(writes) as SplitKey[]).sort(
    (a, b) => SPLIT_KEYS.indexOf(a) - SPLIT_KEYS.indexOf(b),
  );

  // 模型五格都没话说：没有要写的格 → 这一行原样不动，**也不算失败**（原文里确实
  // 没有那些答案）。它会被下一次选行再次选中，这是有意的：那说明这条需求真的薄，
  // 而不是我们放弃了它。
  if (filled.length === 0) {
    return {
      ...base,
      ms: Date.now() - started,
      filled: [],
      stillEmpty: emptyFieldsOf(row),
      rejected: rejectedCount(result),
      skipped: false,
      error: null,
      result: dryRun ? result : null,
    };
  }

  // dry-run：不写库，但结果原样带出去给人判质量。
  if (dryRun) {
    return {
      ...base,
      ms: Date.now() - started,
      filled,
      stillEmpty: FILL_KEYS.filter((key) => writes[key] === undefined),
      rejected: rejectedCount(result),
      skipped: false,
      error: null,
      result,
    };
  }

  let updated: number;
  try {
    updated = await writeRow(row, writes);
  } catch (error) {
    // 写失败也算这条失败：那一行**原样不动**（事务回滚），重跑时会再遇到它。
    return {
      ...base,
      ms: Date.now() - started,
      filled: [],
      stillEmpty: FILL_KEYS.slice(),
      rejected: rejectedCount(result),
      skipped: false,
      error: `写库失败：${error instanceof Error ? error.message : String(error)}`,
      result: null,
    };
  }

  // 命中 0 行：那几格在读到写之间被别人填上了（另一个实例 / 手工改的）。这一行不动。
  if (updated === 0) {
    return {
      ...base,
      ms: Date.now() - started,
      filled: [],
      stillEmpty: emptyFieldsOf(row),
      rejected: rejectedCount(result),
      skipped: true,
      error: null,
      result: null,
    };
  }

  return {
    ...base,
    ms: Date.now() - started,
    filled,
    stillEmpty: FILL_KEYS.filter((key) => writes[key] === undefined),
    rejected: rejectedCount(result),
    skipped: false,
    error: null,
    result: null,
  };
}

// ─── 并发池 ──────────────────────────────────────────────────────────────────

/**
 * 固定宽度的并发池：`size` 个 worker 抢同一个游标。
 *
 * 不用 `Promise.all(items.map(...))`：那是一次把 626 个请求同时甩出去（网关会限流，
 * 也会把内存与连接池吃满）；也不能串行——626 × 5 秒是快一小时。4 路并发是实测下
 * 「网关不皱眉、单条延迟不明显变长」的起点，所以做成 `--concurrency`（默认 4）。
 */
async function runPool<T>(
  items: T[], size: number, fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// ─── 打印 ────────────────────────────────────────────────────────────────────

function names(keys: SplitKey[]): string {
  return keys.length === 0 ? '（无）' : keys.join('、');
}

function block(text: string): string {
  if (text === '') return '  （空）';
  return text.split('\n').map((line) => `  ${line}`).join('\n');
}

/** dry-run 的一条：六格 + 依据，格式与 `split-description.ts` 一致（报告里要贴）。 */
function printPilotRow(outcome: RowOutcome, row: Row): void {
  const result = outcome.result;
  process.stdout.write(`\n══════ #${row.number} ${row.title} ══════\n`);
  process.stdout.write(`原文（${row.context.length} 字，全部进 context）：\n${block(row.context)}\n`);
  if (result === null) {
    process.stdout.write(`\n结果：${outcome.error ?? '（没有结果）'}\n`);
    return;
  }
  process.stdout.write('\n── 六问 ──\n');
  for (const key of SPLIT_KEYS) {
    const current = key === 'context' ? row.context : row[key as SplitKey];
    const marker = result[key] === '' ? '✘' : '✔';
    const note = key === 'context'
      ? '（已有内容，不写）'
      : current !== null && current !== undefined
        ? '（已有内容，不写）'
        : '';
    process.stdout.write(`\n${marker} ${key}（${LABEL[key]}）${note}\n${block(result[key])}\n`);
  }
  process.stdout.write(`\n会写：${names(outcome.filled)}\n`);
  process.stdout.write(`留空：${names(outcome.stillEmpty)}（模型没说，或引文对不上）\n`);
  process.stdout.write(`依据 ${result.notes.length} 条（丢弃 ${outcome.rejected}）：\n`);
  for (const note of result.notes) process.stdout.write(`  ${note}\n`);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dryRun = has('dry-run');
  const limit = arg('limit') === null ? null : positive('limit');
  const rawOnly = arg('only');
  const only = rawOnly === null ? null : positive('only');
  const listPath = arg('only-file');
  const list = listPath === null ? null : numbersIn(listPath);
  const concurrency = positive('concurrency', 4);

  const total = await countNeedingWork(only, list);
  if (total === 0) {
    process.stdout.write(
      only === null
        ? '没有需要补格的行：legacy_ref 非空、context 非空、且五格全部有内容。\n'
        : `#${only} 不在补格范围内（要么没搬过、要么没有 context、要么五格已经齐了）。\n`,
    );
    return;
  }

  const rows = await pickRows(limit, only, list);

  const resolved = await resolveProvider(undefined);
  if (resolved === null) {
    process.stderr.write(
      '未配置模型接口：env 的三个变量没有设，库里也没有完整的「接口地址 + API Key + 模型名」。\n'
      + '去「设置」里填，或用 FLOWERS_PROVIDER_BASE_URL / FLOWERS_PROVIDER_API_KEY / FLOWERS_PROVIDER_MODEL 注入。\n',
    );
    process.exitCode = 1;
    return;
  }
  const { config, scope } = resolved;

  process.stdout.write(`需要补格：${total} 行${only === null
    ? list === null ? '' : `（--only-file ${listPath ?? ''}：清单 ${(list ?? []).length} 个编号里命中 ${total} 行）`
    : `（--only ${only} 命中 ${total} 行）`}\n`);
  process.stdout.write(`本次取：${rows.length} 行（--limit ${limit === null ? '不设' : limit}）`
    + ` · 并发 ${concurrency} · ${dryRun ? '**dry-run：不写库**' : '写库'}\n`);
  // 只报「哪一层 + key 在不在」，**不打印 key 本身**：它可能是别人的。
  process.stdout.write(`模型：${scope} 层 · ${config.model} · 地址 ${config.baseUrl}`
    + ` · key ${config.apiKey === '' ? '缺' : '已配'}\n\n`);

  const startedAll = Date.now();
  const perField = new Map<SplitKey, number>(FILL_KEYS.map((key) => [key, 0]));
  const failures: { number: number; error: string }[] = [];
  const stillPartial: { number: number; title: string; keys: SplitKey[]; rejected: number }[] = [];
  const completeAfter: number[] = [];
  let done = 0;
  let rowsFilled = 0;
  let rowsUntouched = 0;
  let rowsSkipped = 0;
  let rejectedTotal = 0;

  await runPool(rows, concurrency, async (row) => {
    let outcome: RowOutcome;
    try {
      outcome = await runRow(config, row, dryRun);
    } catch (error) {
      // 模型那一步抛了（超时 / 没给 JSON / 接口报错）：这一行原样不动，记下来接着跑。
      outcome = {
        number: row.number,
        title: row.title,
        ms: 0,
        filled: [],
        stillEmpty: emptyFieldsOf(row),
        rejected: 0,
        skipped: false,
        error: error instanceof Error ? error.message : String(error),
        result: null,
      };
    }

    done += 1;
    if (outcome.error !== null) {
      failures.push({ number: outcome.number, error: outcome.error });
      process.stdout.write(`#${outcome.number} 失败：${outcome.error}\n`);
    } else if (outcome.skipped) {
      rowsSkipped += 1;
      process.stdout.write(`#${outcome.number} 跳过：要写的那几格已经被填过了\n`);
    } else {
      for (const key of outcome.filled) perField.set(key, (perField.get(key) ?? 0) + 1);
      rejectedTotal += outcome.rejected;
      if (outcome.filled.length === 0) rowsUntouched += 1;
      else rowsFilled += 1;
      if (dryRun) {
        printPilotRow(outcome, row);
      } else if (outcome.filled.length === 0) {
        process.stdout.write(
          `#${outcome.number} 模型五格都没给（原文里确实没有这些答案），这一行原样不动`
          + `${outcome.rejected > 0 ? ` · 弃引文 ${outcome.rejected}` : ''} · ${seconds(outcome.ms)}\n`,
        );
        stillPartial.push({
          number: outcome.number,
          title: row.title,
          keys: outcome.stillEmpty,
          rejected: outcome.rejected,
        });
      } else {
        process.stdout.write(
          `#${outcome.number} 填 ${outcome.filled.length}（${names(outcome.filled)}）`
          + ` 留 ${outcome.stillEmpty.length}（${names(outcome.stillEmpty)}）`
          + `${outcome.rejected > 0 ? ` 弃引文 ${outcome.rejected}` : ''} · ${seconds(outcome.ms)}\n`,
        );
        if (outcome.stillEmpty.length > 0) {
          stillPartial.push({
            number: outcome.number,
            title: row.title,
            keys: outcome.stillEmpty,
            rejected: outcome.rejected,
          });
        } else {
          completeAfter.push(outcome.number);
        }
      }
    }

    // 每 25 行一句进度：跑几十分钟的东西，不能只在最后说话。
    if (done % 25 === 0) {
      const elapsed = Date.now() - startedAll;
      const per = elapsed / done;
      const left = rows.length - done;
      process.stdout.write(
        `── 进度 ${done}/${rows.length} · 填过 ${rowsFilled} 行 · 没填 ${rowsUntouched} 行`
        + ` · 跳过 ${rowsSkipped} · 失败 ${failures.length} · ${seconds(elapsed)}`
        + ` · 均 ${(per / 1000).toFixed(1)}s/行 · 预计还要 ${Math.round((per * left) / 1000)}s ──\n`,
      );
    }
  });

  const elapsed = Date.now() - startedAll;
  process.stdout.write('\n══ 汇总 ══════════════════════════════════════════════════\n');
  process.stdout.write(`处理 ${done} 行 · 耗时 ${seconds(elapsed)}（均 ${(elapsed / Math.max(done, 1) / 1000).toFixed(2)}s/行）\n`);
  process.stdout.write(`${dryRun ? '会填' : '填过'} ${rowsFilled} 行 · 一格都没填 ${rowsUntouched} 行`
    + ` · 跳过 ${rowsSkipped} 行 · 失败 ${failures.length} 行\n`);
  if (!dryRun) process.stdout.write(`本次补满五格的行：${completeAfter.length}\n`);
  process.stdout.write('每格填了几行：\n');
  for (const key of FILL_KEYS) {
    process.stdout.write(`  ${key.padEnd(14)}${String(perField.get(key) ?? 0).padStart(5)} 行  ${LABEL[key]}\n`);
  }
  process.stdout.write(`被丢弃的引文（模型说了但原文里找不到）：${rejectedTotal} 条\n`);

  if (failures.length > 0) {
    process.stdout.write(`\n失败 ${failures.length} 行（重跑这个脚本就会只补它们）：\n`);
    for (const failure of failures) {
      process.stdout.write(`  #${failure.number} ${failure.error}\n`);
    }
  }
  if (stillPartial.length > 0) {
    process.stdout.write(`\n仍然缺格 ${stillPartial.length} 行的前 20 条（模型没说的格是真没有，别硬填）：\n`);
    for (const item of stillPartial.slice(0, 20)) {
      process.stdout.write(`  #${item.number} 缺 ${names(item.keys)}`
        + `${item.rejected > 0 ? `（其中 ${item.rejected} 条是引文对不上）` : ''} ${item.title}\n`);
    }
  }
  if (dryRun) {
    process.stdout.write('\n--dry-run：只调模型、没写库。判过质量之后去掉它再跑。\n');
  }
}

await main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
