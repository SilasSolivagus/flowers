import { AppError } from '../errors.js';

/**
 * 角色、条线、`can()` —— 全部权限规则的**唯一**来源（P4-04，P4-06 换锚点）。
 *
 * 为什么集中在这一个文件：权限是这个系统里最容易长出第二份的地方。界面要它（按钮显示
 * 不显示）、服务层要它（能不能改）、MCP 要它（token 换来的这个人能不能动）、通知要它
 * （谁收到哪一条）。四份各写一遍，分叉的时候**没有人会看到**——最坏的一类分叉是
 * 「按钮不见了但接口还通」：界面上看不见，抽屉一提交就成功。所以：
 *
 * - 角色取值、条线取值、`条线 → 负责人角色` 的映射，只在这里；
 * - 一切「谁能做什么」的判断题都必须经过 `can()`；
 * - 服务层只调用它，不复制它的分支（`src/core/requirements/*.ts` 一律 `assertCan`）。
 *
 * ── 锚点是「负责人的归属」，不是「需求的类型」（P4-06）
 *
 * P4-04 的模型是 `需求类型 → 条线负责人角色`：功能类归功能线负责人、商业类归商业线
 * 负责人。owner 的原话是「还是别按需求类型来了，按人的归属吧，就是组织结构的关系，
 * 这个相对更固定一些」——于是 `type → role` 那张表被**删除**（不是留着不用：留着就是
 * 一个随时会被下一个人查到的陷阱），锚点换成 `负责人所在条线`：
 *
 * | 谁 | 能做什么 |
 * |---|---|
 * | 超管（`product_owner`） | 一切。改任何需求、转交任何负责人、评审任何一条、收到全部通知 |
 * | 负责人所在条线的负责人 | 改**这位负责人名下**的任何需求、在本线内转交负责人、评审这些需求、收这些需求的全部通知 |
 * | PM | 改**自己负责**的需求；评审动作对他**不存在**（不是「存在但报错」）；对没有负责人的需求可以**认领** |
 *
 * 四条随之而来的结论（每一条都在 `can()` 里有一行）：
 *
 * 1. **负责人没有条线**（今天只有超管是这种人：`members.line is null`）：没有条线可以
 *    锚定，于是**只有超管**能改 / 能签。`ownerLine === null` 这一格不是「谁都可以」，
 *    也不是「谁都不行」——是「回到超管」。
 * 2. **没有负责人**（收集 / 待接单）：没有条线可锚，于是 `edit` / `review` /
 *    `reassignOwner` 对任何人都关着（超管除外），另开一格 `claim`：
 *    **任何 PM、任何条线负责人、超管都可以认领**，认领后负责人变成认领人，
 *    这条需求随即落到认领人的条线下（`claimRequirement` 服务）。
 * 3. 需求的 `type` 仍然是内容属性（列表、筛选、文案都在用），**但不再是权限锚点**：
 *    一条商业类需求由功能线 PM 负责时，改它、签它的是功能线负责人。
 * 4. 「条线负责人」= `role` 与 `line` 同时成立（`role = feature_reviewer` **且**
 *    `line = feature`）。两列都从这一行读，任一为空都不算负责人——这个名字不给
 *    「role 写了但 line 没写」的人。
 */

export const ROLES = ['product_owner', 'feature_reviewer', 'commercial_reviewer', 'pm'] as const;
export type Role = (typeof ROLES)[number];

export const LINES = ['feature', 'commercial'] as const;
export type Line = (typeof LINES)[number];

/** 条线 → 那条线的负责人角色。**唯一**一份（review.ts 的派单也从这里取）。 */
export const ROLE_OF_LINE: Record<Line, Role> = {
  feature: 'feature_reviewer',
  commercial: 'commercial_reviewer',
};

/** 中文名。界面、错误消息、报告里的叫法都从这里来，避免「产品经理 / PM」两个人。 */
export const ROLE_LABEL: Record<Role, string> = {
  product_owner: '超管',
  feature_reviewer: '功能线负责人',
  commercial_reviewer: '商业线负责人',
  pm: 'PM',
};

/** 条线的中文名（权限消息里要用；界面另有一份视图侧映射，见 app/settings/roles.ts）。 */
export const LINE_LABEL: Record<Line, string> = {
  feature: '功能线',
  commercial: '商业线',
};

