import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db, pool } from '../src/db/client.js';
import { recordLocate } from '../src/core/locate/ledger.js';
import { keywordsFrom } from '../src/core/uemaster/inspect.js';
import { locateFromHistory } from '../src/core/locate/history.js';
import type { HistoryRow } from '../src/core/locate/history-store.js';
import { ABSENT_HEADLINE, NOT_FOUND_HEADLINE } from '../src/core/locate/copy.js';
import {
  descriptionOf, locateForInspect, locateQuery, renderLocate, type LocateDeps,
} from '../src/core/uemaster/inspect.js';
import { resetDb } from './helpers/db.js';

/**
 * 走查接线（Task 8）：定位只走合并历史这一条路，且**读不到 ≠ 没有**。
 *
 * 这一组用例钉的是「三种情况在出口处仍然分得开」——本仓已经两次栽在同一形状上
 * （`mergeHistory` 把失败的退出码吞成空历史、`ensureHistory` 写坏一批只留下半段）。
 * 所以每条用例除了断言 `kind`，还要断言**材料里那句话**：那是 PM 唯一看得到的东西，
 * 结论对不对先不谈，先保证「没读到」永远不会被渲染成「代码里没有」。
 *
 * 两个读口（`ensureHistory` / `readHistory`）是**注入**的：真镜像造不出「ssh 超时」，
 * 而这条链要断言的恰恰是失败时的分支。记账（`recordLocate`）用真的——它写的是库，
 * 假对象测不出「忘了 await」。
 */

/** 一份「读得到、且与需求相似」的历史：一条功能合并，动了两个功能路径文件。 */
const ROWS: HistoryRow[] = [
  {
    repo: '123pan-uni-app',
    commitSha: 'a'.repeat(40),
    mergedAt: '2026-11-06T02:00:00.000Z',
    branch: 'feat-share-search',
    message: 'feat: 分享页搜索入口 / 全链接搜索范围切换',
    files: ['src/pages/Share/Share.tsx', 'src/pages/Share/Search.tsx'],
  },
];

/** 镜像读不到：一句点名原因的中文（`why` 会被原样带进材料）。 */
const REASON = '读合并历史失败：123pan-uni-app（/srv/mirror/uni.git）：镜像 ssh 连接超时';

function depsOf(over: Partial<LocateDeps>): LocateDeps {
  return {
    ensureHistory: async () => ({ ok: true, data: { inserted: 0, total: ROWS.length, ms: 1 } }),
    readHistory: async () => ROWS,
    recordLocate,
    ...over,
  };
}

type Row = { stage: string; outcome: string; candidates: number; requirement_id: string | null };

/** 全表按写入顺序读回来。 */
async function ledger(): Promise<Row[]> {
  const res = await db.execute<Row>(sql`
    select stage, outcome, candidates, requirement_id from locate_runs order by created_at`);
  return res.rows;
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});

describe('读不到代码：absent（不是「没有」）', () => {
  it('ensureHistory 失败 → absent；消息带原因，且不许出现「代码里没有」', async () => {
    let readCalls = 0;
    const got = await locateForInspect(db, {
      repoId: '123pan-uni-app',
      query: '分享页搜索入口',
      requirementId: null,
      deps: depsOf({
        ensureHistory: async () => ({ ok: false, code: 'git_failed', message: REASON }),
        // 读库这一步**不许**在补齐失败之后再跑：那不是「没读到」，是「读了一半」。
        readHistory: async () => { readCalls += 1; return ROWS; },
      }),
    });

    expect(got.kind).toBe('absent');
    if (got.kind !== 'absent') return;
    expect(got.why).toContain('镜像 ssh 连接超时');
    expect(readCalls).toBe(0);
    // 文案层对空数组抛，所以 absent 永远不该走到候选那一路
    expect(() => renderLocate(got)).not.toThrow();
  });

  it('readHistory 抛错（库/连接坏了也是「没读到」）→ absent，原因里带原始那句', async () => {
    const got = await locateForInspect(db, {
      repoId: '123pan-uni-app',
      query: '分享页搜索入口',
      requirementId: null,
      deps: depsOf({
        readHistory: async () => { throw new Error('connection terminated unexpectedly'); },
      }),
    });

    expect(got.kind).toBe('absent');
    if (got.kind === 'absent') expect(got.why).toContain('connection terminated unexpectedly');
  });
});

