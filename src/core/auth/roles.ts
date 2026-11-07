import { AppError } from '../errors.js';

/**
 * 角色、条线、`can()` —— 全部权限规则的**唯一**来源（P4-04）。
 *
 * 为什么集中在这一个文件：权限是这个系统里最容易长出第二份的地方。界面要它（按钮显示
 * 不显示）、服务层要它（能不能改）、MCP 要它（token 换来的这个人能不能动）、通知要它
 * （谁收到哪一条）。四份各写一遍，分叉的时候**没有人会看到**——最坏的一类分叉是
 * 「按钮不见了但接口还通」：界面上看不见，抽屉一提交就成功。所以：
 *
 * - 角色取值、条线取值、`type → 条线负责人角色` 的映射，三张表都只在这里；
 * - 一切「谁能做什么」的判断题都必须经过 `can()`；
 * - 服务层只调用它，不复制它的分支（`src/core/requirements/*.ts` 一律 `assertCan`）。
 *
 * ── 角色（`members.role`）
 *
 * | 角色值 | 中文 | 能做什么 |
 * |---|---|---|
 * | `product_owner` | 超管 / 产品总负责人 | 一切。改任何需求、转交任何负责人、管理成员、评审任何一条、收到全部通知 |
 * | `feature_reviewer` / `commercial_reviewer` | 条线负责人 | 改**本线**任何需求、在本线内转交负责人、评审本线需求、收本线全部通知 |
 * | `pm` | PM | 只改**自己负责**的需求；评审动作对他**不存在**（不是「存在但报错」） |
 *
 * ── 条线（`members.line`）
 *
 * `feature` / `commercial` / null。PM 也有条线（人要归属到一条线上），但**条线不授予
 * 权限**：权限只看 `role`。「谁是功能线的负责人」永远由 `role = 'feature_reviewer'`
 * 回答，不由 `line` 回答——两列同时存在时，`role` 是权威，`line` 只用于转交/建人时
 * 判断「这个人是不是在这条线上」以及界面展示。这样即使有人把某个 PM 的 line 改错，
 * 权限也不会跟着变。
 */

export const ROLES = ['product_owner', 'feature_reviewer', 'commercial_reviewer', 'pm'] as const;
export type Role = (typeof ROLES)[number];

export const LINES = ['feature', 'commercial'] as const;
export type Line = (typeof LINES)[number];

/** 需求类型 → 条线。需求只有两种类型，这个映射是「类型决定评审人」的起点。 */
export const LINE_OF_TYPE: Record<string, Line> = {
  feature: 'feature',
  commercial: 'commercial',
};

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

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isLine(value: unknown): value is Line {
  return typeof value === 'string' && (LINES as readonly string[]).includes(value);
}

/**
 * 需求类型 → 那条线的负责人角色。认不出的类型返回 null（调用方自己报「类型不认识」）。
 *
 * `Object.hasOwn` 而不是裸查表：type 来自数据库的 text 列，`'toString'` / `'constructor'`
 * 会命中原型上的函数并当成角色用——review.ts 的 assignReviewer 上踩过同一颗雷。
 */
export function reviewerRoleOf(type: string): Role | null {
  const line = lineOfType(type);
  return line === null ? null : ROLE_OF_LINE[line];
}

export function lineOfType(type: string): Line | null {
  return Object.hasOwn(LINE_OF_TYPE, type) ? (LINE_OF_TYPE[type] ?? null) : null;
}

