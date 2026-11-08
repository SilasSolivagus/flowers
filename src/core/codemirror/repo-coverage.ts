import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { summarize, type CodeIndex } from './code-index.js';

/**
 * 仓覆盖率（迁移 0033）：把「接入这个仓时，索引到底看见了什么」记成一行。
 *
 * ── 为什么非要记这件事
 *
 * 「镜像同步成功」是一句很容易为真的话：`git ls-tree` 能列文件就够了。而 123pan 的仓
 * 有两类**同步成功、索引却看不见**的情形，且它们长得一模一样：
 *
 * - 仓里本来就没多少源码（打包产物 / 资源仓 / 后端 Java 仓——解析器只认
 *   `[ts|tsx|js|jsx|mjs|cjs|vue]`）；
 * - 仓里有源码，但我们的解析器没认出它的目录约定（`pages.json` 不合法、
 *   页面在 `src/views` 而不是 `src/pages`）。
 *
 * 两者的下一步完全不同（前者：这个仓不该进清单；后者：解析器要补一条约定），
 * 而「镜像 ok」这个说法把它们混成一件。所以每仓一行、四个数摆在一起：
 * `files_total`（树里多少）、`files_indexed`（索引吃进多少）、`pages`、`outline_files`。
 * `files_total - files_indexed` 就是**要解释的那部分**，`imports = 0` 则是「解析进去了
 * 但连不起来」的信号（一个真有代码的仓不可能零 import 边）。
 *
 * ── 为什么记录口径不放在 `index-store.ts` 里
 *
 * 那一层是**读路径**（走查/评审懒建索引时用），它不该知道「批量接入」这种运维动作存在。
 * 覆盖率是一次**测量**，测量属于脚本；这里只放「怎么把测量结果写成一行」与
 * 「什么情况下可以跳过」这两件纯逻辑。
 */

/** `repo_coverage` 的一行（camelCase；库里的列名见迁移 0033）。 */
export type CoverageRow = {
  repo: string;
  headSha: string | null;
  headDate: string | null;
  filesTotal: number;
  filesIndexed: number;
  /**
   * 因为「生成代码」被跳过的文件数（迁移 0034）。
   *
   * 为什么它就是覆盖率表要的那一格：`filesTotal - filesIndexed` 原本只有一种解释
   * （「索引看不见」），而 Go 仓里这个差的大头是**正当跳过**。摆在同一行之后，
   * `352 + 231 = 583` 自己就把话说完了，不用去猜解析器有没有坏。
   */
  filesSkippedGenerated: number;
  pages: number;
  outlineFiles: number;
  imports: number;
  ok: boolean;
  error: string | null;
  measuredAt?: string;
};

/**
 * 从一个装配好的索引里数出覆盖率四格。
 *
 * 纯函数、不碰 git 也不碰库：`filesTotal` 由调用方给（它来自 `ls-tree`，与索引不是
 * 同一趟 I/O），其余三项从索引本身数。这样「数错了」是一个可以单测的问题，而不是
 * 「要连一次 dogyun 才能复现」。
 */
export function coverageCounts(
  index: Pick<CodeIndex, 'files' | 'pages' | 'outline' | 'imports' | 'skippedGenerated'>,
  treeFiles: number,
): Pick<CoverageRow, 'filesTotal' | 'filesIndexed' | 'filesSkippedGenerated' | 'pages' | 'outlineFiles' | 'imports'> {
  const summary = summarize(index as CodeIndex);
  return {
    filesTotal: treeFiles,
    filesIndexed: Object.keys(index.files).length,
    // 索引自己数的（`CodeIndex.skippedGenerated`），不是拿 treeFiles 减出来的：
    // 减出来的那个数把「读不回来」也算进去了，正是这一列要分开的东西。
    filesSkippedGenerated: index.skippedGenerated,
    pages: index.pages.length,
    outlineFiles: Object.keys(index.outline).length,
    imports: summary.imports,
  };
}

/**
 * 这一仓能不能跳过。
 *
 * 判据是 **同一个 HEAD 且上一轮 ok**：
 * - 同 sha、上一轮 ok → 跳过（这是续跑的全部意义：139 个仓跑一半断了，重跑不该从零开始）；
 * - 上一轮 `ok = false` → **不跳过**。失败要能被重试，而 HEAD 没动恰恰是「再试一次」
 *   最常见的场景（一次 ssh 抖动、一次库连接超时）；
 * - `headSha` 是 null（上一次连 HEAD 都没读到）→ 不跳过。
 *
 * `--force` 由调用方在这一层之外处理：它表达的是「我就是要重测」，与判据无关。
 */