describe('读到了：none 与 candidates 分得开', () => {
  it('读到了、没有相似合并 → none', async () => {
    const got = await locateForInspect(db, {
      repoId: '123pan-uni-app',
      query: '发票报销审批流',
      requirementId: null,
      deps: depsOf({}),
    });
    expect(got).toEqual({ kind: 'none' });
  });

  it('读到相似合并 → candidates，一律 low，每条 reason 非空', async () => {
    const got = await locateForInspect(db, {
      repoId: '123pan-uni-app',
      query: '分享页搜索入口',
      requirementId: null,
      deps: depsOf({}),
    });

    expect(got.kind).toBe('candidates');
    if (got.kind !== 'candidates') return;
    expect(got.confidence).toBe('low');
    expect(got.items.length).toBeGreaterThan(0);
    for (const item of got.items) {
      expect(item.reason.trim()).not.toBe('');
      expect(item.source).toBe('history');
    }
    // 真答案必须在清单里，否则「有候选」是句空话
    expect(got.items.map((item) => item.path)).toContain('src/pages/Share/Share.tsx');
  });
});

describe('检索式：标题 + 描述原文（不是关键词表）', () => {
  /** 两条各自只跟「标题」或只跟「描述」对得上的合并。 */
  const TWO: HistoryRow[] = [
    {
      repo: '123pan-pc',
      commitSha: 'b'.repeat(40),
      mergedAt: '2026-10-02T02:00:00.000Z',
      branch: 'feat-share-search',
      message: 'feat: 分享页搜索补齐 / 工具栏搜索入口改成输入框',
      files: ['src/pages/Share/Share.tsx'],
    },
    {
      repo: '123pan-pc',
      commitSha: 'c'.repeat(40),
      mergedAt: '2026-09-18T02:00:00.000Z',
      branch: 'feat-download-limit',
      message: 'feat: 下载限速风控开发',
      files: ['src/services/download-risk-modal.ts'],
    },
  ];

  const TITLE = '分享页搜索补齐';
  const DESC = '上传下载按量限速：超过阈值的下载要弹风控提示';

  function pathsOf(text: string): string[] {
    const got = locateFromHistory(TWO, text);
    return got.kind === 'candidates' ? got.items.map((item) => item.path) : [];
  }

  it('带描述与不带描述，候选不同：描述那条只在带描述时进得来', () => {
    const without = pathsOf(locateQuery(TITLE, null));
    const withDesc = pathsOf(locateQuery(TITLE, DESC));

    expect(without).toContain('src/pages/Share/Share.tsx');
    expect(without).not.toContain('src/services/download-risk-modal.ts');

    expect(withDesc).toContain('src/services/download-risk-modal.ts');
    expect(withDesc).toContain('src/pages/Share/Share.tsx'); // 标题那一路没被描述挤掉
    expect(withDesc).not.toEqual(without);
  });

  it('描述是**原文**整句进去，不是 keywordsFrom 切出来的词', () => {
    const query = locateQuery(TITLE, DESC);
    expect(query).toContain(DESC); // 一个字都没被切掉
    // 关键词表里没有这句原文（它是 n-gram 的碎片集合）——两者不能互相冒充
    expect(keywordsFrom(DESC, TITLE).join(' ')).not.toContain(DESC);
    expect(query.startsWith(TITLE)).toBe(true);
  });

  it('没有描述就只传标题（不拿关键词补位）', () => {
    expect(locateQuery(TITLE, null)).toBe(TITLE);
    expect(locateQuery(TITLE, '   ')).toBe(TITLE);
  });

  it('描述从六问拼出来：老数据那段自由文本在 context 里', () => {
    expect(descriptionOf({
      context: '上传下载按量限速', problem: '现在不提示',
      outcome: '', surfaces: null, edge_cases: '  ', out_of_scope: '不涉及',
    })).toBe('上传下载按量限速\n现在不提示\n不涉及');
    expect(descriptionOf({
      context: null, problem: null, outcome: null, surfaces: null, edge_cases: null, out_of_scope: null,
    })).toBe('');
  });
});

