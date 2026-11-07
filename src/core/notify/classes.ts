/**
 * 事件的三类（P4-07）。
 *
 * 三个类不是「重要性」的排序，而是**三种打断人的理由**：
 *
 * | 类 | 意思 | 谁会觉得这条该响 |
 * |---|---|---|
 * | `action` | 需要我动手：等我签字、等我出 PRD、我负责的需求进入新状态 | 当事人 |
 * | `outcome` | 有结果：通过 / 打回 / 拒绝 / 搁置 / 自动上线 / 打回开发 | 关心这条需求的人 |
 * | `change` | 一般变动：新建、换负责人、描述更新、认领、补材料、发版 | 只需要知道，不需要现在做事 |
 *
 * 「进入新状态」这一类放在 `action` 而不是 `change`：状态往前走了，负责人接下来
 * 一定有活（待设计要出 PRD、待评审要签字、待开发要盯开工、开发中要提测、测试中要
 * 跟进度）。把它放进 `change` 会让「只关键」这一档在一条需求的生命周期里几乎一声
 * 不响——那正是这一轮要修的那个「48 条 vs 1 条」的另一个极端。
 *
 * ── 这张表是**穷举**的，而且是这一层的唯一口径
 *
 * 事件类型只从 `src/core/**` 的 `recordEvent` 调用点产生（见 tests/notify-channels.test.ts：
 * 它扫源码，把 recordEvent 里每一个 `type` 的字符串字面量、以及时钟
 * 由 `TRANSITIONS` 派生出来的 `requirement.auto_<state>` 全部收集起来，逐个断言
 * 在这张表里**有且只有一个**类）。所以「新加一个事件类型却忘了分类」= 用例变红，
 * 而不是它悄悄只出现在 `all` 档里。
 *
 * 未登记的类型在运行期按 `change` 兜底（见 `classOf`）：库里可能有更早版本写下的
 * 类型，而一条读不懂的事件不该让铃铛 500。兜底**只**影响读，不改变「表必须穷举」
 * 这条测试约束。
 */

import { sql, type SQL } from 'drizzle-orm';

export const CLASSES = ['action', 'outcome', 'change'] as const;
export type EventClass = (typeof CLASSES)[number];

/** 三个类的中文名（报告、企微消息里用）。 */
export const CLASS_LABEL: Record<EventClass, string> = {
  action: '要你做',
  outcome: '有结果',
  change: '有变动',
};

/**
 * 事件类型 → 类。**每个真实事件类型都在这张表里出现一次。**
 *
 * 顺序不是排版：按 `action` / `outcome` / `change` 三段写，读的人一眼能看出
 * 「哪一类事件在打断我」。
 */
export const EVENT_CLASS: Readonly<Record<string, EventClass>> = {
  // ── action：需要我动手 ───────────────────────────────────────────────────
  /** 进入待设计：负责人要出正式 PRD。 */
  'requirement.evaluated': 'action',
  /** 进入待评审：派单的评审人要签字。 */
  'requirement.review_requested': 'action',
  /** 进入待开发：排期定了，负责人要盯开工。 */
  'requirement.scheduled': 'action',
  /** 进入开发中（时钟）。 */
  'requirement.auto_dev': 'action',
  /** 进入测试中（时钟）：负责人跟测试进度。 */
  'requirement.auto_test': 'action',
  /**
   * 成员级提醒（P2「企微绑定自愈」）：这个人的企微绑定坏了，超管要去点一次「查一下」。
   *
   * 为什么是 `action` 而不是 `change`：它**现在**就要一个人动手，而且这个动作有时效
   * ——不点，那个人会一直收不到通知（这正是这一项要修的那类静默失败）。归到 `change`
   * 会让默认档 `key` 的超管在铃铛里看不到它（`key` = 动手 + 结果），等于白报。
   */
  'member.wecom_unlinked': 'action',

  /**
   * 时钟跳过坏行（2026-11-08 裁定「一条坏数据不许停掉全场」）：这一轮有 N 条需求
   * 的日期 / 版本坏了、钟推不动，超管要去把数据补上。
   *
   * 为什么是 `action` 而不是 `change`：跳过期间的后果是**这些需求永远不会自己往前走**
   * ——超时提醒不响、推送不发，而且看板上它只是「没到点」。归到 `change` 会让默认档
   * `key` 的超管在铃铛里看不到它（`key` = 动手 + 结果），等于白报。
   */
  'clock.tick_skipped': 'action',

  // ── outcome：有结果 ─────────────────────────────────────────────────────
  'requirement.review_passed': 'outcome',   // 评审通过
  'requirement.review_rejected': 'outcome', // 评审打回
  'requirement.rejected': 'outcome',        // 被拒绝
  'requirement.shelved': 'outcome',         // 被搁置
  'requirement.bounced': 'outcome',         // 打回开发
  'requirement.auto_live': 'outcome',       // 自动上线

  // ── change：一般变动 ────────────────────────────────────────────────────
  'requirement.created': 'change',          // 新建（进入收集）
  'requirement.owner_assigned': 'change',   // 换负责人 / 认领
  'requirement.updated': 'change',          // 描述更新
  'requirement.deleted': 'change',          // 删除
  'requirement.restored': 'change',         // 恢复
  /**
   * 从 Flower 迁入（P4-09）。归 `change`：这是一条历史记录，不是「现在需要谁动手」；
   * 放在 `action` 会让迁移一落地就给所有人推 803 条通知。
   */
  'requirement.migrated': 'change',
  'uemaster.attached': 'change',            // 交了材料
  'prd.fetched': 'change',                  // 拉了 PRD 快照
  'release.created': 'change',              // 发版窗口新建
  'release.updated': 'change',              // 发版窗口改了
  'release.deleted': 'change',              // 发版窗口删了
};