export function shouldSkip(existing: CoverageRow | null, headSha: string): boolean {
  if (existing === null) return false;
  return existing.ok && existing.headSha === headSha;
}

/** 写一行（同仓覆盖）。`measured_at` 用库的 `now()`：这一列是「什么时候测的」，不是业务时刻。 */
export async function recordCoverage(db: Db, row: CoverageRow): Promise<void> {
  await db.execute(sql`
    insert into repo_coverage
      (repo, head_sha, head_date, files_total, files_indexed, files_skipped_generated,
       pages, outline_files, imports, ok, error, measured_at)
    values
      (${row.repo}, ${row.headSha}, ${row.headDate}, ${row.filesTotal}, ${row.filesIndexed},
       ${row.filesSkippedGenerated}, ${row.pages}, ${row.outlineFiles}, ${row.imports},
       ${row.ok}, ${row.error}, now())
    on conflict (repo) do update set
      head_sha = excluded.head_sha,
      head_date = excluded.head_date,
      files_total = excluded.files_total,
      files_indexed = excluded.files_indexed,
      files_skipped_generated = excluded.files_skipped_generated,
      pages = excluded.pages,
      outline_files = excluded.outline_files,
      imports = excluded.imports,
      ok = excluded.ok,
      error = excluded.error,
      measured_at = now()`);
}

type RawRow = {
  repo: string;
  head_sha: string | null;
  head_date: Date | string | null;
  files_total: number;
  files_indexed: number;
  files_skipped_generated: number;
  pages: number;
  outline_files: number;
  imports: number;
  ok: boolean;
  error: string | null;
  measured_at: Date | string;
};

function toRow(raw: RawRow): CoverageRow {
  const iso = (value: Date | string | null): string | null =>
    value === null ? null : value instanceof Date ? value.toISOString() : value;
  return {
    repo: raw.repo,
    headSha: raw.head_sha,
    headDate: iso(raw.head_date),
    filesTotal: Number(raw.files_total),
    filesIndexed: Number(raw.files_indexed),
    filesSkippedGenerated: Number(raw.files_skipped_generated),
    pages: Number(raw.pages),
    outlineFiles: Number(raw.outline_files),
    imports: Number(raw.imports),
    ok: raw.ok,
    error: raw.error,
    measuredAt: iso(raw.measured_at) ?? undefined,
  };
}

/** 读一仓的上一行（没有就是 null）。 */
export async function readCoverage(db: Db, repo: string): Promise<CoverageRow | null> {
  const res = await db.execute<RawRow>(sql`
    select repo, head_sha, head_date, files_total, files_indexed, files_skipped_generated,
           pages, outline_files, imports, ok, error, measured_at
      from repo_coverage where repo = ${repo}`);
  const row = res.rows[0];
  return row === undefined ? null : toRow(row);
}

/** 读全部（按仓名排序，便于人逐行对照）。 */
export async function listCoverage(db: Db): Promise<CoverageRow[]> {
  const res = await db.execute<RawRow>(sql`
    select repo, head_sha, head_date, files_total, files_indexed, files_skipped_generated,
           pages, outline_files, imports, ok, error, measured_at
      from repo_coverage order by repo`);
  return res.rows.map(toRow);
}

// ─── 磁盘预算（纯函数：不碰 ssh、不碰库，所以能被用例钉住） ───────────────────

/** 磁盘闸的默认水位：**剩不到 10 GB 就不许再 clone**。 */
export const DEFAULT_DISK_FLOOR_GB = 10;

export type DiskGuardInput = {
  /** 服务器上镜像根所在文件系统的可用空间（GB）。 */
  freeGb: number;
  /** 这一批**还没建**的仓，按当前每仓估算需要多少（GB）。 */
  needGb: number;
  /** 水位：可用空间减掉 need 之后必须还剩这么多。 */
  floorGb?: number;
};

export type DiskGuardDecision =
  | { ok: true; freeGb: number; needGb: number; afterGb: number; floorGb: number; message: string }
  | { ok: false; freeGb: number; needGb: number; afterGb: number; floorGb: number; message: string };

