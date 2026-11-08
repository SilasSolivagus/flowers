import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import type { CodeIndex } from '../src/core/codemirror/code-index.js';
import {
  DEFAULT_DISK_FLOOR_GB, coverageCounts, diskGuard, listCoverage, projectDisk, readCoverage,
  recordCoverage, shouldSkip, type CoverageRow,
} from '../src/core/codemirror/repo-coverage.js';

/**
 * 覆盖率（迁移 0033）与磁盘预算。
 *
 * 这一组钉三件事，顺序按「先是数据、再是判断、最后是外推」：
 *
 * | 组 | 钉的是什么 |
 * |---|---|
 * | 记录 | 一仓一行（同仓覆盖）、`files_indexed` 是**结果**不是上限、`measured_at` 是库的时刻 |
 * | 续跑 | 同 HEAD 且上一轮 ok 才跳过；失败 / 没读到 HEAD **不**跳过（要能重试） |
 * | 磁盘 | 判据是「可用 − 这批还要 ≥ 水位」；水位默认 10 GB；首轮 need=0 只测量不拦 |
 *
 * 库里的行一律用 `fixture-` 前缀的仓名（与 `tests/mirror-health.test.ts` 同一个做法），
 * 跑完删掉自己那几行——这张表故意不在 `reset.ts` 的 `RESET_TABLES` 里（它存的是真实
 * 提交的状态，重建要重跑一次批量接入）。
 */

const PREFIX = 'fixture-onboard-';

afterAll(async () => {
  await db.execute(sql`delete from repo_coverage where repo like ${`${PREFIX}%`}`);
  await pool.end();
});

/** 一份够 `summarize()` 用的最小索引：三个文件、五条 import 边、两条页面、一个轮廓。 */
function fakeIndex(): CodeIndex {
  return {
    repo: 'fixture-onboard-a',
    sha: 'a'.repeat(40),
    files: {
      'src/a.ts': { path: 'src/a.ts', kind: 'ts', size: 10, symbols: ['a'], imports: [] },
      'src/b.ts': { path: 'src/b.ts', kind: 'ts', size: 10, symbols: ['b'], imports: [] },
      'src/c.vue': { path: 'src/c.vue', kind: 'vue', size: 10, symbols: ['c'], imports: [] },
    } as unknown as CodeIndex['files'],
    imports: {
      'src/a.ts': ['src/b.ts', 'src/c.vue'],
      'src/b.ts': ['src/c.vue'],
      'src/c.vue': ['src/a.ts', 'src/b.ts'],
    },
    importedBy: {},
    routes: [],
    pages: [{ route: 'pages/index/index', source: 'pages.json' }, { route: 'pages/mine/mine', source: 'convention' }],
    outline: { 'src/c.vue': [{ kind: 'component', name: 'SearchBox', line: 3 }] },
    builtAt: new Date().toISOString(),
  } as unknown as CodeIndex;
}

describe('coverageCounts', () => {
  it('数的是索引里真有东西的文件，不是树里的可索引文件', () => {
    const counts = coverageCounts(fakeIndex(), 817);
    expect(counts).toEqual({
      filesTotal: 817,
      filesIndexed: 3,
      pages: 2,
      outlineFiles: 1,
      imports: 5,
    });
  });

  it('空索引是 0 而不是抛（mirror_health 一片绿而材料说「没找到」的那一格）', () => {
    const empty = { files: {}, pages: [], outline: {}, imports: {}, routes: [] } as unknown as CodeIndex;
    expect(coverageCounts(empty, 12)).toEqual({
      filesTotal: 12, filesIndexed: 0, pages: 0, outlineFiles: 0, imports: 0,
    });
  });
});

