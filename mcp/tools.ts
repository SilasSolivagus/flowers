import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '../src/db/client.js';
import { AppError } from '../src/core/errors.js';
import { activeMemberByName } from '../src/core/auth/members.js';
import { isPlainObject } from '../src/core/validate.js';
import { CreateInput } from '../src/core/requirements/create.js';
import { BOARD_STATES } from '../src/core/read/board.js';
import type { DetailAction } from '../src/core/read/detail.js';
import { STATE_LABEL, type State } from '../src/core/state-machine.js';
import { DESCRIPTIVE_FIELDS } from '../src/core/requirements/fields.js';
import { missingRequired } from '../src/core/requirements/brief.js';
import { packFor, STAGES, type Stage } from '../src/core/uemaster/packs.js';
import { nextArtifactVersion } from '../src/core/uemaster/versions.js';
import { SERVICES } from './services.js';
import { scopeAllows, scopeLabel, type Identity, type Scope } from './tokens.js';

/**
 * 全部 MCP 工具的**定义**：名字、入参 schema、合法状态、要什么权限、调哪个服务。
 *
 * 这一层仍然是「普通函数」，不碰 stdio、不碰 HTTP：两个入口（`mcp/server.ts` 的
 * stdio 与 `app/mcp/route.ts` 的 Streamable HTTP）都只做一件事——把这份定义挂到
 * 一个 `McpServer` 上，所以「工具长什么样」只有这一处答案。
 *
 * 三条硬口径：
 *
 * 1. **不新增第二个校验层。** 入参 schema 只做「形状」——uuid、枚举、非空串；
 *    「这条需求现在能不能排期」「打回要不要新日期」全部归服务层（那里的 `AppError`
 *    是唯一出口）。这里若再判一遍，就会有两份会分叉的规则，而分叉的表现是
 *    「工具说能调、服务拒了」，最难查。
 * 2. **合法状态不是手写的散文。** 每个工具声明它对应 `detail.ts` 的哪个
 *    `DetailAction`，状态清单从 `LEGAL_FROM` 取，描述里的中文由 `STATE_LABEL`
 *    拼出来。`detail.ts` 的 `actionsFor` 没导出（P4 冻结 core），所以这里留了一张
 *    同口径的表，并用 `tests/mcp-legal-from.test.ts` 把它逐状态钉在 `actionsFor` 上
 *    ——**那张测试就是这份表与状态机之间的唯一约定**。
 * 3. **actor 永远是 token 换来的成员**，不是工具参数。`Identity.member` 直接进
 *    `events.actor` 与 `uemaster_artifacts.created_by`：时间线上「谁承诺了哪一天」
 *    必须答得出名字，匿名动作在这套 API 里不存在。
 */

const BAD_ID = '需求 ID 格式不正确';
const BAD_STAGE = '阶段只能是 evaluate、review、inspect 之一';
const BAD_URL = '产物链接必须是以 http:// 或 https:// 开头的完整链接，或以 / 开头的站内路径';
const NO_REQUIREMENT = '需求不存在';

/**
 * 入参 schema —— **只在这一处定义**，两个入口的 `inputSchema` 与调用前的解析用的是
 * 同一个对象。MCP 客户端看到的 JSON Schema 与真正的校验因此不可能分叉。
 *
 * zod 的错误文案必须显式给中文：默认的 `Required` / `Expected string, received null`
 * 会直接漏给 agent。三条文案与领域层逐字对齐（`attach.ts` 的 `BAD_STAGE`/`BAD_URL`、
 * `validate.ts` 的 `BAD_REQUIREMENT_ID`）：同一个错误从哪一层出去，用户看到的都是同一句。
 */
export const stageSchema = z.enum(STAGES, { errorMap: () => ({ message: BAD_STAGE }) });

export const requirementIdSchema = z.string({
  required_error: BAD_ID,
  invalid_type_error: BAD_ID,
}).uuid(BAD_ID);

const reasonSchema = z.string({ required_error: '必须写原因', invalid_type_error: '必须写原因' })
  .trim().min(1, '必须写原因');

/**
 * 日期：`'YYYY-MM-DD'`（服务层按 UTC 零点解析）。
 *
 * 这里**不判可解析性**：`schedule` 报「提测日和承诺完成日必须是有效日期」比 zod 的
 * 「格式不对」更贴近用户要修的东西（它还知道哪个日期是哪个）。所以这里只要求
 * 「是个非空字符串」，空串由服务层的 missing_dates 统一说。
 */
const dateSchema = z.string({ required_error: '必须填日期', invalid_type_error: '必须填日期' })
  .trim().min(1, '必须填日期');

const releaseIdSchema = z.string({
  required_error: '必须填版本 ID', invalid_type_error: '版本 ID 格式不正确',
}).uuid('版本 ID 格式不正确');

/** `uemaster_plan` / `uemaster_attach`：要哪条需求、哪个阶段的包。 */
export const planInput = z.object({
  requirementId: requirementIdSchema,
  stage: stageSchema,
});

/**
 * `uemaster_attach`：要交回的链接。
 *
 * url 这里**只**要求是个字符串、不是空白：真正的合法性（scheme、站内路径、跳不跳得出
 * 产物根、文件在不在）全部归 `attachArtifact` 管，那里会报 `invalid_url` /
 * `artifact_missing`。schema 里再判一遍前缀，只会让同一件事有两个出口。
 */
export const attachInput = z.object({
  requirementId: requirementIdSchema,
  stage: stageSchema,
  url: z.string({ required_error: BAD_URL, invalid_type_error: BAD_URL }).trim().min(1, BAD_URL),
});

/** `requirement_show`：只要需求 ID。 */
export const showInput = z.object({ requirementId: requirementIdSchema });

/** `requirement_prd`：只读最近一次快照，**不写库**。 */
export const prdInput = z.object({
  requirementId: requirementIdSchema,
});

/** `requirement_prd_refresh`：去源文档现读一版并落快照（会写库，所以要 write）。 */
export const prdRefreshInput = z.object({
  requirementId: requirementIdSchema,
});

/**
 * `requirement_list`：三个过滤器，都可以不给。
 *
 * `state` 的取值来自 `BOARD_STATES`（看板列序的唯一契约），不在这里再抄一份十个字符串：
 * 给 State 加成员时那张表先变，这里跟着变。
 */