/**
 * 要不要继续 clone。
 *
 * 判据是「可用 − 这一批还没建的部分 ≥ 水位」，不是「可用 ≥ 水位」：139 个仓一起进来时，
 * 前者是「还装得下这一批吗」，后者是「现在还有地方吗」——后者会在第 100 个仓之后
 * 才开始喊，而那时磁盘已经 96% 了（`ENOSPC` 的错法是 git 在写一半的 pack 上失败，
 * 留下一个半成品 bare 仓，比没建更糟）。
 *
 * **第一次跑时 `needGb = 0`**（还没有任何实测），于是它只报警不拦——见调用方：
 * 「首轮只测量并告警」，因为用一个猜出来的均值去拦 139 个仓的批量，比不拦更容易
 * 造成误判（估大了会拦住本来装得下的批次）。
 */
export function diskGuard(input: DiskGuardInput): DiskGuardDecision {
  const floorGb = input.floorGb ?? DEFAULT_DISK_FLOOR_GB;
  const freeGb = round1(input.freeGb);
  const needGb = round1(input.needGb);
  const afterGb = round1(freeGb - needGb);
  if (afterGb < floorGb) {
    return {
      ok: false, freeGb, needGb, afterGb, floorGb,
      message: `磁盘不够：可用 ${freeGb} GB − 这批还要 ${needGb} GB = ${afterGb} GB，低于水位 ${floorGb} GB；`
        + '先扩盘或缩小批次（--budget-gb 只是记账口径，水位是硬线）',
    };
  }
  return {
    ok: true, freeGb, needGb, afterGb, floorGb,
    message: `磁盘够：可用 ${freeGb} GB − 这批还要 ${needGb} GB = ${afterGb} GB ≥ 水位 ${floorGb} GB`,
  };
}

/**
 * 两位小数：磁盘数只用来做判断，但**不能只留一位**——12 M 的仓在一位小数下会显示成
 * `0.0 GB`，于是「这批还要 0 GB，够」读起来像什么都没算。两位小数刚好让 0.01 与 0.00
 * 分得开，又不至于让人以为我们在做精度承诺。
 */
function round1(value: number): number {
  return Math.round(value * 100) / 100;
}

export type DiskProjection = {
  /** 实测样本（每仓 GB）。 */
  samples: number[];
  /** 中位数：比均值抗一个离群仓（`123pan-pc` 2.4 G vs 12 M，均值毫无意义）。 */
  medianGb: number;
  meanGb: number;
  /** 用中位数外推 `targetCount` 个仓的总量。 */
  projectedGb: number;
  /** 区间：最小样本 × N 到 最大样本 × N——这是「不确定性」本身，不是标准差。 */
  lowGb: number;
  highGb: number;
};

/**
 * 从已测样本外推总数。
 *
 * 为什么给**区间**而不是一个数：样本里最小 12 M、最大 2.4 G，差 200 倍。用均值乘 139
 * 会得到「大约 100 GB」这样的数字，它既不保守也不激进，只是把两个数量级揉在一起。
 * 中位数 × N 是点估计，最小/最大 × N 是区间——真实的 139 个仓几乎不可能全都比样本
 * 里最大的还大，也不全都比最小的小。
 *
 * `uncertainty` 一句话说清这份估计**凭什么**能/不能信，直接进报告。
 */
export function projectDisk(samples: readonly number[], targetCount: number): DiskProjection {
  const clean = samples.filter((value) => Number.isFinite(value) && value > 0).slice().sort((a, b) => a - b);
  if (clean.length === 0 || targetCount <= 0) {
    return { samples: [], medianGb: 0, meanGb: 0, projectedGb: 0, lowGb: 0, highGb: 0 };
  }
  const mid = Math.floor(clean.length / 2);
  const medianGb = clean.length % 2 === 1
    ? (clean[mid] ?? 0)
    : ((clean[mid - 1] ?? 0) + (clean[mid] ?? 0)) / 2;
  const meanGb = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  const min = clean[0] ?? 0;
  const max = clean[clean.length - 1] ?? 0;
  return {
    samples: clean,
    medianGb: round3(medianGb),
    meanGb: round3(meanGb),
    projectedGb: round3(medianGb * targetCount),
    lowGb: round3(min * targetCount),
    highGb: round3(max * targetCount),
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
