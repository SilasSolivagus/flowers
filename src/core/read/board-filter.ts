/**
 * 看板筛选：`?q=<标题关键词>&owner=<all|me|none|<memberId>>`。
 *
 * 这一层只做**纯解析**：把 URL 上的两个字符串变成一份 `BoardFilter`，或者把
 * `BoardFilter` 变回 URL 上的查询串。它不连库、不认识 SQL——真正的过滤条件写在
 * `board.ts` 那条大 SQL 的 where 里（见那里的 `boardWhere`）。
 *
 * 为什么解析要单独一个文件：它有两类错误必须被用例单独钉住，而两类都不想连库——
 *
 * 1. **手改的 URL 不许 500**。`?owner=` 后面可以是任何东西（uuid、空格、`%FF`、
 *    `__proto__`）。解析器对认不出的一律退回 `all`，绝不把它交给 `::uuid` 去炸
 *    Postgres——一个能被手改的查询参数不该有让整页 500 的力量。
 * 2. **缺席与空串是同一件事**。`?q=`、`?q=%20%20` 与根本不给 `q` 都是「没筛」，
 *    因为它们全都等于「用户什么都没说」。让它们产生三种不同的看板形状（比如
 *    「筛出 0 / 815」）是把输入的空洞当成一个真值。
 *
 * 筛选的**语义**只有两条，且都是刻意收窄的：
 *
 * - `q` 只搜**需求标题**（子串、大小写不敏感）。不搜编号、不搜六问正文：
 *   找一条需求时人记得的是名字；全文搜索会把「正文提到过某个词」误当成「这件事」，
 *   而一条需求正文里几乎必然会提到别的需求的战场词（分享、限速、退款……）。
 *   编号同理是**刻意不做**的（owner 的裁决）：`q=PAN-742` 返回 0 条不是漏了，
 *   想按编号找用浏览器自带查找、或直接翻那一列——把它做成标题搜索之外的第二个
 *   匹配面，会让「搜 742」既可能命中编号 742 也可能命中标题里的 742，
 *   于是「搜到了什么」取决于数据长什么样。
 * - `owner` 是**单选**：`all` / `me` / `none` / 一个成员 id。多选（同时看两个人）
 *   不在这一轮的范围里——它需要一个新的 URL 语法（重复参数或逗号分隔）与一套
 *   新的交互（多选框而不是下拉），而这一轮要解决的是「815 条看不清」。
 */

/** `owner` 的四态。`member` 只装一个 id——多选的语法刻意没有。 */
export type BoardOwner =
  | { kind: 'all' }
  | { kind: 'me' }
  | { kind: 'none' }
  | { kind: 'member'; id: string };

/**
 * 看板的时间范围（2026-11-10）。
 *
 * `active`（默认）与 `all` 的差别只有一条：**已上线且停在那个状态超过 90 天的需求
 * 默认不显示**。库里有 265 条「已上线」，其中 207 条是迁移来的历史，全摊在板子上
 * 等于每天先翻 200 张早就不看的卡。`all` 是那条逃生门，不是另一个视图——
 * 十列、筛选、计数全都一样，只是多带一群老卡。
 *
 * 判据用 `state_entered_at`（进「已上线」那天）而不是 `created_at`：一条三月的需求
 * 上周上线，它是新的；一条上周建的需求三年前就上线了（迁移数据里就有），它是旧的。
 */
export type BoardScope = 'active' | 'all';

export type BoardFilter = { q: string; owner: BoardOwner; scope: BoardScope };

/** 什么都不筛。`?` 一个参数都不给时就是它，所以「没筛」只有一个表示。 */
export const NO_FILTER: BoardFilter = { q: '', owner: { kind: 'all' }, scope: 'active' };