export const listInput = z.object({
  state: z.enum([...BOARD_STATES] as [State, ...State[]], {
    errorMap: () => ({ message: '状态只能是看板十列之一：inbox/design/review/queue/ready/dev/test/live/rejected/shelved' }),
  }).optional(),
  /** 负责人姓名（精确匹配）。「我的」用 `mine`，不是把自己的名字填进来。 */
  owner: z.string({ invalid_type_error: 'owner 是负责人姓名' }).trim().min(1).optional(),
  /** true = 只要「现在就等我动手」的那些（与看板主色框同一条规则）。 */
  mine: z.boolean({ invalid_type_error: 'mine 只能是 true 或 false' }).optional(),
  /** 标题关键词（子串、不分大小写）。2026-11-11 加：没有它，597 条只能整页取回。 */
  q: z.string({ invalid_type_error: 'q 是标题关键词' }).trim().min(1).max(200).optional(),
  /** 编号（纯数字，PAN-742 写 742）。旧编号在迁移后重排，别拿老 Flower 的编号来查。 */
  number: z.number({ invalid_type_error: 'number 是数字' }).int('number 是整数').min(1).optional(),
  /** 分页起点（配合 limit 用）。默认 0。 */
  offset: z.number({ invalid_type_error: 'offset 是数字' }).int('offset 是整数').min(0).optional(),
  limit: z.number({ invalid_type_error: 'limit 是数字' }).int('limit 是整数')
    .min(1, 'limit 至少是 1').max(500, 'limit 最多 500').optional(),
});

/** `requirement_submit_review`：PRD 链接是这条迁移的通行证。 */
export const submitReviewInput = z.object({
  requirementId: requirementIdSchema,
  prdUrl: z.string({ required_error: '提交评审必须填正式 PRD 链接', invalid_type_error: BAD_URL })
    .trim().min(1, '提交评审必须填正式 PRD 链接'),
});

/** `requirement_update`：只开「描述类」字段（标题 / 六问 / 平台 / 优先级 / 备注）。 */
export const updateInput = z.object({
  requirementId: requirementIdSchema,
  title: z.string().trim().min(1, '标题不能为空').optional(),
  /** PRD 链接（2026-11-11）：改它是「补文档」，不是状态动作。 */
  prdUrl: z.string().nullish(),
  /** 类型（2026-11-11）：commercial / feature；空 = 未指定。 */
  type: z.enum(['commercial', 'feature'], {
    message: '类型只能是 commercial（商业）或 feature（功能）',
  }).nullish(),
  context: z.string().nullish(),
  problem: z.string().nullish(),
  outcome: z.string().nullish(),
  surfaces: z.string().nullish(),
  edgeCases: z.string().nullish(),
  outOfScope: z.string().nullish(),
  platforms: z.array(z.string()).nullish(),
  priority: z.enum(['p0', 'p1', 'p2', 'p3', 'green'], {
    message: '优先级只能是 P0/P1/P2/P3/绿色通道（p0/p1/p2/p3/green）',
  }).nullish(),
  remark: z.string().nullish(),
});

/** `requirement_claim`：把一条无主需求接到自己名下。 */
export const claimInput = z.object({ requirementId: requirementIdSchema });

/** `requirement_assign`：转交负责人（条线负责人只能转本线，超管不受限）。 */
export const assignInput = z.object({
  requirementId: requirementIdSchema,
  ownerMemberId: z.string({ required_error: '要给新负责人的 UUID（用 member_list 取）' })
    .uuid('ownerMemberId 是成员的 UUID，不是姓名'),
});

/** `requirement_review_pass`：只有需求 ID（签字人由派单决定，不由参数决定）。 */
export const reviewPassInput = z.object({ requirementId: requirementIdSchema });

/** `requirement_review_reject`：打回必须写原因。 */
export const reviewRejectInput = z.object({
  requirementId: requirementIdSchema,
  reason: reasonSchema,
});

/** `requirement_schedule`：版本 + 提测日 + 承诺完成日，三个都必填。 */
export const scheduleInput = z.object({
  requirementId: requirementIdSchema,
  releaseId: releaseIdSchema,
  commitTestAt: dateSchema,
  commitDueAt: dateSchema,
});

/** `requirement_reschedule`：已在版本里的需求改版本 / 提测日 / 承诺完成日（不动状态）。 */
export const rescheduleInput = z.object({
  requirementId: requirementIdSchema,
  releaseId: releaseIdSchema,
  commitTestAt: dateSchema,
  commitDueAt: dateSchema,
});

/** `requirements_batch_update`：批量改描述类字段，默认 dryRun（先给差异）。 */
export const batchInput = z.object({
  ids: z.array(requirementIdSchema).min(1, '至少给一条').max(50, '一次最多 50 条'),
  patch: z.object({
    priority: z.string().nullish(),
    type: z.string().nullish(),
    remark: z.string().nullish(),
    platforms: z.array(z.string()).nullish(),
    prdUrl: z.string().nullish(),
  }).refine((value) => Object.values(value).some((item) => item !== undefined && item !== null), {
    message: '没有任何要改的字段',
  }),
  /** 默认 true：先给差异。真写要显式给 false。 */
  dryRun: z.boolean().optional(),
});

/** `requirement_calibrate`：超管把存量卡片摆到它真实所在的阶段（要原因）。 */
export const calibrateInput = z.object({
  requirementId: requirementIdSchema,
  to: z.enum([...BOARD_STATES] as [State, ...State[]], {
    message: '状态只能是看板十列之一：inbox/design/review/queue/ready/dev/test/live/rejected/shelved',
  }),
  reason: z.string({ required_error: '状态校准必须写原因' }).trim().min(1, '状态校准必须写原因'),
});

/** `requirement_bounce`：打回必须写原因，并重填承诺完成日。 */
export const bounceInput = z.object({
  requirementId: requirementIdSchema,
  reason: reasonSchema,
  newCommitDueAt: dateSchema,
});

/** `requirement_reject` / `requirement_shelve`：拒绝 / 搁置都必须写原因。 */
export const terminalReasonInput = z.object({
  requirementId: requirementIdSchema,
  reason: reasonSchema,
});

/** `requirement_restore`：只要需求 ID。 */
export const restoreInput = z.object({ requirementId: requirementIdSchema });

