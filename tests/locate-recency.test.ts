import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/client.js';
import type { Db } from '../src/db/client.js';
import {
  RECENCY_CAP, recencyOf, topRecent, type RecentFile,
} from '../src/core/locate/recency.js';
import {
  RECENCY_OLD_TAIL, RECENCY_PREFIX, recencyLines, withRecency,
} from '../src/core/locate/copy.js';
import { shanghaiDayOf } from '../src/core/clock/tick.js';
import { resetDb } from './helpers/db.js';

/**
 * 「最近改动」这一行（Task 6）。
 *
 * 钉的是两件事，刻意分开两组：
 *
 * 1. **查日期**（`recencyOf`）：它必须是一次查询、按仓分组、取 `max(merged_at)`、
 *    按北京时间的整数天差算天数，并且**查不到就不出现**（不是 0 天、不是 null 日期）。
 *    这些都是「事实型」契约——与 Task 5 的先例行不同，这里没有相似度可以争论，
 *    对错只有一条：日期是不是那次合并的。
 * 2. **那一行怎么长**（`recencyLines` / `withRecency`）：逐字钉住，尤其是
 *    **没有已知条目时一个字都不写**。写「最近改动：未知」会把「我们手上没有这条记录」
 *    说成「查过了、确实没有」——本仓修过两遍的同一种假话。
 *
 * 真库：`commit_history` 是迁移里的真表，用例自己插行（`resetDb` 清得掉它），
 * 假对象测不出 `files @> jsonb_build_array(...)` 这种 SQL 层的语义。
 */

type Merge = {
  repo: string;
  sha: string;
  at: string;
  files: string[];
  message?: string;
};

/** 插一次合并。`files` 就是那次合并动过的路径数组——这一行的日期全部由它派生。 */
async function merge(input: Merge): Promise<void> {
  await db.execute(sql`
    insert into commit_history (repo, commit_sha, merged_at, branch, message, files)
    values (${input.repo}, ${input.sha}, ${input.at}::timestamptz, ${'feat-x'},
            ${input.message ?? 'feat: 分享页搜索补齐'}, ${JSON.stringify(input.files)}::jsonb)`);
}

/** 记一次 `execute` 的包装：用例要证明「一批文件只查一次」（N+1 会让材料慢 6 倍）。 */
function counting(target: Db): { db: Db; calls: () => number } {
  let calls = 0;
  const wrapped = new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (prop !== 'execute') return typeof value === 'function' ? value.bind(obj) : value;
      return (...args: unknown[]) => {
        calls += 1;
        return (value as (...a: unknown[]) => unknown).apply(obj, args);
      };
    },
  }) as Db;
  return { db: wrapped, calls: () => calls };
}

const TODAY = new Date('2026-11-09T10:00:00+08:00');

const FILE = 'src/pages/Share/Share.tsx';

beforeEach(async () => {
  await resetDb();
});