/**
 * `owner` 的「具体成员」只认 UUID 形状。
 *
 * 不在这里查库确认这个人存在：那要把解析变成一次异步查询，而一个**合法的 id 但
 * 名册里没有这个人**本来就该得到一个诚实的空看板（这个人名下确实没有需求），
 * 不是一个偷偷换成 `all` 的看板——那会让人以为自己筛过了，看到的却是全体。
 * 反过来，一个**不是 UUID 的垃圾值**（手改 URL、复制粘贴坏一半）没有这个尊严：
 * 它连「一个成员」都不是，只能退回 `all`。
 */
const MEMBER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Next 的 searchParams 形状：同名参数出现两次时是数组，所以两个都要接。 */
export type RawParams = Record<string, string | string[] | undefined>;

/** 只取第一个值：`?q=a&q=b` 是两个互相矛盾的指令，取先到的那个，不拼起来。 */
function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/**
 * `q` 的长度上限。
 *
 * 不是安全机制（值走参数绑定，长度不改变语义），而是一个**手滑**兜底：把一个
 * 几 KB 的粘贴内容当成搜索词，ILIKE 会照样跑，然后筛出 0 条，用户以为看板坏了。
 * 上限取 200 字：中文字段的标题远到不了这个长度。
 */
export const MAX_Q = 200;

/** URL → 筛选。认不出的一律退回「不筛」，永远返回一个可用值。 */
export function parseBoardFilter(params: RawParams): BoardFilter {
  const q = first(params.q).trim().slice(0, MAX_Q);
  const ownerRaw = first(params.owner).trim();
  // 只有 `all` 是「含历史」，其余（空串、`active`、任何垃圾值）都落回默认的 active：
  // 一个手改坏了的 URL 不该意外地把 200 张历史卡放出来。
  const scope: BoardScope = first(params.scope).trim() === 'all' ? 'all' : 'active';

  const owner: BoardOwner = ownerRaw === 'me'
    ? { kind: 'me' }
    : ownerRaw === 'none'
      ? { kind: 'none' }
      : MEMBER_ID.test(ownerRaw)
        ? { kind: 'member', id: ownerRaw }
        // `all`、空串、以及任何认不出的值（`ME`、`null`、`42`、`%E4%B8`）都在这里落地。
        : { kind: 'all' };

  return { q, owner, scope };
}

/** 这条筛选是不是什么都不做（决定「清空」出不出现、工具条高不高亮）。 */
export function isFiltered(filter: BoardFilter): boolean {
  return filter.q !== '' || filter.owner.kind !== 'all';
}

/** 时间范围算不算「被改过」：决定「含历史」那个开关要不要高亮。 */
export function isWideScope(filter: BoardFilter): boolean {
  return filter.scope === 'all';
}

/** `owner` 在 URL 上的写法（下拉的选中值也用它，所以只有一份）。 */
export function ownerParam(owner: BoardOwner): string {
  switch (owner.kind) {
    case 'me':
    case 'none':
      return owner.kind;
    case 'member':
      return owner.id;
    case 'all':
      return 'all';
  }
}

/**
 * 筛选 → URL 查询串（**不带前导 `?`**，空串表示「什么都不用带」）。
 *
 * 空 `q` 与 `owner=all` 都不写进 URL：默认状态就该是一条干净的 `/`，
 * 而不是 `/?q=&owner=all` —— 后者会让人以为这是一条「筛选过的看板」的链接，
 * 分享出去之后对方看到的是同一块板子，只是 URL 更脏。
 *
 * 用途有两处，必须是同一份：工具条自己重新提交时的地址，以及卡片/抽屉的
 * `?open=` 后面要跟的那串（打开了抽屉再关掉，筛选不能丢——否则「筛出 12 条、
 * 点开一条、关掉」会掉回 815 条，那正是这次要消灭的状态）。
 */
export function boardQuery(filter: BoardFilter): string {
  const parts: string[] = [];
  if (filter.q !== '') parts.push(`q=${encodeURIComponent(filter.q)}`);
  if (filter.owner.kind !== 'all') parts.push(`owner=${ownerParam(filter.owner)}`);
  // `scope=active` 是默认值，不写进 URL（与空 q、owner=all 同一条规矩）。
  if (filter.scope === 'all') parts.push('scope=all');
  return parts.join('&');
}