/**
 * 名册上的一行。`deactivatedAt` 非空 = 已停用（登录被拒、不再收通知、不进下拉）。
 *
 * `line` 与 `deactivatedAt` 标成可选：读模型总是给全，但**权限结论不该依赖调用方
 * 是否多填了两个字段**。`can()` 只在 `deactivatedAt` 有值时才据此拒绝（`!= null`
 * 同时覆盖 null 与 undefined），所以一个只有 `{id, name, role}` 的成员对象（老用例、
 * 设置页的视图对象）仍然能得出正确的判断——「缺字段」与「在职」是同一件事。
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
 * 四种能力。写成四个词而不是一个 `role === ...` 的集合，是因为它们对应四件**不同**的
 * 事，而同一件事在不同状态下答案不同：
 *
 * - `edit`：改这条需求（评估、提交评审、排期、打回、拒绝、搁置、恢复、改描述、删除、
 *   以及新建时把负责人设成别人）。
 * - `review`：签字（通过 / 打回）。**只有**条线负责人与超管；而且只有状态在 `review`、
 *   派单是自己的时候。
 * - `reassignOwner`：把这条需求转交给另一个人。
 * - `admin`：就是「是不是超管」。
 * - `manageMembers`：建人 / 改人 / 停用。只有超管。
 */
export type Ability = 'edit' | 'review' | 'reassignOwner' | 'admin' | 'manageMembers';

/**
 * 判断一条需求时需要的全部事实。
 *
 * 全部从库里读出来（`lockRequirement` 的那一 select 里就有），**不接受**调用方凭印象
 * 填：一条「这条需求是谁的」的口头断言，等于把权限交给了调用方。
 */
export type RequirementFacts = {
  /** commercial | feature */
  type: string;
  /** `requirements.owner_member_id`；null = 还没人认领。 */
  ownerMemberId: string | null;
  /** 状态（`review` 这一条只对 `review` 能力有意义）。 */
  state?: string | null;
  /** 这条需求 handed 派单上的评审人 id；undefined / null = 还没有派单。 */
  reviewerMemberId?: string | null;
};

/** 这个人是这条线的负责人（条线负责人角色，且角色与需求类型对得上）。 */
function leadsLineOf(actor: Member, type: string): boolean {
  return actor.role === reviewerRoleOf(type);
}

export function isAdmin(actor: Member | null | undefined): boolean {
  return actor !== null && actor !== undefined && actor.role === 'product_owner';
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
 * 2. 条线负责人：改**本线**任何一条（`role` 与 `type` 的映射对得上）；
 * 3. PM：只改自己负责的（`owner_member_id = 我`）。没有负责人的需求（null）对 PM
 *    一律是「不是你的」——不能因为一条需求无主，就变成谁都能改。
 *
 * `review` 额外要求（顺序）：状态是 `review` → 是这条线的负责人（或超管）→
 * **如果已经有派单，派单必须是本人**。第三步是 R29 的闭合点：同一条线配了两个人的
 * 时候，「类型决定评审人」只决定了「哪条线」，派单才决定「哪个人」。超管不受派单
 * 限制（他能改任何东西，也是所有需求的评审人），但状态门对他同样成立。
 */
export function can(
  actor: Member | null | undefined,
  req: RequirementFacts,
  ability: Ability,
): boolean {
  if (actor === null || actor === undefined) return false;
  if (actor.deactivatedAt != null) return false;

  const admin = actor.role === 'product_owner';

  switch (ability) {
    case 'admin':
      return admin;
    case 'manageMembers':
      return admin;
    case 'edit':
      return admin
        || leadsLineOf(actor, req.type)
        || (req.ownerMemberId !== null && req.ownerMemberId === actor.id);
    case 'reassignOwner':
      // 条线负责人只能在自己这条线内转交（目标是不是本线，由服务层再查一次——
      // 这里只回答「这个人有没有转交权」）。
      return admin || leadsLineOf(actor, req.type);
    case 'review': {
      if (req.state !== 'review') return false;
      if (admin) return true;
      if (!leadsLineOf(actor, req.type)) return false;
      return req.reviewerMemberId === undefined
        || req.reviewerMemberId === null
        || req.reviewerMemberId === actor.id;
    }
  }
}

/** 能力 → 被拒时那句中文。服务层只用这一份措辞。 */
export const FORBIDDEN_MESSAGE: Record<Ability, string> = {
  edit: '你只能改自己负责的需求',
  review: '只有这条需求所属条线的负责人可以评审',
  reassignOwner: '只有条线负责人和超管可以转交负责人',
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
