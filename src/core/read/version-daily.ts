import type { TextNoticeCard } from '../notify/group.js';
import { GROUP_PRODUCT_NAME } from '../notify/group.js';
import type { Release } from './version.js';

/**
 * 版本每日进展（2026-11-10）：一天一条，发到团队群，**版式照 Flower 的「概览卡片」**。
 *
 * Flower 的研发日报是一张 `template_card`（text_notice）：主标题是「产品名 研发日报 ·
 * MM-DD」，辅助信息是「迭代名 · MM/DD 发版 · 还剩 N 个工作日」，关键数据是整体进度，
 * 横排三项统计，引用区列「需要关注」，底部两个跳转按钮。这里逐字段对齐它——owner 的
 * 要求是「跟群里原来那张一模一样」，不是「差不多」。
 *
 * 数据仍然只来自 `listReleases()`（甘特用的同一个读模型），不再写第二条 SQL：日报说
 * 「需求 17 项、已上线 5」，而甘特画的是另一套数，是最容易发生也最难发现的错误。
 *
 * 这一层是**纯函数**：给一批 Release + 今天，返回卡片数组。发不发、发过没有，在
 * `scripts/group-dispatch.ts` 与台账里。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' 或带时间的字符串 → 上海日历日的整数天。解析不出来返回 null。 */
function dayOf(raw: string | null): number | null {
  if (raw === null) return null;
  const text = raw.length > 10 ? raw.slice(0, 10) : raw;
  // 上海零点 → UTC 前一天 16:00；加回 8 小时才是那一天的「天序号」，与
  // `todayInShanghai()` 同一个基准（否则 00:00 附近的判断会差一天）。
  const at = Date.parse(`${text}T00:00:00+08:00`);
  return Number.isFinite(at) ? Math.floor((at + 8 * 60 * 60 * 1000) / DAY_MS) : null;
}

/** 今天（上海）。与看板同一个换算，只是这里要整数天而不是 'MM-DD'。 */
export function todayInShanghai(now: Date = new Date()): number {
  return Math.floor((now.getTime() + 8 * 60 * 60 * 1000) / DAY_MS);
}

function dateText(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** `MM/DD`（Flower 的卡片里发版日就是这个形状）。 */
function monthDay(releaseDate: string): string {
  const day = releaseDate.slice(0, 10);
  return `${day.slice(5, 7)}/${day.slice(8, 10)}`;
}

/**
 * 工作日数（含结束日，不含今天）：周一到周五。
 *
 * Flower 那句「还剩 N 个工作日」是这么算的（`workdaysElapsed`）。这里不复刻节假日表
 * ——那份表在 Flower 也没有（它同样只排除周末）。
 */
export function workdaysBetween(today: number, releaseDay: number): number {
  if (releaseDay <= today) return 0;
  let count = 0;
  for (let day = today + 1; day <= releaseDay; day += 1) {
    const weekday = new Date(day * DAY_MS).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

/** 「MM/DD 发版 · 还剩 N 个工作日」/「今天发版」/「已过发版日」——与 Flower 同一句。 */
export function releaseText(releaseDate: string, today: number): string {
  const day = dayOf(releaseDate);
  if (day === null) return '发版日未定';
  if (day === today) return '今天发版';
  if (day < today) return '已过发版日';
  return `${monthDay(releaseDate)} 发版 · 还剩 ${workdaysBetween(today, day)} 个工作日`;
}

/**
 * 哪些版本值得每天播报：**发版日在过去 7 天到未来 45 天之间**的。
 * 往前 7 天：刚发完的那版还会被问「上了几条」；往后 45 天：再远的每天提等于噪音。
 */
export function activeReleases(releases: readonly Release[], today: number): Release[] {
  return releases.filter((release) => {
    const at = dayOf(release.releaseDate);
    return at !== null && at >= today - 7 && at <= today + 45;
  });
}

/** 今日到点：承诺完成日就是今天、且还没上线的那几条。 */
export function dueToday(release: Release, today: number): number[] {
  return release.requirements
    .filter((item) => item.state !== 'live' && dayOf(item.commitDueAt) === today)
    .map((item) => item.number);
}

/** 卡片里每一行建议不超过 40 字（企微 quote_area 的建议长度）。 */
function clip(text: string, max = 40): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/** 整体进度：已上线 / 全部。没有需求时 0。 */
function overallPercent(release: Release): number {
  const total = release.requirements.length;
  if (total === 0) return 0;
  return Math.round((release.shipped / total) * 100);
}

export type VersionDailyCard = { releaseId: string; releaseName: string; card: TextNoticeCard };

/**
 * 一个版本 → 一张卡片。逐字段对齐 Flower：
 * 标题带 MM-DD、辅助信息带发版日与剩余工作日、关键数据是进度、横排三项统计、
 * 引用区「需要关注」、两个跳转。
 */
export function versionCard(release: Release, today: number, baseUrl: string): VersionDailyCard {
  const late = release.requirements.filter((item) => item.late);
  const due = dueToday(release, today);
  const overall = overallPercent(release);
  const expected = release.timeUsed ?? 0;

  const attention: string[] = [];
  for (const item of late.slice(0, 2)) {
    attention.push(clip(`延期 PAN-${item.number} ${item.title} · 承诺 ${item.dueAtLabel ?? '未填'}`));
  }
  if (due.length > 0) {
    attention.push(clip(`今日到点 ${due.slice(0, 3).map((n) => `PAN-${n}`).join('、')}`));
  }

  const jumps = [
    { title: '查看甘特', url: `${baseUrl}/releases` },
    { title: '需求列表', url: `${baseUrl}/` },
  ];

  return {
    releaseId: release.id,
    releaseName: release.name,
    card: {
      title: clip(`${GROUP_PRODUCT_NAME} 研发日报 · ${dateText(today).slice(5)}`, 26),
      // 文案与 Flower 逐字相同；**不照抄它的截断**——它按「迭代名 ≤ 30 - 发版句」算，
      // 6 个字符的余量会把「2026.11」砍成「2026.1」。企微那条 30 字是建议值，不是硬限，
      // 少一个字比砍掉版本号好认。
      desc: `${release.name} · ${releaseText(release.releaseDate, today)}`,
      source: { desc: 'Flower · 研发日报', desc_color: late.length > 0 ? 2 : 3 },
      emphasis: {
        title: `${overall}%`,
        desc: clip(`整体进度（理论 ${Math.round(expected)}%）`, 15),
      },
      stats: [
        { keyname: '需求', value: `${release.requirements.length} 项` },
        { keyname: '已上线', value: `${release.shipped} 项` },
        { keyname: '遗留下期', value: `${late.length} 项` },
      ],
      quote: attention.length > 0 ? { title: '需要关注', quote_text: attention.join('\n') } : null,
      jumps,
      action: { url: `${baseUrl}/releases` },
    },
  };
}

/** 所有在播版本 → 每版一张卡片。没有可播的版本时返回空数组（调用方不发空卡）。 */
export function versionCards(
  releases: readonly Release[], today: number, baseUrl: string,
): VersionDailyCard[] {
  return activeReleases(releases, today).map((release) => versionCard(release, today, baseUrl));
}