describe('recencyOf：一批文件 → 最近一次被合进来的日期', () => {
  it('取 max(merged_at)：同一个文件被两次合并碰过，取最近的那一次', async () => {
    await merge({ repo: '123pan-pc', sha: 'a'.repeat(40), at: '2026-06-01T02:00:00Z', files: [FILE] });
    await merge({ repo: '123pan-pc', sha: 'b'.repeat(40), at: '2026-09-12T02:00:00Z', files: [FILE, 'src/a.ts'] });

    const got = await recencyOf(db, [{ repo: '123pan-pc', path: FILE }], TODAY);
    expect(got).toHaveLength(1);
    expect(got[0]!.lastMergedAt).toBe('2026-09-12T02:00:00.000Z');
    // 2026-09-12 → 2026-11-09：58 天（北京时间口径）
    expect(got[0]!.days).toBe(58);
  });

  it('同一个路径在两个仓是两个文件：各拿各的日期', async () => {
    await merge({ repo: '123pan-pc', sha: 'c'.repeat(40), at: '2026-10-01T02:00:00Z', files: [FILE] });
    await merge({ repo: '123pan-uni-app', sha: 'd'.repeat(40), at: '2026-11-01T02:00:00Z', files: [FILE] });

    const got = await recencyOf(db, [
      { repo: '123pan-pc', path: FILE },
      { repo: '123pan-uni-app', path: FILE },
    ], TODAY);
    expect(got.map((item) => [item.repo, item.days])).toEqual([
      ['123pan-pc', 39],
      ['123pan-uni-app', 8],
    ]);
  });

  it('查不到就不出现：没有合并记录的文件**不返回 null 日期、不返回 0 天**', async () => {
    await merge({ repo: '123pan-pc', sha: 'e'.repeat(40), at: '2026-10-01T02:00:00Z', files: [FILE] });

    const got = await recencyOf(db, [
      { repo: '123pan-pc', path: FILE },
      { repo: '123pan-pc', path: 'src/pages/Never/merged.ts' },
      // 路径对、仓错：同一个路径在另一个仓没被合并过，也不许串过来
      { repo: '123pan-uni-app', path: FILE },
    ], TODAY);
    expect(got.map((item) => item.path)).toEqual([FILE]);
    expect(got.map((item) => item.repo)).toEqual(['123pan-pc']);
  });

  it('一次查询解决一批（不做 N+1）', async () => {
    await merge({ repo: '123pan-pc', sha: 'f'.repeat(40), at: '2026-10-01T02:00:00Z', files: [FILE] });
    const spy = counting(db);

    await recencyOf(spy.db, [
      { repo: '123pan-pc', path: FILE },
      { repo: '123pan-pc', path: 'src/b.ts' },
      { repo: '123pan-uni-app', path: 'src/c.ts' },
    ], TODAY);
    expect(spy.calls()).toBe(1);
  });

  it('空输入不查库', async () => {
    const spy = counting(db);
    expect(await recencyOf(spy.db, [], TODAY)).toEqual([]);
    expect(spy.calls()).toBe(0);
  });

  it('天数按 Asia/Shanghai 算：UTC 前一天 16:30 的合并 = 北京时间今天，是 0 天', async () => {
    // 2026-11-08T16:30:00Z = 2026-11-09 00:30 北京时间。
    // 按 UTC 算日期会得到「1 天前」，同一个文件在两份材料里就会差一天。
    await merge({ repo: '123pan-pc', sha: 'g'.repeat(40), at: '2026-11-08T16:30:00Z', files: [FILE] });

    const got = await recencyOf(db, [{ repo: '123pan-pc', path: FILE }], TODAY);
    expect(got[0]!.days).toBe(0);
    // 材料上印的日期与天数必须是同一套口径（否则一行里两个值互相打脸）
    expect(recencyLines(got)).toEqual([
      `${RECENCY_PREFIX}123pan-pc:${FILE} @ 2026-11-09（0 天前）`,
    ]);
  });

  it('镜像时钟超前（合并时间晚于今天）时按 0 天算，不写「-3 天前」', async () => {
    // 镜像机器的时钟比我们快是真实存在的：写负数读者只会以为算错了。
    await merge({ repo: '123pan-pc', sha: 'l'.repeat(40), at: '2026-11-12T02:00:00Z', files: [FILE] });

    const got = await recencyOf(db, [{ repo: '123pan-pc', path: FILE }], TODAY);
    expect(got[0]!.days).toBe(0);
  });

  it('排序：天数降序 → 仓 → 路径（先给最久没人动的，截断才稳定）', async () => {
    await merge({ repo: '123pan-pc', sha: 'h'.repeat(40), at: '2026-11-01T02:00:00Z', files: ['src/b.ts'] });
    await merge({ repo: '123pan-uni-app', sha: 'i'.repeat(40), at: '2026-05-01T02:00:00Z', files: ['src/a.vue'] });
    await merge({ repo: '123pan-pc', sha: 'j'.repeat(40), at: '2026-11-01T02:00:00Z', files: ['src/a.ts'] });

    const got = await recencyOf(db, [
      { repo: '123pan-pc', path: 'src/b.ts' },
      { repo: '123pan-uni-app', path: 'src/a.vue' },
      { repo: '123pan-pc', path: 'src/a.ts' },
    ], TODAY);
    expect(got.map((item) => `${item.repo}:${item.path}`)).toEqual([
      '123pan-uni-app:src/a.vue',
      '123pan-pc:src/a.ts',
      '123pan-pc:src/b.ts',
    ]);
  });

  it('重复的 (repo,path) 只回一行（同一条候选被两条合并的清单带进来）', async () => {
    await merge({ repo: '123pan-pc', sha: 'k'.repeat(40), at: '2026-10-01T02:00:00Z', files: [FILE] });

    const got = await recencyOf(db, [
      { repo: '123pan-pc', path: FILE },
      { repo: '123pan-pc', path: FILE },
    ], TODAY);
    expect(got).toHaveLength(1);
  });
});

describe('recencyLines：材料上那几行长什么样', () => {
  const item = (over: Partial<RecentFile> = {}): RecentFile => ({
    repo: '123pan-pc',
    path: FILE,
    lastMergedAt: '2026-09-12T02:00:00.000Z',
    days: 57,
    ...over,
  });

  it('单条逐字：前缀 + 仓:路径 + 北京时间日期 + 天数', () => {
    expect(recencyLines([item()])).toEqual([
      '最近改动：123pan-pc:src/pages/Share/Share.tsx @ 2026-09-12（57 天前）',
    ]);
    expect(RECENCY_PREFIX).toBe('最近改动：');
  });

  it('超过 180 天才追加「已经很久没人动过」：180 不追加、181 追加', () => {
    expect(recencyLines([item({ days: 180 })])[0]).not.toContain(RECENCY_OLD_TAIL);
    expect(recencyLines([item({ days: 181 })])[0]).toBe(
      `最近改动：123pan-pc:src/pages/Share/Share.tsx @ 2026-09-12（181 天前）${RECENCY_OLD_TAIL}`,
    );
  });

  it('没有已知条目时一个字都不写：不写「未知」、不写「无记录」', () => {
    expect(recencyLines([])).toEqual([]);
    expect(withRecency('结论', [])).toBe('结论');
    expect(withRecency('结论', [item()])).toContain(`${RECENCY_PREFIX}123pan-pc:`);
  });

  it('日期读不出来就跳过那一条，不编日期', () => {
    expect(recencyLines([item({ lastMergedAt: '不是日期' })])).toEqual([]);
  });

  it('最多 5 条：截断发生在排序之后（最久没动的那几条先留下）', () => {
    expect(RECENCY_CAP).toBe(5);
    const many = Array.from({ length: 6 }, (_, i) => item({ path: `src/f${i}.ts`, days: i }));
    const kept = topRecent(many);
    expect(kept).toHaveLength(5);
    // 输入已从大到小排？这里故意不排：截断只负责按给定顺序取前 5，排序是 recencyOf 的事
    expect(kept.map((one) => one.days)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('「今天」不可解析：抛，而不是回一份空清单', () => {
  it('非法 Date → 抛（空清单会被读成「这些文件都没改动记录」）', async () => {
    await expect(recencyOf(db, [{ repo: '123pan-pc', path: FILE }], new Date('x')))
      .rejects.toThrow(/recencyOf/);
  });

  it('shanghaiDayOf 与 recencyOf 同一套「第几天」口径', () => {
    expect(shanghaiDayOf(TODAY.toISOString())).toBe(shanghaiDayOf('2026-11-09T00:00:00+08:00'));
  });
});