/**
 * 校验入参，失败就抛 `AppError('invalid')`。
 *
 * 为什么不是直接 `schema.parse`：ZodError 不是 AppError，`runTool` 会把它当未预期
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
 * 动作 → 它合法的起始状态。**逐字对齐 `src/core/read/detail.ts` 的 `actionsFor`。**
 *
 * 为什么是抄一份而不是 import：`actionsFor` 是那个模块的私有函数（P4 冻结 core，
 * 不为 MCP 开一个导出）。所以这份表存在，并由
 * `tests/mcp-legal-from.test.ts` 逐状态比对 `getRequirementDetail().actions`
 * ——十个状态都造一遍真需求，两边不等就红。**那张测试才是口径本身**，这张表只是
 * 它的镜像；改了 `actionsFor` 而没改这里，测试会立刻说出是哪个状态。
 *
 * `Record<DetailAction, …>` 不是 `Record<string, …>`：`DetailAction` 加了成员而这里没跟，
 * 编译就失败——比测试早一步。
 *
 * `approve` 是「立项」：inbox → 待设计（2026-11-10 起叫这个名字，之前叫 `evaluate`）。
 * 它曾经刻意留空（当时把它当成「生成评估材料」，而那不是一个点一下就能完成的动作）。
 * P4-08 认领上线之后它回来了——认领只给负责人、不动状态，而收集状态的唯一出口就是
 * 这条边；不把工具放出来，agent 认领完同样卡死。
 *
 * 它与 `uemaster_plan` / `uemaster_attach`（出材料 / 交材料）是**两件事**：那两个不改
 * 状态，这一个改。理由见 `requirement_start_design` 的 purpose。
 */
export const LEGAL_FROM: Record<DetailAction, readonly State[]> = {
  approve: ['inbox'],
  submitReview: ['inbox', 'design'],
  reject: ['inbox'],
  shelve: ['inbox', 'design', 'review', 'queue', 'ready', 'dev', 'test', 'live'],
  reviewPass: ['review'],
  reviewReject: ['review'],
  schedule: ['queue'],
  bounce: ['test'],
  restore: ['shelved'],
  // 回滚（2026-11-10）：只有已上线的能撤回。
  rollback: ['live'],
  reopen: ['dev'],
};

/** 一个工具的定义形状。`call` 返回**多段文本**，每段对应 MCP 结果里的一段。 */
export type ToolDef = {
  name: string;
  title: string;
  /** 完整描述 = 用途 + 权限 + 合法状态，由 `trailer()` 拼。 */
  description: string;
  inputSchema: z.ZodTypeAny;
  scope: Scope;
  /** 对应 `detail.ts` 的哪个动作；`null` = 不推状态机的工具（读 / 建 / 交材料）。 */
  action: DetailAction | null;
  call(identity: Identity, args: unknown): Promise<string[]>;
};

type Draft = Omit<ToolDef, 'description'> & { purpose: string };

/**
 * 每个工具声明的「合法状态」。
 *
 * 没有 `action` 的工具（列表 / 详情 / PRD / 任务包 / 建需求 / 交材料）不受状态机约束：
 * 它们在任何状态下都能调，其中只有「交材料」会写库。它**不推状态机**（2026-11-10 起）：
 * 「材料落地就进待设计」那条内部耦合已经删掉，推进状态只能调
 * `requirement_start_design`（立项）。
 */
function legalSentence(draft: Draft): string {
  if (draft.action === null) return '合法状态：任何状态都能调，不按状态拒绝。';
  const states = LEGAL_FROM[draft.action];
  if (states.length === 0) return '合法状态：没有——没有任何状态允许这个动作。';
  const labels = states.map((state) => `「${STATE_LABEL[state]}」`).join('、');
  return `合法状态：${labels}。其它状态由服务层拒绝（isError + 中文原文），不要自己预判。`;
}

/** 描述尾部：权限 + 合法状态。两条都从声明里算，不手写。 */
/**
 * 工具说明的收尾（2026-11-11 加第三句）。
 *
 * 第三句是**给执行方式指路**：MCP 这一层说清「能不能做、为什么不能」，真正落地建议用
 * 技能包里的脚本直接打 REST（`/api/v1/*`）——一个 tool call 的往返 + 二十几条描述
 * 全进上下文，比二十行脚本贵得多。地址取 `FLOWERS_PUBLIC_URL`，没配就写相对路径。
 */
function trailer(draft: Draft): string {
  const base = (process.env.FLOWERS_PUBLIC_URL ?? '').replace(/\/+$/, '');
  return `权限：${scopeLabel(draft.scope)}。${legalSentence(draft)}`
    + `执行方式：技能包 ${base || ''}/api/v1/skills/flowers-ops（脚本直调 /api/v1/*，本回复只说明规则）。`;
}

function tool(draft: Draft): ToolDef {
  return { ...draft, description: `${draft.purpose}${trailer(draft)}` };
}

const NO_REQUIREMENT_HINT = '需求 ID 是 uuid，不是 PAN-9。';

/** 建需求：字段与 `createRequirement` 的入参**同一个 schema**（不是副本）。 */
const createInput = CreateInput;

/** 工具实现：都只是「解析入参 → 调服务 → 把结果整理成文本块」。 */

/**
 * 生成任务包。
 *
 * **纯读**：只走 `getRequirementDetail`（一次 select）与纯函数 `packFor`，
 * 不改需求状态、不写事件、不落任何行——「拿任务包」是看一眼，不是动作。
 *
 * 需求不存在（含非 uuid：读模型对这两种都返回 null）→ `not_found`。必须先报
 * 「需求不存在」而不是让 packFor 拿一个空需求去拼包：agent 打错 uuid 是最常见的失败，
 * 而一份拼给不存在的需求的包，会被它当成真的干完活。
 */
async function planTool(identity: Identity, raw: unknown): Promise<string[]> {
  void identity;
  const { requirementId, stage } = parseInput(planInput, raw);

  const detail = await SERVICES.getRequirementDetail(requirementId);
  if (detail === null) throw new AppError('not_found', NO_REQUIREMENT);

  /**
   * 这一版是第几版（2026-11-10 owner 的第一次纠正）：包里那句「写到哪个文件」必须带
   * 版本号，否则照着做的 agent 会覆盖上一份材料（而库里照样多一行）。
   *
   * 版本号在这里算一次（与 `start.ts` 的 runJob 同一个函数），所以「MCP 拿到的包」与
   * 「Flowers 自己跑出来的包」写的是同一个文件名形状：`evaluate-v003.html`。
   */
  const version = await nextArtifactVersion(db, detail.id, detail.number, stage);
  const pack = packFor(stage, {
    id: detail.id,
    number: detail.number,
    title: detail.title,
    type: detail.info.type,
    requester: detail.info.requester,
    prdUrl: detail.info.prdUrl,
    version,
  });

  // 包正文单独一段：它就是给 agent 的指令，不该被 JSON 转义成一行。
  return [
    JSON.stringify({
      id: detail.id,
      number: detail.number,
      title: detail.title,
      state: detail.state,
      type: detail.info.type,
    }, null, 2),
    pack,
  ];
}