describe('repo_coverage 落库与续跑判据', () => {
  const row = (over: Partial<CoverageRow> = {}): CoverageRow => ({
    repo: `${PREFIX}a`,
    headSha: 'sha-1',
    headDate: '2026-11-07T10:00:00+08:00',
    filesTotal: 100,
    filesIndexed: 40,
    pages: 3,
    outlineFiles: 2,
    imports: 9,
    ok: true,
    error: null,
    ...over,
  });

  it('写一行、读回来（含 measured_at 由库给时刻），同仓覆盖而不是两行', async () => {
    await recordCoverage(db, row());
    const first = await readCoverage(db, `${PREFIX}a`);
    expect(first).not.toBeNull();
    expect(first?.filesTotal).toBe(100);
    expect(first?.measuredAt).toBeTruthy();

    await recordCoverage(db, row({ headSha: 'sha-2', filesIndexed: 50 }));
    const second = await readCoverage(db, `${PREFIX}a`);
    expect(second?.headSha).toBe('sha-2');
    expect(second?.filesIndexed).toBe(50);

    const rows = await listCoverage(db);
    expect(rows.filter((it) => it.repo === `${PREFIX}a`)).toHaveLength(1);
  });

  it('同 HEAD 且上一轮 ok → 跳过；失败 / 没读到 HEAD / 换 HEAD → 不跳过', async () => {
    await recordCoverage(db, row({ repo: `${PREFIX}b`, headSha: 'sha-x', ok: true }));
    const good = await readCoverage(db, `${PREFIX}b`);
    expect(shouldSkip(good, 'sha-x')).toBe(true);
    expect(shouldSkip(good, 'sha-y')).toBe(false);

    await recordCoverage(db, row({ repo: `${PREFIX}c`, headSha: 'sha-x', ok: false, error: 'ssh 断了' }));
    const bad = await readCoverage(db, `${PREFIX}c`);
    // 同 sha 但上一轮失败：HEAD 没动恰恰是「再试一次」最常见的场景。
    expect(shouldSkip(bad, 'sha-x')).toBe(false);

    await recordCoverage(db, row({ repo: `${PREFIX}d`, headSha: null, ok: false, error: '读不到 HEAD' }));
    expect(shouldSkip(await readCoverage(db, `${PREFIX}d`), 'anything')).toBe(false);

    expect(shouldSkip(null, 'sha-x')).toBe(false);
    expect(await readCoverage(db, `${PREFIX}nobody`)).toBeNull();
  });
});

describe('diskGuard：可用的空间减掉这批还要的，不许低于水位', () => {
  it('默认水位 10 GB，正好等于水位也算够（判据是 <）', () => {
    expect(DEFAULT_DISK_FLOOR_GB).toBe(10);
    const edge = diskGuard({ freeGb: 30, needGb: 20 });
    expect(edge.ok).toBe(true);
    expect(edge.afterGb).toBe(10);

    const short = diskGuard({ freeGb: 30, needGb: 20.1 });
    expect(short.ok).toBe(false);
    expect(short.message).toContain('磁盘不够');
  });

  it('首轮没有样本（need = 0）时只报数，不拦', () => {
    const decision = diskGuard({ freeGb: 49, needGb: 0 });
    expect(decision.ok).toBe(true);
    expect(decision.message).toContain('49');
  });

  it('--budget-gb 与 --floor-gb 都进同一句话', () => {
    const decision = diskGuard({ freeGb: 49, needGb: 45, floorGb: 10 });
    expect(decision.ok).toBe(false);
    expect(decision.message).toContain('45');
    expect(decision.message).toContain('10');
  });
});

describe('projectDisk：中位数点估计 + 样本区间', () => {
  it('12 M vs 2.4 G 的样本里，中位数才是那个能外推的数', () => {
    const projection = projectDisk([2.4, 0.008, 0.012], 139);
    expect(projection.medianGb).toBe(0.012);
    expect(projection.projectedGb).toBeCloseTo(1.668, 3);
    // 区间就是「全都跟最小的/最大的样本一样大」，不是标准差。
    expect(projection.lowGb).toBeCloseTo(0.008 * 139, 3);
    expect(projection.highGb).toBeCloseTo(2.4 * 139, 3);
  });

  it('偶数个样本取中间两个的均值', () => {
    expect(projectDisk([1, 2, 3, 4], 10).medianGb).toBe(2.5);
  });

  it('没有样本 / 目标为 0 时全 0（而不是 NaN）', () => {
    expect(projectDisk([], 139)).toEqual({
      samples: [], medianGb: 0, meanGb: 0, projectedGb: 0, lowGb: 0, highGb: 0,
    });
    expect(projectDisk([1], 0).projectedGb).toBe(0);
  });
});
