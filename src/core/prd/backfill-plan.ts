/**
 * 老系统 PRD 链接回填的**口径**（纯函数，不碰库、不碰 ssh）。
 *
 * 从 `scripts/prd-backfill.ts` 拆出来的唯一理由：口径要能被用例钉住。脚本带顶层
 * `await main()`，import 它就等于跑一遍回填；而这里只有 `buildPlan(docs, reqs)`，
 * 输入两边的行、输出「哪几条能配、哪几条不能配以及为什么」，可以拿内存里的数组直接测。
 *
 * 口径本身与迁移 `0025_prd_url_backfill.sql` 的 `where` 一一对应（写错一个条件，
 * 种子文件与库就会各说一套）：
 *
 * - 只认标题**全等**（不 trim、不归一化、不分大小写）——老系统里 `documents.title`
 *   本身就是需求标题，这是唯一存在的那条链接；
 * - 一对一才写：歧义（同题多于一条需求）**不猜**，两个候选各写一半的概率是 50%，
 *   而写错的 PRD 链接比没有链接更坏（`prd_snapshots` 与材料生成会把它当权威源）；
 * - 软删的行**不算**「同题需求」（见 `buildPlan` 里的 `live`）：软删意味着这一行
 *   从每一条读路径上消失、只为历史保留，而「同题唯一」正是一个读路径上的判断。
 */

export type FlowerDoc = { title: string; external_url: string; kind: string };

/**
 * 库里的一条需求（回填判据用得上的四列 + 软删标记）。
 *
 * `deleted_at` 是 `Date | string | null`：pg 对 `timestamptz` 给 `Date`，但凡是能被
 * JSON 化或从别处喂进来的行都想得到 `string`。判据只问「是不是 null」，两者都对。
 */
export type LocalReq = {
  number: number;
  legacy_ref: string | null;
  title: string;
  prd_url: string | null;
  deleted_at: Date | string | null;
};

export type Pair = { title: string; url: string };

export type Ambiguous = {
  title: string;
  url: string;
  candidates: { number: number; migrated: boolean; prdUrl: string | null }[];
};

export type Plan = {
  pairs: Pair[];
  ambiguous: Ambiguous[];
  /** 迁移行里没有 PRD 的原因分类（合计 = 迁移行 − pairs.length）。 */
  gaps: {
    /** 一条同名文档都没有。 */
    noDocument: number[];
    /** 有同名文档，但文档的 external_url 是空的。 */
    documentWithoutUrl: number[];
    /** 有同名文档且有 URL，但同名需求不止一条（本题的 2 条）。 */
    ambiguous: number[];
    /** 已经填过（不该出现：迁移行里 prd_url 全为 null）。 */
    alreadyFilled: number[];
  };
  counts: { total: number; migrated: number; demo: number; docs: number; docsWithUrl: number };
};

/** 标题全等比较用的键：就是标题本身（刻意不做 trim / 归一化）。 */
const key = (title: string): string => title;

export function buildPlan(docs: FlowerDoc[], reqs: LocalReq[]): Plan {
  /**
   * **软删的行不算「同题需求」。** 判据只有一条：`deleted_at is null`。
   *
   * 为什么必须在这里过滤：`--emit` 重新生成种子时，「同题唯一」这个判断是拿需求行
   * 数出来的。把已软删的行数进去，`用户部分权益缩减调整`（PAN-338 已删、PAN-742 保留）
   * 就仍然是「2 条同题」→ 判成歧义 → 从种子里掉出去；而迁移 0026 刚刚按裁定把它填进了
   * 库里。于是同一个标题，库说「填好了」，种子说「有歧义不敢填」——一份数据两个答案。
   *
   * 过滤**只在这里做一次**（不在 `loadRequirements` 的 SQL 里再做一遍）：`pairs` 与
   * `counts` 必须是同一份事实，分两处过滤迟早会分叉。软删的行仍然被读出来（`deleted_at`
   * 跟着行一起上送）：分类缺口时它还是一条真实存在的历史行，需要知道它为什么不算。
   */
  const live = reqs.filter((r) => r.deleted_at === null);

  const withUrl = docs.filter((d) => d.external_url.trim() !== '');
  const withoutUrl = docs.filter((d) => d.external_url.trim() === '');

  // 同一标题在文档侧是否只有一条（217 行里没有重名，但这里有判据，让报告说得出来）。
  const urlDocTitles = new Map<string, FlowerDoc>();
  for (const d of withUrl) urlDocTitles.set(key(d.title), d);
  const emptyDocTitles = new Set(withoutUrl.map((d) => key(d.title)));

  const byTitle = new Map<string, LocalReq[]>();
  for (const r of live) {
    const k = key(r.title);
    const bucket = byTitle.get(k);
    if (bucket === undefined) byTitle.set(k, [r]);
    else bucket.push(r);
  }

  const pairs: Pair[] = [];
  const ambiguous: Ambiguous[] = [];
  const gaps: Plan['gaps'] = {
    noDocument: [], documentWithoutUrl: [], ambiguous: [], alreadyFilled: [],
  };

  // 文档侧驱动：只有「有 URL 的文档」能提供一条链接。
  for (const [title, doc] of urlDocTitles) {
    const matches = byTitle.get(title) ?? [];
    if (matches.length === 0) continue; // 与需求无关的文档（217 里的一条使用手册等）
    if (matches.length > 1) {
      // 歧义只在「这些候选里至少有迁移行、且都还没填」时才有意义。
      const open = matches.filter((r) => r.legacy_ref !== null && r.prd_url === null);
      if (open.length === 0) continue;
      ambiguous.push({
        title,
        url: doc.external_url,
        candidates: matches.map((r) => ({
          number: r.number, migrated: r.legacy_ref !== null, prdUrl: r.prd_url,
        })),
      });
      continue;
    }
    const only = matches[0]!;
    if (only.legacy_ref === null) continue; // 演示行不填（0025 的 legacy_ref 判据）
    if (only.prd_url !== null) continue;
    pairs.push({ title, url: doc.external_url });
  }

  // 缺口分类：迁移行里没被配上的那些。
  const paired = new Set(pairs.map((p) => key(p.title)));
  const ambiguousTitles = new Set(ambiguous.map((a) => key(a.title)));
  for (const r of live) {
    if (r.legacy_ref === null) continue;
    if (r.prd_url !== null) { gaps.alreadyFilled.push(r.number); continue; }
    const k = key(r.title);
    if (paired.has(k)) continue;
    if (ambiguousTitles.has(k)) gaps.ambiguous.push(r.number);
    else if (emptyDocTitles.has(k)) gaps.documentWithoutUrl.push(r.number);
    else gaps.noDocument.push(r.number);
  }

  // 排序用码点比较（不用 localeCompare）：同一个仓库在任何机器上 emit 出的字节一致。
  pairs.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  ambiguous.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));

  return {
    pairs,
    ambiguous,
    gaps,
    counts: {
      total: live.length,
      migrated: live.filter((r) => r.legacy_ref !== null).length,
      demo: live.filter((r) => r.legacy_ref === null).length,
      docs: docs.length,
      docsWithUrl: withUrl.length,
    },
  };
}