/** 读 PRD：默认用最近一次快照，没有（或 refresh）时现读一次源文档。 */
/**
 * 只读版：**不写库**。
 *
 * 为什么要拆开：`read` 权限的语义是「不会改变任何东西」。早前这一版在没有快照时会
 * 顺手调 `readPrd` 落一版快照 + 记事件——一个只读 token 因此能写库。语义要么守，
 * 要么就别叫只读。
 */
/**
 * 写版：现读一版源文档并落快照（`readPrd` 会写 `prd_snapshots` + 记 `prd.fetched`）。
 * 与只读版拆开之后，`read` token 再也碰不到写路径。
 */
async function prdRefreshTool(identity: Identity, raw: unknown): Promise<string[]> {
  const { requirementId } = parseInput(prdRefreshInput, raw);

  const detail = await SERVICES.getRequirementDetail(requirementId);
  if (detail === null) throw new AppError('not_found', NO_REQUIREMENT);

  const got = await SERVICES.readPrd(db, identity.member, { requirementId });
  if (!got.ok) throw new AppError(got.code, got.message);
  const snapshot = got.data.snapshot;

  return [
    JSON.stringify({
      requirementId,
      number: detail.number,
      title: detail.title,
      state: detail.state,
      url: snapshot.url,
      hash: snapshot.hash,
      fetchedAt: snapshot.fetchedAt.toISOString(),
      chars: snapshot.markdown.length,
      source: 'live',
    }, null, 2),
    snapshot.markdown,
  ];
}

async function prdTool(_identity: Identity, raw: unknown): Promise<string[]> {
  const { requirementId } = parseInput(prdInput, raw);

  const detail = await SERVICES.getRequirementDetail(requirementId);
  if (detail === null) throw new AppError('not_found', NO_REQUIREMENT);

  const snapshot = await SERVICES.latestSnapshot(db, requirementId);
  if (snapshot === null) {
    throw new AppError(
      'no_prd_snapshot',
      '这条需求还没有 PRD 快照（只读工具不拉取）。用 requirement_prd_refresh 读一版，'
        + '或在 Flowers 里点一次「读 PRD」。',
    );
  }
  const source: 'snapshot' | 'live' = 'snapshot';

  return [
    JSON.stringify({
      requirementId,
      number: detail.number,
      title: detail.title,
      state: detail.state,
      url: snapshot.url,
      hash: snapshot.hash,
      fetchedAt: snapshot.fetchedAt.toISOString(),
      chars: snapshot.markdown.length,
      source,
    }, null, 2),
    snapshot.markdown,
  ];
}

/** 列表：一条 SQL 取全部需求（`getBoard`），过滤在内存里做。 */
async function listTool(identity: Identity, raw: unknown): Promise<string[]> {
  const { state, owner, mine, q, number, offset, limit } = parseInput(listInput, raw);

  const columns = await SERVICES.getBoard(identity.member);
  const rows = columns.flatMap((column) => column.cards.map((card) => ({
    id: card.id,
    number: card.number,
    title: card.title,
    state: column.state,
    stateLabel: column.label,
    owner: card.owner,
    waiting: card.waiting,
    waitingOn: card.waitingOn,
    late: card.late,
    days: card.days,
    mine: card.mine,
    inspectAtLabel: card.inspectAtLabel,
  })));

  const needle = q?.toLowerCase();
  const filtered = rows.filter((row) => (
    (state === undefined || row.state === state)
    && (owner === undefined || row.owner === owner)
    && (mine === undefined || row.mine === mine)
    && (number === undefined || row.number === number)
    && (needle === undefined || row.title.toLowerCase().includes(needle))
  ));

  // 先切片再返回：`total` 是「筛完有多少」，`count` 是「这一页给了几条」。
  // 没有 offset/limit 时两者相等（老行为不变：一次全给）。
  const start = offset ?? 0;
  const page = filtered.slice(start, limit === undefined ? undefined : start + limit);

  return [JSON.stringify({
    total: filtered.length,
    offset: start,
    count: page.length,
    requirements: page,
  }, null, 2)];
}

/**
 * 让 agent 不必再问人：现状、类型、负责人、PRD、已有产物、还缺哪几处。
 *
 * ── `actions` / `permissions` 必须是「这个人能做的」，不是「这个状态允许的」（P2）
 *
 * 这里曾经调 `getRequirementDetail(id)`（不传身份），于是 `actions` 是
 * `actionsFor(state)` 的原样——状态合法的**全部**动作。后果是一种不会报错的坏法：
 * agent 被列表里一个 `reviewPass` 说服，去调 `requirement_review_pass`，然后拿到
 * 一句「签字人不是这条需求派单到的评审人」。它没有说谎，写工具的 scope 也只管
 * 「读 / 写」两级，管不了「这个人的角色」——于是读侧与写侧对同一件事给了两个答案，
 * 而 agent 只能靠一次失败去猜。
 *
 * 现在身份来自 token（`identity.member`），读模型用它算 `visibleActions` /
 * `permissionsFor`——与抽屉、动作条**同一个 `can()`**，没有第二套规则。
 * 查不到这一行（停用 / 被删）时传 `null`：`getRequirementDetail` 对 `null` 给
 * 空动作 + 全 false 权限，一个 token 换了主人也不该凭空看见动作。
 */
