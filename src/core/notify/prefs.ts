/**
 * 通知口味：**两个频道 × 三档**（P4-07）。
 *
 * ```
 * {"site":"key","wecom":"key"}
 * ```
 *
 * - 频道：`site` = 站内铃铛，`wecom` = 企微推送。两者各存各的：一个人可以只看铃铛
 *   不被打扰，也可以只在工位上收推送。
 * - 三档：`all`（三类都要）/ `key`（只要「需要我动手」与「有结果」）/ `off`（关）。
 *
 * 为什么不是每类一个布尔：这一轮要回答的问题只有「要不要被打断」和「在哪被打断」。
 * 三档是这两件事的最小形状——`off` 必须是一个独立的值，而不是「三个都 false」，
 * 否则「关掉」在 JSON 里是一串需要逐字段判断的默认值（P4-03 就是那样，`inherit`
 * 与 `changed` 之间的组合让读侧长出两条分支）。
 *
 * ── 读侧的三条硬规矩
 *
 * 1. **认不出的值回落 `key`，不抛**。库里的文本可能是老形状（P4-03 的
 *    `{"inherit":…,"changed":…,"rejected":…}`），可能是手改的、可能是未来的。
 *    一条读不懂的设置不该让通知**静默消失**，也不该让整页 500：回落到默认档，
 *    用户下一次保存时被纠正。
 * 2. **默认是 `key`，不是 `all`**。超管默认收全部变更时一天 48 条（owner 的原话
 *    「我快被淹了」）。`key` 的首屏是「要我动手的」和「有结果的」，其余的仍然在
 *    铃铛里（切到 `all` 就能看），只是不主动打断。
 * 3. **写入端才校验**（`src/core/members/manage.ts` 的 `saveNotifyChannels`）。
 *    读侧永远为坏数据留一条活路。
 *
 * 老形状的迁移规则只有一条，写在这里免得下一个人再造一个版本：`changed` 与
 * `rejected` **全是 false**（= 当年真的关了）→ 两个频道都 `off`；其余任何老形状
 * → 默认 `key`。当年「只收拒绝搁置」那一档在新模型里没有对应物（`rejected` 属于
 * `outcome`，而 `key` 已经把 outcome 全收了），于是它落回 `key`——多收一点，
 * 不会漏。
 */

export const LEVELS = ['all', 'key', 'off'] as const;
export type Level = (typeof LEVELS)[number];

export const CHANNELS = ['site', 'wecom'] as const;
export type Channel = (typeof CHANNELS)[number];

export type NotifyPrefs = Record<Channel, Level>;

/** 默认档：只看关键的。三个角色（超管 / 条线负责人 / PM）都是它。 */
export const DEFAULT_LEVEL: Level = 'key';

export const DEFAULT_PREFS: NotifyPrefs = { site: DEFAULT_LEVEL, wecom: DEFAULT_LEVEL };

/** 频道的中文名（设置页两个行标签用它，报告里也用它——一处措辞）。 */
export const CHANNEL_LABEL: Record<Channel, string> = {
  site: '站内',
  wecom: '企微',
};

/** 档位的中文名。短标签，界面上是三格分段控件，没有第二行解释。 */
export const LEVEL_LABEL: Record<Level, string> = {
  all: '全部',
  key: '只关键',
  off: '关',
};

export function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value);
}

/**
 * 任意值 → 档案位。认不出就是 `key`（见文件头第 1 条）。
 *
 * `Object.hasOwn` 不是必需的（`LEVELS.includes` 已经挡掉了原型链），但这里用的是
 * 一个显式白名单：`'toString'` 这类脏值不会通过 `includes`，而未来的档位名也不会
 * 被一个宽松的查表蒙对。
 */
export function levelOf(value: unknown): Level {
  return isLevel(value) ? value : DEFAULT_LEVEL;
}

/** 老形状（P4-03）是否表达「当年真的关了」。 */
function legacyOff(record: Record<string, unknown>): boolean {
  return record.inherit === false && record.changed === false && record.rejected === false;
}

/**
 * JSON 文本 → 口味。`null` / 空串 / 坏 JSON / 不是对象 → 默认档。
 *
 * 不抛（见文件头第 1 条）。缺一个频道也按默认补——半份设置比没有更常见
 * （手改、未来加频道、迁移写了一半）。
 */
export function prefsOf(raw: string | null | undefined): NotifyPrefs {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_PREFS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFS;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return DEFAULT_PREFS;

  const record = parsed as Record<string, unknown>;
  // 老形状没有频道键；只有「当年全关」才是确定的 off，其余一律按默认档。
  const legacy = !('site' in record) && !('wecom' in record);
  if (legacy) {
    const off = legacyOff(record);
    return { site: off ? 'off' : DEFAULT_LEVEL, wecom: off ? 'off' : DEFAULT_LEVEL };
  }
  return { site: levelOf(record.site), wecom: levelOf(record.wecom) };
}

/** 写回库里的形状。字段顺序固定，报告与用例里可以直接比字符串。 */
export function prefsJson(prefs: NotifyPrefs): string {
  return JSON.stringify({ site: prefs.site, wecom: prefs.wecom });
}

/** 只改一个频道（设置页的分段控件一次只动一格）。 */
export function withLevel(prefs: NotifyPrefs, channel: Channel, level: Level): NotifyPrefs {
  return { ...prefs, [channel]: level };
}
