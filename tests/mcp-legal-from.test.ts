import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { evaluate } from '../src/core/requirements/evaluate.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { reviewPass } from '../src/core/requirements/review.js';
import { schedule } from '../src/core/requirements/schedule.js';
import { rejectRequirement, shelveRequirement } from '../src/core/requirements/terminal.js';
import { startOfShanghaiDay, tick } from '../src/core/clock/tick.js';
import { BOARD_STATES, getBoard } from '../src/core/read/board.js';
import { getRequirementDetail, type DetailAction } from '../src/core/read/detail.js';
import { STATE_LABEL, type State } from '../src/core/state-machine.js';
import { LEGAL_FROM, TOOLS } from '../mcp/tools.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { BRIEF } from './helpers/brief.js';
import { makeRelease } from './helpers/factory.js';

/**
 * **漂移探测器**：MCP 声明的「合法状态」必须与 `detail.ts` 的 `actionsFor` 逐状态相等。
 *
 * 为什么这条测试是这个功能的核心，而不是一条普通回归：
 *
 * `actionsFor` 是「这个状态下哪些动作合法」的唯一口径——页面动作条、抽屉、以及现在的
 * MCP 工具都由它派生（`mcp/tools.ts` 的 `LEGAL_FROM` 是它的镜像，因为它是那个模块的
 * 私有函数，P4 冻结 core 不为 MCP 开导出）。镜像就会漂：有人把 `live` 的「走查」加回
 * 动作条，页面变了、MCP 没变，于是 agent 会看到一个「调了必然被拒」的工具——而这
 * 恰恰是 owner 在选 C（整套状态机交给 agent）时最不想要的东西：**API 与 UI 对同一件
 * 事的说法不一致**。
 *
 * 所以这里不测「某个工具返回什么」，而是把十个状态**都造一遍真需求**，读出
 * `getRequirementDetail(id).actions`（就是 `actionsFor(state)`），再与 MCP 声明比对：
 * - 正向：声明了的，`actionsFor` 必须有；
 * - 反向：`actionsFor` 有的（除 `evaluate`，它从不出现），MCP 必须声明。
 *
 * 造状态走真实服务（不手改 `state` 列）：手改能造出一个「状态机不允许」的行，
 * 那时这条测试会拿一个假的起点去比对，反而绿得没有意义。
 *
 * 「时钟推着走」的那三个状态各自用**不同的日期**：tick 会推所有到点的行，三条共用一套
 * 日期的话，后一次 tick 会把先造好的那两条一起推走——那样模拟出来的状态是假的。
 */

beforeEach(async () => {
  await resetDb();
  await seedPeople();
});

afterAll(async () => {
  await pool.end();
});

async function inInbox(title: string): Promise<string> {
  const created = await createRequirement(db, '吕品', { ...BRIEF, title, type: 'feature', requester: '孙建宏' });
  return created.id;
}

/** 收集 → 待设计 → 待评审（停在待评审）。 */
async function inReview(title: string): Promise<string> {
  const id = await inInbox(title);
  await evaluate(db, '吕品', { requirementId: id });
  await submitReview(db, '吕品', { requirementId: id, prdUrl: 'https://doc.example.com/prd' });
  return id;
}

/** 收集 → 待设计 → 待评审 → 待排期。 */
async function inQueue(title: string): Promise<string> {
  const id = await inReview(title);
  await reviewPass(db, '吕正豪', { requirementId: id });
  return id;
}

/** 排进某一天：windowStart 是开工日，testAt / dueAt 决定时钟什么时候推它。 */
async function scheduled(
  title: string, windowStart: string, testAt: string, dueAt: string,
): Promise<string> {
  // 每个窗口一条版本：releases 是 window_start 的唯一来源，而 tick 按它推进。
  const releaseId = await makeRelease(`R-${windowStart}-${title}`, windowStart, '2027-06-30');
  const id = await inQueue(title);
  await schedule(db, '吕品', { requirementId: id, releaseId, commitTestAt: testAt, commitDueAt: dueAt });
  return id;
}

/** 一个状态一条需求。返回「状态 → 需求 id」。 */
async function onePerState(): Promise<Map<State, string>> {
  const map = new Map<State, string>();

  map.set('inbox', await inInbox('收集'));
  const design = await inInbox('待设计');
  await evaluate(db, '吕品', { requirementId: design });
  map.set('design', design);

  // 待评审与待排期是**两条**需求：同一条一路推过去，那个状态就没有样本了。
  map.set('review', await inReview('待评审'));
  map.set('queue', await inQueue('待排期'));

  // 待排期之后那一格（`ready` = 待开发）：开工日放在 2027，于是下面那三次 tick
  // 一次都推不动它——它要停在「待开发」，不是被时钟顺手推走。
  map.set('ready', await scheduled('待开发', '2027-01-01', '2027-01-10', '2027-01-20'));

  // 下面三条各用各的日期，于是同一次 tick 只会把「该走的那一条」推一步：
  //   12-01：三条 ready → dev
  //   12-03：test 那条（提测日 12-01）dev → test；live 那条同样 dev → test
  //   12-05：live 那条（承诺日 12-02）test → live
  map.set('dev', await scheduled('开发中', '2026-12-01', '2026-12-10', '2026-12-20'));
  map.set('test', await scheduled('测试中', '2026-12-01', '2026-12-01', '2026-12-20'));
  map.set('live', await scheduled('已上线', '2026-12-01', '2026-12-01', '2026-12-02'));

  for (const day of ['2026-12-01', '2026-12-03', '2026-12-05']) {
    await tick(db, startOfShanghaiDay(day));
  }

  const rejected = await inInbox('被拒');
  await rejectRequirement(db, '吕品', { requirementId: rejected, reason: '不做' });
  map.set('rejected', rejected);

  const shelved = await inInbox('被搁置');
  await shelveRequirement(db, '吕品', { requirementId: shelved, reason: '先等等' });
  map.set('shelved', shelved);

  return map;
}