async function showTool(identity: Identity, raw: unknown): Promise<string[]> {
  const { requirementId } = parseInput(showInput, raw);

  const actor = await activeMemberByName(db, identity.member);
  const detail = await SERVICES.getRequirementDetail(requirementId, actor);
  if (detail === null) throw new AppError('not_found', NO_REQUIREMENT);

  const artifacts = await SERVICES.listArtifacts(db, detail.id);
  const attached = new Set<Stage>(artifacts.map((a) => a.stage));

  return [JSON.stringify({
    id: detail.id,
    number: detail.number,
    title: detail.title,
    state: detail.state,
    stateLabel: detail.stateLabel,
    stateDays: detail.days,
    stateEnteredAt: detail.info.stateEnteredAt,
    // 类型（Ruling 1）：可能为 null（未指定），标签给的是「未指定」而不是空串。
    type: detail.info.type,
    typeLabel: detail.info.typeLabel,
    // 来源（Ruling 3）：六类之一 / null。agent 决定下一步常要看它（线上问题优先）。
    source: detail.info.source,
    sourceLabel: detail.info.sourceLabel,
    sourceNote: detail.info.sourceNote,
    requester: detail.info.requester,
    owner: detail.info.owner,
    prdUrl: detail.info.prdUrl,
    // P4-09：平台与优先级都是「这条需求是什么」的一部分，agent 决定下一步要用它们
    // （例如 P0 的需求不该被排进下下个版本）。两个都给**键**，标签另给一格。
    platforms: detail.info.platforms,
    priority: detail.info.priority,
    priorityLabel: detail.info.priorityLabel,
    skipReason: detail.info.skipReason,
    // 六问正文（2026-11-11）：没有它，agent 要补全或评估只能另开页面。
    description: detail.description,
    // 迁移来源（Flower 的 uuid）。编号在迁移后重排，只有它能对上老系统那一条。
    legacyRef: detail.info.legacyRef,
    // 六问缺哪几问——与立项/生成两道门同一个判据，agent 不必自己数。
    missingBrief: missingRequired(detail.description),
    // 两个字段都来自同一次 `can()`：`actions` 是「状态 ∩ 他能做」，`permissions`
    // 是那几处控件各自的结论。只给其中一个会让 agent 用「有动作」去猜「能不能改描述」。
    actions: detail.actions,
    permissions: detail.permissions,
    artifacts: artifacts.map((a) => ({ stage: a.stage, url: a.url, at: a.at.toISOString() })),
    missing: STAGES.filter((stage) => !attached.has(stage)),
  }, null, 2)];
}

/** 建需求：`createRequirement` 自己会校验字段，这里不再判第二遍。 */
async function createTool(identity: Identity, raw: unknown): Promise<string[]> {
  const input = parseInput(createInput, raw);
  const got = await SERVICES.createRequirement(db, identity.member, input);
  return [JSON.stringify(got, null, 2)];
}

/** 交材料：站内文件存在性、stage 白名单、事件全在 `attachArtifact` 里。 */
async function attachTool(identity: Identity, raw: unknown): Promise<string[]> {
  const { requirementId, stage, url } = parseInput(attachInput, raw);
  const got = await SERVICES.attachArtifact(db, identity.member, { requirementId, stage, url });
  return [JSON.stringify({ ok: true, url: got.url }, null, 2)];
}

async function submitReviewTool(identity: Identity, raw: unknown): Promise<string[]> {
  const { requirementId, prdUrl } = parseInput(submitReviewInput, raw);
  const got = await SERVICES.submitReview(db, identity.member, { requirementId, prdUrl });
  return [JSON.stringify(got, null, 2)];
}

async function reviewPassTool(identity: Identity, raw: unknown): Promise<string[]> {
  const { requirementId } = parseInput(reviewPassInput, raw);
  const got = await SERVICES.reviewPass(db, identity.member, { requirementId });
  return [JSON.stringify(got, null, 2)];
}

async function reviewRejectTool(identity: Identity, raw: unknown): Promise<string[]> {
  const { requirementId, reason } = parseInput(reviewRejectInput, raw);
  const got = await SERVICES.reviewReject(db, identity.member, { requirementId, reason });
  return [JSON.stringify(got, null, 2)];
}

async function scheduleTool(identity: Identity, raw: unknown): Promise<string[]> {
  const { requirementId, releaseId, commitTestAt, commitDueAt } = parseInput(scheduleInput, raw);
  const got = await SERVICES.schedule(db, identity.member, {
    requirementId, releaseId, commitTestAt, commitDueAt,
  });
  return [JSON.stringify(got, null, 2)];
}

async function batchTool(identity: Identity, raw: unknown): Promise<string[]> {
  const input = parseInput(batchInput, raw);
  const got = await SERVICES.batchUpdate(db, identity.member, input);
  return [JSON.stringify(got, null, 2)];
}

async function calibrateTool(identity: Identity, raw: unknown): Promise<string[]> {
  const input = parseInput(calibrateInput, raw);
  const got = await SERVICES.calibrateState(db, identity.member, input);
  return [JSON.stringify(got, null, 2)];
}

async function reopenTool(identity: Identity, raw: unknown): Promise<string[]> {
  const { requirementId, reason } = parseInput(terminalReasonInput, raw);
  const got = await SERVICES.reopenRequirement(db, identity.member, { requirementId, reason });
  return [JSON.stringify(got, null, 2)];
}

async function rescheduleTool(identity: Identity, raw: unknown): Promise<string[]> {
  const input = parseInput(rescheduleInput, raw);
  const got = await SERVICES.reschedule(db, identity.member, input);
  return [JSON.stringify(got, null, 2)];
}

async function bounceTool(identity: Identity, raw: unknown): Promise<string[]> {
  const { requirementId, reason, newCommitDueAt } = parseInput(bounceInput, raw);
  // 不传 now：生产调用方用真实时钟（R24 的注入只给用例）。
  const got = await SERVICES.bounce(db, identity.member, {
    requirementId, reason, newCommitDueAt,
  });
  return [JSON.stringify(got, null, 2)];
}

async function rejectTool(identity: Identity, raw: unknown): Promise<string[]> {
  const { requirementId, reason } = parseInput(terminalReasonInput, raw);
  const got = await SERVICES.rejectRequirement(db, identity.member, { requirementId, reason });
  return [JSON.stringify(got, null, 2)];
}

async function memberListTool(identity: Identity, raw: unknown): Promise<string[]> {
  void identity;
  void raw;
  const members = await SERVICES.listMembers();
  return [JSON.stringify({
    members: members.map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, line: m.line })),
  }, null, 2)];
}

async function releaseListTool(identity: Identity, raw: unknown): Promise<string[]> {
  void identity;
  void raw;
  const releases = await SERVICES.listReleases();
  return [JSON.stringify({
    releases: releases.map((r) => ({
      id: r.id, name: r.name, windowStart: r.windowStart, releaseDate: r.releaseDate,
      shipped: r.shipped, inFlight: r.inFlight, late: r.late,
    })),
  }, null, 2)];
}

async function briefPromptsTool(identity: Identity, raw: unknown): Promise<string[]> {
  void identity;
  void raw;
  // 纯常量：六个问题的标签与「不填会怎样」。给 agent 一份可以直接照念的问题清单，
  // 省得每个工具说明里再抄一遍。
  return [JSON.stringify({
    required: DESCRIPTIVE_FIELDS.map((f) => ({
      key: f.key, label: f.label, why: f.hint ?? '补充信息，缺了材料会写得更空',
    })),
    rule: '六问全必填：缺任何一条都不能立项（进待设计）、也不能生成评估材料；'
      + '认领、提交评审、拒绝、搁置不受影响。',
  }, null, 2)];
}

