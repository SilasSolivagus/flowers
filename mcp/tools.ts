import { z } from 'zod';
import { db } from '../src/db/client.js';
import { AppError } from '../src/core/errors.js';
import { isPlainObject } from '../src/core/validate.js';
import { attachArtifact } from '../src/core/uemaster/attach.js';
import { listArtifacts } from '../src/core/uemaster/list.js';
import { packFor, STAGES, type Stage } from '../src/core/uemaster/packs.js';
import { getRequirementDetail, type DetailAction } from '../src/core/read/detail.js';

/**
 * 三个 MCP 工具的**实现**：普通异步函数，不碰 stdio。
 *
 * 为什么跟 `server.ts` 分成两个文件（计划「文件结构」段）：stdio 那一层没法直接断言
 * ——它的输出去向是另一个进程的管道；而工具逻辑要能拿真库跑、要能被一个普通 tsx 脚本
 * 直接调。所以这一层只做三件事：校验入参、调既有服务、把结果整理成结构化对象。
 * `server.ts` 只负责把它们挂到 `McpServer` 上，并把异常翻成 `isError`。
 *
 * 这一层**不新增任何写入路径**：attach 走 `attachArtifact`（校验 + 落库 + 事件都在那里），
 * plan 与 show 只走读模型。actor 由 `FLOWERS_MCP_ACTOR` 决定，落进 `events.actor`——
 * 时间线上「这条材料是 agent 交的」是靠这一列说出来的，不是靠事件类型。
 */

const BAD_STAGE = '阶段只能是 evaluate、review、inspect 之一';
const BAD_ID = '需求 ID 格式不正确';
const BAD_URL = '产物链接必须是以 http:// 或 https:// 开头的完整链接，或以 / 开头的站内路径';
const NO_REQUIREMENT = '需求不存在';

/**
 * 入参 schema —— **只在这一处定义**，`server.ts` 的 `inputSchema` 与这里的解析用的是
 * 同一个对象。为什么值得这么较真：MCP 客户端的工具列表（JSON Schema）与工具真正的
 * 校验若各写一份，迟早在「stage 的枚举值少一个」「url 允许了空串」这种地方分叉，
 * 而分叉的表现是「客户端说能调、服务端拒了」，最难查。
 *
 * 三条文案与领域层逐字对齐（`attach.ts` 的 `BAD_STAGE`/`BAD_URL`、`validate.ts` 的
 * `BAD_REQUIREMENT_ID`）：同一个错误从哪一层出去，用户看到的都是同一句话。
 * zod 的错误文案必须显式给中文——默认的 `Required` / `Expected string, received null`
 * 会直接漏给 agent。
 */
export const stageSchema = z.enum(STAGES, { errorMap: () => ({ message: BAD_STAGE }) });

export const requirementIdSchema = z.string({
  required_error: BAD_ID,
  invalid_type_error: BAD_ID,
}).uuid(BAD_ID);

/** `uemaster_plan`：要哪条需求、哪个阶段的包。 */
export const planInput = z.object({
  requirementId: requirementIdSchema,
  stage: stageSchema,
});

/**
 * `uemaster_attach`：要交回的链接。
 *
 * url 这里**只**要求是个字符串、不是空白：真正的合法性（scheme、站内路径、跳不跳得出
 * public/、文件在不在）全部归 `attachArtifact` 管，那里会报 `invalid_url` /
 * `artifact_missing`。schema 里再判一遍前缀，只会让同一件事有两个出口。
 */
export const attachInput = z.object({
  requirementId: requirementIdSchema,
  stage: stageSchema,
  url: z.string({ required_error: BAD_URL, invalid_type_error: BAD_URL }).trim().min(1, BAD_URL),
});

/** `requirement_show`：只要需求 ID。 */
export const showInput = z.object({ requirementId: requirementIdSchema });

export type PlanInput = z.infer<typeof planInput>;
export type AttachInput = z.infer<typeof attachInput>;
export type ShowInput = z.infer<typeof showInput>;

/**
 * 校验入参，失败就抛 `AppError('invalid')`。
 *
 * 为什么不是直接 `schema.parse`：ZodError 不是 AppError，`server.ts` 会把它当未预期
 * 错误（连带打一条堆栈）。而「少传了 requirementId」是最平常的用户错误，该拿到一句
 * 中文，走与领域层同一条出口。
 *
 * 非对象（null / 数组 / 字符串）先在这里挡掉：zod 对它们给的是
 * `Expected object, received null`，那句话不该出现在界面上。
 */
function parseInput<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  if (!isPlainObject(raw)) throw new AppError('invalid', '参数不合法');
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('invalid', parsed.error.issues[0]?.message ?? '参数不合法');
  }
  return parsed.data;
}

/**
 * 写操作的那个人。
 *
 * `FLOWERS_MCP_ACTOR` 由使用者（`claude mcp add` 的那条命令、`.mcp.json` 的 env）
 * 指定，值直接进 `events.actor` 与 `uemaster_artifacts.created_by`。缺省是 `agent`：
 * 宁可时间线上写着「agent」，也不要让它看起来像是某个真人点的。
 * 空串与纯空白当没配——`actor=''` 在时间轴上是一行看不见来源的记录。
 */