/** 条线 → 中文名；认不出的条线返回 null（视图自己决定怎么兜底）。 */
export function lineLabelOf(line: string | null | undefined): string | null {
  return typeof line === 'string' && Object.hasOwn(LINE_LABEL, line)
    ? (LINE_LABEL[line as Line] ?? null)
    : null;
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isLine(value: unknown): value is Line {
  return typeof value === 'string' && (LINES as readonly string[]).includes(value);
}

/**
 * 条线 → 它的负责人角色；认不出的条线（null、空串、库里的脏值）返回 null。
 *
 * `Object.hasOwn` 而不是裸查表：line 来自数据库的 text 列，`'toString'` /
 * `'constructor'` 会命中原型上的函数并当成角色用——review.ts 的 assignReviewer
 * 上踩过同一颗雷。
 */
export function leadRoleOf(line: string | null | undefined): Role | null {
  return typeof line === 'string' && Object.hasOwn(ROLE_OF_LINE, line)
    ? (ROLE_OF_LINE[line as Line] ?? null)
    : null;
}

/**
 * 名册上的一行。`deactivatedAt` 非空 = 已停用（登录被拒、不再收通知、不进下拉）。
 *
 * `line` 与 `deactivatedAt` 标成可选：读模型总是给全，但**权限结论不该依赖调用方
 * 是否多填了两个字段**。`can()` 只在 `deactivatedAt` 有值时才据此拒绝（`!= null`
 * 同时覆盖 null 与 undefined），所以一个只有 `{id, name, role}` 的成员对象（老用例、
 * 设置页的视图对象）仍然能得出正确的判断——「缺字段」与「在职」是同一件事。
 * `line` 缺省同样按「没有条线」算：一个没写条线的人不是任何条线的负责人。
 */
export type Member = {
  id: string;
  name: string;
  role: string;
  line?: string | null;
  deactivatedAt?: Date | null;
  /** 通知口味的原始 JSON 文本（`{"inherit":true}` 或显式布尔）。null = 默认。 */
  notifyPrefs?: string | null;
};

/**
 * 六种能力。写成六个词而不是一个 `role === ...` 的集合，是因为它们对应六件**不同**的
 * 事，而同一件事在不同状态下答案不同：
 *
 * - `edit`：改这条需求（评估、提交评审、排期、打回、拒绝、搁置、恢复、改描述、删除、
 *   以及新建时把负责人设成别人）。
 * - `review`：签字（通过 / 打回）。**只有**负责人所在条线的负责人与超管；而且只有
 *   状态在 `review`、派单是自己的时候。
 * - `reassignOwner`：把这条需求转交给另一个人（锚点同样是负责人的条线）。
 * - `claim`：把一条**还没有负责人**的需求认领下来（认领即成为负责人）。P4-06 新增，
 *   它取代了「类型决定派给谁」：没有负责人时没有条线可锚，只能由人认领。
 * - `admin`：就是「是不是超管」。
 * - `manageMembers`：建人 / 改人 / 停用。只有超管。
 */
export type Ability = 'edit' | 'review' | 'reassignOwner' | 'claim' | 'admin' | 'manageMembers';

/**
 * 判断一条需求时需要的全部事实。
 *
 * 全部从库里读出来（`lockRequirement` 的那一 select 里就有），**不接受**调用方凭印象
 * 填：一条「这条需求归谁管」的口头断言，等于把权限交给了调用方。
 *
 * `type` 不在这里：P4-06 把锚点从「需求类型」换成「负责人的条线」之后，类型与权限
 * 无关。把这个字段从类型里删掉，是为了让「谁还在拿类型判权限」变成一次编译错误，
 * 而不是一段读起来像是对的分支。
 */
export type RequirementFacts = {
  /** `requirements.owner_member_id`；null = 还没人认领。 */
  ownerMemberId: string | null;
  /**
   * 负责人所在条线（`members.line`，与 owner_member_id 那一行同一行）。
   * null 有**两种**含义，靠 `ownerMemberId` 区分：没有负责人 / 负责人没有条线。
   * 两者都不授予任何条线权限——前者只能认领，后者只有超管能动。
   */
  ownerLine: string | null;
  /** 状态（`review` 这一条只对 `review` 能力有意义）。 */
  state?: string | null;
  /** 这条需求 handed 派单上的评审人 id；undefined / null = 还没有派单。 */
  reviewerMemberId?: string | null;
};

/**
 * 与具体需求无关的能力（`admin` / `manageMembers`）用这条事实。
 *
 * 只给这两格用：`claim` 在这里会是「没有负责人」——拿它去判 `claim` 会把每一次设置页
 * 渲染变成一次认领。服务层的用法在 `src/core/members/manage.ts` 与设置页，两处都只问
 * `manageMembers`。
 */
export const NO_REQUIREMENT: RequirementFacts = { ownerMemberId: null, ownerLine: null };

export function isAdmin(actor: Member | null | undefined): boolean {
  return actor !== null && actor !== undefined && actor.role === 'product_owner';
}

/** 这个人是不是**这条**线的负责人：`role` 与 `line` 同时对得上（见 `leadLineOf`）。 */
export function leadsLine(actor: Member, line: string | null): boolean {
  return line !== null && leadLineOf(actor) === line;
}

/**
 * 这个人以负责人的身份管着哪条线；不是条线负责人就是 null。
 *
 * 这是「条线负责人」唯一的定义：`role` 与 `line` 同时成立。`can()` 用它、通知扇出用它、
 * 派单用它——三处给出的必须同一个人，否则会出现「能改的人收不到通知 / 收通知的人改不了」。
 */
export function leadLineOf(actor: Member): string | null {
  const line = actor.line ?? null;
  return line !== null && leadRoleOf(line) === actor.role ? line : null;
}

/** 这个人是不是某条线的负责人（不管是哪条线）。给「谁能认领」用。 */
export function isLineLead(actor: Member): boolean {
  return leadLineOf(actor) !== null;
}

/**
 * 唯一的判断题。
 *
 * **停用的人什么都不行**：`deactivatedAt` 非空直接 false。这一条放在最前面，是因为
 * 它是唯一一个「角色仍然写着 pm、但这个人已经不该动任何东西」的状态——若只看 role，
 * 停用就只是「登录不了」，而他手里那个还没过期的 token 仍然能写库。
 *
 * `edit` 的三档（顺序就是优先级）：
 * 1. 超管：改任何一条；
 * 2. 负责人所在条线的负责人：改那位负责人名下的任何一条（**与需求类型无关**）；
 * 3. 负责人本人：改自己负责的。
 *    没有负责人的需求对所有人都是「不是你的」——不能因为一条需求无主，就变成谁都能改；
 *    想管它，先认领（`claim`）。
 *
 * `review` 额外要求（顺序）：状态是 `review` → 超管，或负责人所在条线的负责人 →
 * **如果已经有派单，派单必须是本人**。第三步是 R29 的闭合点：同一条线配了两个人的
 * 时候，「条线锚定」只决定了「哪条线」，派单才决定「哪个人」。超管不受派单限制
 * （他能改任何东西，也是所有需求的评审人），但状态门对他同样成立。
 */
export function can(
  actor: Member | null | undefined,
  req: RequirementFacts,
  ability: Ability,
): boolean {
  if (actor === null || actor === undefined) return false;
  if (actor.deactivatedAt != null) return false;

  const admin = actor.role === 'product_owner';
  const ownerLine = req.ownerLine;
  /** 这个人是不是「负责人所在条线」的负责人——P4-06 的唯一锚点。 */
  const governs = leadsLine(actor, ownerLine);

  switch (ability) {
    case 'admin':
      return admin;
    case 'manageMembers':
      return admin;
    case 'edit':
      return admin
        || governs
        || (req.ownerMemberId !== null && req.ownerMemberId === actor.id);
    case 'reassignOwner':
      // 条线负责人只能在自己这条线内转交（目标是不是本线，由服务层再查一次——
      // 这里只回答「这个人有没有转交权」）。没有负责人的需求没有条线可锚：只有超管。
      return admin || (req.ownerMemberId !== null && governs);
    case 'claim':
      // 没有负责人 → 没有条线锚点。任何 PM / 条线负责人 / 超管都可以把它认领下来；
      // 认领之后这条需求就落到认领人的条线下（见 claim.ts）。
      return req.ownerMemberId === null
        && (admin || actor.role === 'pm' || isLineLead(actor));
    case 'review': {
      if (req.state !== 'review') return false;
      if (admin) return true;
      if (!governs) return false;
      return req.reviewerMemberId === undefined
        || req.reviewerMemberId === null
        || req.reviewerMemberId === actor.id;
    }
  }
}

/** 能力 → 被拒时那句中文。服务层只用这一份措辞。 */
export const FORBIDDEN_MESSAGE: Record<Ability, string> = {
  edit: '你只能改自己负责的需求',
  review: '只有负责人所在条线的负责人可以评审',
  reassignOwner: '只有负责人所在条线的负责人和超管可以转交负责人',
  claim: '这条需求已经有负责人了',
  admin: '只有超管可以做这一步',
  manageMembers: '只有超管可以管理成员',
};

/**
 * 一个能力被拒时抛什么。**只有这一处**造 `forbidden`，于是「拒绝的形状」不可能分叉：
 * 页面上是一句中文，MCP 里是同一个 code + 同一句话。
 *
 * 评审那一格是刻意的例外：它抛的是 review.ts 的 `not_reviewer`（同一句话
 * 「签字人不是这条需求派单到的评审人」）。那个错误码先于本模块存在，且被 P1 的用例
 * 逐字钉着（`tests/requirements.test.ts` 的 R29 那一组）；更精确的措辞也比一句笼统的
 * 「没有权限」更能告诉用户该找谁。其余七种动作用 `forbidden`。
 */
export class PermissionDenied extends AppError {
  constructor(ability: Ability, message?: string) {
    super('forbidden', message ?? FORBIDDEN_MESSAGE[ability]);
    this.name = 'PermissionDenied';
  }
}