async function updateTool(identity: Identity, raw: unknown): Promise<string[]> {
  const input = parseInput(updateInput, raw);
  const got = await SERVICES.updateRequirement(db, identity.member, input);
  return [JSON.stringify(got, null, 2)];
}

async function claimTool(identity: Identity, raw: unknown): Promise<string[]> {
  const { requirementId } = parseInput(claimInput, raw);
  const got = await SERVICES.claimRequirement(db, identity.member, { requirementId });
  return [JSON.stringify(got, null, 2)];
}

async function assignTool(identity: Identity, raw: unknown): Promise<string[]> {
  const input = parseInput(assignInput, raw);
  const got = await SERVICES.reassignOwner(db, identity.member, input);
  return [JSON.stringify(got, null, 2)];
}

async function rollbackTool(identity: Identity, raw: unknown): Promise<string[]> {
  const { requirementId, reason } = parseInput(terminalReasonInput, raw);
  const got = await SERVICES.rollbackRelease(db, identity.member, { requirementId, reason });
  return [JSON.stringify(got, null, 2)];
}

async function shelveTool(identity: Identity, raw: unknown): Promise<string[]> {
  const { requirementId, reason } = parseInput(terminalReasonInput, raw);
  const got = await SERVICES.shelveRequirement(db, identity.member, { requirementId, reason });
  return [JSON.stringify(got, null, 2)];
}

/**
 * 「立项」= 收集 → 待设计（状态机的 trigger 叫 `approve`）。
 *
 * 认领（`requirement_claim`）只把负责人换成你，**不动状态**；收集状态的唯一出口是
 * 这一条边。没有它，agent 认领完就卡在收集列，只能直接提交 PRD 跳过设计。
 *
 * 2026-11-10 起它**不再**是「交回评估材料」的副作用：`uemaster_attach` 只落产物、
 * 不改状态（owner 的第二次纠正：材料是产物，立项是决定）。所以 agent 想推进这条需求，
 * 必须显式调这个工具——这也是六问那道门（六格全必填，2026-11-11 起）唯一的入口。
 */
async function startDesignTool(identity: Identity, raw: unknown): Promise<string[]> {
  const { requirementId } = parseInput(restoreInput, raw);
  const got = await SERVICES.evaluate(db, identity.member, { requirementId });
  return [JSON.stringify(got, null, 2)];
}

async function restoreTool(identity: Identity, raw: unknown): Promise<string[]> {
  const { requirementId } = parseInput(restoreInput, raw);
  const got = await SERVICES.restoreRequirement(db, identity.member, { requirementId });
  return [JSON.stringify(got, null, 2)];
}

/**
 * 十四个工具。
 *
 * 顺序是「读 → 建 → 材料 → 流程」：客户端把 `tools/list` 原样摆给模型看，
 * 顺序就是它读到这些工具的次序。写工具排在读工具后面，是因为一次会话通常先看清楚
 * 再动手。
 */