export function mcpActor(): string {
  const name = process.env.FLOWERS_MCP_ACTOR?.trim();
  return name !== undefined && name.length > 0 ? name : 'agent';
}

/** `uemaster_plan` 的返回值：任务包 + 这条需求的身份（agent 拿它对齐 PAN-n 与需求 ID）。 */
export type PlanOutput = {
  stage: Stage;
  pack: string;
  requirement: { id: string; number: number; title: string; state: string; type: string };
};

/**
 * 生成任务包。
 *
 * **纯读**：只走 `getRequirementDetail`（一次 select）与纯函数 `packFor`，
 * 不改需求状态、不写事件、不落任何行。这是评审过的口径——「拿任务包」是看一眼，
 * 不是动作；只有 attach 才是动作，也只有它会在时间线上留痕。
 *
 * 需求不存在（含非 uuid：读模型对这两种都返回 null）→ `not_found`。这里必须先报
 * 「需求不存在」而不是让 packFor 拿一个空需求去拼包：agent 打错 uuid 是最常见的失败，
 * 而一份拼给不存在的需求的包，会被它当成真的干完活。
 */
export async function planTool(raw: unknown): Promise<PlanOutput> {
  const { requirementId, stage } = parseInput(planInput, raw);

  const detail = await getRequirementDetail(requirementId);
  if (detail === null) throw new AppError('not_found', NO_REQUIREMENT);

  const pack = packFor(stage, {
    id: detail.id,
    number: detail.number,
    title: detail.title,
    type: detail.info.type,
    requester: detail.info.requester,
    prdUrl: detail.info.prdUrl,
  });

  return {
    stage,
    pack,
    requirement: {
      id: detail.id,
      number: detail.number,
      title: detail.title,
      state: detail.state,
      type: detail.info.type,
    },
  };
}

/**
 * 把产物交回来。
 *
 * 一行都不自己写：校验（uuid / stage 白名单 / url 形状）、站内文件存在性、
 * 事务里的 insert 与 `uemaster.attached` 事件全在 `attachArtifact` 里——那是 P2
 * 唯一被测试钉住的写入路径，这里再抄一遍就会有两份不一致的规则。
 *
 * 返回值刻意只有 `{ ok, url }`：agent 需要的确认就是「这条链接现在在库里了」，
 * 多给它一个 id 只会让它下次编一个 id 来用。
 */
export async function attachTool(raw: unknown): Promise<{ ok: true; url: string }> {
  const { requirementId, stage, url } = parseInput(attachInput, raw);
  const got = await attachArtifact(db, mcpActor(), { requirementId, stage, url });
  return { ok: true, url: got.url };
}

/** `requirement_show` 的返回值：一条需求的现状 + 三处产物 + 还缺哪几处。 */
export type ShowOutput = {
  id: string;
  number: number;
  title: string;
  state: string;
  stateLabel: string;
  stateDays: number;
  stateEnteredAt: string;
  type: string;
  typeLabel: string;
  requester: string;
  owner: string | null;
  prdUrl: string | null;
  skipReason: string | null;
  actions: DetailAction[];
  artifacts: Array<{ stage: Stage; url: string; at: string }>;
  missing: Stage[];
};

/**
 * 让 agent 不必再问人：现状、类型、负责人、PRD、已有产物、还缺哪几处。
 *
 * 与抽屉共用 `getRequirementDetail`——两个读侧各写一套查询，迟早在「handed 派单怎么定序」
 * 这种细节上分叉，而 agent 看到的与用户看到的必须是同一件事。
 *
 * `actions` 是**当前状态下合法的动作**（`detail.ts` 的 `actionsFor`），它是 agent 判断
 * 「下一步该干什么」的依据：状态机不接受的动作，做了也是白做。
 * `missing` 是三个 stage 里还没有产物的那些——那是 `uemaster_plan` 还欠的活。
 */
export async function showTool(raw: unknown): Promise<ShowOutput> {
  const { requirementId } = parseInput(showInput, raw);

  const detail = await getRequirementDetail(requirementId);
  if (detail === null) throw new AppError('not_found', NO_REQUIREMENT);

  const artifacts = await listArtifacts(db, detail.id);
  const attached = new Set<Stage>(artifacts.map((a) => a.stage));

  return {
    id: detail.id,
    number: detail.number,
    title: detail.title,
    state: detail.state,
    stateLabel: detail.stateLabel,
    stateDays: detail.days,
    stateEnteredAt: detail.info.stateEnteredAt,
    type: detail.info.type,
    typeLabel: detail.info.typeLabel,
    requester: detail.info.requester,
    owner: detail.info.owner,
    prdUrl: detail.info.prdUrl,
    skipReason: detail.info.skipReason,
    actions: detail.actions,
    artifacts: artifacts.map((a) => ({ stage: a.stage, url: a.url, at: a.at.toISOString() })),
    missing: STAGES.filter((stage) => !attached.has(stage)),
  };
}