/** MCP 在某个状态下**会提供**的动作（按声明算，不读任何散文）。 */
function declaredActionsIn(state: State): DetailAction[] {
  return TOOLS
    .filter((def) => def.action !== null && LEGAL_FROM[def.action].includes(state))
    .map((def) => def.action as DetailAction);
}

describe('actionsFor 对齐（漂移探测器）', () => {
  it('十个状态：MCP 声明的动作集合 === actionsFor，双向相等', async () => {
    const ids = await onePerState();

    // 十个状态一条不少：少一个就等于少测一个方向。
    expect([...ids.keys()].sort()).toEqual([...BOARD_STATES].sort());

    for (const state of BOARD_STATES) {
      const detail = await getRequirementDetail(ids.get(state)!);
      expect(detail).not.toBeNull();
      // 需求真的停在这个状态上（而不是被后来的 tick 推走了）。
      expect(detail!.state).toBe(state);

      const fromUi = detail!.actions;
      const fromMcp = declaredActionsIn(state);
      // 排序后比较：这一条测的是「集合相等」。顺序由 `actionsFor` 的 switch 决定，
      // 而工具表的顺序是「读 → 建 → 材料 → 流程」，两者本来就不必一致。
      expect({ state, actions: [...fromMcp].sort() }).toEqual({ state, actions: [...fromUi].sort() });
    }
  });

  // 动作名 2026-11-10 从 `evaluate` 改成 `approve`：它做的是**立项**（inbox → design），
  // 与「生成评估材料」不再是同一件事（材料不改状态）。
  it('`approve`（立项）只在收集状态给出，MCP 也有对应工具', async () => {
    const ids = await onePerState();
    for (const state of BOARD_STATES) {
      const detail = await getRequirementDetail(ids.get(state)!);
      if (state === 'inbox') expect(detail!.actions).toContain('approve');
      else expect(detail!.actions).not.toContain('approve');
    }
    // 认领只给负责人、不动状态；收集状态的唯一出口就是这条边，所以 agent 也要能走。
    expect(LEGAL_FROM.approve).toEqual(['inbox']);
    expect(TOOLS.filter((def) => def.action === 'approve')).toHaveLength(1);
  });

  it('每个 DetailAction 都有恰好一个工具', () => {
    const declared = TOOLS.flatMap((def) => (def.action === null ? [] : [def.action]));
    expect(new Set(declared).size).toBe(declared.length);

    const covered = [...new Set(declared)].sort();
    // `DetailAction` 的九个成员各有一个工具——包括 `approve`（立项）。
    expect(covered).toEqual([
      'approve', 'bounce', 'reject', 'restore', 'reviewPass', 'reviewReject', 'schedule',
      'shelve', 'submitReview',
    ]);
    for (const action of covered) expect(LEGAL_FROM[action].length).toBeGreaterThan(0);
  });

  it('描述里的状态清单与声明逐字一致（防止描述与表各说各的）', () => {
    for (const def of TOOLS) {
      if (def.action === null) continue;
      // 只看「权限：」之后的尾巴：用途那句散文可以提到任何状态（「恢复…放回「收集」」），
      // 而合法状态清单在 trailer 里，由 `LEGAL_FROM` + `STATE_LABEL` 拼出来。
      const trailer = def.description.split('权限：')[1] ?? '';
      for (const state of BOARD_STATES) {
        expect({ tool: def.name, state, mentioned: trailer.includes(`「${STATE_LABEL[state]}」`) })
          .toEqual({ tool: def.name, state, mentioned: LEGAL_FROM[def.action].includes(state) });
      }
    }
  });

  it('十条需求各占看板一列（造出来的状态都是真的，没有手改出来的行）', async () => {
    await onePerState();
    const columns = await getBoard('吕品');
    expect(columns.map((column) => column.state)).toEqual([...BOARD_STATES]);
    // `getBoard` 对认不出的状态会抛错，所以这条同时证明十个状态都落在状态机里。
    expect(columns.map((column) => column.cards.length)).toEqual(Array(10).fill(1));
  });
});