export const TOOLS: readonly ToolDef[] = [
  tool({
    name: 'requirement_list',
    title: '列需求',
    scope: 'read',
    action: null,
    inputSchema: listInput,
    purpose: '看板上全部需求的一行摘要（编号、标题、状态、负责人、等谁、停几天）。'
      + '可按 state / owner / mine 过滤：mine=true 是「现在就等我动手」的那些。纯读。',
    call: listTool,
  }),
  tool({
    name: 'requirement_show',
    title: '看一条需求的现状',
    scope: 'read',
    action: null,
    inputSchema: showInput,
    purpose: '读一条需求：当前状态、类型、负责人、提出人、PRD 链接、已有产物、还缺哪几个阶段，'
      + '以及当前状态下合法的动作。用它决定下一步，不必问人。纯读。' + NO_REQUIREMENT_HINT,
    call: showTool,
  }),
  tool({
    name: 'requirement_prd',
    title: '读 PRD 正文（快照）',
    scope: 'read',
    action: null,
    inputSchema: prdInput,
    purpose: '取这条需求最近一次 PRD 快照的 markdown（评审 / 走查要读的那份）。'
      + '**只读，不写库**：还没有快照时明确报错，并提示用 requirement_prd_refresh。'
      + '返回两段：第一段是元信息 JSON（url、hash、取于何时），第二段是正文原文。',
    call: prdTool,
  }),
  tool({
    name: 'requirement_prd_refresh',
    title: '读一版 PRD（会写库）',
    scope: 'write',
    action: null,
    inputSchema: prdRefreshInput,
    purpose: '去 PRD 源文档（企业微信文档）现读一版，落成新快照并记一条 prd.fetched 事件。'
      + '**会写库**，所以要写权限。快照只在内容变了时新增一行（同 hash 不重复存）。'
      + '返回结构与 requirement_prd 相同。',
    call: prdRefreshTool,
  }),

  tool({
    name: 'uemaster_plan',
    title: '取 UEmaster 任务包',
    scope: 'read',
    action: null,
    inputSchema: planInput,
    purpose: '为一条需求生成某个阶段的 UEmaster 任务包（可直接执行的中文指令：画什么、'
      + '写到哪个文件、怎么交回来）。阶段只有 evaluate（评估）/ review（评审）/ inspect（走查）。'
      + '**为什么要出这份材料**：它是一张能在评审会上直接投屏的 HTML——流程图 + 页面/入口 + '
      + '异常与边界 + 范围，评审人按它签字，比一段文字少两轮返工。'
      + '**示例**：一条「分享页搜索」的需求会得到「搜索入口 → 结果页 → 空态/失败态」三张流程图、'
      + '5 条待确认项，评审时逐条拍板。'
      + '纯读：不改需求状态、不写时间线——材料是产物，立项（requirement_start_design）是'
      + '另一个动作。包里的文件名带版本号（evaluate-v003.html），照着写不会覆盖历史版本。'
      + '**六问缺任何一条都不会出包**（先用 requirement_brief_prompts 补齐）。'
      + '拿到包之后照它做，写完文件再调 uemaster_attach。',
    call: planTool,
  }),
  tool({
    name: 'requirement_create',
    title: '提需求',
    scope: 'write',
    action: null,
    inputSchema: createInput,
    purpose: '新建一条需求（落在「收集」）。actor 就是这个 token 对应的人；'
      + 'requester 是「谁提的」这个自由文本字段，不一定是同一个人。'
      + '**录入前必须先问用户六问**：调 requirement_brief_prompts 取六条问题原文，逐条问、'
      + '不要自己编答案，再填进 context/problem/outcome/surfaces/edgeCases/outOfScope。'
      + '六问不全也能建（进收集），但之后不能立项、不能生成评估材料。'
      + '池子里已有相似标题时会被拒（duplicate_suspected）并点名那几条；'
      + '确认不是重复再传 allowDuplicate:true。',
    call: createTool,
  }),
  tool({
    name: 'requirement_brief_prompts',
    title: '六问清单（照念给用户）',
    scope: 'read',
    action: null,
    inputSchema: z.object({}),
    purpose: '返回六问的原文与「不填会怎样」，供 agent 在录入/补全前逐条问用户。'
      + '六问全必填：缺任何一条都不能立项，也不能生成评估材料。纯读。',
    call: briefPromptsTool,
  }),
  tool({
    name: 'member_list',
    title: '成员列表',
    scope: 'read',
    action: null,
    inputSchema: z.object({}),
    purpose: '在册成员与他们的 UUID / 角色 / 条线。新建需求指派负责人、转交负责人时'
      + '需要 ownerMemberId，就用这里的 id。纯读。',
    call: memberListTool,
  }),
  tool({
    name: 'release_list',
    title: '版本列表',
    scope: 'read',
    action: null,
    inputSchema: z.object({}),
    purpose: '版本与它们的 UUID、发版日、已上线/在途/延期条数。排期（requirement_schedule）'
      + '需要 releaseId，就用这里的 id。纯读。',
    call: releaseListTool,
  }),
  tool({
    name: 'requirement_update',
    title: '改需求（描述类字段）',
    scope: 'write',
    action: null,
    inputSchema: updateInput,
    purpose: '改标题 / 六问 / 平台 / 优先级 / 备注。改不了类型、提出人、负责人、状态'
      + '（负责人用 requirement_assign，状态用状态动作）。权限：负责人 / 条线负责人 / 超管。'
      + '六问改完仍不全时，立项与生成照旧被拒。',
    call: updateTool,
  }),
  tool({
    name: 'requirement_claim',
    title: '认领（无主 → 我）',
    scope: 'write',
    action: null,
    inputSchema: claimInput,
    purpose: '把一条**还没有负责人**的需求接到自己名下，不动状态。认领后你成为负责人，'
      + '才能改它、立项、提交评审。已有负责人的需求不能认领（用 requirement_assign 转交）。',
    call: claimTool,
  }),
  tool({
    name: 'requirement_assign',
    title: '转交负责人',
    scope: 'write',
    action: null,
    inputSchema: assignInput,
    purpose: '把需求转给另一个在册成员（ownerMemberId 用 member_list 的 id）。'
      + '条线负责人只能转给本线的人，超管不受限；PM 不能转交。',
    call: assignTool,
  }),
  tool({
    name: 'uemaster_attach',
    title: '交回 UEmaster 产物',
    scope: 'write',
    action: null,
    inputSchema: attachInput,
    purpose: '把已经生成好的产物链接交出：站内路径（形如 /uemaster/PAN-7/evaluate-v003.html，'
      + '项目根目录 data/uemaster/ 下必须真有这个文件）或 http(s) 完整链接。'
      + '只写一条 uemaster.attached 事件，**不改状态**：要推进用 requirement_start_design。',
    call: attachTool,
  }),
  tool({
    name: 'requirement_submit_review',
    title: '提交评审',
    scope: 'write',
    action: 'submitReview',
    inputSchema: submitReviewInput,
    purpose: '把需求推进到「待评审」并派单给对应评审线（按类型）。必须给正式 PRD 链接：'
      + '没有链接进不了评审。从「收集」直接提交等于跳过评估（skip_reason 会记下来）。',
    call: submitReviewTool,
  }),
  tool({
    name: 'requirement_review_pass',
    title: '评审通过',
    scope: 'write',
    action: 'reviewPass',
    inputSchema: reviewPassInput,
    purpose: '签字通过，需求进入「待排期」。签字人必须是这条需求派单上的那位评审人——'
      + 'token 对应的人对不上时服务层会拒绝（不是这条需求的评审人）。',
    call: reviewPassTool,
  }),
  tool({
    name: 'requirement_review_reject',
    title: '评审打回',
    scope: 'write',
    action: 'reviewReject',
    inputSchema: reviewRejectInput,
    purpose: '评审不通过，需求退回「待设计」。原因必填，它会进时间线（打回理由是谁都要读的东西）。',
    call: reviewRejectTool,
  }),
  tool({
    name: 'requirement_schedule',
    title: '排期',
    scope: 'write',
    action: 'schedule',
    inputSchema: scheduleInput,
    purpose: '把需求排进一个版本：要版本 ID、提测日、承诺完成日（YYYY-MM-DD）。'
      + '承诺完成日不能早于提测日、也不能晚于版本发版日。这一步就是「承诺」——'
      + '它会在时间线上写下这个 token 对应的人的名字。',
    call: scheduleTool,
  }),
  tool({
    name: 'requirement_reschedule',
    title: '改排期（版本 / 提测日 / 承诺完成日）',
    scope: 'write',
    action: null,
    inputSchema: rescheduleInput,
    purpose: '已经排进版本的需求（待开发 / 开发中 / 测试中）改版本或改两个承诺日，**不动状态**。'
      + '第一次排期用 requirement_schedule；这条用于版本页「管理进度」。'
      + '规则与排期一致：提测日 ≤ 承诺完成日 ≤ 版本发版日，且必须有正式 PRD。'
      + '每次改写在时间线上留一条 requirement.rescheduled（带改前改后）。',
    call: rescheduleTool,
  }),
  tool({
    name: 'requirements_batch_update',
    title: '批量改（先看差异再落库）',
    scope: 'write',
    action: null,
    inputSchema: batchInput,
    purpose: '一次改多条的描述类字段（优先级 / 类型 / 备注 / 平台 / PRD）。'
      + '**默认 dryRun**：只返回每条会改成什么，确认后再传 dryRun:false 落库。'
      + '负责人、版本、承诺日不在批量范围（各自有更严的规则）。逐条报告成功/跳过/被拒原因。',
    call: batchTool,
  }),
  tool({
    name: 'requirement_calibrate',
    title: '状态校准（超管）',
    scope: 'write',
    action: null,
    inputSchema: calibrateInput,
    purpose: '把一条需求直接摆到它**真实所在**的阶段（存量卡片对齐现实用），必须写原因。'
      + '只有超管能做；只改状态，不动版本、承诺日与产物。日常推进仍走立项/评审/排期/打回。',
    call: calibrateTool,
  }),
  tool({
    name: 'requirement_reopen',
    title: '退回待开发（开发中 → 待开发）',
    scope: 'write',
    action: 'reopen',
    inputSchema: terminalReasonInput,
    purpose: '开发中发现接错了 / 方案变了，把需求退回「待开发」重新排期，原因必填。'
      + '与 requirement_bounce 不同：那是「测试没过」，这是「还没真正开始」。'
      + '版本与承诺日保留，改日期用 requirement_reschedule。',
    call: reopenTool,
  }),
  tool({
    name: 'requirement_bounce',
    title: '打回开发中',
    scope: 'write',
    action: 'bounce',
    inputSchema: bounceInput,
    purpose: '测试没收住：退回「开发中」，必须写原因并重填承诺完成日（不能早于今天）。',
    call: bounceTool,
  }),
  tool({
    name: 'requirement_reject',
    title: '拒绝需求',
    scope: 'write',
    action: 'reject',
    inputSchema: terminalReasonInput,
    purpose: '把还在「收集」的需求毙掉（终态）。原因必填。已经评估过的需求不能走这条——'
      + '那已经是评审意见，用 requirement_review_reject。',
    call: rejectTool,
  }),
  tool({
    name: 'requirement_start_design',
    title: '立项（收集 → 待设计）',
    scope: 'write',
    action: 'approve',
    inputSchema: restoreInput,
    purpose: '接手之后往下走一步：从「收集」进「待设计」，意思是「我去出正式 PRD」。'
      + '无主的需求要先 requirement_claim；有主之后只有负责人 / 条线负责人 / 超管能立项。'
      + '六问（谁在什么情况下用 / 现在怎么做哪不好 / 做成什么样算成功 / 涉及哪些页面入口 / '
      + '失败空无权限怎么办 / 这次不做什么）缺任何一条都会被拒，'
      + '拒的那句话会点名缺哪几条。**它与生成评估材料是两件事**：uemaster_plan / '
      + 'uemaster_attach 只出材料、交材料，不改状态。',
    call: startDesignTool,
  }),
  tool({
    name: 'requirement_shelve',
    title: '搁置',
    scope: 'write',
    action: 'shelve',
    inputSchema: terminalReasonInput,
    purpose: '这件事先不做：任何非终态都能搁置，原因必填（一年后翻事件流时，'
      + '唯一能回答「为什么」的就是这句话）。已挂着的评审派单会一起作废。',
    call: shelveTool,
  }),
  tool({
    name: 'requirement_rollback',
    title: '回滚（已上线 → 待排期）',
    scope: 'write',
    action: 'rollback',
    inputSchema: terminalReasonInput,
    purpose: '发出去的东西有问题时撤回：需求退回「待排期」，版本与两个日期一起清空，'
      + '原因必填（它会进事件流）。退回的是待排期而不是开发中——开发中的时钟会立刻把它'
      + '推回测试与已上线，等于没撤。之后要重新排期一次（requirement_schedule）。',
    call: rollbackTool,
  }),
  tool({
    name: 'requirement_restore',
    title: '恢复',
    scope: 'write',
    action: 'restore',
    inputSchema: restoreInput,
    purpose: '把搁置的需求放回「收集」，重新走一遍流程。版本与日期不会自动恢复，'
      + '要再排期一次（那时三列会被整体覆盖）。',
    call: restoreTool,
  }),
];