/** 表里登记的全部类型（用例拿它和自己的扫描结果比）。 */
export function knownTypes(): string[] {
  return Object.keys(EVENT_CLASS);
}

/**
 * 事件类型 → 类。未登记 → `change`（见文件头）。
 *
 * 显式白名单而不是裸查表：`'toString'` / `'constructor'` 这类原型键不该被当成
 * 一个类返回（review.ts 的 `assignReviewer` 上踩过同一颗雷）。
 */
export function classOf(type: string): EventClass {
  return Object.hasOwn(EVENT_CLASS, type) ? (EVENT_CLASS[type] ?? 'change') : 'change';
}

/**
 * 这一档收不收这一类。**三档 × 三类 = 九格全部写死在这里**。
 *
 * 它是 `classesOfLevel` 的逐格版本：列表用于拼 SQL，这一条用于判单个事件（用例的
 * 九格矩阵、以及「这条事件要不要推送」这种单点问题）。两者必须给同一个答案——
 * 用例里那张矩阵就是钉这件事的。
 */
export function allows(level: 'all' | 'key' | 'off', cls: EventClass): boolean {
  if (level === 'off') return false;
  if (level === 'all') return true;
  return cls !== 'change';
}

/** 这一档收哪几类。`key` = 动手 + 结果，`all` = 三类，`off` = 都不收。 */
export function classesOfLevel(level: 'all' | 'key' | 'off'): EventClass[] {
  if (level === 'off') return [];
  if (level === 'all') return [...CLASSES];
  return ['action', 'outcome'];
}

/**
 * 某一档该放行的事件类型。`null` = 不加条件（`all`）。
 *
 * 读侧（站内铃铛）与发送侧（企微推送）**共用它**：两处各写一份 `type in (…)`，
 * 迟早出现「铃铛里有、企微没发」或者反过来——而这一轮的全部意义就是两个频道
 * 说的是同一句话。
 */
export function typesOfLevel(level: 'all' | 'key' | 'off'): string[] | null {
  const classes = classesOfLevel(level);
  if (classes.length === CLASSES.length) return null;
  return knownTypes().filter((type) => classes.includes(classOf(type)));
}

/**
 * 某一档的事件类型条件，拼进 `where`。**永远是一段完整的布尔表达式**。
 *
 * 三种取值，一个都不能省：
 * - `all` → `true`（不是空片段！空片段拼进 `(… and )` 就是一条语法错误的 SQL，
 *   而 `true` 让「不加过滤」也是一句能读的话）；
 * - `off` → `false`（不是空片段：关掉的口味必须让 feed 真的空，把「关」拼成
 *   「不加条件」会把它读成「全开」，是最难发现的一类反向 bug）；
 * - `key` → `e.type in (…)`。
 */
export function levelFilter(level: 'all' | 'key' | 'off'): SQL {
  const types = typesOfLevel(level);
  if (types === null) return sql`true`;
  if (types.length === 0) return sql`false`;
  return sql`e.type in (${sql.join(types.map((type) => sql`${type}`), sql`, `)})`;
}