describe('材里那句话：三种情况各说各的', () => {
  it('absent 的正文带原因，且与 none 的正文不同', async () => {
    const absent = await locateForInspect(db, {
      repoId: 'r',
      query: 'x',
      requirementId: null,
      deps: depsOf({ ensureHistory: async () => ({ ok: false, code: 'git_failed', message: REASON }) }),
    });
    const none = await locateForInspect(db, {
      repoId: 'r',
      query: '发票报销审批流',
      requirementId: null,
      deps: depsOf({}),
    });

    const absentText = renderLocate(absent);
    const noneText = renderLocate(none);

    expect(absentText.startsWith(ABSENT_HEADLINE)).toBe(true);
    expect(absentText).toContain('镜像 ssh 连接超时');
    expect(absentText).not.toContain('代码里没有');

    expect(noneText.startsWith(NOT_FOUND_HEADLINE)).toBe(true);
    expect(noneText).not.toContain('镜像 ssh 连接超时');
    // 两句不许互相接近：这就是本次改造要保住的那条缝
    expect(noneText).not.toBe(absentText);
    expect(noneText).not.toContain('这一轮不含任何现状判断');
  });

  it('candidates 的正文是「待研发确认」的编号清单', async () => {
    const got = await locateForInspect(db, {
      repoId: 'r',
      query: '分享页搜索入口',
      requirementId: null,
      deps: depsOf({}),
    });
    const text = renderLocate(got);
    expect(text.startsWith('最可能的位置（待研发确认）：')).toBe(true);
    expect(text).toContain('src/pages/Share/Share.tsx');
    expect(text).toContain('以上是线索，不是结论');
  });
});

describe('记账：每次定位一条，outcome 对得上', () => {
  it('三种情况各写一条，阶段是 inspect', async () => {
    await locateForInspect(db, {
      repoId: 'pc',
      query: 'x',
      requirementId: null,
      deps: depsOf({ ensureHistory: async () => ({ ok: false, code: 'git_failed', message: REASON }) }),
    });
    await locateForInspect(db, {
      repoId: 'pc',
      query: '发票报销审批流',
      requirementId: null,
      deps: depsOf({}),
    });
    await locateForInspect(db, {
      repoId: 'pc',
      query: '分享页搜索入口',
      requirementId: null,
      deps: depsOf({}),
    });

    const rows = await ledger();
    expect(rows.map((row) => row.outcome)).toEqual(['absent', 'none', 'low']);
    expect(rows.map((row) => row.candidates)).toEqual([0, 0, 2]);
    for (const row of rows) expect(row.stage).toBe('inspect');
  });

  it('需求 id 原样落库（null 就是 null，不编一个）', async () => {
    await locateForInspect(db, {
      repoId: 'pc',
      query: '分享页搜索入口',
      requirementId: null,
      deps: depsOf({}),
    });
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requirement_id).toBeNull();
  });

  it('记账失败往上抛，不降级成一条「记不上就算了」', async () => {
    await expect(locateForInspect(db, {
      repoId: 'pc',
      query: '分享页搜索入口',
      requirementId: null,
      deps: depsOf({ recordLocate: async () => { throw new Error('locate_runs 写不进去'); } }),
    })).rejects.toThrow('locate_runs 写不进去');
  });
});