/** 按名字取工具（未知名一律 null，入口据此回一句中文）。 */
export function toolByName(name: string): ToolDef | null {
  return TOOLS.find((item) => item.name === name) ?? null;
}

/** 成功的结果：`blocks` 是多段文本，不是一段 JSON。 */
function succeeded(blocks: string[]): CallToolResult {
  return { content: blocks.map((text) => ({ type: 'text' as const, text })) };
}

/** 失败的结果：`isError: true` + 那句中文。内容与成功同形，客户端不需要第二种解析。 */
function failed(message: string, code?: string): CallToolResult {
  // 第二段是给 `/api/v1` 那层读的机器码：MCP 客户端只看第一段中文，REST 要按 code 决定
  // 403 / 404 / 409。不带 code 时保持原来的一行——工具错误与协议错误是两件事。
  return {
    content: [{ type: 'text', text: message }],
    // 机器码放 `_meta`，**不进正文**：MCP 客户端读的是那句中文，而正文一旦多出一段
    // JSON，既有的「错误原文逐字相等」用例会全部红掉（也确实是把话说脏了）。
    ...(code === undefined ? {} : { _meta: { code } }),
    isError: true,
  };
}

/**
 * 跑一个工具。这是 stdio 与 HTTP 两条入口**共用的唯一执行路径**。
 *
 * 三件事，顺序不能换：
 * 1. **scope 检查**：token 的权限不够执行这个工具时，一句中文说清「你现在是什么权限、
 *    这一步要什么权限」。它发生在调服务之前——一个 read token 不该因为点错工具而在
 *    时间线上留下半条记录。（返回的是工具错误，不是 HTTP 401：身份是真的，只是
 *    权限不够；MCP 层没有「403」这个概念，把话说在正文里是客户端读得到的位置。）
 * 2. 调工具，把多段文本原样交回。
 * 3. `AppError`（状态不对、需求不存在、不是评审人、日期越界）→ `isError` + 原文，
 *    不加前缀、不打堆栈。其它异常不吞：打一条 stderr 留证据，然后照样抛出去，
 *    由 SDK 的请求处理器收成 `isError`——「库挂了」与「参数填错了」不该长得一模一样。
 */
export async function runTool(
  def: ToolDef, identity: Identity, args: unknown,
): Promise<CallToolResult> {
  if (!scopeAllows(identity.scope, def.scope)) {
    return failed(
      `这个 token 的权限是「${scopeLabel(identity.scope)}」，调用 ${def.name} 需要「${scopeLabel(def.scope)}」权限`,
    );
  }
  try {
    return succeeded(await def.call(identity, args));
  } catch (error) {
    // code 一起交回去（2026-11-11）：REST 面要按它决定 HTTP 状态（403 / 404 / 409）。
    // MCP 客户端读的是第一段中文，多出来的第二段是给 `/api/v1` 那层看的。
    if (error instanceof AppError) return failed(error.message, error.code);
    console.error('[flowers-mcp] 未预期错误：', error);
    throw error;
  }
}
